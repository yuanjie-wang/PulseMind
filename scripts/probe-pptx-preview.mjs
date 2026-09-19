/**
 * PPTX preview probe (PLAN-pptx-preview; real Chromium, production components).
 *
 * Mounts the real PreviewPane over a stubbed electronAPI whose readFileBinary
 * serves a deck generated Node-side with pptxgenjs (devDependency — fixture
 * only, never shipped). The layout-inheritance case is grafted on by zip
 * surgery: a title placeholder WITHOUT its own frame is injected into slide 1,
 * and the matching placeholder WITH the frame goes into the slide layout —
 * exactly the chain real PowerPoint decks depend on. Drives the story a user
 * would:
 *
 *   1. the deck renders as slide pages at the file's own size (960×540);
 *   2. text boxes land where the file says, with size/weight/colour/family;
 *   3. shape fills and the roundRect radius come from the file;
 *   4. a placeholder-less title inherits its frame from the layout (and the
 *      probe fails when that inheritance is broken — see non-vacuity);
 *   5. images ride data: URLs and actually decode; srcRect crops apply;
 *   6. tables render their grid text;
 *   7. the chart frame becomes a labelled placeholder and the amber banner
 *      counts the skips + states the fidelity hint;
 *   8. zoom: ＋/− move the scale, 适应宽度 returns to 100% at this pane size;
 *   9. a truncated/corrupt pptx falls back to the fallback card; a .ppt keeps
 *      the old markitdown path (which fails for the stub) — also the card.
 *
 * Usage: node scripts/probe-pptx-preview.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pptxgen from 'pptxgenjs'
import sharp from 'sharp'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

const DIR = mkdtempSync(join(tmpdir(), 'pm-pptx-preview-'))

// ── Fixture deck (pptxgenjs, Node side; inches ×96 = px). ──
// The image is three vertical bands — red quarter, green half, blue quarter —
// so the srcRect crop below is PIXEL-assertable: cropping l=25% must show
// green+blue and no red (the wrong position formula lets the red band in).
const bandColors = [
  [200, 60, 60], // x 0..19   red
  [60, 180, 90], // x 20..59  green
  [60, 90, 200], // x 60..79  blue
]
const raw = Buffer.alloc(80 * 40 * 3)
for (let y = 0; y < 40; y++) {
  for (let x = 0; x < 80; x++) {
    const band = x < 20 ? 0 : x < 60 ? 1 : 2
    const i = (y * 80 + x) * 3
    raw[i] = bandColors[band][0]
    raw[i + 1] = bandColors[band][1]
    raw[i + 2] = bandColors[band][2]
  }
}
const png = await sharp(raw, { raw: { width: 80, height: 40, channels: 3 } }).png().toBuffer()

const pptx = new pptxgen()
const slide1 = pptx.addSlide()
slide1.background = { color: 'EEF2F7' }
slide1.addText('季度经营汇报', { x: 1, y: 0.8, w: 8, h: 1, fontSize: 40, bold: true, color: '1F3864', align: 'center' })
slide1.addShape(pptx.ShapeType.roundRect, { x: 1, y: 2, w: 3, h: 1.5, fill: { color: '4472C4' }, rectRadius: 0.15 })
slide1.addImage({ data: `image/png;base64,${png.toString('base64')}`, x: 6, y: 2, w: 1.6, h: 0.8 })
slide1.addTable(
  [
    [{ text: '名称', options: { bold: true } }, { text: '数量' }],
    [{ text: '甲' }, { text: '123' }],
  ],
  { x: 1, y: 4, w: 4 }
)
slide1.addChart(pptx.ChartType.bar, [{ name: '系列', labels: ['一', '二', '三'], values: [3, 5, 4] }], {
  x: 5.5, y: 3.2, w: 3.5, h: 2,
})
const slide2 = pptx.addSlide()
slide2.addText('第二页', { x: 2, y: 2, w: 6, h: 1, fontSize: 28 })

let bin = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }))

// ── Zip surgery: graft the inheritance case onto the generated deck. ──
// Slide 1 gains a title placeholder with NO frame; the layout gains the
// matching ph WITH the frame at 1",0.5" (96,48 px). The model must inherit.
const files = unzipSync(new Uint8Array(bin))
const slide1Xml = strFromU8(files['ppt/slides/slide1.xml'])
files['ppt/slides/slide1.xml'] = strToU8(
  slide1Xml
    .replace(
      '</p:spTree>',
      '<p:sp><p:nvSpPr><p:cNvPr id="99"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
        '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>继承标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>'
    )
    // Crop the image's LEFT 25% away (srcRect before a:stretch per schema):
    // the frame must then show green+blue and no red.
    .replace('<a:stretch><a:fillRect/></a:stretch>', '<a:srcRect l="25000"/><a:stretch><a:fillRect/></a:stretch>')
)
const layoutXml = strFromU8(files['ppt/slideLayouts/slideLayout1.xml'])
files['ppt/slideLayouts/slideLayout1.xml'] = strToU8(
  layoutXml.replace(
    '</p:spTree>',
    '<p:sp><p:nvSpPr><p:cNvPr id="98"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="4762500" cy="952500"/></a:xfrm></p:spPr></p:sp></p:spTree>'
  )
)
// Master decoration picture (the logo case): a 1"×1" pic at the page's top-left
// corner, resolved through the MASTER's own rels — the slide's rels carry no
// such rId, so a parser that borrows them renders a dashed placeholder.
const masterXml = strFromU8(files['ppt/slideMasters/slideMaster1.xml'])
files['ppt/slideMasters/slideMaster1.xml'] = strToU8(
  masterXml.replace(
    '</p:spTree>',
    '<p:pic><p:nvPicPr><p:cNvPr id="97"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rIdM1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic></p:spTree>'
  )
)
const masterRelsXml = strFromU8(files['ppt/slideMasters/_rels/slideMaster1.xml.rels'])
files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = strToU8(
  masterRelsXml.replace(
    '</Relationships>',
    '<Relationship Id="rIdM1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/masterlogo.png"/></Relationships>'
  )
)
files['ppt/media/masterlogo.png'] = new Uint8Array(png)
bin = Buffer.from(zipSync(files))
const PPTX_B64 = bin.toString('base64')

// A corrupt pptx (valid zip magic, garbage after) — the renderer's catch must
// land it on the fallback card.
const BROKEN_B64 = Buffer.from('504b0304 this is not a zip payload'.repeat(20), 'utf8').toString('base64')
// An old-format .ppt (OLE2 magic) — kind routes to markitdown, which the stub
// fails, so the tab must land on the fallback card (today's behaviour, kept).
const PPT_B64 = Buffer.from('D0CF11E0A1B11AE1', 'hex').toString('base64')

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
  ([pptx, broken, ppt]) => {
    window.__bin = { '/w/报告.pptx': pptx, '/w/损坏.pptx': broken, '/w/旧稿.ppt': ppt }
    window.__binaryCalls = []
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
      key === 'readFile' ? () => Promise.resolve(null)
      : key === 'readFileBinary' ? (p) => {
          window.__binaryCalls.push(p)
          return Promise.resolve(window.__bin[p] ?? null)
        }
      : key === 'convertFileToMarkdown' ? () => Promise.resolve({ content: null })
      : key === 'getFileStat' ? () => Promise.resolve({ size: 123456, mtime: '2026-09-19T08:00:00Z' })
      : key === 'openFolder' ? () => Promise.resolve()
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })
  },
  [PPTX_B64, BROKEN_B64, PPT_B64]
)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)
const slides = () => page.locator('[data-pptx-slide]')
const zoomLabel = () => page.locator('[data-zoom-label]')

await page.evaluate(() => window.__mount())
await openFile('/w/报告.pptx')
await slides().first().waitFor()

/* ── 1. Pages. ── */
check('binary read went through readFileBinary exactly once', (await page.evaluate(() => window.__binaryCalls)).length === 1)
check('both slides render as pages', (await slides().count()) === 2, String(await slides().count()))
const pageSize = await slides().first().evaluate((el) => ({ w: el.style.width, h: el.style.height }))
check('page box is the file slide size 960×540', pageSize.w === '960px' && pageSize.h === '540px', JSON.stringify(pageSize))
const slideBg = await slides().first().evaluate((el) => getComputedStyle(el).backgroundColor)
check('slide background is the file EEF2F7', slideBg === 'rgb(238, 242, 247)', slideBg)

