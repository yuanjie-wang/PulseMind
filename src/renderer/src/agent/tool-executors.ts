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
import { join } from 'node:path'
import { execGitTool } from './engine/git-tools'
import type { ToolUseBlock } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import type { SpawnSubAgentConfig, SubAgentHandle } from './agent-utils'
import type { Plan } from '../../../shared/types/plan'
import { parseDeckSpec } from '../../../shared/deck/spec'
import { writeFileChunked } from './agent-utils'
import { buildCommandFromSkillInput } from './command-builder'
import { SkillKeywordAgent, SkillSelectionAgent } from './one-shot-agent'
import { saveImagesInText } from './image-utils'
import type { ToolExecContext } from './executors/context'
import type { SkillDefinition } from '../skills/types'
import { execPickTool as pickToolImpl } from './executors/pick-tool'
import { execSpawnAgent as spawnAgentImpl } from './executors/spawn-tool'
import { formatInspectResult, INSPECT_RESULT_TOKEN_BUDGET } from './office-inspect-format'
import { formatOfficeReadResult } from './office-read-format'

/** 经验信封的位置段（PLAN-experience-scripts 1.4）：pick_skill 之前只回
 *  SKILL.md 原文，模型拿到正文也到不了盘上的脚本。与 formatSelectedSkill
 *  的 **Location:** 行同构；`dir` 来自 main 的 list() 计算，取不到记录时
 *  退化为无位置段（现状行为，正文的相对调用命令仍在）。 */
async function experienceLocationBlock(em: { list(): Promise<Array<{ name: string; dir?: string }>> } | undefined, name: string): Promise<string> {
  if (!em) return ''
  try {
    const rec = (await em.list())?.find((e) => e.name === name)
    if (!rec?.dir) return ''
    return `\n\n**Location:** ${join(rec.dir, 'SKILL.md')}\n**Directory:** ${rec.dir}   ← companion scripts live here; read them with read, run them with the terminal (node ${join(rec.dir, 'scripts', '<name>.mjs')} …)`
  } catch {
    return ''
  }
}

