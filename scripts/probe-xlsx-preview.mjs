/**
 * XLSX preview probe (PLAN-xlsx-preview; real Chromium, production components).
 *
 * Mounts the real PreviewPane over a stubbed electronAPI whose readFileBinary
 * serves a workbook generated Node-side with the SAME exceljs the renderer
 * parses with (its browser build, bundled here by esbuild). Drives the whole
 * preview story the way a user would:
 *
 *   1. the grid renders — values, row/col headers, and the file's own styles
 *      (fill, bold, white-on-blue title at 14pt);
 *   2. number formats render (thousands, percent, currency) and the date
 *      pattern formats through its tokens;
 *   3. a formula with a cached result shows the result; one without shows the
 *      formula text in the formula colour;
 *   4. merges render as a spanned master with the covered cells gone;
 *   5. column widths / row heights come from the file;
 *   6. the letters row and the row-number gutter stay put while scrolling;
 *   7. the sheet bar switches sheets (and truncation notes appear on a 520-row
 *      sheet and a >40-column one);
 *   8. zoom: − / ＋ move the scale, 适应宽度 shrinks a wide grid to the pane;
 *   9. an error cell surfaces in the error colour; a link cell tooltips;
 *  10. .xls keeps the old markitdown→fallback path while .xlsx renders rich.
 *
 * Usage: node scripts/probe-xlsx-preview.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

const DIR = mkdtempSync(join(tmpdir(), 'pm-xlsx-preview-'))

// ── Fixture workbook (exceljs main build, Node side). ──
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('数据')
ws.mergeCells('A1:C1')
const title = ws.getCell('A1')
title.value = '季度报表'
title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
title.alignment = { horizontal: 'center', vertical: 'middle' }
ws.getRow(1).height = 30
ws.getCell('A2').value = '名称'
ws.getCell('B2').value = '数量'
ws.getCell('C2').value = 1234.5
ws.getCell('C2').numFmt = '#,##0.00'
ws.getCell('A3').value = '甲'
ws.getCell('B3').value = { formula: 'C2*2', result: 2469 }
ws.getCell('C3').value = new Date(2026, 8, 18, 14, 30, 9)
ws.getCell('C3').numFmt = 'yyyy-mm-dd hh:mm'
ws.getCell('A4').value = '完成率'
ws.getCell('B4').value = 0.25
ws.getCell('B4').numFmt = '0%'
ws.getCell('C4').value = 9500
ws.getCell('C4').numFmt = '¥#,##0'
ws.getCell('A5').value = { text: '站点', hyperlink: 'https://example.com' }
ws.getCell('B5').value = { error: '#N/A' }
ws.getCell('C5').value = { formula: 'NOPE()' } // never computed → formula text
ws.columns = [{ width: 20 }, { width: 12 }, { width: 16 }]

const wide = wb.addWorksheet('宽表')
for (let c = 1; c <= 40; c++) wide.getColumn(c).width = 10
for (let r = 1; r <= 5; r++) {
  for (let c = 1; c <= 40; c++) wide.getRow(r).getCell(c).value = r * 100 + c
}

const big = wb.addWorksheet('大表')
for (let r = 1; r <= 520; r++) big.getRow(r).getCell(1).value = `行${r}`
for (let c = 1; c <= 3; c++) big.getColumn(c).width = 15

const bin = await wb.xlsx.writeBuffer()
const XLSX_B64 = Buffer.from(bin).toString('base64')

// An old-format .xls header (OLE2 magic) — its kind routes to the markitdown
// path, which the stub fails, so the tab must land on the fallback card.
const XLS_B64 = Buffer.from('D0CF11E0A1B11AE1', 'hex').toString('base64')

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
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root" style="height:700px"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')

await page.evaluate(
  ([xlsx, xls]) => {
    window.__bin = { '/w/报表.xlsx': xlsx, '/w/旧表.xls': xls }
    window.__binaryCalls = []
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
      key === 'readFile' ? () => Promise.resolve(null)
      : key === 'readFileBinary' ? (p) => {
          window.__binaryCalls.push(p)
          return Promise.resolve(window.__bin[p] ?? null)
        }
      : key === 'convertFileToMarkdown' ? () => Promise.resolve({ content: null })
      : key === 'getFileStat' ? () => Promise.resolve({ size: 12345, mtime: '2026-09-18T08:00:00Z' })
      : key === 'openFolder' ? () => Promise.resolve()
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })
  },
  [XLSX_B64, XLS_B64]
)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)
const grid = () => page.locator('[data-xlsx-grid]')
const scrollBox = () => page.locator('.pm-xlsx-scroll')

await page.evaluate(() => window.__mount())
await openFile('/w/报表.xlsx')
await grid().waitFor()

/* ── 1. Grid + styles. ── */
check('binary read went through readFileBinary exactly once', (await page.evaluate(() => window.__binaryCalls)) .length === 1)
const a1 = page.locator('[data-xlsx-grid] td', { hasText: '季度报表' })
await a1.waitFor()
const a1Style = await a1.evaluate((el) => ({
  bg: getComputedStyle(el).backgroundColor,
  color: getComputedStyle(el).color,
  weight: getComputedStyle(el).fontWeight,
  sizePx: parseFloat(getComputedStyle(el).fontSize),
  span: el.colSpan,
  align: getComputedStyle(el).textAlign,
}))
check('A1 wears the file fill, font colour, weight and size',
  a1Style.bg === 'rgb(68, 114, 196)' && a1Style.color === 'rgb(255, 255, 255)' && a1Style.weight === '600' && Math.abs(a1Style.sizePx - 14 * (96 / 72)) < 0.01,
  JSON.stringify(a1Style))
