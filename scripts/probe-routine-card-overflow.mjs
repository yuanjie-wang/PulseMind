/**
 * Routine-card params-pill overflow probe (real Chromium).
 *
 * 用户报告：日常任务参数设置过多时，首页任务卡片的内容超出卡片宽度，
 * 页面出现水平滚动条。The params pill joins every user-named key with
 * ` · ` into ONE `white-space: nowrap` inline-flex string — its width is
 * the user's naming, unbounded — and the card neither clips it nor caps it.
 * Overflowing `overflow: visible` content extends the scrollable overflow
 * region of the nearest scroller (the tasks column, `overflowY: auto` whose
 * overflow-x computes to `auto`), which is the horizontal scrollbar.
 *
 * The fix has two halves, both in RoutineCenter.tsx: the pill is capped at
 * the card (`max-width: 100%`, `min-width: 0`) with an ellipsized inner span
 * + a Tooltip carrying the full list, and `.routine-card` gains
 * `min-width: 0` (the grid item's automatic minimum, as defense in depth).
 *
 * jsdom has no layout engine and reading the source reads identically either
 * way — `calc`/`nowrap`/grid-track arithmetic is a pixel fact. Non-vacuity is
 * in-probe: an `!important` stylesheet override re-widens the pill to the
 * pre-fix shape (a sheet beats the inline styles production renders, exactly
 * like a source revert) and the containment checks must go red.
 *
 * Usage: node scripts/probe-routine-card-overflow.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-routine-overflow-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'

// Three routines: a plain one (regression guard), one with MANY keys — some
// long, one with no word-break opportunities — mounted so it lands in the
// grid's LAST track (2 tracks at this host width), where an overflowing pill
// extends the scroll region instead of only painting over its neighbour.
const LONG_KEY = 'submitButtonXPathSelectorForTheLoginForm'
const KEYS = ['收件人', '抄送', '主题', LONG_KEY, 'page', 'retryCount']
const ROUTINES = [
  { id: 'r1', name: '每日晨报', description: '总结今天的日历和邮件', prompt: '总结今天的日历和邮件', enabled: true },
  { id: 'r2', name: '邮箱巡检', description: '检查未读邮件并汇总', prompt: '检查未读邮件并汇总', enabled: true,
    schedule: { cron: '0 9 * * *' },
    params: KEYS.map((k) => ({ key: k, label: k, required: false })) },
  { id: 'r3', name: '表单提交', description: '提交登录表单', prompt: '提交登录表单', enabled: true,
    params: [{ key: 'aVeryLongSingleParameterNameWithoutAnyWordBreaksAtAllXX', label: '长参数', required: false }] },
]

installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'routineList') return Promise.resolve(ROUTINES)
    if (key === 'routineRuns') return Promise.resolve([])
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' })
    }
    return Promise.resolve(undefined)
  },
})

function RoutineShell() {
  return (
    <div id="routine-host" style={{ width: 1000, height: 900 }}>
      <RoutineCenter />
    </div>
  )
}

/** The nearest scroller above the cards — the tasks column, overflowY: auto
 *  (overflow-x computes to auto). A horizontal scrollbar the user sees lives
 *  on THIS element, so this is where overflow is measured. */
window.__scroller = () => {
  const card = document.querySelector('.routine-card')
  let el = card?.parentElement
  while (el) {
    const ox = getComputedStyle(el).overflowX
    if (ox === 'auto' || ox === 'scroll') return el
    el = el.parentElement
  }
  return document.documentElement
}

window.__measure = () => {
  const scroller = window.__scroller()
  const cards = [...document.querySelectorAll('.routine-card')]
  if (cards.length < 3) return null
  // The params pill of the 邮箱巡检 card — the last pill whose text starts
  // with 参数. Identifying by content, not index, so a pill added before it
  // (a run-status pill appearing, say) cannot silently re-point the probe.
  const many = cards[1]
  const single = cards[2]
  const pillOf = (card) =>
    [...card.querySelectorAll('.routine-pill')].find((p) => p.textContent.startsWith('参数')) ?? null
  const manyPill = pillOf(many)
  const singlePill = pillOf(single)
  const manyInner = manyPill?.lastElementChild ?? null
  const singleInner = singlePill?.lastElementChild ?? null
  const r = (el) => el.getBoundingClientRect()
  return {
    scrollOverflow: scroller.scrollWidth - scroller.clientWidth,
    manyPill: manyPill ? {
      exceedsCard: r(manyPill).right - (r(many).right - 16),
      clipped: manyPill.scrollWidth - manyPill.clientWidth,
    } : null,
    singlePill: singlePill ? {
      exceedsCard: r(singlePill).right - (r(single).right - 16),
      clipped: singlePill.scrollWidth - singlePill.clientWidth,
    } : null,
    manyEllipsized: manyInner ? manyInner.scrollWidth > manyInner.clientWidth : null,
    singleEllipsized: singleInner ? singleInner.scrollWidth > singleInner.clientWidth : null,
  }
}

