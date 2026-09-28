// Tests for the gate-period escape's refined decision (gate-escape.ts):
// `window-all-closed` during the launch-hook gate no longer pops the dialog
// instantly. The grace absorbs the two shapes that made the dialog mostly
// noise — the hook's server-side poll landing seconds after the user closed
// the login window, and the watchdog abandoning a stuck hook a beat before
// the gate releases. When the grace expires with the gate still held, a
// user-closed hook window auto-skips the gate (skipLaunchHooks never kills
// the hook), and the dialog remains only for a zero-window state no user
// close explains — the defensive face.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginGateEscape,
  cancelGateEscape,
  GATE_ESCAPE_GRACE_MS,
  type GateEscapeDeps,
} from '../src/main/gate-escape'

function makeDeps(init: { held?: boolean; userClosed?: boolean } = {}) {
  const state = {
    held: init.held ?? true,
    userClosed: init.userClosed ?? false,
    skips: 0,
    dialogs: 0,
    logs: [] as string[],
  }
  const deps: GateEscapeDeps = {
    gateHeld: () => state.held,
    lastHookWindowCloseFromUser: () => state.userClosed,
    skipGate: () => { state.skips++ },
    showDialog: () => { state.dialogs++ },
    log: (message) => { state.logs.push(message) },
  }
  return { state, deps }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cancelGateEscape()
  vi.useRealTimers()
})

describe('beginGateEscape', () => {
  it('decides nothing before the grace expires', () => {
    const { deps, state } = makeDeps()
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS - 1)
    expect(state.skips).toBe(0)
    expect(state.dialogs).toBe(0)
  })

  it('auto-skips the gate when the user closed the hook window and the gate still holds', () => {
    const { deps, state } = makeDeps({ userClosed: true })
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS)
    expect(state.skips).toBe(1)
    expect(state.dialogs).toBe(0)
    expect(state.logs.join('\n')).toContain('skipping')
  })

  it('decides nothing when the gate releases during the grace (the poll landed)', () => {
    const { deps, state } = makeDeps({ userClosed: true })
    beginGateEscape(deps)
    state.held = false
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS)
    expect(state.skips).toBe(0)
    expect(state.dialogs).toBe(0)
  })

  it('falls back to the dialog when no user close explains the zero-window state', () => {
    const { deps, state } = makeDeps({ userClosed: false })
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS)
    expect(state.dialogs).toBe(1)
    expect(state.skips).toBe(0)
  })

  it('is idempotent while the grace runs — arming twice decides once', () => {
    const { deps, state } = makeDeps({ userClosed: true })
    beginGateEscape(deps)
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS)
    expect(state.skips).toBe(1)
  })

  it('never arms when the gate is not held', () => {
    const { deps, state } = makeDeps({ held: false })
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS * 2)
    expect(state.skips).toBe(0)
    expect(state.dialogs).toBe(0)
  })

  it('a cancelled grace (a hook window opened again) decides nothing, and re-arming works', () => {
    const { deps, state } = makeDeps({ userClosed: true })
    beginGateEscape(deps)
    cancelGateEscape()
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS * 2)
    expect(state.skips).toBe(0)
    // The window closed again → window-all-closed re-fires → re-arms.
    beginGateEscape(deps)
    vi.advanceTimersByTime(GATE_ESCAPE_GRACE_MS)
    expect(state.skips).toBe(1)
  })
})
