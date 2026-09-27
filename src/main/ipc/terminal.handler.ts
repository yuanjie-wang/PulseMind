/**
 * Thin IPC registration for terminal operations. All logic lives in
 * services/terminal.ts; this handler only bridges the service's emit sink to
 * the calling renderer's webContents (with the disposed-frame guard).
 *
 * Renderer-originated execution gate (review 2026-09-25 P0-3): the engine's
 * own terminal calls never come through here — main-hosted engines hold the
 * ALS session context and call services/terminal directly — so every call on
 * these two channels arrives from renderer code. The approval ladder lives in
 * the engine (main side); a renderer reach-around (XSS) used to hit an
 * ungated IPC = unattended RCE. Now each call must pass a NATIVE confirmation
 * dialog (a window the page cannot script) and is audited either way. An
 * optional `sessionId` opts into the mechanical workspace cwd jail as well.
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { join, resolve as resolvePath } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { svcExecuteCommand, svcKillCommand, svcExecSync, svcExecLogs, svcExecKill } from '../services/terminal'
import { currentSessionSandbox } from '../sandbox/session-context'
import { auditStore } from '../storage/audit-store'
import { getConversationWorkspaceDir } from '../storage/conversation.db'
import { isSubpath } from '../../shared/sandbox/path-jail'

export interface TerminalCallOptions {
  /** The conversation this call belongs to — enables the workspace cwd jail. */
  sessionId?: string
}

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

function auditTerminalCall(
  command: string,
  cwd: string | undefined,
  sessionId: string | undefined,
  decision: 'allowed' | 'denied',
  meta: Record<string, unknown>,
): void {
  try {
    auditStore.record({
      scope: 'terminal',
      actor: sessionId ?? 'renderer',
      action: 'terminal.exec',
      target: command.slice(0, 500),
      decision,
      metaJson: JSON.stringify({ cwd: cwd ?? null, ...meta }),
    })
  } catch { /* auditing must never block the gate */ }
}

/** One native confirmation — unspoofable by page content, unlike anything a
 *  renderer-driven approval could prove. */
async function confirmExecution(
  event: Electron.IpcMainInvokeEvent,
  command: string,
  cwd: string | undefined,
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: '终端命令确认',
    message: '有代码请求执行系统命令',
    detail: `命令：${command}\n工作目录：${cwd ?? '(默认)'}`,
    buttons: ['允许执行', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const win = BrowserWindow.fromWebContents(event.sender)
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

/** Validate + confirm one renderer-originated execution. Returns the cwd to
 *  use, or an error string when the call must not run. */
async function gateRendererExecution(
  event: Electron.IpcMainInvokeEvent,
  command: string,
  cwd: string | undefined,
  opts: TerminalCallOptions | undefined,
): Promise<{ ok: true; cwd?: string } | { ok: false; error: string }> {
  const sessionId = opts?.sessionId
  // Mechanical workspace jail first: a session that owns a workspace may only
  // run (or default) inside it — the dialog then confirms the exact command.
  if (sessionId) {
    const workspace = getConversationWorkspaceDir(sessionId)
    if (workspace) {
      const targetCwd = cwd ? resolvePath(cwd) : join(workspace)
      if (!isSubpath(workspace, targetCwd)) {
        auditTerminalCall(command, cwd, sessionId, 'denied', { reason: 'cwd outside workspace' })
        return { ok: false, error: `cwd blocked by sandbox: ${cwd} is outside the conversation workspace` }
      }
    }
  }
  const confirmed = await confirmExecution(event, command, cwd)
  auditTerminalCall(command, cwd, sessionId, confirmed ? 'allowed' : 'denied', {
    source: 'renderer-ipc',
    confirmed,
  })
  if (!confirmed) return { ok: false, error: 'Execution declined by the user' }
  return { ok: true, cwd }
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXECUTE, async (event, command: string, cwd?: string, timeoutMs?: number, opts?: TerminalCallOptions) => {
    const gate = await gateRendererExecution(event, command, cwd, opts)
    if (!gate.ok) throw new Error(gate.error)
    const webContents = getSender(event)
    return svcExecuteCommand(command, gate.cwd, timeoutMs, {
      output: (processId, type, data) => sendOutput(webContents, processId, type, data),
      exit: (processId, code, signal) => sendExit(webContents, processId, code, signal),
      error: (processId, message) => {
        if (!webContents.isDestroyed()) {
          try { webContents.send(IPC_CHANNELS.TERMINAL_ERROR, { processId, message }) } catch { /* renderer frame disposed */ }
        }
      },
    })
  })

  // Kill a running process — no execution, no confirmation; the process table
  // is keyed by ids minted here, so a stray kill only reaches app-spawned work.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_KILL, (_event, processId: string) => {
    svcKillCommand(processId)
  })

  // One-shot command execution: spawn, collect output, return on exit.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXEC_SYNC, async (_event, command: string, cwd?: string, timeoutMs?: number, opts?: TerminalCallOptions): Promise<{ output: string; code: number | null }> => {
    const gate = await gateRendererExecution(_event, command, cwd, opts)
    if (!gate.ok) throw new Error(gate.error)
    return svcExecSync(command, gate.cwd, timeoutMs)
  })

  // ── Background process mode + session exec allowlist (PLAN-coding-contract
  // P0-2/P0-3). Same trust shape as the review note above: the agent graph
  // reaches these through the main-process host, never through these channels —
  // so the spawn and the allowlist-write REFUSE renderer origins outright (a
  // reach-around here would be unattended RCE / an approval-ladder widening).
  // The pid-keyed reads/kill are harmless for renderer calls: both key off the
  // ALS session context, which a renderer invocation never has.
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXECUTE_BACKGROUND, () => {
    throw new Error('background execution is agent-only — this channel has no renderer path')
  })
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXEC_LOGS, (_event, pid: number, tailBytes?: number) => svcExecLogs(Number(pid), tailBytes))
  ipcMain.handle(IPC_CHANNELS.TERMINAL_EXEC_KILL, (_event, pid: number) => svcExecKill(Number(pid)))
  ipcMain.handle(IPC_CHANNELS.EXEC_ALLOWLIST_GET, () => {
    const ctx = currentSessionSandbox()
    return ctx ? [...ctx.execAllowlist] : []
  })
  ipcMain.handle(IPC_CHANNELS.EXEC_ALLOWLIST_ADD, () => {
    throw new Error('the exec allowlist is engine-side — approve with alwaysAllow through the session engine instead')
  })
}
