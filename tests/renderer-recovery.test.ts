// Tests for the renderer recovery ladder (2026-11-18 post-sleep freeze).
//
// The incident: after system sleep the renderer process stayed alive — the
// compositor kept repainting carets and the main process kept working — but it
// received no IPC at all. The resume notification timed out, and the `reload()`
// sent as its fallback was logged yet never arrived, because a reload is itself
// an IPC command. Chromium's 'unresponsive' event never fired: the renderer's
// message loop was idle, not blocked.
//
// Two mechanisms answer that state: the heartbeat (`createRendererHealth` — a
// missing pong means the channel is dead, and the verdict is a process kill) and
// the resume arm now calling the same kill instead of `reload()`. The unit half
// below drives the state machine with an injected clock; the wiring half pins
// that index.ts / the preload actually use it (the recovery path has no other
// runtime coverage — a killed renderer is not something vitest can boot).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'
import { createRendererHealth, RENDERER_ALIVE_TIMEOUT_MS, RENDERER_CLOCK_JUMP_MS, RENDERER_PING_INTERVAL_MS } from '../src/main/renderer-health'

interface HarnessOptions {
  destroyed?: boolean
  devtools?: boolean
}

function harness(opts: HarnessOptions = {}) {
  let clock = 1_000_000
  let tickFn: (() => void) | null = null
  let stopped = false
  let intervalsCreated = 0
  const state = { sentThrow: false }
  const sent: string[] = []
  const wedges: number[] = []
  const skips: string[] = []
  const health = createRendererHealth({
    target: {
      isDestroyed: () => opts.destroyed ?? false,
      isDevToolsOpened: () => opts.devtools ?? false,
      send: (channel: string) => {
        if (state.sentThrow) throw new Error('IPC channel is gone')
        sent.push(channel)
      },
    },
    onWedged: (idleMs: number) => {
      wedges.push(idleMs)
    },
    onSkip: (reason: string) => {
      skips.push(reason)
    },
    now: () => clock,
    setInterval: (fn) => {
      intervalsCreated++
      tickFn = fn
      stopped = false
      return 0 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {
      stopped = true
    },
  })
  const dispose = health.start()
  /** One watchdog tick. `pong` models the renderer answering the ping it just
   *  received (a live renderer always does). */
  const step = (ms = RENDERER_PING_INTERVAL_MS, pong = true): void => {
    clock += ms
    if (!stopped) tickFn?.()
    if (pong) health.markAlive()
  }
  const steps = (n: number, pong = true): void => {
    for (let i = 0; i < n; i++) step(RENDERER_PING_INTERVAL_MS, pong)
  }
  return {
    health,
    sent,
    wedges,
    skips,
    step,
    steps,
    dispose,
    set sentThrow(v: boolean) {
      state.sentThrow = v
    },
    intervalsCreated: () => intervalsCreated,
  }
}

describe('renderer health heartbeat', () => {
  it('pings every interval while the renderer answers', () => {
    const h = harness()
    h.steps(12)
    expect(h.sent).toHaveLength(12)
    expect(h.sent.every((c) => c === IPC_CHANNELS.APP_RENDERER_PING)).toBe(true)
    expect(h.wedges).toHaveLength(0)
    expect(h.skips).toHaveLength(0)
  })

  it('declares a wedge once silence passes the timeout, and stops pinging dead air', () => {
    const h = harness()
    // 30s of silence is still inside the timeout — the renderer may just be
    // slow to start or busy; the ping keeps asking.
    h.steps(6, false)
    expect(h.wedges).toHaveLength(0)
    const pingsSent = h.sent.length
    // 35s: silence outlasted the timeout.
    h.step(undefined, false)
    expect(h.wedges).toHaveLength(1)
    expect(h.wedges[0]).toBeGreaterThan(RENDERER_ALIVE_TIMEOUT_MS)
    expect(h.sent).toHaveLength(pingsSent)
  })

  it('retries the kill each timeout instead of going silent after one attempt', () => {
    const h = harness()
    h.steps(7, false)
    expect(h.wedges).toHaveLength(1)
    h.steps(6, false) // 35s → 65s: another full timeout past the first verdict
    expect(h.wedges).toHaveLength(2)
  })

  it('markAlive re-arms the watchdog after a wedge', () => {
    const h = harness()
    h.steps(7, false)
    expect(h.wedges).toHaveLength(1)
    const wedgedAt = h.sent.length
    h.health.markAlive()
    h.steps(3)
    expect(h.sent.length).toBeGreaterThan(wedgedAt)
    expect(h.wedges).toHaveLength(1)
  })

  it('a clock jump (sleep / blocked main thread) resets instead of killing', () => {
    const h = harness()
    h.step()
    expect(h.sent).toHaveLength(1)
    // The machine slept (or main stalled): the next tick arrives far later than
    // its interval, so elapsed time is no evidence about the renderer.
    h.step(60_000, false)
    expect(h.wedges).toHaveLength(0)
    expect(h.skips).toHaveLength(0)
    // ...and the countdown restarted rather than being pre-loaded.
    h.step()
    expect(h.sent).toHaveLength(2)
    expect(RENDERER_CLOCK_JUMP_MS).toBeLessThan(RENDERER_ALIVE_TIMEOUT_MS)
  })

  it('skips the kill while DevTools is open (a paused breakpoint may hold the thread)', () => {
    const h = harness({ devtools: true })
    h.steps(10, false)
    expect(h.wedges).toHaveLength(0)
    expect(h.skips).toEqual(['devtools-open'])
  })

  it('does nothing for a destroyed target', () => {
    const h = harness({ destroyed: true })
    h.steps(10, false)
    expect(h.sent).toHaveLength(0)
    expect(h.wedges).toHaveLength(0)
  })

  it('start() is idempotent and the disposer stops ticking', () => {
    const h = harness()
    h.health.start()
    expect(h.intervalsCreated()).toBe(1)
    h.step()
    expect(h.sent).toHaveLength(1)
    h.dispose()
    h.step()
    expect(h.sent).toHaveLength(1)
  })

  it('a send that throws counts as a miss, not a crash in main', () => {
    const h = harness()
    h.sentThrow = true
    expect(() => h.steps(6, false)).not.toThrow()
    h.sentThrow = false
    h.step(undefined, false)
    expect(h.wedges).toHaveLength(1)
  })

  it('works with no seams injected (real clock and timers)', () => {
    // The production wiring passes only target/onWedged/onSkip; the `??` defaults
    // for now/setInterval/clearInterval must be exercised, or a typo there ships.
    const health = createRendererHealth({
      target: { isDestroyed: () => false, isDevToolsOpened: () => false, send: () => {} },
      onWedged: () => {},
    })
    const stop = health.start()
    health.start() // idempotent under the real timer too
    health.markAlive()
    stop()
  })

  it('an absent onSkip does not turn the DevTools skip into a crash', () => {
    const health = createRendererHealth({
      target: { isDestroyed: () => false, isDevToolsOpened: () => true, send: () => {} },
      onWedged: () => {
        throw new Error('must not kill while DevTools is open')
      },
    })
    const stop = health.start()
    stop()
  })
})

describe('renderer recovery wiring', () => {
  const index = readFileSync('src/main/index.ts', 'utf-8')
  const preload = readFileSync('src/preload/index.ts', 'utf-8')

  it('the resume fallback kills the process instead of asking it to reload', () => {
    const arm = index.slice(index.indexOf("powerMonitor.on('resume'"), index.indexOf("app.on('activate'"))
    expect(arm).toContain("recoverRenderer(win, 'resume-no-ack')")
    // A reload travels over the same dead channel this fallback exists for.
    expect(arm).not.toContain('.reload()')
    // A hidden window with a dead renderer is the state the user finds later.
    expect(arm).not.toContain('isVisible()')
    expect(arm).toContain('rendererHealth?.markAlive()')
  })

  it('recoverRenderer kills at process level, behind the DevTools gate', () => {
    const fn = index.slice(index.indexOf('function recoverRenderer'), index.indexOf('let rendererHealth:'))
    expect(fn).toContain('wc.forcefullyCrashRenderer()')
    expect(fn).toContain('wc.isDevToolsOpened()')
    expect(fn).toContain('forcedRendererRecovery = true')
    expect(fn).toContain('isQuitting')
    expect(fn).not.toContain('.reload()')
  })

  it('the unresponsive watchdog reuses the same kill path', () => {
    const arm = index.slice(index.indexOf("mainWindow.webContents.on('unresponsive'"), index.indexOf('installRendererHealth(mainWindow)'))
    expect(arm).toContain("recoverRenderer(win, 'unresponsive-15s')")
    expect(arm).not.toContain('forcefullyCrashRenderer')
  })

  it('the heartbeat is installed per window and its pong binds once', () => {
    expect(index).toContain('installRendererHealth(mainWindow)')
    expect(index).toContain('ipcMain.on(IPC_CHANNELS.APP_RENDERER_PONG')
    expect(index).toContain('ipcMain.on(IPC_CHANNELS.APP_SYSTEM_RESUMED_ACK')
    // Post-recovery evidence: the new document must announce itself in main.log.
    expect(index).toContain("win.webContents.on('did-finish-load'")
    expect(index).toContain('renderer: document loaded')
  })

  it('render-process-gone resets the heartbeat for the replacement renderer', () => {
    const gone = index.slice(index.indexOf("app.on('render-process-gone'"), index.indexOf("app.on('child-process-gone'"))
    expect(gone).toContain('rendererHealth?.markAlive()')
  })

  it('the stall watchdog no longer reports mid-sleep drift as a stall', () => {
    expect(index).toContain('powerEventTimestamps.lastSuspendAt > powerEventTimestamps.lastResumeAt')
  })

  it('the preload answers pings itself, outside the api object', () => {
    const tail = preload.slice(preload.indexOf("exposeInMainWorld('electronAPI'"))
    expect(tail).toContain('IPC_CHANNELS.APP_RENDERER_PING')
    expect(tail).toContain('IPC_CHANNELS.APP_RENDERER_PONG')
    // Nothing in the renderer (React) may be needed for a pong.
    expect(tail).not.toContain('onRendererPing')
  })

  it('ping and pong are separate channels', () => {
    expect(IPC_CHANNELS.APP_RENDERER_PING).not.toBe(IPC_CHANNELS.APP_RENDERER_PONG)
    expect(IPC_CHANNELS.APP_RENDERER_PING).not.toBe(IPC_CHANNELS.APP_SYSTEM_RESUMED)
  })
})
