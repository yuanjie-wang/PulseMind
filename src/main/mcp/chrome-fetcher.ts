// ── Rendered web fetch (A-M2) ──
// The internal "rendered page HTML" channel for knowledge import etc.
// A-M2: implementation moved from the chrome-devtools MCP round-trip to the
// native BrowserService (same managed backend the agent tool uses). The
// exported signature is unchanged — callers don't know the backend changed.

import { browserService } from '../browser/BrowserService'

/** Navigate to URL and return the rendered DOM (post-JS). Null on failure —
 *  callers fall back to plain HTTP fetch. `depth` is kept from the old
 *  iframe-recursion signature; the abort signal is honored before launch. */
export async function fetchUrlViaChromeMCP(url: string, depth = 0, signal?: AbortSignal): Promise<string | null> {
  void depth
  signal?.throwIfAborted()
  return browserService.fetchRendered(url)
}
