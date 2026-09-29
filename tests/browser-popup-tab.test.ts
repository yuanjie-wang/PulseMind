// window.open in a pane tab becomes a pane tab of the opener's own
// conversation, not an OS window (user report 2026-09-28: 内置浏览器里页面用
// new-window 方式打开时弹出了真窗口). The classification is pure and lives in
// shared/browser/pane.ts — unit-covered here. The Electron side cannot mount
// under vitest (a pane tab is a WebContentsView inside the app window), so
// the wiring — the per-tab setWindowOpenHandler that denies everything and
// hands the classifier's survivors to the service, and the service's
// opener-scoped routing — is pinned as source, the office-tool-dispatch
// idiom; the behaviour itself is driven end-to-end by the REAL
// BrowserService in scripts/probe-pane-actions.mjs §11.

import { describe, expect, it } from 'vitest'
import { routeWindowOpen } from '../src/shared/browser/pane'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('routeWindowOpen — the pure classification', () => {
  it('http/https becomes a pane tab, URL-normalized', () => {
    expect(routeWindowOpen('https://a.example/x?y=1', 'foreground-tab')).toEqual({
      action: 'tab',
      url: 'https://a.example/x?y=1',
    })
    expect(routeWindowOpen('http://A.example/', 'new-window')).toEqual({ action: 'tab', url: 'http://a.example/' })
  })

  it('a form POST rides the route as a replayable string (review_20260929 中7)', () => {
    // Electron's postBody.data is UploadData[] (rawData chunks); the route
    // decodes it to one string so the service can POST-replay the navigation.
    const payload = 'SAMLResponse=PD94bWw%2B&RelayState=tok42'
    const bytes = new TextEncoder().encode(payload)
    const route = routeWindowOpen('https://idp.example/sso', 'foreground-tab', {
      data: [{ type: 'rawData', bytes }],
      contentType: 'application/x-www-form-urlencoded',
    }, 'https://sp.example/app')
    expect(route).toEqual({
      action: 'tab',
      url: 'https://idp.example/sso',
      postBody: { data: payload, contentType: 'application/x-www-form-urlencoded' },
      referrer: 'https://sp.example/app',
    })
  })

  it('a GET open carries no postBody key; multipart chunks join; empty data is dropped', () => {
    expect(routeWindowOpen('https://a.example/', 'new-window')).toEqual({ action: 'tab', url: 'https://a.example/' })
    const joined = routeWindowOpen('https://a.example/', 'new-window', {
      data: [
        { type: 'rawData', bytes: new TextEncoder().encode('a=1&') },
        { type: 'rawData', bytes: new TextEncoder().encode('b=2') },
      ],
    })
    expect(joined).toEqual({ action: 'tab', url: 'https://a.example/', postBody: { data: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' } })
    // File-upload chunks (UploadFile) and empty bodies downgrade to a plain tab.
    expect(routeWindowOpen('https://a.example/', 'new-window', { data: [{ type: 'file', file: 'x' }] })).toEqual({ action: 'tab', url: 'https://a.example/' })
    // external/ignore shapes never carry a postBody.
    expect(routeWindowOpen('mailto:someone@example.com', 'new-window', { data: [{ type: 'rawData', bytes: new TextEncoder().encode('a=1') }] })).toEqual({
      action: 'external',
      url: 'mailto:someone@example.com',
    })
  })

  it('about:blank and empty urls are ignored — the opener could never write into a denied window', () => {
    expect(routeWindowOpen('about:blank', 'new-window')).toEqual({ action: 'ignore' })
    expect(routeWindowOpen('ABOUT:BLANK', 'foreground-tab')).toEqual({ action: 'ignore' })
    expect(routeWindowOpen('', 'new-window')).toEqual({ action: 'ignore' })
    expect(routeWindowOpen('   ', 'new-window')).toEqual({ action: 'ignore' })
  })

  it('a download is not a window (will-download already routes it)', () => {
    expect(routeWindowOpen('https://a.example/report.xlsx', 'save-to-disk')).toEqual({ action: 'ignore' })
  })

  it('unparseable urls are ignored', () => {
    expect(routeWindowOpen('https://[bad', 'new-window')).toEqual({ action: 'ignore' })
  })

  it('other schemes route to the OS (the caller still gates them through safeExternalUrl)', () => {
    expect(routeWindowOpen('mailto:someone@example.com', 'foreground-tab')).toEqual({
      action: 'external',
      url: 'mailto:someone@example.com',
    })
  })

  it('non-string garbage is ignored, never thrown on', () => {
    expect(routeWindowOpen(undefined as unknown as string, 'new-window')).toEqual({ action: 'ignore' })
  })
})

describe('wiring — deny on the Electron side, route on the service side', () => {
  const backend = read('src/main/browser/backends/AppViewBackend.ts')

  it('every pane tab installs setWindowOpenHandler and denies the native window', () => {
    expect(backend).toMatch(/setWindowOpenHandler/)
    expect(backend).toMatch(/action: 'deny'/)
  })

  it('the handler classifies through the shared pure function and hands survivors to the hook', () => {
    expect(backend).toContain('routeWindowOpen(details.url, details.disposition, details.postBody, details.referrer?.url)')
    expect(backend).toMatch(/route\.action !== 'ignore'\) this\.onWindowOpen\?\./)
  })

  const service = read('src/main/browser/BrowserService.ts')

  it('BrowserService wires onWindowOpen in backendFor (the factory is the one place backends are built)', () => {
    expect(service).toMatch(/appView\.onWindowOpen = /)
  })

  it('popup tabs inherit the opener scope+origin (agent popups stay workspace-jailed)', () => {
    expect(service).toMatch(/doCreatePaneTab\(opener\.scopeId, opener\.origin\)/)
    expect(service).not.toMatch(/doCreateUserPaneTab/)
  })

  it('only USER popups write address-bar history (L1: the agent writes none)', () => {
    expect(service).toMatch(/opener\.origin === 'user'/)
  })

  it('external routes go through the safeExternalUrl scheme gate before the OS launcher', () => {
    expect(service).toMatch(/safeExternalUrl\(route\.url, DATA_DIR\)/)
    expect(service).toMatch(/shell\.openExternal\(safe\)/)
  })

  it('popups bypass the per-scope creation serialization — they always mean a NEW tab', () => {
    expect(service).toMatch(/const entry = await this\.doCreatePaneTab\(/)
    expect(service).not.toMatch(/createUserPaneTab\(opener/)
  })

  it('a form POST is replayed as POST, never downgraded to GET (review_20260929 中7)', () => {
    // Playwright's goto has no method override — the one-shot route rewrite
    // is the mechanism; pin its load-bearing pieces as source.
    expect(service).toMatch(/method: 'POST'/)
    expect(service).toMatch(/times: 1/)
    expect(service).toMatch(/'content-type': post\.contentType \|\| 'application\/x-www-form-urlencoded'/)
    expect(service).toMatch(/route\.referrer \? \{ referrer: route\.referrer \}/)
  })

  it('page-initiated popups sit behind flood gates; a denial is audited, not minted (review_20260929 中8)', () => {
    expect(service).toMatch(/POPUP_TABS_PER_SCOPE/)
    expect(service).toMatch(/POPUP_MIN_INTERVAL_MS/)
    expect(service).toMatch(/popupInFlight/)
    expect(service).toMatch(/action: 'browser\.panePopupTab', target, decision: 'denied'/)
  })
})
