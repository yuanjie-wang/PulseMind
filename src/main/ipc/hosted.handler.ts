/** IPC surface for hosted (reverse-RPC) page tools (PLAN-browser-extension
 *  M0.2). The renderer host never calls this today (hosted clients live on the
 *  WS service), but the bridge contract must resolve for the desktop renderer
 *  too — the handler routes to the same main-process proxy. */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { mainHost } from '../agent/main-host'

export function registerHostedHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.HOSTED_TOOL_CALL,
    (_event, tool: string, args: Record<string, unknown>, opts: { sessionId: string; timeoutMs?: number }) =>
      mainHost.hostedToolCall(tool, args, opts ?? { sessionId: '' }),
  )
}
