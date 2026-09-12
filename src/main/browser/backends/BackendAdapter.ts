// ── Backend adapter seam (A-M1) ──
// A backend owns how tabs actually exist: `managed` launches a bundled/system
// Chromium via playwright-core; `app-view` (M3) reuses the app's own
// WebContentsView over a loopback CDP connection. Both feed the same
// PlaywrightCommands executor — the command layer is backend-agnostic.

import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { BackendDescriptor } from '../../../shared/browser-client/protocol'

/** A live tab as the backend sees it. The service wraps it with scope
 *  attribution and an id; backends only supply the playwright primitives. */
export interface BackendTab {
  page: Page
  /** Close the tab and anything the backend pinned for it (its context, e.g.). */
  close: () => Promise<void>
}

export interface BackendAdapter {
  descriptor(): BackendDescriptor
  /** Launch/connect. Must be idempotent; called lazily before first use. */
  start(): Promise<void>
  /** Release everything (app quit). */
  stop(): Promise<void>
  newTab(url?: string): Promise<BackendTab>
  /** Backends may keep browser-level state (the launch browser itself). */
  rawBrowser(): Browser | null
  /** Context of a tab, when the backend associates one (managed: per-tab). */
  contextOf(tab: BackendTab): BrowserContext | null
}
