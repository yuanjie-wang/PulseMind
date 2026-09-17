// ── Insertion-order LRU over a plain record ──
// Both renderer-side per-key caches (preview tabs per conversation, expansion
// state per workspace dir) keep a bounded number of entries in a
// `Record<string, T>` where the insertion order IS the recency order — the
// browsers' own object property order. Reading a key means re-inserting it at
// the end and dropping the entries that fell past the cap.

/** Re-insert `key` (with `value`) as most-recently-used and prune beyond `cap`. */
export function touchRecord<T>(map: Record<string, T>, key: string, value: T, cap: number): Record<string, T> {
  const entries = Object.entries(map).filter(([k]) => k !== key)
  entries.push([key, value])
  // The Math.max is load-bearing: a negative slice start is resolved from the
  // END of the array, so the natural-looking `slice(len - cap)` keeps only the
  // last `cap - len` entries whenever the map is smaller than the cap — a
  // 6-entry map with cap 10 came back as its last 4 entries (measured). This is
  // exactly the arithmetic the two call sites had, and it silently shed the
  // oldest preview tab strips below ten conversations.
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - cap)))
}
