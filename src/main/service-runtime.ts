/** Runtime handle of the local agent service (PLAN-0.3.5 M2.4). index.ts owns
 *  the lifecycle; the settings IPC reads/mutates through this module. */
import type { AgentServiceHandle } from './agent/ws-server'
import { settingsStore } from './storage/settings-store'
import { startAgentService } from './agent/ws-server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './storage'

export const serviceRuntime: {
  handle: AgentServiceHandle | null
} = { handle: null }

export function tokenPath(): string {
  return join(DATA_DIR, 'service-token')
}

export function readToken(): string {
  try {
    return readFileSync(tokenPath(), 'utf-8').trim()
  } catch {
    return ''
  }
}

export function writeToken(token: string): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(tokenPath(), token, 'utf-8')
}

/** (Re)start the service with current settings. Stops a running instance first.
 *  EADDRINUSE is handled INSIDE startAgentService with a deterministic +0..+14
 *  scan (PLAN-browser-extension G6) so the extension can discover the bound
 *  port — a random listen(0) fallback would be unfindable. */
export async function restartService(): Promise<{ port: number } | null> {
  await serviceRuntime.handle?.close()
  serviceRuntime.handle = null
  const settings = await settingsStore.get()
  if (settings.serviceEnabled === false) return null
  const handle = await startAgentService({ port: settings.servicePort, broadcast: broadcastConversationHandoff })
  serviceRuntime.handle = handle
  return { port: handle.port }
}

/** session.handoff 的桌面广播（PLAN-extension-handoff）：全窗口 webContents
 *  发送 + **无条件前置**的主窗拉起（user 2026-11-08 实机反馈「转出后桌面端没
 *  有到前台」——原实现只在零窗口时建窗，已有窗但不在前台/最小化时静默后置）；
 *  popout/项目沉浸窗口收到后自行忽略。 */
async function broadcastConversationHandoff(payload: { sessionId: string; title: string; url: string }): Promise<void> {
  try {
    const { BrowserWindow } = await import('electron')
    const { IPC_CHANNELS } = await import('../shared/ipc-channels')
    const boot = await import('./index')
    await boot.ensureMainWindowForHandoff()
    const alive = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    for (const win of alive) {
      try {
        win.webContents.send(IPC_CHANNELS.CONVERSATION_HANDOFF, payload)
      } catch {
        /* window closing */
      }
    }
  } catch (err) {
    console.warn('[AgentService] handoff broadcast failed:', err instanceof Error ? err.message : err)
  }
}
