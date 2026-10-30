// ── Managed backend (A-M1, v1) ──
// Launches Chromium via playwright-core. Executable resolution order:
//   1. PULSEMIND_CHROMIUM_PATH env override
//   2. bundled Chromium from resources/chromium/ (M2 packing; present when
//      running from a packaged build)
//   3. system Chrome channel → 4. system Edge channel
// Headless by default (screenshots + snapshots work headless); the settings
// toggle arrives with M4. One BrowserContext per tab keeps storage isolated.
//
// `chromium` is loaded on demand — a `start()` or a probe launch is the only
// thing that needs it. The types stay static (they cost nothing at runtime).

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Browser, BrowserContext } from 'playwright-core'
import { settingsStore } from '../../storage/settings-store'
import { parseProxyUrl, ProxyConfigError } from '../../../shared/proxy'
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
    let headless = true
    let proxyUrl: string | null = null
    try {
      const settings = await settingsStore.get()
      headless = settings.browser?.headless ?? true
      // 抓包面（2026-10-27）：托管浏览器跟主进程 fetch 一样走用户代理。
      // Chromium 走系统证书库，Fiddler/Charles 的根证书装进系统链即可
      // 解密 HTTPS，不需要 proxyStrictSSL。开关关时跳过解析——关着的
      // 开关不该让一个坏地址把浏览器 launch 打炸（fetch 链同款）。
      proxyUrl = settings.proxyEnabled !== false ? parseProxyUrl(settings.proxyUrl) : null
    } catch (err) {
      // 代理配置无效必须响亮地失败——用户刚填的坏地址静默直连，抓包就
      // 抓了个寂寞；settings 本身读不出来才回落默认（headless 同款容错）。
      if (err instanceof ProxyConfigError) throw err
      /* default */
    }
    const launch = await resolveLaunchOptions(headless)
    if (proxyUrl) (launch as LaunchOptions).proxy = { server: proxyUrl }
    const { chromium } = await import('playwright-core')
    this.browser = await chromium.launch(launch)
  }

  async stop(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        /* already gone */
      }
      this.browser = null
    }
  }

  async newTab(options: { url?: string; tabId: string; downloadsDir?: string }): Promise<BackendTab> {
    void options.tabId
    await this.start()
    const context = await this.browser!.newContext({ viewport: DEFAULT_VIEWPORT, acceptDownloads: true })
    const page = await context.newPage()
    if (options.downloadsDir) {
      // A-M4 下载: every download in this tab lands in the conversation's
      // workspace — nothing goes to the user's ~/Downloads unasked.
      mkdirSync(options.downloadsDir, { recursive: true })
      page.on('download', (download) => {
        const name = download.suggestedFilename() || `download_${Date.now()}`
        download
          .saveAs(join(options.downloadsDir!, name))
          .catch((err) => console.warn('[browser] download save failed:', err instanceof Error ? err.message : err))
      })
    }
    if (options.url) await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    return {
      page,
      close: async () => {
        try {
          await context.close()
        } catch {
          /* already gone */
        }
      },
    }
  }
}

interface LaunchOptions {
  executablePath?: string
  channel?: 'chrome' | 'msedge'
  headless: boolean
  /** Playwright 代理参数（抓包调试）：只在 start() 的真实 launch 上设置，
   *  resolveLaunchOptions 的可执行文件探测不背它——代理不可达不该把
   *  「找不到浏览器内核」的探测误伤。 */
  proxy?: { server: string }
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

  const { chromium } = await import('playwright-core')
  for (const options of candidates) {
    try {
      const probe = await chromium.launch(options)
      await probe.close()
      return options
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    '没有可用的浏览器内核：未找到随包 Chromium，也未安装系统 Chrome/Edge。' + '可安装 Chrome，或设置 PULSEMIND_CHROMIUM_PATH 指向一个 Chromium 可执行文件。',
  )
}

/** Bundled Chromium executable (packaged builds; filled by browsers:ensure).
 *  macOS layout differs by playwright version: newer builds ship
 *  "Google Chrome for Testing.app", older ones "Chromium.app". */
function bundledChromiumPath(): string | null {
  if (!app.isPackaged) return null
  const base = join(process.resourcesPath, 'chromium')
  const candidates = [
    join(base, 'chrome-win', 'chrome.exe'),
    join(base, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(base, 'chrome-linux', 'chrome'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}
