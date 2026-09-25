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
  type PageExpression,
} from '../../shared/browser-client/protocol'
import {
  clampPaneWidth,
  defaultPaneWidth,
  isFreshTabUrl,
  normalizeAddressBarInput,
  type BrowserPaneAction,
  type BrowserPaneState,
  type BrowserPaneUpdate,
  type PaneTabInfo,
} from '../../shared/browser/pane'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { guardPath, buildBaselineDenyRoots } from '../../shared/sandbox/path-jail'
import { WORKSPACE_DIR } from '../storage'
import { auditStore } from '../storage/audit-store'
import { browserHistoryStore } from '../storage/browser-history-store'
import { settingsStore } from '../storage/settings-store'
import { getConversationWorkspaceDir } from '../storage/conversation.db'
import type { BackendAdapter } from './backends/BackendAdapter'
import { ManagedBackend } from './backends/ManagedBackend'
import { AppViewBackend } from './backends/AppViewBackend'
import { appViewDock } from './app-view-dock'
import { readDevToolsPort } from './cdp-port'
import { runPlaywrightOp } from './PlaywrightCommands'
import { takeDomSnapshot } from './snapshot-refs'
import { browserFavoriteStore } from '../storage/browser-favorite-store'
import { runBrowserCode, type BrowserRunOutput } from './kernel'

/** Playwright ops that change page state — the audit-worthy subset. */
const MUTATING_METHODS = new Set(['navigate', 'back', 'forward', 'reload', 'close', 'evaluate', 'newTab', 'playwright', 'setActiveBackend', 'claimTab'])

interface ServiceTab {
  /** The tab's last AI-mode snapshot tree + its url (PLAN-browser-snapshot-ai
   *  §1.3): the diff baseline AND the server-side sig source for action-time
   *  ref verification. Dropped with the tab entry — no new lifecycle. */
  lastSnapshot?: { url: string; tree: import('../../shared/browser-client/snapshot-render').AriaNode[] }
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

