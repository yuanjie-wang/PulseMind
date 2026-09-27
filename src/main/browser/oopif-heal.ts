// ── OOPIF blindness heal (app-view reconnect) ──
// The app-view backend drives the in-app pane over connectOverCDP. When the
// CDP connection is (re)established while a tab ALREADY shows a cross-origin
// iframe, Playwright never learns about that frame target: page.frames()
// misses it, `ariaSnapshotJSON({mode:'ai'})` omits its content, and any
// aria-ref action inside it times out. Frames born AFTER the auto-attach are
// adopted normally — which is why freshly created agent tabs work and only
// adopted (survived-a-reconnect) tabs go blind. Measured against Electron 33:
// a raw CDP session created after the fact DOES receive the pre-existing
// `iframe:` target via Target.setAutoAttach replay, so the protocol layer is
// willing — it is Playwright's adoption ordering that misses it, and there is
// no public API to force a re-adoption.
//
// The one lever that works: reload the blind page. A reload re-births the
// frame targets into the LIVE connection's auto-attach and full control
// (snapshot + frame-prefixed refs + clicks) returns. That costs the page its
// runtime state, so the heal reloads ONLY pages proven blind — Electron's own
// frame list (webContents.mainFrame.frames, which sees every frame) diffed
// against Playwright's.

import type { Page } from 'playwright-core'

/** Frame URLs Electron shows that Playwright's page does not — the blindness
 *  signal. `about:blank` on both sides is noise (fresh frames, fresh tabs);
 *  a page where every frame is known returns []. */
export function missingFrameUrls(electronFrameUrls: string[], playwrightFrameUrls: string[]): string[] {
  const seen = new Set(playwrightFrameUrls)
  return electronFrameUrls.filter((u) => u && u !== 'about:blank' && !seen.has(u))
}

/** Reload `page` when its cross-origin frames are invisible to the connected
 *  Playwright session. Returns whether a reload happened, so the caller can
 *  log it; a page that fails to reload is reported as healed=false and left
 *  as-is (it was no worse before the attempt). */
export async function healOopifBlindPage(page: Page, electronFrameUrls: string[]): Promise<boolean> {
  let playwrightUrls: string[]
  try {
    playwrightUrls = page.frames().map((f) => f.url())
  } catch {
    return false // page closed or detached mid-check — nothing to heal
  }
  if (missingFrameUrls(electronFrameUrls, playwrightUrls).length === 0) return false
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
  } catch {
    return false
  }
  return true
}
