// Tests for the hook browser primitive (ctx.browser.open) — the login-flow
// seam for app-start.js. The `electron` module production code imports
// resolves to tests/stubs/electron.ts through the vitest alias, so the
// window registry the stub keeps is the one openBuiltInWindow fills.
//
// The last suite drives the REAL runLaunchHooks: vite-node injects `require`,
// so a real app-start.js on disk runs exactly as it does at launch — open →
// poll (sleep stand-in) → close → return env. Non-vacuity is built in: drop
// `browser:` from the hook context and that hook throws, the runner swallows
// it (by contract), and LOGIN_PROBE comes back undefined.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStubBrowserWindows, getStubExternalOpens, resetStubBrowserWindows, resetStubExternalOpens } from './stubs/electron'
import { openBuiltInWindow } from '../src/main/hook-browser'

// runLaunchHooks resolves the login-shell PATH for real otherwise — a spawned
// login shell, slow and irrelevant to what's under test here.
vi.mock('../src/main/utils/user-path', () => ({
  initUserPath: async () => null,
  getUserPath: () => null,
}))

beforeEach(() => {
  resetStubBrowserWindows()
})

describe('openBuiltInWindow', () => {
  it('opens one window and navigates to the normalized URL', async () => {
    const handle = await openBuiltInWindow('https://EXAMPLE.com/login')
    const windows = getStubBrowserWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0].loadedUrls).toEqual(['https://example.com/login'])
    expect(typeof handle.close).toBe('function')
  })

  it('passes window options through to the constructor', async () => {
    await openBuiltInWindow('https://example.com/', { title: '登录', width: 800, height: 600 })
    const [win] = getStubBrowserWindows()
    expect(win.options).toMatchObject({ title: '登录', width: 800, height: 600, show: true })
    expect(win.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
  })

  it('rejects non-http(s) URLs before creating any window', async () => {
    await expect(openBuiltInWindow('javascript:alert(1)')).rejects.toThrow()
    await expect(openBuiltInWindow('file:///etc/passwd')).rejects.toThrow()
    expect(getStubBrowserWindows()).toHaveLength(0)
  })

  it('close() destroys the window and is idempotent', async () => {
    const handle = await openBuiltInWindow('https://example.com/')
    const [win] = getStubBrowserWindows()
    await handle.close()
    expect(win.isDestroyed()).toBe(true)
    await expect(handle.close()).resolves.toBeUndefined()
  })

  it('close() resolves even when the user already closed the window', async () => {
    const handle = await openBuiltInWindow('https://example.com/')
    const [win] = getStubBrowserWindows()
    win.destroy() // the user hit the titlebar close — 'closed' fired first
    await expect(handle.close()).resolves.toBeUndefined()
  })

  // review 2026-09-26 中3: the login window loads arbitrary remote content,
  // so it carries the same two gates the main window got in P0-2. Before this
  // fix a page-side window.open('smb://…') opened a NEW Electron window or
  // triggered the OS launcher ungated.
  it('denies every window.open but hands safe schemes to the OS launcher', async () => {
    resetStubExternalOpens()
    await openBuiltInWindow('https://example.com/')
    const [win] = getStubBrowserWindows()
    expect(win.openWindow('smb://server/share')).toMatchObject({ action: 'deny' })
    expect(win.openWindow('https://sso.example.com/oauth/callback')).toMatchObject({ action: 'deny' })
    // denied as a window, launched externally — the P0-2 behaviour
    expect(getStubExternalOpens()).toEqual(['https://sso.example.com/oauth/callback'])
    // a scheme the gate refuses never reaches the launcher at all
    expect(win.openWindow('javascript:alert(1)')).toMatchObject({ action: 'deny' })
    expect(getStubExternalOpens()).toEqual(['https://sso.example.com/oauth/callback'])
  })

  it('lets http(s) navigation pass (login redirects) and blocks every other scheme', async () => {
    await openBuiltInWindow('https://example.com/')
    const [win] = getStubBrowserWindows()
    expect(win.navigate('https://sso.example.com/oauth?code=x')).toBe(true)
    expect(win.navigate('http://localhost:8765/done')).toBe(true)
    expect(win.navigate('file:///etc/passwd')).toBe(false)
    expect(win.navigate('javascript:void 0')).toBe(false)
  })
})

