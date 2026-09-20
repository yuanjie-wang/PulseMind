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
// The browser pane chrome is migrated onto the theme sheet (PLAN-dark-mode
// M3/T5), so the page needs the variable table injected before it renders.
// Light is pinned explicitly; the dark column belongs to probe-theme-dark.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')
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
window.__paneStore = useBrowserPaneStore
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
  content: `window.__historyFixture = [];
    window.__historyQueries = [];
    window.__historyCleared = 0;
    window.__paneStates = [];
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'browserPaneAction' ? (action) => { window.__actions.push(action); return Promise.resolve() }
      : key === 'browserHistoryQuery' ? (text) => { window.__historyQueries.push(text); return Promise.resolve(window.__historyFixture) }
      : key === 'browserHistoryClear' ? () => { window.__historyCleared += 1; window.__historyFixture = []; return Promise.resolve() }
      : key === 'browserPaneSetState' ? (state) => { window.__paneStates.push(state); return Promise.resolve() }
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
  // The 36px ROW (it carries the row's border-bottom) — the input now sits in
  // an inner flex wrapper that stretches, so parentElement is no longer the row.
  const row = input.closest('div[style*="border-bottom"]')
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

/* ── 1b. Optimistic highlight (T1.1): the click paints in the same frame —
        no IPC event, no snapshot, just the click. The probe's stubbed bridge
        never delivers a snapshot after an action, so any movement here is the
        optimistic id working. Switch timing is recorded informationally. ── */
await page.evaluate((tabs) => window.__mount({ tabs }), TABS)
await address().waitFor()
const optimistic = await page.evaluate(() => new Promise((resolve) => {
  const tab = document.querySelector('div[title="Example"]')
  if (!tab) { resolve(null); return }
  const before = getComputedStyle(tab).fontWeight
  const t0 = performance.now()
  tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // Same frame, before any paint or event await — React's scheduled render
  // from the zustand write completes in a microtask, i.e. before this runs.
  requestAnimationFrame(() => {
    resolve({ before, after: getComputedStyle(tab).fontWeight, ms: performance.now() - t0 })
  })
}))
check(
  'clicking the inactive tab moves the highlight within the same frame (optimistic)',
  !!optimistic && optimistic.before === '400' && optimistic.after === '600',
  optimistic ? `fontWeight ${optimistic.before}→${optimistic.after} in ${optimistic.ms.toFixed(1)}ms (informational)` : 'tab not found',
)
await page.evaluate((tabs) => {
  // Main's authoritative snapshot arrives: the optimistic id must clear and
  // the highlight return to the snapshot's active tab (main is the truth).
  window.__paneStore.getState().setUpdate({ visible: true, width: 420, conversationId: window.__CONV_KEY, tabs })
}, TABS)
const snapshotWeight = await page.evaluate(() => getComputedStyle(document.querySelector('div[title="百度一下"]')).fontWeight)
check('main\'s snapshot clears the optimistic id (main is the source of truth)', snapshotWeight === '600', `百度一下 fontWeight=${snapshotWeight}`)

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

/* ── 5. Tab-strip overflow (T2): shrink-to-floor, wheel-to-scroll, active
        tab auto-revealed — with the 32/36 geometry contract intact. ────── */
const MANY_TABS = Array.from({ length: 8 }, (_, i) => ({
  id: `tab_many_${i + 1}`,
  url: `https://site${i + 1}.example/`,
  title: `第${i + 1}个标签页标题较长`,
  active: i === 0,
}))
await page.evaluate((tabs) => window.__mount({ tabs }), MANY_TABS)
await address().waitFor()

const strip = () => page.evaluate(() => {
  const el = document.querySelector('.pm-pane-tabstrip')
  if (!el) return null
  const r = el.getBoundingClientRect()
  // The 32px contract lives on the strip ROW (the scroller's parent); the
  // scroller itself is content-height inside it.
  const row = el.parentElement.getBoundingClientRect()
  return {
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft, top: r.top, height: r.height,
    rowHeight: row.height,
  }
})

