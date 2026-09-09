/**
 * Pure planning for incremental conversation persistence: given the live
 * message list and the set of already-persisted message IDs, decide what the
 * next save must write.
 *
 * - First save (nothing persisted yet): append everything.
 * - History shrank in memory (compaction/regeneration dropped messages):
 *   fall back to a full save so the DB reflects the live set.
 * - Otherwise: append messages newer than the last save, PLUS a small tail of
 *   already-saved messages — in-place block updates on the live tail (e.g.
 *   exitCode written onto tool_use after execution) are invisible to ID-based
 *   skipping, so the tail is re-written (INSERT OR REPLACE) every tick.
 */

export const INCREMENTAL_TAIL_RESAVE = 8

export type IncrementalSavePlan =
  | { mode: 'append'; fromIdx: number }
  | { mode: 'full' }

export function planIncrementalSave(
  msgs: ReadonlyArray<{ id: string }>,
  savedIds: ReadonlySet<string> | undefined,
  tailResave: number = INCREMENTAL_TAIL_RESAVE,
): IncrementalSavePlan {
  if (!savedIds) return { mode: 'append', fromIdx: 0 }
  if (msgs.length < savedIds.size) return { mode: 'full' }

  let firstNewIdx = -1
  for (let i = 0; i < msgs.length; i++) {
    if (!savedIds.has(msgs[i].id)) { firstNewIdx = i; break }
  }
  const fromIdx = firstNewIdx === -1
    ? Math.max(0, msgs.length - tailResave)
    : Math.max(0, firstNewIdx - tailResave)
  return { mode: 'append', fromIdx }
}
