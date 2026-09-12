// ── App-view CDP port (A-M3) ──
// The app-view backend drives tabs that live INSIDE the app window over the
// loopback DevTools protocol. Chromium must be told the port before app ready
// (port 0 → pick a free one, recorded in <userData>/DevToolsActivePort).
// Loopback-only by Chromium default; the CDP connection itself is lazy —
// opened on the first app-view session, not at boot (§10 risk acceptance).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

let enabled = false

export function enableAppViewDebugPort(): void {
  if (enabled) return
  app.commandLine.appendSwitch('remote-debugging-port', '0')
  enabled = true
}

/** Actual bound port, once Chromium has written the file (after ready). */
export function readDevToolsPort(): number | null {
  try {
    const file = join(app.getPath('userData'), 'DevToolsActivePort')
    if (!existsSync(file)) return null
    const first = readFileSync(file, 'utf-8').split('\n')[0]?.trim() ?? ''
    const port = Number(first)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}
