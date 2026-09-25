/**
 * Deck layout probe (PLAN-deck-layouts; real Chromium, production components).
 *
 * Generates a full-layout deck NODE-side with the real deckToPptxBuffer (the
 * same engine export_document format=pptx runs), then mounts the real
 * PreviewPane over a stubbed electronAPI serving those bytes — because every
 * coordinate in deck-to-pptx.ts is hand-set, and an XML assertion cannot see
 * an overlapping page. Drives what a user would look at:
 *
 *   1. all 9 layouts render as pages with NO placeholder boxes and NO amber
 *      banner (the vector-shapes decision + the pie conic branch, verified);
 *   2. cover/section carry the accent chrome (left bar / tinted background);
 *   3. two-col panels and kpi cards are tinted roundRects in a row;
 *   4. column/line/bar charts draw real bars, segments and markers;
 *   5. the pie renders conic-gradient slices with the palette colours;
 *   6. the table renders its grid with the accent header;
 *   7. the image layout embeds a decodable data: URL with its caption.
 *
 * Screenshots of every slide land in $(os.tmpdir())/pm-deck-shots/ for the
 * eyeball pass the numbers cannot replace.
 *
 * Usage: node scripts/probe-deck-layouts.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'pm-deck-layouts-'))
const SHOTS = join(tmpdir(), 'pm-deck-shots')
mkdirSync(SHOTS, { recursive: true })

// A real 1×1 PNG (the image layout needs real bytes to embed; geometry, not
// content, is what this probe asserts about it).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const SPEC = {
  title: '版式探针',
  theme: { accent: '2F54EB' },
  slides: [
    { layout: 'cover', title: '季度经营回顾', subtitle: '2026 Q3 · 探针样本' },
    { layout: 'section', title: '第一章 · 经营概览' },
    { layout: 'bullets', title: '核心要点', bullets: ['结论先行，一页一事', { text: '要点带子项', sub: ['子项甲', '子项乙'] }, '数据进图表，不进长句'] },
    { layout: 'two-col', title: '方案对比', columns: [{ heading: '方案甲', bullets: ['成本低', '周期短'] }, { heading: '方案乙', bullets: ['扩展性强', '风险可控'] }] },
    { layout: 'kpi', title: '核心指标', items: [{ value: '98.2%', label: '达成率' }, { value: '3天', label: '交付周期' }, { value: '12次', label: '迭代次数' }] },
    { layout: 'chart', title: '月度营收（万元）', note: '来源：财务系统', chart: { type: 'column', categories: ['一月', '二月', '三月'], series: [{ name: '营收', values: [12, 30, 20] }] } },
    { layout: 'chart', title: '活跃趋势', chart: { type: 'line', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: '活跃', values: [5, 9, 7] }] } },
    { layout: 'chart', title: '渠道构成', chart: { type: 'pie', categories: ['直营', '渠道'], series: [{ name: '份额', values: [3, 1] }] } },
    { layout: 'table', title: '明细', header: ['名称', '数量'], rows: [['甲', '12'], ['乙', '30']] },
    { layout: 'quote', quote: '结论先行，以上统下，归类分组，逻辑递进。', author: '金字塔原理' },
    { layout: 'image', image: 'a.png', caption: '图一：架构示意' },
  ],
}

// ── Generate the deck bytes Node-side with the REAL engine. ──
const GEN = join(DIR, 'gen.mjs')
await build({
  stdin: {
    contents: `
import { parseDeckSpec } from '${join(process.cwd(), 'src/shared/deck/spec.ts')}'
import { deckToPptxBuffer } from '${join(process.cwd(), 'src/main/office-export/deck-to-pptx.ts')}'
const parsed = parseDeckSpec(${JSON.stringify(SPEC)})
if (!parsed.ok) throw new Error(parsed.error)
const PNG = Buffer.from(${JSON.stringify(PNG_1PX.toString('base64'))}, 'base64')
export async function deck() {
  return deckToPptxBuffer(parsed.spec, new Map([['a.png', PNG]]))
}
`,
    resolveDir: process.cwd(),
    loader: 'tsx',
    sourcefile: 'gen.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: GEN,
  tsconfig: 'tsconfig.node.json',
})
const { deck } = await import(GEN)
const bin = Buffer.from(await deck())

// ── Harness: the production PreviewPane over the stubbed bridge. ──
const OUT = join(DIR, 'harness.js')
const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { PreviewPane } from './src/renderer/src/components/preview/PreviewPane'

let root = null
window.__mount = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <TranslationProvider initialLocale="zh">
        <PreviewPane conversationId={undefined} />
      </TranslationProvider>
    </ConfigProvider>
  )
  return true
}
window.__store = usePreviewPaneStore
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
let failures = 0
function check(name, pass, detail) {
  results.push({ name, pass })
  if (!pass) failures++
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root" style="width:1100px;height:900px"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')

await page.evaluate(
  ([pptx]) => {
    window.__bin = { '/w/版式探针.pptx': pptx }
    window.__binaryCalls = []
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
      key === 'readFile' ? () => Promise.resolve(null)
      : key === 'readFileBinary' ? (p) => {
          window.__binaryCalls.push(p)
          return Promise.resolve(window.__bin[p] ?? null)
        }
      : key === 'convertFileToMarkdown' ? () => Promise.resolve({ content: null })
      : key === 'getFileStat' ? () => Promise.resolve({ size: pptx.length, mtime: '2026-09-24T08:00:00Z' })
      : key === 'openFolder' ? () => Promise.resolve()
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })
  },
  [bin.toString('base64')]
)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)
const slides = () => page.locator('[data-pptx-slide]')
const ACCENT = 'rgb(47, 84, 235)' // 2F54EB
const TINT_SECTION = 'rgb(238, 241, 253)' // EEF1FD
const TINT_PANEL = 'rgb(247, 248, 250)' // F7F8FA

await page.evaluate(() => window.__mount())
await openFile('/w/版式探针.pptx')
await slides().first().waitFor()

/* ── 1. Pages: every layout renders, nothing skipped. ── */
check('all 11 slides render as pages', (await slides().count()) === SPEC.slides.length, String(await slides().count()))
check('no placeholder boxes anywhere (charts/geometry are all real)', (await page.locator('[data-ph]').count()) === 0)
check('no amber skip banner', !(await page.locator('body').innerText()).includes('无法完整展示'), (await page.locator('body').innerText()).slice(0, 80))