/* ── 2. Inherited title (zip-grafted placeholder) + text styles. ── */
// The grafted ph carries NO frame; the layout's matching ph holds the 1",0.5"
// 500×100 frame. The shape renders there — and its text inherits the master
// title style (large, centred), which is exactly PowerPoint's chain.
const inheritedShape = page.locator('[data-pptx-slide="1"] [data-shape]', { hasText: '继承标题' })
const inheritedBox = await inheritedShape.boundingBox()
const pageBox = await slides().first().boundingBox()
check(
  'placeholder-less title inherits the layout frame (1", 0.5" → 96, 48px; 500×100)',
  inheritedBox !== null && pageBox !== null && Math.abs(inheritedBox.x - pageBox.x - 96) < 2 && Math.abs(inheritedBox.y - pageBox.y - 48) < 2 && Math.abs(inheritedBox.width - 500) < 2 && Math.abs(inheritedBox.height - 100) < 2,
  inheritedBox && pageBox ? `dx=${(inheritedBox.x - pageBox.x).toFixed(1)} dy=${(inheritedBox.y - pageBox.y).toFixed(1)} w=${inheritedBox.width.toFixed(1)} h=${inheritedBox.height.toFixed(1)}` : 'missing'
)
const inheritedSpan = await inheritedShape.locator('span', { hasText: '继承标题' }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
check('the inherited title text wears the master title size (44pt → 58.7px)', Math.abs(inheritedSpan - 44 * (96 / 72)) < 0.5, String(inheritedSpan))
const title = page.locator('[data-pptx-slide="1"] span', { hasText: '季度经营汇报' })
const titleStyle = await title.evaluate((el) => {
  const cs = getComputedStyle(el)
  return { color: cs.color, weight: cs.fontWeight, sizePx: parseFloat(cs.fontSize), align: getComputedStyle(el.parentElement).textAlign }
})
check(
  'title wears 40pt bold in the file colour, centred',
  titleStyle.color === 'rgb(31, 56, 100)' && titleStyle.weight === '700' && Math.abs(titleStyle.sizePx - 40 * (96 / 72)) < 0.5 && titleStyle.align === 'center',
  JSON.stringify(titleStyle)
)

/* ── 3. Shapes. ── */
// shape indices: the master decoration picture walks FIRST, so the slide's
// own shapes start at 1 (title), 2 (roundRect), 3 (image)…
const roundRect = page.locator('[data-pptx-slide="1"] [data-shape="2"]')
const rr = await roundRect.evaluate((el) => ({
  bg: getComputedStyle(el).backgroundColor,
  radius: parseFloat(getComputedStyle(el).borderRadius),
  x: el.offsetLeft,
  y: el.offsetTop,
  w: el.offsetWidth,
  h: el.offsetHeight,
}))
check('roundRect fills #4472C4 at its file position (96,192) 288×144',
  rr.bg === 'rgb(68, 114, 196)' && Math.abs(rr.x - 96) < 1 && Math.abs(rr.y - 192) < 1 && Math.abs(rr.w - 288) < 1 && Math.abs(rr.h - 144) < 1, JSON.stringify(rr))
check('roundRect radius = rectRadius 0.15" × min-dim ratio → 14.4px', Math.abs(rr.radius - 14.4) < 1, String(rr.radius))

/* ── 4. Image: data URL that decodes. ── */
const imgDiv = page.locator('[data-pptx-slide="1"] [data-shape="3"]')
const imgSrc = await imgDiv.evaluate((el) => getComputedStyle(el).backgroundImage)
check('image renders from a data: URL', imgSrc.startsWith('url("data:image/png;base64,'), imgSrc.slice(0, 48) + '…')
const decoded = await imgDiv.evaluate((el) => new Promise((resolve) => {
  const m = /url\("([^"]+)"\)/.exec(getComputedStyle(el).backgroundImage)
  const img = new Image()
  img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
  img.onerror = () => resolve(null)
  img.src = m ? m[1] : ''
}))
check('the data URL actually decodes (80×40)', decoded !== null && decoded.w === 80 && decoded.h === 40, JSON.stringify(decoded))
const imgGeom = await imgDiv.evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }))
check('the image fills its frame (1.6"×0.8" → 153.6×76.8, stretched not natural-size)',
  Math.abs(imgGeom.w - 153.6) < 1 && Math.abs(imgGeom.h - 76.8) < 1, JSON.stringify(imgGeom))

