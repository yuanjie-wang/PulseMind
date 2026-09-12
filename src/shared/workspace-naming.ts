// ── Conversation workspace naming (PLAN-0.4.0 M8) ──
// Pure naming logic for per-conversation working directories — no IO, so the
// vitest suite can cover it (the SQLite layer cannot run under plain Node).

/** `yyyyMMddHHmmss` in local time — the same shape as the `conv_` id suffix. */
export function formatConversationDirName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** `conv_yyyyMMddHHmmss` → `yyyyMMddHHmmss`; null for ids without the shape. */
export function conversationDirNameFor(convId: string): string | null {
  const m = /^conv_(\d{14})$/.exec(convId)
  return m ? m[1] : null
}

/** Pick `preferred`, suffixing `-2`, `-3`… while the name is already taken. */
export function nextConversationDirName(existingNames: string[], preferred: string): string {
  const taken = new Set(existingNames)
  if (!taken.has(preferred)) return preferred
  const base = preferred
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
