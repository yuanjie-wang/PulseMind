// ── Browser Use IPC (A-M1) ──
// The runtime lives in src/main/browser/BrowserService — one channel carries
// the whole capability. This shim keeps the actual `ipcMain.handle` call in
// the ipc/ directory so the registration-integrity test can see it.

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { browserService, type BrowserRunPayload } from '../browser/BrowserService'

export function registerBrowserHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BROWSER_RUN_CODE, (_event, payload: BrowserRunPayload) => browserService.handleRunCode(payload))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_STATE, (event, state) => browserService.handlePaneState(state, event.sender))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_WIDTH, (event, width: number) => browserService.handlePaneWidth(width, event.sender))
  ipcMain.handle(IPC_CHANNELS.BROWSER_PANE_ACTION, (event, action) => browserService.handlePaneAction(action, event.sender))
}
