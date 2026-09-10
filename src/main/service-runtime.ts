/** Runtime handle of the local agent service (PLAN-0.3.5 M2.4). index.ts owns
 *  the lifecycle; the settings IPC reads/mutates through this module. */
import type { AgentServiceHandle } from './agent/ws-server'
import { settingsStore } from './storage/settings-store'
import { startAgentService } from './agent/ws-server'
import { randomUUID } from 'node:crypto'
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
  try { return readFileSync(tokenPath(), 'utf-8').trim() } catch { return '' }
}

export function writeToken(token: string): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(tokenPath(), token, 'utf-8')
}

/** (Re)start the service with current settings. Stops a running instance first. */
export async function restartService(): Promise<{ port: number } | null> {
  await serviceRuntime.handle?.close()
  serviceRuntime.handle = null
  const settings = await settingsStore.get()
  if (settings.serviceEnabled === false) return null
  const handle = await startAgentService({ port: settings.servicePort }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err
    return startAgentService({ port: 0 })
  })
  serviceRuntime.handle = handle
  return { port: handle.port }
}
