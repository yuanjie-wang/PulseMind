// ── Short id helpers ──
// One place for the `<prefix>_<random>` id shape used across main-process
// stores and services (proj_/tool_/routine_/run_/tab_/tok_/ws_). The random
// part is the leading hex of a UUIDv4 — collision-safe for in-app table keys.

import { randomUUID } from 'node:crypto'

/** First `len` hex chars of a UUIDv4. */
export function shortUuid(len = 8): string {
  return randomUUID().slice(0, len)
}

/** `proj_1a2b3c4d`-style id; len is the random part's length. */
export function prefixedId(prefix: string, len = 8): string {
  return `${prefix}_${shortUuid(len)}`
}
