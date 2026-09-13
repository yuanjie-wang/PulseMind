// Real-engine smoke for the locator sugar: pure string tests can only assert
// shape, and the internal:* forms are Playwright internals, not a public
// contract — parse/match must be pinned against a live engine. Skips when no
// system Chrome/Edge is present (browser chains stay out of CI by repo
// convention); run on a dev machine with Chrome installed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { playwrightSugar } from '../src/shared/browser-client/playwright-sugar'

const BROWSER_BINARIES = [
  process.env.PULSEMIND_CHROMIUM_PATH,
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform === 'darwin' && '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.platform === 'win32' && 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  process.platform === 'win32' && 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/microsoft-edge',
].filter((p): p is string => !!p && existsSync(p))

describe.skipIf(BROWSER_BINARIES.length === 0)('locator sugar vs a real engine', () => {
  let browser: Browser | null = null
  let page: Page

  beforeAll(async () => {
    for (const channel of ['chrome', 'msedge'] as const) {
      try {
        browser = await chromium.launch({ channel, headless: true })
        break
      } catch {
        /* try the next channel */
      }
    }
    if (!browser) throw new Error('检测到浏览器二进制但启动失败')
    page = await browser.newPage()
    await page.setContent(`
      <button id="login">登录</button>
      <input id="q" placeholder="搜索">
      <label for="u">用户名</label><input id="u">
      <button data-testid="submit-btn">go</button>
      <input type="checkbox" checked>
      <h1>Release summary</h1>
      <div>提交</div>
      <ul><li>one</li><li>two</li></ul>
    `)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  })

  // count() parses the selector against the live engine — an invalid form
  // throws instead of returning 0.
  const count = (selector: string) => page.locator(selector).count()

  it('getByTestId uses the bracketed attr form the testid engine parses', async () => {
    expect(await count(playwrightSugar.getByTestId('submit-btn').selector)).toBe(1)
  })

  it('getByPlaceholder goes through the attr engine', async () => {
    expect(await count(playwrightSugar.getByPlaceholder('搜索').selector)).toBe(1)
  })

  it('role name is substring-insensitive by default and whole-string with the s suffix', async () => {
    expect(await count(playwrightSugar.getByRole('button', { name: '登' }).selector)).toBe(1)
    expect(await count(playwrightSugar.getByRole('button', { name: '登录', exact: true }).selector)).toBe(1)
    expect(await count(playwrightSugar.getByRole('button', { name: '登', exact: true }).selector)).toBe(0)
  })

  it('role boolean attributes parse', async () => {
    expect(await count(playwrightSugar.getByRole('checkbox', { checked: true }).selector)).toBe(1)
  })

  it('label, text (exact + regex) and chained role selectors match', async () => {
    expect(await count(playwrightSugar.getByLabel('用户名').selector)).toBe(1)
    expect(await count(playwrightSugar.getByText('提交', { exact: true }).selector)).toBe(1)
    expect(await count(playwrightSugar.getByText(/release/i).selector)).toBe(1)
    expect(await count(playwrightSugar.getByRole('heading', { level: 1, name: /summary/i }).selector)).toBe(1)
    expect(await count(playwrightSugar.getByRole('list').getByRole('listitem').first().selector)).toBe(1)
  })
})
