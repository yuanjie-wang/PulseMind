/**
 * PDF preview probe (PLAN-pdf-preview; real Chromium, production components).
 *
 * Mounts the real PreviewPane over a stubbed electronAPI whose readFileBinary
 * serves PDF fixtures written by hand in this script (no generator dep): a
 * minimal single-font PDF writer plus the R=2 standard security handler
 * (40-bit RC4) for the encrypted one. Drives the whole preview story the way
 * a user would:
 *
 *   1. the 3-page document renders — placeholders for every page, a canvas
 *      raster for the visible one, backing store 1:1 with display pixels;
 *   2. the landscape first page drives 适应宽度 below 100%;
 *   3. the page bar tracks scrolling and jumps (input + prev/next);
 *   4. the 305-page document caps at 300 placeholders with the amber note,
 *      and only the visible band ± buffer ever holds canvases;
 *   5. zoom: ＋ moves the scale and the canvas re-renders its backing store;
 *      适应宽度 returns to the fitted scale;
 *   6. the encrypted fixture lands on its own card (PasswordException gate),
 *      a corrupt file on the default fallback card, an oversized payload on
 *      the byte-gate card — and markitdown is never called for .pdf.
 *
 * Usage: node scripts/probe-pdf-preview.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const DIR = mkdtempSync(join(tmpdir(), 'pm-pdf-preview-'))

// ── PDF fixtures, written by hand. ──

const md5 = (buf) => createHash('md5').update(buf).digest()
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])
const padPw = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32)

function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff
    ;[S[i], S[j]] = [S[j], S[i]]
  }
  const out = Buffer.alloc(data.length)
  let i = 0
  j = 0
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + S[i]) & 0xff
    ;[S[i], S[j]] = [S[j], S[i]]
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff]
  }
  return out
}

/** Minimal single-font PDF: catalog(1) / pages(2) / font(3), then per page a
 *  page object and its content stream. With `userPw`, encrypted per the R=2
 *  standard security handler (40-bit RC4, fixed file ID) — pdf.js must
 *  reject it with PasswordException, which is exactly the gate under test. */
