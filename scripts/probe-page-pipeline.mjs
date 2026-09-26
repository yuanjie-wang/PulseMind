// PMPage is the esbuild bundle globalName (see build() below): every
// reference runs inside the page via page.evaluate, never in this process.
/* global PMPage */
/**
 * Real-browser check of the page DOM pipeline (PLAN-browser-extension M2.1).
 *
 * The unit tests run under jsdom, where `hasLayout()` fails and every geometry
 * check is skipped — visibility by rect, `elementFromPoint` occlusion, viewport
 * scoping and scrollability are therefore NOT covered there. This probe runs
 * the same source in a real Chromium against a fixture page and asserts exactly
 * those behaviours, plus that clicks/typing/scrolls reach the page.
 *
 * It deliberately does not load the extension: a second client with the same
 * clientId would kick whatever the user has connected. The content-script half
 * is exercised directly, which is the half jsdom cannot reach.
 *
 * Usage: node scripts/probe-page-pipeline.mjs   (temporary dev harness)
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-probe-')), 'page-tools.js')

await build({
  entryPoints: ['src/extension/content/page-tools.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PMPage',
  platform: 'browser',
  target: 'chrome110',
  outfile: OUT,
  logLevel: 'warning',
})

const FIXTURE = `<!doctype html>
<html><head><style>
  body { margin: 0; font: 14px system-ui; }
  .overlay { position: fixed; top: 0; left: 0; right: 0; height: 120px; background: rgba(0,0,0,.6); z-index: 10; }
  .hidden { display: none; }
  .tall { height: 3000px; }
  .scroller { width: 200px; height: 100px; overflow: auto; }
  .scroller-inner { height: 900px; }
</style></head>
<body>
  <div class="overlay" id="overlay"></div>
  <button id="covered" style="position:absolute; top:60px; left:30px;">被遮挡按钮</button>
  <button id="visible" style="position:absolute; top:260px; left:30px;">可见按钮</button>
  <input id="q" placeholder="搜索" style="position:absolute; top:320px; left:30px;" />
  <select id="sel" style="position:absolute; top:360px; left:30px;">
    <option value="a">苹果</option><option value="b">香蕉</option>
  </select>
  <div class="hidden"><button id="ghost">隐藏按钮</button></div>
  <div class="scroller" id="scroller" style="position:absolute; top:400px; left:30px;">
    <div class="scroller-inner">很长的内容</div>
  </div>
  <my-widget id="widget" style="position:absolute; top:520px; left:30px;"></my-widget>
  <div class="tall" style="position:absolute; top:1500px; left:30px;">
    <button id="below" style="position:absolute; top:1200px; left:0;">折叠下方按钮</button>
  </div>
  <div aria-hidden="true" style="position:absolute; top:600px; left:30px;">
    <button id="aria">aria 隐藏</button>
  </div>
  <script>
    class MyWidget extends HTMLElement {
      connectedCallback() {
        this.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-btn">影子按钮</button>'
      }
    }
    customElements.define('my-widget', MyWidget)
  </script>
</body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
await page.setContent(FIXTURE)
await page.addScriptTag({ path: OUT })
await page.evaluate(() => {
  const existing = document.querySelector('#scroller')
  existing.scrollTop = 0
})

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Ask the pipeline for the page text and pull an element's index out of it,
 *  the way the model does. */
const indexOf = (text, re) => {
  const m = text.match(re)
  return m ? Number(m[1]) : null
}

// ── the panel host must be invisible to the pipeline ─────────────────
await page.evaluate(() => {
  const host = document.createElement('div')
  host.setAttribute('data-pulsemind-panel', '')
  host.style.cssText = 'position:fixed; right:0; bottom:0; width:160px; height:160px;'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<button id="fab">面板按钮</button>'
  document.body.appendChild(host)
})

const text = await page.evaluate(() => PMPage.pageGetContent({}))
check('own panel DOM is excluded', !text.includes('面板按钮') && !text.includes('fab'))
check('covered button is NOT numbered (elementFromPoint)', !/\[\d+\]<button[^>]*id=covered/.test(text), 'fixed overlay sits on top')
check('visible button IS numbered', /\[\d+\]<button[^>]*id=visible/.test(text))
check('display:none subtree is skipped', !text.includes('隐藏按钮'))
check('aria-hidden subtree is skipped', !text.includes('aria 隐藏'))
check(
  'shadow-DOM content is pierced AND numbered',
  /\[\d+\]<button[^>]*id=shadow-btn/.test(text) && text.includes('影子按钮'),
  'elementFromPoint stops at the host; hitTest must descend',
)
check('scrollable container is flagged', /id=scroller[^>]*data-scrollable/.test(text), 'data-scrollable attr')

