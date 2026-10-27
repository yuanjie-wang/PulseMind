// ── Tool executor facade ──
// One ToolExecutor per engine (constructed in useChatManagers / session-manager)
// that maps a tool_use block to its implementation. This file keeps the small /
// built-in-file tools and the dispatch surface the engine calls; the larger
// per-domain implementations live in executors/* (pick_tool, spawn_agent,
// memory/conversation/knowledge/experience) behind the ToolExecContext
// interface. Results flow back through the injected addToolResult callback
// (which owns the global context-size guardrail) — executors themselves no
// longer truncate.

import { getHost } from './host'
import { execGitTool } from './engine/git-tools'
import type { ToolUseBlock } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import type { SpawnSubAgentConfig, SubAgentHandle } from './agent-utils'
import type { Plan } from '../../../shared/types/plan'
import { writeFileChunked, resolveToolFilePath } from './agent-utils'
import { buildCommandFromSkillInput, withDefaultSearchDir } from './command-builder'
import { shSingleQuote, shEscape, psEscape } from './agent-utils'
import { SkillKeywordAgent, SkillSelectionAgent } from './one-shot-agent'
import { saveImagesInText } from './image-utils'
import type { ToolExecContext } from './executors/context'
import type { SkillDefinition } from '../skills/types'
import { execPickTool as pickToolImpl } from './executors/pick-tool'
import { execSpawnAgent as spawnAgentImpl } from './executors/spawn-tool'
import { formatInspectResult, INSPECT_RESULT_TOKEN_BUDGET } from './office-inspect-format'
import { formatOfficeReadResult } from './office-read-format'
import { formatOfficeSearchResult } from './office-search-format'
import { detectVerifyCommands, isSourceFilePath, isVerifyExecCommand, officeSpotCheckHint, summarizeTestOutput, verifyStreakHint, VERIFY_STREAK_THRESHOLD } from './verify-loop'


import { execRecallTool, execMemoryTool, execContextCompactTool, execToolResultSearchTool, execSkillCommand } from './executors/domain-tools'
import { MAX_READ_RESULT_TOKENS } from './engine/engine-constants'
import { execInstallTool } from './executors/install-tool'
import { execCreateSubPlanTool } from './executors/create-sub-plan-tool'
import type { SplitChildSpec } from '../../../shared/plan/split-proposal'
import { serializeScriptFences } from '../../../shared/experience/script-fence'
import { isLivePage, type MemoryPageRecord } from '../../../shared/memory-pages'

export type SpawnSubAgentFn = (config: SpawnSubAgentConfig) => SubAgentHandle
export { UI_PREVIEW_MAX } from './executors/context'

// ── Remaining per-tool limits ───────────────────────────────────────
// Executors no longer truncate tool results for context — the global guardrail
// in AgentEngine (MAX_TOOL_RESULT_TOKENS) is the single backstop, and read
// rides it with a dedicated higher budget (MAX_READ_RESULT_TOKENS) instead of
// the 4K default, since reading a file IS the task. These limits stay only
// where they serve a non-context purpose: UI previews (see
// executors/context.ts) and the read tool's paging (an intrinsic part of how
// the model reads large files).
const READ_DEFAULT_LINE_LIMIT = 500        // read: default lines per page (2026-10-28: 200 → 500 — fewer round-trips on the files models actually face; the token-level net is MAX_READ_RESULT_TOKENS)
const READ_MAX_LINE_LIMIT = 1000           // read: hard cap on lines per page (the structural bound; the token-level net is MAX_READ_RESULT_TOKENS)

/** read 的行号前缀（2026-10-28，cat -n 同款）：绝对行号 + tab 前缀给模型一个
 *  跨回合共享的坐标系——「改 350 行附近」成为合法表达，重读定位也少一次
 *  offset 试错。前缀是坐标不是内容：手册教模型 edit 的 old_str/new_str 与
 *  write 的 content 一律不带前缀（read/edit 两本手册各有一句回声）。 */
export function numberReadLines(content: string, startLine: number): string {
  if (!content) return content
  return content.split('\n').map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`).join('\n')
}
/** write's soft size gate (2026-10-27): the manual's ≤5KB advice, echoed in
 *  the result past this mark — a hint, never a rejection. */
const WRITE_SOFT_LIMIT_BYTES = 5 * 1024

/** office_edit's write ops per format — the validator runs BEFORE the host
 *  call (the services back up + snapshot before applying, so a batch that
 *  could never apply is refused here), and the read-shaped ops office_read
 *  took over get their migration hint instead of a backup for nothing. */
const OFFICE_EDIT_OPS: Record<'docx' | 'xlsx' | 'pptx', ReadonlySet<string>> = {
  docx: new Set(['replace_text', 'insert_paragraph', 'delete_paragraph', 'set_paragraph_style', 'format_text', 'insert_image', 'insert_table_row', 'delete_table_row']),
  xlsx: new Set(['set_cell', 'find_replace', 'add_row', 'set_style', 'set_column_width', 'freeze_panes']),
  pptx: new Set(['replace_text', 'set_shape_text', 'format_text', 'set_shape_fill', 'set_slide_background', 'set_shape_geometry']),
}

/** UTF-8 byte length of a string. `String.length` counts UTF-16 code units,
 *  which for CJK-heavy content reads ~50% under the bytes actually hitting
 *  the disk — a correct write reported as a truncated one (2026-09-27). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * The pick_skill result envelope. The **Location:** line is what makes a body
 * that names companion files (the office skill's `references/`) usable: it is
 * the one anchor the model has for deriving "same directory" paths. The body is
 * read from DISK at call time (see freshSkillDefinition), so the envelope and
 * the file the Location line advertises are the same text. Omitted when the
 * engine has no skillsDir rather than printing a wrong absolute path.
 */
function formatSelectedSkill(name: string, definition: SkillDefinition, skillsDir?: string): string {
  const location = skillsDir ? `\n**Location:** ${skillsDir}/${name}/SKILL.md` : ''
  return `## Selected Skill: ${name}\n\n**Description:** ${definition.description}\n**Category:** ${definition.category}${location}\n\n### Instructions\n${definition.systemPrompt || '(no instructions)'}`
}

// ── pick_skill 的经验段（PLAN-experience-sop B，2026-10-26）──
// 一阶段经验产出即可被拉取（裁定二）：候选表在已启用技能之外追加活经验页，
// 选中返回页正文信封。拉取面扩源、不搬家——经验页继续住在 memory_pages，
// 不落盘、不进注册表，草稿语义原样保留。开关态（2026-10-27，经验卡与技能卡同款
// 开关）镜像技能的语义：候选表只列启用页（getEnabledSkills 同款），显式按名拉取
// 仍能解析停用页（getSkill 同款）。

/** 活经验候选的索引 TTL（matchExperiences 同款先例）。 */
const EXP_CANDIDATE_TTL_MS = 60_000
const EXP_CANDIDATE_MAX = 30
let expCandidateCache: { at: number; pages: MemoryPageRecord[] } | null = null

/** tests/probes 的复位钩子：60s TTL 缓存在同进程的用例间会串味。 */
export function resetExperienceCandidateCache(): void {
  expCandidateCache = null
}

/** 活页全集（含停用）——按名解析的查找面。 */
async function liveExperiencePages(): Promise<MemoryPageRecord[]> {
  const now = Date.now()
  if (!expCandidateCache || now - expCandidateCache.at >= EXP_CANDIDATE_TTL_MS) {
    try {
      const all = await getHost().listMemoryPages('experience')
      expCandidateCache = { at: now, pages: all.filter(isLivePage).slice(0, EXP_CANDIDATE_MAX) }
    } catch {
      return expCandidateCache?.pages ?? []
    }
  }
  return expCandidateCache.pages
}

