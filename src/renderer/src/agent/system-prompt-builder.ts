import { getHost } from './host'
import { resolveToolFilePath } from './agent-utils'
import type { AgentMessage, TextBlock, Plan } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import { getCachedSkillPrefs } from './mcp-cache'
import type { GitStatusInfo } from '../../../shared/types/git'
import { formatPlanForPrompt } from '../../../shared/plan/graph'
import { formatForcedSkillsForPrompt, formatSummonForPrompt, type SummonState } from '../../../shared/expert-context'
import { isLivePage } from '../../../shared/memory-pages'
import { detectVerifyCommands } from './verify-loop'

export interface BuildSystemPromptParams {
  opts: AgentEngineOptions
  spawnSystemPrompt?: string
  spawnSystemPromptAppendix?: string
  messages: AgentMessage[]
  plan: Plan | null
  /** 多专家 @召唤（计划模式）：the turn's expert roster. Per-turn state, so it
   *  belongs to the tail — never to the invariant core. Null on every other
   *  turn, including a single-expert summon (that one is a plain delegation). */
  summon?: SummonState | null
  /** The enabled built-ins' usage protocols (buildToolProtocols over the SAME
   *  final toolset the request ships as schemas). Static per toolset, so it
   *  keeps the system prompt's cache contract: it only changes when the tool
   *  schemas change, which invalidates the prefix anyway. Ignored on the
   *  spawned-sub-agent path — a spawn prompt owns its whole system message. */
  toolProtocols?: string
  /** The early-stop guard's continuation directive (2026-10-08): true makes
   *  the state block carry a `## Turn Continuation` section (second-to-last,
   *  clock still last). Consumed by prepareLoopRequest — one request build
   *  only, never persisted, never rendered. */
  continuationNudge?: boolean
  /** Context window gauge (user 2026-10-10): the POST-PIPELINE size of THIS
   *  request — what the model is actually reading after the automatic
   *  nano/light/hard passes (2026-10-24 口径修正). The pre-pipeline reading
   *  (last wire anchor + raw tail, requestTokensOf) over-reads by exactly the
   *  share the pipeline compresses before it ships: a tool-heavy turn pinned
   *  the gauge at 79–96% while the wire carried ~60%, and the model read the
   *  gap as exhaustion and began rationing its work (conv_20261021155951).
   *  `tokens: null` = sentinel mode: the pipeline has not run yet, so the
   *  block carries CONTEXT_GAUGE_SENTINEL and prepareLoopRequest swaps in the
   *  real section afterwards (one replace, one occurrence). Absent → no
   *  section (tests, spawned sessions). Per-turn volatile — state block only,
   *  clock still last. */
  contextUsage?: { tokens: number | null; window: number }
  /** Background-exit wake-ups (2026-10-28 后台任务唤醒): background: true
   *  processes that finished since the last request, as pre-formatted lines.
   *  Rendered as a `## Background Tasks` section and drained by the engine at
   *  build time — one-shot, state block only (never persisted, never
   *  rendered), so the cache contract holds. Absent → no section. */
  backgroundNotices?: Array<{ pid: number; code: number | null; command?: string }>
  /** Still-running background tasks (PLAN-background-tasks E #3) — pid+name,
   *  liveness-checked against backgroundByPid at build time. Per-turn volatile
   *  like the notices: the model's pid memory is lossy (compaction/restart). */
  runningBackgroundTasks?: Array<{ pid: number; name: string }>
  /** PLAN-extension-handoff M3：会话自浏览器扩展移交而来——state block 的
   *  `## Handoff` 告知行（提示不是工具下架，G20 禁 availability 门控）。 */
  handoffNotice?: boolean
  /** `$`-pinned skill names for THIS turn ($-mention in the composer).
   *  Per-turn volatile — state block only, like summon. Null/empty elsewhere. */
  forcedSkills?: ReadonlyArray<string> | null
}

/** Sentinel standing in for the Context Window gauge while the compaction
 *  pipeline runs: the gauge must report the POST-COMPACTION size, but the
 *  pipeline needs the state block's byte length for its overhead estimate
 *  first (chicken-and-egg). prepareLoopRequest builds the block with the
 *  sentinel, runs the pipeline, then single-replaces the sentinel with
 *  buildContextWindowSection's real section — same position (before the
 *  continuation nudge, clock last). Building the block twice instead would
 *  double the per-request host reads (git status, AGENTS.md, knowledge
 *  stats) for one number. */
export const CONTEXT_GAUGE_SENTINEL = '@@PULSEMIND_CONTEXT_GAUGE@@'

export interface BuildSystemPromptResult {
  /**
   * The invariant prefix. Byte-identical across every turn of every conversation
   * and across restarts: it carries only contracts (identity, environment shape,
   * tool-call format, output conventions) plus the memory context, which rides
   * a two-clock TTL (3h global snapshot + 1h per-conversation pin, 2026-09-26
   * user ruling) so its bytes stay stable within a conversation and across the
   * conversations pinning the same window. Everything else follows the old
   * shape: no clock, no git status, no workspace — those are per-turn or
   * per-conversation values and cannot ride a shared prefix.
   *
   * That invariance is the whole point. DeepSeek's cache matches a prompt prefix
   * from token 0 and renders `system → tools → messages`, so the system prompt
   * sits in front of EVERYTHING: one changed byte here (a timestamp, a memory)
   * re-bills the tools and the entire conversation. Keeping it frozen is what
   * makes the cache warm across turns, conversations and restarts.
   */
  systemPrompt: string
  /**
   * Per-turn volatile state, sent as the FINAL message of the request (see
   * AgentEngine.prepareLoopRequest). Null for derived sessions (spawned
   * sub-agents), which supply their own prompt and need no session state.
   */
  stateBlock: string | null
}

export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<BuildSystemPromptResult> {
  const { opts, spawnSystemPrompt, spawnSystemPromptAppendix, messages, plan, summon, toolProtocols, continuationNudge, contextUsage, backgroundNotices, runningBackgroundTasks, handoffNotice } = params

  if (spawnSystemPrompt) {
    const base = spawnSystemPromptAppendix
      ? spawnSystemPrompt + '\n\n' + spawnSystemPromptAppendix
      : spawnSystemPrompt
    // D16: an explicitly pinned expert pack (the assistants) rides ON TOP of a
    // pinned override — the override carries the mechanics (protocol/tool
    // contract), the pack the identity. One assembly site, byte-stable per
    // (override, pack, catalogs): no clock, no DB, no per-turn value.
    const systemPrompt = opts.expert?.instructions
      ? `${base}\n\n${opts.expert.instructions}`
      : base
    // 子代理没有会话状态块（spawn prompt 自含全部机制），但早停守卫的续跑
    // 指令仍须落到线上（2026-10-08）：flag 经 spawn-manager 的 opts 展开继承，
    // stream-runner 的守卫对子代理照常开火——没有这里的最小 state block，
    // pendingEarlyStopNudge 会被 prepareLoopRequest 消费后无处着落，子代理的
    // 续跑退化成一次没有指令的裸重采样。块里只有这一节，单次请求，不落库。
    return {
      systemPrompt,
      stateBlock: continuationNudge ? `<session-state>\n${TURN_CONTINUATION_NUDGE}\n</session-state>` : null,
    }
  }

  const systemPrompt = await buildCorePrompt(opts, toolProtocols)
  const stateBlock = await buildStateBlock({
    opts,
    messages,
    plan,
    summon,
    continuationNudge,
    // 上下文刻度的转发（review_20261011 高4）：生产端（AgentEngine）与消费端
    // （buildStateBlock 的 ## Context Window 节）都在，唯独这一跳漏写——
    // 功能自落库即死，模型对窗口占用全盲。
    contextUsage,
    // backgroundNotices / handoffNotice 的转发（PLAN-extension-handoff 落地时
    // 顺手修正）：params 里有、engine 也传了，但这里从未解构转发——后台任务
    // 的 ## Background Tasks 节在 buildSystemPrompt 这条生产路径上自落库即死，
    // 只有直接调 buildStateBlock 的测试见过它。
    backgroundNotices,
    runningBackgroundTasks,
    handoffNotice,
  })
  return { systemPrompt, stateBlock }
}

