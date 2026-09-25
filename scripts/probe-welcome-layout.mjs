/**
 * Welcome-page vertical layout probe (real Chromium).
 *
 * 对话/项目切换按钮下方不许有固定高度的空白, and the logo must never be squeezed
 * when the window is short. Two defects stacked here, both invisible to jsdom
 * (no layout engine) and to reading the source:
 *
 *   1. The switcher band used to carry `padding-bottom: 144px` — a FIXED blank
 *      outside the scroll region, so it ate 144px no matter how short the
 *      window got. It is now 8px, and the breathing room lives INSIDE the
 *      welcome column as an elastic spacer (`flex: 1 1 0`, `max-height: 136`):
 *      the blank only exists when there is spare height, and collapses to zero
 *      before anything else gives way. Max gap 8 + 24 + 136 = 168 = the old
 *      144 + 24, so tall windows look unchanged.
 *   2. The welcome column is a flex column whose fixed children (logo, title,
 *      subtitle) used to default to `flex-shrink: 1` — and the logo/title
 *      wrappers carry `overflow: hidden`, which per the flex spec gives them an
 *      automatic minimum size of 0, so on a short window they COMPRESSED
 *      instead of the region scrolling. They now carry `flex-shrink: 0`; the
 *      degradation order is quick band → 224 floor, spacer → 0, then scroll.
 *
 * What this mounts: the real `ChatView` welcome branch in an AppLayout-shaped
 * shell (same recipe as probe-welcome-focus.mjs), at several viewport heights.
 * Non-vacuity is in-probe: `!important` stylesheet overrides reintroduce each
 * fixed value (144px padding, a fixed 136px spacer, a shrinkable logo) and the
 * corresponding assertion must go red — no source edits needed.
 *
 * Usage: node scripts/probe-welcome-layout.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-welcome-layout-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'

// Same stub shape as probe-welcome-focus.mjs — the welcome page's suggestion
// cards map over what these answer, and SettingsProvider reads getSettings.
const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  projectValidateDir: { ok: true },
  showOpenDialog: { canceled: true, filePaths: [] },
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

function WelcomeShell() {
  return (
    <div id="chat-host" style={{ height: 900 }}>
      <ChatView
        messages={EMPTY}
        isRequesting={false}
        agentStatus={IDLE}
        streamingBlocks={EMPTY}
        hasApiKey={true}
        onSendMessage={() => {}} onCancel={() => {}}
        onApproveTool={() => {}} onRejectTool={() => {}}
        onClearError={() => {}}
        conversations={EMPTY}
        onOpenConversation={() => {}}
      />
    </div>
  )
}

/**
 * One measurement of the vertical story, in CSS pixels:
 *   gap      — switcher band's bottom edge to the logo's top edge (the blank)
 *   spacer   — the elastic spacer's own height
 *   logoH    — the logo container's rendered height (90 when healthy, less
 *              when a shrink is squeezing it)
 *   region   — scroll region client/scroll height (scrollHeight > clientHeight
 *              means the page degrades to scrolling)
 */
window.__measure = () => {
  const seg = document.querySelector('.task-switch')
  const sp = document.querySelector('[data-welcome-spacer]')
  const logo = document.querySelector('[data-welcome-logo]')
  const region = document.querySelector('[data-welcome-region]')
  if (!seg || !sp || !logo || !region) return null
  const segRect = seg.getBoundingClientRect()
  const logoRect = logo.getBoundingClientRect()
  return {
    // Capsule control's bottom edge to the logo's top edge — the blank the
    // user actually sees. Measured off the capsule, NOT off its band wrapper:
    // a restored padding-bottom lives INSIDE the wrapper's box, so reading the
    // wrapper's bottom would report the same gap with 136px more padding.
    gap: logoRect.top - segRect.bottom,
    spacer: sp.getBoundingClientRect().height,
    logoH: logoRect.height,
    regionClient: region.clientHeight,
    regionScroll: region.scrollHeight,
  }
}

window.__setHeight = (h) => { document.getElementById('chat-host').style.height = h + 'px' }

/** Inject (or remove) an !important stylesheet override — the in-probe negative
 *  controls. Inline styles are what production renders, so only an !important
 *  sheet can shadow them, exactly like a source revert would. */
window.__override = (css) => {
  let el = document.getElementById('probe-override')
  if (css === null) { el?.remove(); return }
  if (!el) { el = document.createElement('style'); el.id = 'probe-override'; document.head.appendChild(el) }
  el.textContent = css
}

window.__mount = () => {
  const host = document.createElement('div')
  host.id = 'case-welcome'
  document.body.appendChild(host)
  createRoot(host).render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><WelcomeShell /></TranslationProvider>
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.waitForTimeout(400)

const measure = (h) =>
  page.evaluate((hh) => {
    window.__setHeight(hh)
    // Two rAFs: let layout settle after the height flip before reading.
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__measure()))))
  }, h)
