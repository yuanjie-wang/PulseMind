// ── App-view dock (A-M3) ──
// Hosts the browser pane: a stack of WebContentsViews docked to the right
// edge of the main window, below the title bar. Adding a view expands the
// pane; removing the last one folds it. Pure layout — no browser policy.

import { BrowserWindow, WebContentsView } from 'electron'
import { TITLE_BAR_HEIGHT } from '../../shared/window-chrome'

const PANE_WIDTH = 380

class AppViewDock {
  private window: BrowserWindow | null = null
  private views: WebContentsView[] = []

  attach(win: BrowserWindow): void {
    if (this.window === win) return
    this.window = win
    win.on('resize', () => this.layout())
    win.on('closed', () => { this.window = null; this.views = [] })
  }

  addView(view: WebContentsView): void {
    if (!this.window) throw new Error('app-view dock: no main window')
    this.views.push(view)
    this.window.contentView.addChildView(view)
    this.layout()
  }

  removeView(view: WebContentsView): void {
    const idx = this.views.indexOf(view)
    if (idx >= 0) this.views.splice(idx, 1)
    this.window?.contentView.removeChildView(view)
    if (this.views.length === 0) this.layout() // fold (zero-width)
  }

  /** Re-add an existing view so it stacks on top and the pane stays open. */
  addViewToTop(view: WebContentsView): void {
    const idx = this.views.indexOf(view)
    if (idx >= 0) this.views.splice(idx, 1)
    this.views.push(view)
    this.window?.contentView.removeChildView(view)
    this.window?.contentView.addChildView(view)
    this.layout()
  }

  /** Whether any agent tab is currently docked. */
  hasViews(): boolean {
    return this.views.length > 0
  }

  private layout(): void {
    const win = this.window
    if (!win) return
    const [width, height] = win.getContentSize()
    const paneWidth = this.views.length > 0 ? Math.min(PANE_WIDTH, Math.max(240, width - 200)) : 0
    for (const view of this.views) {
      view.setBounds({ x: width - paneWidth, y: TITLE_BAR_HEIGHT, width: paneWidth, height: Math.max(0, height - TITLE_BAR_HEIGHT) })
    }
  }
}

export const appViewDock = new AppViewDock()
