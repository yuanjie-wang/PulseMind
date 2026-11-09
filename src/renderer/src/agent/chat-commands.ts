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
  return CHAT_COMMANDS.find((c) => {
    const rest = trimmed.slice(1 + c.name.length)
    return trimmed.startsWith(`/${c.name}`) && (rest === '' || /\s/.test(rest[0]))
  }) ?? null
}

/** The `rest` after the command token, trimmed (`/init 重点测试` → '重点测试'). */
export function commandArgument(text: string, name: string): string {
  return text.trim().slice(1 + name.length).trim()
}

/** The model-facing turn text `/init` becomes. English, like every other
 *  canned prompt in the engine (system-prompt-builder conventions). The file
 *  contract it teaches mirrors buildProjectInstructionsSection exactly: the
 *  .pulsemind/AGENTS.md is the ONLY write surface, a root AGENTS.md is shared
 *  read-only context, and existing lines are never deleted or reworded. */
export function buildInitPrompt(focus?: string): string {
  const lines = [
    'Initialize this workspace\'s standing-instructions file (.pulsemind/AGENTS.md).',
    '',
    '1. Survey the workspace first: directory structure, manifests, README / CONTRIBUTING / an existing root AGENTS.md, and from them the build / test / lint commands and the conventions a contributor would need.',
    '2. Write `.pulsemind/AGENTS.md` at the workspace root — concise standing instructions for FUTURE work here: a 2-3 line project overview, the commands (and when to run them), and the durable conventions. Keep it tight; this file rides every request.',
    '3. If a root AGENTS.md already exists, treat it as read-only shared context and record only PulseMind-specific notes in .pulsemind/AGENTS.md. If .pulsemind/AGENTS.md itself already exists, propose ADDITIONS instead of overwriting — never delete or reword its existing lines.',
    '4. When done, summarize what you recorded and point me at the file.',
  ]
  const trimmedFocus = focus?.trim()
  if (trimmedFocus) lines.push('', `Additional focus from the user: ${trimmedFocus}`)
  return lines.join('\n')
}
