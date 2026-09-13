// ── BrowserService (L0 host, A-M1) ──
// Singleton orchestrator: backend registry, tab registry, session-scope
// attribution and the single entry the kernel talks to (executeCommand).
// Policies enforced here, not in the facade: URL scheme whitelist (§6),
// per-conversation tab isolation, audit_log on every state-changing command.
// Registry + orchestration only (≤1000-line rule) — command execution lives
// in PlaywrightCommands, launching in the backend adapters.

import { prefixedId } from '../utils/id'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell, type WebContents, type WebContentsView } from 'electron'
import {
  assertAllowedUrl,
  browserError,
  browserOk,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserTabInfo,
} from '../../shared/browser-client/protocol'
import {
  clampPaneWidth,
  defaultPaneWidth,
  normalizeAddressBarInput,
  type BrowserPaneAction,
  type BrowserPaneState,
  type BrowserPaneUpdate,
  type PaneTabInfo,
} from '../../shared/browser/pane'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { guardPath, buildBaselineDenyRoots } from '../../shared/sandbox/path-jail'
import { DEFAULT_SANDBOX_POLICY } from '../../shared/sandbox/policy'
import { WORKSPACE_DIR } from '../storage'
import { auditStore } from '../storage/audit-store'
import { settingsStore } from '../storage/settings-store'
import { getConversationWorkspaceDir } from '../storage/conversation.db'
import type { BackendAdapter } from './backends/BackendAdapter'
import { ManagedBackend } from './backends/ManagedBackend'
import { AppViewBackend } from './backends/AppViewBackend'
import { appViewDock } from './app-view-dock'
import { readDevToolsPort } from './cdp-port'
import { runPlaywrightOp } from './PlaywrightCommands'
import { runBrowserCode, type BrowserRunOutput } from './kernel'

/** Playwright ops that change page state — the audit-worthy subset. */
const MUTATING_METHODS = new Set(['navigate', 'back', 'forward', 'reload', 'close', 'evaluate', 'newTab', 'playwright', 'setActiveBackend', 'claimTab'])

interface ServiceTab {
  id: string
  backendId: string
  /** Owning conversation — tabs.list() is scoped to it (§4.1 Tab 归属). */
  scopeId: string
  /** Pane chrome (user) or browser tool (agent) — decides download routing
   *  (user → ~/Downloads, agent → conversation workspace). */
  origin: 'user' | 'agent'
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
  /** Per-conversation backend choice (协议 §5.1: one choice per task). */
  private activeBackend = new Map<string, 'managed' | 'app-view'>()
  /** Settings-derived defaults; re-read on every runCode call so settings
   *  changes apply without an app restart. The in-app pane is the default —
   *  browser work should be visible where the user is looking; managed
   *  (headless) remains selectable via settings or setActiveBackend. */
  private defaultBackend: 'managed' | 'app-view' = 'app-view'
  private defaultTimeoutMs: number | undefined
  /** What the renderer is showing right now — drives pane visibility. */
  private paneState: BrowserPaneState = { viewKind: 'other', conversationId: null, chatAreaWidth: 1300 }
  /** Persisted pane width (settings.browser.paneWidth); null = never dragged. */
  private paneWidth: number | null = null
  /** The user's selected tab per conversation inside the pane. */
  private paneActiveTab = new Map<string, string>()
  private paneSender: WebContents | null = null

  constructor() {
    // Both backends instantiate lazily on first use.
    this.backends.set('managed', new ManagedBackend())
    void this.loadDefaults()
  }

  private async loadDefaults(): Promise<void> {
    try {
      const browser = (await settingsStore.get()).browser
      if (browser?.backend) this.defaultBackend = browser.backend
      if (browser?.timeoutMs) this.defaultTimeoutMs = browser.timeoutMs
      if (browser?.paneWidth) this.paneWidth = browser.paneWidth
    } catch {
      /* defaults stand */
    }
  }

  /** Entry behind the BROWSER_RUN_CODE channel (registered in ipc/browser.handler.ts). */
  handleRunCode(payload: BrowserRunPayload): Promise<unknown> {
    if (!payload || typeof payload.code !== 'string' || !payload.code.trim()) {
      throw new Error('browser 工具需要非空 code 参数')
    }
    const scopeId = typeof payload.scopeId === 'string' && payload.scopeId ? payload.scopeId : 'unscoped'
    return this.runCode(payload.code, payload.timeoutMs, scopeId)
  }