// ── viewport scoping: bounds the indices, not the prose ──────────────
// A viewport read must still carry the whole page's text, or "总结这个页面"
// would need one scroll+read per screen. What it withholds is indices.
check('below-fold element is NOT numbered in the viewport-limited view', !/\[\d+\]<button[^>]*id=below/.test(text))
check('below-fold TEXT still arrives in one read', text.includes('折叠下方按钮'), 'index-free prose')
const full = await page.evaluate(() => PMPage.pageGetContent({ viewportExpansion: -1 }))
check('viewportExpansion:-1 numbers the whole page', /\[\d+\]<button[^>]*id=below/.test(full))
check('the full-page view reports the same page size', /Page info:/.test(full))

// ── actions reach the real page ──────────────────────────────────────
const visibleIdx = indexOf(text, /\[(\d+)\]<button[^>]*id=visible/)
await page.evaluate(() => {
  window.__clicks = 0
  document.getElementById('visible').addEventListener('click', () => { window.__clicks += 1 })
})
const clicked = await page.evaluate((i) => PMPage.runPageTool('page_click', { index: i }), visibleIdx)
check('page_click lands a real click', clicked.ok && (await page.evaluate(() => window.__clicks)) === 1, clicked.result ?? clicked.error)

const qIdx = indexOf(text, /\[(\d+)\]<input[^>]*id=q/)
const typed = await page.evaluate(async (i) => {
  window.__events = []
  const el = document.getElementById('q')
  el.addEventListener('input', () => window.__events.push('input'))
  el.addEventListener('change', () => window.__events.push('change'))
  const res = await PMPage.runPageTool('page_input', { index: i, text: '咖啡' })
  return { res, value: el.value, events: window.__events }
}, qIdx)
check('page_input sets the value', typed.value === '咖啡', String(typed.value))
check('page_input fires input+change', JSON.stringify(typed.events) === '["input","change"]', JSON.stringify(typed.events))

const selIdx = indexOf(text, /\[(\d+)\]<select[^>]*id=sel/)
const selected = await page.evaluate(async (i) => {
  const res = await PMPage.runPageTool('page_select', { index: i, option: '香蕉' })
  return { res, value: document.getElementById('sel').value }
}, selIdx)
check('page_select matches by visible text', selected.value === 'b', `${selected.res.result ?? selected.res.error} → ${selected.value}`)

// A stale index must fail loudly rather than click whatever moved into place.
const stale = await page.evaluate(async () => PMPage.runPageTool('page_click', { index: 900 }))
check('a stale index fails with an actionable message', !stale.ok && /page_get_content/.test(stale.error ?? ''), stale.error)

// ── nested scrolling ─────────────────────────────────────────────────
// Done before the window scroll: the fixed overlay covers the top of the
// viewport, so the container is only unobstructed while the page is at 0.
const scrollerIdx = indexOf(text, /\[(\d+)\]<div[^>]*id=scroller/)
if (scrollerIdx === null) {
  check('inner scrollable container got an index', false, 'not found in the view')
} else {
  const inner = await page.evaluate(async (i) => {
    const el = document.getElementById('scroller')
    const t0 = el.scrollTop
    const res = await PMPage.runPageTool('page_scroll', { index: i, down: true, pixels: 300 })
    await new Promise((r) => setTimeout(r, 50))
    return { res, t0, t1: el.scrollTop }
  }, scrollerIdx)
  check('inner scrollable container got an index', true, `[${scrollerIdx}]`)
  check('page_scroll scrolls an inner container', inner.t1 > inner.t0, `${inner.t0} → ${inner.t1}`)
  // Indices are only rebuilt by page_get_content (or a navigation); a scroll
  // must not silently renumber the page under the model.
  const reused = await page.evaluate((i) => PMPage.runPageTool('page_click', { index: i }), scrollerIdx)
  check('an index survives a scroll action', reused.ok, reused.result ?? reused.error)
}

// ── window scrolling ─────────────────────────────────────────────────
const scroll = await page.evaluate(async () => {
  const y0 = window.scrollY
  const res = await PMPage.runPageTool('page_scroll', { down: true, pixels: 400 })
  await new Promise((r) => setTimeout(r, 50))
  return { res, y0, y1: window.scrollY }
})
check('page_scroll moves the window', scroll.y1 > scroll.y0, `${scroll.y0} → ${scroll.y1}`)

// ── page JS + the CSP-free path ──────────────────────────────────────
const js = await page.evaluate(() => PMPage.runPageTool('page_execute_js', { script: '() => args.n + 1', args: { n: 41 } }))
check('page_execute_js binds args by name', js.ok && js.result === '42', js.result ?? js.error)

