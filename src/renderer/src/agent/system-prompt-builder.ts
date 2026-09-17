import { getHost } from './host'
import type { AgentMessage, TextBlock, Plan } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import { getCachedSkillPrefs } from './mcp-cache'
import type { GitStatusInfo } from '../../../shared/types/git'
import { formatPlanForPrompt } from '../../../shared/plan/graph'
import { formatSummonForPrompt, type SummonState } from '../../../shared/expert-context'

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
}

export interface BuildSystemPromptResult {
  /**
   * The invariant prefix. Byte-identical across every turn of every conversation
   * and across restarts: it carries only contracts (identity, environment shape,
   * tool-call format, output conventions) and never a value that can change while
   * the app runs — no clock, no memory, no git status, no workspace.
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
   * sub-agents, canvas), which supply their own prompt and need no session state.
   */
  stateBlock: string | null
}

export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<BuildSystemPromptResult> {
  const { opts, spawnSystemPrompt, spawnSystemPromptAppendix, messages, plan, summon, toolProtocols } = params

  if (spawnSystemPrompt) {
    const systemPrompt = spawnSystemPromptAppendix
      ? spawnSystemPrompt + '\n\n' + spawnSystemPromptAppendix
      : spawnSystemPrompt
    return { systemPrompt, stateBlock: null }
  }

  const systemPrompt = await buildCorePrompt(opts, toolProtocols)
  const stateBlock = await buildStateBlock({
    opts,
    messages,
    plan,
    summon,
  })
  return { systemPrompt, stateBlock }
}

/**
 * The frozen part of the prompt: identity + the contracts that hold for every
 * request this app makes. Nothing here may read a clock, the database, git or
 * the settings file — a value that can change mid-session belongs in
 * buildStateBlock instead (or the cached prefix dies with it).
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

  // ── Wiki knowledge context: presence hint only (no index injection) ──
  // The model is told the knowledge base exists so it knows to look it up via
  // knowledge_search / knowledge_read. Experts search the same global base.
  parts.push(`## Knowledge Base

You have a local knowledge base (compiled wiki) of project documents and past compiled knowledge. It is NOT shown here — look things up on demand with the knowledge_search and knowledge_read tools when relevant.`)

  // ── Experience index: name-only second channel (progressive disclosure) ──
  if (opts.experienceManager) {
    const expIndex = await opts.experienceManager.buildNameIndex()
    if (expIndex) parts.push(expIndex)
  }

  // ── Managed-tool appendix (renderer-provided; empty for the built-in manager) ──
  const toolAppendix = opts.toolManager?.getSystemPromptAppendix()
  if (toolAppendix) parts.push(toolAppendix)

  // ── Tool usage protocols (per-tool markdown from the enabled toolset) ──
  // Sits with the other tool-convention blocks and is static per toolset, so
  // the cached prefix only moves when the tool schemas move anyway.
  if (toolProtocols) parts.push(toolProtocols)

  parts.push(SESSION_STATE_NOTICE)
  parts.push(TOOL_CALL_FORMAT)
  parts.push(COMPRESSED_TOOL_RESULTS)
  parts.push(RENDER_REFERENCE)

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
 * The per-turn tail. Sections are ordered by how often they change: memory and
 * git first, the clock LAST. That order is load-bearing, not cosmetic — within a
 * tool loop the same block is re-sent on every iteration, and the cache can only
 * reuse it up to the first byte that differs, so the one field that always
 * changes (the time) must not sit in front of the ones that didn't.
 */
async function buildStateBlock(params: {
  opts: AgentEngineOptions
  messages: AgentMessage[]
  plan: Plan | null
  summon?: SummonState | null
}): Promise<string> {
  const { opts, plan, summon } = params
  const sections: string[] = []

  if (opts.memoryManager) {
    const memoryContext = await opts.memoryManager.buildMemoryContext()
    if (memoryContext) sections.push(memoryContext)
  }

  // Git status — skipped silently outside a repo, and when the user turned the
  // injection off in settings.
  if (opts.workspaceDir) {
    // A stale preload can leave getSettings undefined, and getHost() throws
    // synchronously when no host is installed (tests) — neither may take the
    // prompt down, so fall through to injecting git context.
    const gitEnabled = await readGitInjectionEnabled()
    if (gitEnabled) {
      const gitCtx = await buildGitContext(opts.workspaceDir)
      if (gitCtx) sections.push(gitCtx)
    }
  }

  const workspace = buildWorkspaceSection(opts.workspaceDir)
  if (workspace) sections.push(workspace)

  const planSection = formatPlanForPrompt(plan)
  if (planSection) sections.push(planSection)

  // 多专家 @召唤的作战说明 — right after the plan (which it tells the model to
  // create) and before the page/hints, so the roster reads together with the
  // graph it is about. Turn-scoped, so it vanishes with the turn.
  const summonSection = formatSummonForPrompt(summon ?? null)
  if (summonSection) sections.push(summonSection)

  const pageSection = buildPageSection(opts.pageContext)
  if (pageSection) sections.push(pageSection)

  const hints = await buildTurnHints(params)
  if (hints) sections.push(hints)

  // K9 (PLAN-knowledge-base D9): the model gets ONE line saying the base is
  // non-empty — enough to know `knowledge_search` can pay off, without a
  // title index (ruled out). Counts only, inside the state block (the frozen
  // core already carries the static "look it up" hint), clock still last.
  if (opts.knowledgeManager) {
    try {
      const stats = await opts.knowledgeManager.getStats()
      if (stats.total > 0) {
        sections.push(`## Knowledge Base\n- 知识库：${stats.total} 个源（${stats.compiled} 已编译），wiki ${stats.wikiFileCount ?? 0} 页`)
      }
    } catch { /* stats unavailable — the section just stays out */ }
  }

  sections.push(buildClockSection())

  return `<session-state>\n${sections.join('\n\n')}\n</session-state>`
}

