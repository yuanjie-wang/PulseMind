// ── Browser-side fact check for the shared visual-center padding ── Under a
// CLASSIC (layout-consuming) scrollbar, centering inside the content box makes
// the right grey gutter read `gutter + scrollbar` wide; the helper's padding
// makes both sides measure the same from the pane's edge. Headed on purpose —
// the headless shell renders no scrollbars at all.
//
// Usage: node scripts/probe-visual-center.mjs
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-visual-center-')), 'helper.js')
const results = []
function check(name, pass, detail) {
  results.push(pass)
  console.log(`${pass ? '✓' : '✗ FAIL'} ${name}${pass ? '' : `  [${detail}]`}`)
}

// The REAL helper, bundled for the page.
await build({
  stdin: {
    contents: `import { visualCenterPaddingX } from '${process.cwd()}/src/renderer/src/components/preview/visual-center';
window.__padX = visualCenterPaddingX; window.__ready = true`,
    resolveDir: process.cwd(),
    loader: 'ts',
    sourcefile: 'helper-entry.ts',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  logLevel: 'warning',
})

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
await page.setContent(`<!doctype html><html><head><style>
  /* A classic, layout-consuming vertical scrollbar — the user's macOS
     「始终显示滚动条」 posture. */
  .scroller::-webkit-scrollbar { width: 15px; height: 15px }
  .scroller::-webkit-scrollbar-thumb { background: #aab }
  .scroller::-webkit-scrollbar-track { background: #808080 }
  .case { position: relative; width: 700px; height: 300px; margin-bottom: 12px }
  .scroller { position: absolute; inset: 0; overflow: auto; background: #808080 }
  .paper { background: #fff }
</style></head><body>
<div class="case" data-case="pdf">
  <div class="scroller"><div class="doc" style="width:fit-content;padding:16px"><div class="paper" style="width:636px;height:800px"></div></div></div>
</div>
<div class="case" data-case="pptx">
  <div class="scroller" style="display:flex"><div class="zoomed" style="zoom:0.6958"><div class="paper" style="width:960px;height:800px"></div></div></div>
</div>
<div class="case" data-case="xlsx">
  <div class="scroller"><table class="paper" style="width:668px;height:800px;border-collapse:collapse"><tr><td></td></tr></table></div>
</div>
<div class="case" data-case="docx">
  <div class="scroller"><div class="zoomed" style="zoom:0.7822;padding:30px;background:#808080;width:794px;box-sizing:content-box"><div class="paper" style="width:794px;height:800px"></div></div></div>
</div>
<div class="case" data-case="plain">
  <div class="scroller" style="display:flex;justify-content:center"><div class="paper" style="width:668px;height:800px"></div></div>
</div>
</body></html>`)
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

// All inside the page: measure painted widths, apply the helper's padding,
// then read the visual gutters from the pane's edge.
const m = await page.evaluate(() => {
  const out = {}
  for (const c of document.querySelectorAll('.case')) {
    const name = c.dataset.case
    const scroller = c.querySelector('.scroller')
    const el = name === 'pdf' ? scroller.querySelector('.doc') : scroller.querySelector('.zoomed, .paper, table')
    if (name !== 'plain') {
      scroller.style.paddingLeft = `${window.__padX(scroller, el.getBoundingClientRect().width)}px`
    }
  }
  for (const c of document.querySelectorAll('.case')) {
    const name = c.dataset.case
    const scroller = c.querySelector('.scroller')
    const el = name === 'pdf' ? scroller.querySelector('.doc') : scroller.querySelector('.zoomed, .paper, table')
    const s = scroller.getBoundingClientRect()
    const e = el.getBoundingClientRect()
    out[name] = {
      left: Math.round(e.x - s.x),
      right: Math.round(s.x + s.width - (e.x + e.width)),
      sb: scroller.offsetWidth - scroller.clientWidth,
    }
  }
  return out
})
for (const name of ['pdf', 'pptx', 'xlsx', 'docx']) {
  check(`${name}: visual gutters symmetric under a classic scrollbar`, m[name].left === m[name].right && m[name].sb === 15, JSON.stringify(m[name]))
}
check(
  'non-vacuity: plain content-box centering IS lopsided by the scrollbar width',
  m.plain.sb === 15 && m.plain.right - m.plain.left === 15,
  JSON.stringify(m.plain),
)

await browser.close()
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every(Boolean) ? 0 : 1)
