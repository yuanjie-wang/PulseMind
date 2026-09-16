/**
 * Workbench 浏览器面板地址栏 probe (real Chromium + real mouse/keyboard).
 *
 * Two things about this address bar are invisible to reading the source and to
 * jsdom, and both have bitten us:
 *
 *   1. Whether typing reaches the input at all. That is a hit-test question —
 *      anything stacked above the row (the chat's own composer, a stray
 *      overlay) swallows the click and the field stays focusless.
 *   2. Whether the row is *live*. The pane's actions are all keyed on the
 *      ACTIVE TAB, so a pane with zero tabs renders a perfectly normal-looking
 *      address bar that discards every keystroke and swallows Enter: a dead
 *      control that promises "输入网址，回车打开".
 *
 * The chrome's own height is measured too — it must equal PANE_CHROME_HEIGHT on
 * the DOM side, because the main process docks the native WebView at exactly
 * that offset. If the DOM rows are taller than the constant, the native view
 * overlaps the bottom of the address bar and the field becomes unclickable for
 * reasons no amount of React debugging will show.
 *
 * Mounts the production surfaces (AppLayout + ChatView + WorkbenchPane, the
 * real stores and the real i18n), stubs electronAPI, and never talks to an LLM
 * or to a real browser session.
 *
 * Usage: node scripts/probe-browser-pane.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-pane-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-pane-shots')

const CONV_KEY = 'conv_20260916190000'
/** Matches the dock: ChatView's top offset inside the window content area. */
const TITLE_BAR_HEIGHT = 56
/** Must equal src/shared/browser/pane.ts PANE_CHROME_HEIGHT. */
const PANE_CHROME_HEIGHT = 100

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useBrowserPaneStore } from './src/renderer/src/stores/browserPaneStore'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'

const CONV = { key: '${CONV_KEY}', label: '浏览器任务', updatedAt: '2026-09-16T19:00:00.000Z' }

let root = null
window.__mount = ({ tabs, activeTab = 'browser' } = {}) => {
  if (root) root.unmount()
  useBrowserPaneStore.getState().setUpdate({
    visible: tabs.length > 0,
    width: 420,
    conversationId: '${CONV_KEY}',
    tabs,
  })
  useWorkbenchStore.getState().openTab('${CONV_KEY}', activeTab)
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AppLayout
            conversations={[CONV]}
            activeConversationKey={'${CONV_KEY}'}
            totalSessions={1}
            autoCleanup={true}
            onCreateNew={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onTogglePinConversation={() => {}}
          >
            <ChatView
              messages={[
                { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: '2026-09-16T19:00:00.000Z' },
              ]}
              conversationId={'${CONV_KEY}'}
              conversations={[CONV]}
              isRequesting={false}
              agentStatus={{ status: 'idle' }}
              streamingBlocks={[]}
              hasApiKey={true}
              onSendMessage={() => {}}
              onCancel={() => {}}
              onApproveTool={() => {}}
              onRejectTool={() => {}}
              onClearError={() => {}}
              onOpenConversation={() => {}}
            />
          </AppLayout>
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}

window.__actions = []
window.__CONV_KEY = '${CONV_KEY}'
window.__setTab = (tab) => { useWorkbenchStore.getState().setActiveTab(tab); return true }
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.PROBE_DEV ? 'development' : 'production'), __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: AppLayout reads electronAPI at module scope, and the pane
// store subscribes at import time (so the subscription must exist up front).
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'browserPaneAction' ? (action) => { window.__actions.push(action); return Promise.resolve() }
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: 'zh',
        })
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const ADDRESS = 'input[placeholder="输入网址，回车打开"]'
const address = () => page.locator(ADDRESS)
const shot = async (name) => page.screenshot({ path: join(SHOTS, name) })

const TABS = [
  { id: 'tab_probe_1', url: 'https://example.com/', title: 'Example', active: false },
  { id: 'tab_probe_2', url: 'https://www.baidu.com/', title: '百度一下', active: true },
]

/* ── 1. A pane with a live tab: the row is clickable, typable, and Enter
        reaches main as one navigate action. ────────────────────────────── */
await page.evaluate((tabs) => window.__mount({ tabs }), TABS)
await address().waitFor()

const box = await address().boundingBox()
const hit = await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y)
  return { tag: el?.tagName ?? null, placeholder: el?.getAttribute?.('placeholder') ?? null }
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
check('the address bar hit-tests to itself (nothing stacks above it)', hit.tag === 'INPUT', `${hit.tag} placeholder=${hit.placeholder}`)

check('the address bar shows the active tab URL', (await address().inputValue()) === 'https://www.baidu.com/', await address().inputValue())