function buildWorkspaceSection(workspaceDir?: string): string | null {
  if (!workspaceDir) return null
  return `## Workspace\n- Workspace: ${workspaceDir}`
}

/** Whether the user left git-context injection on (default true, missing settings = on). */
async function readGitInjectionEnabled(): Promise<boolean> {
  try {
    const settings = await getHost().getSettings()
    return settings?.git?.contextInjection !== false
  } catch {
    return true
  }
}

function buildClockSection(): string {
  const ts = new Date()
  const date = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`
  const time = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
  return `## Current Date\n- Date: ${date} ${time} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
}

function buildPageSection(pageContext?: AgentEngineOptions['pageContext']): string | null {
  if (!pageContext?.url && !pageContext?.title) return null
  const lines = ['## Current Page']
  if (pageContext.title) lines.push(`- Title: ${pageContext.title}`)
  if (pageContext.url) lines.push(`- URL: ${pageContext.url}`)
  lines.push('The user is looking at this page right now. Read or act on it with the `page_*` tools; do not assume its content from the URL alone.')
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

  const blocks: string[] = []
  const skills = matchSkills(userText, opts)
  if (skills) blocks.push(skills)
  const experiences = await matchExperiences(userText, opts.experienceManager)
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

/** Skill-style trigger matching for experiences (name-only, read on demand via pick_skill). */
async function matchExperiences(
  userText: string,
  experienceManager?: AgentEngineOptions['experienceManager'],
): Promise<string | null> {
  if (!experienceManager) return null
  try {
    const matched = await experienceManager.matchByTriggers(userText)
    if (matched.length === 0) return null
    return '[Possible experiences: <experiences>' +
      matched.map((e) => `<experience><name>${e.name}</name><description>${e.description}</description></experience>`).join('') +
      '</experiences>]'
  } catch {
    return null
  }
}

/** Snapshot a git status summary for the given cwd. Returns null when not a repo (silent skip). */
async function buildGitContext(cwd: string): Promise<string | null> {
  try {
    const isRepo = await getHost().gitInvoke({ action: 'is_repo', cwd })
    if (!isRepo.ok || !(isRepo.data as { isRepo?: boolean } | undefined)?.isRepo) return null
    const status = await getHost().gitInvoke({ action: 'status', cwd })
    if (!status.ok) return null
    const d = status.data as GitStatusInfo
    if (!d.isRepo) return null
    const lines = ['--- Git Context ---', `Repo: ${cwd} (branch: ${d.branch ?? 'detached'})`, `Ahead: ${d.ahead} | Behind: ${d.behind}`]
    if (d.staged.length) lines.push(`Staged (${d.staged.length}):`, ...d.staged.map((f) => `  ${f}`))
    if (d.unstaged.length) lines.push(`Unstaged (${d.unstaged.length}):`, ...d.unstaged.map((f) => `  ${f}`))
    if (d.untracked.length) lines.push(`Untracked (${d.untracked.length}):`, ...d.untracked.map((f) => `  ${f}`))
    if (d.conflict.length) lines.push(`Conflicts (${d.conflict.length}):`, ...d.conflict.map((f) => `  ${f}`))
    lines.push('--- End Git Context ---')
    return lines.join('\n')
  } catch {
    return null
  }
}

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
Volatile per-turn context — the current date and time, the workspace, memory, git status, the current plan, the page a browser client is showing, and any matching skills/experiences — is appended as a \`<session-state>\` block in the FINAL message of the request. Read the values from the LATEST block; earlier blocks in the history are snapshots of earlier turns and may be stale.`

const TOOL_CALL_FORMAT = `\
## Tool Call Format

Only call tools via the API's structured JSON tool-call mechanism. Never emit XML tags like \`<invoke name="...">\` — such text is treated as prose and will NOT execute. Follow the tool definitions provided with this request.`

const COMPRESSED_TOOL_RESULTS = `\
## Compressed Tool Results

Very old tool execution results may be compressed to save context space. You may encounter these two markers inside tool result content:

- \`[tool_result_id: <uuid>]\` — the original tool result content was removed to fit the context window. The result DID happen, but its full text is gone. Use the \`tool_result_search\` tool with the uuid to retrieve the original content if you need it.
- \`[tool_result_error] ...\` — the tool call FAILED (timeout, truncated parameters, nonzero exit code, etc.). The tool did NOT complete its task. Do not claim the task was done; treat the remaining text as the error message and respond accordingly.`

const RENDER_REFERENCE = `\
## Render Reference

The chat UI supports enhanced rendering for standard Markdown links and images: \`[](uri)\` renders as clickable cards; \`![](uri)\` renders inline images. The \`uri\` can be \`file://\` (local file) or \`http(s)://\` (web URL).`
