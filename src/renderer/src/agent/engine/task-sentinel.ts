// ── Task-completion sentinel (early-stop guard, 2026-10-08) ──────────────
// Models running with the per-profile earlyStopGuard flag are taught (frozen
// core, system-prompt-builder TASK_COMPLETION_SENTINEL_SECTION) to end their
// FINAL text with the bare line below when — and only when — the task is fully
// done. The engine-side guard in stream-runner uses its ABSENCE on a
// text-only end_turn round as the "stopped too early" signal, which is what
// turns an undecidable "did it finish or give up" guess into a decidable
// protocol. Pure functions: no engine imports, unit-tested directly.

/** The exact line a guarded model must emit (alone on its final line). */
export const TASK_DONE_SENTINEL = '<<TASK_DONE>>'

/** Line-anchored on purpose: prose that merely MENTIONS the marker (a tool
 *  result quoting it, the model discussing the convention) is not a
 *  declaration. A declaration is a line that trims to exactly the sentinel. */
const SENTINEL_LINE_RE = /^[ \t]*<<TASK_DONE>>[ \t]*$/m

/** Did this text declare task completion? Reads the RAW text — call it before
 *  stripping. */
export function hasTaskDoneSentinel(text: string | undefined | null): boolean {
  if (!text) return false
  return SENTINEL_LINE_RE.test(text)
}

/** Remove sentinel lines from a text block. Returns null when nothing of the
 *  block survives (the round was NOTHING but the declaration — the caller
 *  drops the emptied text block so the transcript never shows a blank bubble). */
export function stripTaskDoneSentinel(text: string): string | null {
  if (!hasTaskDoneSentinel(text)) return text
  const kept = text
    .split('\n')
    .filter((line) => !/^[ \t]*<<TASK_DONE>>[ \t]*$/.test(line))
    .join('\n')
    .trimEnd()
  return kept.length > 0 ? kept : null
}