let st = await strip()
check('8 tabs overflow the strip (it scrolls instead of clipping)', st && st.scrollWidth > st.clientWidth, `scrollWidth=${st?.scrollWidth} clientWidth=${st?.clientWidth}`)
check('…and the strip row is still exactly 32px tall (PANE_CHROME_HEIGHT contract)', st && Math.round(st.rowHeight) === 32, `rowHeight=${st?.rowHeight}`)

await page.locator('.pm-pane-tabstrip').hover()
await page.mouse.wheel(0, 240)
await page.waitForTimeout(80)
st = await strip()
check('a vertical wheel gesture scrolls the strip horizontally', st && st.scrollLeft > 0, `scrollLeft=${st?.scrollLeft}`)

// Make the LAST tab active the way main does — via a snapshot. The auto-reveal
// effect must scroll it fully into view; scrollIntoView would have chained to
// the outer scroll containers, so this also pins the manual-scrollLeft rule.
await page.evaluate((tabs) => {
  const revealed = tabs.map((t, i) => ({ ...t, active: i === tabs.length - 1 }))
  window.__paneStore.getState().setUpdate({ visible: true, width: 420, conversationId: window.__CONV_KEY, tabs: revealed })
}, MANY_TABS)
await page.waitForTimeout(120)
st = await strip()
const reveal = await page.evaluate(() => {
  const stripEl = document.querySelector('.pm-pane-tabstrip')
  const tab = [...stripEl.querySelectorAll('[data-tab-id]')].pop()
  const sr = stripEl.getBoundingClientRect()
  const tr = tab.getBoundingClientRect()
  return {
    fullyVisible: tr.left >= sr.left - 0.5 && tr.right <= sr.right + 0.5,
    atRightEdge: Math.abs(tr.right - sr.right) < 2,
    hitIsTab: (() => {
      const el = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2)
      return el === tab || tab.contains(el)
    })(),
  }
})
check('activating the last tab auto-reveals it fully inside the strip', reveal.fullyVisible && reveal.atRightEdge, JSON.stringify(reveal))
check('…and a real hit-test at its centre finds the tab (nothing clipped)', reveal.hitIsTab)

/* ── 6. Address-bar history dropdown (T3.5/T3.6): fixture rows from the
        (stubbed) query channel drive the panel; ↑↓+Enter walk it, Esc is
        two-stage, the footer clears with a confirm step, and the open
        dropdown reports its height so main can shift the webview. ──────── */
const DROPDOWN_ROW = '.pm-pane-tabstrip, div'
const suggestionItems = () => page.locator('div[style*="z-index: 40"] > div > div')
await page.evaluate(() => {
  window.__historyFixture = [
    { url: 'https://mail.163.com/', title: '网易邮箱', visitCount: 3, lastVisitAt: 30 },
    { url: 'https://github.com/', title: 'GitHub', visitCount: 1, lastVisitAt: 10 },
  ]
  window.__actions = []
  window.__historyCleared = 0
  window.__paneStates = []
})
await page.evaluate((tabs) => window.__mount({ tabs }), TABS)
await address().waitFor()

await address().click()
await page.keyboard.type('m')
await page.locator('div[style*="z-index: 40"]').waitFor()
const rowCount = await suggestionItems().count()
check('typing opens the dropdown with matching history rows', rowCount === 2, `${rowCount} rows`)

const firstBg = await suggestionItems().nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)
await page.keyboard.press('ArrowDown')
const secondBg = await suggestionItems().nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)
check('ArrowDown moves the selection (row highlight moves)', firstBg !== secondBg, `${firstBg} → ${secondBg}`)

await page.keyboard.press('ArrowDown') // wrap to the second row
await page.keyboard.press('Enter')
await page.waitForTimeout(100)
const walked = await page.evaluate(() => window.__actions)
check(
  'Enter opens the walked-to suggestion (its url already carries the scheme)',
  walked.length === 1 && walked[0].op === 'navigate' && walked[0].url === 'https://github.com/' && walked[0].tabId === 'tab_probe_2',
  JSON.stringify(walked),
)
check('…and the dropdown closed', (await page.locator('div[style*="z-index: 40"]').count()) === 0)