const override = (css) => page.evaluate((c) => window.__override(c), css)

// Thresholds are derived from the layout, not eyeballed: the gap can never
// exceed 8 (band padding) + 24 (root padding) + 136 (spacer cap) = 168, and
// the logo is 90 tall by construction (LOGO_SIZE_HEIGHT).
const GAP_MAX = 168
const LOGO_H = 90

console.log('\n§1 弹性空白 — 高度富余时给到封顶，高度变矮时平滑收缩，永不为负')
const tall = await measure(1000)
console.log('  [1000]', JSON.stringify(tall))
check('高窗口：logo 高度是 90', Math.abs(tall.logoH - LOGO_H) < 0.5, `logoH=${tall.logoH}`)
check('高窗口：空白达到封顶区（spacer 吃到了富余）', tall.spacer > 100 && tall.spacer <= 136 + 0.5, `spacer=${tall.spacer}`)
check('高窗口：空白总和不超过 168（旧 144+24 的观感上限）', tall.gap <= GAP_MAX + 0.5 && tall.gap > 0, `gap=${tall.gap}`)

const mid = await measure(760)
console.log('  [ 760]', JSON.stringify(mid))
check('中窗口：logo 仍是 90', Math.abs(mid.logoH - LOGO_H) < 0.5, `logoH=${mid.logoH}`)
check('中窗口：空白随高度收缩（小于高窗口）', mid.gap < tall.gap, `${mid.gap} < ${tall.gap}`)
check('中窗口：空白不低于 0', mid.gap >= -0.5, `gap=${mid.gap}`)

const short = await measure(600)
console.log('  [ 600]', JSON.stringify(short))
check('矮窗口：logo 仍是 90（没有被压扁）', Math.abs(short.logoH - LOGO_H) < 0.5, `logoH=${short.logoH}`)
check('矮窗口：空白继续收缩且不为负', short.gap < mid.gap && short.gap >= -0.5, `gap=${short.gap} < ${mid.gap}`)

console.log('\n§2 高度不足时降级为页面滚动，而不是挤压内容')
const tiny = await measure(520)
console.log('  [ 520]', JSON.stringify(tiny))
check('极矮窗口：logo 还是 90（压缩没有落到它头上）', Math.abs(tiny.logoH - LOGO_H) < 0.5, `logoH=${tiny.logoH}`)
check('极矮窗口：空白不为负（spacer 已归零或仍在内容间隙内）', tiny.gap >= -0.5, `gap=${tiny.gap}`)
check('极矮窗口：区域可滚动（scrollHeight > clientHeight）', tiny.regionScroll > tiny.regionClient + 1, `scroll=${tiny.regionScroll} client=${tiny.regionClient}`)

console.log('\n§3 非空验证 — !important 重演三个旧的固定值，对应断言必须变红')
// (a) the fixed 144px band padding: the gap blows past the 168 cap.
await measure(1000)
await override('[data-welcome-switcher] { padding-bottom: 144px !important; }')
const vA = await measure(1000)
console.log('  [a:144px]', JSON.stringify(vA))
check('负控 a：144px 固定 padding 回来后 gap 超过 168（§1 的上限断言会红）', vA.gap > GAP_MAX + 0.5, `gap=${vA.gap}`)
await override(null)

// (b) a fixed (non-elastic) spacer: on a short window the blank stays pinned
//     instead of collapsing, so §1's "矮窗口空白收缩" assertion goes red.
await measure(600)
await override('[data-welcome-spacer] { flex: 0 0 136px !important; }')
const vB = await measure(600)
console.log('  [b:fixed-spacer@600]', JSON.stringify(vB))
check('负控 b：固定 spacer 让矮窗口的空白钉在 136（§1 的收缩断言会红）', vB.spacer > 130, `spacer=${vB.spacer}`)
await override(null)

// (c) a shrinkable logo: on a short window the overflow:hidden wrapper
//     compresses — the original bug, and §1/§2's logoH assertions go red.
await measure(520)
await override('[data-welcome-logo] { flex-shrink: 1 !important; }')
const vC = await measure(520)
console.log('  [c:shrink-logo@520]', JSON.stringify(vC))
check('负控 c：可收缩的 logo 在矮窗口被压扁（logoH < 90，§1/§2 的 logo 断言会红）', vC.logoH < LOGO_H - 0.5, `logoH=${vC.logoH}`)
await override(null)

// Restored: everything green again (the overrides really were the only fault).
const back = await measure(520)
check('撤掉负控后 logo 回到 90', Math.abs(back.logoH - LOGO_H) < 0.5, `logoH=${back.logoH}`)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