function buildPdf({ pages, userPw }) {
  const idHex = '9a1f2e3c4d5b6a7980f1e2d3c4b5a697'
  const ascii = (s) => Buffer.from(s, 'latin1')
  // /Length must live INSIDE the stream dictionary: `<< >> /Length N` leaves
  // the dict empty and pdf.js decodes the stream as nothing — a file whose
  // pages all exist with correct sizes but render blank (this cost a
  // debugging round: the ink check below is what catches it).
  const streamObj = (extra, data) => Buffer.concat([ascii(`<< ${extra} /Length ${data.length} >>\nstream\n`), data, ascii('\nendstream')])
  const objects = []
  objects.push(ascii('<< /Type /Catalog /Pages 2 0 R >>'))
  objects.push(ascii(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`))
  objects.push(ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'))

  let enc = null
  if (userPw !== undefined) {
    const P = -3904
    const pBuf = Buffer.alloc(4)
    pBuf.writeInt32LE(P)
    const O = rc4(md5(padPw(userPw)).subarray(0, 5), padPw(userPw))
    const fileKey = md5(Buffer.concat([padPw(userPw), O, pBuf, Buffer.from(idHex, 'hex')])).subarray(0, 5)
    enc = { O, U: rc4(fileKey, PAD), P, fileKey }
  }

  const objKey = (num, gen) => {
    const extra = Buffer.alloc(5)
    extra.writeUIntLE(num, 0, 3)
    extra.writeUIntLE(gen, 3, 2)
    return md5(Buffer.concat([enc.fileKey, extra])).subarray(0, Math.min(enc.fileKey.length + 5, 16))
  }

  pages.forEach((p, i) => {
    const pageObj = 4 + i * 2
    const contentObj = pageObj + 1
    let content = ascii(`BT /F1 ${p.size ?? 40} Tf 72 ${p.h - 140} Td (${p.text}) Tj ET`)
    if (enc) content = rc4(objKey(contentObj, 0), content)
    objects.push(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`))
    objects.push(streamObj('', content))
  })
  if (enc) {
    // The /Encrypt dict is pushed last, so its object number is only known
    // now — trailer and dict must agree or pdf.js reads the wrong object.
    enc.num = objects.length + 1
    objects.push(ascii(`<< /Filter /Standard /V 1 /R 2 /O <${enc.O.toString('hex')}> /U <${enc.U.toString('hex')}> /P ${enc.P} >>`))
  }

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  let pos = chunks[0].length
  const offsets = []
  for (let n = 1; n <= objects.length; n++) {
    offsets[n] = pos
    const body = Buffer.concat([Buffer.from(`${n} 0 obj\n`, 'latin1'), objects[n - 1], Buffer.from('\nendobj\n', 'latin1')])
    chunks.push(body)
    pos += body.length
  }
  const xrefStart = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= objects.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${enc ? ` /Encrypt ${enc.num} 0 R` : ''} /ID [<${idHex}><${idHex}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`
  chunks.push(ascii(xref + trailer))
  return Buffer.concat(chunks)
}

const A4 = { w: 595, h: 842 }
const wide3 = buildPdf({
  pages: [
    { w: 1400, h: 800, text: 'Wide first page', size: 64 },
    { ...A4, text: 'Page two' },
    { ...A4, text: 'Page three' },
  ],
})
const longBook = buildPdf({
  pages: Array.from({ length: 305 }, (_, i) => ({ ...A4, text: `Page ${i + 1}` })),
})
const secret = buildPdf({ pages: [{ ...A4, text: 'Secret page' }], userPw: 'pm-secret' })

const B64 = (buf) => buf.toString('base64')
const FIXTURES = {
  '/w/三页.pdf': B64(wide3),
  '/w/长书.pdf': B64(longBook),
  '/w/加密.pdf': B64(secret),
  '/w/损坏.pdf': Buffer.from('this is not a pdf at all').toString('base64'),
}

// ── Harness: the production PreviewPane over the stubbed bridge. ──
const OUT = join(DIR, 'harness.js')
const WORKER_SHIM = join(DIR, 'worker-url-shim.mjs')
// esbuild has no ?url idiom; alias the Vite-style worker import to a shim
// that names the URL the route table below serves the real worker file at.
await (await import('node:fs/promises')).writeFile(
  WORKER_SHIM,
  'export default window.location.origin + "/pdf.worker.min.mjs"\n'
)
const HARNESS = `
import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { PreviewPane } from './src/renderer/src/components/preview/PreviewPane'

let root = null
window.__mount = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  // StrictMode, because the app's main.tsx renders <React.StrictMode> — the
  // first draft of PdfPreview mounted canvases everywhere EXCEPT under it
  // (a cleanup left a stale rAF handle that blocked every later schedule),
  // which is exactly the user's blank-pages-with-correct-page-count report.
  root.render(
    <StrictMode>
      <ConfigProvider>
        <TranslationProvider initialLocale="zh">
          <PreviewPane conversationId={undefined} />
        </TranslationProvider>
      </ConfigProvider>
    </StrictMode>
  )
  return true
}
window.__store = usePreviewPaneStore
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  alias: { 'pdfjs-dist/build/pdf.worker.min.mjs?url': WORKER_SHIM },
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
page.on('console', (msg) => {
  if (msg.type() === 'warning' || msg.type() === 'error') console.log(`  [console.${msg.type()}]`, msg.text())
})
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root" style="height:700px"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
// The real worker file, served same-origin so pdf.js runs it as a module
// worker (the in-thread fake-worker fallback would cover it either way).
await page.route('**/pdf.worker.min.mjs', async (route) => {
  const worker = await readFile(join(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'))
  await route.fulfill({ contentType: 'text/javascript', body: worker })
})
await page.goto('http://pm-probe.local/')

await page.evaluate(
  ([fixtures]) => {
    window.__bin = fixtures
    window.__binaryCalls = []
    window.__mdCalls = []
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
      key === 'readFile' ? () => Promise.resolve(null)
      : key === 'readFileBinary' ? (p) => {
          window.__binaryCalls.push(p)
          return Promise.resolve(window.__bin[p] ?? null)
        }
      : key === 'convertFileToMarkdown' ? (p) => {
          window.__mdCalls.push(p)
          return Promise.resolve({ content: null })
        }
      : key === 'getFileStat' ? () => Promise.resolve({ size: 12345, mtime: '2026-09-19T08:00:00Z' })
      : key === 'openFolder' ? () => Promise.resolve()
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })
  },
  [{ ...FIXTURES, '/w/巨大.pdf': 'A'.repeat(90_000_000) }] // 90M b64 chars ≈ 67.5MB > the 64MB gate
)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const openFile = (path) => page.evaluate((p) => window.__store.getState().openFile(null, p), path)
const scrollBox = () => page.locator('[data-pdf-scroll]')
const pageCount = () => page.locator('[data-pdf-page]').count()
const canvasCount = () => page.locator('[data-pdf-page] canvas').count()
const pageInput = () => page.locator('[data-pdf-page-input]')
const zoomLabel = () => page.locator('[data-zoom-label]')
const waitCanvas = (n, timeout = 15000) => page.locator(`[data-pdf-page="${n}"] canvas`).waitFor({ timeout })
/** Non-white pixel share of one page's canvas — a page the renderer drew
 *  carries text ink; an all-white canvas is a render that failed silently
 *  (the exact "blank page, correct page count" report this probe must never
 *  bless again). */
