// ── BrowserService (L0 host, A-M1) ──
// Singleton orchestrator: backend registry, tab registry, session-scope
// attribution and the single entry the kernel talks to (executeCommand).
// Policies enforced here, not in the facade: URL scheme whitelist (§6),
// per-conversation tab isolation, audit_log on every state-changing command.
// Registry + orchestration only (≤1000-line rule) — command execution lives
// in PlaywrightCommands, launching in the backend adapters.

import { randomUUID } from 'node:crypto'
import {
  assertAllowedUrl,
  browserError,
  browserOk,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserTabInfo,
} from '../../shared/browser-client/protocol'
import { auditStore } from '../storage/audit-store'
import type { BackendAdapter } from './backends/BackendAdapter'
import { ManagedBackend } from './backends/ManagedBackend'
import { runPlaywrightOp } from './PlaywrightCommands'
import { runBrowserCode, type BrowserRunOutput } from './kernel'

/** Playwright ops that change page state — the audit-worthy subset. */
const MUTATING_METHODS = new Set(['navigate', 'back', 'forward', 'reload', 'close', 'evaluate', 'newTab', 'playwright'])

interface ServiceTab {
  id: string
  backendId: string
  /** Owning conversation — tabs.list() is scoped to it (§4.1 Tab 归属). */
  scopeId: string
  createdAt: string
  tab: import('./backends/BackendAdapter').BackendTab
}

export interface BrowserRunPayload {
  code: string
  timeoutMs?: number
  scopeId: string
}

export class BrowserService {
  private backends = new Map<string, BackendAdapter>()
  private tabs = new Map<string, ServiceTab>()

  constructor() {
    // v1 registers only `managed`; app-view joins the registry in M3.
    this.backends.set('managed', new ManagedBackend())
  }

  /** Entry behind the BROWSER_RUN_CODE channel (registered in ipc/browser.handler.ts). */
  handleRunCode(payload: BrowserRunPayload): Promise<unknown> {
    if (!payload || typeof payload.code !== 'string' || !payload.code.trim()) {
      throw new Error('browser 工具需要非空 code 参数')
    }
    const scopeId = typeof payload.scopeId === 'string' && payload.scopeId ? payload.scopeId : 'unscoped'
    return this.runCode(payload.code, payload.timeoutMs, scopeId)
  }

  /** Release every tab + stop backends (app quit). */
  async stopAll(): Promise<void> {
    for (const [id] of this.tabs) await this.closeTab(id)
    for (const backend of this.backends.values()) {
      try { await backend.stop() } catch { /* best-effort */ }
    }
  }