  /** ── Pane (A-M5): chrome state, width, user tab actions ── */

  handlePaneState(state: BrowserPaneState, sender: WebContents): void {
    this.paneSender = sender
    this.paneState = state
    this.syncPane()
  }

  async handlePaneWidth(width: number, sender: WebContents): Promise<void> {
    this.paneSender = sender
    const clamped = clampPaneWidth(width, this.paneState.chatAreaWidth)
    if (clamped !== this.paneWidth) {
      this.paneWidth = clamped
      try {
        const s = await settingsStore.get()
        await settingsStore.set({ ...s, browser: { ...s.browser, paneWidth: clamped } })
      } catch {
        /* width stays session-only */
      }
    }
    appViewDock.setWidth(this.resolvePaneWidth())
    this.pushPaneUpdates()
  }

  async handlePaneAction(action: BrowserPaneAction, sender: WebContents): Promise<void> {
    this.paneSender = sender
    const scope = this.paneState.conversationId
    if (!scope) return
    switch (action.op) {
      case 'newTab': {
        const backend = this.backendFor('app-view') as AppViewBackend
        await backend.start()
        const id = prefixedId('tab')
        const created = await backend.newTab({ tabId: id, origin: 'user', scopeId: scope })
        this.tabs.set(id, { id, backendId: 'app-view', scopeId: scope, origin: 'user', createdAt: new Date().toISOString(), tab: created })
        this.paneActiveTab.set(scope, id)
        auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNewTab', target: 'about:blank', decision: 'allowed' })
        break
      }
      case 'closeTab': {
        const entry = this.resolveTab(action.tabId, scope)
        await this.closeTab(entry.id)
        auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneCloseTab', target: action.tabId, decision: 'allowed' })
        break
      }
      case 'selectTab':
        if (this.tabs.get(action.tabId)?.scopeId === scope) this.paneActiveTab.set(scope, action.tabId)
        break
      case 'navigate': {
        const entry = this.resolveTab(action.tabId, scope)
        const url = assertAllowedUrl(normalizeAddressBarInput(action.url))
        auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNavigate', target: url, decision: 'allowed' })
        await entry.tab.page.goto(url, { waitUntil: 'commit', timeout: 20_000 }).catch(() => {})
        break
      }
      case 'back':
        await this.resolveTab(action.tabId, scope)
          .tab.page.goBack({ waitUntil: 'commit', timeout: 20_000 })
          .catch(() => {})
        break
      case 'forward':
        await this.resolveTab(action.tabId, scope)
          .tab.page.goForward({ waitUntil: 'commit', timeout: 20_000 })
          .catch(() => {})
        break
      case 'reload':
        await this.resolveTab(action.tabId, scope)
          .tab.page.reload({ waitUntil: 'commit', timeout: 20_000 })
          .catch(() => {})
        break
      case 'openExternal':
        await shell.openExternal(assertAllowedUrl(action.url))
        return
    }
    this.syncPane()
  }

  /** Release every tab + stop backends (app quit). */
  async stopAll(): Promise<void> {
    for (const [id] of this.tabs) await this.closeTab(id)
    for (const backend of this.backends.values()) {
      try {
        await backend.stop()
      } catch {
        /* best-effort */
      }
    }
  }