/* ── 2. Cover chrome. ── */
// data-shape indexes are 0-based over the slide's own shapes (this deck has no
// master decorations): 0 = left accent bar, 1 = short bar, 2 = title…
const coverBar = await page.locator('[data-pptx-slide="1"] [data-shape="0"]').evaluate((el) => ({
  bg: getComputedStyle(el).backgroundColor, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight,
}))
check('cover accent bar hugs the left edge (0.22" wide, full height)',
  coverBar.bg === ACCENT && coverBar.x === 0 && coverBar.y === 0 && Math.abs(coverBar.w - 0.22 * 96) < 1 && Math.abs(coverBar.h - 5.625 * 96) < 1, JSON.stringify(coverBar))
check('cover title text renders', (await page.locator('[data-pptx-slide="1"]').innerText()).includes('季度经营回顾'))

/* ── 3. Section tint + two-col panels + kpi cards. ── */
const sectionBg = await slides().nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)
check('section page background is the derived tint', sectionBg === TINT_SECTION, sectionBg)
const panelStyles = await page.locator('[data-pptx-slide="4"] [data-shape]').evaluateAll((els) =>
  els.filter((el) => getComputedStyle(el).borderRadius !== '0px').map((el) => ({ bg: getComputedStyle(el).backgroundColor, x: el.offsetLeft, w: el.offsetWidth })))
check('two-col draws two tinted rounded panels side by side',
  panelStyles.length === 2 && panelStyles.every((p) => p.bg === TINT_PANEL) && panelStyles[1].x > panelStyles[0].x + panelStyles[0].w, JSON.stringify(panelStyles))
