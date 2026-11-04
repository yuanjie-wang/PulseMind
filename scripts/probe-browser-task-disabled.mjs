/**
 * Browser-task panel DISABLED probe (real Chromium) — 2026-11-04 用户裁定
 * 「输出框还是要显示的，只是禁用」（澄清：浏览器模式的 URL 输入框）
 *
 * The browser arm of the welcome page used to vanish entirely when no API key
 * was configured (`hasApiKey ? <BrowserTaskPanel/> : null`), leaving only the
 * key guide — the user could no longer see what this mode even does. The panel
 * now mounts unconditionally and the panel itself goes read-only:
 *
 *   - URL input present but disabled (and it must NOT grab focus — a disabled
 *     input cannot be focused anyway, and the key guide is the thing to see)
 *   - open button disabled
 *   - history rows readable but inert: no `start()` on click, no hover wash,
 *     `cursor: default` (the guard alone would still look clickable)
 *   - the key guide below carries the way out
 *
 * Source wiring is pinned in tests/workbench-primary-mode.test.ts; this probe
 * verifies the DOM/state facts in a real layout, including the enabled control
 * (same panel, same assertions inverted).
 *
 * Usage: node scripts/probe-browser-task-disabled.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(mkdtempSync(join(tmpdir(), 'pm-browser-disabled-shots-')), 'shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-browser-task-disabled-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'

const NOW = Date.UTC(2026, 10, 4, 8, 0, 0)
const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  getConversationLastUserMessage: '',
  getPlatformInfo: { platform: 'darwin' },
  browserHistoryQuery: [
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', visitCount: 3, lastVisitAt: NOW - 3600 * 1000 },
    { url: 'https://example.org/docs/very/long/path?with=query', title: null, visitCount: 1, lastVisitAt: NOW - 7200 * 1000 },
  ],
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    return Promise.resolve(TABLE[key])
  },
})

const EMPTY = []
const IDLE = { status: 'idle' }
window.__starts = []

function Shell({ hasApiKey }) {
  return (
    <div style={{ display: 'flex', height: 900 }}>
      <div id="chat-host" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <ChatView
          messages={EMPTY}
          isRequesting={false}
          agentStatus={IDLE}
          streamingBlocks={EMPTY}
          hasApiKey={hasApiKey}
          onSendMessage={() => {}}
          onBrowserTaskStart={(url) => { window.__starts.push(url) }}
          onCancel={() => {}} onApproveTool={() => {}} onRejectTool={() => {}}
          onClearError={() => {}}
          conversations={EMPTY}
          onOpenConversation={() => {}}
        />
      </div>
    </div>
  )
}

let root = null
window.__mount = (hasApiKey) => {
  if (root) root.unmount()
  const host = document.createElement('div')
  host.id = 'case-chat'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><Shell hasApiKey={hasApiKey} /></TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

window.__stores = { newTask: useNewTaskStore }
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.web.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.bringToFront()

// ── helpers ──
const mount = (hasApiKey) => page.evaluate((k) => window.__mount(k), hasApiKey)
const setMode = (mode) => page.evaluate((m) => window.__stores.newTask.getState().setMode(m), mode)
const starts = () => page.evaluate(() => window.__starts.length)
const state = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-pm-browser-task-panel]')
    const input = document.querySelector('[data-pm-browser-task-panel] input')
    const openBtn = panel ? panel.querySelector('button.ant-btn') : null
    const rows = [...document.querySelectorAll('[data-pm-browser-task-history-item]')]
    return {
      panel: panel !== null,
      urlHook: document.querySelector('[data-pm-browser-task-url]') !== null,
      inputPresent: input !== null,
      inputDisabled: input ? input.disabled : null,
      inputValue: input ? input.value : null,
      inputFocused: document.activeElement === input,
      openDisabled: openBtn ? openBtn.disabled : null,
      openLabel: openBtn ? openBtn.getAttribute('aria-label') : null,
      historyCard: document.querySelector('[data-pm-browser-task-history]') !== null,
      rows: rows.length,
      rowsDisabled: rows.every((r) => r.hasAttribute('data-disabled')),
      rowCursors: rows.map((r) => getComputedStyle(r).cursor),
      guide: document.querySelector('[data-pm-api-key-guide]') !== null,
      composer: document.querySelector('.ant-sender textarea') !== null,
    }
  })

console.log('\n§0 进入浏览器形态的 welcome（未配置密钥）')
await mount(false)
await page.waitForTimeout(200)
await setMode('browser')
await page.waitForTimeout(500)
let s = await state()
check('browser welcome 渲染了任务面板', s.panel, JSON.stringify(s))
check('URL 输入框仍在(不是整块退场)', s.inputPresent && s.urlHook)
check('输入框被禁用', s.inputDisabled === true, String(s.inputDisabled))
check('禁用态不抢焦点(autoFocus 关)', !s.inputFocused)
check('打开按钮被禁用', s.openDisabled === true, String(s.openDisabled))
check('近期访问卡在(可读的引导)', s.historyCard && s.rows >= 2, `card=${s.historyCard} rows=${s.rows}`)
check('历史行都带禁用标记', s.rowsDisabled)
check(
  '历史行指针是 default(不是 pointer)',
  s.rowCursors.every((c) => c === 'default'),
  s.rowCursors.join(','),
)
check('下方有密钥引导卡(给出处)', s.guide)
check('无密钥时自由输入框不入场(既有裁定不变)', !s.composer)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '1-disabled.png') })

console.log('\n§1 禁用态真的不可用：键盘、打开钮、历史行都不提交')
// 点输入框 + 打字：disabled 的 input 拿不到焦点，按键无处可落。
await page.locator('[data-pm-browser-task-panel] input').first().click({ force: true })
await page.keyboard.type('example.com')
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
let m = await state()
check('打字进不去(值为空且仍未聚焦)', m.inputValue === '' && !m.inputFocused, JSON.stringify({ v: m.inputValue, f: m.inputFocused }))
check('回车没有开任务', (await starts()) === 0, String(await starts()))

// 打开按钮真点击（Playwright 会因 disabled 拒绝普通点击——用 force 确认它
// 即便被点到也不派发）。
await page.locator('[data-pm-browser-task-panel] button.ant-btn').first().click({ force: true })
await page.waitForTimeout(200)
check('点打开钮没有开任务', (await starts()) === 0, String(await starts()))

// 历史行真鼠标点击（坐标点，穿透 disable 的 style 层）。
const row = page.locator('[data-pm-browser-task-history-item]').first()
check('历史行可见', await row.isVisible())
await row.click({ force: true })
await page.waitForTimeout(200)
check('点历史行没有开任务', (await starts()) === 0, String(await starts()))
const rowBg = await page.evaluate(() => {
  const r = document.querySelector('[data-pm-browser-task-history-item]')
  return r ? getComputedStyle(r).backgroundColor : null
})
check('历史行 hover 不给 hover 底色(本来也不该看起来可点)', rowBg === 'rgba(0, 0, 0, 0)' || rowBg === 'transparent', rowBg)

console.log('\n§2 有密钥的对照态：同一面板全部恢复')
await mount(true)
await page.waitForTimeout(200)
await setMode('browser')
await page.waitForTimeout(500)
s = await state()
check('面板在', s.panel)
check('输入框可用', s.inputDisabled === false, String(s.inputDisabled))
check('输入框自动聚焦(可用态才抢焦点)', s.inputFocused)
check('打开钮可用', s.openDisabled === false, String(s.openDisabled))
check('历史行没有禁用标记', s.rows >= 2 && !s.rowsDisabled)
check(
  '历史行指针是 pointer',
  s.rowCursors.every((c) => c === 'pointer'),
  s.rowCursors.join(','),
)
check('密钥引导卡退场', !s.guide)

// 回车走归一化：example.com → https://example.com
const input = page.locator('[data-pm-browser-task-panel] input').first()
await input.fill('example.com')
await input.press('Enter')
await page.waitForTimeout(200)
let list = await page.evaluate(() => window.__starts)
check('回车开启任务且 URL 归一化', list.length === 1 && list[0] === 'https://example.com', JSON.stringify(list))

// 打开钮点当前输入值
await input.fill('https://news.ycombinator.com')
await page.locator('[data-pm-browser-task-panel] button.ant-btn').first().click()
await page.waitForTimeout(200)
list = await page.evaluate(() => window.__starts)
check('点打开钮提交当前输入', list.length === 2 && list[1] === 'https://news.ycombinator.com', JSON.stringify(list))

// 历史行点自身 URL
await page.locator('[data-pm-browser-task-history-item]').first().click()
await page.waitForTimeout(200)
list = await page.evaluate(() => window.__starts)
check('点历史行打开该条 URL', list.length === 3 && list[2] === 'https://news.ycombinator.com/', JSON.stringify(list))
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '2-enabled.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
