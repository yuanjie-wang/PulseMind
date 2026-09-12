// ── Search snippet extraction ──
// Storage matches whole message bodies; a result row shows one line around the hit.
// Pure — no DB, no DOM — so the main process and the test suite both call it.

/** How much context to keep on each side of the match. */
const DEFAULT_RADIUS = 60

/**
 * One line of `text` around the first occurrence of `query`, with `…` marking what was
 * cut away. Whitespace is collapsed first, so a multi-line message body never breaks the
 * result list. Without a match this is the flattened head of the text.
 */
export function extractSnippet(text: string, query: string, radius: number = DEFAULT_RADIUS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''

  const needle = query.trim()
  const at = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) {
    return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat
  }

  const start = Math.max(0, at - radius)
  const end = Math.min(flat.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
