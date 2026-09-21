/**
 * Sidebar 对话/项目 pill-tab vertical-center probe (real Chromium).
 *
 * The history switcher's two labels sat 1px low inside their pill on Windows
 * (user report 2026-09-21). The mechanism is font-shaped and therefore not
 * reproducible here: antd's Button centers the label's *line box*
 * (inline-flex + align-items:center, no line-height of its own), and where the
 * glyphs sit inside that box is decided by the font's ascent/descent
 * asymmetry — PingFang on macOS reads centered, Microsoft YaHei parks CJK
 * faces low, and DirectWrite's baseline snapping at fractional DPRs rounds
 * that to a visible device pixel. The fix is a 1px lift applied ONLY on
 * Windows, keyed off the data-platform attribute index.html stamps before
 * React mounts — the same hook that disables backdrop-filter there.
 *
 * What a mac-side harness CAN measure, and what this probe therefore asserts:
 *
 *   - the selector's dependency: antd wraps string children in exactly one
 *     direct <span> per button (spaceChildren), so `.sidebar-list-tab > span`
 *     reaches the label on both tabs;
 *   - inertness off-Windows: without `data-platform='win32'` the labels carry
 *     no offset — the macOS rendering is untouched by the rule;
 *   - the flip: with the attribute set, both labels read position:relative /
 *     top:-1px and their rects sit exactly 1px above the button's center;
 *   - the pill does not move: button and track rects are identical before and
 *     after — the correction lifts the label inside the pill, never the pill.
 *
 * Non-vacuity is the flip itself: delete the rule and the win32 checks fail
 * on computed styles before the geometry ones run.
 *
 * Usage: node scripts/probe-sidebar-tab-center.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-tab-center-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-tab-center-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">{node}</TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

window.__mountLayout = () => {
  mount(
    <AppLayout
      conversations={[]}
      activeConversationKey=""
      totalSessions={0}
      autoCleanup={true}
      onCreateNew={() => {}}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    />
  )
  return true
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// index.html's boot order: the electronAPI stub first (AppLayout reads it at
// module scope), then the platform stamp — the '' a mac writes, which is what
// keeps the win32-scoped rule inert below.
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: 'zh',
        })
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })
  document.documentElement.dataset.platform = ''`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

await page.evaluate(() => window.__mountLayout())
await page.waitForSelector('.sidebar-list-tab')

/* ── Off-Windows: the rule is inert ─────────────────────────────────────── */

const defaultState = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.sidebar-list-tab')]
  const snap = (btn) => {
    const span = btn.querySelector(':scope > span')
    const b = btn.getBoundingClientRect()
    const s = span.getBoundingClientRect()
    const cs = getComputedStyle(span)
    return {
      spans: btn.querySelectorAll(':scope > span').length,
      position: cs.position,
      top: cs.top,
      centerDelta: (s.top + s.height / 2) - (b.top + b.height / 2),
      button: { top: b.top, height: b.height },
    }
  }
  return {
    labels: buttons.map((b) => b.textContent),
    tabs: buttons.map(snap),
    track: (() => { const t = document.querySelector('.sidebar-list-track').getBoundingClientRect(); return { top: t.top, height: t.height } })(),
  }
})
check('both tabs render, one label span each', defaultState.labels.join('/') === '对话/项目' && defaultState.tabs.every((t) => t.spans === 1),
  `${defaultState.labels.join('/')} — spans ${defaultState.tabs.map((t) => t.spans).join(',')}`)
check('off-Windows the labels carry no offset', defaultState.tabs.every((t) => t.position === 'static' && t.top === 'auto'),
  defaultState.tabs.map((t) => `${t.position}/${t.top}`).join(' · '))
check('off-Windows flex centering reads centered', defaultState.tabs.every((t) => Math.abs(t.centerDelta) <= 0.5),
  `label-vs-pill center Δ ${defaultState.tabs.map((t) => t.centerDelta.toFixed(2)).join(' / ')} px`)

/* ── Windows: the 1px lift ──────────────────────────────────────────────── */

await page.evaluate(() => { document.documentElement.dataset.platform = 'win32' })

const winState = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.sidebar-list-tab')]
  const snap = (btn) => {
    const span = btn.querySelector(':scope > span')
    const b = btn.getBoundingClientRect()
    const s = span.getBoundingClientRect()
    const cs = getComputedStyle(span)
    return {
      position: cs.position,
      top: cs.top,
      centerDelta: (s.top + s.height / 2) - (b.top + b.height / 2),
      button: { top: b.top, height: b.height },
    }
  }
  return {
    tabs: buttons.map(snap),
    track: (() => { const t = document.querySelector('.sidebar-list-track').getBoundingClientRect(); return { top: t.top, height: t.height } })(),
  }
})
check('win32 lifts the labels: relative, top -1px', winState.tabs.every((t) => t.position === 'relative' && t.top === '-1px'),
  winState.tabs.map((t) => `${t.position}/${t.top}`).join(' · '))
check('win32 label centers sit 1px above the pill center', winState.tabs.every((t) => Math.abs(t.centerDelta + 1) <= 0.25),
  `Δ ${winState.tabs.map((t) => t.centerDelta.toFixed(2)).join(' / ')} px (want −1.00)`)
check('the pill and the track do not move',
  winState.tabs.every((t, i) => t.button.top === defaultState.tabs[i].button.top && t.button.height === defaultState.tabs[i].button.height) &&
    winState.track.top === defaultState.track.top && winState.track.height === defaultState.track.height,
  `button ${defaultState.tabs[0].button.top}/${defaultState.tabs[0].button.height} → ${winState.tabs[0].button.top}/${winState.tabs[0].button.height}, track ${defaultState.track.height} → ${winState.track.height}`)

await page.locator('.sidebar-list-track').screenshot({ path: join(SHOTS, 'win32-lift.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks pass${failed.length ? ` — ${failed.length} FAILED` : ''}`)
process.exit(failed.length ? 1 : 0)
