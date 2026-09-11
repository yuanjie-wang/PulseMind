// ── IPC registration integrity (added after the duplicate-handler incident
//    that shipped in 0.4.0 M5 — a silent string-replace no-op left a call to
//    the wrong register function) ──
// Static checks, no Electron:
//   1. every ipcMain.handle channel is registered exactly once across handlers
//   2. every channel the preload invokes has a registration

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const HANDLERS_DIR = join(REPO, 'src', 'main', 'ipc')

function registeredChannels(): Map<string, string[]> {
  const byChannel = new Map<string, string[]>()
  const consts = readFileSync(join(REPO, 'src', 'shared', 'ipc-channels.ts'), 'utf-8')
  const constMap = new Map([...consts.matchAll(/([A-Z0-9_]+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))

  for (const file of readdirSync(HANDLERS_DIR).filter((f) => f.endsWith('.handler.ts'))) {
    const src = readFileSync(join(HANDLERS_DIR, file), 'utf-8')
    for (const m of src.matchAll(/ipcMain\.handle\(\s*(?:IPC_CHANNELS\.([A-Z0-9_]+)|'([^']+)')/g)) {
      const literal = constMap.get(m[1] ?? '') ?? m[2] ?? m[1] ?? ''
      const list = byChannel.get(literal) ?? []
      list.push(file)
      byChannel.set(literal, list)
    }
  }
  return byChannel
}

function invokedChannels(): string[] {
  const consts = readFileSync(join(REPO, 'src', 'shared', 'ipc-channels.ts'), 'utf-8')
  const constMap = new Map([...consts.matchAll(/([A-Z0-9_]+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  const pre = readFileSync(join(REPO, 'src', 'preload', 'index.ts'), 'utf-8')
  const out = new Set<string>()
  for (const m of pre.matchAll(/ipcRenderer\.invoke\(IPC_CHANNELS\.([A-Z0-9_]+)/g)) {
    out.add(constMap.get(m[1]) ?? m[1])
  }
  return [...out]
}

describe('IPC registration integrity', () => {
  it('registers every channel exactly once', () => {
    const byChannel = registeredChannels()
    const dupes = [...byChannel.entries()].filter(([, files]) => files.length > 1)
    expect(dupes, `duplicate handlers: ${JSON.stringify(Object.fromEntries(dupes))}`).toEqual([])
  })

  it('has a registration for every channel the preload invokes', () => {
    const byChannel = registeredChannels()
    const missing = invokedChannels().filter((ch) => !byChannel.has(ch))
    expect(missing, 'channels invoked by preload but never registered').toEqual([])
  })
})