  async executeCommand(cmd: BrowserCommand, scopeId: string): Promise<BrowserCommandResult> {
    try {
      this.audit(cmd, scopeId)
      switch (cmd.method) {
        case 'getDescriptor':
          return browserOk(this.backendFor(this.activeBackendId(scopeId)).descriptor())
        case 'setActiveBackend': {
          if (cmd.backend === 'app-view' && !readDevToolsPort()) {
            return browserError('APP_VIEW_UNAVAILABLE', '应用内嵌浏览器后端不可用（调试端口未就绪）')
          }
          const backend = this.backendFor(cmd.backend)
          try {
            await backend.start()
          } catch (err) {
            this.activeBackend.set(scopeId, 'managed')
            return browserError('APP_VIEW_UNAVAILABLE', err instanceof Error ? err.message : String(err))
          }
          this.activeBackend.set(scopeId, cmd.backend)
          return browserOk(backend.descriptor())
        }
        case 'userOpenTabs': {
          const backend = this.backendFor(this.activeBackendId(scopeId))
          if (!backend.userOpenTabs) return browserError('UNSUPPORTED_BACKEND', '当前后端没有应用窗格')
          const all = await backend.userOpenTabs()
          return browserOk(all.filter((t) => this.tabs.get(t.id)?.scopeId === scopeId))
        }
        case 'claimTab': {
          const entry = this.resolveTab(cmd.tabId, scopeId)
          const backend = this.backendFor(entry.backendId)
          if (!backend.claimTab) return browserError('UNSUPPORTED_BACKEND', '当前后端没有应用窗格')
          await backend.claimTab(entry.id)
          return browserOk(await this.tabInfo(entry))
        }
        case 'listTabs':
          return browserOk(await this.listTabs(scopeId))
        case 'listDownloads':
          return browserOk(this.listDownloads(scopeId))
        case 'newTab': {
          if (cmd.url) assertAllowedUrl(cmd.url)
          const backendId = this.activeBackendId(scopeId)
          const backend = this.backendFor(backendId)
          await backend.start()
          const id = prefixedId('tab')
          const downloadsDir = backendId === 'managed' ? join(WORKSPACE_DIR, 'downloads', scopeId) : undefined
          const created = await backend.newTab({ url: cmd.url, tabId: id, downloadsDir, origin: 'agent', scopeId })
          this.tabs.set(id, { id, backendId, scopeId, origin: 'agent', createdAt: new Date().toISOString(), tab: created })
          this.syncPane()
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
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 })
          return browserOk()
        case 'forward':
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 })
          return browserOk()
        case 'reload':
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
          return browserOk()
        case 'close':
          await this.closeTab(entry.id)
          this.syncPane()
          return browserOk()
        case 'snapshot':
          return browserOk(await page.locator('html').ariaSnapshot())
        case 'screenshot': {
          const buffer = cmd.selector ? await page.locator(cmd.selector).screenshot() : await page.screenshot({ fullPage: cmd.fullPage })
          return browserOk({ mime: 'image/png', base64: buffer.toString('base64') })
        }
        case 'evaluate':
          return browserOk(await page.evaluate(cmd.expression))
        case 'playwright': {
          // setInputFiles uploads local files into a page — jail them to the
          // conversation's workspace so a page can't exfiltrate arbitrary paths.
          if (cmd.op === 'setInputFiles') {
            const wsDir = getConversationWorkspaceDir(scopeId)
            if (wsDir) {
              const decision = guardPath({
                denyRoots: buildBaselineDenyRoots(homedir(), process.platform),
                workspaceDir: wsDir,
                policy: DEFAULT_SANDBOX_POLICY,
                target: cmd.arg ?? '',
                operation: 'read',
              })
              if (!decision.ok) return browserError('PATH_DENIED', `文件上传被拒绝：${decision.reason}`)
            }
          }
          return browserOk(await runPlaywrightOp(page, { selector: cmd.selector, op: cmd.op, arg: cmd.arg, timeoutMs: cmd.timeoutMs }))
        }
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

  private activeBackendId(scopeId: string): 'managed' | 'app-view' {
    return this.activeBackend.get(scopeId) ?? this.defaultBackend
  }

