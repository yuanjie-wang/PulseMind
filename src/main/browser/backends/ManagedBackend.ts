// ── Managed backend (A-M1, v1) ──
// Launches Chromium via playwright-core. Executable resolution order:
//   1. PULSEMIND_CHROMIUM_PATH env override
//   2. bundled Chromium from resources/chromium/ (M2 packing; present when
//      running from a packaged build)
//   3. system Chrome channel → 4. system Edge channel
// Headless by default (screenshots + snapshots work headless); the settings
// toggle arrives with M4. One BrowserContext per tab keeps storage isolated.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import type { BackendAdapter, BackendTab } from './BackendAdapter'
import type { BackendDescriptor } from '../../../shared/browser-client/protocol'

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

export class ManagedBackend implements BackendAdapter {
  private browser: Browser | null = null

  descriptor(): BackendDescriptor {
    return {
      id: 'managed',
      type: 'managed',
      capabilities: {
        browser: ['open', 'tabs', 'fetchRendered'],
        tab: ['navigate', 'snapshot', 'screenshot', 'playwright', 'evaluate', 'download'],
      },
    }
  }

  rawBrowser(): Browser | null {
    return this.browser
  }

  contextOf(tab: BackendTab): BrowserContext | null {
    return tab.page.context()
  }

  async start(): Promise<void> {
    if (this.browser?.isConnected?.()) return
    const launch = await resolveLaunchOptions()
    this.browser = await chromium.launch(launch)
  }

  async stop(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close() } catch { /* already gone */ }
      this.browser = null
    }
  }

  async newTab(options: { url?: string; tabId: string }): Promise<BackendTab> {
    void options.tabId
    await this.start()
    const context = await this.browser!.newContext({ viewport: DEFAULT_VIEWPORT })
    const page = await context.newPage()
    if (options.url) await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    return {
      page,
      close: async () => {
        try { await context.close() } catch { /* already gone */ }
      },
    }
  }
}

interface LaunchOptions {
  executablePath?: string
  channel?: 'chrome' | 'msedge'
  headless: boolean
}

/** Try candidates in order; first that launches wins. Exported for M2's
 *  packing self-check. */
export async function resolveLaunchOptions(headless = true): Promise<LaunchOptions> {
  const candidates: LaunchOptions[] = []
  if (process.env.PULSEMIND_CHROMIUM_PATH && existsSync(process.env.PULSEMIND_CHROMIUM_PATH)) {
    candidates.push({ executablePath: process.env.PULSEMIND_CHROMIUM_PATH, headless })
  }
  const bundled = bundledChromiumPath()
  if (bundled) candidates.push({ executablePath: bundled, headless })
  candidates.push({ channel: 'chrome', headless })
  candidates.push({ channel: 'msedge', headless })

  for (const options of candidates) {
    try {
      const probe = await chromium.launch(options)
      await probe.close()
      return options
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    '没有可用的浏览器内核：未找到随包 Chromium，也未安装系统 Chrome/Edge。' +
    '可安装 Chrome，或设置 PULSEMIND_CHROMIUM_PATH 指向一个 Chromium 可执行文件。')
}

/** Bundled Chromium executable (packaged builds; M2 fills this directory). */
function bundledChromiumPath(): string | null {
  if (!app.isPackaged) return null
  const base = join(process.resourcesPath, 'chromium')
  const win = join(base, 'chrome-win', 'chrome.exe')
  const mac = join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
  const linux = join(base, 'chrome-linux', 'chrome')
  for (const p of [win, mac, linux]) {
    if (existsSync(p)) return p
  }
  return null
}
