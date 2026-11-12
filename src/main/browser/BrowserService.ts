// ── BrowserService (L0 host, A-M1) ──
// Singleton orchestrator: backend registry, tab registry, session-scope
// attribution and the single entry the kernel talks to (executeCommand).
// Policies enforced here, not in the facade: URL scheme whitelist (§6),
// per-conversation tab isolation, audit_log on every state-changing command.
// Registry + orchestration only (≤1000-line rule) — command execution lives
// in PlaywrightCommands, launching in the backend adapters.

import { prefixedId } from '../utils/id'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, shell, type WebContents, type WebContentsView } from 'electron'
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
  historyVisitFor,
  isFreshTabUrl,
  normalizeAddressBarInput,
  type BrowserPaneAction,
  type BrowserPaneState,
  type BrowserPaneUpdate,
  type PaneTabInfo,
  type WindowOpenRoute,
} from '../../shared/browser/pane'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { isSubpath, resolveTarget } from '../../shared/sandbox/path-jail'
import { resolveRealTarget } from '../sandbox/real-path'
import { normalizeUserPath } from '../sandbox/guard'
import { DATA_DIR, WORKSPACE_DIR } from '../storage'
import { resolveScreenshotSave, writeScreenshotFile } from './screenshot-save'
import { captureAppViewScreenshot } from './app-view-screenshot'
import { auditStore } from '../storage/audit-store'
import { browserHistoryStore } from '../storage/browser-history-store'
import { settingsStore } from '../storage/settings-store'
import { getConversationWorkspaceDir } from '../storage/conversation.db'
import type { BackendAdapter } from './backends/BackendAdapter'
import { ManagedBackend } from './backends/ManagedBackend'
import { AppViewBackend } from './backends/AppViewBackend'
import { appViewDock } from './app-view-dock'
import { readDevToolsPort } from './cdp-port'
import { runPlaywrightOp, runTabWait } from './PlaywrightCommands'
import { pulsemindReadText } from '../../shared/browser-client/read-text'
import { takeDomSnapshot } from './snapshot-refs'
import { browserFavoriteStore } from '../storage/browser-favorite-store'
import { runBrowserCode, type BrowserRunOutput } from './kernel'
import { safeExternalUrl } from '../utils/external-url'

/** Playwright ops that change page state — the audit-worthy subset. Real-input
 *  clicks/drags/keys and BOTH clipboard directions are in: the clipboard may
 *  hold the user's own copied secrets, so even `read` leaves an audit row.
 *  mouseMove/mouseWheel stay out — hover/scroll are navigation gestures, not
 *  state changes, and would flood the log. */
const MUTATING_METHODS = new Set([
  'navigate',
  'back',
  'forward',
  'reload',
  'close',
  'evaluate',
  'newTab',
  'playwright',
  'setActiveBackend',
  'claimTab',
  'mouseClick',
  'mouseDown',
  'mouseUp',
  'mouseDrag',
  'keyboardPress',
  'keyboardType',
  'keyboardDown',
  'keyboardUp',
  'clipboardRead',
  'clipboardWrite',
])

/** Page-initiated popup flood gates (review_20260929 中8): every window.open
 *  used to mint a real pane tab — backend.start + newTab + CDP polling each,
 *  on top of unbounded audit rows, history rows and a full pane push — so one
 *  hostile page (or an agent loop stuck on a popup site) could spin tabs
 *  without limit. Cap per scope, throttle per scope, merge a same-URL popup
 *  already in flight; a denied popup leaves an audit row, not a tab. User
 *  gestures ("+" button, address bar) are deliberately NOT gated. The cap
 *  counts the POPUP-minted tabs of a scope (review_20260930 中8) — the flood
 *  channel the gate exists for — never the user's own tabs: a scope where the
 *  user opened 12 tabs themselves must not deny every later popup (including
 *  their own target=_blank clicks) silently. */