/** 候选表只列启用页（技能侧的 getEnabledSkills 对应物）。只有显式 false 才算停用——
 *  字段缺席（旧主进程的记录）读作启用，与存储层「显式 0 才停用」同口径。 */
async function enabledExperiencePages(): Promise<MemoryPageRecord[]> {
  return (await liveExperiencePages()).filter((p) => p.enabled !== false)
}

function experienceCandidateLine(p: MemoryPageRecord): string {
  const head = p.summary ?? p.body.replace(/\s+/g, ' ').slice(0, 120)
  return `- [experience] ${p.title}: ${head}`
}

/** 解析序即判词（B2）：title 精确优先，其次 alias——同名时已安装技能在调用侧
 *  先赢，这里只接技能注册表未命中的名字。 */
async function resolveExperiencePage(name: string): Promise<MemoryPageRecord | null> {
  const pages = await liveExperiencePages()
  const want = name.trim().toLowerCase()
  if (!want) return null
  return pages.find((p) => p.title.toLowerCase() === want)
    ?? pages.find((p) => p.aliases.some((a) => a.toLowerCase() === want))
    ?? null
}

/** 经验信封（B3）：**无 `**Location:**` 行**——无磁盘文件，freshSkillDefinition
 *  的「信封与 Location 广告文件同文」纪律不适用；DB 现读即构造性新鲜。正文 =
 *  页 body 全文；files_json 的脚本反向序列化回 `### File:` 围栏；尾行是数据指针。 */
function formatSelectedExperience(p: MemoryPageRecord): string {
  const scripts = p.files && p.files.length > 0 ? `${serializeScriptFences(p.files)}\n\n` : ''
  const summary = p.summary ? `**Summary:** ${p.summary}\n` : ''
  const source = p.sourceConversationId ?? 'unknown'
  return `## Experience: ${p.title}\n\n${summary}${scripts}${p.body}\n\n(source: ${source}, extracted ${p.updatedAt.slice(0, 10)}, maturity: ${p.maturity})`
}

/** B5 使用侧记账：pick 是有意图的拉取，才是干净的 touch 点（hint 触达刻意
 *  不记——逐回合 substring 命中太噪；recall 的记账在 searchMemoryPages 尾部）。 */
async function touchExperiencePage(id: string): Promise<void> {
  try { await getHost().touchMemoryPage(id) } catch { /* 记账失败不影响取用 */ }
}

/** 技能侧的同款记账（2026-10-27，技能卡「使用 N 次」）：选中已注册技能时 +1。
 *  不 await——信封先回给模型，计数失败只记日志。 */
function touchSkillUse(name: string): void {
  void (async () => {
    try { await getHost().recordSkillUse(name) } catch { /* 记账失败不影响取用 */ }
  })()
}

export class ToolExecutor implements ToolExecContext {
  constructor(
    /** @internal shared with the executors/* modules via ToolExecContext */
    opts: AgentEngineOptions,
    private mcpToolOwner: Map<string, string>,
    /** @internal shared with the executors/* modules via ToolExecContext */
    skillKeywordAgent: SkillKeywordAgent,
    private skillSelectionAgent: SkillSelectionAgent,
    /** @internal shared with the executors/* modules via ToolExecContext */
    addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void,
    /** @internal shared with the executors/* modules via ToolExecContext */
    notify: () => void,
    onProcessStart?: (pid: string) => void,
    /** @internal shared with the executors/* modules via ToolExecContext */
    spawnSubAgent?: SpawnSubAgentFn,
    /** @internal live plan accessor for the spawn_agent planNode linkage */
    getPlan?: () => Plan | null,
    /** @internal records the sub-conversation a plan node's spawn runs in */
    linkPlanNode?: (ref: string | number, subConvId: string) => void,
    /** @internal 单专家 @召唤：asks the engine to deliver this expert's conclusion
     *  as the turn's own assistant message (see ToolExecContext) */
    deliverExpertConclusion?: (toolUseId: string, text: string) => boolean,
    beginPlanNodeExecution?: ToolExecContext['beginPlanNodeExecution'],
    updatePlanNodeExecution?: ToolExecContext['updatePlanNodeExecution'],
    /** @internal spawn_agent calls in the current round — the shared envelope
     *  budget's denominator (see executors/spawn-tool.ts spawnEnvelopeBudget) */
    spawnBatchTotal?: () => number,
    /** @internal CAS the delivered node's output onto the plan as its handoff */
    recordNodeHandoff?: ToolExecContext['recordNodeHandoff'],
    /** @internal nested-dispatch discriminator, read at call time (the engine
     *  flag is set after this constructor runs — see ToolExecContext) */
    isSpawnedSubAgent?: () => boolean,
    /** @internal PLAN-plan-split P3: the plan's third write policy, from the
     *  spawn choke point's proposal branch */
    mergeSplitProposal?: ToolExecContext['mergeSplitProposal'],
    /** @internal PLAN-plan-exchange E3: stamp the node's delivered report */
    recordNodeReport?: ToolExecContext['recordNodeReport'],
    /** @internal PLAN-context-compact-tool: context_compact's engine channel
     *  (guards + prewarm + mandate) — absent on test stubs, where the tool
     *  refuses rather than half-works */
    compactContext?: ToolExecContext['compactContext'],
  ) {
    this.opts = opts
    this.addToolResult = addToolResult
    this.notify = notify
    this.onProcessStart = onProcessStart
    this.spawnSubAgent = spawnSubAgent
    this.getPlan = getPlan
    this.linkPlanNode = linkPlanNode
    this.deliverExpertConclusion = deliverExpertConclusion
    this.beginPlanNodeExecution = beginPlanNodeExecution
    this.updatePlanNodeExecution = updatePlanNodeExecution
    this.spawnBatchTotal = spawnBatchTotal
    this.recordNodeHandoff = recordNodeHandoff
    this.isSpawnedSubAgent = isSpawnedSubAgent
    this.mergeSplitProposal = mergeSplitProposal
    this.recordNodeReport = recordNodeReport
    this.compactContext = compactContext
  }

  opts: AgentEngineOptions
  addToolResult: (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number) => void
  notify: () => void
  onProcessStart?: (pid: string) => void
  spawnSubAgent?: SpawnSubAgentFn
  getPlan?: () => Plan | null
  linkPlanNode?: (ref: string | number, subConvId: string) => void
  deliverExpertConclusion?: (toolUseId: string, text: string) => boolean
  beginPlanNodeExecution?: ToolExecContext['beginPlanNodeExecution']
  updatePlanNodeExecution?: ToolExecContext['updatePlanNodeExecution']
  spawnBatchTotal?: () => number
  recordNodeHandoff?: ToolExecContext['recordNodeHandoff']
  isSpawnedSubAgent?: () => boolean
  mergeSplitProposal?: ToolExecContext['mergeSplitProposal']
  recordNodeReport?: ToolExecContext['recordNodeReport']
  compactContext?: ToolExecContext['compactContext']
  /** create_sub_plan's bridge to the PARENT plan (v2 R6), assigned by
   *  spawn-manager AFTER construction — the executor is built before the
   *  sub-engine knows its parent. Present only when opts.spawnPlanSplit is
   *  set; createSubPlan gates on both. */
  parentPlanMerge?: ToolExecContext['createSubPlan']