// ── stable indices + delta reads ─────────────────────────────────────
// Must run before page_back (that may navigate away). Everything above this
// point mutated the page only through properties and scrolls — no attribute
// or text change — so the baseline below is a genuine unchanged snapshot.
const base = await page.evaluate(() => PMPage.pageGetContent({ viewportExpansion: -1 }))
const deltaUnchanged = await page.evaluate(() => PMPage.pageGetContent({ delta: true, viewportExpansion: -1 }))
check(
  'delta on an unchanged page reports zero changes',
  deltaUnchanged.includes('[增量视图]') && deltaUnchanged.includes('无变化'),
  deltaUnchanged.split('\n')[3] ?? '',
)
check(
  'delta on an unchanged page omits every surviving element',
  !deltaUnchanged.includes(`[${visibleIdx}]<button`),
  `index [${visibleIdx}] stayed valid and unlisted`,
)

await page.evaluate(() => {
  const btn = document.createElement('button')
  btn.id = 'delta-new'
  btn.textContent = '增量新按钮'
  document.body.appendChild(btn)
  document.getElementById('visible').setAttribute('aria-expanded', 'true')
  document.getElementById('sel').remove()
})

// A removed element must fail loudly on its cached index — BEFORE any re-read
// rebuilds the map and downgrades the failure to "index not found".
const selOldIdx = indexOf(base, /\[(\d+)\]<select[^>]*id=sel/)
const removedClick = selOldIdx === null ? { ok: true } : await page.evaluate((i) => PMPage.runPageTool('page_click', { index: i }), selOldIdx)
check(
  'a removed element index fails loudly',
  selOldIdx !== null && !removedClick.ok && /已从页面移除/.test(removedClick.error ?? ''),
  removedClick.error ?? 'select index not found in baseline',
)

const deltaChanged = await page.evaluate(() => PMPage.pageGetContent({ delta: true, viewportExpansion: -1 }))
check('delta lists a newly added element', /\+\s+\*\[\d+\]<button[^>]*id=delta-new/.test(deltaChanged), '')
check('delta lists a changed element', /~\s+\[\d+\]<button[^>]*aria-expanded=true/.test(deltaChanged), '')
check(
  'delta lists a removed element',
  /-\s+\[\d+\]<select[^>]*id=sel/.test(deltaChanged) && deltaChanged.includes('已消失'),
  '',
)
check(
  'delta omits elements that did not change',
  !/\[\d+\]<input[^>]*id=q/.test(deltaChanged),
  'the untouched input stays out of the diff body',
)

// The stable-index payoff: act on an index from an OLD read without re-reading,
// even though the DOM gained and lost elements since.
const clickedAgain = await page.evaluate((i) => PMPage.runPageTool('page_click', { index: i }), visibleIdx)
check(
  'an index from an earlier read still acts after unrelated DOM changes',
  clickedAgain.ok && (await page.evaluate(() => window.__clicks)) === 2,
  clickedAgain.result ?? clickedAgain.error,
)

// Too-large changes fall back to the full view — a diff that lists most of the
// page is the full page plus overhead.
await page.evaluate(() => {
  for (let i = 0; i < 40; i += 1) {
    const b = document.createElement('button')
    b.id = `flood-${i}`
    b.textContent = `洪水按钮 ${i}`
    document.body.appendChild(b)
  }
})
const flooded = await page.evaluate(() => PMPage.pageGetContent({ delta: true, viewportExpansion: -1 }))
check(
  'a too-large delta falls back to the full view',
  !flooded.includes('[增量视图]') && flooded.includes('id=flood-39'),
  '',
)

const back = await page.evaluate(() => PMPage.runPageTool('page_back', {}))
check('page_back reports the history call', back.ok && /history\.back\(\)/.test(back.result ?? ''), back.result ?? back.error)

// ── node cap ─────────────────────────────────────────────────────────
// Separate page: a pathological document must be cut short and *say so*,
// rather than returning a silently partial view.
const big = await browser.newPage({ viewport: { width: 900, height: 700 } })
await big.setContent(
  `<!doctype html><html><body>` +
    Array.from({ length: 1200 }, (_, i) => `<div><span>第 ${i} 行</span><span>第二列</span></div>`).join('') +
    `</body></html>`,
)
await big.addScriptTag({ path: OUT })
const bigWalk = await big.evaluate(() => {
  const started = performance.now()
  const out = PMPage.pageGetContent({})
  const deltaOut = PMPage.pageGetContent({ delta: true })
  return {
    ms: Math.round(performance.now() - started),
    hasCapWarning: out.includes('节点数超过'),
    chars: out.length,
    deltaIsFull: deltaOut.includes('节点数超过') && !deltaOut.includes('[增量视图]'),
  }
})
check('over-cap page is truncated and labelled', bigWalk.hasCapWarning, `${bigWalk.ms}ms, ${bigWalk.chars} chars`)
check('a truncated build never reports a delta', bigWalk.deltaIsFull, 'a partial baseline cannot support a diff')
await big.close()

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
writeFileSync(join(tmpdir(), 'pm-probe-done'), 'ok')
