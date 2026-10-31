// ── App-view dock (A-M5; per-window registry since PLAN-popout-browser-pane
// 2026-10-31) ──
// Host for the in-app browser pane's native WebContentsViews: every pane tab
// view is attached ONCE on first show and then stays mounted (PLAN T1.2 —
// remove/add throws away the compositor surface and forces a full
// recomposite, which was the visible part of 「页签慢、网页快」). Switching the
// visible tab is a bounds write: the active view gets the webview box, every
// other mounted view goes 0×0 (zero-size views are not painted), so at most
// one view is ever non-zero-sized and there is no z-order question. Folding
// is zero bounds, never destruction — tabs and running agent tasks survive
// panel switches (decision 2026-09-13: 折叠保留); `detach` is the destroy
// path only. The chrome (tab strip + address bar) is renderer DOM; this side
// only positions the native WebView below it, using the shared 16:9 layout.
//
// ONE DOCK PER WINDOW (user ruling 2026-10-30: the popout window carries the
// browser pane too). The exported `appViewDock` is a REGISTRY over per-window
// dock instances, not a single slot: each window (main + conversation popouts)
// docks the tabs of the conversation IT shows, and the watch-guard chain
// (popout 置前守卫 / ⑦退 welcome / secondaryWatch) keeps one conversation in
// one window — so two windows' panes never contend for a view and can be up
// at the same time. Tab views are re-parentable across docks; `show` steals a
// view from another dock first (belt-and-suspenders for the watch race).
// Project windows stay excluded — their workbench is hidden entirely.

import { BrowserWindow, WebContentsView } from 'electron'
import { TITLE_BAR_HEIGHT } from '../../shared/window-chrome'
import { PANE_CHROME_HEIGHT, webviewBox, zoomForWidth } from '../../shared/browser/pane'

class AppViewDock {
  private window: BrowserWindow | null = null
  /** Views currently attached to the contentView (persistent mounting). */
  private mounted = new Set<WebContentsView>()
  private attached: WebContentsView | null = null
  private width = 380
  private visible = false
  /** Extra px the chrome's floating overlay (suggestion dropdown) needs —
   *  the webview shifts down while it is open (T3.5), because a
   *  WebContentsView paints above all DOM. */
  private chromeOverlay = 0
  // 沉浸窗口几何补偿（2026-10-31）：右卡是圆角卡片 + 顶部面板切换器行，原生
  // view 要收进卡的内容盒。缺省全 0 = 主窗/popout 的旧几何逐字节不变。
  private topInset = 0
  private rightInset = 0
  private bottomInset = 0

  attach(win: BrowserWindow): void {
    if (this.window === win) return
    this.window = win
    win.on('resize', () => this.layout())
    win.on('closed', () => {
      this.window = null
      this.attached = null
      this.mounted.clear()
    })
  }

  getWindow(): BrowserWindow | null {
    return this.window
  }

