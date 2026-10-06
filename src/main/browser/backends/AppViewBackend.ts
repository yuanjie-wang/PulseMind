// ── App-view backend (A-M3, pane integration A-M5) ──
// Tabs are WebContentsViews docked inside the app window; control happens
// over the loopback DevTools protocol (connectOverCDP), so the SAME
// PlaywrightCommands executor drives them — the command layer is unchanged,
// exactly as planned (§8 M3). A token injected into each view maps CDP
// targets back to Electron views without touching the user's own windows.
//
// A-M5: the backend no longer docks views itself — BrowserService decides
// visibility (the pane shows the ACTIVE conversation's ACTIVE tab and folds
// otherwise; folding never destroys). Tabs carry an origin ('user' via the
// pane chrome | 'agent' via the tool): downloads from user tabs go to
// ~/Downloads, agent tabs stay jailed to the conversation workspace
// (download split, decision 2026-09-13).

import { prefixedId } from '../../utils/id'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, session, WebContentsView, type WebContents } from 'electron'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { appViewDock } from '../app-view-dock'
import { readDevToolsPort } from '../cdp-port'
import { healOopifBlindPage } from '../oopif-heal'
import { routeWindowOpen, PANE_SESSION_PARTITION, type WindowOpenRoute } from '../../../shared/browser/pane'
import { WORKSPACE_DIR } from '../../storage'
import type { BackendAdapter, BackendTab } from './BackendAdapter'
import type { BackendDescriptor } from '../../../shared/browser-client/protocol'

const MARKER_KEY = '__pulsemindAgentTab'

export type PaneTabOrigin = 'user' | 'agent'

interface DownloadMeta {
  origin: PaneTabOrigin
  scopeId: string
}

export class AppViewBackend implements BackendAdapter {
  private browser: Browser | null = null
  private views = new Map<string, WebContentsView>()
  private downloadMeta = new WeakMap<WebContents, DownloadMeta>()
  private downloadsWired = false
  /** Tab URL/title changes → BrowserService re-broadcasts the pane state. */
  onTabActivity: ((tabId: string) => void) | null = null
  /** window.open / target=_blank from a pane page (its setWindowOpenHandler
   *  below denies the native window): BrowserService turns the routed
   *  survivors into pane tabs of the opener's conversation. */
  onWindowOpen: ((openerTabId: string, route: WindowOpenRoute) => void) | null = null

  descriptor(): BackendDescriptor {
    return {
      id: 'app-view',
      type: 'app-view',
      capabilities: {
        browser: ['open', 'tabs', 'user'],
        tab: ['navigate', 'snapshot', 'screenshot', 'playwright', 'evaluate', 'recording'],
      },
    }
  }

  rawBrowser(): Browser | null {
    return this.browser
  }

  contextOf(): BrowserContext | null {
    return null
  }

  async start(): Promise<void> {
    if (this.browser?.isConnected?.()) return
    const port = readDevToolsPort()
    if (!port) throw new Error('应用内嵌浏览器后端不可用：调试端口未就绪')
    // Same deferral as ManagedBackend: playwright-core is ~170ms of require()
    // and BrowserService imports this module at launch.
    const { chromium } = await import('playwright-core')
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    // Views surviving into a (re)connect are the reconnect case — every view
    // is created after a start(), so a non-empty map here means the previous
    // connection died without stop(). Those tabs' cross-origin frames predate
    // the new auto-attach and are invisible to it (see oopif-heal.ts).
    if (this.views.size > 0) await this.healAdoptedViews()
  }

  async stop(): Promise<void> {
    for (const [, view] of this.views) this.destroyView(view)
    this.views.clear()
    if (this.browser) {
      try {
        this.browser.close()
      } catch {
        /* already gone */
      }
      this.browser = null
    }
  }