// Geometry: the rows above the native WebView must total PANE_CHROME_HEIGHT.
const geom = await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="输入网址，回车打开"]')
  const row = input.parentElement
  // The pane root is the first ancestor that also carries the workbench's own
  // tool-tab strip — that, not a fixed hop count, is what makes the measured
  // offset the same thing the main-process dock measures against.
  let pane = row
  while (pane && !(pane.textContent || '').includes('工作区')) pane = pane.parentElement
  const paneTop = pane.getBoundingClientRect().top
  const rowBottom = row.getBoundingClientRect().bottom
  return { paneTop, rowBottom, chromeHeight: rowBottom - paneTop }
})
check(
  `the chrome the native WebView docks below is exactly PANE_CHROME_HEIGHT (${PANE_CHROME_HEIGHT}px)`,
  Math.round(geom.chromeHeight) === PANE_CHROME_HEIGHT,
  `measured ${geom.chromeHeight}px`,
)
check(
  'the pane starts at TITLE_BAR_HEIGHT below the viewport top',
  Math.round(geom.paneTop) === TITLE_BAR_HEIGHT,
  `paneTop=${geom.paneTop}`,
)
check(
  'the dock offset (pane top + chrome) is where the address row ends — no overlap',
  Math.round(geom.rowBottom) === TITLE_BAR_HEIGHT + PANE_CHROME_HEIGHT,
  `rowBottom=${geom.rowBottom} vs ${TITLE_BAR_HEIGHT + PANE_CHROME_HEIGHT}`,
)

// Typing: select-all then type, the way a user replacing an address does.
await address().click()
await page.keyboard.press('Control+A')
await page.keyboard.press('Meta+A')
await page.keyboard.type('example.com')
check('typing shows in the address bar', (await address().inputValue()) === 'example.com', await address().inputValue())
await shot('pane-with-tab.png')
await page.evaluate(() => { window.__actions = [] })
await page.keyboard.press('Enter')
await page.waitForTimeout(150)
const navActions = await page.evaluate(() => window.__actions)
check(
  'Enter sends exactly one navigate action, scheme completed',
  navActions.length === 1 && navActions[0].op === 'navigate' && navActions[0].tabId === 'tab_probe_2' && navActions[0].url === 'https://example.com',
  JSON.stringify(navActions),
)

/* ── 2. A pane with NO tab: the row must still be usable — typing takes, and
        Enter opens a tab instead of being swallowed. ───────────────────── */
await page.evaluate(() => window.__mount({ tabs: [] }))
await address().waitFor()
await address().click()
await page.keyboard.type('mail.163.com')
const typedNoTab = await address().inputValue()
check('typing works in a pane with no tab yet', typedNoTab === 'mail.163.com', `value=${JSON.stringify(typedNoTab)}`)
await shot('pane-no-tab.png')
await page.evaluate(() => { window.__actions = [] })
await page.keyboard.press('Enter')
await page.waitForTimeout(150)
const noTabActions = await page.evaluate(() => window.__actions)
check(
  'Enter in a pane with no tab sends a navigate the service can turn into a new tab',
  noTabActions.length === 1 && noTabActions[0].op === 'navigate' && noTabActions[0].url === 'https://mail.163.com' && !noTabActions[0].tabId,
  JSON.stringify(noTabActions),
)

/* ── 2. A fresh tab sits on about:blank: the field must read EMPTY, and
        typing must replace. "about:blank" + typed text passes the URL
        whitelist untouched (about: is allowed) and then dies silently in
        goto — the exact silent failure the address bar must not have. ──── */
await page.evaluate(() => window.__mount({ tabs: [{ id: 'tab_fresh', url: 'about:blank', title: '', active: true }] }))
await address().waitFor()
const freshValue = await address().inputValue()
check('a fresh about:blank tab shows an empty address bar (placeholder, not the scheme)', freshValue === '', JSON.stringify(freshValue))
await address().click()
await page.keyboard.type('mail.163.com')
check('typing into a fresh tab starts from the typed text (no about:blank concatenation)', (await address().inputValue()) === 'mail.163.com', await address().inputValue())
await page.evaluate(() => { window.__actions = [] })
await page.keyboard.press('Enter')
await page.waitForTimeout(150)
const freshNav = await page.evaluate(() => window.__actions)
check(
  'Enter navigates the fresh tab to the completed host',
  freshNav.length === 1 && freshNav[0].op === 'navigate' && freshNav[0].tabId === 'tab_fresh' && freshNav[0].url === 'https://mail.163.com',
  JSON.stringify(freshNav),
)

/* ── 3. Focusing a filled field selects the whole address — the omnibox
        rule. Without it, typing a new address appends to the old one. ──── */
await page.evaluate((tabs) => window.__mount({ tabs }), TABS)
await address().waitFor()
await address().click()
await page.keyboard.type('example.org')
check('focusing the field selects the address, so typing replaces it', (await address().inputValue()) === 'example.org', await address().inputValue())

/* ── 4. Other tool tabs: the browser chrome (and with it the native-view
        dock offset) only exists on the browser tab. ─────────────────────── */
await page.evaluate((tabs) => window.__mount({ tabs, activeTab: 'plan' }), TABS)
await page.waitForTimeout(150)
// The browser-tab auto-open funnel fires when the tab count goes 0→N, which is
// correct behaviour — switch away afterwards to test the view switch itself.
await page.evaluate(() => window.__setTab('plan'))
await page.waitForTimeout(120)
check('the address bar is not rendered on a non-browser workbench tab', (await address().count()) === 0)
await page.evaluate(() => window.__setTab('browser'))
await address().waitFor()
check('switching back to the browser tab brings the address bar back', (await address().count()) === 1)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
await browser.close()
process.exit(failed.length ? 1 : 0)
