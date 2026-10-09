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
 *  declaration — a declaration is a line that trims to exactly the sentinel.
 *  ONE regex is the single source for BOTH consumers (detection re-arms the
 *  guard, stripping rewrites the transcript): separate literals are how
 *  review 20261009 中3 happened — the /m detection accepted a CRLF tail the
 *  per-line strip then left in place, leaking the raw marker into the
 *  transcript. The trailing `[ \t\r]` eats the `\r` a CRLF gateway leaves at
 *  the line's tail after a split on `\n` (deliberately not `\s`: only the
 *  CR/NL split is a real model shape). */
const SENTINEL_LINE_RE = /^[ \t]*<<TASK_DONE>>[ \t\r]*$/

const isSentinelLine = (line: string): boolean => SENTINEL_LINE_RE.test(line)

/** Did this text declare task completion? Reads the RAW text — call it before
 *  stripping. */
export function hasTaskDoneSentinel(text: string | undefined | null): boolean {
  if (!text) return false
  return text.split('\n').some(isSentinelLine)
}

/** Remove sentinel lines from a text block. Returns null when nothing of the
 *  block survives (the round was NOTHING but the declaration — the caller
 *  drops the emptied text block so the transcript never shows a blank bubble). */
export function stripTaskDoneSentinel(text: string): string | null {
  if (!hasTaskDoneSentinel(text)) return text
  const kept = text
    .split('\n')
    .filter((line) => !isSentinelLine(line))
    .join('\n')
    .trimEnd()
  return kept.length > 0 ? kept : null
}