const inkShare = (n) => page.locator(`[data-pdf-page="${n}"] canvas`).evaluate((canvas) => {
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let inked = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) inked++
  }
  return inked / (data.length / 4)
})

await page.evaluate(() => window.__mount())

/* ── 1. The 3-page document: placeholders, raster, honest backing store. ── */
await openFile('/w/三页.pdf')
await waitCanvas(1)
check('.pdf never reaches markitdown (the dispatcher routes it)', (await page.evaluate(() => window.__mdCalls)).length === 0)
const binCalls = await page.evaluate(() => window.__binaryCalls)
// StrictMode double-mounts the loader, so the count is 2 per open — what the
// check pins is that pdf reads ride readFileBinary and nothing else does.
check('pdf reads ride readFileBinary (StrictMode double-mount tolerated)', binCalls.length >= 1 && binCalls.every((p) => typeof p === 'string' && p.endsWith('.pdf')), JSON.stringify(binCalls))
check('all three pages have placeholders (scrollbar honest from the start)', (await pageCount()) === 3, String(await pageCount()))
const box1 = await page.locator('[data-pdf-page="1"]').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
const cv1 = await page.locator('[data-pdf-page="1"] canvas').evaluate((el) => ({ w: el.width, h: el.height, cssW: el.clientWidth }))
check('page 1 canvas backs its box 1:1 (dpr 1, ±1px rounding)',
  Math.abs(cv1.w - box1.w) <= 1 && Math.abs(cv1.h - box1.h) <= 1 && cv1.cssW === box1.w, JSON.stringify({ box1, cv1 }))
const ink1 = await inkShare(1)
check('page 1 actually carries ink (the blank-page regression gate)', ink1 > 0.001, `inked ${(ink1 * 100).toFixed(2)}%`)
check('only the visible band ± buffer renders — pages 2-3 may hold canvases here', [2, 3].includes(await canvasCount()), String(await canvasCount()))

/* ── 2. Fit: the landscape first page drives the scale below 100%. ── */
const fitNow = await zoomLabel().textContent()
check('opened fitted to the widest page (landscape 1400pt → < 100%)', fitNow !== '100%' && fitNow.endsWith('%'), fitNow)

/* ── 3. Page bar: tracks scrolling, jumps by input and by button. ── */
check('page bar reads 1 / 3', (await pageInput().inputValue()) === '1' && (await page.locator('[data-pdf-pagebar]').textContent()).includes('/ 3'))
await page.locator('div[title="下一页"]').click()
await page.waitForFunction(() => document.querySelector('[data-pdf-page-input]')?.value === '2')
check('下一页 moved to page 2 and scrolled', await scrollBox().evaluate((el) => el.scrollTop > 0))
check('page 2 canvas appeared', (await page.locator('[data-pdf-page="2"] canvas').count()) === 1)