import { execMemoryTool, execConversationTool, execKnowledgeTool, execExperienceTool, execContextCompactTool } from './executors/domain-tools'
import { MAX_READ_RESULT_TOKENS } from './engine/engine-constants'
import { execInstallTool } from './executors/install-tool'
import { execCreateSubPlanTool } from './executors/create-sub-plan-tool'
import type { SplitChildSpec } from '../../../shared/plan/split-proposal'

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
const READ_DEFAULT_LINE_LIMIT = 200        // read: default lines per page
const READ_MAX_LINE_LIMIT = 500            // read: hard cap on lines per page (the structural bound; the token-level net is MAX_READ_RESULT_TOKENS)

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

  /** Resolve relative file_path against workspaceDir when set. */
  private resolveWorkspacePath(filePath: string): string {
    const wd = this.opts.workspaceDir
    if (!wd) return filePath
    if (/^[/\\]|[A-Za-z]:[/\\]/.test(filePath)) return filePath
    const sep = wd.includes('\\') ? '\\' : '/'
    return wd + sep + filePath
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
    ]
    if (extraNote) lines.push(`  Note: ${extraNote}`)
    lines.push('--- End File Metadata ---', '', content)
    return lines.join('\n')
  }

  /** Get total line count of a file. Returns 0 on failure. */
  private async getLineCount(filePath: string): Promise<number> {
    try {
      const isWin = this.opts.platformInfo?.platform === 'win32'
      const cmd = isWin
        ? `(Get-Content '${filePath.replace(/'/g, "''")}' -Encoding utf8 | Measure-Object -Line).Lines`
        : `wc -l "${filePath.replace(/"/g, '\\"')}"`
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
        // ── `read` tool: metadata header + content ────────────────────
        if (t.name === 'read') {
          const filePath = String(t.input?.file_path || '')
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
              content = lines.slice(offset - 1, offset - 1 + limit).join('\n')
              t.status = 'completed'; t.exitCode = 0; t.output = content
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
          const cmd = buildCommandFromSkillInput(t.name, { ...t.input, limit }, platform, this.opts.platformInfo?.ripgrepPath)
          const cwd = String(t.input?.cwd || '')
          const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
          const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
          content = result.output
          const isError = result.code !== 0 && !content

          if (!isError) {
            totalLines = await this.getLineCount(filePath)
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
        const cmd = buildCommandFromSkillInput(t.name, t.input || {}, platform, this.opts.platformInfo?.ripgrepPath)
        const cwd = String(t.input?.cwd || '')
        const timeoutMs = t.input.timeout != null ? Number(t.input.timeout) * 1000 : undefined
        const result = await getHost().execCommandSync(cmd, cwd || undefined, timeoutMs)
        const output = result.output
        t.status = 'completed'; t.exitCode = result.code; t.output = output
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
        const bytes = utf8ByteLength(content)
        const done = `Written ${bytes} bytes to ${fp}${append ? ' (appended)' : ''}`
        t.output = `Writing ${bytes} bytes to ${fp}...`; this.notify()
        const result = await writeFileChunked(fp, content, append)
        t.output = result.success ? done : `Error: ${result.error || 'Write failed'}`
        this.addToolResult(t.id, result.success ? done : `Error: ${result.error || 'Write failed'}`, !result.success)
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
          const toolText = parts.join('\n')
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
      } else if (t.name === 'export_document') {
        const format = String(t.input.format || '')
        if (!['docx', 'xlsx', 'csv', 'pptx', 'pdf'].includes(format)) throw new Error(`format 必须是 docx / xlsx / csv / pptx / pdf 之一`)
        const content = typeof t.input.content === 'string' && t.input.content.trim() !== '' ? t.input.content : undefined
        const sourcePath = typeof t.input.sourcePath === 'string' && t.input.sourcePath.trim() !== '' ? t.input.sourcePath : undefined
        const hasDeck = t.input.deck !== undefined && t.input.deck !== null
        if (!content && !sourcePath && !hasDeck) throw new Error('content / sourcePath / deck 三选一')
        if (hasDeck && format !== 'pptx') throw new Error('deck 仅支持 format pptx——其他格式请给 content 或 sourcePath')
        // validate HERE, not just in main: a malformed spec fails before the
        // IPC roundtrip with the same readable message the service would give
        if (hasDeck) {
          const parsed = parseDeckSpec(t.input.deck)
          if (!parsed.ok) throw new Error(parsed.error)
        }
        const fontSize = t.input.fontSize
        if (fontSize !== undefined) {
          if (typeof fontSize !== 'number' || !Number.isFinite(fontSize)) throw new Error(`fontSize 需是 6–72 的数字（磅），收到「${fontSize}」`)
          if (format !== 'docx' && format !== 'pdf') throw new Error(`fontSize 仅支持 format docx / pdf——收到「${format}」`)
        }
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const rawPath = String(t.input.file_path || '') || `export-${stamp}.${format}`
        const fp = this.resolveWorkspacePath(rawPath)
        t.output = `Exporting ${format.toUpperCase()} → ${fp}...`; this.notify()
        const result = await getHost().exportDocument({ format: format as 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf', content, sourcePath, deck: hasDeck ? t.input.deck : undefined, fontSize, filePath: fp })
        if (result.success) {
          const summary = `Exported ${result.path} (${Math.round((result.bytes ?? 0) / 1024)} KB)`
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

        const diff = String(t.input.diff || '')
        if (diff) {
          const result = await getHost().patchFile({ filePath: fp, diff })
          t.output = result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : `Error: ${result.error || 'Patch failed'}`
          this.addToolResult(t.id, result.success ? `Applied ${result.replacements} hunk(s) to ${fp}` : `Error: ${result.error || 'Patch failed'}`, !result.success)
          t.exitCode = result.success ? 0 : 1
        } else {
          const oldStr = String(t.input.old_str || ''); const newStr = String(t.input.new_str || ''); const multi = t.input.multi === true
          if (!oldStr) throw new Error('old_str is required (or use diff parameter)')
          const result = await getHost().editFile({ filePath: fp, oldStr, newStr, multi })
          t.output = result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : `Error: ${result.error || 'Edit failed'}`
          this.addToolResult(t.id, result.success ? `Replaced ${result.replacements} occurrence(s) in ${fp}` : `Error: ${result.error || 'Edit failed'}`, !result.success)
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
      const allowedSkillSet = this.opts.allowedSkills ? new Set(this.opts.allowedSkills) : null
      if (skillName && allowedSkillSet && !allowedSkillSet.has(skillName)) {
        const msg = `Skill "${skillName}" is not in this session's allowed skills (${[...allowedSkillSet].join(', ')}). Work with what's available.`
        this.addToolResult(t.id, msg, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      if (skillName) {
        t.output = `Looking up skill: ${skillName}...`; this.notify()
        const skill = sm!.getSkill(skillName)
        if (skill) {
          const def = await this.freshSkillDefinition(skillName, skill.definition)
          this.addToolResult(t.id, formatSelectedSkill(skill.definition.name, def, this.opts.skillsDir), false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
        // Fall back to the experience library (skill-style progressive disclosure)
        const em = this.opts.experienceManager
        if (em) {
          const raw = await em.read(skillName)
          if (raw) {
            em.touch(skillName).catch(() => {})
            this.addToolResult(t.id, `## Selected Experience: ${skillName}\n\n${raw}${await experienceLocationBlock(em, skillName)}`, false)
            t.exitCode = 0; t.status = 'completed'; this.notify(); return
          }
        }
        this.addToolResult(t.id, `Skill or experience "${skillName}" not found.`, true); t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      const intent = String(t.input?.intent || '')
      if (!intent) throw new Error('Either "name" or "intent" must be provided')
      t.output = `Selecting best skill for: ${intent.slice(0, 80)}...`; this.notify()
      const enabledSkills2 = sm!.getEnabledSkills().filter(s => !allowedSkillSet || allowedSkillSet.has(s.definition.name))
      const experiences2 = this.opts.experienceManager ? await this.opts.experienceManager.list() : []
      if (enabledSkills2.length === 0 && experiences2.length === 0) { this.addToolResult(t.id, 'No skills or experiences enabled.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      const skillsList = enabledSkills2.map(s => `- ${s.definition.name}: ${s.definition.description} (${s.definition.category})`).join('\n')
      const expList = experiences2.map(e => `- ${e.name}: ${e.description} (experience)`).join('\n')
      const combinedList = [skillsList, expList].filter(Boolean).join('\n')
      const selectedName = await this.skillSelectionAgent.execute(
        { intent, skillsList: combinedList },
        { llmConfig: { adapter: this.opts.adapter, apiKey: this.opts.apiKey || '', baseURL: this.opts.baseURL, model: this.opts.model }, maxTokens: 200 }
      )
      if (!selectedName) { this.addToolResult(t.id, 'No matching skill found.', false); t.exitCode = 0; t.status = 'completed'; this.notify(); return }
      const cleanName = selectedName.trim()
      if (allowedSkillSet && !allowedSkillSet.has(cleanName)) {
        this.addToolResult(t.id, `"${cleanName}" selected but it is outside this session's allowed skills. Pick from: ${[...allowedSkillSet].join(', ')}.`, true)
        t.exitCode = 1; t.status = 'completed'; this.notify(); return
      }
      const skill = sm!.getSkill(cleanName)
      if (skill) {
        const def = await this.freshSkillDefinition(cleanName, skill.definition)
        this.addToolResult(t.id, formatSelectedSkill(cleanName, def, this.opts.skillsDir), false)
        t.exitCode = 0; t.status = 'completed'; this.notify(); return
      }
      const em2 = this.opts.experienceManager
      if (em2) {
        const raw2 = await em2.read(cleanName)
        if (raw2) {
          em2.touch(cleanName).catch(() => {})
          this.addToolResult(t.id, `## Selected Experience: ${cleanName}\n\n${raw2}${await experienceLocationBlock(em2, cleanName)}`, false)
          t.exitCode = 0; t.status = 'completed'; this.notify(); return
        }
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
      if (r.images.length > 0) parts.push(`[${r.images.length} 张截图已附加]`)
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
      if (await execMemoryTool(this, t)) return
      if (await execContextCompactTool(this, t)) return
      if (await execConversationTool(this, t)) return
      if (await execKnowledgeTool(this, t)) return
      if (await execExperienceTool(this, t)) return
      this.addToolResult(t.id, `Unknown tool: ${t.name}`, true)
    } catch (err) {
      this.addToolResult(t.id, `Tool failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

}