/**
 * The frozen part of the prompt: identity + the contracts that hold for every
 * request this app makes. Nothing here may read a clock, git or the settings
 * file — a value that can change mid-session belongs in buildStateBlock
 * instead (or the cached prefix dies with it). The one sanctioned database
 * read is the memory context, whose bytes are held stable by the manager's
 * two-clock TTL (3h global snapshot + 1h per-conversation pin): re-pinning identical
 * bytes is free, so within a conversation and across conversations in the
 * same window this section never moves.
 */
async function buildCorePrompt(opts: AgentEngineOptions, toolProtocols?: string): Promise<string> {
  const parts: string[] = []
  const { myName, soul, yourName, locale, platformInfo } = opts

  // ── Identity ────────────────────────────────────────────────────
  // An expert config pack (a conversation-bound role switch; @-summon now
  // delegates via spawn_agent instead of binding) REPLACES the basic persona:
  // identity precedence is the whole point of the pack. myName survives (it is
  // context about the user, not the assistant); soul/yourName do not.
  if (opts.expert) {
    parts.push(opts.expert.instructions)
    if (myName) parts.push(`The user's name is ${myName}.`)
  } else {
    const personaParts: string[] = []
    if (myName) personaParts.push(`The user's name is ${myName}.`)
    if (yourName) personaParts.push(`You are ${yourName}.`)
    if (soul) personaParts.push(soul)
    if (personaParts.length > 0) {
      parts.push('# Basic Persona & Identity')
      parts.push(personaParts.join('\n'))
    }
  }

  parts.push(buildEnvironmentSection(opts, { locale, platformInfo }))

  if (platformInfo?.platform === 'win32') parts.push(WINDOWS_SHELL_NOTES)

  // ── Local knowledge & memory: JIT 检索协议节（PLAN-memory-wiki M4，2026-10-25）──
  // 零数据、零时钟、零 per-conversation 值——取代 v1 的 Knowledge Base 提示节 +
  // Experience Index + Memory Context（Extracted/Recent）三处动态注入。记忆/
  // 经验/知识库/技能全文的唯一曝光面是检索工具；核心因此永久字节稳定，任何
  // 记忆落库都不再击穿在飞会话的前缀缓存（取代 2026-09-26 双钟 TTL 裁定）。
  parts.push(LOCAL_KNOWLEDGE_MEMORY_SECTION)

  // ── Manual memories（MEMORY.md）：唯一残余的动态节 ──
  // 用户手写 = 永远在场（≈ CLAUDE.md 的地位，2026-10-25 裁定）；字节仅在用户
  // 编辑时变化（mtime 缓存），对缓存契约天然成立。
  if (opts.memoryManager) {
    const manual = await opts.memoryManager.getManualMemoryContext()
    if (manual) parts.push(manual)
  }

  // ── Managed-tool appendix (renderer-provided; empty for the built-in manager) ──
  const toolAppendix = opts.toolManager?.getSystemPromptAppendix()
  if (toolAppendix) parts.push(toolAppendix)

  // ── Tool usage protocols (per-tool markdown from the enabled toolset) ──
  // Sits with the other tool-convention blocks and is static per toolset, so
  // the cached prefix only moves when the tool schemas move anyway.
  // ── Cross-tool batching rule (2026-10-29): static per toolset, so it never
  // moves the cached prefix; it sits immediately above the manuals it qualifies.
  parts.push(PARALLEL_CALLS_SECTION)

  if (toolProtocols) parts.push(toolProtocols)

  parts.push(ENGINEERING_WORKFLOW)
  parts.push(SESSION_STATE_NOTICE)
  parts.push(TOOL_CALL_FORMAT)
  if (opts.earlyStopGuard) parts.push(TASK_COMPLETION_SENTINEL_SECTION)
  parts.push(COMPRESSED_TOOL_RESULTS)
  parts.push(CONTEXT_MANAGEMENT_NOTICE)
  parts.push(RENDER_REFERENCE)
  parts.push(HTML_VISUAL_AIDS)

  return parts.join('\n')
}

/** Environment shape — dirs, locale, platform, output budget. Deliberately clock-free. */
function buildEnvironmentSection(
  opts: AgentEngineOptions,
  { locale, platformInfo }: { locale?: 'zh' | 'en'; platformInfo?: AgentEngineOptions['platformInfo'] },
): string {
  const envParts: string[] = ['## System Info']
  if (platformInfo) {
    envParts.push(`- Operating System: ${platformInfo.platformName} ${platformInfo.release} (${platformInfo.arch})`)
  }
  if (locale) envParts.push(`- Language: ${locale === 'zh' ? 'Chinese (中文)' : 'English'} (${locale})`)
  const isWin = platformInfo?.platform === 'win32'
  const homePrefix = isWin ? '%USERPROFILE%' : '~'
  const sep = isWin ? '\\' : '/'
  envParts.push(`- Config Directory: ${homePrefix}${sep}.pulsemind`)
  envParts.push(`- Skills Directory: ${homePrefix}${sep}.pulsemind${sep}skills`)
  envParts.push(`- Your maximum output limit: ${opts.maxTokens} tokens per response. For large writes, split the content across multiple write calls.`)
  return ['# Running Environment', envParts.join('\n')].join('\n')
}

/**
 * The per-turn tail. Sections are ordered by how often they change: git first,
 * the clock LAST. That order is load-bearing, not cosmetic — within a
 * tool loop the same block is re-sent on every iteration, and the cache can only
 * reuse it up to the first byte that differs, so the one field that always
 * changes (the time) must not sit in front of the ones that didn't. The memory
 * context used to lead this block; it moved into the frozen core (3h snapshot,
 * 2026-09-26) where the prefix cache can actually reuse it — the block is
 * re-sent and re-billed whole on every request.
 */
