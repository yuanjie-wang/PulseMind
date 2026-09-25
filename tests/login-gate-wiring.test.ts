// The login gate's wiring — source scans, because index.ts is the app entry:
// importing it boots an Electron app, and the ordering it pins (hooks BEFORE
// window creation, the splash holding for the gate) exists nowhere a runtime
// assertion can reach from vitest.
//
// The central assertion inverts a deliberate OLD fix: "hooks run concurrently
// with window creation" was itself a fix for slow hooks delaying first paint,
// and the 2026-09-25 login decision reversed it again. Reverting the gate
// (moving ensureLaunchHooks back after createWindow) fails the first scan.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), 'utf8')

describe('login gate (app-start before createWindow)', () => {
  const src = read('src', 'main', 'index.ts')

  it('awaits the launch hooks BEFORE the first createWindow() call', () => {
    const gate = src.indexOf('await ensureLaunchHooks()')
    expect(gate).toBeGreaterThan(-1)
    // Indented = a call; the `function createWindow` declaration sits at
    // column 0 and must not count as the site the gate precedes.
    const firstCall = src.search(/^\s+createWindow\(\)\s*$/m)
    expect(firstCall).toBeGreaterThan(gate)
  })

  it('the old concurrent shape is gone', () => {
    expect(src).not.toContain('void ensureLaunchHooks().then(')
  })

  it('hooks completion stamps hooksCompletedAt for the splash valve anchor', () => {
    expect(src).toContain('hooksCompletedAt = Date.now()')
  })

  it('the splash holds indefinitely while the gate is closed (all three give-up branches)', () => {
    // scheduleSplashFade has three paths that could walk away from a hold:
    // splash-not-painted, main-window-not-ready, and splash-already-gone (a
    // hook opened the login window and the splash was closed for it). All
    // must re-check while hooksComplete is false, or a login past
    // MAX_SPLASH_MS empties the screen.
    const fnStart = src.indexOf('function scheduleSplashFade')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart, src.indexOf('function getResourcePath', fnStart))
    expect(body).toContain('!hooksComplete ||')
    expect(body.match(/!hooksComplete/g) ?? []).toHaveLength(3)
  })

  it('after the gate the MAX_SPLASH_MS valve is anchored to hooks completion', () => {
    // Otherwise a two-minute login burns the whole budget before
    // createWindow runs and the crossfade fires before the renderer paints.
    expect(src).toContain('hooksCompletedAt ?? splashCreatedAt')
  })

  it('activate cannot conjure the main window around the login', () => {
    expect(src).toContain('getAllWindows().length === 0 && hooksComplete')
  })

  it('a hook-opened window CLOSES the splash — the two never share the screen', () => {
    // User ruling 2026-09-25, replacing the demote-only behaviour: the
    // splash is destroyed in the same tick the login window is created.
    expect(src).toContain('setHookWindowOpenListener')
    expect(src).not.toContain('setAlwaysOnTop(false)')
    const listenerStart = src.indexOf('setHookWindowOpenListener(() => {')
    expect(listenerStart).toBeGreaterThan(-1)
    const listener = src.slice(listenerStart, src.indexOf('\n  })', listenerStart))
    expect(listener).toContain('splashWindow.destroy()')
    expect(listener).toContain('splashWindow = null')
  })

  it('the splash-less fade branch still waits for the main window to paint', () => {
    // After a login closes the splash, a straight fadeInMainWindow() at the
    // timer fire would show the bare background colour — the branch must
    // carry the same gate hold and MAX_SPLASH_MS valve as the painted path.
    const fnStart = src.indexOf('function scheduleSplashFade')
    const body = src.slice(fnStart, src.indexOf('function getResourcePath', fnStart))
    const gone = body.indexOf('!splashWindow || splashWindow.isDestroyed()')
    expect(gone).toBeGreaterThan(-1)
    const branch = body.slice(gone, body.indexOf('if (splashShownAt === null)', gone))
    expect(branch).toContain('if (fadeCompleted) return')
    expect(branch).toContain('mainWindowReadyAt !== null')
    expect(branch).toContain('!hooksComplete')
    expect(branch).toContain('hooksCompletedAt ?? splashCreatedAt')
    expect(branch).toContain('fadeInMainWindow()')
  })
})

describe('hook context wiring', () => {
  it('hooks-runner hands the browser primitive to the hook', () => {
    const runnerSrc = read('src', 'main', 'hooks-runner.ts')
    expect(runnerSrc).toContain('browser: { open: openBuiltInWindow }')
  })

  it('HookContext carries the browser field', () => {
    const typesSrc = read('src', 'shared', 'types', 'hooks.ts')
    expect(typesSrc).toContain('browser: HookBrowserApi')
  })

  it('llm-request does NOT get the browser (per-request path must not open windows)', () => {
    const llmHookSrc = read('src', 'main', 'llm-hook.ts')
    expect(llmHookSrc).not.toContain('browser')
    expect(llmHookSrc).not.toContain('openBuiltInWindow')
  })
})
