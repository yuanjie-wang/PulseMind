// ── JSON-safe serialization for the vm return channel (A-M1) ──
// Kernels are stateless and the protocol only carries pure data — element
// handles, functions and circulars never cross the boundary (硬约束 §10).

import { BROWSER_MAX_RETURN_BYTES } from './protocol'

const MAX_DEPTH = 8

export function jsonSafe(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : String(value)
  if (t === 'bigint') return `${value}n`
  if (t === 'function' || t === 'symbol') return `[${t} ${String(value).slice(0, 60)}]`
  if (t === 'object') {
    if (seen.has(value)) return '[circular]'
    if (depth >= MAX_DEPTH) return '[max depth reached]'
    const nextSeen = new Set(seen)
    nextSeen.add(value)
    if (Array.isArray(value)) return value.slice(0, 500).map((v) => jsonSafe(v, depth + 1, nextSeen))
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= 500) { out['…'] = '[truncated]'; break }
      out[k] = jsonSafe(v, depth + 1, nextSeen)
    }
    return out
  }
  return String(value)
}

export interface SerializeOutcome {
  text: string
  truncated: boolean
}

/** Serialize a return value for the kernel's `Result:` channel, capping at maxBytes.
 *
 *  Shape follows the extension's `page_js.serializeResult` — the same idea on the
 *  other side of the boundary: strings verbatim, `undefined` named, everything
 *  else pretty JSON. A string return is the common case and it IS text: wrapping
 *  `domSnapshot()` in `JSON.stringify` turned every newline into a literal `\n`
 *  and every quote into `\"`, so a 5.6KB snapshot arrived as one unreadable line —
 *  the model had to unescape it and the chat's output box showed 13 of its 90
 *  lines (the user's 「返回的snapshot还是没有标序号」). Objects keep `jsonSafe`
 *  first, so handles/functions/circulars still cannot cross. */
export function serializeResult(value: unknown, maxBytes = BROWSER_MAX_RETURN_BYTES): SerializeOutcome {
  const safe = jsonSafe(value)
  const text = safe === undefined ? 'undefined' : typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? 'null'
  if (text.length <= maxBytes) return { text, truncated: false }
  // Hard cap: keep the head, drop the tail, mark the cut. The head is what every
  // caller's own contract needs kept — a snapshot leads with its numbered index.
  const cut = `${text.slice(0, maxBytes)}…[返回值超限被截断——把大输出写到文件,或用 screenshot/emitImage 传图]`
  return { text: cut, truncated: true }
}
