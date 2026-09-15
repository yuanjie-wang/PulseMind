// ── Conversation keys ──
// `useXConversations` opens with `activeConversationKey = ''`: its store is built
// as `new ConversationStore(list, config?.defaultActiveConversationKey || '')`,
// so "no conversation is open" arrives as the **empty string**, not `undefined`.
// A `typeof key === 'string'` test therefore reads it as a real conversation, and
// a 授权 click on a fresh window went down the write path for an id that does not
// exist — the DB stub-inserted a row with an empty id (title 新对话, no messages,
// visible in the sidebar) and the button never moved, because no list item carries
// that key. Truthiness is the only correct test, in one place, for every reader.

/** The key when it names a real conversation, otherwise `undefined`.
 *  Numbers are accepted because a caller may hand us an sdk key verbatim. */
export function conversationKeyOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