  /** Files saved by page downloads in this conversation's workspace. */
  private listDownloads(scopeId: string): Array<{ name: string; path: string; size: number; savedAt: string }> {
    const dir = join(WORKSPACE_DIR, 'downloads', scopeId)
    if (!existsSync(dir)) return []
    const out: Array<{ name: string; path: string; size: number; savedAt: string }> = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isFile()) out.push({ name, path: full, size: st.size, savedAt: st.mtime.toISOString() })
      } catch {
        /* vanished between list and stat */
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  /** Lazy backend factory — app-view instantiates (and connects) on demand. */
  private backendFor(id: string): BackendAdapter {
    let backend = this.backends.get(id)
    if (!backend) {
      if (id === 'app-view') {
        const appView = new AppViewBackend()
        appView.onTabActivity = () => this.pushPaneUpdates()
        backend = appView
        this.backends.set(id, backend)
      } else {
        throw new Error(`未知后端：${id}`)
      }
    }
    return backend
  }

  /** Rendered page HTML via the managed backend — the internal read-web
   *  channel (knowledge import etc.). First internal consumer, before the
   *  agent tool. Audited like any browser command. */
  async fetchRendered(url: string): Promise<string | null> {
    auditStore.record({ scope: 'browser', actor: 'internal', action: 'browser.fetchRendered', target: url, decision: 'allowed' })
    const backend = this.backends.get('managed')!
    try {
      await backend.start()
      const tab = await backend.newTab({ url: assertAllowedUrl(url), tabId: 'internal_fetch' })
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

  private async listTabs(scopeId: string): Promise<BrowserTabInfo[]> {
    const scopeTabs = [...this.tabs.values()].filter((t) => t.scopeId === scopeId)
    return Promise.all(scopeTabs.map(async (t) => ({ id: t.id, url: t.tab.page.url(), title: await t.tab.page.title().catch(() => '') })))
  }

  /** ── pane internals (A-M5) ── */

  private resolvePaneWidth(): number {
    return clampPaneWidth(this.paneWidth ?? defaultPaneWidth(this.paneState.chatAreaWidth), this.paneState.chatAreaWidth)
  }

  private paneScopeTabs(scope: string | null): Array<{ entry: ServiceTab; view: WebContentsView | null }> {
    if (!scope) return []
    const backend = this.backends.get('app-view') as AppViewBackend | undefined
    if (!backend) return []
    return [...this.tabs.values()].filter((t) => t.scopeId === scope && t.backendId === 'app-view').map((entry) => ({ entry, view: backend.viewOf(entry.id) }))
  }

  /** Apply the pane snapshot to the native dock. Folding (no tabs, or not on
   *  the chat view) keeps tabs alive — bounds go zero, nothing is destroyed. */
  private syncPane(): void {
    const { viewKind, conversationId } = this.paneState
    const scopeTabs = viewKind === 'chat' ? this.paneScopeTabs(conversationId) : []
    appViewDock.setWidth(this.resolvePaneWidth())
    if (scopeTabs.length === 0) {
      appViewDock.show(null)
      appViewDock.setVisible(false)
      this.pushPaneUpdates()
      return
    }
    const scope = conversationId as string
    let activeId = this.paneActiveTab.get(scope)
    if (!activeId || !scopeTabs.some((t) => t.entry.id === activeId)) {
      activeId = scopeTabs[scopeTabs.length - 1].entry.id
      this.paneActiveTab.set(scope, activeId)
    }
    const active = scopeTabs.find((t) => t.entry.id === activeId)!
    appViewDock.show(active.view)
    appViewDock.setVisible(true)
    this.pushPaneUpdates()
  }

  private pushPaneUpdates(): void {
    const target = this.paneSender ?? appViewDock.getWindow()?.webContents
    if (!target || target.isDestroyed()) return
    const { viewKind, conversationId } = this.paneState
    const scope = viewKind === 'chat' ? conversationId : null
    const scopeTabs = this.paneScopeTabs(scope)
    let activeId = scope ? (this.paneActiveTab.get(scope) ?? null) : null
    if (activeId && !scopeTabs.some((t) => t.entry.id === activeId)) activeId = scopeTabs[scopeTabs.length - 1]?.entry.id ?? null
    const tabs: PaneTabInfo[] = scopeTabs.map((t) => ({
      id: t.entry.id,
      url: t.view?.webContents.getURL() ?? '',
      title: t.view?.webContents.getTitle() ?? '',
      active: t.entry.id === activeId,
    }))
    const update: BrowserPaneUpdate = {
      visible: viewKind === 'chat' && scopeTabs.length > 0,
      width: this.resolvePaneWidth(),
      conversationId: scope,
      tabs,
    }
    target.send(IPC_CHANNELS.BROWSER_PANE_UPDATE, update)
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
    try {
      await entry.tab.close()
    } catch {
      /* already gone */
    }
  }

  private audit(cmd: BrowserCommand, scopeId: string): void {
    if (!MUTATING_METHODS.has(cmd.method)) return
    const target =
      'url' in cmd
        ? cmd.url
        : 'expression' in cmd
          ? cmd.expression.slice(0, 120)
          : 'op' in cmd
            ? `${cmd.op} ${cmd.selector.slice(0, 80)}`
            : 'tabId' in cmd
              ? cmd.tabId
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
  async runCode(code: string, timeoutMs: number | undefined, scopeId: string): Promise<BrowserRunOutput> {
    await this.loadDefaults()
    return runBrowserCode({ code, timeoutMs: timeoutMs ?? this.defaultTimeoutMs }, (cmd) => this.executeCommand(cmd, scopeId))
  }
}

export const browserService = new BrowserService()
