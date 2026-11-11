// ── Chat slash commands (单一真源) ──
// The composer's `/` popup and useChatController's send-path interception both
// read this registry, so a command's name, its popup description and its
// runtime behavior can never drift apart. Pure data + pure functions — no I/O.

export interface ChatCommand {
  /** Literal token after `/`, as the user types it (`init` → `/init`). */
  name: string
  /** i18n key of the one-line description the popup shows under the token. */
  descKey: string
  /** True = the command acts on the CURRENT conversation and warns when none
   *  is open (compact). False = it may open one (init materializes like any
   *  first send). */
  requiresConversation: boolean
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: 'init',
    descKey: 'chatView.command.initDesc',
    requiresConversation: false,
  },
  {
    name: 'compact',
    descKey: 'chatView.command.compactDesc',
    requiresConversation: true,
  },
  {
    // Opens a fresh conversation of the SAME kind as the current one (browser
    // task / project / plain chat) — the sidebar's 新建任务「与当前模式相同」
    // rule, reached from the keyboard. Text after the token becomes that new
    // conversation's first message.
    name: 'new',
    descKey: 'chatView.command.newDesc',
    requiresConversation: false,
  },
]

/** Resolve the command a message invokes: the text must START with
 *  `/<name>` followed by whitespace or end-of-text — `/init extra` matches,
 *  `/inits` and `x /init` do not. Returns null for non-command text. */
export function matchChatCommand(text: string): ChatCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  return (
    CHAT_COMMANDS.find((c) => {
      const rest = trimmed.slice(1 + c.name.length)
      return trimmed.startsWith(`/${c.name}`) && (rest === '' || /\s/.test(rest[0]))
    }) ?? null
  )
}

/** The `rest` after the command token, trimmed (`/init 重点测试` → '重点测试'). */
export function commandArgument(text: string, name: string): string {
  return text
    .trim()
    .slice(1 + name.length)
    .trim()
}

/** How long `/init` may write .pulsemind/AGENTS.md without the per-write
 *  approval hold (user 2026-11-11: 「在init时…给予一定的时间范围，而不是每次都要
 *  授权」). One survey pass issues several write/edit calls in a row; ten
 *  minutes covers a slow survey without becoming a standing permission — the
 *  file returns to the protected-path hold on the next engine or after this
 *  window. The grant is scoped to .pulsemind/AGENTS.md only (root AGENTS.md
 *  stays held) and always-ask still asks. */
export const INIT_PROJECT_INSTRUCTIONS_GRANT_MS = 10 * 60_000

/** The model-facing turn text `/init` becomes. English, like every other
 *  canned prompt in the engine (system-prompt-builder conventions). The file
 *  contract it teaches mirrors buildProjectInstructionsSection exactly: the
 *  .pulsemind/AGENTS.md is the ONLY write surface, a root AGENTS.md is shared
 *  read-only context, and existing lines are never deleted or reworded. The
 *  survey checklist (2026-11-09) names the four dimensions a README usually
 *  lacks — layering, comment conventions, testing habits, external-dependency
 *  wrapping — each grounded in files actually read and depth-budgeted, because
 *  the output rides every request. */
export function buildInitPrompt(focus?: string): string {
  const lines = [
    "Initialize this workspace's standing-instructions file (.pulsemind/AGENTS.md).",
    '',
    '1. Survey the workspace first — read real files, not just directory names:',
    '   - Structure & commands: manifests, README / CONTRIBUTING, any existing root AGENTS.md → the build / test / lint commands and when to run them.',
    '   - Code layering: the architecture layers (e.g. UI / state / domain / data / integration), each with its path and a ONE-line responsibility — a small table, one row per layer, only layers that actually exist.',
    '   - Comment conventions: the language comments are written in and the house style (rationale-comments vs doc-blocks, TODO markers), grounded in 1-2 real excerpts you read.',
    '   - Testing habits: framework, test file locations & naming, run commands, mocking / fixture patterns, coverage gates if configured.',
    '   - External dependencies: how third-party services are wrapped — API clients, DB / ORM access, queues / caches — each with its wrapper module and the house rules (retry / timeout / error handling).',
    '   If the workspace is large, sample one or two representative files per layer. Omit any topic the workspace does not have.',
    '2. Write `.pulsemind/AGENTS.md` at the workspace root — concise standing instructions for FUTURE work here: a 2-3 line project overview, the commands, the layering table, then the conventions above. Keep it tight — a few lines per topic, each claim anchored to a real path; this file rides every request.',
    '3. If a root AGENTS.md already exists, treat it as read-only shared context and record only PulseMind-specific notes in .pulsemind/AGENTS.md. If .pulsemind/AGENTS.md itself already exists, propose ADDITIONS instead of overwriting — never delete or reword its existing lines.',
    '4. When done, summarize what you recorded and point me at the file.',
  ]
  const trimmedFocus = focus?.trim()
  if (trimmedFocus) lines.push('', `Additional focus from the user: ${trimmedFocus}`)
  return lines.join('\n')
}