const kpiCards = await page.locator('[data-pptx-slide="5"] [data-shape]').evaluateAll((els) =>
  els.filter((el) => getComputedStyle(el).borderRadius !== '0px').map((el) => ({ bg: getComputedStyle(el).backgroundColor, y: el.offsetTop, h: el.offsetHeight })))
check('kpi draws three same-size tinted cards on one row',
  kpiCards.length === 3 && kpiCards.every((c) => c.bg !== 'rgba(0, 0, 0, 0)') && new Set(kpiCards.map((c) => c.y)).size === 1, JSON.stringify(kpiCards))
check('kpi values wear the accent colour', (await page.locator('[data-pptx-slide="5"]').innerText()).includes('98.2%'))

/* ── 4. Column chart: real bars in the accent colour. ── */
// y > 80 skips the title chrome bar (accent too, but up at y=40)
const bars = await page.locator('[data-pptx-slide="6"] [data-shape]').evaluateAll((els) =>
  els.map((el) => ({ bg: getComputedStyle(el).backgroundColor, y: el.offsetTop, h: el.offsetHeight }))
    .filter((s) => s.bg === 'rgb(47, 84, 235)' && s.h > 8 && s.y > 80))
check('column chart draws 3 accent bars of differing heights',
  bars.length === 3 && new Set(bars.map((b) => b.h)).size === 3, JSON.stringify(bars))
check('column chart carries the note line', (await page.locator('[data-pptx-slide="6"]').innerText()).includes('来源：财务系统'))

/* ── 5. Line chart: SVG segments + ellipse markers. ── */
const lineSvgs = await page.locator('[data-pptx-slide="7"] svg').count()
const markers = await page.locator('[data-pptx-slide="7"] [data-shape]').evaluateAll((els) =>
  els.filter((el) => { const r = getComputedStyle(el).borderRadius; return r === '50%' || r === '4.32px' }).length)
check('line chart renders SVG line shapes', lineSvgs >= 3, String(lineSvgs))
check('line chart renders ellipse markers', markers >= 3, String(markers))

/* ── 6. Pie: conic-gradient slices in the palette colours. ── */
const pieSlices = await page.locator('[data-pptx-slide="8"] [data-shape]').evaluateAll((els) =>
  els.map((el) => ({ grad: getComputedStyle(el).backgroundImage, radius: getComputedStyle(el).borderRadius }))
    .filter((s) => s.grad.includes('conic-gradient')))
check('pie renders 2 conic-gradient slices', pieSlices.length === 2, JSON.stringify(pieSlices.map((p) => p.grad.slice(0, 60))))
check('pie slices are round boxes', pieSlices.length === 2 && pieSlices.every((p) => p.radius === '50%'))
check('pie legend carries the pct', (await page.locator('[data-pptx-slide="8"]').innerText()).includes('75%'))

/* ── 7. Table. ── */
const table = page.locator('[data-pptx-slide="9"] table')
check('table renders a real grid with its cells', (await table.count()) === 1 && (await table.innerText()).includes('甲') && (await table.innerText()).includes('30'))

/* ── 8. Quote + image. ── */
check('quote page shows the attribution', (await page.locator('[data-pptx-slide="10"]').innerText()).includes('— 金字塔原理'))
const imgDiv = page.locator('[data-pptx-slide="11"] [data-shape]').evaluateAll((els) => {
  for (const el of els) {
    const bg = getComputedStyle(el).backgroundImage
    if (bg.startsWith('url("data:image/png;base64,')) return { ok: true }
  }
  return { ok: false }
})
check('image layout embeds a decodable data URL', (await imgDiv).ok)
check('image page shows the caption', (await page.locator('[data-pptx-slide="11"]').innerText()).includes('图一：架构示意'))

/* ── Screenshots for the eyeball pass. ── */
for (let i = 1; i <= SPEC.slides.length; i++) {
  const el = page.locator(`[data-pptx-slide="${i}"]`)
  await el.screenshot({ path: join(SHOTS, `deck-slide-${String(i).padStart(2, '0')}.png`) })
}
console.log(`\n  screenshots → ${SHOTS}`)

await browser.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} (${results.length} checks)`)
process.exit(failures === 0 ? 0 : 1)