/* ── 4. The 305-page book: cap, laziness, jump. ── */
await openFile('/w/长书.pdf')
await waitCanvas(1)
check('305 pages cap at 300 placeholders with the amber note', (await pageCount()) === 300 && (await page.locator('text=共 305 页，仅显示前 300 页').count()) === 1)
check('zoom is 100% (all-A4 fits without shrinking)', (await zoomLabel().textContent()) === '100%')
check('only the visible band ± buffer holds canvases at the top', (await canvasCount()) === 3, String(await canvasCount()))
await scrollBox().evaluate((el) => { el.scrollTop = 1e9 })
await waitCanvas(300)
check('scrolled to the end: page 300 rastered, the window stays small', (await canvasCount()) <= 6, String(await canvasCount()))
check('the page bar tracks the end (300)', (await pageInput().inputValue()) === '300')
await pageInput().click()
await pageInput().fill('150')
await pageInput().press('Enter')
await page.waitForFunction(() => document.querySelector('[data-pdf-page-input]')?.value === '150')
const jumpTop = await scrollBox().evaluate((el) => el.scrollTop)
check('jumping to 150 landed on the page top', jumpTop > 0 && (await page.locator('[data-pdf-page="150"] canvas').count()) === 1, `scrollTop ${jumpTop}`)
await page.locator('div[title="上一页"]').click()
await page.waitForFunction(() => document.querySelector('[data-pdf-page-input]')?.value === '149')
check('上一页 stepped back to 149', true)

/* ── 5. Zoom on the 3-page doc: scale moves, backing store follows, fit returns. ── */
await openFile('/w/三页.pdf')
await waitCanvas(1)
await page.locator('div[title="放大"]').click()
const upLabel = await zoomLabel().textContent()
check('＋ moved the scale up past the fit', parseFloat(upLabel) > parseFloat(fitNow), `${fitNow} → ${upLabel}`)
await page.waitForTimeout(350) // the 120ms render debounce + raster time
const cvUp = await page.locator('[data-pdf-page="1"] canvas').evaluate((el) => el.width)
check('the canvas re-rendered at the new scale (backing store grew)', cvUp > cv1.w, `${cv1.w} → ${cvUp}`)
await page.locator('div[title="适应宽度"]').click()
check('适应宽度 returned to the fitted scale', (await zoomLabel().textContent()) === fitNow)

/* ── 6. The gates: encrypted, corrupt, oversized — and reload idempotence. ── */
await openFile('/w/加密.pdf')
await page.locator('button:has-text("在系统中打开")').waitFor()
check('the encrypted PDF landed on its own card, not a blank pane', (await page.locator('text=已加密').count()) === 1)
check('no placeholders rendered for the encrypted file', (await pageCount()) === 0)
await openFile('/w/损坏.pdf')
await page.locator('button:has-text("在系统中打开")').waitFor()
check('a corrupt .pdf lands on the default fallback card (no hint override)', (await page.locator('text=该格式暂不支持应用内预览').count()) === 1 && (await pageCount()) === 0)
await openFile('/w/巨大.pdf')
await page.locator('button:has-text("在系统中打开")').waitFor()
check('the oversized payload stopped at the byte gate (64.0 MB named)', (await page.locator('text=文件过大').count()) === 1 && (await page.locator('text=64.0 MB').count()) === 1)
check('the byte gate fired before decode (readFileBinary, no markitdown)', (await page.evaluate(() => window.__mdCalls)).length === 0)

await openFile('/w/三页.pdf')
await waitCanvas(1)
await page.evaluate(() => window.__store.getState().bumpReload('/w/三页.pdf'))
await waitCanvas(1, 10000)
check('a reload tick re-parses idempotently', (await pageCount()) === 3)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