/* ── 4b. srcRect crop: position algebra + PIXELS. ── */
// l=25% of the image is trimmed: correct background-position is l/(l+r) = 100%
// (the old l/horizontal formula gave 33.3% and dragged the red band in).
const cropStyle = await imgDiv.evaluate((el) => {
  const cs = getComputedStyle(el)
  return { pos: cs.backgroundPosition, size: cs.backgroundSize }
})
check('crop position solves to l/(l+r) → 100% 50%', /^100% 50%$/.test(cropStyle.pos.replace(/\s+/g, ' ').trim()), cropStyle.pos)
check('background size zooms by the kept window (133.33% × 100%)', Math.abs(parseFloat(cropStyle.size) - 100 / 0.75) < 0.01, cropStyle.size)
const shot = await imgDiv.screenshot()
const { data: px, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
let redPx = 0
let greenPx = 0
let bluePx = 0
for (let i = 0; i < px.length; i += info.channels) {
  const r = px[i]
  const g = px[i + 1]
  const b = px[i + 2]
  if (r > 150 && g < 120 && b < 120) redPx++
  else if (g > 140 && r < 120 && b < 140) greenPx++
  else if (b > 150 && r < 120 && g < 130) bluePx++
}
const totalPx = info.width * info.height
check('cropped render shows NO red band (the trimmed quarter stays out)',
  redPx / totalPx < 0.02, `red=${((redPx / totalPx) * 100).toFixed(1)}%`)
check('cropped render keeps green (2/3) and blue (1/3) bands',
  greenPx / totalPx > 0.5 && bluePx / totalPx > 0.2,
  `green=${((greenPx / totalPx) * 100).toFixed(1)}% blue=${((bluePx / totalPx) * 100).toFixed(1)}%`)

/* ── 4c. Master decoration picture. ── */
check('the master picture renders (no image placeholder on slide 1)', (await page.locator('[data-pptx-slide="1"] [data-ph="image"]').count()) === 0)
const masterImg = await page.evaluate(() => {
  for (const el of document.querySelectorAll('[data-pptx-slide="1"] [data-shape]')) {
    const bg = el.style.backgroundImage
    if (!bg.startsWith('url("data:image/png')) continue
    const host = el.closest('[data-pptx-slide]')
    const box = el.getBoundingClientRect()
    const hostBox = host.getBoundingClientRect()
    if (Math.abs(box.left - hostBox.left) < 2 && Math.abs(box.top - hostBox.top) < 2) {
      return { w: el.clientWidth, h: el.clientHeight }
    }
  }
  return null
})
check('the master picture sits at the page corner at 96×96 (1"×1")', masterImg !== null && Math.abs(masterImg.w - 96) < 1 && Math.abs(masterImg.h - 96) < 1, JSON.stringify(masterImg))

/* ── 5. Table. ── */
const tableCells = await page.locator('[data-pptx-slide="1"] table td').allTextContents()
check('table renders its grid text (名称/数量/甲/123)', tableCells.join(',') === '名称,数量,甲,123', tableCells.join(','))

/* ── 6. Chart placeholder + notes banner. ── */
const chartPh = page.locator('[data-pptx-slide="1"] [data-ph="chart"]')
const chartBox = await chartPh.boundingBox()
// the dashed 1.5px border rides the bounding box, hence the ±3 on width
check('chart frame is a labelled placeholder at its file position',
  (await chartPh.count()) === 1 && chartBox !== null && Math.abs(chartBox.x - pageBox.x - 528) < 2 && Math.abs(chartBox.width - 336) < 3,
  chartBox ? `dx=${(chartBox.x - pageBox.x).toFixed(1)} w=${chartBox.width.toFixed(1)}` : 'missing')
const chartLabel = await chartPh.textContent()
check('placeholder is labelled 图表', chartLabel === '图表', String(chartLabel))
const banner = await page.locator('div', { hasText: '文字换行与行高为近似效果' }).last().textContent()
check('notes banner counts the chart skip and carries the fidelity hint',
  banner !== null && banner.includes('1 个图表以占位框显示') && banner.includes('文字换行与行高为近似效果'), String(banner).slice(0, 80))

/* ── 7. Second page. ── */
const page2Text = await page.locator('[data-pptx-slide="2"] span', { hasText: '第二页' }).textContent()
check('slide 2 renders 第二页', page2Text === '第二页', String(page2Text))

/* ── 8. Zoom. ── */
check('适应宽度 sits at 100% (pane 1100 ≥ slide 960, fit only shrinks)', (await zoomLabel().textContent()) === '100%', await zoomLabel().textContent())
await page.locator('div[title="放大"]').click()
await page.waitForTimeout(150)
const zoomedIn = await zoomLabel().textContent()
check('＋ zooms to 180% (step factor 1.8)', zoomedIn === '180%', zoomedIn)
await page.locator('div[title="适应宽度"]').click()
await page.waitForTimeout(150)
check('适应宽度 returns the fit scale', (await zoomLabel().textContent()) === '100%', await zoomLabel().textContent())

/* ── 9. Broken pptx and legacy .ppt land on the fallback card. ── */
await openFile('/w/损坏.pptx')
await page.waitForTimeout(400)
const brokenCard = await page.locator('div', { hasText: '该格式暂不支持应用内预览' }).count()
check('a corrupt pptx falls back to the fallback card', brokenCard >= 1, String(brokenCard))
await openFile('/w/旧稿.ppt')
await page.waitForTimeout(400)
const pptCard = await page.locator('div', { hasText: '该格式暂不支持应用内预览' }).count()
check('.ppt keeps the markitdown path (stub fails → fallback card)', pptCard >= 1, String(pptCard))
await openFile('/w/报告.pptx')
await slides().first().waitFor()
check('reopening the pptx renders it again (reload idempotent)', (await slides().count()) === 2, String(await slides().count()))

/* ── Summary. ── */
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} checks passed${failures === 0 ? '' : ` — ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