async function buildStateBlock(params: {
  opts: AgentEngineOptions
  messages: AgentMessage[]
  plan: Plan | null
  summon?: SummonState | null
  continuationNudge?: boolean
  contextUsage?: { tokens: number | null; window: number }
  backgroundNotices?: Array<{ pid: number; code: number | null; command?: string }>
  /** Still-running background tasks (PLAN-background-tasks E #3) — pid+name,
   *  liveness-checked against backgroundByPid at build time. Per-turn volatile
   *  like the notices: the model's pid memory is lossy (compaction/restart). */
  runningBackgroundTasks?: Array<{ pid: number; name: string }>
  /** PLAN-extension-handoff M3：会话自浏览器扩展移交而来。提示不是工具下架
   *  （G20 缓存契约禁 availability 门控）——page_* 的 schema 照常在，模型调了
   *  会得到「没有连接的浏览器客户端」的裸错误；这行让它先知道。 */
  handoffNotice?: boolean
  /** `$`-pinned skill names for THIS turn ($-mention in the composer).
   *  Per-turn volatile — state block only, like summon. Null/empty elsewhere. */
  forcedSkills?: ReadonlyArray<string> | null
}): Promise<string> {
  const { opts, plan, summon, continuationNudge, contextUsage, backgroundNotices, runningBackgroundTasks, handoffNotice, forcedSkills } = params
  const sections: string[] = []

  // Git status — OFF unless the user turned the injection on in settings, and
  // skipped silently outside a repo.
  if (opts.workspaceDir) {
    // A stale preload can leave getSettings undefined, and getHost() throws
    // synchronously when no host is installed (tests) — neither may take the
    // prompt down, so fall through to the default (off).
    const gitEnabled = await readGitInjectionEnabled()
    if (gitEnabled) {
      const gitCtx = await buildGitContext(opts.workspaceDir)
      if (gitCtx) sections.push(gitCtx)
    }
  }

  // 项目概述 (2026-09-18): the bound project's name + ≤50 字 overview, ABOVE
  // its workspace (project → workspace hierarchy). Stable across turns — it
  // only moves when the user edits the project — so the low-volatility bytes
  // sit as early in the block as the contract allows; an unbound or
  // default-project conversation ships no section at all (若无则忽略).
  const projectSection = buildProjectSection(opts.projectName, opts.projectOverview)
  if (projectSection) sections.push(projectSection)

  // Project Instructions (2026-10-07): the workspace's .pulsemind/AGENTS.md —
  // per-project standing instructions, user-authored, read from DISK every
  // iteration like git, so an edit lands on the very next request with no
  // restart. Bytes only move when the user edits the file, so the section sits
  // with the other low-volatility blocks (after ## Project, before the
  // commands). Absent file + a bound project → a one-line pointer that teaches
  // the model the write path; absent + a plain minted workspace → nothing (a
  // scratch dir has no conventions worth recording).
  const instructions = await buildProjectInstructionsSection(opts)
  if (instructions) sections.push(instructions)

  // Project Commands (PLAN-coding-contract P1 #21): OPT-IN, the same shape as
  // the git injection above. Read-only name strings — never executed — so the
  // model verifies with the commands the project ALREADY defines (contract #2).
  // A plain conversation's workspace is a deliberately minted empty dir, so the
  // whole section stays out there; it exists for project conversations and
  // pinned-workspace routines. Rarely-moving bytes sit early, per the ordering
  // contract.
  if (opts.workspaceDir) {
    const commandsEnabled = await readProjectCommandsEnabled()
    if (commandsEnabled) {
      const commands = await buildProjectCommandsSection(opts.workspaceDir)
      if (commands) sections.push(commands)
    }
  }

  const workspace = buildWorkspaceSection(opts.workspaceDir)
  if (workspace) sections.push(workspace)

  // Verify commands (2026-10-27 验证闭环): the workspace's own verification
  // commands, detected from its root manifests. Silent outside a project — a
  // scratch workspace has no manifests, so office sessions ship zero new
  // bytes. Sits with the low-volatility sections (detectVerifyCommands is
  // TTL-cached per workspace — load-bearing, this block rebuilds on EVERY
  // tool-loop iteration), and its own bytes are stable across turns.
  if (opts.workspaceDir) {
    const verify = await buildVerifySection(opts.workspaceDir)
    if (verify) sections.push(verify)
  }

  const planSection = formatPlanForPrompt(plan)
  if (planSection) sections.push(planSection)

  // 多专家 @召唤的作战说明 — right after the plan (which it tells the model to
  // create) and before the page/hints, so the roster reads together with the
  // graph it is about. Turn-scoped, so it vanishes with the turn.
  const summonSection = formatSummonForPrompt(summon ?? null)
  if (summonSection) sections.push(summonSection)

  // $-pinned skills ($-mention, 2026-11-08): same per-turn family as the
  // summon section — right after it, before the page/hints. Turn-scoped, so
  // it vanishes with the turn.
  const forcedSkillsSection = formatForcedSkillsForPrompt(forcedSkills ?? null)
  if (forcedSkillsSection) sections.push(forcedSkillsSection)

  const pageSection = buildPageSection(resolvePageContext(opts))
  if (pageSection) sections.push(pageSection)

  const hints = await buildTurnHints(params)
  if (hints) sections.push(hints)

  // K9 (PLAN-knowledge-base D9): the model gets ONE line saying the base is
  // non-empty — enough to know `knowledge_search` can pay off, without a
  // title index (ruled out). Counts only, inside the state block (the frozen
  // core already carries the static "look it up" hint), clock still last.
  if (opts.knowledgeManager) {
    try {
      // G6: an @知识库 turn counts (and says) only its scope — the model must
      // know its retrieval is narrowed, not assume the whole base is empty.
      const scope = opts.knowledgeBaseScope
      const stats = await opts.knowledgeManager.getStats(scope ? scope.id : undefined)
      if (stats.total > 0) {
        const prefix = scope ? `@${scope.name} · ` : ''
        sections.push(`## Knowledge Base\n- 知识库：${prefix}${stats.total} 个源（${stats.compiled} 已编译），wiki ${stats.wikiFileCount ?? 0} 页`)
      }
    } catch { /* stats unavailable — the section just stays out */ }
  }

  // Background-exit wake-ups (2026-10-28 后台任务唤醒): one-shot news from
  // main's process registry, drained by prepareLoopRequest at build time.
  // Sits just before the gauge — freshest news reads next to the freshest
  // numbers; the clock keeps its last position either way.
  if (backgroundNotices && backgroundNotices.length > 0) {
    sections.push(buildBackgroundTasksSection(backgroundNotices))
  }

  if (runningBackgroundTasks && runningBackgroundTasks.length > 0) {
    sections.push(buildRunningBackgroundTasksSection(runningBackgroundTasks))
  }

  // 会话移交告知（PLAN-extension-handoff M3）：持久 flag（引擎生命周期内每回合
  // 都带），不是一次性 notice——page_* 在桌面端结构性不可用，晚一回合告知就晚
  // 一回合白调。
  if (handoffNotice) {
    sections.push(
      '## Handoff\n- 本会话已从浏览器扩展转入桌面端：page_* 系列工具（page_snapshot/page_click 等）不再可用。如需页面信息，请让用户粘贴内容或截图。'
    )
  }

  // Context Window gauge (user 2026-10-10): the model owns the context_compact
  // decision, so it needs an occupancy number it can trust — the POST-PIPELINE
  // size of this request (sentinel here; prepareLoopRequest swaps the real
  // section in after the compaction pipeline runs). Sits BEFORE the nudge so
  // the continuation directive keeps its "last-but-clock" contract; both are
  // per-turn volatile and the clock re-bills the tail on every request
  // regardless, so the line rides free.
  if (contextUsage) {
    // Narrow through a local: passing contextUsage whole would lose the
    // null-check's property narrowing (TS narrows the access path, not the
    // containing object).
    const gaugeSection = contextUsage.tokens === null
      ? CONTEXT_GAUGE_SENTINEL
      : buildContextWindowSection({ tokens: contextUsage.tokens, window: contextUsage.window })
    sections.push(gaugeSection)
  }

  // Early-stop continuation directive (2026-10-08): armed by stream-runner's
  // guard for exactly one request. Volatile by nature — present only on nudge
  // rounds — so it sits last-but-clock: when absent, only the block tail
  // re-bills. Never persisted, never rendered (state-block contract).
  if (continuationNudge) sections.push(TURN_CONTINUATION_NUDGE)

  sections.push(buildClockSection())

  // Delimiter hygiene (2026-10-24 harness review): every section interpolates
  // external bytes — page titles, project text, git paths, user-authored
  // AGENTS.md bodies — and none of them may be able to CLOSE this wrapper
  // early and keep writing as if it were environment state. SESSION_STATE_NOTICE
  // tells the model the LATEST block is authoritative, so a forged tail would
  // inherit that authority. Neutralize the literal tags anywhere in the body;
  // the escaped forms stay perfectly readable to the model.
  const body = sections.join('\n\n')
    .replaceAll('<session-state>', '<session\\-state>')
    .replaceAll('</session-state>', '<\\/session-state>')
  return `<session-state>\n${body}\n</session-state>`
}

