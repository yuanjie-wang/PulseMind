import { getHost } from './host'
import type { AgentMessage, TextBlock, Plan } from '../types/agent'
import type { AgentEngineOptions } from './AgentEngine'
import { getCachedSkillPrefs } from './mcp-cache'
import type { GitStatusInfo } from '../../../shared/types/git'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export interface BuildSystemPromptParams {
  opts: AgentEngineOptions
  spawnSystemPrompt?: string
  spawnSystemPromptAppendix?: string
  messages: AgentMessage[]
  memoryContextSnapshot: string | null
  wikiContextSnapshot: string | null
  wikiContextVersion: number
  systemPromptCache: Map<string, { prompt: string; time: number }>
  conversationId?: string
  skillAppendix: string | null
  experienceAppendix: string | null
  plan: Plan | null
  experienceManager?: import('../experiences/ExperienceManager').ExperienceManager
}

export interface BuildSystemPromptResult {
  systemPrompt: string
  memoryContextSnapshot: string | null
  wikiContextSnapshot: string | null
  wikiContextVersion: number
  skillAppendix: string | null
  experienceAppendix: string | null
}

export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<BuildSystemPromptResult> {
  const {
    opts, spawnSystemPrompt, spawnSystemPromptAppendix,
    messages, conversationId, plan,
    skillAppendix: prevSkillAppendix,
    experienceAppendix: prevExperienceAppendix
  } = params
  const { wikiContextSnapshot, wikiContextVersion } = params
  let { memoryContextSnapshot } = params
  let skillAppendix = prevSkillAppendix
  let experienceAppendix = prevExperienceAppendix

  const convId = conversationId
  const now = Date.now()
  const cacheEntry = convId ? params.systemPromptCache.get(convId) : undefined
  const useCached = cacheEntry && (now - cacheEntry.time) < SIX_HOURS_MS

  let systemPrompt: string
  if (spawnSystemPrompt) {
    systemPrompt = spawnSystemPrompt
    if (spawnSystemPromptAppendix) {
      systemPrompt += '\n\n' + spawnSystemPromptAppendix
    }
  } else if (useCached) {
    systemPrompt = cacheEntry!.prompt
  } else {
    const parts: string[] = []
    const { myName, soul, yourName, locale, platformInfo, workspaceDir, memoryManager } = opts

    // ── Expert config pack (@-summoned role switch) ─────────────────
    // The expert's composed instructions REPLACE the basic persona: identity
    // precedence is the whole point of the summon. myName survives (it's
    // context about the user, not the assistant); soul/yourName do not.
    // Everything else (environment / memory / git / tool format) is kept —
    // it's infrastructure, not identity.
    if (opts.expert) {
      parts.push(opts.expert.instructions)
      if (myName) parts.push(`The user's name is ${myName}.`)
    } else {
      const personaParts: string[] = []
      if (myName) personaParts.push(`The user's name is ${myName}.`)
      if (yourName) personaParts.push(`You are ${yourName}.`)
      if (soul) personaParts.push(soul)
      if (personaParts.length > 0) { parts.push('# Basic Persona & Identity'); parts.push(personaParts.join('\n')) }
    }

    const envParts: string[] = ['## System Info']
    if (platformInfo) envParts.push(`- Operating System: ${platformInfo.platformName} ${platformInfo.release} (${platformInfo.arch})`)
    const ts = new Date()
    envParts.push(`- Date: ${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
    if (locale) envParts.push(`- Language: ${locale === 'zh' ? 'Chinese (中文)' : 'English'} (${locale})`)
    const isWin = platformInfo?.platform === 'win32'
    const homePrefix = isWin ? '%USERPROFILE%' : '~'
    const sep = isWin ? '\\' : '/'
    envParts.push(`- Config Directory: ${homePrefix}${sep}.pulsemind`)
    envParts.push(`- Skills Directory: ${homePrefix}${sep}.pulsemind${sep}skills`)
    envParts.push(`- Workspace: ${workspaceDir || `${homePrefix}${sep}.pulsemind${sep}output`}`)
    envParts.push(`- Your maximum output limit: ${opts.maxTokens} tokens per response. For large writes, split the content across multiple write calls.`)
    parts.push('# Running Environment')
    parts.push(envParts.join('\n'))

    if (isWin) {
      parts.push(`\
## Windows Shell Notes
- Commands run in Windows PowerShell 5.x via \`powershell.exe\`.
- Many Unix command aliases ARE available: \`ls\`, \`cat\`, \`pwd\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`echo\`, \`dir\`.
- The following common commands are NOT available: \`grep\`, \`tail\`, \`head\`, \`chmod\`, \`chown\`, \`sudo\`, \`which\`, \`touch\`.
- \`&&\` chaining is NOT supported. Use \`;\` to run commands sequentially, or use separate tool calls.
- Use \`findstr\` or \`Select-String\` instead of \`grep\`.
- Use \`Get-ChildItem\` instead of \`ls -la\` (though \`ls\` alias works for simple cases).
- Environment variables: use \`$env:VARNAME\` (PowerShell) or \`%VARNAME%\` (cmd.exe compat).
- File paths: both forward slashes (\`/\`) and backslashes (\`\\\`) work in PowerShell.
- Default home directory: \`%USERPROFILE%\` (typically \`C:\\Users\\<username>\`).`)
    }

    // ── Memory context ──────────────────────────────────────────────
    if (memoryManager) {
      if (memoryContextSnapshot) {
        parts.push(memoryContextSnapshot)
      } else {
        const memoryContext = await memoryManager.buildMemoryContext()
        if (memoryContext) {
          memoryContextSnapshot = memoryContext
          parts.push(memoryContext)
        }
      }
    }

    // ── Git context (snapshot once per conversation, skipped silently if not a repo) ──
    if (workspaceDir) {
      const settings = await getHost().getSettings().catch(() => null)
      if (!settings || settings.git?.contextInjection !== false) {
        const gitCtx = await buildGitContext(workspaceDir)
        if (gitCtx) parts.push(gitCtx)
      }
    }

    // ── Wiki knowledge context: presence hint only (no index injection) ──
    // Full wiki index is intentionally NOT injected to keep the prompt lean.
    // The model is told the knowledge base exists so it knows to look it up
    // via knowledge_search / knowledge_read when relevant.
    // An expert with bound files already carries its own Bound Knowledge
    // section (scoped search) — skip the generic hint to avoid double-listing.
    if (!opts.expert || opts.expert.knowledgeFiles.length === 0) {
      parts.push(`## Knowledge Base

You have a local knowledge base (compiled wiki) of project documents and past compiled knowledge. It is NOT shown here — look things up on demand with the knowledge_search and knowledge_read tools when relevant.`)
    }

    // ── Experience index: name-only second channel (progressive disclosure) ──
    // Full experience contents are never injected. The model sees a compact
    // name list and can pick_skill an experience by name when relevant.
    if (params.experienceManager) {
      const expIndex = await params.experienceManager.buildNameIndex()
      if (expIndex) parts.push(expIndex)
    }

    // ── Tool & renderer appendix ─────────────────────────────────────
    const toolManager = opts.toolManager
    const toolAppendix = toolManager?.getSystemPromptAppendix()
    if (toolAppendix) parts.push(toolAppendix)

    // ── Tool call format ─────────────────────────────────────────────
    // Some models drift into emitting tool invocations as raw XML text
    // (`<invoke name="...">`, `<parameter ...>`) instead of the API's
    // structured tool-call mechanism. The chat API only executes calls made
    // through the protocol — XML tags in the reply are treated as plain text,
    // so the model silently "thinks" it called a tool while nothing runs
    // (seen as unresponsive tool use). Nail the format down up front.
    parts.push(`\
## Tool Call Format

Only call tools via the API's structured JSON tool-call mechanism. Never emit XML tags like \`<invoke name="...">\` — such text is treated as prose and will NOT execute. Follow the tool definitions provided with this request.`)

    // ── Compressed tool results ──────────────────────────────────────
    // Old tool_result content may be stripped to a placeholder to fit the
    // context window. The model must understand these markers so it doesn't
    // mistake a placeholder for a real result — and can resolve it on demand.
    parts.push(`\
## Compressed Tool Results

Very old tool execution results may be compressed to save context space. You may encounter these two markers inside tool result content:

- \`[tool_result_id: <uuid>]\` — the original tool result content was removed to fit the context window. The result DID happen, but its full text is gone. Use the \`tool_result_search\` tool with the uuid to retrieve the original content if you need it.
- \`[tool_result_error] ...\` — the tool call FAILED (timeout, truncated parameters, nonzero exit code, etc.). The tool did NOT complete its task. Do not claim the task was done; treat the remaining text as the error message and respond accordingly.`)

    // ── Render Reference ─────────────────────────────────────────────
    parts.push(`\
## Render Reference

The chat UI supports enhanced rendering for standard Markdown links and images: \`[](uri)\` renders as clickable cards; \`![](uri)\` renders inline images. The \`uri\` can be \`file://\` (local file) or \`http(s)://\` (web URL).`)

    const builtPrompt = parts.join('\n')
    if (convId) {
      params.systemPromptCache.set(convId, { prompt: builtPrompt, time: Date.now() })
      if (params.systemPromptCache.size > 50) {
        const now2 = Date.now()
        for (const [id, entry] of params.systemPromptCache) {
          if (now2 - entry.time > SIX_HOURS_MS) params.systemPromptCache.delete(id)
        }
      }
    }
    systemPrompt = builtPrompt
  }

  // ── Plan context (injected dynamically, NOT cached) ──────────────
  if (plan && !plan.completed) {
    const lines: string[] = ['', '## Current Plan', '', `Objective: "${plan.objective}"`, `Mode: ${plan.mode}`, '']
    if (plan.mode === 'delegated') {
      lines.push('Rules for delegated mode:')
      lines.push('- You MUST use the `spawn_agent` tool for EACH step — do not execute steps directly')
      lines.push('- Do not attempt to complete multiple steps in a single response')
      lines.push('')
    }
    lines.push('### Workflow')
    lines.push('1. Execute the current [ ] step using the appropriate tools')
    lines.push('2. Call `advance_plan` with action="complete" to mark it done — the plan does NOT auto-advance')
    lines.push('3. Repeat for each subsequent step until all steps are done')
    lines.push('4. Call `advance_plan` with action="finish" when the objective is fully met')
    lines.push('### Progress')
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i]
      const marker = s.status === 'completed' ? '[done]' : s.status === 'failed' ? '[fail]' : '[ ]'
      lines.push(`${marker} Step ${i + 1}: ${s.description}`)
    }
    systemPrompt += lines.join('\n')
  }

  // ── Current page context (injected dynamically, NOT cached) ──────
  // Browser-extension sessions carry the tab the user is looking at. This is
  // per-turn state (the user navigates), so — like the plan block above — it
  // must never enter the cached prefix. The page CONTENT itself arrives via
  // the page_* tools; only the page's identity lives here.
  if (opts.pageContext?.url || opts.pageContext?.title) {
    const lines = ['', '## Current Page']
    if (opts.pageContext.title) lines.push(`- Title: ${opts.pageContext.title}`)
    if (opts.pageContext.url) lines.push(`- URL: ${opts.pageContext.url}`)
    lines.push('The user is looking at this page right now. Read or act on it with the `page_*` tools; do not assume its content from the URL alone.')
    systemPrompt += lines.join('\n')
  }

  // ── Skill keyword matching (always runs, reads from shared cache) ──
  {
    const prefs = getCachedSkillPrefs()
    const skillKeywords = prefs.skillKeywords || {}
    const enabledSkills = opts.skillManager?.getEnabledSkills() || []
    if (Object.keys(skillKeywords).length > 0 && enabledSkills.length > 0) {
      let userText = ''
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') continue
        for (const block of messages[i].contentBlocks) {
          if (block.type === 'text') { userText = (block as TextBlock).text; break }
        }
        if (userText) break
      }
      if (userText) {
        const matchedSkills: { name: string; description: string }[] = []
        for (const [skillName, keywords] of Object.entries(skillKeywords)) {
          const matched = keywords.some(kw => userText.toLowerCase().includes(kw.toLowerCase()))
          if (matched) {
            const skill = enabledSkills.find(s => s.definition.name === skillName)
            if (skill) matchedSkills.push({ name: skill.definition.name, description: skill.definition.description })
          }
        }
        if (matchedSkills.length > 0) {
          skillAppendix = '[Possible skills: <skills>' +
            matchedSkills.map(s => `<skill><name>${s.name}</name><description>${s.description}</description></skill>`).join('') +
            '</skills>]'
        } else { skillAppendix = null }
      }
    }
  }

  // ── Experience keyword matching (skill-style triggers, appended to the last user message) ──
  {
    const experienceManager = params.experienceManager
    if (experienceManager) {
      let userText = ''
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') continue
        for (const block of messages[i].contentBlocks) {
          if (block.type === 'text') { userText = (block as TextBlock).text; break }
        }
        if (userText) break
      }
      if (userText) {
        try {
          const matched = await experienceManager.matchByTriggers(userText)
          if (matched.length > 0) {
            experienceAppendix = '[Possible experiences: <experiences>' +
              matched.map(e => `<experience><name>${e.name}</name><description>${e.description}</description></experience>`).join('') +
              '</experiences>]'
          } else { experienceAppendix = null }
        } catch { experienceAppendix = null }
      }
    }
  }

  return {
    systemPrompt,
    memoryContextSnapshot,
    wikiContextSnapshot,
    wikiContextVersion,
    skillAppendix,
    experienceAppendix,
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