  /** Track which renderer owns the pane (review 2026-09-18 M1): a renderer
   *  reload (refresh, crash restore, window reopen) creates a NEW WebContents
   *  whose store starts EMPTY — the paneUpdateEquals gate in pushPaneUpdates
   *  would swallow the identical re-push and the new renderer would learn
   *  nothing until a tab actually changed. A sender change invalidates the
   *  last push once, so the first syncPane reaches the fresh store. */
  private setPaneSender(sender: WebContents): void {
    if (this.paneSender !== sender) {
      this.paneSender = sender
      this.lastPanePush = null
    }
  }

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
    this.setPaneSender(sender)
    this.paneState = state
    appViewDock.setChromeOverlay(state.chromeOverlayHeight ?? 0)
    this.syncPane()
  }

  async handlePaneWidth(width: number, sender: WebContents): Promise<void> {
    this.setPaneSender(sender)
    const clamped = clampPaneWidth(width, this.paneState.chatAreaWidth)
    if (clamped !== this.paneWidth) {
      this.paneWidth = clamped
      try {
        await settingsStore.update(s => ({ ...s, browser: { ...s.browser, paneWidth: clamped } }))
      } catch {
        /* width stays session-only */
      }
    }
    appViewDock.setWidth(this.resolvePaneWidth())
    this.pushPaneUpdates(true)
  }

  async handlePaneAction(action: BrowserPaneAction, sender: WebContents): Promise<void> {
    this.setPaneSender(sender)
    const scope = this.paneState.conversationId
    if (!scope) return
    switch (action.op) {
      case 'newTab':
        await this.createUserPaneTab(scope)
        break
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
        const url = assertAllowedUrl(normalizeAddressBarInput(action.url))
        // No tabId = the pane had no tab when Enter was pressed, and the
        // address bar's promise ("输入网址，回车打开") is to open one and go
        // there. A tab that appeared in the meantime — a second Enter before
        // the pane update landed, or one the agent opened — is reused rather
        // than duplicated, so the resolution is the same one the dock uses.
        const entry = action.tabId ? this.resolveTab(action.tabId, scope) : (this.activePaneEntry(scope) ?? (await this.createUserPaneTab(scope)))
        auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNavigate', target: url, decision: 'allowed' })
        const beforeUrl = entry.tab.page.url()
        await entry.tab.page.goto(url, { waitUntil: 'commit', timeout: 20_000 }).catch(() => {})
        // History records MANUAL navigation only (裁定 L1 — the agent's
        // executeCommand('navigate') never reaches here; back/forward/reload
        // are not new destinations). The FINAL url is what's remembered
        // (redirects land under where the user actually went); a goto that
        // never committed — page.url unchanged — is not a visit.
        const finalUrl = entry.tab.page.url()
        // about:blank / chrome-error 是导航失败或空页签的落点，不是「去过哪」
        // ——记进去只会在联想里冒出噪声行（用户库里的 about:blank 行即此洞）。
        if (finalUrl && finalUrl !== beforeUrl && !/^(about:|chrome-error:)/i.test(finalUrl)) {
          const title = await entry.tab.page.title().catch(() => '')
          browserHistoryStore.recordVisit(finalUrl, title || undefined)
        }
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
        case 'listFavorites':
          return browserOk(browserFavoriteStore.list())
        case 'addFavorite':
          try {
            const added = browserFavoriteStore.add(cmd.url, cmd.title)
            return browserOk({ url: added.url, title: added.title ?? undefined, added: added.created ? true : 'already' })
          } catch (err) {
            return browserError('FAVORITE_LIMIT', err instanceof Error ? err.message : String(err))
          }
        case 'removeFavorite':
          return browserOk({ removed: browserFavoriteStore.remove(cmd.url) })
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
        case 'snapshot': {
          const prev = entry.lastSnapshot ?? null
          const snap = await takeDomSnapshot(page, prev, { full: (cmd as { full?: boolean }).full })
          entry.lastSnapshot = { url: page.url(), tree: snap.tree }
          return browserOk(snap.text)
        }
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
                target: cmd.arg ?? '',
                operation: 'read',
              })
              if (!decision.ok) return browserError('PATH_DENIED', `文件上传被拒绝：${decision.reason}`)
            }
          }
          return browserOk(await runPlaywrightOp(page, { selector: cmd.selector, op: cmd.op, arg: cmd.arg, timeoutMs: cmd.timeoutMs }, entry.lastSnapshot?.tree ?? null))
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
        appView.onTabActivity = () => this.handleTabActivity()
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

  /** The scope's app-view tabs, as the pane sees them. */
  private paneScopeEntries(scope: string | null): ServiceTab[] {
    if (!scope) return []
    return [...this.tabs.values()].filter((t) => t.scopeId === scope && t.backendId === 'app-view')
  }

  /** The native view behind a tab, or null while the backend is not built yet
   *  (a scope can be listed before its first tab exists). */
  private viewOfTab(tabId: string): WebContentsView | null {
    const backend = this.backends.get('app-view') as AppViewBackend | undefined
    return backend?.viewOf(tabId) ?? null
  }

  /** The tab the pane shows for this scope, or null when it has none: the
   *  user's pick, falling back to the newest tab. One rule for every reader —
   *  the native dock (syncPane), the pushed pane state, and an address typed
   *  with no tab id, where a tab that appeared in the meantime must be reused
   *  rather than duplicated. */
  private activePaneEntry(scope: string): ServiceTab | null {
    const entries = this.paneScopeEntries(scope)
    if (entries.length === 0) return null
    let activeId = this.paneActiveTab.get(scope)
    if (!activeId || !entries.some((t) => t.id === activeId)) {
      activeId = entries[entries.length - 1].id
      this.paneActiveTab.set(scope, activeId)
    }
    return entries.find((t) => t.id === activeId) ?? null
  }

  /** The pane's own tab (origin 'user': its downloads go to ~/Downloads, not
   *  the conversation workspace). Made active, because every caller is the
   *  user asking for somewhere to look — the "+" button and an address typed
   *  into a pane that has no tab yet. Creation is serialized per scope: the
   *  tab is registered only after `backend.start()` + `newTab()` return (a
   *  Playwright page costs 100ms+), and a second Enter (or a second "+") in
   *  that window must await the same tab, not race a duplicate past the
   *  registry write — the reuse rule above can only see registered tabs. */
  private paneTabCreation = new Map<string, Promise<ServiceTab>>()

  private createUserPaneTab(scope: string): Promise<ServiceTab> {
    const inFlight = this.paneTabCreation.get(scope)
    if (inFlight) return inFlight
    const created = this.doCreateUserPaneTab(scope).finally(() => {
      this.paneTabCreation.delete(scope)
    })
    this.paneTabCreation.set(scope, created)
    return created
  }

  private async doCreateUserPaneTab(scope: string): Promise<ServiceTab> {
    const backend = this.backendFor('app-view') as AppViewBackend
    await backend.start()
    const id = prefixedId('tab')
    const created = await backend.newTab({ tabId: id, origin: 'user', scopeId: scope })
    const entry: ServiceTab = { id, backendId: 'app-view', scopeId: scope, origin: 'user', createdAt: new Date().toISOString(), tab: created }
    this.tabs.set(id, entry)
    this.paneActiveTab.set(scope, id)
    auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNewTab', target: 'about:blank', decision: 'allowed' })
    return entry
  }

  /** Apply the pane snapshot to the native dock. Folding (no tabs, not on
   *  the chat view, or the workbench showing a non-browser tab — W3) keeps
   *  tabs alive — bounds go zero, nothing is destroyed. */
  private syncPane(): void {
    const { viewKind, conversationId } = this.paneState
    const browserActive = this.paneState.browserActive !== false
    const scope = viewKind === 'chat' ? conversationId : null
    appViewDock.setWidth(this.resolvePaneWidth())
    const active = browserActive && scope ? this.activePaneEntry(scope) : null
    // T4.3: a never-navigated tab (''/about:blank) shows the renderer's empty
    // state instead of a white native page — fold exactly like "no tab"; the
    // tab itself stays alive and listed (折叠保留语义不变).
    const fresh = active ? this.activeFresh() : null
    this.lastShownFresh = fresh
    const view = active ? this.viewOfTab(active.id) : null
    appViewDock.show(view && fresh === false ? view : null)
    appViewDock.setVisible(Boolean(active) && fresh === false)
    this.pushPaneUpdates(true)
  }

  /** The freshness of the pane's active tab (false = a real page is showing),
   *  or null when there is no active tab. One read shared by syncPane and the
   *  activity hook — a second copy could fold one side while the other shows
   *  a page. */
  private activeFresh(): boolean | null {
    const { viewKind, conversationId } = this.paneState
    const browserActive = this.paneState.browserActive !== false
    const scope = viewKind === 'chat' ? conversationId : null
    const active = browserActive && scope ? this.activePaneEntry(scope) : null
    if (!active) return null
    const view = this.viewOfTab(active.id)
    return !view || isFreshTabUrl(view.webContents.getURL() ?? '')
  }

  /** Freshness at last syncPane — the fold-flip detector below compares
   *  against it so only the transition pushes immediately. */
  private lastShownFresh: boolean | null = null

  /** AppViewBackend activity hook (wired in backendFor): agent-driven
   *  navigations bypass handlePaneAction (executeCommand never syncs), so the
   *  backend's activity event is the only signal that a folded fresh tab has
   *  gained a real URL — that transition must lift the fold at once. Every
   *  other activity stays on the throttled push (T1.3). */
  handleTabActivity(): void {
    const fresh = this.activeFresh()
    if (fresh === null || fresh !== this.lastShownFresh) this.syncPane()
    else this.pushPaneUpdates()
  }

  /** The last pane update actually sent — content-equality gate below. */
  private lastPanePush: BrowserPaneUpdate | null = null

  /** Trailing ~64ms coalescing for activity-driven pushes (PLAN
   *  PLAN-browser-pane-ux T1.3): a loading page emits an event storm and each
   *  event used to ship a full tabs snapshot, re-rendering the chrome once per
   *  event on top of the round-trip lag. User-action paths pass `immediate` —
   *  a click must not wait for the trailing edge. */
  private panePushTimer: ReturnType<typeof setTimeout> | null = null

  private pushPaneUpdates(immediate = false): void {
    if (immediate) {
      if (this.panePushTimer) {
        clearTimeout(this.panePushTimer)
        this.panePushTimer = null
      }
      this.doPushPaneUpdates()
      return
    }
    if (this.panePushTimer) return
    this.panePushTimer = setTimeout(() => {
      this.panePushTimer = null
      this.doPushPaneUpdates()
    }, 64)
  }

  private doPushPaneUpdates(): void {
    const target = this.paneSender ?? appViewDock.getWindow()?.webContents
    if (!target || target.isDestroyed()) return
    const { viewKind, conversationId } = this.paneState
    const scope = viewKind === 'chat' ? conversationId : null
    const entries = this.paneScopeEntries(scope)
    const activeId = scope ? (this.activePaneEntry(scope)?.id ?? null) : null
    const tabs: PaneTabInfo[] = entries.map((entry) => ({
      id: entry.id,
      url: this.viewOfTab(entry.id)?.webContents.getURL() ?? '',
      title: this.viewOfTab(entry.id)?.webContents.getTitle() ?? '',
      active: entry.id === activeId,
    }))
    const update: BrowserPaneUpdate = {
      visible: viewKind === 'chat' && entries.length > 0,
      width: this.resolvePaneWidth(),
      conversationId: scope,
      tabs,
    }
    // Second line of defense against a render↔main loop: callers push on
    // every width write and tab activity without checking for change, and a
    // new update object re-renders the whole ChatView. Nothing changed → say
    // nothing (a title/url polling delta is the renderer's own refresh path,
    // not this push's job).
    if (paneUpdateEquals(update, this.lastPanePush)) return
    this.lastPanePush = update
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
          ? auditPreview(cmd.expression)
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

/** Audit preview for an `evaluate` payload. It runs BEFORE the command, so it
 *  must accept whatever the kernel handed over: a source string (the common
 *  case) or a function (Playwright calls it in the page — `() => document.title`
 *  is the idiom a model reaches for first). Calling `.slice` on the latter
 *  threw `e.expression.slice is not a function` and killed the whole call
 *  before Playwright ever saw it. */
function auditPreview(expression: PageExpression): string {
  const text = typeof expression === 'string' ? expression : typeof expression === 'function' ? expression.toString() : String(expression)
  return text.slice(0, 120)
}

/** Field equality over the small pane-update payload — no dependency, no
 *  serialization. Title/url can lag a page's own mutation until the backend
 *  reports activity; that freshness rides onTabActivity, not this gate. */
function paneUpdateEquals(a: BrowserPaneUpdate, b: BrowserPaneUpdate | null): boolean {
  if (!b) return false
  if (a.visible !== b.visible || a.width !== b.width || a.conversationId !== b.conversationId) return false
  if (a.tabs.length !== b.tabs.length) return false
  return a.tabs.every((t, i) => {
    const o = b.tabs[i]
    return t.id === o.id && t.url === o.url && t.title === o.title && t.active === o.active
  })
}
