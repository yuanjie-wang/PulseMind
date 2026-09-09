/**
 * Thin IPC registration for terminal operations. All logic lives in
 * services/terminal.ts; this handler only bridges the service's emit sink to
 * the calling renderer's webContents (with the disposed-frame guard).
 */
import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { svcExecuteCommand, svcKillCommand, svcExecSync } from '../services/terminal'

function getSender(event: Electron.IpcMainInvokeEvent): Electron.WebContents {
  return BrowserWindow.fromWebContents(event.sender)?.webContents ?? event.sender
}

// isDestroyed() alone is insufficient: during a renderer reload/crash the
// WebContents object survives but its frame is disposed, and send() throws
// "Render frame was disposed before WebFrameMain could be accessed". A subprocess
// exit firing in that window must drop the event, not crash the main process.
function sendOutput(webContents: Electron.WebContents, processId: string, type: 'stdout' | 'stderr', data: string) {
  if (webContents.isDestroyed()) return
  try { webContents.send(IPC_CHANNELS.TERMINAL_OUTPUT, { processId, type, data }) } catch { /* renderer frame disposed */ }
}

function sendExit(webContents: Electron.WebContents, processId: string, code: number | null, signal: string | null) {
  if (webContents.isDestroyed()) return
  try { webContents.send(IPC_CHANNELS.TERMINAL_EXIT, { processId, code, signal }) } catch { /* renderer frame disposed */ }
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXECUTE, (event, command: string, cwd?: string, timeoutMs?: number) => {
    const webContents = getSender(event)
    return svcExecuteCommand(command, cwd, timeoutMs, {
      output: (processId, type, data) => sendOutput(webContents, processId, type, data),
      exit: (processId, code, signal) => sendExit(webContents, processId, code, signal),
      error: (processId, message) => {
        if (!webContents.isDestroyed()) {
          try { webContents.send(IPC_CHANNELS.TERMINAL_ERROR, { processId, message }) } catch { /* renderer frame disposed */ }
        }
      },
    })
  })

  // Kill a running process
  ipcMain.handle(IPC_CHANNELS.TERMINAL_KILL, (_event, processId: string) => {
    svcKillCommand(processId)
  })

  // One-shot command execution: spawn, collect output, return on exit.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXEC_SYNC, (_event, command: string, cwd?: string, timeoutMs?: number): Promise<{ output: string; code: number | null }> => {
    return svcExecSync(command, cwd, timeoutMs)
  })
}
