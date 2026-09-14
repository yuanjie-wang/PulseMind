// ── Rendered web fetch ──
// The internal "rendered page HTML" channel for knowledge import etc. Runs on
// the native BrowserService — the same managed backend the agent's browser tool
// uses, so a JS-heavy page renders identically in both paths.

import { browserService } from './BrowserService'

/** Navigate to URL and return the rendered DOM (post-JS). Null on failure —
 *  the browser failing to launch is reported to the caller, not retried. */
export async function fetchRenderedHtml(url: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  return browserService.fetchRendered(url)
}
