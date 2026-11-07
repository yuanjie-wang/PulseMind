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

/** The human-readable remainder after the marker (the slim row's body). */
export function backgroundNoticeBody(text: string): string {
  return text.slice(BACKGROUND_NOTICE_MARKER.length).trim()
}
