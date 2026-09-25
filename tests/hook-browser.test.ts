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
import { getStubBrowserWindows, resetStubBrowserWindows } from './stubs/electron'
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
      const runner = await import('../src/main/hooks-runner')
      const { HOOKS_DIR } = await import('../src/main/storage/index')
      // Safety before driving: HOOKS_DIR must be the TEMP home's. A stale
      // module (computed against the real HOME) would otherwise execute the
      // user's own ~/.pulsemind/hooks/app-start.js right here.
      expect(HOOKS_DIR).toBe(join(home, '.pulsemind', 'hooks'))

      await runner.runLaunchHooks()

      expect(runner.getHookEnv().LOGIN_PROBE).toBe('ok')
      const windows = getStubBrowserWindows()
      expect(windows).toHaveLength(1)
      expect(windows[0].loadedUrls).toEqual(['https://example.com/login'])
      expect(windows[0].isDestroyed()).toBe(true)
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
