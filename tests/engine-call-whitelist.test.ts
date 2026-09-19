// ── Engine-call surface governance (PLAN-form-assist-proposals D18①) ──
// The 授权 dropdown "could not be switched" twice; the second time the cause
// was a protocol method the service never dispatched. Multi-assistant surfaces
// drift the same way: the main chat grows a loop interaction, an assistant
// column copies the button, and `dispatchEngineCall` answers "engine method
// not allowed" — a click that does nothing, visible only in the console. This
// is the static fence:
//
//   every engine method the renderer UI can send ⊆ the session-manager
//   dispatch whitelist
//
// Static on purpose (vitest here is node-env — no app to mount); the runtime
// behaviour of each method is covered by its own tests. Non-vacuity: both
// scans assert minimum yields, so a broken regex cannot pass by finding
// nothing on either side.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()

/** Methods the main process dispatches — the `case '<name>':` rows inside
 *  session-manager's dispatchEngineCall (scoped to that function so other
 *  switch statements in the file cannot inflate the whitelist). */
function dispatchedMethods(): Set<string> {
  const src = readFileSync(join(REPO, 'src', 'main', 'agent', 'session-manager.ts'), 'utf-8')
  const start = src.indexOf('private dispatchEngineCall')
  expect(start, 'dispatchEngineCall moved? re-scope the scan').toBeGreaterThan(0)
  const end = src.indexOf('default: throw', start)
  expect(end, 'dispatch default arm moved? re-scope the scan').toBeGreaterThan(start)
  const body = src.slice(start, end)
  return new Set([...body.matchAll(/case\s+'(\w+)':/g)].map((m) => m[1]))
}

/** Methods the renderer can send: `engineCall('<name>'` and
 *  `agentSessionEngineCall(convId, '<name>'` literals anywhere under
 *  src/renderer/src (tests excluded). Both funnels end at the same IPC. */
function uiCalledMethods(): Array<{ name: string; file: string }> {
  const root = join(REPO, 'src', 'renderer', 'src')
  const out: Array<{ name: string; file: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
        const src = readFileSync(full, 'utf-8')
        // Both funnel shapes: session.engineCall('x', …) and the direct
        // agentSessionEngineCall(convId, 'x', [args]) the main chat uses.
        for (const m of src.matchAll(/\bengineCall\(\s*'(\w+)'/g)) out.push({ name: m[1], file: full })
        for (const m of src.matchAll(/agentSessionEngineCall\(\s*[^,]+,\s*'(\w+)'/g)) out.push({ name: m[1], file: full })
      }
    }
  }
  walk(root)
  return out
}

describe('engine-call surface: UI ⊆ dispatch whitelist (D18①)', () => {
  it('every engine method the UI sends has a dispatch case', () => {
    const dispatched = dispatchedMethods()
    const missing = uiCalledMethods().filter(({ name }) => !dispatched.has(name))
    expect(
      missing.map(({ name, file }) => `${name} (${file.split('/').slice(-1)[0]})`),
      'methods the renderer sends but session-manager never dispatches — the caller gets ' +
        '"engine method not allowed" and the click does nothing',
    ).toEqual([])
  })

  it('scans enough to be meaningful (a broken regex must not pass)', () => {
    const called = uiCalledMethods()
    const names = new Set(called.map(({ name }) => name))
    // Four assistant/tool-studio surfaces + the main chat call at least these.
    expect(called.length).toBeGreaterThanOrEqual(20)
    expect(names.size).toBeGreaterThanOrEqual(8)
    expect(names.has('respondToTool'), 'ask_user 应答是 UI 面，丢了说明扫描坏了').toBe(true)
    const dispatched = dispatchedMethods()
    expect(dispatched.size).toBeGreaterThanOrEqual(12)
    // The fence has two directions: a case nobody sends is dead surface too
    // (it grows the whitelist without a consumer — flag it, don't fail, but
    // keep the invariant visible).
    const unsent = [...dispatched].filter((name) => !names.has(name))
    expect(unsent, 'dispatch-only methods（允许存在，但必须是有意的：reset 供测试/内部用）').toEqual(['reset'])
  })
})