function buildWorkspaceSection(workspaceDir?: string): string | null {
  if (!workspaceDir) return null
  // The Scratch line is per-conversation (it names this workspace), so it lives
  // here and NOT in the frozen core; the spawn env block carries the same rule
  // for sub-agents (they get no state block). Throwaway files under one
  // dot-dir keep a project workspace — the user's own files — unpolluted.
  return `## Workspace\n- Workspace: ${workspaceDir}\n- Scratch: ${workspaceDir}/.pulsemind/tmp — put throwaway/intermediate files here, never loose in the workspace root`
}

/** The `## Verify` state-block section: the detected commands, one line, plus
 *  the one sentence ENGINEERING_WORKFLOW #2 assumes the model can look up.
 *  Returns null when detection finds nothing — the whole section stays out
 *  (an office session must not learn that verify machinery exists). */
async function buildVerifySection(workspaceDir: string): Promise<string | null> {
  const cmds = await detectVerifyCommands(workspaceDir)
  if (cmds.length === 0) return null
  return [
    '## Verify',
    `- Commands: ${cmds.map((c) => `\`${c}\``).join(' · ')}`,
    '- This workspace\'s own verification commands, detected from its manifests. After code changes, run the relevant one before claiming done; do not invent others.',
  ].join('\n')
}

function buildProjectSection(name?: string, overview?: string): string | null {
  if (!name && !overview) return null
  const lines = ['## Project']
  if (name) lines.push(`- Name: ${name}`)
  if (overview) lines.push(`- Overview: ${overview}`)
  return lines.join('\n')
}

/**
 * Cap on the injected Project Instructions body. The state block is re-sent
 * whole on every request, so a pathological file must not ride it verbatim;
 * the tail beyond the cap is replaced by a pointer at the file, which the
 * model can `read` back. Exported so the sub-agent pass-through
 * (executors/spawn-tool.ts) caps identically.
 */
export const MAX_PROJECT_AGENTS_CHARS = 8_000

/**
 * The workspace-local conventions file — PulseMind's OWN namespace under
 * .pulsemind/ (the scratch dir's parent, already the app's own namespace in
 * every workspace). It remains the only WRITE surface: a root AGENTS.md is
 * shared with every other coding tool that reads the repo, so PulseMind
 * never authors it (amended 2026-10-28: the root file is now READ as a
 * fallback — see readProjectInstructions).
 */
export function projectAgentsPath(workspaceDir: string): string {
  return `${workspaceDir}/.pulsemind/AGENTS.md`
}

/**
 * The workspace-root AGENTS.md — the cross-tool conventions file every major
 * coding agent reads. Read-only for PulseMind (fallback source when
 * .pulsemind/AGENTS.md is absent, 2026-10-28): the model is taught to treat
 * its body as context and to record PulseMind-specific conventions in
 * projectAgentsPath instead. Because that body IS injected as standing
 * instructions, isProjectInstructionsPath protects it like the .pulsemind
 * file — user-owned law, edits go through the approval ladder.
 */
export function rootAgentsPath(workspaceDir: string): string {
  return `${workspaceDir}/AGENTS.md`
}

/**
 * Whether a model-supplied file_path names a project instructions file —
 * the write surfaces the state block teaches the model to treat as
 * user-owned law (「never delete or reword existing lines — append, or
 * propose the change first」). Covers BOTH files: .pulsemind/AGENTS.md
 * (PulseMind's own) and the workspace-root AGENTS.md whose body is injected
 * as the read-only fallback — once a file's bytes ride the prompt as law,
 * an unreviewed write to it would poison every later session. The
 * approval-side half of that teaching (2026-10-27): a write/edit to either
 * path is HELD for approval at EVERY level including 'auto' — 「propose the
 * change first」 translated into the ladder; a spawned sub-agent (nobody to
 * approve) gets a flat rejection at dispatch instead. Resolution rides
 * resolveToolFilePath (the executor's own spelling) and the comparison
 * normalizes separators, so `\.pulsemind\…` matches on Windows too. A
 * `~`-spelled path never matches (the read gate's same deliberate gap).
 */
export function isProjectInstructionsPath(filePath: string, workspaceDir?: string): boolean {
  if (!workspaceDir) return false
  const raw = filePath.trim()
  if (!raw) return false
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const target = norm(resolveToolFilePath(raw, workspaceDir))
  return target === norm(projectAgentsPath(workspaceDir)) || target === norm(rootAgentsPath(workspaceDir))
}

// ── repo-root discovery (the root AGENTS.md fallback's third candidate) ──

/** Ancestor levels the `.git` walk visits before giving up. High enough for
 *  any realistic monorepo nesting, low enough that a workspace under a deep
 *  home directory cannot wander toward `/`. */
const REPO_ROOT_WALK_LIMIT = 8

/** Discovery results older than this re-walk (verify-loop's TTL pattern):
 *  buildStateBlock runs on EVERY tool-loop iteration, so an uncached walk
 *  here would multiply by the iteration count. Negative results (no repo —
 *  the minted-scratch case) are cached too; that is the common case. */
export const PROJECT_ROOT_CACHE_TTL_MS = 10 * 60_000

const repoRootCache = new Map<string, { at: number; root: string | null }>()

/** Test reset hook — the module cache must not leak a fixture workspace into
 *  the next test (resetVerifyCommandsCache precedent). */
export function resetProjectInstructionsRootCache(): void {
  repoRootCache.clear()
}

/**
 * The nearest ancestor of workspaceDir containing a `.git` marker (directory
 * or worktree file), or null. Pure fs stats through the host — no git
 * process spawn on the request path. Cached per workspaceDir.
 */
async function discoverGitRoot(workspaceDir: string): Promise<string | null> {
  const now = Date.now()
  const hit = repoRootCache.get(workspaceDir)
  if (hit && now - hit.at < PROJECT_ROOT_CACHE_TTL_MS) return hit.root
  let root: string | null = null
  let dir = workspaceDir
  for (let i = 0; i < REPO_ROOT_WALK_LIMIT; i++) {
    try {
      if (await getHost().getFileStat(`${dir}/.git`)) { root = dir; break }
    } catch { /* stat failure = not a marker here; keep walking */ }
    const parent = dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
    if (!parent || parent === dir) break
    dir = parent
  }
  repoRootCache.set(workspaceDir, { at: now, root })
  return root
}

export interface ProjectInstructionsRead {
  body: string
  /** Absolute path of the file the body came from; null when none was found. */
  path: string | null
  /** 'project' = PulseMind's own .pulsemind/AGENTS.md; 'root' = the shared
   *  workspace-root / repo-root AGENTS.md. */
  source: 'project' | 'root' | null
}

async function readInstructionsFile(path: string): Promise<string> {
  try { return ((await getHost().readFile(path)) ?? '').trim() } catch { return '' }
}

function capInstructionsBody(body: string, path: string): string {
  if (body.length <= MAX_PROJECT_AGENTS_CHARS) return body
  return body.slice(0, MAX_PROJECT_AGENTS_CHARS) +
    `\n\n(The file exceeds ${MAX_PROJECT_AGENTS_CHARS} chars; the rest is not shown — \`read\` ${path} if you need it.)`
}