  async executeCommand(cmd: BrowserCommand, scopeId: string): Promise<BrowserCommandResult> {
    try {
      this.audit(cmd, scopeId)
      switch (cmd.method) {
        case 'getDescriptor': {
          // v1 registers only `managed`; app-view appears here in M3.
          const managed = this.backends.get('managed')!
          return browserOk(managed.descriptor())
        }
        case 'listTabs':
          return browserOk(this.listTabs(scopeId))
        case 'newTab': {
          if (cmd.url) assertAllowedUrl(cmd.url)
          const backend = this.backends.get('managed')!
          await backend.start()
          const created = await backend.newTab(cmd.url)
          const id = `tab_${randomUUID().slice(0, 8)}`
          this.tabs.set(id, { id, backendId: 'managed', scopeId, createdAt: new Date().toISOString(), tab: created })
          return browserOk(await this.tabInfo(this.tabs.get(id)!))
        }
        default:
          break
      }
      // Tab-carrying commands from here on; the `in` guard narrows the union.
      if (!('tabId' in cmd)) return browserError('UNKNOWN_METHOD', `命令缺少 tabId：${(cmd as { method: string }).method}`)
      const entry = this.resolveTab(cmd.tabId, scopeId)
      const page = entry.tab.page
      switch (cmd.method) {
        case 'getState':
          return browserOk({ id: entry.id, url: page.url(), title: await page.title() })
        case 'navigate':
          await page.goto(assertAllowedUrl(cmd.url), { waitUntil: 'domcontentloaded', timeout: 20_000 })
          return browserOk({ url: page.url(), title: await page.title() })
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }); return browserOk()
        case 'forward': await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }); return browserOk()
        case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }); return browserOk()
        case 'close': await this.closeTab(entry.id); return browserOk()
        case 'snapshot': return browserOk(await page.locator('html').ariaSnapshot())
        case 'screenshot': {
          const buffer = cmd.selector
            ? await page.locator(cmd.selector).screenshot()
            : await page.screenshot({ fullPage: cmd.fullPage })
          return browserOk({ mime: 'image/png', base64: buffer.toString('base64') })
        }
        case 'evaluate':
          return browserOk(await page.evaluate(cmd.expression))
        case 'playwright':
          return browserOk(await runPlaywrightOp(page, { selector: cmd.selector, op: cmd.op, arg: cmd.arg, timeoutMs: cmd.timeoutMs }))
        case 'playwrightWaitForTimeout':
          await page.waitForTimeout(Math.min(Math.max(cmd.ms, 0), 30_000))
          return browserOk()
        default:
          return browserError('UNKNOWN_METHOD', `未知命令：${(cmd as { method: string }).method}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Navigation rejections (dns, 404 lands fine, TLS…) surface readably —
      // the model decides whether to retry, search, or give up.
      return browserError('BROWSER_CMD_FAILED', message)
    }
  }

  /** ── internals ── */

  /** Rendered page HTML via the managed backend — the internal read-web
   *  channel (knowledge import etc.). First internal consumer, before the
   *  agent tool. Audited like any browser command. */
  async fetchRendered(url: string): Promise<string | null> {
    auditStore.record({ scope: 'browser', actor: 'internal', action: 'browser.fetchRendered', target: url, decision: 'allowed' })
    const backend = this.backends.get('managed')!
    try {
      await backend.start()
      const tab = await backend.newTab(assertAllowedUrl(url))
      try {
        await tab.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
        await tab.page.waitForTimeout(800) // let SPA hydration begin
        return await tab.page.content()
      } finally {
        await tab.close().catch(() => {})
      }
    } catch (err) {
      console.warn('[browser] fetchRendered failed:', err instanceof Error ? err.message : err)
      return null
    }
  }

  private listTabs(scopeId: string): BrowserTabInfo[] {
    return [...this.tabs.values()]
      .filter((t) => t.scopeId === scopeId)
      .map((t) => ({ id: t.id, url: t.tab.page.url() }))
  }

  private resolveTab(tabId: string, scopeId: string): ServiceTab {
    const entry = this.tabs.get(tabId)
    if (!entry) throw new Error(`Tab 不存在：${tabId}（用 tabs.list() 重新核对）`)
    if (entry.scopeId !== scopeId) throw new Error('Tab 不属于当前会话')
    return entry
  }

  private async tabInfo(entry: ServiceTab): Promise<BrowserTabInfo> {
    return { id: entry.id, url: entry.tab.page.url(), title: await entry.tab.page.title() }
  }

  private async closeTab(id: string): Promise<void> {
    const entry = this.tabs.get(id)
    if (!entry) return
    this.tabs.delete(id)
    try { await entry.tab.close() } catch { /* already gone */ }
  }

  private audit(cmd: BrowserCommand, scopeId: string): void {
    if (!MUTATING_METHODS.has(cmd.method)) return
    const target = 'url' in cmd ? cmd.url
      : 'expression' in cmd ? cmd.expression.slice(0, 120)
      : 'op' in cmd ? `${cmd.op} ${cmd.selector.slice(0, 80)}`
      : 'tabId' in cmd ? cmd.tabId
      : cmd.method
    auditStore.record({
      scope: 'browser',
      actor: scopeId,
      action: `browser.${cmd.method}`,
      target,
      decision: 'allowed',
    })
  }

  /** Run one kernel call — exposed for the main-process agent host (M1.4). */
  runCode(code: string, timeoutMs: number | undefined, scopeId: string): Promise<BrowserRunOutput> {
    return runBrowserCode({ code, timeoutMs }, (cmd) => this.executeCommand(cmd, scopeId))
  }
}

export const browserService = new BrowserService()
