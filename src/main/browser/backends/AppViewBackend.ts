// ── App-view backend (A-M3) ──
// Tabs are WebContentsViews docked inside the app window; control happens
// over the loopback DevTools protocol (connectOverCDP), so the SAME
// PlaywrightCommands executor drives them — the command layer is unchanged,
// exactly as planned (§8 M3). A token injected into each view maps CDP
// targets back to Electron views without touching the user's own windows.

import { randomUUID } from 'node:crypto'
import { app, WebContentsView } from 'electron'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { appViewDock } from '../app-view-dock'
import { readDevToolsPort } from '../cdp-port'
import type { BackendAdapter, BackendTab } from './BackendAdapter'
import type { BackendDescriptor } from '../../../shared/browser-client/protocol'

const MARKER_KEY = '__pulsemindAgentTab'

export class AppViewBackend implements BackendAdapter {
  private browser: Browser | null = null
  private views = new Map<string, WebContentsView>()

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
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  }

  async stop(): Promise<void> {
    for (const [, view] of this.views) this.destroyView(view)
    this.views.clear()
    if (this.browser) {
      try { this.browser.close() } catch { /* already gone */ }
      this.browser = null
    }
  }

  async newTab(options: { url?: string; tabId: string }): Promise<BackendTab> {
    await this.start()
    const view = new WebContentsView({ webPreferences: { sandbox: true } })
    const token = `tok_${randomUUID().slice(0, 12)}`
    this.views.set(options.tabId, view)
    appViewDock.addView(view)
    await view.webContents.loadURL('about:blank')
    await view.webContents.executeJavaScript(`${MARKER_KEY} = ${JSON.stringify(token)}`, true)
    const page = await this.findPageByToken(token)
    if (options.url) await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    return {
      page,
      close: async () => {
        this.views.delete(options.tabId)
        appViewDock.removeView(view)
        this.destroyView(view)
      },
    }
  }

  async userOpenTabs(): Promise<Array<{ id: string; url: string; title: string }>> {
    return [...this.views.entries()].map(([id, view]) => ({
      id,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    }))
  }

  async claimTab(tabId: string): Promise<void> {
    if (!this.views.has(tabId)) throw new Error(`应用窗格中没有这个标签页：${tabId}`)
    appViewDock.addViewToTop(this.views.get(tabId)!)
  }

  /** ── internals ── */

  private destroyView(view: WebContentsView): void {
    try {
      appViewDock.removeView(view)
    } catch { /* already removed */ }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch { /* already gone */ }
  }

  private async findPageByToken(token: string) {
    const context = this.browser?.contexts()[0]
    if (!context) throw new Error('CDP 连接没有可用的浏览器上下文')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      for (const page of context.pages()) {
        try {
          const marker = await page.evaluate(`(window as any)[${JSON.stringify(MARKER_KEY)}]`)
          if (marker === token) return page
        } catch { /* not ours, or not ready */ }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`未能通过 CDP 定位到新标签页（app=${app.isPackaged ? 'packaged' : 'dev'}）`)
  }
}