/**
 * Read + normalize the project-instructions body, first candidate with
 * non-whitespace content wins:
 *   1. .pulsemind/AGENTS.md — PulseMind's own file, the only write surface;
 *   2. <workspaceDir>/AGENTS.md — the shared cross-tool file at the
 *      workspace root (the workspace IS the repo root for most projects);
 *   3. <gitRoot>/AGENTS.md — a workspace nested INSIDE a repo reads the
 *      repo root's shared file (discovery is TTL-cached, negative too).
 * Each candidate is read from disk at point of use — an edit lands on the
 * next request with no registration step (freshSkillDefinition philosophy);
 * only the git-root WALK is cached, since it costs stats per ancestor.
 */
export async function readProjectInstructions(workspaceDir: string): Promise<ProjectInstructionsRead> {
  const projectPath = projectAgentsPath(workspaceDir)
  const projectBody = await readInstructionsFile(projectPath)
  if (projectBody) return { body: capInstructionsBody(projectBody, projectPath), path: projectPath, source: 'project' }
  const rootPath = rootAgentsPath(workspaceDir)
  const rootBody = await readInstructionsFile(rootPath)
  if (rootBody) return { body: capInstructionsBody(rootBody, rootPath), path: rootPath, source: 'root' }
  const gitRoot = await discoverGitRoot(workspaceDir)
  if (gitRoot && gitRoot !== workspaceDir) {
    const repoPath = `${gitRoot}/AGENTS.md`
    const repoBody = await readInstructionsFile(repoPath)
    if (repoBody) return { body: capInstructionsBody(repoBody, repoPath), path: repoPath, source: 'root' }
  }
  return { body: '', path: null, source: null }
}

/**
 * Body-only wrapper (spawn pass-through shape): the content is what a
 * sub-agent needs; provenance lives in the state block's section header.
 */
export async function readProjectInstructionsBody(workspaceDir: string): Promise<string> {
  return (await readProjectInstructions(workspaceDir)).body
}

/**
 * The main agent's `## Project Instructions` state-block section. Full file
 * when present (PulseMind's own, else the shared root AGENTS.md as fallback);
 * otherwise a one-line empty-state pointer — but ONLY for project-bound
 * conversations (opts.projectName): the pointer teaches the write path, and
 * a plain chat's minted scratch workspace has no conventions to record, so
 * it gets nothing at all.
 */
async function buildProjectInstructionsSection(opts: AgentEngineOptions): Promise<string | null> {
  if (!opts.workspaceDir) return null
  const read = await readProjectInstructions(opts.workspaceDir)
  if (read.body && read.path) {
    if (read.source === 'root') {
      return [
        '## Project Instructions',
        `Standing instructions for this project, from ${read.path} — the repo's shared AGENTS.md, also read by other coding tools. Follow it for work in this workspace, but treat it as read-only context: PulseMind-specific conventions belong in ${projectAgentsPath(opts.workspaceDir)} — offer to record them there when the user states one.`,
        read.body,
      ].join('\n')
    }
    return [
      '## Project Instructions',
      `Standing instructions for this project, from ${projectAgentsPath(opts.workspaceDir)}. Follow them for work in this workspace. The file is user-authored: when updating it, never delete or reword existing lines — append, or propose the change first.`,
      read.body,
    ].join('\n')
  }
  if (opts.projectName) {
    return [
      '## Project Instructions',
      `- This project has no .pulsemind/AGENTS.md yet — its standing-instructions file (${projectAgentsPath(opts.workspaceDir)}). When the user states a durable, reusable convention for this project (tone, structure, naming, data rules), offer to record it there; confirm before the first write.`,
    ].join('\n')
  }
  return null
}

/**
 * Whether git-context injection is on. OPT-IN: only an explicit `true` enables
 * it, and a missing or unreadable settings value falls back to OFF
 * (fail-closed) — a stale preload must not silently start shipping the user's
 * repo state to the model.
 *
 * Default-off is the 2026-09-21 ruling. The same field is normalized by
 * `readGitSettings` in src/main/storage/settings-store.ts (the source of truth,
 * written by the toggle in DataRuntimeSettings); keep the three in step.
 */
async function readGitInjectionEnabled(): Promise<boolean> {
  try {
    const settings = await getHost().getSettings()
    return settings?.git?.contextInjection === true
  } catch {
    return false
  }
}

/**
 * Whether project-command injection is on. OPT-IN with the exact fail-closed
 * shape of readGitInjectionEnabled above (PLAN-coding-contract P1 #22): only
 * an explicit `true` enables it, and a missing or unreadable value — or a
 * stale preload without the field — falls back to OFF. The normalization
 * source of truth is `readCommandsSettings` in settings-store.ts; keep the
 * three (store, toggle, here) in step.
 */
async function readProjectCommandsEnabled(): Promise<boolean> {
  try {
    const settings = await getHost().getSettings()
    return settings?.commands?.projectInjection === true
  } catch {
    return false
  }
}

/** Cap on command names per source — the section is a hint, not a menu. */
const MAX_PROJECT_COMMANDS = 30

function parsePackageScripts(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { scripts?: Record<string, string> }
    return Object.keys(parsed.scripts ?? {}).filter((n) => /^[A-Za-z0-9@/:._-]+$/.test(n)).slice(0, MAX_PROJECT_COMMANDS)
  } catch {
    return []
  }
}

/** [project.scripts] entry names, best-effort — a regex walk, not a TOML
 *  parser; anything it cannot see simply stays out. */
function parsePyprojectScripts(toml: string): string[] {
  const out: string[] = []
  let inScripts = false
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    const table = line.match(/^\[(.*)\]$/)
    if (table) { inScripts = table[1] === 'project.scripts'; continue }
    if (!inScripts) continue
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=/)
    if (kv) { out.push(kv[1]); if (out.length >= MAX_PROJECT_COMMANDS) break }
  }
  return out
}

/** Makefile targets, best-effort: a line that looks like `name:` at column 0.
 *  Dot-prefixed special targets (.PHONY) never match; variable-expanded or
 *  pattern targets are exactly the "not guaranteed" part of the contract. */
function parseMakefileTargets(makefile: string): string[] {
  const out: string[] = []
  for (const raw of makefile.split('\n')) {
    const m = raw.match(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*:/)
    if (m && !out.includes(m[1])) {
      out.push(m[1])
      if (out.length >= MAX_PROJECT_COMMANDS) break
    }
  }
  return out
}