// Esc: first press closes the dropdown, second clears the field.
await address().click()
await page.keyboard.press('Meta+A')
await page.keyboard.type('ma')
await page.locator('div[style*="z-index: 40"]').waitFor()
await page.keyboard.press('Escape')
check('first Esc closes the dropdown but keeps the typed text', (await page.locator('div[style*="z-index: 40"]').count()) === 0 && (await address().inputValue()) === 'ma', `value=${await address().inputValue()}`)
await page.keyboard.press('Escape')
// 清空的是 draft：有激活页签时字段回到该页签自己的地址（无页签才是空串）。
const clearedTo = await address().inputValue()
check('second Esc clears the draft (field reverts to the active tab\'s url)', clearedTo === 'https://www.baidu.com/', `value=${JSON.stringify(clearedTo)}`)

// Clear footer: one click arms the confirm, the second fires it.
await address().click()
await page.keyboard.press('Meta+A')
await page.keyboard.type('mail')
await page.locator('div[style*="z-index: 40"]').waitFor()
const footer = page.locator('div[style*="z-index: 40"] > div:last-child')
await footer.click()
check('the clear footer first asks for confirmation', (await footer.textContent())?.includes('确认清除'), await footer.textContent())
await footer.click()
await page.waitForTimeout(80)
const clearedCount = await page.evaluate(() => window.__historyCleared)
check('the confirmed click clears the history through the channel', clearedCount === 1, `clears=${clearedCount}`)
check('…and the dropdown closes afterwards', (await page.locator('div[style*="z-index: 40"]').count()) === 0)

const overlayPush = await page.evaluate(() => window.__paneStates.some((s) => s.chromeOverlayHeight > 0))
check('an open dropdown reports its height so main shifts the webview', overlayPush)

/* ── 6b. 用户复现（2026-09-17）：原样重输刚去过的完整网址（带 scheme）必须
   出联想。SQL LIKE 能查到该行，但 rankHistorySuggestions 此前只拿 scheme-less
   的存储 URL 比对，把它过滤光 → 下拉不弹（fixture 用用户库的真实行形状）。 ── */
await page.evaluate(() => {
  window.__historyFixture = [
    { url: 'https://www.baidu.com/', title: '百度一下，你就知道', visitCount: 2, lastVisitAt: 99 },
  ]
  window.__actions = []
})
await address().click()
await page.keyboard.press('Meta+A')
await page.keyboard.type('https://www.baidu.com')
await page.locator('div[style*="z-index: 40"]').waitFor({ timeout: 3000 }).catch(() => {})
const reproRows = await suggestionItems().count()
check('re-typing the visited full URL (with scheme) still suggests it', reproRows === 1, `${reproRows} rows`)
await page.keyboard.press('ArrowDown') // 选中条目再 Enter —— 无选中时 Enter 按原文导航（另一条路径）
await page.keyboard.press('Enter')
await page.waitForTimeout(100)
const reproNav = await page.evaluate(() => window.__actions)
check(
  'Enter on the full-URL suggestion navigates to it',
  reproNav.length === 1 && reproNav[0].op === 'navigate' && reproNav[0].url === 'https://www.baidu.com/',
  JSON.stringify(reproNav),
)

/* ── 7. Empty state (T4.4): zero tabs or a fresh about:blank tab shows the
   new-tab empty state — guidance copy + 最近访问 fed by the SAME query
   channel (the stub serves it); main folds the webview for both states
   (asserted over in probe-pane-actions). ─────────────────────────────────── */
