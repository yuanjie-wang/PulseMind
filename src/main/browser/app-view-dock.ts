// ── App-view dock (A-M5) ──
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

  /** Detach a view that is being destroyed (mounted or not). */
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

  private layout(): void {
    const win = this.window
    if (!win) return
    const showBox = this.visible && this.attached !== null && this.width > 0
    if (showBox && this.attached) {
      const [w, h] = win.getContentSize()
      const box = webviewBox(this.width, TITLE_BAR_HEIGHT, Math.max(0, h - TITLE_BAR_HEIGHT), PANE_CHROME_HEIGHT + this.chromeOverlay)
      // webviewBox's x is pane-relative (inset past the DOM-drawn divider); the
      // pane spans the rightmost `width` px of the content area.
      box.x = Math.max(0, w - this.width) + box.x
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

export const appViewDock = new AppViewDock()