async function buildProjectCommandsSection(workspaceDir: string): Promise<string | null> {
  const read = async (name: string): Promise<string | null> => {
    try {
      return await getHost().readFile(`${workspaceDir}/${name}`)
    } catch {
      return null
    }
  }
  const groups: string[] = []
  const pkg = await read('package.json')
  if (pkg) {
    const names = parsePackageScripts(pkg)
    if (names.length > 0) groups.push(`- npm scripts: ${names.map((n) => `\`npm run ${n}\``).join(', ')}`)
  }
  const pyproject = await read('pyproject.toml')
  if (pyproject) {
    const names = parsePyprojectScripts(pyproject)
    if (names.length > 0) groups.push(`- pyproject scripts: ${names.map((n) => `\`${n}\``).join(', ')}`)
  }
  const makefile = await read('Makefile')
  if (makefile) {
    const names = parseMakefileTargets(makefile)
    if (names.length > 0) groups.push(`- make targets (best-effort): ${names.map((n) => `\`make ${n}\``).join(', ')}`)
  }
  if (groups.length === 0) return null
  return [
    '## Project Commands',
    'Command names this project already defines — read from package.json / pyproject.toml / Makefile, listed as strings only, none executed here. Prefer these for building, testing or linting over inventing your own.',
    ...groups,
  ].join('\n')
}

function buildClockSection(): string {
  const ts = new Date()
  const date = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`
  const time = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
  return `## Current Date\n- Date: ${date} ${time} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
}

/**
 * The context-window gauge. Numbers are the REQUEST-side estimate
 * (requestTokensOf): the last real request's wire size plus the tail since —
 * the same reading the UI ring shows, and the only unit where "~N% used" is
 * a true sentence about this window. Below the 55% line a context_compact
 * call is refused; the force target is 0.6×. Exported for the section's math
 * pins.
 */
/** The `## Background Tasks` wake-up section (2026-10-28). Exported pure for
 *  the format pins; prepareLoopRequest drains the engine's queue into the
 *  param, so a notice renders EXACTLY ONCE — the state block is never
 *  persisted, and exec_logs remains the full-output channel if the model
 *  misses the pointer. */
export function buildBackgroundTasksSection(notices: Array<{ pid: number; code: number | null; command?: string }>): string {
  const lines = notices.slice(0, 10).map((n) => {
    // 任务名（PLAN-background-tasks D）：台账带来的命令首行——模型不用再从
    // 会话里回忆 pid 对应哪条命令。截断到 80 列防超长命令撑爆 state block。
    const name = typeof n.command === 'string' && n.command.trim()
      ? ` \`${n.command.trim().split('\n', 1)[0].slice(0, 80)}\``
      : ''
    return `- Background task${name} pid=${n.pid} finished (${n.code === null ? 'killed by a signal' : `exit code ${n.code}`}). Read its final output with exec_logs(pid=${n.pid})${n.code === 0 ? '' : ' and check what went wrong before continuing'}.`
  })
  return ['## Background Tasks', 'These background processes finished since your last turn — you did not need to poll for them:', ...lines].join('\n')
}

/** The still-running half (PLAN-background-tasks E #3): the model's pid memory
 *  is lossy by design (compaction, restart), so the live set re-renders EVERY
 *  turn while anything runs. Exported pure for the format pins. */
export function buildRunningBackgroundTasksSection(tasks: Array<{ pid: number; name: string }>): string {
  const lines = tasks.slice(0, 10).map((t) =>
    `- pid=${t.pid} \`${t.name.slice(0, 80)}\` — still running; read progress with exec_logs(pid=${t.pid}), stop with exec_kill(pid=${t.pid}). The full list (incl. ended ones) is one exec_list call away.`,
  )
  return ['## Background Tasks (running)', 'These background processes are STILL RUNNING — the user may be waiting on them; do not assume their outcome:', ...lines].join('\n')
}

/** The gauge line. The number is the POST-PIPELINE size of THIS request (see
 *  BuildSystemPromptParams.contextUsage for the 口径 history). Guard ③ still
 *  refuses context_compact in transcript-pressure units and prints its own
 *  honest percentage in the refusal envelope, so the line no longer cites the
 *  55% threshold against a differently-unit'd number. */
export function buildContextWindowSection(usage: { tokens: number; window: number }): string {
  const pct = Math.min(100, Math.max(0, Math.round((usage.tokens / usage.window) * 100)))
  const k = (n: number): string => `${Math.round(n / 1000)}K`
  return `## Context Window
- ~${pct}% used (~${k(usage.tokens)} / ${k(usage.window)} tokens) — the size of THIS request, measured after automatic compaction. Every request is re-fitted automatically; work normally and do not rush to finish or ration detail to save context.
- context_compact at a phase boundary, with a handover note, is how you deliberately free room for what comes next; calls with nothing droppable are refused.`
}

/** Which page this turn is about, two sources with a fixed precedence
 *  (2026-11-04): a client-pushed `pageContext` (the browser extension sent its
 *  own tab with the message) is the user's explicit context and wins; the
 *  provider is the desktop session's own built-in browser, consulted live at
 *  build time. A provider that throws or returns null is simply "no page" —
 *  the state block must never take a request down over a browsing detail. */
function resolvePageContext(opts: AgentEngineOptions): AgentEngineOptions['pageContext'] {
  if (opts.pageContext) return opts.pageContext
  if (!opts.pageContextProvider) return undefined
  try {
    return opts.pageContextProvider() ?? undefined
  } catch {
    return undefined
  }
}

/** The state block rebuilds on every tool-loop iteration, so the section is
 *  capped: a `data:`/`blob:` URL or a pathological title must not be re-sent
 *  once per iteration. Two values, no content — reading the page is a tool
 *  call by design. */
const PAGE_URL_MAX_CHARS = 300
const PAGE_TITLE_MAX_CHARS = 120

function clipForPrompt(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function buildPageSection(pageContext?: AgentEngineOptions['pageContext']): string | null {
  if (!pageContext?.url && !pageContext?.title) return null
  const lines = ['## Current Page']
  if (pageContext.title) lines.push(`- Title: ${clipForPrompt(pageContext.title, PAGE_TITLE_MAX_CHARS)}`)
  if (pageContext.url) lines.push(`- URL: ${clipForPrompt(pageContext.url, PAGE_URL_MAX_CHARS)}`)
  // The hint names the tool family that can actually reach the page: `page_*`
  // only exists while a browser-extension client is bound (an app-pane session
  // has none of them in its toolset), while `browser` drives both backends —
  // including the app-view tabs listed here.
  lines.push(
    pageContext.source === 'builtin'
      ? "This conversation's built-in browser has this page open. Read it with the `browser` tool (agent.browsers.tabs.list() → tab.domSnapshot()); do not assume its content from the URL alone."
      : 'The user is looking at this page right now. Read or act on it with the `page_*` tools; do not assume its content from the URL alone.',
  )
  return lines.join('\n')
}

/** Last user message text — the input both keyword matchers read. */
function latestUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    for (const block of messages[i].contentBlocks) {
      if (block.type === 'text') return (block as TextBlock).text
    }
  }
  return ''
}

/**
 * Per-turn capability hints. These used to be appended to the last user message
 * in the API copy, which mutated a message inside the cached history and silently
 * vanished once a tool result added a text-less user message ahead of it. They now
 * ride the state block, so the user's own message stays pristine.
 */