const POPUP_TABS_PER_SCOPE = 12
const POPUP_MIN_INTERVAL_MS = 1000

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
  /** Persisted pane width (settings.browser.paneWidth); null = never dragged. */
  private paneWidth: number | null = null
  /** The user's selected tab per conversation inside the pane. */
  private paneActiveTab = new Map<string, string>()

  /** ── Per-window pane registry (PLAN-popout-browser-pane 2026-10-31) ──
   *  Every window (main + conversation popouts) drives its own pane: its own
   *  "what am I showing" state, its own push target, its own dock. One
   *  conversation lives in one window (the watch-guard chain), so each
   *  window's pane scopes to a DIFFERENT tab set and two windows' panes can
   *  be up at the same time. Project windows never register (their
   *  workbench is hidden — the renderer gates the push). */
  private paneWindows = new Map<number, { state: BrowserPaneState; sender: WebContents; win: BrowserWindow }>()

  /** Which window is this sender? The test seam: vitest has no real
   *  BrowserWindow (the electron stub answers fromWebContents with null), so
   *  tests override this to map fake senders onto fake windows. */
  private resolveWindow(sender: WebContents): BrowserWindow | null {
    return BrowserWindow.fromWebContents(sender)
  }

  /** Sender change invalidates ONLY that window's last push (review
   *  2026-09-18 M1, per window): a renderer reload creates a NEW WebContents
   *  whose store starts EMPTY — the paneUpdateEquals gate would swallow the
   *  identical re-push and the fresh renderer would learn nothing until a tab
   *  actually changed. */
  private dropPaneWindow(key: number): void {
    this.paneWindows.delete(key)
    this.lastPanePush.delete(key)
    this.lastShownFresh.delete(key)
  }

  /** Dead windows/renderers leave the registry without trusting events —
   *  closeAllPopouts destroys via win.destroy(), which emits no 'closed'. */
  private prunePaneWindows(): void {
    for (const [key, entry] of this.paneWindows) {
      if (entry.win.isDestroyed() || (entry.sender.isDestroyed?.() ?? false)) this.dropPaneWindow(key)
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
    const win = this.resolveWindow(sender)
    if (!win) return
    appViewDock.attach(win)
    const key = win.id
    const prev = this.paneWindows.get(key)
    if (!prev || prev.sender !== sender) this.lastPanePush.delete(key)
    this.paneWindows.set(key, { state, sender, win })
    appViewDock.setChromeOverlay(win, state.chromeOverlayHeight ?? 0)
    // 浏览器主视图（PLAN-layout-modes）：chrome 基础行高随推送（主视图卡
    // 68，无工作台页签条）；缺省回落 PANE_CHROME_HEIGHT——侧栏/popout 推送
    // 不带该字段，dock 几何逐字节不变。
    appViewDock.setChromeBase(win, state.chromeHeight)
    // 浮窗让位（十三期）：侧边栏/dock 下拉浮窗右侵/左侵浏览器主卡时，渲染端
    // 量出的左右内收 px；缺省 0——无浮窗时 view 几何逐字节不变。
    appViewDock.setSideOverlays(win, state.leftOverlay ?? 0, state.rightOverlay ?? 0)
    // 沉浸窗口（2026-10-31）：三向卡片 inset 随 pane 状态推送更新——主窗与
    // popout 不带这些字段，全是 0，dock 几何逐字节不变。
    appViewDock.setInsets(win, state.topInset ?? 0, state.rightInset ?? 0, state.bottomInset ?? 0)
    this.syncPaneFor(key)
  }

  async handlePaneWidth(width: number, sender: WebContents): Promise<void> {
    const win = this.resolveWindow(sender)
    if (!win) return
    const entry = this.paneWindows.get(win.id)
    const clamped = clampPaneWidth(width, entry?.state.chatAreaWidth ?? 1300)
    if (clamped !== this.paneWidth) {
      this.paneWidth = clamped
      try {
        await settingsStore.update((s) => ({ ...s, browser: { ...s.browser, paneWidth: clamped } }))
      } catch {
        /* width stays session-only */
      }
    }
    // One persisted width, clamped per window against THAT window's chat area.
    // 沉浸窗口的 paneWidth 直通（2026-10-31）——面板占满右卡，不走 chatArea clamp。
    for (const e of this.paneWindows.values()) {
      appViewDock.dockFor(e.win).setWidth(e.state.paneWidth ?? this.resolvePaneWidthFor(e.state.chatAreaWidth))
    }
    this.pushPaneUpdates(true)
  }

  async handlePaneAction(action: BrowserPaneAction, sender: WebContents): Promise<void> {
    const win = this.resolveWindow(sender)
    if (!win) return
    const scope = this.paneWindows.get(win.id)?.state.conversationId ?? null
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
        await this.ensureLivePage(entry)
        auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNavigate', target: url, decision: 'allowed' })
        const beforeUrl = entry.tab.page.url()
        await entry.tab.page.goto(url, { waitUntil: 'commit', timeout: 20_000 }).catch(() => {})
        // History records MANUAL navigation only (裁定 L1 — the agent's
        // executeCommand('navigate') never reaches here; back/forward/reload
        // are not new destinations), and it records the address the USER
        // committed rather than the redirect chain's landing page (user
        // 2026-11-09：A 自动跳到 B、再点进 C，记录里只该有 A).
        const visit = historyVisitFor(url, beforeUrl, entry.tab.page.url(), await entry.tab.page.title().catch(() => ''))
        if (visit) browserHistoryStore.recordVisit(visit.url, visit.title)
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

  /** A page's window.open / target=_blank (AppViewBackend's
   *  setWindowOpenHandler denied the native window and routed the request
   *  here): http(s) becomes a pane tab of the OPENER's own conversation —
   *  same scope, same origin (an agent tab's popup stays jailed to the
   *  workspace for downloads) — and other schemes go through the OS gate.
   *  An opener that is already gone has nothing to attach the popup to. */
  handleWindowOpen(openerTabId: string, route: WindowOpenRoute): void {
    if (route.action === 'ignore') return
    const opener = this.tabs.get(openerTabId)
    if (!opener || opener.backendId !== 'app-view') return
    if (route.action === 'external') {
      const safe = safeExternalUrl(route.url, DATA_DIR)
      auditStore.record({
        scope: 'browser',
        actor: opener.scopeId,
        action: 'browser.paneOpenExternal',
        target: safe ?? route.url,
        decision: safe ? 'allowed' : 'denied',
      })
      if (safe) void shell.openExternal(safe)
      return
    }
    void this.openPopupTab(opener, route)
  }

  /** The tab side of handleWindowOpen, behind the popup flood gates: a
   *  per-scope tab cap, a per-scope minimum interval, and a same-URL merge
   *  for popups already being minted (review_20260929 中8). */
  private async openPopupTab(opener: ServiceTab, route: Extract<WindowOpenRoute, { action: 'tab' }>): Promise<void> {
    let target: string
    try {
      target = assertAllowedUrl(route.url)
    } catch {
      return // routeWindowOpen only lets http(s) through; belt and braces
    }
    const scope = opener.scopeId
    const deny = (reason: string): void => {
      auditStore.record({ scope: 'browser', actor: scope, action: 'browser.panePopupTab', target, decision: 'denied' })
      console.warn(`[browser] popup tab denied (${reason}): ${target}`)
    }
    if (this.popupTabsInScope(scope) >= POPUP_TABS_PER_SCOPE) return deny('tab cap reached')
    // The same URL is already being minted into a tab → join it instead of
    // duplicating (a double-fired window.open is one navigation, not two tabs).
    const inFlightKey = `${scope}\u0000${target}`
    const inFlight = this.popupInFlight.get(inFlightKey)
    if (inFlight) return inFlight
    // The minimum interval is per scope+URL — the shape it exists for is a
    // page loop re-firing one URL (open → settle → open…); distinct-URL
    // bursts are the cap's job, not the throttle's, or legitimate
    // multi-link popups would drop (probe-pane-actions §11 opens two).
    const now = Date.now()
    if (now - (this.lastPopupAt.get(inFlightKey) ?? 0) < POPUP_MIN_INTERVAL_MS) return deny('rate limited')
    this.lastPopupAt.set(inFlightKey, now)
    const run = this.doOpenPopupTab(opener, target, route).finally(() => {
      this.popupInFlight.delete(inFlightKey)
    })
    this.popupInFlight.set(inFlightKey, run)
    return run
  }

  /** The mint itself. Same shape as the address bar's navigate —
   *  commit-or-give-up, remember the FINAL url — and history is written for
   *  USER tabs only (L1: the agent's moves write no history). */
  private async doOpenPopupTab(opener: ServiceTab, target: string, route: Extract<WindowOpenRoute, { action: 'tab' }>): Promise<void> {
    // NOT createUserPaneTab — its per-scope serialization exists so a second
    // "+" AWAITS the first tab rather than duplicating it, while a popup
    // always means a NEW tab; concurrent doCreatePaneTab calls are safe (the
    // registry write is synchronous once newTab resolves).
    const entry = await this.doCreatePaneTab(opener.scopeId, opener.origin)
    this.popupTabIds.add(entry.id)
    auditStore.record({ scope: 'browser', actor: opener.scopeId, action: 'browser.panePopupTab', target, decision: 'allowed' })
    const beforeUrl = entry.tab.page.url()
    // A form POST must not downgrade to GET in the reopened tab — SAML
    // HTTP-POST binding and gateway jumps land on 405s or broken flows when
    // it does. Playwright's goto has no method override, so the navigation
    // is rewritten through a one-shot route (the URL predicate keeps the
    // match exact).
    const post = route.postBody?.data ? route.postBody : null
    const postRoute = post ? (url: URL) => url.toString() === target : null
    if (post && postRoute) {
      let replayed = false
      await entry.tab.page.route(postRoute, async (r) => {
        // One-shot rewrite BY HAND, gated to the main-frame navigation: the
        // URL predicate alone also matches same-URL subresource/iframe
        // requests (Playwright routes them all), and Playwright's own
        // `times: 1` counts EVERY match — a subresource arriving before
        // goto would consume the rewrite (the navigation ships as GET), and
        // a goto whose URL normalization never matches would leave the
        // route armed to overwrite a LATER same-URL request with the stale
        // body (review_20260930 中9; a SAML one-time token would replay an
        // old assertion). Everything else passes through untouched.
        const req = r.request()
        if (replayed || !req.isNavigationRequest() || req.frame() !== entry.tab.page.mainFrame()) {
          await r.continue().catch(() => {})
          return
        }
        replayed = true
        // request().headers() is async (Playwright) — spread it AWAITED or
        // the override ships with no cookies/user-agent and SSO breaks.
        await r
          .continue({
            method: 'POST',
            headers: {
              ...(await r.request().headers()),
              'content-type': post.contentType || 'application/x-www-form-urlencoded',
              'content-length': String(new TextEncoder().encode(post.data).length),
            },
            postData: post.data,
          })
          .catch(() => {})
      })
    }
    try {
      await entry.tab.page
        .goto(target, {
          waitUntil: 'commit',
          timeout: 20_000,
          ...(route.referrer ? { referrer: route.referrer } : {}),
        })
        .catch(() => {})
    } finally {
      // The rewrite never outlives this mint: a route left armed by a
      // failed or never-matching goto would keep rewriting later same-URL
      // requests with the stale body — the review's case (b).
      if (postRoute) await entry.tab.page.unroute(postRoute).catch(() => {})
    }
    const finalUrl = entry.tab.page.url()
    if (opener.origin === 'user') {
      // 与地址栏同一把尺：记 window.open 的发起地址 target，不记它的跳转落点。
      const visit = historyVisitFor(target, beforeUrl, finalUrl, await entry.tab.page.title().catch(() => ''))
      if (visit) browserHistoryStore.recordVisit(visit.url, visit.title)
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
          // 认领即落前台：返回的 Tab 句柄指向的视图必须真的有视口，
          // 否则第一次交互就是 0×0 超时（2026-11-13 实测）。
          this.paneActiveTab.set(scopeId, entry.id)
          this.syncPane()
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
            const message = err instanceof Error ? err.message : String(err)
            // 只有真的存满才是 FAVORITE_LIMIT——类型/规范化错误归 INVALID_PARAMS，
            // 别把「参数写错」标成「收藏已满」（2026-11-13 实测误导排查方向）。
            return browserError(/收藏已满/.test(message) ? 'FAVORITE_LIMIT' : 'INVALID_PARAMS', message)
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
          // agent 新建的标签页落前台（2026-11-13 实测：不切前台就是 0×0 视口，
          // 第一次交互必然可见性超时）：open() 的复用路径由 prepareInteraction
          // 的 navigate 激活兜住，新建路径在这里直接落。
          this.paneActiveTab.set(scopeId, id)
          this.syncPane()
          return browserOk(await this.tabInfo(this.tabs.get(id)!))
        }
        // System clipboard, main-process side — the read-back channel canvas
        // apps need (select → Control+c → read the TSV they produced).
        case 'clipboardRead':
          return browserOk(clipboard.readText())
        case 'clipboardWrite':
          clipboard.writeText(cmd.text)
          return browserOk()
        default:
          break
      }
      // Tab-carrying commands from here on; the `in` guard narrows the union.
      if (!('tabId' in cmd)) return browserError('UNKNOWN_METHOD', `命令缺少 tabId：${(cmd as { method: string }).method}`)
      const entry = this.resolveTab(cmd.tabId, scopeId)
      // close 对 app-view 是纯 Electron 侧操作（dock detach + webContents.close），
      // 不需要活 CDP 句柄——跳过探活，CDP 空闲重连的竞态不再把关闭卡成
      // 「首次报错、重试才成功」（2026-11-13 四轮实测的稳定性抖动就在这层）。
      if (cmd.method !== 'close') await this.ensureLivePage(entry)
      await this.prepareInteraction(entry, scopeId, cmd)
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
          // App-view pages are laid out at the 1280 design width and shrunk by
          // page zoom; Playwright's CDP screenshot mixes the zoomed layout
          // viewport with CSS-sized clips and returns a mostly-white canvas
          // (2026-11-11 「截图有问题」). That path captures in document DIP —
          // see app-view-screenshot.ts. Managed pages have no zoom and keep
          // Playwright's own screenshot.
          let buffer: Buffer
          if (entry.backendId === 'app-view') {
            const view = this.viewOfTab(entry.id)
            if (!view || view.webContents.isDestroyed()) {
              throw new Error('截图失败：应用窗格标签页已关闭')
            }
            buffer = await captureAppViewScreenshot(page, {
              zoom: view.webContents.getZoomFactor(),
              selector: cmd.selector,
              fullPage: cmd.fullPage,
            })
          } else {
            buffer = cmd.selector
              ? await page.locator(cmd.selector).screenshot()
              : await page.screenshot({ fullPage: cmd.fullPage })
          }
          const shot: { mime: string; base64: string; path?: string } = {
            mime: 'image/png',
            base64: buffer.toString('base64'),
          }
          // `save` writes a real file so the user can get the screenshot out of
          // the app (the inline image is display-only). ANY destination is
          // accepted: `~/…` and absolute paths go where they say, relative
          // paths start from Downloads, and the token spellings
          // (`desktop/名称.png` …) resolve through app.getPath so one string
          // means the same thing on macOS, Windows and Linux. Missing folders
          // are created; the app's own data dir is the one carve-out, and an
          // existing file is never overwritten (writeScreenshotFile).
          if (cmd.save) {
            const dirs = {
              home: app.getPath('home'),
              downloads: app.getPath('downloads'),
              desktop: app.getPath('desktop'),
              documents: app.getPath('documents'),
              pictures: app.getPath('pictures'),
            }
            const dest = resolveScreenshotSave(cmd.save, {
              dirs,
              protectedRoots: [DATA_DIR],
              // 工作区在数据目录里（~/.pulsemind/workspace）而沙箱又要求任务
              // 文件落工作区——allowedRoots 放行工作区子树，其余数据目录照旧
              // 拒绝（2026-11-13 实测两条规则正面相撞）。
              allowedRoots: [getConversationWorkspaceDir(scopeId) ?? WORKSPACE_DIR],
            })
            try {
              await mkdir(dest.dir, { recursive: true })
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err)
              throw new Error(`截图失败：无法创建保存目录 ${dest.dir}：${reason}`)
            }
            shot.path = await writeScreenshotFile(dest, buffer)
          }
          return browserOk(shot)
        }
        case 'evaluate':
          return browserOk(await page.evaluate(cmd.expression))
        case 'readText':
          // pulsemindReadText 自包含（无 import/闭包），整体序列化进页面跑。
          return browserOk(
            await page.evaluate(pulsemindReadText, { selector: cmd.selector, budget: cmd.budget, offset: cmd.offset }),
          )
        case 'waitFor':
          return browserOk(await runTabWait(page, cmd))
        case 'playwright': {
          // setInputFiles uploads local files into a page — jail them to the
          // conversation's workspace so a page can't exfiltrate arbitrary
          // paths (full_20261011 M10-P1-1): the old gate judged with
          // operation:'read', which the jail answers "inside workspace =
          // allowed" for — i.e. no workspace containment at all — and was
          // SKIPPED ENTIRELY when the conversation had no workspace
          // (fail-open). Now: explicit fail-closed subpath check on BOTH the
          // lexical and the realpath coordinate, workspace required.
          if (cmd.op === 'setInputFiles') {
            const wsDir = getConversationWorkspaceDir(scopeId)
            if (!wsDir) return browserError('PATH_DENIED', '文件上传被拒绝：当前会话没有工作区')
            const arg = String(cmd.arg ?? '')
            const target = normalizeUserPath(arg)
            const lexical = resolveTarget(wsDir, target)
            const real = await resolveRealTarget(lexical)
            if (real.status === 'unresolvable') return browserError('PATH_DENIED', '文件上传被拒绝：路径无法解析')
            const wsReal = await resolveRealTarget(wsDir)
            const inside = isSubpath(wsDir, lexical) || (wsReal.status === 'resolved' && isSubpath(wsReal.path, real.path))
            if (!inside) return browserError('PATH_DENIED', '文件上传被拒绝：只能上传当前会话工作区内的文件')
          }
          return browserOk(
            await runPlaywrightOp(page, { selector: cmd.selector, op: cmd.op, arg: cmd.arg, timeoutMs: cmd.timeoutMs }, entry.lastSnapshot?.tree ?? null),
          )
        }
        case 'playwrightWaitForTimeout':
          await page.waitForTimeout(Math.min(Math.max(cmd.ms, 0), 30_000))
          return browserOk()
        // ── Real input (canvas apps): page.mouse/keyboard dispatch TRUSTED
        // events over the same CDP transport both backends use — no Electron
        // sendInputEvent needed. Coordinates are the caller's duty (DOM
        // anchors); these ops carry no locator safety net by design.
        case 'mouseClick':
          await page.mouse.click(cmd.x, cmd.y, {
            button: cmd.button,
            clickCount: cmd.clickCount,
            delay: cmd.delayMs,
          })
          return browserOk()
        case 'mouseMove':
          await page.mouse.move(cmd.x, cmd.y)
          return browserOk()
        case 'mouseDown':
          await page.mouse.down({ button: cmd.button })
          return browserOk()
        case 'mouseUp':
          await page.mouse.up({ button: cmd.button })
          return browserOk()
        case 'mouseWheel':
          await page.mouse.wheel(cmd.deltaX, cmd.deltaY)
          return browserOk()
        case 'mouseDrag': {
          const steps = Math.min(Math.max(cmd.steps ?? 8, 2), 100)
          await page.mouse.move(cmd.fromX, cmd.fromY)
          await page.mouse.down()
          await page.mouse.move(cmd.toX, cmd.toY, { steps })
          await page.mouse.up()
          return browserOk()
        }
        case 'keyboardPress':
          await page.keyboard.press(cmd.key, { delay: cmd.delayMs })
          return browserOk()
        case 'keyboardType':
          await page.keyboard.type(cmd.text, { delay: cmd.delayMs })
          return browserOk()
        case 'keyboardDown':
          await page.keyboard.down(cmd.key)
          return browserOk()
        case 'keyboardUp':
          await page.keyboard.up(cmd.key)
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
        appView.onWindowOpen = (tabId, route) => this.handleWindowOpen(tabId, route)
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

  /** The page this conversation's own browser pane is showing, for the state
   *  block's `## Current Page` section (2026-11-04, user ruling: 带上、只放
   *  最简信息). Two facts only — url + title — because the section is rebuilt
   *  on EVERY tool-loop iteration and the model can read the rest itself with
   *  the `browser` tool.
   *
   *  Source = the active pane tab (what the user would see if the pane were
   *  unfolded), falling back to the newest tab that holds a real page: a scope
   *  whose active tab is still `about:blank` must not report nothing while a
   *  sibling tab shows something. No visible-window/scope check — the tab
   *  belongs to this conversation whether or not the pane is currently
   *  unfolded, and the section is worded for exactly that ("has this page
   *  open", not "you are looking at it").
   *
   *  Never throws into the prompt path: a destroyed view or a torn-down
   *  backend just means "no page". */
  currentPageOf(scope: string | null): { url: string; title: string } | null {
    if (!scope) return null
    const read = (tab: ServiceTab): { url: string; title: string } | null => {
      try {
        const view = this.viewOfTab(tab.id)
        if (!view || view.webContents.isDestroyed()) return null
        const url = view.webContents.getURL() ?? ''
        if (!url || isFreshTabUrl(url)) return null
        return { url, title: view.webContents.getTitle() ?? '' }
      } catch {
        return null
      }
    }
    const active = this.activePaneEntry(scope)
    const fromActive = active ? read(active) : null
    if (fromActive) return fromActive
    const entries = this.paneScopeEntries(scope)
    for (let i = entries.length - 1; i >= 0; i--) {
      const hit = read(entries[i])
      if (hit) return hit
    }
    return null
  }

  private async listTabs(scopeId: string): Promise<BrowserTabInfo[]> {
    const scopeTabs = [...this.tabs.values()].filter((t) => t.scopeId === scopeId)
    return Promise.all(scopeTabs.map(async (t) => ({ id: t.id, url: t.tab.page.url(), title: await t.tab.page.title().catch(() => '') })))
  }

  /** ── pane internals (A-M5) ── */

  /** The pane width in force for a window showing a chat area of
   *  `chatAreaWidth` px: the persisted pick, clamped against that window (two
   *  windows have different chat areas; the same drag feeds both). */
  private resolvePaneWidthFor(chatAreaWidth: number): number {
    return clampPaneWidth(this.paneWidth ?? defaultPaneWidth(chatAreaWidth), chatAreaWidth)
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

  /** Popup flood-gate state (review_20260929 中8): one in-flight mint per
   *  scope+URL (same-URL popups merge into it), and the last minted-at time
   *  per scope+URL for the same-URL minimum-interval throttle. popupTabIds
   *  remembers the tabs POPUPS minted — the population POPUP_TABS_PER_SCOPE
   *  caps (review_20260930 中8): counting every app-view tab made the user's
   *  own "+" tabs spend the popup budget. */
  private popupInFlight = new Map<string, Promise<void>>()
  private lastPopupAt = new Map<string, number>()
  private popupTabIds = new Set<string>()

  /** The scope's popup-minted tab count — what the cap is about. */
  private popupTabsInScope(scope: string): number {
    let n = 0
    for (const t of this.paneScopeEntries(scope)) if (this.popupTabIds.has(t.id)) n++
    return n
  }

  private createUserPaneTab(scope: string): Promise<ServiceTab> {
    const inFlight = this.paneTabCreation.get(scope)
    if (inFlight) return inFlight
    const created = this.doCreatePaneTab(scope, 'user').finally(() => {
      this.paneTabCreation.delete(scope)
    })
    this.paneTabCreation.set(scope, created)
    return created
  }

  private async doCreatePaneTab(scope: string, origin: ServiceTab['origin']): Promise<ServiceTab> {
    const backend = this.backendFor('app-view') as AppViewBackend
    await backend.start()
    const id = prefixedId('tab')
    const created = await backend.newTab({ tabId: id, origin, scopeId: scope })
    const entry: ServiceTab = { id, backendId: 'app-view', scopeId: scope, origin, createdAt: new Date().toISOString(), tab: created }
    this.tabs.set(id, entry)
    this.paneActiveTab.set(scope, id)
    auditStore.record({ scope: 'browser', actor: scope, action: 'browser.paneNewTab', target: 'about:blank', decision: 'allowed' })
    return entry
  }

  /** Apply the pane snapshot to EVERY registered window's dock. Folding (no
   *  tabs, not on the chat view, or the workbench showing a non-browser tab —
   *  W3) keeps tabs alive — bounds go zero, nothing is destroyed. */
  private syncPane(): void {
    this.prunePaneWindows()
    for (const key of [...this.paneWindows.keys()]) this.syncPaneFor(key)
  }

  /** The per-window half: dock + fold for ONE window's own scope. */
  private syncPaneFor(key: number): void {
    const entry = this.paneWindows.get(key)
    if (!entry) return
    if (entry.win.isDestroyed() || (entry.sender.isDestroyed?.() ?? false)) {
      this.dropPaneWindow(key)
      return
    }
    const { viewKind, conversationId } = entry.state
    const browserActive = entry.state.browserActive !== false
    const scope = viewKind === 'chat' ? conversationId : null
    const dock = appViewDock.dockFor(entry.win)
    dock.setWidth(entry.state.paneWidth ?? this.resolvePaneWidthFor(entry.state.chatAreaWidth))
    const active = browserActive && scope ? this.activePaneEntry(scope) : null
    // T4.3: a never-navigated tab (''/about:blank) shows the renderer's empty
    // state instead of a white native page — fold exactly like "no tab"; the
    // tab itself stays alive and listed (折叠保留语义不变).
    const fresh = this.freshnessOf(active)
    this.lastShownFresh.set(key, fresh)
    const view = active ? this.viewOfTab(active.id) : null
    appViewDock.show(entry.win, view && fresh === false ? view : null)
    dock.setVisible(Boolean(active) && fresh === false)
    this.pushPaneUpdates(true)
  }

  /** The freshness of a pane's active tab (false = a real page is showing),
   *  or null when there is no active tab. */
  private freshnessOf(active: ServiceTab | null): boolean | null {
    if (!active) return null
    const view = this.viewOfTab(active.id)
    return !view || isFreshTabUrl(view.webContents.getURL() ?? '')
  }

  /** Freshness at last syncPane, per window — the fold-flip detector below
   *  compares against it so only the transition pushes immediately. */
  private lastShownFresh = new Map<number, boolean | null>()

  /** AppViewBackend activity hook (wired in backendFor): agent-driven
   *  navigations bypass handlePaneAction (executeCommand never syncs), so the
   *  backend's activity event is the only signal that a folded fresh tab has
   *  gained a real URL — that transition must lift the fold at once. Every
   *  other activity stays on the throttled push (T1.3). */
  handleTabActivity(): void {
    this.prunePaneWindows()
    let flipped = false
    for (const [key, entry] of this.paneWindows) {
      const { viewKind, conversationId } = entry.state
      const browserActive = entry.state.browserActive !== false
      const scope = viewKind === 'chat' ? conversationId : null
      const fresh = browserActive && scope ? this.freshnessOf(this.activePaneEntry(scope)) : null
      if (fresh === null || fresh !== this.lastShownFresh.get(key)) {
        flipped = true
        break
      }
    }
    if (flipped) this.syncPane()
    else this.pushPaneUpdates()
  }

  /** The last pane update actually sent per window — content-equality gate
   *  below. Keyed by window id: each window's snapshot is its own. */
  private lastPanePush = new Map<number, BrowserPaneUpdate | null>()

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
    this.prunePaneWindows()
    if (this.paneWindows.size === 0) {
      // Boot-race fallback: a tab created before ANY window pushed pane state
      // still needs a push target (was: the main window's webContents). The
      // default scope is null — the moment the window's own state push lands,
      // its scoped snapshot replaces this.
      const fallback = appViewDock.anyLiveWindow()?.webContents
      if (!fallback || fallback.isDestroyed()) return
      const update: BrowserPaneUpdate = { visible: false, width: this.resolvePaneWidthFor(1300), conversationId: null, tabs: [] }
      if (!paneUpdateEquals(update, this.lastPanePush.get(-1) ?? null)) {
        this.lastPanePush.set(-1, update)
        fallback.send(IPC_CHANNELS.BROWSER_PANE_UPDATE, update)
      }
      return
    }
    for (const [key, entry] of this.paneWindows) {
      if (entry.sender.isDestroyed?.() ?? false) continue
      const { viewKind, conversationId } = entry.state
      const scope = viewKind === 'chat' ? conversationId : null
      const entries = this.paneScopeEntries(scope)
      const activeId = scope ? (this.activePaneEntry(scope)?.id ?? null) : null
      const tabs: PaneTabInfo[] = entries.map((tab) => ({
        id: tab.id,
        url: this.viewOfTab(tab.id)?.webContents.getURL() ?? '',
        title: this.viewOfTab(tab.id)?.webContents.getTitle() ?? '',
        active: tab.id === activeId,
      }))
      const update: BrowserPaneUpdate = {
        visible: viewKind === 'chat' && entries.length > 0,
        width: entry.state.paneWidth ?? this.resolvePaneWidthFor(entry.state.chatAreaWidth),
        conversationId: scope,
        tabs,
      }
      // Second line of defense against a render↔main loop: callers push on
      // every width write and tab activity without checking for change, and a
      // new update object re-renders the whole ChatView. Nothing changed → say
      // nothing (a title/url polling delta is the renderer's own refresh path,
      // not this push's job). Gated PER WINDOW — each window's snapshot is its
      // own, and one window's no-op must not swallow another's change.
      if (paneUpdateEquals(update, this.lastPanePush.get(key) ?? null)) continue
      this.lastPanePush.set(key, update)
      entry.sender.send(IPC_CHANNELS.BROWSER_PANE_UPDATE, update)
    }
  }

  private resolveTab(tabId: string, scopeId: string): ServiceTab {
    const entry = this.tabs.get(tabId)
    if (!entry) throw new Error(`Tab 不存在：${tabId}（用 tabs.list() 重新核对）`)
    if (entry.scopeId !== scopeId) throw new Error('Tab 不属于当前会话')
    return entry
  }

  /** CDP idle-disconnect recovery (2026-10-29 白屏根因): the app-view backend
   *  drops its connectOverCDP session after its idle timeout — a live session
   *  wedges the MAIN window's preview frames (the pane's html 预览 white-screens
   *  until restart) — which invalidates stored Page handles. Probe the handle;
   *  a dead one re-resolves through the backend's refreshTab. Alive pages pay
   *  one evaluate round-trip. */
  private async ensureLivePage(entry: ServiceTab): Promise<void> {
    const backend = this.backendFor(entry.backendId)
    if (!backend.refreshTab) return
    const alive = await entry.tab.page
      .evaluate(() => true)
      .then(() => true)
      .catch(() => false)
    if (alive) return
    entry.tab = await backend.refreshTab(entry.id)
  }

  /** 观察与交互都会碰页面几何的命令：把这些标签页切到窗格前台再执行。 */
  private static readonly FRONT_COMMANDS = new Set([
    'snapshot',
    'readText',
    'waitFor',
    'playwright',
    'screenshot',
    'navigate',
    'back',
    'forward',
    'reload',
    'mouseClick',
    'mouseMove',
    'mouseWheel',
    'mouseDown',
    'mouseUp',
    'mouseDrag',
    'keyboardPress',
    'keyboardType',
    'keyboardDown',
    'keyboardUp',
  ])
  /** 其中真正依赖可见视口的（可见性检查/截图/真实输入坐标）。waitFor 的
   *  selector 形态依赖（等元素可见），url/js/loadState 形态不依赖。 */
  private static readonly VIEWPORT_COMMANDS = new Set([
    'playwright',
    'screenshot',
    'waitFor',
    'mouseClick',
    'mouseMove',
    'mouseWheel',
    'mouseDown',
    'mouseUp',
    'mouseDrag',
    'keyboardPress',
    'keyboardType',
    'keyboardDown',
    'keyboardUp',
  ])

  /** 后台标签页 0×0（2026-11-13 四轮实测的阻断级问题）：dock 把非活跃视图
   *  压成 0×0（zero-size 不绘制），innerWidth/innerHeight 与一切元素矩形
   *  归零——可见性检查必然超时，而报错只说 Timeout，看不出这层原因。所以
   *  观察/交互命令先把该标签页切到窗格前台（激活即有视口）；纯信息命令
   *  （getState/evaluate/close/clipboard/list 类）不抢前台——evaluate 是
   *  模型探测「哪个标签页有视口」的通道，保持廉价。折叠兜底：窗格不在
   *  浏览器视图时连活跃视图也是 0×0——视口依赖命令快速失败并说明原因，
   *  不让模型拿 8s 超时瞎猜选择器。 */
  private async prepareInteraction(entry: ServiceTab, scopeId: string, cmd: BrowserCommand): Promise<void> {
    if (entry.backendId !== 'app-view') return
    if (!BrowserService.FRONT_COMMANDS.has(cmd.method)) return
    this.paneActiveTab.set(scopeId, entry.id)
    this.syncPane()
    const needsViewport =
      BrowserService.VIEWPORT_COMMANDS.has(cmd.method) &&
      !(cmd.method === 'waitFor' && (cmd as { selector?: string }).selector === undefined)
    if (!needsViewport) return
    const viewable = await entry.tab.page
      .evaluate(() => window.innerWidth > 0 && window.innerHeight > 0)
      .catch(() => true)
    if (!viewable) {
      throw new Error(
        '该标签页的视口为 0×0：浏览器窗格当前处于折叠状态（界面上没有显示浏览器面板），交互类命令需要可见视口。' +
          '请在应用里把面板切回浏览器页签后重试；只想读内容时可用 evaluate()（不依赖布局），导航类命令（navigate）也不受影响。',
      )
    }
  }

  private async tabInfo(entry: ServiceTab): Promise<BrowserTabInfo> {
    return { id: entry.id, url: entry.tab.page.url(), title: await entry.tab.page.title() }
  }

  private async closeTab(id: string): Promise<void> {
    const entry = this.tabs.get(id)
    if (!entry) return
    this.tabs.delete(id)
    this.popupTabIds.delete(id)
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
            : 'key' in cmd
              ? cmd.key
              : 'text' in cmd
                ? auditPreview(cmd.text)
                : 'x' in cmd
                  ? `${cmd.x},${cmd.y}`
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
