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
  const { opts, spawnSystemPrompt, spawnSystemPromptAppendix, messages, plan, summon, toolProtocols } = params

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

  // ── Memory context (2026-09-26: moved out of the state block) ──
  // Extracted Memories + the recent-conversations table are GLOBAL data, so
  // with the manager's double 3h TTL they are byte-identical across
  // conversations and reusable by DeepSeek's cross-request prefix cache. The
  // per-conversation Workspace section stays in the state block for the same
  // reason in reverse: a per-conversation value in this shared prefix would
  // cold-start every new conversation.
  if (opts.memoryManager) {
    const memoryContext = await opts.memoryManager.getStableMemoryContext(opts.conversationId)
    if (memoryContext) parts.push(memoryContext)
  }

  // ── Managed-tool appendix (renderer-provided; empty for the built-in manager) ──
  const toolAppendix = opts.toolManager?.getSystemPromptAppendix()
  if (toolAppendix) parts.push(toolAppendix)

  // ── Tool usage protocols (per-tool markdown from the enabled toolset) ──
  // Sits with the other tool-convention blocks and is static per toolset, so
  // the cached prefix only moves when the tool schemas move anyway.
  if (toolProtocols) parts.push(toolProtocols)

  parts.push(ENGINEERING_WORKFLOW)
  parts.push(SESSION_STATE_NOTICE)
  parts.push(TOOL_CALL_FORMAT)
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
}): Promise<string> {
  const { opts, plan, summon } = params
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

  sections.push(buildClockSection())

  return `<session-state>\n${sections.join('\n\n')}\n</session-state>`
}

function buildWorkspaceSection(workspaceDir?: string): string | null {
  if (!workspaceDir) return null
  // The Scratch line is per-conversation (it names this workspace), so it lives
  // here and NOT in the frozen core; the spawn env block carries the same rule
  // for sub-agents (they get no state block). Throwaway files under one
  // dot-dir keep a project workspace — the user's own files — unpolluted.
  return `## Workspace\n- Workspace: ${workspaceDir}\n- Scratch: ${workspaceDir}/.pulsemind/tmp — put throwaway/intermediate files here, never loose in the workspace root`
}

function buildProjectSection(name?: string, overview?: string): string | null {
  if (!name && !overview) return null
  const lines = ['## Project']
  if (name) lines.push(`- Name: ${name}`)
  if (overview) lines.push(`- Overview: ${overview}`)
  return lines.join('\n')
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
async function buildGitContext(cwd: string): Promise<string | null> {
  try {
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
export const ENGINEERING_WORKFLOW = `\
## Engineering Workflow

These hold on every code change, in every turn.

1. Read before you write. Only a \`read\` of the file in this session counts as having read it — a path seen only in \`list_dir\`, in \`search\` output, or in an earlier turn does not. \`edit\`'s \`old_str\` must be copied from bytes you just read, never reconstructed from memory.
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

const TOOL_CALL_FORMAT = `\
## Tool Call Format

Only call tools via the API's structured JSON tool-call mechanism. Never emit XML tags like \`<invoke name="...">\` — such text is treated as prose and will NOT execute. Follow the tool definitions provided with this request.`

const COMPRESSED_TOOL_RESULTS = `\
## Compressed Tool Results

Very old tool execution results may be compressed to save context space. You may encounter these two markers inside tool result content:

- \`[tool_result_id: <uuid>]\` — the original tool result content was removed to fit the context window. The result DID happen, but its full text is gone. Use the \`tool_result_search\` tool with the uuid to retrieve the original content if you need it.
- \`[tool_result_error] ...\` — the tool call FAILED (timeout, truncated parameters, nonzero exit code, etc.). The tool did NOT complete its task. Do not claim the task was done; treat the remaining text as the error message and respond accordingly.`

const CONTEXT_MANAGEMENT_NOTICE = `\
## Context Management

When the conversation grows long, older context is compacted automatically: a summary, verbatim key user messages, and an archived-reads reminder are injected into subsequent requests, and archived tool results stay retrievable in full via \`tool_result_search\` by their \`tool_result_id\`. Compaction needs nothing from you — continue the current task as if the break never happened; do not wrap up early, re-explore files the reminder already names, or change how you work because the context is long.`

const RENDER_REFERENCE = `\
## Render Reference

The chat UI supports enhanced rendering for standard Markdown links and images: \`[](uri)\` renders as clickable cards; \`![](uri)\` renders inline images. The \`uri\` can be \`file://\` (local file) or \`http(s)://\` (web URL).`

const HTML_VISUAL_AIDS = `\
## Visual HTML Aids

When a visual would explain better than prose — a multi-dimension comparison, a timeline or process flow, a data chart, an infographic, a small interactive demo — you may render it directly in the chat: emit a self-contained static HTML fragment in a \`\`\`html fenced block, and the chat UI renders it as a sandboxed preview card. Hard requirements: all CSS and JS inline in the fragment; no external network resources (no CDN scripts, fonts, or stylesheets); design for a WHITE background; keep the fragment under ~30KB. The card enhances the answer, never replaces it — keep the surrounding prose. When the user asks to visualize or compare something in the conversation, prefer the card over writing an HTML file; write an HTML file only when the user asks for a file deliverable.`