describe('runLaunchHooks drives a real app-start.js', () => {
  it('opens the login window through ctx.browser and returns the hook env', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pm-hook-browser-'))
    const hooksDir = join(home, '.pulsemind', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      join(hooksDir, 'app-start.js'),
      [
        'module.exports = async (ctx) => {',
        "  const win = await ctx.browser.open('https://EXAMPLE.com/login')",
        '  // stand-in for the server-side session poll',
        '  await new Promise((resolve) => setTimeout(resolve, 10))',
        '  await win.close()',
        "  return { env: { LOGIN_PROBE: 'ok' } }",
        '}',
        '',
      ].join('\n'),
    )

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      // hook-browser (imported at file top) transitively loads storage/index,
      // which computes HOOKS_DIR from HOME at module load — against the SETUP
      // home. A fresh registry re-evaluates storage under the temp home; the
      // stub comes along so the window assertions read the registry the fresh
      // runner filled (two registries would each see an empty other's windows).
      vi.resetModules()
      const [{ getStubBrowserWindows: freshWindows, resetStubBrowserWindows: freshReset }, runner, { HOOKS_DIR }] = await Promise.all([
        import('./stubs/electron'),
        import('../src/main/hooks-runner'),
        import('../src/main/storage/index'),
      ])
      freshReset()
      // Safety before driving: HOOKS_DIR must be the TEMP home's. A stale
      // module (computed against the real HOME) would otherwise execute the
      // user's own ~/.pulsemind/hooks/app-start.js right here.
      expect(HOOKS_DIR).toBe(join(home, '.pulsemind', 'hooks'))

      await runner.runLaunchHooks()

      expect(runner.getHookEnv().LOGIN_PROBE).toBe('ok')
      const windows = freshWindows()
      expect(windows).toHaveLength(1)
      expect(windows[0].loadedUrls).toEqual(['https://example.com/login'])
      expect(windows[0].isDestroyed()).toBe(true)
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  // review 2026-09-26 中4: a hook stuck on a network黑洞 fetch must not hold
  // the startup gate forever. The watchdog abandons the flow: the gate opens,
  // the login window closes, the orphaned hook's late env never arrives (it
  // was abandoned), and its rejection surfaces nowhere.
  it('the watchdog abandons a hook past its timeout and closes its window', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pm-hook-watchdog-'))
    const hooksDir = join(home, '.pulsemind', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      join(hooksDir, 'app-start.js'),
      [
        'module.exports = async (ctx) => {',
        "  const win = await ctx.browser.open('https://example.com/login')",
        "  await new Promise((resolve) => setTimeout(resolve, 400))",
        "  await win.close()",
        "  return { env: { LOGIN_PROBE: 'late' } }",
        '}',
        'module.exports.timeout = 50',
        '',
      ].join('\n'),
    )

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      vi.resetModules()
      const [{ getStubBrowserWindows: freshWindows, resetStubBrowserWindows: freshReset }, runner] = await Promise.all([
        import('./stubs/electron'),
        import('../src/main/hooks-runner'),
      ])
      freshReset()
      const started = Date.now()
      await runner.runLaunchHooks()
      // The gate opened on the watchdog (50ms), not on the hook's own 400ms.
      expect(Date.now() - started).toBeLessThan(400)
      expect(runner.getHookEnv().LOGIN_PROBE).toBeUndefined()
      const windows = freshWindows()
      expect(windows).toHaveLength(1)
      expect(windows[0].isDestroyed()).toBe(true) // abandoned flow's window is closed
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('skipLaunchHooks releases the gate without waiting for a hung hook', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pm-hook-skip-'))
    const hooksDir = join(home, '.pulsemind', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      join(hooksDir, 'app-start.js'),
      [
        'module.exports = async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 10_000))",
        "  return { env: { LOGIN_PROBE: 'late' } }",
        '}',
        '',
      ].join('\n'),
    )

    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      vi.resetModules()
      const [runner] = await Promise.all([
        import('../src/main/hooks-runner'),
      ])
      const gated = runner.ensureLaunchHooks()
      const settled = { done: false }
      void gated.then(() => { settled.done = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled.done).toBe(false) // the hung hook still holds the gate
      runner.skipLaunchHooks()
      await gated // resolves immediately — the 门期 dialog's 跳过 path
      expect(settled.done).toBe(true)
      expect(runner.getHookEnv().LOGIN_PROBE).toBeUndefined()
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
