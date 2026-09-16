// ── App-view dock (A-M5) ──
// Single-slot host for the in-app browser pane: at most ONE WebContentsView
// (the active tab of the active conversation) is attached at the right edge;
// folding is zero bounds, never destruction — tabs and running agent tasks
// survive panel switches (decision 2026-09-13: 折叠保留). The chrome (tab
// strip + address bar) is renderer DOM; this side only positions the native
// WebView below it, using the shared 16:9 layout math.

import { BrowserWindow, WebContentsView } from 'electron'
import { TITLE_BAR_HEIGHT } from '../../shared/window-chrome'
import { webviewBox, zoomForWidth } from '../../shared/browser/pane'

class AppViewDock {
  private window: BrowserWindow | null = null
  private attached: WebContentsView | null = null
  private width = 380
  private visible = false

  attach(win: BrowserWindow): void {
    if (this.window === win) return
    this.window = win
    win.on('resize', () => this.layout())
    win.on('closed', () => {
      this.window = null
      this.attached = null
    })
  }

  getWindow(): BrowserWindow | null {
    return this.window
  }

  /** Swap the visible tab (null = nothing to show for this scope). */
  show(view: WebContentsView | null): void {
    if (this.attached === view) {
      this.layout()
      return
    }
    if (this.attached) this.window?.contentView.removeChildView(this.attached)
    this.attached = view
    if (this.attached) this.window?.contentView.addChildView(this.attached)
    this.layout()
  }

  /** Detach a view that is being destroyed (no-op unless it is the shown one). */
  detach(view: WebContentsView): void {
    if (this.attached !== view) return
    this.attached = null
    this.window?.contentView.removeChildView(view)
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

  private layout(): void {
    const win = this.window
    if (!win) return
    if (!this.visible || !this.attached || this.width <= 0) {
      this.attached?.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const [w, h] = win.getContentSize()
    const box = webviewBox(this.width, TITLE_BAR_HEIGHT, Math.max(0, h - TITLE_BAR_HEIGHT))
    // webviewBox's x is pane-relative (inset past the DOM-drawn divider); the
    // pane spans the rightmost `width` px of the content area.
    box.x = Math.max(0, w - this.width) + box.x
    this.attached.setBounds(box)
    // Pages lay out at the design width and scale down to fit the 16:9 box —
    // the whole page stays visible (等比缩放) instead of cropping a 1:1 render.
    this.attached.webContents.setZoomFactor(zoomForWidth(this.width))
  }
}

export const appViewDock = new AppViewDock()