/** Inject (or remove) an !important stylesheet override — the in-probe
 *  negative control. Inline styles are what production renders, so only an
 *  !important sheet can shadow them, exactly like a source revert would. */
window.__override = (css) => {
  let el = document.getElementById('probe-override')
  if (css === null) { el?.remove(); return }
  if (!el) { el = document.createElement('style'); el.id = 'probe-override'; document.head.appendChild(el) }
  el.textContent = css
}

window.__mount = () => {
  const host = document.createElement('div')
  host.id = 'case-routine'
  document.body.appendChild(host)
  createRoot(host).render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><RoutineShell /></TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

const root = createRoot(document.getElementById('root'))
root.render(<div />)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.waitForTimeout(400)

console.log('\n§1 修复后形态 — 胶囊收在卡片内，长列表省略号截断，页面无横向滚动')
const m = await page.evaluate(() => window.__measure())
console.log('  ', JSON.stringify(m))
check('三个任务卡片都渲染（含无参数的回归对照）', m !== null)
check('页面无横向溢出（滚动容器 scrollWidth ≤ clientWidth）', m.scrollOverflow <= 0.5, `overflow=${m.scrollOverflow}px`)
check('多参数胶囊不超出卡片右内边距线', m.manyPill && m.manyPill.exceedsCard <= 0.5, `exceeds=${m.manyPill?.exceedsCard?.toFixed(1)}px`)
check('多参数胶囊自身不被裁剪（scrollWidth == clientWidth）', m.manyPill && m.manyPill.clipped <= 0.5, `clipped=${m.manyPill?.clipped}px`)
check('多参数列表在内部截断出省略号', m.manyEllipsized === true)
check('单个超长无断行 key 同样收在卡片内并截断', m.singlePill && m.singlePill.exceedsCard <= 0.5 && m.singleEllipsized === true,
  `exceeds=${m.singlePill?.exceedsCard?.toFixed(1)}px ellipsized=${m.singleEllipsized}`)

console.log('\n§2 Tooltip — 截断的完整 key 列表悬停可见')
const manyCard = page.locator('.routine-card').nth(1)
const pill = manyCard.locator('.routine-pill', { hasText: '参数' })
await pill.hover()
await page.waitForTimeout(400)
const tipText = await page.evaluate(() => document.querySelector('.ant-tooltip')?.textContent ?? '')
check('悬停参数胶囊出现完整 key 列表', tipText.includes('submitButtonXPathSelectorForTheLoginForm') && tipText.includes('retryCount'),
  JSON.stringify(tipText.slice(0, 80)))
await page.mouse.move(10, 10)
await page.waitForTimeout(300)

console.log('\n§3 非空性 — !important 还原修复前形态，度量必须转红')
await page.evaluate(() => window.__override(`
  .routine-pill { max-width: none !important; min-width: auto !important; }
  .routine-pill span:last-child { overflow: visible !important; }
`))
await page.waitForTimeout(100)
const pre = await page.evaluate(() => window.__measure())
console.log('  ', JSON.stringify(pre))
check('[负对照] 胶囊放开后重新画出卡片右缘（exceedsCard > 0）', pre.manyPill && pre.manyPill.exceedsCard > 1, `exceeds=${pre.manyPill?.exceedsCard?.toFixed(1)}px`)
check('[负对照] 胶囊放开后页面重新出现横向溢出（用户报告的症状）', pre.scrollOverflow > 0.5, `overflow=${pre.scrollOverflow}px`)
await page.evaluate(() => window.__override(null))
await page.waitForTimeout(100)
const healed = await page.evaluate(() => window.__measure())
check('[还原] 移除负对照后恢复无溢出', healed.scrollOverflow <= 0.5 && healed.manyPill.exceedsCard <= 0.5,
  `overflow=${healed.scrollOverflow}px exceeds=${healed.manyPill.exceedsCard.toFixed(1)}px`)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