  /** Read-before-write ledger (2026-10-27, user ruling): paths whose bytes the
   *  model has seen THIS session, keyed by resolveWorkspacePath's spelling —
   *  read/write/edit all resolve through the same function, so the string
   *  match is exact (`~` passes through unexpanded on both sides, so a read
   *  of `~/x` does not license an edit spelled as the absolute path; the
   *  rejection message teaches the recovery). The value is the getFileStat
   *  mtime+size signature at read/write time, so the ledger answers not just
   *  "was it read" but "is that read still current" — an external writer
   *  (user's editor, git, a build step) stales the entry and the gate demands
   *  a re-read. Gated: `edit`/`patch` (both forms) and overwriting `write`;
   *  append and new-file writes stay free. One ToolExecutor per engine (and
   *  each sub-agent constructs its own), so the ledger is naturally
   *  per-session and a parent's reads never license a sub-agent's edit.
   *  @internal not `private` on purpose — tests seed it directly to exercise
   *  the gated branches without driving a real read first (the same
   *  reach-in shape spawn-manager uses for parentPlanMerge). */
  readFilePaths = new Map<string, { mtime: string; size: number }>()

  // ── Verify-loop soft gate state (2026-10-27, agent/verify-loop.ts) ──
  // Per-session like readFilePaths (one executor per engine): consecutive
  // source-file edits arm the streak, a verify-shaped exec resets it, and the
  // hint fires ONCE per session — a repeat nudge is noise, and noise teaches
  // the model to ignore the channel. The office branch counts successful
  // office_edit batches separately (its verification is reading back, and the
  // first batch already ended in a read).
  private sourceEditsSinceVerify = 0
  private verifyHintFired = false
  private officeEditBatches = 0
  private officeCheckHintFired = false

  /** spawn_agent's free-form dispatch ledger (see ToolExecContext.spawnTaskResults).
   *  @internal not `private` on purpose — tests seed it to exercise the
   *  re-dispatch gate without driving a real spawn first. */
  spawnTaskResults = new Map<string, 'completed' | 'failed' | 'aborted'>()