async function buildTurnHints(params: {
  opts: AgentEngineOptions
  messages: AgentMessage[]
}): Promise<string | null> {
  const { opts, messages } = params
  const userText = latestUserText(messages)
  if (!userText) return null

  // 经验 hint v2 回归（PLAN-capability-followups E6，对齐 skill 触发）：aliases
  // 关键词命中 + hint 内联全文；与 recall 彻底隔离（读取不经检索）。
  const blocks: string[] = []
  const skills = matchSkills(userText, opts)
  if (skills) blocks.push(skills)
  const experiences = await matchExperiences(userText, opts.memoryManager)
  if (experiences) blocks.push(experiences)
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

/** Keyword auto-trigger for skills (reads the shared prefs cache). */
function matchSkills(userText: string, opts: AgentEngineOptions): string | null {
  const prefs = getCachedSkillPrefs()
  const skillKeywords = prefs.skillKeywords || {}
  const enabledSkills = opts.skillManager?.getEnabledSkills() || []
  if (Object.keys(skillKeywords).length === 0 || enabledSkills.length === 0) return null

  const lowered = userText.toLowerCase()
  const matched: { name: string; description: string }[] = []
  for (const [skillName, keywords] of Object.entries(skillKeywords)) {
    if (!keywords.some((kw) => lowered.includes(kw.toLowerCase()))) continue
    const skill = enabledSkills.find((s) => s.definition.name === skillName)
    if (skill) matched.push({ name: skill.definition.name, description: skill.definition.description })
  }
  if (matched.length === 0) return null
  return '[Possible skills: <skills>' +
    matched.map((s) => `<skill><name>${s.name}</name><description>${s.description}</description></skill>`).join('') +
    '</skills>]'
}


/** 经验 hint v2（PLAN-capability-followups E6）：experience 记忆页的 aliases
 *  关键词命中（matchSkills 同款 substring），命中页 hint 内联全文（title + summary
 *  (E3)/正文首段 + body）——与 recall 彻底隔离（E7 收窄：列表召回排除 experience）。
 *  索引 60s TTL（ExperienceManager 先例）。 */
const EXP_HINT_CACHE_TTL_MS = 60_000
let expHintCache: { at: number; pages: Array<{ title: string; summary: string | null; body: string; aliases: string[] }> } | null = null

const EXP_HINT_INLINE_CAP = 2000
const EXP_HINT_MAX = 3

async function matchExperiences(
  userText: string,
  memoryManager?: AgentEngineOptions['memoryManager'],
): Promise<string | null> {
  if (!memoryManager) return null
  const now = Date.now()
  if (!expHintCache || now - expHintCache.at >= EXP_HINT_CACHE_TTL_MS) {
    try {
      const all = await getHost().listMemoryPages('experience')
      expHintCache = {
        at: now,
        // 停用的经验不进提示（matchSkills 只看 getEnabledSkills 的同款语义）；只有显式 false 才算停用；
        // 退役页同排除（园丁判它过时）
        pages: all.filter((p) => isLivePage(p) && p.enabled !== false).map((p) => ({ title: p.title, summary: p.summary, body: p.body, aliases: p.aliases })),
      }
    } catch {
      return null
    }
  }
  if (expHintCache.pages.length === 0) return null
  const lowered = userText.toLowerCase()
  const matched = expHintCache.pages.filter((p) => p.aliases.some((a) => a && lowered.includes(a.toLowerCase())))
  if (matched.length === 0) return null
  const items = matched.slice(0, EXP_HINT_MAX).map((p) => {
    const head = p.summary ? p.summary : p.body.slice(0, 120)
    const body = p.body.length <= EXP_HINT_INLINE_CAP
      ? p.body
      : `${p.body.slice(0, 800)}…（正文被截断，技能中心查看全文）`
    return `<experience><title>${p.title}</title><summary>${head}</summary><body>${body}</body></experience>`
  })
  return '[Possible experiences: <experiences>' + items.join('') + '</experiences>]'
}

/**
 * Snapshot a git status summary for the given cwd. Returns null when not a repo
 * (silent skip).
 *
 * ONE git call, deliberately. This runs on EVERY tool-loop iteration of a turn
 * (AgentEngine.prepareLoopRequest → buildSystemPrompt → buildStateBlock), so
 * each call here is multiplied by the iteration count, not the turn count —
 * measured at ~10ms/iteration on this machine. A `rev-parse
 * --is-inside-work-tree` precheck used to guard the `status` call, but it was
 * pure waste: `status` already reports `isRepo`, and the main-process
 * `gitStatus` returns `{ isRepo: false }` (not an error) for a non-repo cwd, so
 * both the non-repo and the failure paths land on the same `return null` below.
 *
 * Do NOT reintroduce a probe call before this one. tests/git-context.test.ts
 * pins the call count.
 */
/** Per-list cap on git-context file entries (2026-10-24 harness review): the
 *  state block is re-sent whole on every request, and git runs
 *  `--untracked-files=all` — a workspace without node_modules/dist ignored
 *  would otherwise ride tens of thousands of file lines into every iteration
 *  of a tool loop. Same shape as MAX_PROJECT_COMMANDS: head + a count pointer.
 *  The FULL counts stay in each header line, so nothing is hidden. */
const MAX_GIT_LIST_ENTRIES = 50

function gitListLines(label: string, files: string[]): string[] {
  if (files.length === 0) return []
  const shown = files.slice(0, MAX_GIT_LIST_ENTRIES).map((f) => `  ${f}`)
  const more = files.length > MAX_GIT_LIST_ENTRIES
    ? [`  … +${files.length - MAX_GIT_LIST_ENTRIES} more (use git to list)`]
    : []
  return [`${label} (${files.length}):`, ...shown, ...more]
}

async function buildGitContext(cwd: string): Promise<string | null> {
  try {
    const status = await getHost().gitInvoke({ action: 'status', cwd })
    if (!status.ok) return null
    const d = status.data as GitStatusInfo
    if (!d.isRepo) return null
    const lines = ['--- Git Context ---', `Repo: ${cwd} (branch: ${d.branch ?? 'detached'})`, `Ahead: ${d.ahead} | Behind: ${d.behind}`]
    lines.push(...gitListLines('Staged', d.staged))
    lines.push(...gitListLines('Unstaged', d.unstaged))
    lines.push(...gitListLines('Untracked', d.untracked))
    lines.push(...gitListLines('Conflicts', d.conflict))
    lines.push('--- End Git Context ---')
    return lines.join('\n')
  } catch {
    return null
  }
}

/**
 * Coding behaviour contract (2026-09-27, PLAN-coding-contract P0-1). Lives in
 * the FROZEN CORE on purpose: it never varies per turn, per workspace or per
 * conversation, so it rides the cached prefix. Never read a value that can
 * change while the app runs from here — that is what buildStateBlock is for.
 * Do not make it conditional on the enabled toolset either: toggling `edit`
 * off would fork the shared trunk (see engine/tool-collection.ts, the
 * gated-manual ruling). Exported so the spawn path (executors/spawn-tool.ts)
 * hangs the same contract on sub-agent prompts — sub-agents do the coding and
 * must answer to the same rules; their prompts are per-session, so there the
 * append costs no shared cache bytes.
 */
/** JIT 检索协议节（PLAN-memory-wiki M4，2026-10-25）——零数据、字节恒定。
 *  红线：本节不得携带任何运行时数据/时钟/会话值（buildCorePrompt 纪律）。 */
const LOCAL_KNOWLEDGE_MEMORY_SECTION = `## Local Knowledge & Memory

Everything local is reachable through ONE retrieval tool, and NONE of it is injected into your context:

- **recall** — one federated search across the memory wiki (the user's preferences, decisions, facts), past conversation records, and the knowledge base (compiled wiki + raw documents). [knowledge] hits carry the absolute md path — open the full document with **read**.
- **pick_skill** — installed skill full texts AND experiences: playbooks distilled from this user's past conversations. recall does NOT return experiences; pick_skill (by intent, or by an experience's title/alias) is the only way to pull one deliberately. A \`[Possible experiences: …]\` hint in the turn context means some were already matched for you.

On every task-bearing turn (not small talk), recall BEFORE acting: standing preferences, past decisions, related past work and compiled docs all surface in one query; for a reusable playbook, pick_skill by intent. One cheap retrieval beats redoing a solved problem or violating a standing preference. If recall returns nothing, retry once with different keywords before concluding the store has nothing.`

export const ENGINEERING_WORKFLOW = `\
## Engineering Workflow

These hold on every code change, in every turn.

1. Read before you write. Only a \`read\` of the file in this session counts as having read it — a path seen only in \`list_dir\`, in \`search\` output, or in an earlier turn does not. \`edit\`'s \`old_str\` must be copied from bytes you just read, never reconstructed from memory. Enforced: \`edit\` on any file, and \`write\` replacing an existing file, are rejected until a \`read\` or your own \`write\` has touched that path this session, and re-rejected if the file changed on disk after that read — when rejected, read the file and retry.
2. Verify before you claim done. An edit succeeding is not the change working. After editing, run the command this workspace already uses for building, testing or linting (check \`package.json\` scripts, \`Makefile\`, \`pyproject.toml\`, \`Cargo.toml\`). If none exists, say so — never invent one. Paste failures verbatim, fix, and re-run. If you could not run anything, state exactly what is unverified; never imply a check happened.
3. Never invent an API. Do not call a function, import a module, pass a flag, or cite a config key that you have not seen in this workspace or in a tool result during this session. Confirm it first (\`search\` the dependency's source or types, \`webfetch\` the docs) or ask. A plausible-looking guess is still a guess — never present one as fact.
4. Match the code around you. Follow the existing naming, error handling and comment style. Do not reformat, reorder or rename lines you were not asked to touch, and do not silently expand scope.`

const WINDOWS_SHELL_NOTES = `\
## Windows Shell Notes
- Commands run in Windows PowerShell 5.x via \`powershell.exe\`.
- Many Unix command aliases ARE available: \`ls\`, \`cat\`, \`pwd\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`echo\`, \`dir\`.
- The following common commands are NOT available: \`grep\`, \`tail\`, \`head\`, \`chmod\`, \`chown\`, \`sudo\`, \`which\`, \`touch\`.
- \`&&\` chaining is NOT supported. Use \`;\` to run commands sequentially, or use separate tool calls.
- Use \`findstr\` or \`Select-String\` instead of \`grep\`.
- Use \`Get-ChildItem\` instead of \`ls -la\` (though \`ls\` alias works for simple cases).
- Environment variables: use \`$env:VARNAME\` (PowerShell) or \`%VARNAME%\` (cmd.exe compat).
- File paths: both forward slashes (\`/\`) and backslashes (\`\\\`) work in PowerShell.
- Default home directory: \`%USERPROFILE%\` (typically \`C:\\Users\\<username>\`).`

const SESSION_STATE_NOTICE = `\
## Session State
Volatile per-turn context — the current date and time, the workspace, git status, the current plan, the page a browser client is showing, and any matching skills/experiences — is appended as a \`<session-state>\` block in the FINAL message of the request. Read the values from the LATEST block; earlier blocks in the history are snapshots of earlier turns and may be stale.`

// ── Batch independent calls (2026-10-29) ─────────────────────────────
// The engine has always run read/list_dir/find/search under Promise.all
// (execReadOnlyTools), but no manual ever said so — every one of them taught
// a single call, so investigating ten files cost ten round trips, each
// re-paying the whole context. This is the cross-tool rule that says the
// engine's capability out loud; it rides the shared trunk (static per
// toolset) instead of being repeated inside each tool's own manual.
const PARALLEL_CALLS_SECTION = `\
# Batching Independent Calls

Each round trip re-sends the whole context, so the number of MESSAGES matters as much as the number of calls.

- Two or more calls whose arguments do not depend on each other's RESULT belong in the SAME assistant message. read / list_dir / find / search then run concurrently — one wave, one latency.
- Investigating N files or N directories is ONE message carrying N calls, not N messages carrying one.
- Serialize only a real dependency: resolve a path before reading it, search before reading the hits it returns.
- Ordering still governs writes, edits and shell commands — they keep their sequence. Batching is for read-only exploration.`

const TOOL_CALL_FORMAT = `\
## Tool Call Format

Only call tools via the API's structured JSON tool-call mechanism. Never emit XML tags like \`<invoke name="...">\` — such text is treated as prose and will NOT execute. Follow the tool definitions provided with this request.

When a message carries tool calls, its prose states INTENT and facts already in your context — never pre-write what a tool will return. Tool output exists only in tool results and in the latest \`<session-state>\` block; narrate what a tool returned only after its result has arrived, quoting that result.`

/**
 * Early-stop guard companion (2026-10-08, per-model opt-in): taught ONLY to
 * models with LlmModelConfig.earlyStopGuard — conditional on the model, never
 * on the enabled toolset (that fork is forbidden; a per-model fork is fine:
 * there is no cross-model cache sharing to protect). Static bytes, so the
 * shared-prefix contract holds for every conversation on that model. The
 * marker itself is decoded by engine/task-sentinel.ts; spawn-tool.ts hangs
 * the same section on sub-agent prompts of guarded models.
 */
export const TASK_COMPLETION_SENTINEL_SECTION = `\
## Task Completion

Doing the work takes precedence over replying. While any part of the user's request is still unfinished, do NOT end the turn — continue by calling the tools you need, request after request, until the work is done. Only when the task is fully complete, end your final reply with this exact marker on a line by itself:

<<TASK_DONE>>

A reply that ends without the marker while tools were used this turn may be treated as an unfinished turn and automatically continued.`

const TURN_CONTINUATION_NUDGE = `\
## Turn Continuation

Your previous reply ended without tool calls, but this turn has already done tool work and the completion marker was absent — this may be an unfinished turn. If the task still has remaining steps, continue it NOW by calling tools. Only if it is fully complete, restate the final result briefly and end with <<TASK_DONE>> alone on the last line.`

const COMPRESSED_TOOL_RESULTS = `\
## Compressed Tool Results

Very old tool execution results may be compressed to save context space. You may encounter these two markers inside tool result content:

- \`⟨archived: <uuid>⟩\` — the original tool result content was removed to fit the context window. The result DID happen, but its full text is gone. Use the \`tool_result_search\` tool with the uuid (copied VERBATIM from the marker) to retrieve the original content if you need it. This marker is an ARCHIVE notice, not a failure.
- \`[tool_result_error] ...\` — the tool call FAILED (timeout, truncated parameters, nonzero exit code, etc.). The tool did NOT complete its task. Do not claim the task was done; treat the remaining text as the error message and respond accordingly.`

const CONTEXT_MANAGEMENT_NOTICE = `\
## Context Management

When the conversation grows long, older context is compacted automatically: a summary, verbatim key user messages, and an archived-reads reminder are injected into subsequent requests, and archived tool results stay retrievable in full via \`tool_result_search\` by their \`tool_result_id\`. Compaction needs nothing from you — continue the current task as if the break never happened; do not wrap up early, re-explore files the reminder already names, or change how you work because the context is long. At a phase boundary you may free room immediately with the \`context_compact\` tool (a handover note markedly improves what the summary preserves).`

const RENDER_REFERENCE = `\
## Render Reference

The chat UI supports enhanced rendering for standard Markdown links and images: \`[](uri)\` renders as clickable cards; \`![](uri)\` renders inline images. The \`uri\` can be \`file://\` (local file) or \`http(s)://\` (web URL).`

const HTML_VISUAL_AIDS = `\
## Visual HTML Aids

When a visual would explain better than prose — a multi-dimension comparison, a timeline or process flow, a data chart, an infographic, a small interactive demo — you may render it directly in the chat: emit a self-contained static HTML fragment in a \`\`\`html fenced block, and the chat UI renders it as a sandboxed preview card. Hard requirements: all CSS and JS inline in the fragment; no external network resources — no CDN scripts, fonts, or stylesheets (enforced: the preview sandbox blocks every network load, so a CDN reference breaks the card); design for a WHITE background; keep the fragment under ~30KB. The card enhances the answer, never replaces it — keep the surrounding prose. When the user asks to visualize or compare something in the conversation, prefer the card over writing an HTML file; write an HTML file only when the user asks for a file deliverable.`