check('merge A1:C1 renders one spanned master (3 covered cells gone)', a1Style.span === 3)
const row1Cells = await page.locator('[data-xlsx-grid] tbody tr').first().locator('td').count()
check('row 1 carries exactly one data cell (the master)', row1Cells === 1, String(row1Cells))
const headers = await page.locator('[data-xlsx-grid] thead th').allTextContents()
check('column letters run A B C beside the corner gutter', headers.slice(1).join(',') === 'A,B,C', headers.join(','))

/* ── 2. Number formats. ── */
const fmt = async (text) => (await page.locator('[data-xlsx-grid] td', { hasText: text }).textContent()) ?? ''
check('thousands format renders 1,234.50', (await fmt('1,234.50')) === '1,234.50')
check('percent renders 25%', (await fmt('25%')) === '25%')
check('currency renders ¥9,500', (await fmt('¥9,500')) === '¥9,500')
check('date pattern renders 2026-09-18 14:30', (await fmt('2026-09-18 14:30')) === '2026-09-18 14:30')

/* ── 3. Formulas. ── */
check('cached formula result renders 2469', (await fmt('2469')) === '2469')
const bare = page.locator('[data-xlsx-grid] td', { hasText: '=NOPE()' })
check('uncomputed formula shows the formula text', (await bare.count()) === 1)
const bareColor = await bare.evaluate((el) => getComputedStyle(el).color)
check('formula text wears the formula colour', bareColor === 'rgb(114, 46, 209)', bareColor)

/* ── 4. Error + link. ── */
const errColor = await page.locator('[data-xlsx-grid] td', { hasText: '#N/A' }).evaluate((el) => getComputedStyle(el).color)
check('error cell wears the error colour', errColor === 'rgb(212, 56, 13)', errColor)
const linkTitle = await page.locator('[data-xlsx-grid] td', { hasText: '站点' }).getAttribute('title')
check('link cell tooltips its URL', linkTitle === 'https://example.com', String(linkTitle))

/* ── 5. Dimensions from the file. ── */
const colA = await page.locator('[data-xlsx-grid] colgroup col').nth(1).evaluate((el) => el.style.width)
check('column A width rides the file (20ch → 145px)', colA === '145px', colA)
const row1H = await page.locator('[data-xlsx-grid] tbody tr').first().evaluate((el) => el.style.height)
check('row 1 height rides the file (30pt → 40px)', row1H === '40px', row1H)