  updateOptions(opts: AgentEngineOptions): void {
    this.opts = opts
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * The disk-fresh definition for the pick_skill envelope. The registry holds
   * launch-time definitions and never refreshes, but the envelope's
   * **Location:** line points at the file — a SKILL.md hand-edited mid-session
   * ("a user edit wins"), or seed-upgraded by ensureBuiltInSkills after an app
   * update, must be the body the model reads, or the envelope and the file it
   * advertises tell two different stories. Falls back to the registry copy
   * when the read fails or the file is gone (deleted mid-session): the
   * registry definition is then the only description there is.
   */
  private async freshSkillDefinition(name: string, fallback: SkillDefinition): Promise<SkillDefinition> {
    try {
      return (await getHost().installSkill(name)) ?? fallback
    } catch {
      return fallback
    }
  }

  /** Resolve relative file_path against workspaceDir when set. `~` passes
   *  through untouched: the main process's expandTilde is the authority, and
   *  joining it here would spell a literal `<workspace>/~/...` directory.
   *  Delegates to the shared pure helper so the protected-path gate (the
   *  approval side) matches paths in exactly this coordinate system. */
  private resolveWorkspacePath(filePath: string): string {
    return resolveToolFilePath(filePath, this.opts.workspaceDir)
  }

  /** The stale half of the read-before-write gate: the ledger entry must
   *  still match disk. Mirrors main-side STALE_FILE_ERROR's wording
   *  (file-ops.ts) so both surfaces teach the same recovery — this gate owns
   *  the window BETWEEN the model's read and its edit/write, while
   *  statSignature owns the read-modify-write window inside one svc op. */
  private assertUnchangedOnDisk(
    cur: { mtime: string; size: number } | null,
    rec: { mtime: string; size: number },
  ): void {
    if (!cur || cur.mtime !== rec.mtime || cur.size !== rec.size) {
      throw new Error('file changed on disk since it was read — re-read and retry')
    }
  }

  /** Post-success ledger refresh: the op's own mtime bump must not
   *  stale-reject the NEXT edit/write on the same file. Stat failure keeps
   *  the old entry — the gate re-checks it on the next use anyway. */
  private async refreshReadSignature(fp: string): Promise<void> {
    try {
      const s = await getHost().getFileStat(fp)
      if (s) this.readFilePaths.set(fp, { mtime: s.mtime, size: s.size })
    } catch { /* the old entry stands */ }
  }

  /** The verify streak's write-side half: a successful source-file edit/write
   *  bumps the counter and, on crossing the threshold in a workspace that
   *  DETECTS verify commands, appends the once-per-session hint. Deliberately
   *  a note, never a rejection (the 2026-10-27 soft-gate shape): a legit
   *  multi-file change must not be blocked, the hint only makes the un-run
   *  verification visible at the moment the model decides what to do next.
   *  No manifests → the gate disarms itself (counter reset, no hint) — an
   *  office session never sees this machinery. Non-source paths (notes,
   *  deliverables, the .pulsemind scratch namespace) never count. */
  private async noteSourceEdit(fp: string, text: string): Promise<string> {
    if (!isSourceFilePath(fp)) return text
    this.sourceEditsSinceVerify++
    if (this.sourceEditsSinceVerify < VERIFY_STREAK_THRESHOLD || this.verifyHintFired) return text
    this.sourceEditsSinceVerify = 0
    const cmds = this.opts.workspaceDir ? await detectVerifyCommands(this.opts.workspaceDir) : []
    if (cmds.length === 0) return text
    this.verifyHintFired = true
    return `${text}\n${verifyStreakHint(cmds)}`
  }

  /** The streak's exec-side reset, called from BOTH exec dispatch points
   *  (execSkillCommand's auto path and approveTool's released-shell path) so
   *  a verification the model DID run — auto or approved — clears the count.
   *  Matching lives in isVerifyExecCommand; a failed test run resets too —
   *  the failure itself is the model learning the change doesn't work. */
  noteVerifyExec(command: string): void {
    if (isVerifyExecCommand(command)) this.sourceEditsSinceVerify = 0
  }

  /** The office branch: after the session's SECOND successful office_edit
   *  batch (the first already ended in the read that licensed it), append the
   *  read-back hint once. One batch is too early to teach; a third is too
   *  late — the second is where the edit→verify loop should form. */
  private noteOfficeEdit(text: string): string {
    this.officeEditBatches++
    if (this.officeEditBatches < 2 || this.officeCheckHintFired) return text
    this.officeCheckHintFired = true
    return `${text}\n${officeSpotCheckHint()}`
  }

  /** Format exec tool result with exit code and stdout/stderr separation. No truncation — the global guardrail in addToolResult caps it. */
  /** Format exec tool result with exit code and stdout/stderr separation. No truncation — the global guardrail in addToolResult caps it.
   *  @internal shared with the executors/* modules via ToolExecContext */
  formatExecResult(exitCode: number | null, stdout: string, stderr: string): string {
    // Normalize line endings (Windows PowerShell uses \r\n)
    stdout = stdout.replace(/\r\n/g, '\n')
    stderr = stderr.replace(/\r\n/g, '\n')
    const totalLen = stdout.length + stderr.length
    const stderrLines = stderr ? stderr.split('\n').filter(l => l.trim()).length : 0

    const header = `Exit Code: ${exitCode ?? 'signal'}  |  Total: ${totalLen.toLocaleString()} chars  |  Stderr: ${stderrLines} lines`
    const parts: string[] = [header, '', '--- stdout ---', stdout || '(empty)']
    if (stderr) parts.push('', '--- stderr ---', stderr)
    // Test-output summary (2026-10-27 验证闭环): a confident runner-format
    // match earns ONE head line carrying the failure count and the first
    // failing anchor — the part of a 200-line test log a weak model needs to
    // start fixing. Purely additive (summarizeTestOutput returns null unless
    // it recognizes the format), so every other command's output is
    // byte-identical to before.
    const testSummary = summarizeTestOutput(stdout)
    if (testSummary) parts.splice(1, 0, testSummary.line)
    return parts.join('\n')
  }

  // ── Read-only tools (concurrent sync execution) ──────────────────────

  /** Extensions that markitdown can convert to markdown. */
  private static CONVERTIBLE_EXTS = new Set([
    '.pdf', '.docx', '.pptx', '.xlsx', '.xls',
    '.epub', '.msg', '.ipynb',
  ])

  /** Format `read` tool output with file metadata header. `fileSize` undefined
   *  = the stat failed — shown as `?` so it can never read as an empty file. */
  private formatReadOutput(
    filePath: string, fileSize: number | undefined, totalLines: number,
    offset: number, limit: number, content: string,
    extraNote?: string,
  ): string {
    const sizeStr = fileSize === undefined
      ? '?'
      : fileSize > 1024 * 1024
        ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
        : fileSize > 1024
          ? `${(fileSize / 1024).toFixed(1)} KB`
          : `${fileSize} B`
    const readLen = totalLines ? Math.min(limit, Math.max(0, totalLines - offset + 1)) : limit
    const lines: string[] = [
      '--- File Metadata ---',
      `  Path: ${filePath}`,
      `  Size: ${sizeStr}${totalLines ? ` (${totalLines} lines)` : ''}`,
      `  Range: lines ${offset}-${offset + readLen - 1}`,
      `  Numbering: each content line is prefixed with its absolute line number ("N\\t", cat -n style) — a coordinate for referencing (e.g. "edit around line 350"), NOT part of the file. Strip the prefixes when passing text to edit old_str/new_str or write.`,
    ]
    if (extraNote) lines.push(`  Note: ${extraNote}`)
    lines.push('--- End File Metadata ---', '', content)
    return lines.join('\n')
  }

  /** Get total line count of a file. Returns 0 on failure. */
  private async getLineCount(filePath: string): Promise<number> {
    try {
      const isWin = this.opts.platformInfo?.platform === 'win32'
      // The POSIX branch used to escape only `"` while riding a DOUBLE-quoted
      // context — `$( )`/backtick in the path executed as command substitution
      // (review_20261005 P1-03). '…' + shSingleQuote leaves nothing to escape.
      // ~ 不进引号（引号里不展开），按 read 命令同款拼 $HOME。
      const hasTilde = filePath.startsWith('~')
      // ~ 展开的引号坐标（full_20261011 M2-P1-3/X8）：变量必须在引号外——
      // Windows 单引号内的 $env:USERPROFILE 是字面量（读必败）；POSIX 侧与
      // read 的已验证分支同款（"$HOME" + shEscape，shEscape 是 "…" 语境的
      // 转义器），不再走 $HOME 裸奔拼接。
      const cmd = isWin
        ? `(Get-Content -Path ${hasTilde ? `(Join-Path $env:USERPROFILE '${psEscape(filePath.slice(1))}')` : `'${psEscape(filePath)}'`} -Encoding utf8 | Measure-Object -Line).Lines`
        : `wc -l ${hasTilde ? `"$HOME${shEscape(filePath.slice(1))}"` : shSingleQuote(filePath)}`
      const r = await getHost().execCommandSync(cmd)
      if (r.code === 0) {
        const trimmed = r.output.trim()
        const n = isWin ? parseInt(trimmed, 10) : parseInt(trimmed.split(/\s+/)[0], 10)
        return Number.isFinite(n) ? n : 0
      }
    } catch { /* ignore */ }
    return 0
  }

  async execReadOnlyTools(tools: ToolUseBlock[]): Promise<void> {
    const platform = this.opts.platformInfo?.platform || ''
    await Promise.all(tools.map(async (t) => {
      // Reads fan out concurrently — every tool here is genuinely executing,
      // so all enter 'running' at once (dispatch no longer blanket-marks; the
      // other executors carry their own entry mark).
      t.status = 'running'; this.notify()
      try {
        // ── office_inspect: a workspace tool living on the read tier ──
        // (H10: READ_TIER_TOOLS routes it HERE; without this branch it fell
        // through to the shell command builder below and died as
        // "Unknown tool", or worse, ran as a shell command after approval.)
        if (t.name === 'office_inspect') {
          await this.execWorkspaceTool(t)
          return
        }
        // ── office_read: the edit tools' read sibling, same tier ──
        if (t.name === 'office_read') {
          await this.execWorkspaceTool(t)
          return
        }
        // ── office_search: coordinate-anchored content search, same tier ──
        if (t.name === 'office_search') {
          await this.execWorkspaceTool(t)
          return
        }
        // ── `read` tool: metadata header + content ────────────────────
        if (t.name === 'read') {
          // 相对路径挂 workspace、~ 原样（audit 2026-10-10 #6）：stat/markitdown
          // 走主进程的 workspace 坐标，shell 曾按 $HOME 解析同一相对路径——两套
          // 坐标让文本文件读取必败而元数据头还显示 stat 成功。
          const filePath = this.resolveWorkspacePath(String(t.input?.file_path || ''))
          const offset = Number(t.input?.offset) || 1
          // read rides a dedicated budget (MAX_READ_RESULT_TOKENS) instead of
          // the 4K default, so still bound its page size here: the LLM's
          // limit (or the 200-line default) never exceeds 500 lines per call.
          const limit = Math.min(Number(t.input?.limit) || READ_DEFAULT_LINE_LIMIT, READ_MAX_LINE_LIMIT)
          const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()

          const stat = await getHost().getFileStat(filePath)
          const fileSize = stat?.size

          let content: string
          let totalLines = 0

          // markitdown path for binary document formats (cached in tmp/read-cache)
          if (ToolExecutor.CONVERTIBLE_EXTS.has(ext)) {
            const result = await getHost().convertFileToMarkdown(filePath)
            if (result !== null) {
              const lines = result.content.split('\n')
              totalLines = lines.length
              content = numberReadLines(lines.slice(offset - 1, offset - 1 + limit).join('\n'), offset)
              t.status = 'completed'; t.exitCode = 0; t.output = content
              // Convertible formats record too — deliberately. They can never
              // be edited by text write/edit (main-side officeBinaryReject),
              // but WITHOUT an entry the gate would loop the model on "read it
              // first" ↔ read(convert) ↔ edit: with one, the call sails past
              // this gate to the service's accurate 「用 office_edit」 message.
              this.readFilePaths.set(filePath, { mtime: stat?.mtime ?? '', size: stat?.size ?? 0 })
              const note = result.cachePath
                ? `Content converted from original file to markdown. Full conversion saved at: ${result.cachePath}${result.hit ? ' (cached)' : ''}`
                : 'Content converted from original file to markdown.'
              this.addToolResult(t.id, this.formatReadOutput(
                filePath, fileSize, totalLines, offset, limit, content, note,
              ), false, undefined, MAX_READ_RESULT_TOKENS)
              return
            }
            // markitdown failed, fall through to shell
          }

          // Legacy Office formats (.doc/.ppt) are not convertible — refuse with guidance
          // instead of falling through to `cat` which outputs garbled binary.
          if (ext === '.doc' || ext === '.ppt') {
            const fmt = ext === '.doc' ? 'Word' : 'PowerPoint'
            this.addToolResult(t.id,
              `「${ext}」是旧版 ${fmt} 格式，无法直接读取。请先在 Office/WPS 中另存为 .docx/.pptx，再用 office_edit 编辑或 read 查看。`,
              true, undefined, MAX_READ_RESULT_TOKENS)
            return
          }

          // shell path (text files, or markitdown fallback)
          const cmd = buildCommandFromSkillInput(t.name, { ...t.input, file_path: filePath, limit }, platform, this.opts.platformInfo?.ripgrepPath)
          const cwd = String(t.input?.cwd || '')
          const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
          const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
          content = result.output
          const isError = result.code !== 0 && !content

          if (!isError) {
            totalLines = await this.getLineCount(filePath)
            // The ledger's main entry point: text bytes the model has just
            // seen (the stat was taken at this branch's head).
            this.readFilePaths.set(filePath, { mtime: stat?.mtime ?? '', size: stat?.size ?? 0 })
            // Line numbers ride AFTER the ledger entry and only on success —
            // they are presentation over the same bytes the model just read.
            content = numberReadLines(content, offset)
          }

          t.status = 'completed'; t.exitCode = result.code; t.output = content
          this.addToolResult(t.id, isError
            ? (content || `Command failed (exit: ${result.code})`)
            : this.formatReadOutput(filePath, fileSize, totalLines, offset, limit, content),
            isError, undefined, MAX_READ_RESULT_TOKENS)
          return
        }

        // ── git read-only tools: execFile, no shell ───────────────────
        if (t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log') {
          await this.execGitTool(t)
          return
        }

        // ── Other read-only tools ─────────────────────────────────────
        // search/find 的 search_dir 缺省回 workspace、相对挂 workspace（audit
        // 2026-10-10 #5：shell cwd 以 $HOME 兜底，省略曾等于全 home 扫描）；
        // list_dir 的 dir_path 与 read 的 file_path 同一坐标系。审批/白名单
        // 侧的命令重建永远见不到 read 档工具，不需要镜像这份默认值。
        let genericInput: Record<string, unknown> = t.input || {}
        if (t.name === 'search' || t.name === 'find') {
          genericInput = withDefaultSearchDir(genericInput, this.opts.workspaceDir)
        } else if (t.name === 'list_dir') {
          genericInput = { ...genericInput, dir_path: this.resolveWorkspacePath(String(genericInput.dir_path || '')) }
        }
        const cmd = buildCommandFromSkillInput(t.name, genericInput, platform, this.opts.platformInfo?.ripgrepPath)
        const cwd = String(t.input?.cwd || '')
        const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
        const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
        const output = result.output
        t.status = 'completed'; t.exitCode = result.code; t.output = output
        // search：空输出是「无匹配」不是错误（audit 2026-10-10 #4）——rg/grep
        // 无匹配退出码 1 曾被标成 is_error；真实失败的退出码又被尾部 head 的 0
        // 掩盖，只有命令侧 2>&1 并进来的 stderr 文本会说话，非空即原样放行。
        if (t.name === 'search') {
          this.addToolResult(t.id, output || 'No matches found.', false)
          return
        }
        this.addToolResult(t.id, output || (result.code !== 0 ? `Command failed (exit: ${result.code})` : '(no output)'), result.code !== 0)
      } catch (err) {
        t.status = 'completed'; t.exitCode = -1
        const m = `Error: ${err instanceof Error ? err.message : 'exec failed'}`
        t.output = m
        this.addToolResult(t.id, m, true)
      }
    }))
  }

  // ── Git tools (execFile via main process — never a shell string) ───

  // ── Write/Edit tools ─────────────────────────────────────────────────

  async execWorkspaceTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      if (t.name === 'git_commit' || t.name === 'git_restore') {
        await this.execGitTool(t)
        return
      }
      if (t.name === 'write') {
        let fp = String(t.input.file_path || ''); const content = String(t.input.content || ''); const append = t.input.append === true
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        // Read-before-write gate (ENGINEERING_WORKFLOW #1): replacing bytes
        // the model has not seen — or saw but that have since changed on disk
        // — is the silent-loss case. append never destroys existing bytes and
        // a missing stat means a new file, so neither is gated.
        if (!append) {
          const existing = await getHost().getFileStat(fp)
          if (existing && !existing.isDirectory) {
            const rec = this.readFilePaths.get(fp)
            if (!rec) {
              throw new Error(`${fp} already exists and has not been read in this session — read it before replacing it (or use a new file name / append: true)`)
            }
            this.assertUnchangedOnDisk(existing, rec)
          }
        }
        const bytes = utf8ByteLength(content)
        const done = `Written ${bytes} bytes to ${fp}${append ? ' (appended)' : ''}`
        t.output = `Writing ${bytes} bytes to ${fp}...`; this.notify()
        const result = await writeFileChunked(fp, content, append)
        if (result.success) await this.refreshReadSignature(fp)
        // Soft gate (2026-10-27): the manual's ≤5KB-per-call advice, echoed in
        // the result when a call blows past it. Deliberately NOT a rejection —
        // a legit large generated file must not be blocked, the note only
        // keeps the discipline visible (split writes are easier to review
        // and cheaper to retry).
        const sizeNote = bytes > WRITE_SOFT_LIMIT_BYTES
          ? `\n(Note: ${Math.round(bytes / 1024)} KB in one call — keep content under 5KB per write; several consecutive writes are easier to review and cheaper to retry than one giant call.)`
          : ''
        let resultText = result.success ? done + sizeNote : `Error: ${result.error || 'Write failed'}`
        if (result.success) resultText = await this.noteSourceEdit(fp, resultText)
        t.output = result.success ? done : resultText
        this.addToolResult(t.id, resultText, !result.success)
        t.exitCode = result.success ? 0 : 1
      } else if (t.name === 'office_edit') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        // One tool, three formats: the file's extension picks the service
        // (the three main-side editors are unchanged behind the router).
        const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase()
        const format = ext === '.docx' ? 'docx' : ext === '.pptx' ? 'pptx' : ext === '.xlsx' ? 'xlsx' : null
        if (!format) {
          throw new Error(`office_edit 支持 .docx / .xlsx / .pptx，收到「${ext || '无扩展名'}」——读取用 office_read，生成新文件用 export_document`)
        }
        const ops = Array.isArray(t.input.ops) ? t.input.ops : []
        if (ops.length === 0) throw new Error('ops is required (至少一个写入算子；读取 / 定位用 office_read)')
        // Validated BEFORE the service on purpose: the editors back up and
        // snapshot before applying ops, so a batch that could never apply
        // must be refused here — and the read-shaped ops this tool used to
        // carry (docx/pptx outline, xlsx inspect) get their migration hint
        // instead of a backup for nothing (office_read owns reading now).
        for (const op of ops) {
          const kind = String((op as { op?: unknown })?.op ?? '')
          if (kind === 'outline' || kind === 'inspect') {
            throw new Error(`op「${kind}」已由 office_read 承担——office_edit 只做写入。先用 office_read（分页、带段落索引/单元格地址/shape id）再回来编辑。`)
          }
          if (!OFFICE_EDIT_OPS[format].has(kind)) {
            throw new Error(`未知 op「${kind || '(缺失)'}」（${format} 的写入算子: ${[...OFFICE_EDIT_OPS[format]].join(', ')}）`)
          }
        }
        t.output = `Editing ${fp} (${ops.length} op)...`; this.notify()
        // The three office editors share one result shape; the bridge unions
        // them, so the consumer reads through this common view.
        const result = (format === 'docx'
          ? await getHost().editDocx({ filePath: fp, ops: ops as never, workspaceDir: this.opts.workspaceDir })
          : format === 'pptx'
            ? await getHost().editPptx({ filePath: fp, ops: ops as never, workspaceDir: this.opts.workspaceDir })
            : await getHost().editXlsx({ filePath: fp, ops: ops as never, workspaceDir: this.opts.workspaceDir })) as {
          success: boolean
          error?: string
          results?: Array<{ index: number; op: string; ok: boolean; detail: string }>
          outline?: Array<Record<string, unknown>>
          tables?: Array<{ index: number; rows: number; cols: number }>
          warnings?: string[]
          backup?: string
          diff?: string
          changeSummary?: string
        }
        if (result.success) {
          const allResults = (result.results ?? []) as Array<{ index: number; op: string; ok: boolean; detail: string }>
          const detail = allResults.filter((r) => r.ok).map((r) => r.detail).join('; ')
          const summary = `Edited ${fp}: ${detail || 'done'}${result.backup ? ` (备份: ${result.backup})` : ''}`
          // P2.5: append change summary and diff preview
          const parts = [summary]
          if (result.changeSummary) parts.push(`变更摘要:\n${result.changeSummary}`)
          // The post-edit outline rides every write batch (indexes of the
          // CURRENT state — what the next op batch edits against).
          const tables = (result.tables ?? []) as Array<{ index: number; rows: number; cols: number }>
          if (format === 'docx' && tables.length > 0) {
            parts.push(`表格:\n${tables.map((tb) => `表 ${tb.index}：${tb.rows} 行 × ${tb.cols} 列`).join('\n')}`)
          }
          const outline = (result.outline ?? []) as Array<Record<string, unknown>>
          if (outline.length > 0) {
            const isDocx = format === 'docx'
            const isPptx = format === 'pptx'
            const lines = outline.map((o) =>
              isDocx
                ? `[${o.index}] ${o.style ?? '-'}: ${String(o.text ?? '').slice(0, 80)}`
                : isPptx
                  ? `slide ${o.slide}: ${(o.shapes as Array<Record<string, unknown>> ?? []).map((s) => `[${s.shapeId}]${s.phType ? `(${s.phType})` : ''} ${String(s.text ?? '').slice(0, 40)}`).join(' | ').slice(0, 200)}`
                  : `${o.sheet}: ${o.usedRange}`,
            )
            const shown = lines.length > 120
              ? [...lines.slice(0, 120), `…（共 ${lines.length} 项，截断）`]
              : lines
            parts.push(`大纲:\n${shown.join('\n')}`)
          }
          if (result.diff) {
            // Truncate diff to last 80 lines to keep tool result readable
            const lines = result.diff.split('\n')
            const truncated = lines.length > 80 ? `... (${lines.length - 80} 行省略)\n${lines.slice(-80).join('\n')}` : result.diff
            parts.push(`变更预览:\n${truncated}`)
          }
          const toolText = this.noteOfficeEdit(parts.join('\n'))
          t.output = summary
          this.addToolResult(t.id, toolText, false)
          t.exitCode = 0
        } else {
          const msg = `Error: ${result.error || 'Edit failed'}`
          t.output = msg
          this.addToolResult(t.id, msg, true)
          t.exitCode = 1
        }
      } else if (t.name === 'office_inspect') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        t.output = `Inspecting ${fp}...`; this.notify()
        const result = await getHost().inspectOffice({ filePath: fp })
        if (result.success) {
          t.output = result.summary
          // The details ARE the answer (2026-09-28): the old shape shipped the
          // one-line summary and dropped the whole computed inventory — docx
          // gave no paragraphs, xlsx not even sheet names — so every office
          // read paid for inspect AND read/python. formatInspectResult
          // self-caps under the token budget passed here, so its next-step
          // envelope survives as the true last bytes.
          this.addToolResult(t.id, formatInspectResult(result), false, undefined, INSPECT_RESULT_TOKEN_BUDGET)
          t.exitCode = 0
        } else {
          const msg = `Error: ${result.error || result.summary}`
          t.output = msg
          this.addToolResult(t.id, msg, true)
          t.exitCode = 1
        }
      } else if (t.name === 'office_read') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        t.output = `Reading ${fp}...`; this.notify()
        const result = await getHost().readOffice({
          filePath: fp,
          offset: t.input.offset != null ? Number(t.input.offset) : undefined,
          limit: t.input.limit != null ? Number(t.input.limit) : undefined,
          tables: t.input.tables === true,
          sheet: typeof t.input.sheet === 'string' && t.input.sheet !== '' ? t.input.sheet : undefined,
          range: typeof t.input.range === 'string' && t.input.range !== '' ? t.input.range : undefined,
          slide: t.input.slide != null ? Number(t.input.slide) : undefined,
          outline: t.input.outline === true,
        })
        if (result.success) {
          t.output = result.summary
          // The formatted read IS the answer (the inspect lesson, 2026-09-28):
          // the executor never ships the summary alone. formatOfficeReadResult
          // self-caps under the budget passed here, so the next-step envelope
          // (offset/slide/sheet) survives as the true last bytes.
          this.addToolResult(t.id, formatOfficeReadResult(result), false, undefined, MAX_READ_RESULT_TOKENS)
          t.exitCode = 0
        } else {
          const msg = `Error: ${result.error || result.summary}`
          t.output = msg
          this.addToolResult(t.id, msg, true)
          t.exitCode = 1
        }
      } else if (t.name === 'office_search') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        const query = String(t.input.query || '')
        if (!query) throw new Error('query is required')
        t.output = `Searching ${fp}...`; this.notify()
        const result = await getHost().searchOffice({
          filePath: fp,
          query,
          regex: t.input.regex === true,
          caseSensitive: t.input.case_sensitive === true,
          sheet: typeof t.input.sheet === 'string' && t.input.sheet !== '' ? t.input.sheet : undefined,
          slide: t.input.slide != null ? Number(t.input.slide) : undefined,
        })
        if (result.success) {
          t.output = result.summary
          // Same contract as office_read: the formatted hits ARE the answer,
          // the follow-up-read envelope is the true last bytes.
          this.addToolResult(t.id, formatOfficeSearchResult(result), false, undefined, MAX_READ_RESULT_TOKENS)
          t.exitCode = 0
        } else {
          const msg = `Error: ${result.error || result.summary}`
          t.output = msg
          this.addToolResult(t.id, msg, true)
          t.exitCode = 1
        }
      } else if (t.name === 'export_document') {
        // deck 参数已退役（设计路线，PLAN-pptx-html-route）：executor 是
        // export_document 的唯一生产调用方，不转发 deck——旧会话的模型必须
        // 在这里就得到指引，而不是 deck 被静默丢弃后按 content 走 markdown
        // 兜底，或 deck 单独出现时只收到通用的「三选一」报错（服务层的同款
        // 消息只有测试能触达，review_20261006 中9）。文案与
        // svcExportDocument 的退役分支逐字一致。
        if (t.input.deck !== undefined && t.input.deck !== null) {
          throw new Error('deck 参数已退役——从零做 PPT 一律走设计路线：write tokens.css + deck.html 后给 htmlPath（见 office 技能 references/pptx.md）')
        }
        const format = String(t.input.format || '')
        if (!['docx', 'xlsx', 'csv', 'pptx', 'pdf'].includes(format)) throw new Error(`format 必须是 docx / xlsx / csv / pptx / pdf 之一`)
        const content = typeof t.input.content === 'string' && t.input.content.trim() !== '' ? t.input.content : undefined
        const sourcePath = typeof t.input.sourcePath === 'string' && t.input.sourcePath.trim() !== '' ? t.input.sourcePath : undefined
        const htmlPath = typeof t.input.htmlPath === 'string' && t.input.htmlPath.trim() !== '' ? t.input.htmlPath : undefined
        if (!content && !sourcePath && !htmlPath) throw new Error('content / sourcePath / htmlPath 三选一')
        if (htmlPath && format !== 'pptx') throw new Error('htmlPath 仅支持 format pptx——设计路线只产幻灯片')
        if (htmlPath && content) throw new Error('htmlPath 与 content 二选一：设计路线的 HTML 先 write 成文件再走 htmlPath')
        if (htmlPath && sourcePath) throw new Error('htmlPath 与 sourcePath 二选一')
        const fontSize = t.input.fontSize
        if (fontSize !== undefined) {
          if (typeof fontSize !== 'number' || !Number.isFinite(fontSize)) throw new Error(`fontSize 需是 6–72 的数字（磅），收到「${fontSize}」`)
          if (format !== 'docx' && format !== 'pdf') throw new Error(`fontSize 仅支持 format docx / pdf——收到「${format}」`)
        }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const rawPath = String(t.input.file_path || '') || `export-${stamp}.${format}`
        const fp = this.resolveWorkspacePath(rawPath)
        t.output = `Exporting ${format.toUpperCase()} → ${fp}...`; this.notify()
        const result = await getHost().exportDocument({ format: format as 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf', content, sourcePath, htmlPath, fontSize, filePath: fp })
        if (result.success) {
          const summary = `Exported ${result.path} (${Math.round((result.bytes ?? 0) / 1024)} KB)${result.report ? `\n${result.report}` : ''}`
          t.output = summary
          this.addToolResult(t.id, summary, false)
          t.exitCode = 0
        } else {
          const msg = `Error: ${result.error || 'Export failed'}`
          t.output = msg
          this.addToolResult(t.id, msg, true)
          t.exitCode = 1
        }
      } else if (t.name === 'edit') {
        let fp = String(t.input.file_path || '')
        if (!fp) throw new Error('file_path is required')
        fp = this.resolveWorkspacePath(fp)
        // Read-before-write gate (ENGINEERING_WORKFLOW #1), ahead of BOTH
        // forms (diff and old_str): a path the model never read this session
        // cannot be edited from imagination, and a path whose bytes changed
        // after the read must be re-read — old_str could still match while
        // the surrounding intent has moved under it.
        const rec = this.readFilePaths.get(fp)
        if (!rec) {
          throw new Error(`edit requires a prior read of ${fp} in this session — call read on it first, then retry (a path seen in search/list_dir output does not count)`)
        }
        this.assertUnchangedOnDisk(await getHost().getFileStat(fp), rec)

        const diff = String(t.input.diff || '')
        if (diff) {
          const result = await getHost().patchFile({ filePath: fp, diff })
          if (result.success) await this.refreshReadSignature(fp)
          let resultText = result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : `Error: ${result.error || 'Patch failed'}`
          if (result.success) resultText = await this.noteSourceEdit(fp, resultText)
          t.output = result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : resultText
          this.addToolResult(t.id, resultText, !result.success)
          t.exitCode = result.success ? 0 : 1
        } else {
          const oldStr = String(t.input.old_str || ''); const newStr = String(t.input.new_str || ''); const multi = t.input.multi === true
          if (!oldStr) throw new Error('old_str is required (or use diff parameter)')
          const result = await getHost().editFile({ filePath: fp, oldStr, newStr, multi })
          if (result.success) await this.refreshReadSignature(fp)
          let resultText = result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : `Error: ${result.error || 'Edit failed'}`
          if (result.success) resultText = await this.noteSourceEdit(fp, resultText)
          t.output = result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : resultText
          this.addToolResult(t.id, resultText, !result.success)
          t.exitCode = result.success ? 0 : 1
        }
      }
    } catch (err) { const em = `Error: ${err instanceof Error ? err.message : 'exec failed'}`; t.output = em; this.addToolResult(t.id, em, true); t.exitCode = -1 }
    t.status = 'completed'; this.notify()
  }

  // ── MCP tools ─────────────────────────────────────────────────────────
  async execGitTool(t: ToolUseBlock): Promise<void> {
    return execGitTool({ opts: this.opts, addToolResult: this.addToolResult, notify: this.notify }, t)
  }

  async execMCPTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const serverId = this.mcpToolOwner.get(t.name)
      if (!serverId) throw new Error(`No MCP server provides tool "${t.name}"`)
      const result = await getHost().mcpCallTool(serverId, t.name, { ...t.input })
      if (result.success) {
        const raw = typeof result.result === 'object' && result.result !== null
          ? JSON.stringify(result.result, null, 2)
          : String(result.result || '')
        const text = await saveImagesInText(raw)
        // No per-server truncation — the global guardrail in addToolResult caps it.
        t.exitCode = 0; t.status = 'completed'
        this.addToolResult(t.id, text, false)
      } else {
        t.exitCode = 1; t.status = 'completed'
        this.addToolResult(t.id, `MCP error: ${result.error || 'Unknown'}`, true)
      }
    } catch (err) {
      t.exitCode = 1; t.status = 'completed'
      this.addToolResult(t.id, `MCP error: ${err instanceof Error ? err.message : 'Unknown'}`, true)
    }
    this.notify()
  }

  async execInstall(t: ToolUseBlock): Promise<void> {
    return execInstallTool(this, t)
  }

  /** PLAN-plan-split v2 R1: the sub-agent's one growth channel — merge its
   *  proposed subtasks into the PARENT plan. Gated on opts.spawnPlanSplit
   *  (toolset gate) AND the spawn-manager bridge (parentPlanMerge); absent
   *  either, the tool is not in the toolset anyway and the call is rejected
   *  with an actionable error. */
  createSubPlan(children: SplitChildSpec[], reason?: string): { ok: true; nodeIds: string[] } | { ok: false; reason: string } {
    if (!this.opts.spawnPlanSplit) return { ok: false, reason: 'create_sub_plan is not available for this dispatch' }
    return this.parentPlanMerge?.(children, reason) ?? { ok: false, reason: 'no parent plan channel — the bridge was not wired' }
  }

  async execCreateSubPlan(t: ToolUseBlock): Promise<void> {
    return execCreateSubPlanTool(this, t)
  }

  async execPickSkill(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const sm = this.opts.skillManager; const skillName = String(t.input?.name || '').trim()
      // Expert/spawn skill whitelist: skills outside the pack are off-limits
      // (`undefined` = no restriction; an empty set blocks every skill).
      // Experiences stay readable — they're progressive-disclosure records.
      // The gate therefore fires on REGISTERED SKILLS only (audit 2026-10-10
      // #9): the old pre-check rejected every name before the experience
      // lookup, so a restricted expert could not read any experience at all —
      // the opposite of this comment. The intent branch below mirrors it.
      const allowedSkillSet = this.opts.allowedSkills ? new Set(this.opts.allowedSkills) : null
      if (skillName) {
        t.output = `Looking up skill: ${skillName}...`; this.notify()
        const skill = sm!.getSkill(skillName)
        if (skill && allowedSkillSet && !allowedSkillSet.has(skillName)) {
          const msg = `Skill "${skillName}" is not in this session's allowed skills (${[...allowedSkillSet].join(', ')}). Work with what's available.`
          this.addToolResult(t.id, msg, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
        }
        if (skill) {
          const def = await this.freshSkillDefinition(skillName, skill.definition)
          touchSkillUse(skill.definition.name)
          this.addToolResult(t.id, formatSelectedSkill(skill.definition.name, def, this.opts.skillsDir), false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
        // 技能注册表未命中 → 经验页（PLAN-experience-sop B2）。解析序即判词：
        // 同名时上面的已安装技能先赢，这里只接经验名/别名。
        const page = await resolveExperiencePage(skillName)
        if (page) {
          await touchExperiencePage(page.id)
          this.addToolResult(t.id, formatSelectedExperience(page), false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
        this.addToolResult(t.id, `Skill "${skillName}" not found.`, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      const intent = String(t.input?.intent || '')
      if (!intent) throw new Error('Either "name" or "intent" must be provided')
      t.output = `Selecting best skill for: ${intent.slice(0, 80)}...`; this.notify()
      const enabledSkills2 = sm!.getEnabledSkills().filter(s => !allowedSkillSet || allowedSkillSet.has(s.definition.name))
      const expPages = await enabledExperiencePages()
      if (enabledSkills2.length === 0 && expPages.length === 0) { this.addToolResult(t.id, 'No skills or experiences available.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      // 候选表 = 已启用技能 + [experience] 活经验页（PLAN-experience-sop B1）；
      // 经验曝光的另一半走 state block hint（E6，推式）——这里是拉式，两道并行。
      const combinedList = [
        ...enabledSkills2.map(s => `- ${s.definition.name}: ${s.definition.description} (${s.definition.category})`),
        ...expPages.map(experienceCandidateLine),
      ].join('\n')
      const selectedName = await this.skillSelectionAgent.execute(
        { intent, skillsList: combinedList },
        { llmConfig: { adapter: this.opts.adapter, apiKey: this.opts.apiKey || '', baseURL: this.opts.baseURL, model: this.opts.model, modelMaxTokens: this.opts.maxTokens }, maxOutputTokens: 200 }
      )
      if (!selectedName) { this.addToolResult(t.id, 'No matching skill found.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      const cleanName = selectedName.trim()
      // 与名字分支同一裁定（audit 2026-10-10 #9）：白名单只拦已注册技能。候选表
      // 里的经验不在白名单语义内（progressive disclosure，只读知识无需授权），
      // 选中经验必须放行，否则受限专家看到的候选永远选不中。
      const selectedSkill = sm!.getSkill(cleanName)
      if (selectedSkill && allowedSkillSet && !allowedSkillSet.has(cleanName)) {
        this.addToolResult(t.id, `"${cleanName}" selected but it is outside this session's allowed skills. Pick from: ${[...allowedSkillSet].join(', ')}.`, true)
        t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      if (selectedSkill) {
        const def = await this.freshSkillDefinition(cleanName, selectedSkill.definition)
        touchSkillUse(cleanName)
        this.addToolResult(t.id, formatSelectedSkill(cleanName, def, this.opts.skillsDir), false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }
      // 选中名不是注册技能 → 经验页（候选表里 [experience] 行的 title/alias）。
      const pickedExp = await resolveExperiencePage(cleanName)
      if (pickedExp) {
        await touchExperiencePage(pickedExp.id)
        this.addToolResult(t.id, formatSelectedExperience(pickedExp), false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }
      this.addToolResult(t.id, `"${cleanName}" selected but not available.`, true); t.exitCode = 1
    } catch (err) { this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'pick_skill failed'}`, true); t.exitCode = -1 }
    t.status = 'completed'; this.notify()
  }

  /** Page tools (PLAN-browser-extension M2.3): forward to the browser extension
   *  bound to this session and wait for its answer. The host rejects when no
   *  client is bound, which lands here as an `is_error` result — the loop keeps
   *  going and the model can choose another path (§3.4.3). */
  async execPageTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const sessionId = this.opts.conversationId || ''
      const result = await getHost().hostedToolCall(t.name, { ...(t.input || {}) }, { sessionId })
      t.exitCode = 0
      t.status = 'completed'
      this.addToolResult(t.id, typeof result === 'string' ? result : JSON.stringify(result, null, 2), false)
    } catch (err) {
      t.exitCode = -1
      t.status = 'completed'
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : '页面工具执行失败'}`, true)
    }
    this.notify()
  }

  /** Page reads run in parallel — they only look, and their per-tool timeouts
   *  are independent. Writes go through execPageTool one at a time. */
  async execPageReadTools(tools: ToolUseBlock[]): Promise<void> {
    await Promise.all(tools.map((t) => this.execPageTool(t)))
  }

  /** Browser Use (A-M1): run a JS snippet against the host browser runtime.
   *  Screenshots come back as images[] and flow through the existing
   *  base64→tmp-file channel so they render inline in the transcript. */
  async execBrowser(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const code = String(t.input?.code || '')
      if (!code.trim()) throw new Error('code is required')
      const timeoutMs = Number(t.input?.timeoutMs) || undefined
      const r = await getHost().browserRunCode(code, { timeoutMs, conversationId: this.opts.conversationId })
      const parts: string[] = []
      if (r.error) parts.push(`Error: ${r.error}`)
      // A multi-line payload (a snapshot: numbered index, then the ARIA tree) gets
      // its own line — `Result: ── 交互元素编号 [N] ──` reads as a heading glued to
      // a label. Single values (`clicked`, `42`) keep the one-line form.
      parts.push(r.result.includes('\n') ? `Result:\n${r.result}` : `Result: ${r.result}`)
      if (r.console.length > 0) parts.push(`Console:\n${r.console.slice(0, 20).join('\n')}`)
      // imageData 通道一次只载一张（audit 2026-10-10 #7）：旧文案谎报 N 张已
      // 附加，第 2+ 张其实静默丢弃——如实说，并把取回方式指出来。
      if (r.images.length === 1) parts.push('[1 张截图已附加]')
      else if (r.images.length > 1) parts.push(`[${r.images.length} 张截图：仅第 1 张已附加为图片——要看其余的，把 emitImage 拆到单独的调用里逐张取]`)
      t.exitCode = r.error ? 1 : 0
      t.status = 'completed'
      const text = parts.join('\n\n')
      // imageData is raw base64 (UI prepends the data: prefix); the model gets
      // the textual summary — visual reasoning keeps riding the snapshot.
      const firstImage = r.images[0]
      this.addToolResult(t.id, text, !!r.error, firstImage?.base64)
    } catch (err) {
      t.exitCode = -1
      t.status = 'completed'
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'browser run failed'}`, true)
    }
    this.notify()
  }

  async execWebFetch(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      const url = String(t.input?.url || '').trim()
      if (!url) throw new Error('url is required')
      const method = String(t.input?.method || 'GET').toUpperCase()
      const headers = t.input?.headers as Record<string, string> | undefined
      const body = t.input?.body !== undefined ? String(t.input.body) : undefined
      const result = await getHost().apiFetch(url, { method, headers, body })
      if (result === null) throw new Error('Request failed or was blocked')

      // No truncation here — the global guardrail in addToolResult caps it.
      const display = `--- WebFetch ---\n  URL: ${url}\n  Method: ${method}\n  Size: ${result.length.toLocaleString()} chars\n--- End WebFetch ---\n\n${result}`
      this.addToolResult(t.id, display, false)
      t.exitCode = 0
    } catch (err) {
      this.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'fetch failed'}`, true)
      t.exitCode = -1
    }
    t.status = 'completed'; this.notify()
  }

  async execPickTool(t: ToolUseBlock, setSelectedTools: (names: string[]) => void): Promise<void> {
    return pickToolImpl(this, t, setSelectedTools)
  }

  async execSpawnAgent(t: ToolUseBlock): Promise<void> {
    return spawnAgentImpl(this, t)
  }


  // ── Catch-all tool executor ───────────────────────────────────────────

  async execOtherTool(t: ToolUseBlock): Promise<void> {
    t.status = 'running'; this.notify()
    try {
      if (await execRecallTool(this, t)) return
      if (await execMemoryTool(this, t)) return
      if (await execContextCompactTool(this, t)) return
      if (await execToolResultSearchTool(this, t)) return
      if (await execSkillCommand(this, t)) return
      this.addToolResult(t.id, `Unknown tool: ${t.name}`, true)
    } catch (err) {
      this.addToolResult(t.id, `Tool failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

}