// ── Browser Use IPC (A-M1) ──
// The runtime lives in src/main/browser/BrowserService — one channel carries
// the whole capability. This shim keeps the actual `ipcMain.handle` call in
// the ipc/ directory so the registration-integrity test can see it.

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { browserService, type BrowserRunPayload } from '../browser/BrowserService'
import { browserFavoriteStore } from '../storage/browser-favorite-store'
import { browserHistoryStore } from '../storage/browser-history-store'

export function registerBrowserHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BROWSER_RUN_CODE, (_event, payload: BrowserRunPayload) => browserService.handleRunCode(payload))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_STATE, (event, state) => browserService.handlePaneState(state, event.sender))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_WIDTH, (event, width: number) => browserService.handlePaneWidth(width, event.sender))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_ACTION, (event, action) => browserService.handlePaneAction(action, event.sender))
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_QUERY, (_event, text: string) => browserHistoryStore.query(text))
  ipcMain.handle(IPC_CHANNELS.BROWSER_HISTORY_CLEAR, () => browserHistoryStore.clear())
  // ── Favorites (PLAN-browser-favorites M1) ──
  ipcMain.handle(IPC_CHANNELS.BROWSER_FAVORITE_ADD, (_event, url: string, title?: string) => {
    try {
      return { ok: true, ...(browserFavoriteStore.add(url, title)) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.BROWSER_FAVORITE_REMOVE, (_event, url: string) => browserFavoriteStore.remove(url))
  ipcMain.handle(IPC_CHANNELS.BROWSER_FAVORITE_LIST, () => browserFavoriteStore.list())
  ipcMain.handle(IPC_CHANNELS.BROWSER_FAVORITE_QUERY, (_event, text: string, limit?: number) => browserFavoriteStore.query(text, limit))
  ipcMain.handle(IPC_CHANNELS.BROWSER_FAVORITE_HAS, (_event, url: string) => browserFavoriteStore.has(url))
}