/* ── 6. Sticky letters + gutter under real scroll — the short sheet cannot
   scroll at all, so this runs where the range exists: 大表 scrolls
   vertically, 宽表 horizontally. ── */
await page.locator('[data-sheet="大表"]').click()
await page.locator('[data-xlsx-grid] td', { hasText: '行100' }).first().waitFor()
await scrollBox().evaluate((el) => { el.scrollTop = 400 })
await page.waitForTimeout(80)
const lettersTop = await scrollBox().evaluate((el) => {
  const letters = el.querySelectorAll('thead th')[1].getBoundingClientRect()
  return letters.top - el.getBoundingClientRect().top
})
check('letters row sticks to the top while scrolled', Math.abs(lettersTop) <= 2, String(lettersTop))
await page.locator('[data-sheet="宽表"]').click()
await page.locator('[data-xlsx-grid] td', { hasText: '307' }).waitFor()
await scrollBox().evaluate((el) => { el.scrollLeft = 500 })
await page.waitForTimeout(80)
const gutterLeft = await scrollBox().evaluate((el) => {
  const gutter = el.querySelector('tbody th').getBoundingClientRect()
  return gutter.left - el.getBoundingClientRect().left
})
check('row-number gutter sticks to the left while scrolled', Math.abs(gutterLeft) <= 2, String(gutterLeft))
await scrollBox().evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0 })

/* ── 7. Sheet bar, wide grid, fit, truncation (宽表 is already active from
   the gutter check above). ── */
check('sheet bar lists all three sheets', (await page.locator('[data-xlsx-sheetbar] [data-sheet]').count()) === 3)
check('switching sheets swapped the grid (307 only on 宽表)', (await page.locator('[data-xlsx-grid] td', { hasText: '307' }).count()) === 1)
check('a 40-column sheet is not column-truncated', (await page.locator('text=仅显示前').count()) === 0)

const zoomLabel = () => page.locator('[data-zoom-label]')
check('zoom reads 100% at rest', (await zoomLabel().textContent()) === '100%')
await page.locator('div[title="放大"]').click()
const zoomedUp = await scrollBox().locator('.pm-xlsx-zoom').evaluate((el) => el.style.zoom)
check('＋ moves the scale up', Number(zoomedUp) > 1, zoomedUp)
await page.locator('div[title="适应宽度"]').click()
const fitScale = await scrollBox().locator('.pm-xlsx-zoom').evaluate((el) => Number(el.style.zoom))
const boxW = await scrollBox().evaluate((el) => el.clientWidth)
check('适应宽度 shrinks the 40-column grid to the pane (never past 100%)',
  fitScale <= 1 && fitScale > 0.1 && Math.round(fitScale * 100) !== 100,
  `${fitScale} of box ${boxW}`)
const gridW = await scrollBox().locator('.pm-xlsx-zoom table').evaluate((el) => el.getBoundingClientRect().width)
check('fitted grid fills the pane within one gutter of slack', Math.abs(gridW - boxW) <= 40, `grid ${gridW} vs box ${boxW}`)

await page.locator('[data-sheet="大表"]').click()
await page.locator('text=共 520 行，仅显示前 500 行').waitFor()
check('520-row sheet shows the truncation note with both counts', true)
const lastRow = await page.locator('[data-xlsx-grid] tbody tr').last().locator('th').textContent()
check('the rendered window stops at row 500', lastRow === '500', String(lastRow))

/* ── 8. Refresh path re-parses, .xls keeps the fallback. ── */
await page.evaluate(() => window.__store.getState().bumpReload('/w/报表.xlsx'))
await page.waitForTimeout(300)
check('after a reload tick the grid is back (parse is idempotent)', (await grid().count()) === 1)

await openFile('/w/旧表.xls')
await page.locator('button:has-text("在系统中打开")').waitFor()
check('.xls lands on the fallback card, not the grid', (await grid().count()) === 0)
check('.xls fallback names the file', (await page.locator('div:has-text("旧表.xls")').count()) > 0)

/* ── Non-vacuity: remove the merge handling in buildSheetGrid and the
   span check above fails (run once during development — it did). ── */

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
