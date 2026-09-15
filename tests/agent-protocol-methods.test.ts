// ── Protocol method coverage (added after the 授权切换 that could not switch) ──
// `Methods.sessionSetApprovalMode` was declared in the shared protocol, sent by
// the extension's panel bridge and answered by a *fake* client in
// extension-panel-bridge.test.ts — while the real service had no `case` for it,
// so every click came back `methodNotFound`, the panel reverted its optimistic
// value and the level stayed where it was. A fake that answers everything hides
// exactly this bug, so this is the static check that closes it:
//
//   1. every method a client *sends* (request/notify) has a case in ws-server
//   2. the scan is non-vacuous — a broken regex must not pass by finding nothing
//
// Static, no sockets: the runtime behaviour of each method is covered by
// agent-protocol-ws.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const METHODS_SRC = join(REPO, 'src', 'shared', 'agent-protocol', 'methods.ts')
const WS_SERVER = join(REPO, 'src', 'main', 'agent', 'ws-server.ts')
/** The in-page panel's half: the service worker is the protocol client. */
const CLIENT_SOURCES = [
  join(REPO, 'src', 'extension', 'background', 'panel-bridge.ts'),
  join(REPO, 'src', 'extension', 'background', 'index.ts'),
  join(REPO, 'src', 'extension', 'background', 'ws-client.ts'),
]

/** Wire names of the shared `Methods` map: `sessionSetApprovalMode: 'session.setApprovalMode'`. */
function methodConsts(): Map<string, string> {
  const src = readFileSync(METHODS_SRC, 'utf-8')
  return new Map([...src.matchAll(/(\w+):\s*'([a-z_]+(?:\.[a-zA-Z]+)+)'/g)].map((m) => [m[1], m[2]]))
}

/** Methods the server dispatches — `case Methods.x:` / `if (msg.method === Methods.x)`. */
function handledConsts(): Set<string> {
  const src = readFileSync(WS_SERVER, 'utf-8')
  const out = new Set<string>()
  for (const m of src.matchAll(/case\s+Methods\.(\w+)/g)) out.add(m[1])
  for (const m of src.matchAll(/msg\.method\s*===\s*Methods\.(\w+)/g)) out.add(m[1])
  return out
}

/** Methods the client sends to the service. Only `request`/`notify` calls count:
 *  an incoming notification is compared with `msg.method === Methods.x` and is
 *  not something the service has to dispatch. */
function sentConsts(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = []
  for (const file of CLIENT_SOURCES) {
    const src = readFileSync(file, 'utf-8')
    for (const m of src.matchAll(/(?:request|notify)\(\s*Methods\.(\w+)/g)) out.push({ name: m[1], file })
    // The handshake (and any other literal-written method) rides the same path.
    for (const m of src.matchAll(/\.(?:request|notify)\(\s*'([a-z_]+(?:\.[a-zA-Z]+)+)'/g)) {
      const name = [...methodConsts().entries()].find(([, wire]) => wire === m[1])?.[0]
      if (name) out.push({ name, file })
    }
  }
  return out
}

describe('agent protocol method coverage', () => {
  it('declares a wire name for every method the clients reference', () => {
    const consts = methodConsts()
    const unknown = sentConsts().filter((s) => !consts.has(s.name))
    expect(unknown, `methods referenced but not declared in methods.ts: ${JSON.stringify(unknown)}`).toEqual([])
  })

  it('has a ws-server case for every method a client sends', () => {
    const handled = handledConsts()
    const missing = sentConsts().filter((s) => !handled.has(s.name))
    expect(
      missing.map((m) => `${m.name} (${m.file.split('/').slice(-1)[0]})`),
      'methods the extension sends but the service never dispatches — the caller gets methodNotFound ' +
        'and its optimistic UI silently reverts',
    ).toEqual([])
  })

  it('scans enough to be meaningful (a broken regex must not pass)', () => {
    // Guards the guard: if the client scan stops matching, the check above
    // passes trivially — which is how the missing case stayed invisible.
    const sent = sentConsts()
    expect(sent.length).toBeGreaterThanOrEqual(8)
    expect(new Set(sent.map((s) => s.name)).size).toBeGreaterThanOrEqual(8)
    expect(handledConsts().size).toBeGreaterThanOrEqual(10)
  })
})
