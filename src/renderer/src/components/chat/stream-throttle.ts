/**
 * Streaming-text parse throttle (PLAN-long-task-perf M1-T3).
 *
 * Measured (probe-chat-stream-perf, M0): the streaming tail re-parses the
 * WHOLE accumulated text through XMarkdown on every coalesced tick, and that
 * cost grows with the answer — 9.4ms/tick at the head of a 20KB answer,
 * 15.7ms at its tail, ~45-50% of all sampled renderer CPU inside the markdown
 * pipeline. The plan's ruling (开放决策 ③): keep the renderer, throttle the
 * parse — the streaming segment may lag the live text by up to
 * STREAM_PARSE_MIN_INTERVAL, and the settled message (a different segment)
 * always carries the complete text, so the lag never survives the turn.
 *
 * Deliberately NOT in here: engine cadence (the 80ms coalesce is a red line),
 * any wire shape, and any second renderer — streaming and settled render the
 * same XMarkdown, only the snapshot's freshness differs.
 *
 * Pure and clock-injected so node-env vitest can exercise it without a DOM.
 */
export interface StreamThrottle {
  /** Feed the live text at time `now`; returns the (possibly stale) text that
   *  should be rendered now. Idempotent: feeding the shown text again is a
   *  no-op, so React StrictMode's double render cannot advance the clock. */
  feed(text: string, now: number): string
  /** Drop the frozen snapshot (unmount / a new stream beginning). */
  reset(): void
}

export function createTextThrottle(minIntervalMs: number): StreamThrottle {
  let shown = ''
  let lastAt = -Infinity
  return {
    feed(text: string, now: number): string {
      if (text === shown) return shown
      if (now - lastAt >= minIntervalMs) {
        shown = text
        lastAt = now
      }
      return shown
    },
    reset(): void {
      shown = ''
      lastAt = -Infinity
    },
  }
}

/** The streaming snapshot's minimum refresh interval. 150ms keeps the tail
 *  visibly live (the chat's own coalesce is 80ms) while cutting the parse
 *  renders of a long answer roughly in half; every tick between refreshes
 *  re-renders XMarkdown with the SAME string, which is its memo hit. */
export const STREAM_PARSE_MIN_INTERVAL = 150
