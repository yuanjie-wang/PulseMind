// The in-app browser pane must ride its OWN persistent session
// (PANE_SESSION_PARTITION = 'persist:pane'), never defaultSession.
//
// Why (2026-10-06, 「整体界面被缩放」): the dock stamps every pane page at
// zoomForWidth(width) ≈ 0.33× via webContents.setZoomFactor, and Chromium
// persists that per HOST NAME (scheme and port ignored). While the pane
// shared the default session with the main window, a pane visit to
// localhost:8899 stamped host "localhost" at 0.33× and the dev renderer at
// localhost:5173 loaded at a third of its size — surviving restarts, since
// the stamp lands in Preferences per_host_zoom_levels.
//
// vitest cannot run Electron (no app/session), so this scan owns the wiring:
// a revert of the partition, a download handler left on defaultSession, or a
// CDP page search pinned to contexts()[0] (pane pages now live in another
// context) fails here.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const pane = readFileSync(join(ROOT, 'src/shared/browser/pane.ts'), 'utf-8')
const backend = readFileSync(join(ROOT, 'src/main/browser/backends/AppViewBackend.ts'), 'utf-8')
const dock = readFileSync(join(ROOT, 'src/main/browser/app-view-dock.ts'), 'utf-8')
const hookBrowser = readFileSync(join(ROOT, 'src/main/hook-browser.ts'), 'utf-8')

describe('pane tabs ride an isolated persistent session', () => {
  it('the partition constant exists and is persistent (persist: prefix)', () => {
    const m = pane.match(/export const PANE_SESSION_PARTITION = '([^']+)'/)
    expect(m).toBeTruthy()
    expect(m![1].startsWith('persist:')).toBe(true)
  })

  it('every pane WebContentsView is created with the pane partition', () => {
    // Anchor on the view's own webPreferences block — "partition" must live
    // INSIDE it, not merely somewhere in the file.
    const view = backend.match(/new WebContentsView\(\{\s*webPreferences:\s*\{[^}]*\}/s)
    expect(view).toBeTruthy()
    expect(view![0]).toContain('partition: PANE_SESSION_PARTITION')
  })

  it('download routing rides the pane session, not defaultSession', () => {
    expect(backend).toContain("session.fromPartition(PANE_SESSION_PARTITION).on('will-download'")
    expect(backend).not.toContain("session.defaultSession.on('will-download'")
  })

  it('CDP page matching sweeps all contexts — no contexts()[0] pin', () => {
    // The pane's context sits next to the default one, and Playwright's
    // ordering is not ours to assume; findPageByToken/healAdoptedViews must
    // both go through the all-contexts sweep.
    expect(backend).not.toContain('contexts()[0]')
    expect(backend).toContain('private allPages()')
    expect(backend.match(/this\.allPages\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('the dock re-stamps the width zoom on navigation, and the backend calls it', () => {
    expect(dock).toContain('restampZoom(view: WebContentsView)')
    expect(backend).toMatch(/on\('did-navigate', \(\) => \{\s*notify\(\)[^}]*appViewDock\.restampZoom\(view\)/)
  })

  it('non-vacuity + the hook login window stays on the default session on purpose', () => {
    // The scans must read the real wiring, not vacuously pass.
    expect(backend).toContain("new WebContentsView({")
    expect(backend).toContain("from '../../../shared/browser/pane'")
    // The login window deliberately shares the app session (hook flow polls
    // the server the user just logged into) — it must NOT pick up the pane
    // partition.
    expect(hookBrowser).not.toContain('PANE_SESSION_PARTITION')
  })
})
