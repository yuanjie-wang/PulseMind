/**
 * Synthetic background-notice message (PLAN-background-tasks C).
 *
 * The delivery turn's content is a normal user message on the wire (the engine,
 * persistence and the model all treat it as one), but the transcript must
 * render it as a system line, never a user bubble — the marker prefix is the
 * contract between the composer (session-manager) and the renderer (which
 * strips the marker and paints the slim row). Pure + DOM-free so vitest pins
 * both ends.
 */

export const BACKGROUND_NOTICE_MARKER = '[[background-notice]]'

/** True when a message's text IS a background notice. Only the message's FIRST
 *  text block carries the marker (the composer writes exactly one text block). */
export function isBackgroundNoticeText(text: string | undefined | null): boolean {
  return typeof text === 'string' && text.startsWith(BACKGROUND_NOTICE_MARKER)
}

/** The slim row's body: the FIRST non-empty line after the marker (2026-11-08
 *  裁定: the row shows the task name + result — the summary line the composer
 *  writes on the marker line — and nothing else. Everything below is the
 *  MODEL's half (detail + report instruction) and must never reach the
 *  transcript. Leading blank lines are skipped so a composer that starts the
 *  summary on the next line still renders. */
export function backgroundNoticeBody(text: string): string {
  const rest = text.slice(BACKGROUND_NOTICE_MARKER.length)
  for (const line of rest.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** The model-facing result of a backgrounded exec — the SINGLE source for the
 *  three dispatch sites (exec background:true, and the two 转入后台 paths).
 *  It has to teach two things, not one: the exit wake-up (2026-10-28) and what
 *  the freed round trips are FOR (2026-11-09). The passive "no polling needed"
 *  wording left the model with no next action, so it idled on exec_logs or
 *  synthesized a wait with `sleep` — strictly worse than ending the turn, since
 *  a wait yields zero information and holds an execution slot. Stated
 *  positively, and the sleep workaround is banned by name: saying only "there
 *  is no sleep tool" advertises the `sleep` command as a way around it. */
export function backgroundStartNote(pid: number, kind: 'started' | 'promoted'): string {
  const head = kind === 'promoted' ? `Moved to background by the user: pid=${pid}` : `Background process started: pid=${pid}`
  return [
    head,
    '',
    "This result is immediate — the process keeps running beyond the turn. When it exits you will be NOTIFIED in a later turn's context (a Background Tasks section appears automatically).",
    'Between now and needing its output, spend the freed round trips on work that does not depend on it: batch the reads/searches you were going to do anyway, advance the next step, write the file this job does not touch.',
    'Do not synthesize a wait — no `sleep`, no polling loop, no `while` on a pid: waiting in-turn buys zero information and holds an execution slot. If nothing else is left, end the turn; the completion notice brings you back.',
    `Read exec_logs(pid=${pid}) when you actually need the output (its tail ends with "[exited code=N]"). Stop it with exec_kill(pid=${pid}).`,
  ].join('\n')
}