  isLive(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  /** Whether this dock currently holds `view` (mounted or visible) — the
   *  registry's holder lookup for view-routed detach/zoom re-stamps. */
  hasView(view: WebContentsView): boolean {
    return this.mounted.has(view) || this.attached === view
  }

  /** Make `view` the visible tab (null = nothing to show for this scope).
   *  First sighting mounts it; every switch after that is bounds-only. */
  show(view: WebContentsView | null): void {
    if (this.attached === view) {
      this.layout()
      return
    }
    this.attached = view
    if (view && !this.mounted.has(view)) {
      this.window?.contentView.addChildView(view)
      this.mounted.add(view)
    }
    this.layout()
  }

  /** Detach a view that is being destroyed — or being re-parented to another
   *  window's dock (the registry's `show` steals through here). */
  detach(view: WebContentsView): void {
    if (this.mounted.delete(view)) {
      this.window?.contentView.removeChildView(view)
    }
    if (this.attached === view) this.attached = null
    this.layout()
  }

  setWidth(px: number): void {
    const next = Math.max(0, Math.round(px))
    if (next === this.width) return
    this.width = next
    this.layout()
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.layout()
  }

  setChromeOverlay(px: number): void {
    const next = Math.max(0, Math.round(px))
    if (next === this.chromeOverlay) return
    this.chromeOverlay = next
    this.layout()
  }

  /** 沉浸窗口的卡片几何（2026-10-31）：原生 view 收进右卡内容盒所需的三向
   *  inset，随 pane 状态推送更新。任一变化即重排。 */
  setInsets(top: number, right: number, bottom: number): void {
    const t = Math.max(0, Math.round(top))
    const r = Math.max(0, Math.round(right))
    const b = Math.max(0, Math.round(bottom))
    if (t === this.topInset && r === this.rightInset && b === this.bottomInset) return
    this.topInset = t
    this.rightInset = r
    this.bottomInset = b
    this.layout()
  }

  /** Re-apply the pane-width zoom to `view` — the did-navigate hook. Chromium
   *  loads each navigation at the target host's OWN persisted zoom level, so
   *  without a re-stamp a new page renders at the previous host's scale (or
   *  1.0) until the next layout event. No-op unless the view is the visible
   *  one: hidden views are 0×0 and get stamped by layout() when shown. */
  restampZoom(view: WebContentsView): void {
    if (this.visible && this.attached === view && this.width > 0) {
      view.webContents.setZoomFactor(zoomForWidth(this.width))
    }
  }

  private layout(): void {
    const win = this.window
    if (!win) return
    const showBox = this.visible && this.attached !== null && this.width > 0
    if (showBox && this.attached) {
      const [w, h] = win.getContentSize()
      const paneTop = TITLE_BAR_HEIGHT + this.topInset
      const paneHeight = Math.max(0, h - paneTop - this.bottomInset)
      const box = webviewBox(this.width, paneTop, paneHeight, PANE_CHROME_HEIGHT + this.chromeOverlay)
      // webviewBox's x is pane-relative (inset past the DOM-drawn divider); the
      // pane spans the rightmost `width` px of the content area — pulled in by
      // rightInset for the immersive card (its border is absorbed by
      // webviewBox's own 2px left inset and 1px right gap).
      box.x = Math.max(0, w - this.width - this.rightInset) + box.x
      this.attached.setBounds(box)
      // Pages lay out at the design width and scale down to fit the 16:9 box —
      // the whole page stays visible (等比缩放) instead of cropping a 1:1 render.
      this.attached.webContents.setZoomFactor(zoomForWidth(this.width))
    }
    // Everyone but the active view idles at 0×0; folded = active bounds zero.
    for (const view of this.mounted) {
      if (showBox && view === this.attached) continue
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }
}

/**
 * The per-window registry exported as `appViewDock`. Callers that act on "the
 * window" keep their shape (`attach(win)`, and AppViewBackend's
 * `detach(view)` / `restampZoom(view)` route to whichever dock holds the
 * view); BrowserService's per-window pane flow addresses a specific window
 * via `dockFor`.
 */
class AppViewDockRegistry {
  private docks = new Map<number, AppViewDock>()

  /** Idempotent. Registers the window's dock (resize/closed listeners ride
   *  inside). The main window attaches at createWindow; a popout attaches on
   *  its first pane-state push. */
  attach(win: BrowserWindow): void {
    this.dockFor(win)
  }

  dockFor(win: BrowserWindow): AppViewDock {
    this.sweep()
    let dock = this.docks.get(win.id)
    if (!dock) {
      dock = new AppViewDock()
      dock.attach(win)
      this.docks.set(win.id, dock)
    }
    return dock
  }

  /** Make `view` the visible tab of `win`'s dock, re-parenting it away from
   *  any other dock first. Only ever fires on the watch-guard race (the same
   *  conversation momentarily claimed by two windows); the compositor-surface
   *  cost of a remove/add is the price of correctness there. */
  show(win: BrowserWindow, view: WebContentsView | null): void {
    if (view) {
      const holder = this.holderOf(view)
      const target = this.docks.get(win.id)
      if (holder && holder !== target) holder.detach(view)
    }
    this.dockFor(win).show(view)
  }

  setVisible(win: BrowserWindow, visible: boolean): void {
    this.dockFor(win).setVisible(visible)
  }

  setChromeOverlay(win: BrowserWindow, px: number): void {
    this.dockFor(win).setChromeOverlay(px)
  }

  /** 沉浸窗口的三向 inset（2026-10-31），按窗口路由。 */
  setInsets(win: BrowserWindow, top: number, right: number, bottom: number): void {
    this.dockFor(win).setInsets(top, right, bottom)
  }

  /** The view is being destroyed — drop it from whichever dock holds it. */
  detach(view: WebContentsView): void {
    this.holderOf(view)?.detach(view)
  }

  /** The did-navigate zoom re-stamp routes to the dock showing the view. */
  restampZoom(view: WebContentsView): void {
    this.holderOf(view)?.restampZoom(view)
  }

  /** Boot-race fallback: a browser tab created before ANY window pushed pane
   *  state still needs a push target (was: the main window's webContents). */
  anyLiveWindow(): BrowserWindow | null {
    this.sweep()
    for (const dock of this.docks.values()) {
      const win = dock.getWindow()
      if (win && !win.isDestroyed()) return win
    }
    return null
  }

  private holderOf(view: WebContentsView): AppViewDock | null {
    this.sweep()
    for (const dock of this.docks.values()) {
      if (dock.getWindow() && dock.hasView(view)) return dock
    }
    return null
  }

  /** destroy() does not emit 'closed', so a dead window can sit in the map —
   *  every access sweeps instead of trusting events. */
  private sweep(): void {
    for (const [id, dock] of this.docks) {
      const win = dock.getWindow()
      if (!win || win.isDestroyed()) this.docks.delete(id)
    }
  }
}

export const appViewDock = new AppViewDockRegistry()
export type { AppViewDock }