  async newTab(options: { url?: string; tabId: string; origin?: PaneTabOrigin; scopeId?: string }): Promise<BackendTab> {
    await this.start()
    const origin: PaneTabOrigin = options.origin ?? 'agent'
    const scopeId = options.scopeId ?? 'unscoped'
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        // Folded panes keep executing agent tasks — no timer throttling.
        backgroundThrottling: false,
        // Own persistent session (see PANE_SESSION_PARTITION): Chromium
        // persists the dock's width zoom per host name, and a shared session
        // let a pane stamp at ≈0.33× rescale the main window on a port
        // collision (localhost:8899 pane vs localhost:5173 renderer).
        partition: PANE_SESSION_PARTITION,
      },
    })
    const token = prefixedId('tok', 12)
    this.views.set(options.tabId, view)
    this.wireDownloadRouting()
    this.downloadMeta.set(view.webContents, { origin, scopeId })
    const notify = () => this.onTabActivity?.(options.tabId)
    view.webContents.on('did-navigate', () => {
      notify()
      // Chromium applies the destination host's own persisted zoom at commit;
      // the dock's width zoom must ride again or the new page renders at the
      // previous host's scale until the next layout event.
      appViewDock.restampZoom(view)
    })
    view.webContents.on('did-navigate-in-page', notify)
    view.webContents.on('page-title-updated', notify)
    // Electron's default for window.open/target=_blank is a real OS window
    // floating over the app (user report 2026-09-28). Every shape is denied
    // here; the classifier's survivors are handed to BrowserService, which
    // re-opens them as pane tabs of this tab's own conversation.
    view.webContents.setWindowOpenHandler((details) => {
      // postBody/referrer ride the route: a form POST must survive the
      // deny-and-reopen round trip as a POST (review_20260929 中7).
      const route = routeWindowOpen(details.url, details.disposition, details.postBody, details.referrer?.url)
      if (route.action !== 'ignore') this.onWindowOpen?.(options.tabId, route)
      return { action: 'deny' }
    })
    await view.webContents.loadURL('about:blank')
    await view.webContents.executeJavaScript(`${MARKER_KEY} = ${JSON.stringify(token)}`, true)
    let page: Page
    try {
      page = await this.findPageByToken(token)
    } catch (err) {
      // The view was already registered — tear it down so a failed newTab
      // never leaves an orphaned blank pane behind.
      this.views.delete(options.tabId)
      this.destroyView(view)
      throw err
    }
    if (options.url) await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    return {
      page,
      close: async () => {
        this.views.delete(options.tabId)
        appViewDock.detach(view)
        this.destroyView(view)
      },
    }
  }

  viewOf(tabId: string): WebContentsView | null {
    return this.views.get(tabId) ?? null
  }

  async userOpenTabs(): Promise<Array<{ id: string; url: string; title: string }>> {
    return [...this.views.entries()].map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    }))
  }

  /** User tabs already live in the shared registry — claiming only validates
   *  membership; BrowserService owns pane visibility. */
  async claimTab(tabId: string): Promise<void> {
    if (!this.views.has(tabId)) throw new Error(`应用窗格中没有这个标签页：${tabId}`)
  }

  /** ── internals ── */

  private destroyView(view: WebContentsView): void {
    try {
      appViewDock.detach(view)
    } catch {
      /* already detached */
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      /* already gone */
    }
  }

  /** Every page across all CDP contexts — pane pages live in the pane
   *  partition's context while the default session's windows (main, splash,
   *  hook login) live in another, and the mapping/order is Playwright's
   *  business, so token matching sweeps all of them. */
  private allPages(): Page[] {
    return this.browser?.contexts().flatMap((context) => context.pages()) ?? []
  }

  private async findPageByToken(token: string) {
    if ((this.browser?.contexts().length ?? 0) === 0) throw new Error('CDP 连接没有可用的浏览器上下文')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      for (const page of this.allPages()) {
        try {
          // Evaluated as PAGE JavaScript — plain JS only, no TS syntax here.
          const marker = await page.evaluate(`window[${JSON.stringify(MARKER_KEY)}]`)
          if (marker === token) return page
        } catch {
          /* not ours, or not ready */
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`未能通过 CDP 定位到新标签页（app=${app.isPackaged ? 'packaged' : 'dev'}）`)
  }

  /** Reconnect healing: reload each surviving tab whose cross-origin frames
   *  the new connection cannot see (mechanism in oopif-heal.ts). Only proven-
   *  blind pages pay the reload; a page mid-navigation or already gone is
   *  skipped, and one failed reload leaves the tab exactly as it was. */
  private async healAdoptedViews(): Promise<void> {
    if ((this.browser?.contexts().length ?? 0) === 0) return
    for (const [, view] of this.views) {
      const wc = view.webContents
      if (wc.isDestroyed()) continue
      try {
        // View ↔ page matching by a transient tag: written into the page's
        // main world from the Electron side, read back through Playwright.
        // (The newTab marker cannot be used here — it only lives until the
        // tab's first navigation.)
        const tag = `heal_${Math.random().toString(36).slice(2)}`
        await wc.executeJavaScript(`window.__pmHealTag = ${JSON.stringify(tag)}`, true)
        let page: Page | null = null
        for (const candidate of this.allPages()) {
          const seen = await candidate.evaluate('window.__pmHealTag').catch(() => undefined)
          if (seen === tag) {
            page = candidate
            break
          }
        }
        void wc.executeJavaScript('delete window.__pmHealTag', true).catch(() => {})
        if (!page) continue
        const frameUrls = wc.mainFrame.frames.map((f) => f.url)
        const reloaded = await healOopifBlindPage(page, frameUrls)
        if (reloaded) {
          console.warn(
            '[browser] app-view 重连修复：标签页的跨域 iframe 对新 CDP 连接不可见，已重载页面恢复控制:',
            wc.getURL(),
          )
        }
      } catch (err) {
        console.warn('[browser] app-view reconnect heal skipped a tab:', err instanceof Error ? err.message : err)
      }
    }
  }

  /** One session-level will-download handler routes every pane download by
   *  the owning tab's origin: user → ~/Downloads, agent → the conversation
   *  workspace. Downloads from webContents we don't own are left untouched.
   *  Wired on the pane's own session — will-download fires on the downloading
   *  webContents' session, and pane views stopped riding defaultSession when
   *  the zoom isolation moved them to PANE_SESSION_PARTITION. */
  private wireDownloadRouting(): void {
    if (this.downloadsWired) return
    this.downloadsWired = true
    session.fromPartition(PANE_SESSION_PARTITION).on('will-download', (_event, item, webContents) => {
      const meta = this.downloadMeta.get(webContents)
      if (!meta) return
      const dir = meta.origin === 'agent' ? join(WORKSPACE_DIR, 'downloads', meta.scopeId) : app.getPath('downloads')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        /* exists */
      }
      let name = item.getFilename() || `download_${Date.now()}`
      if (existsSync(join(dir, name))) name = `${Date.now()}_${name}`
      item.setSavePath(join(dir, name))
    })
  }
}