const EMPTY_COPY = '打开一个网页，或让 AI 帮你查资料'
await page.evaluate(() => {
  window.__historyFixture = [
    { url: 'https://github.com/', title: 'GitHub', visitCount: 5, lastVisitAt: 77 },
    { url: 'https://news.example/', title: null, visitCount: 1, lastVisitAt: 55 },
  ]
  window.__actions = []
})
await page.evaluate(() => window.__mount({ tabs: [] }))
check('a pane with no tab shows the empty state', await page.getByText(EMPTY_COPY).isVisible().catch(() => false))
const emptyRows = await page.locator('[data-pm-empty-item]').count()
check('…with the recents list rendered from history', emptyRows === 2, `${emptyRows} rows`)
check('…a titleless row falls back to its host', (await page.locator('[data-pm-empty-item]').nth(1).textContent())?.includes('news.example'), await page.locator('[data-pm-empty-item]').nth(1).textContent())
await page.locator('[data-pm-empty-item]').first().click()
await page.waitForTimeout(100)
const emptyNav = await page.evaluate(() => window.__actions)
check(
  'clicking a recents row navigates (no tabId — main opens the tab)',
  emptyNav.length === 1 && emptyNav[0].op === 'navigate' && emptyNav[0].url === 'https://github.com/' && !emptyNav[0].tabId,
  JSON.stringify(emptyNav),
)

/* ── 7b. The recents block is a centred surface (user feedback 2026-09-17:
   「最近访问 视觉上重心靠左」). With no visible box, a 280px column of
   left-aligned rows under centred icon+copy reads as ink hanging off the
   left — the box already was centred, so "centred" cannot be reviewed from
   the box alone; the surface is what makes the centring visible. Pins the
   light-grey rounded background, the centring, the row inset (a hover fill
   must not touch a corner) and the label sharing the rows' text edge. ───── */
