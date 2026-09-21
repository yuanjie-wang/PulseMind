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
      },
    })
    const token = prefixedId('tok', 12)
    this.views.set(options.tabId, view)
    this.wireDownloadRouting()
    this.downloadMeta.set(view.webContents, { origin, scopeId })
    const notify = () => this.onTabActivity?.(options.tabId)
    view.webContents.on('did-navigate', notify)
    view.webContents.on('did-navigate-in-page', notify)
    view.webContents.on('page-title-updated', notify)
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

  private async findPageByToken(token: string) {
    const context = this.browser?.contexts()[0]
    if (!context) throw new Error('CDP 连接没有可用的浏览器上下文')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
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

  /** One session-level will-download handler routes every pane download by
   *  the owning tab's origin: user → ~/Downloads, agent → the conversation
   *  workspace. Downloads from webContents we don't own are left untouched. */
  private wireDownloadRouting(): void {
    if (this.downloadsWired) return
    this.downloadsWired = true
    session.defaultSession.on('will-download', (_event, item, webContents) => {
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