const cardGeo = await page.evaluate(() => {
  const empty = document.querySelector('[data-pm-empty]')
  const card = document.querySelector('[data-pm-empty-recents]')
  if (!empty || !card) return null
  const rgbOf = (s) => (s.match(/[\d.]+/g) ?? []).map(Number)
  const lum = (a) => a[0] * 0.299 + a[1] * 0.587 + a[2] * 0.114
  // The nearest ancestor that actually paints is the pane body (now #fff —
  // the user's ruling of 2026-09-17 made the whole pane white).
  let backdrop = null
  for (let n = empty.parentElement; n && !backdrop; n = n.parentElement) {
    const m = rgbOf(getComputedStyle(n).backgroundColor)
    if (m.length >= 3 && (m.length < 4 || m[3] > 0)) backdrop = m.slice(0, 3)
  }
  const e = empty.getBoundingClientRect()
  const c = card.getBoundingClientRect()
  const cs = getComputedStyle(card)
  const pad = parseFloat(getComputedStyle(empty).paddingLeft) || 0
  const row = card.querySelector('[data-pm-empty-item]')
  const label = [...card.children].find((el) => el.textContent?.startsWith('最近访问'))
  const rgb = rgbOf(cs.backgroundColor)
  const rowPadLeft = row ? parseFloat(getComputedStyle(row).paddingLeft) || 0 : -1
  return {
    gapLeft: c.left - (e.left + pad),
    gapRight: e.right - pad - c.right,
    width: c.width,
    radius: parseFloat(cs.borderRadius) || 0,
    bg: cs.backgroundColor,
    rgb,
    chroma: rgb.length === 3 ? Math.max(...rgb) - Math.min(...rgb) : 99,
    dLum: backdrop && rgb.length === 3 ? lum(rgb) - lum(backdrop) : 0,
    rowInset: row ? row.getBoundingClientRect().left - c.left : -1,
    labelInset: label ? label.getBoundingClientRect().left - c.left : -1,
    rowTextInset: row ? row.getBoundingClientRect().left + rowPadLeft - c.left : -1,
  }
})
const g = cardGeo
// The pane body is white in every folded state (user ruling 2026-09-17:
// 「把页面整体背景色改为白色」). Pinned because the empty state is its only
// reader: with a page mounted the native WebView covers it, so a leftover
// grey would only ever show up here — and grey-on-white is what a stale
// value looks like.
const paneBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-pm-pane]')).backgroundColor)
check('the pane body itself is white', paneBg === 'rgb(255, 255, 255)', paneBg)
check('the recents block paints its own surface', Boolean(g) && g.rgb.length >= 3 && (g.rgb.length < 4 || g.rgb[3] > 0), g?.bg)
check(
  '…horizontally centred in the empty area',
  Boolean(g) && Math.abs(g.gapLeft - g.gapRight) <= 1,
  g && `left ${g.gapLeft.toFixed(1)} vs right ${g.gapRight.toFixed(1)}`,
)
check(
  '…light grey: near-neutral, a touch darker than the pane body',
  Boolean(g) && g.chroma <= 4 && g.dLum < -3 && g.dLum > -26,
  g && `${g.bg} chroma ${g.chroma} Δlum ${g.dLum.toFixed(1)}`,
)
check('…rounded', Boolean(g) && g.radius >= 8, String(g?.radius))
// border-box: the 6px padding is INSIDE the 280 — a content-box card would
// paint 292 wide and eat the empty area's margin.
check('…280px wide: the padding sits inside the box, not outside it', Boolean(g) && Math.abs(g.width - 280) <= 1, String(g?.width))
// Hit-testing honours border-radius, so the corner point proves the SHAPE the
// user sees — 10px in the computed style would still be square if the paint
// were clipped elsewhere. The inside point is the non-vacuous half.
const cornerHit = await page.evaluate(() => {
  const card = document.querySelector('[data-pm-empty-recents]')
  const c = card.getBoundingClientRect()
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y)
    return el === card || card.contains(el)
  }
  return { corner: hit(c.left + 1.5, c.top + 1.5), inside: hit(c.left + 12, c.top + 12) }
})
check('…and the corners really are cut (a hit-test at the corner misses the card)', cornerHit.corner === false, JSON.stringify(cornerHit))
check('…while 12px in lands on it (the region is painted, not empty)', cornerHit.inside === true, JSON.stringify(cornerHit))
check('…with the rows inset inside it (a hover fill stays off the corners)', Boolean(g) && g.rowInset >= 4, String(g?.rowInset))
check(
  '…and the 最近访问 label sharing the rows\' text edge',
  Boolean(g) && Math.abs(g.labelInset - g.rowTextInset) <= 1,
  g && `label ${g.labelInset} vs text ${g.rowTextInset}`,
)
// The hover fill must stay distinguishable from the card it sits on — equal
// values would make a hovered row read as nothing happening at all.
await page.locator('[data-pm-empty-item]').first().hover()
await page.waitForTimeout(60)
const rowHover = await page.evaluate(() => {
  const row = document.querySelector('[data-pm-empty-item]')
  const card = document.querySelector('[data-pm-empty-recents]')
  const rgbOf = (s) => (s.match(/[\d.]+/g) ?? []).map(Number)
  const lum = (a) => a[0] * 0.299 + a[1] * 0.587 + a[2] * 0.114
  return {
    hover: getComputedStyle(row).backgroundColor,
    card: getComputedStyle(card).backgroundColor,
    dLum: lum(rgbOf(getComputedStyle(row).backgroundColor)) - lum(rgbOf(getComputedStyle(card).backgroundColor)),
  }
})
check(
  'a hovered row darkens against the card (a real mouse, no navigation)',
  rowHover.dLum < -4 && rowHover.dLum > -26,
  `${rowHover.hover} on ${rowHover.card} Δlum ${rowHover.dLum.toFixed(1)}`,
)
await page.mouse.move(0, 0) // release the hover before the shot
await page.waitForTimeout(60)
await shot('pane-empty-state.png')

await page.evaluate(() => window.__mount({ tabs: [{ id: 'tab_fresh', url: 'about:blank', title: '', active: true }] }))
check('a fresh about:blank tab shows the same empty state', await page.getByText(EMPTY_COPY).isVisible().catch(() => false))
await page.evaluate(() => window.__mount({ tabs: [{ id: 'tab_real', url: 'https://www.baidu.com/', title: '百度一下', active: true }] }))
check('a navigated tab hides the empty state (the webview owns the area)', !(await page.getByText(EMPTY_COPY).isVisible().catch(() => false)))
await page.evaluate(() => {
  window.__historyFixture = []
})
await page.evaluate(() => window.__mount({ tabs: [] }))
check(
  'empty history hides the recents block but keeps the guidance',
  (await page.locator('[data-pm-empty-recents]').count()) === 0 && (await page.getByText(EMPTY_COPY).isVisible().catch(() => false)),
)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
await browser.close()
process.exit(failed.length ? 1 : 0)
