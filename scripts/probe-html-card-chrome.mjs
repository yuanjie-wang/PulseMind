/**
 * HTML artifact card chrome + height probe (real Chromium).
 *
 * The card's chrome is hover-only (2026-10-09 user ruling): at rest the card
 * is a bare rounded iframe — no header bar, transparent border; hovering
 * floats the five controls (preview/code tabs + copy/browser/pane) in a
 * toolbar OUTSIDE the card's top-right corner, and a streaming badge rides
 * the top-left. The facts worth a real browser:
 *
 *   - the toolbar extends ABOVE the card, so ANY ancestor with overflow
 *     clipping (a bubble, a markdown container added tomorrow) silently cuts
 *     it — invisible to source scans, caught here with elementFromPoint
 *   - the 6px padding bridge under the toolbar is the hover continuity: the
 *     pointer crosses it without the card losing :hover (a flicker here makes
 *     the toolbar unreachable by mouse)
 *   - the invisible toolbar must not block clicks on the content above the
 *     card (pointer-events: none at rest)
 *   - the height contract end-to-end: fragment / FULL DOCUMENT / tiny all
 *     report through the measure script and clamp into [120, 800] — including
 *     the full-document injection, which no node-env test can drive
 *
 * No Electron, no LLM: `window.electronAPI` is a Proxy whose every method
 * resolves () — getDataPaths() therefore resolves undefined, persistHtmlCopy
 * throws inside and returns null, and the frame takes the srcdoc fallback
 * (this page carries no CSP, so the inline measure script runs). Nothing is
 * written to disk and no session is touched.
 *
 * Usage: node scripts/probe-html-card-chrome.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-html-card-chrome-')), 'harness.js')

const FRAGMENT_TALL = '<div style="height:3000px;background:#e8f0fe">tall fragment</div>'
const FRAGMENT_TINY = '<div style="height:20px;background:#e8f0fe">tiny</div>'
// A page the model authored whole — the shape that used to ride the default
// 280px forever (the 2026-10-09 height fix's main subject).
const FULL_DOC =
  '<!doctype html><html><head><title>p</title></head><body style="margin:0"><div style="height:500px;background:#fce8e6">full document</div></body></html>'

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { HtmlArtifactCard } from './src/renderer/src/components/chat/HtmlArtifactCard'

installThemeVars()
applyThemeAttr('light')

// Every bridge method resolves (): getDataPaths() → undefined makes
// persistHtmlCopy fail → the srcdoc fallback renders (see the header).
window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve() })

// The chat context the card lives in: a bubble inside a message column. No
// ancestor may clip (the real bubble chain does not) — the probe pins that
// assumption together with the card: if either starts clipping, this fails.
function Case({ id, code, streaming }) {
  return (
    <div data-case={id} style={{ width: 900, margin: '0 auto 80px' }}>
      <div style={{ background: '#f0f2f4', borderRadius: 12, padding: '4px 12px', fontFamily: 'system-ui' }}>
        <HtmlArtifactCard code={code} streaming={streaming} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <TranslationProvider>
    <Case id="cap" code={${JSON.stringify(FRAGMENT_TALL)}} />
    <Case id="fulldoc" code={${JSON.stringify(FULL_DOC)}} />
    <Case id="tiny" code={${JSON.stringify(FRAGMENT_TINY)}} />
    <Case id="stream" code={${JSON.stringify(FRAGMENT_TINY)}} streaming />
    {/* The occlusion report: a card scrolled to the top of its scroll
        container — the outside toolbar would cross the scroller's clip edge
        and get cut (「被前一个消息块遮挡」). The card must flip inside. */}
    <div data-case="clipped" style={{ width: 900, margin: '0 auto 80px' }}>
      <div id="clip-scroller" style={{ height: 380, overflowY: 'auto', border: '1px solid #ddd' }}>
        <div style={{ height: 120, background: '#fafafa' }}>上方内容占位</div>
        <div style={{ background: '#f0f2f4', borderRadius: 12, padding: '4px 12px', fontFamily: 'system-ui' }}>
          <HtmlArtifactCard code={${JSON.stringify(FRAGMENT_TINY)}} />
        </div>
        <div style={{ height: 240 }} />
      </div>
    </div>
  </TranslationProvider>
)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1000, height: 2400 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// Top padding = the transcript's own headroom: the toolbar lives ABOVE its
// card, and an element above the viewport top is invisible to
// elementFromPoint (null) and to hit-testing — every check below needs it
// on-screen without scrolling.
const PAGE = '<!doctype html><html><body style="margin:0;padding-top:120px"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

const caseSel = (id) => `[data-case=${id}]`

async function waitForHeight(id, expected) {
  await page.waitForFunction(
    ([cid, want]) => {
      const el = document.querySelector(`[data-case=${cid}] iframe`)
      return el && Math.abs(parseFloat(getComputedStyle(el).height) - want) < 1
    },
    [id, expected],
  )
}

console.log('── 高度契约端到端（srcdoc + 测量脚本真跑） ──')
await waitForHeight('cap', 800)
check('tall fragment (3000px) clamps to the 800 cap', true, 'height=800')
await waitForHeight('fulldoc', 500)
check('full document (500px) auto-sizes to its content', true, 'height=500 (was pinned at 280 before the fix)')
await waitForHeight('tiny', 280)
check('tiny fragment keeps the 280 default (scrollHeight never reads below the viewport)', true, 'height=280; the 120 floor only guards degenerate reports')

console.log('── 静止态：chrome 不在场，也不挡点击 ──')
const rest = await page.evaluate(() => {
  const root = document.querySelector('[data-case=cap] .pm-html-card')
  const float = root.querySelector('.pm-html-card-float')
  const toolbar = root.querySelector('.pm-html-card-toolbar')
  // opacity rides the FLOAT (the toolbar's own opacity is a constant 1 —
  // opacity does not inherit); pointer-events is what inherits down.
  const rr = toolbar.getBoundingClientRect()
  // The toolbar is laid out at rest; hit-test its center to prove the
  // invisible state does not intercept the pointer.
  const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2)
  return {
    opacity: getComputedStyle(float).opacity,
    pointerEvents: getComputedStyle(toolbar).pointerEvents,
    borderColor: getComputedStyle(root).borderTopColor,
    hitIsToolbar: !!hit && !!hit.closest('.pm-html-card-toolbar'),
  }
})
check('rest: toolbar is transparent', rest.opacity === '0', `opacity=${rest.opacity}`)
check('rest: toolbar does not intercept the pointer', rest.pointerEvents === 'none' && !rest.hitIsToolbar, `pointer-events=${rest.pointerEvents}`)
check('rest: card border is transparent', rest.borderColor === 'rgba(0, 0, 0, 0)', `border=${rest.borderColor}`)

console.log('── 悬停态：工具栏在右上外侧、不被裁切 ──')
const cardBox = await page.locator(`${caseSel('cap')} .pm-html-card`).boundingBox()
await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
await page.waitForTimeout(300) // the 0.15s opacity transition, with margin
const hover = await page.evaluate(() => {
  const root = document.querySelector('[data-case=cap] .pm-html-card')
  const toolbar = root.querySelector('.pm-html-card-toolbar')
  const t = toolbar.getBoundingClientRect()
  const c = root.getBoundingClientRect()
  // The kill-check for ancestor clipping/overlay: when hovered, the toolbar
  // really receives the pointer at its own center.
  const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
  return {
    opacity: getComputedStyle(toolbar).opacity,
    pointerEvents: getComputedStyle(toolbar).pointerEvents,
    border: getComputedStyle(root).borderTopColor,
    aboveCard: t.bottom <= c.top + 0.5,
    fullyRight: Math.abs(t.right - c.right) < 2,
    receivesPointer: !!hit && !!hit.closest('.pm-html-card-toolbar'),
  }
})
check('hover: toolbar fades in and turns interactive', hover.opacity === '1' && hover.pointerEvents === 'auto', `opacity=${hover.opacity} pointer-events=${hover.pointerEvents}`)
check('hover: card border stays transparent (no hover border)', hover.border === 'rgba(0, 0, 0, 0)', `border=${hover.border}`)
check('hover: toolbar sits entirely ABOVE the card', hover.aboveCard, 'toolbar.bottom <= card.top')
check('hover: toolbar is right-aligned with the card', hover.fullyRight)
check('hover: toolbar receives the pointer at its center (no ancestor clipping)', hover.receivesPointer)

console.log('── 桥接与点击：跨过 6px 间隙不闪失，tab 真的可按 ──')
// Walk the pointer from the card center up to the 源码 tab in small steps —
// the path crosses the toolbar's padding bridge; if the card lost :hover
// mid-way the toolbar would fade out and the final click would miss. Exact
// regex: '预览' also prefixes 在预览中打开's title (that button's textContent
// is empty — icon only — but stay explicit).
const tab = page.locator(`${caseSel('cap')} .pm-html-card-toolbar button`, { hasText: /^源码$/ })
const tabBox = await tab.boundingBox()
const steps = 12
for (let i = 0; i <= steps; i++) {
  const x = cardBox.x + cardBox.width / 2 + ((tabBox.x + tabBox.width / 2 - (cardBox.x + cardBox.width / 2)) * i) / steps
  const y = cardBox.y + cardBox.height / 2 + ((tabBox.y + tabBox.height / 2 - (cardBox.y + cardBox.height / 2)) * i) / steps
  await page.mouse.move(x, y)
}
await page.waitForTimeout(300)
const walked = await page.evaluate(() => {
  const float = document.querySelector('[data-case=cap] .pm-html-card-float')
  return getComputedStyle(float).opacity
})
check('pointer crosses the bridge without losing the toolbar', walked === '1', `opacity after walk=${walked}`)
await tab.click()
await page.waitForTimeout(100)
const codeShown = await page.evaluate(() => {
  const root = document.querySelector('[data-case=cap] .pm-html-card')
  return !!root.querySelector('pre') && !root.querySelector('iframe')
})
check('源码 tab switches the card to the source view', codeShown)
const previewTab = page.locator(`${caseSel('cap')} .pm-html-card-toolbar button`, { hasText: /^预览$/ })
await previewTab.click()
await page.waitForTimeout(100)
const previewBack = await page.evaluate(() => !!document.querySelector('[data-case=cap] iframe'))
check('预览 tab switches back to the iframe', previewBack)

console.log('── 甩指针：跳过工具栏命中区也不许死锁 ──')
// The shape that deadlocked a pure :hover gate: one mouse event landing
// ABOVE the toolbar flips pointer-events off in the same frame hover is
// lost, and the pointer parked on the pass-through toolbar can never
// re-hover. The leave-grace must keep the toolbar reachable: flick out,
// immediately back onto the tab, click.
await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, { steps: 4 })
await page.waitForTimeout(250)
await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y - 44) // one jump past the toolbar
await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2) // straight back onto it
await page.waitForTimeout(250)
const flick = await page.evaluate(() => {
  const float = document.querySelector('[data-case=cap] .pm-html-card-float')
  return getComputedStyle(float).opacity
})
check('flick past the toolbar keeps it alive (grace, no deadlock)', flick === '1', `opacity=${flick}`)
await tab.click()
await page.waitForTimeout(100)
const flickClick = await page.evaluate(() => {
  const root = document.querySelector('[data-case=cap] .pm-html-card')
  return !!root.querySelector('pre') && !root.querySelector('iframe')
})
check('源码 tab is clickable after the flick', flickClick)

console.log('── 流式徽标：常驻左上外侧（非悬停态） ──')
const chip = await page.evaluate(() => {
  const root = document.querySelector('[data-case=stream] .pm-html-card')
  const chip = root.querySelector('.pm-html-card-stream')
  if (!chip) return { present: false }
  // Measure the inner pill: the stream div carries the 6px hover bridge as
  // padding, so its own box bottom lands ~1px into the card's border.
  const pill = chip.querySelector('span')
  const ch = pill.getBoundingClientRect()
  const c = root.getBoundingClientRect()
  return {
    present: true,
    visible: ch.height > 0 && getComputedStyle(chip).opacity === '1',
    aboveCard: ch.bottom <= c.top + 2,
    leftAligned: Math.abs(ch.left - c.left) < 4,
  }
})
check('streaming badge renders at rest (no hover needed)', chip.present && chip.visible)
check('streaming badge sits above the card, left-aligned', chip.aboveCard && chip.leftAligned)

console.log('── 贴近滚动容器上沿：chrome 翻进内侧（遮挡报告的回归） ──')
// Scroll the card to ~10px below the scroller's clip edge — the shape the
// user hit: the outside toolbar would cross the scroller's top and get cut,
// reading as 「被前一个消息块遮挡」. The flip must place it INSIDE.
await page.evaluate(() => { document.getElementById('clip-scroller').scrollTop = 110 })
await page.waitForTimeout(100)
const clipBox = await page.locator(`${caseSel('clipped')} iframe`).boundingBox()
await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
await page.waitForTimeout(350)
const flipped = await page.evaluate(() => {
  const root = document.querySelector('[data-case=clipped] .pm-html-card')
  const toolbar = root.querySelector('.pm-html-card-toolbar')
  const t = toolbar.getBoundingClientRect()
  const c = root.getBoundingClientRect()
  const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
  return {
    rootClass: root.className,
    inside: t.top >= c.top,
    receivesPointer: !!hit && !!hit.closest('.pm-html-card-toolbar'),
  }
})
check('near the clip edge the chrome flips inside the card', flipped.inside && flipped.rootClass.includes('pm-html-card-flip'), `class=${flipped.rootClass}`)
check('flipped toolbar is hit-testable (not clipped by the scroller)', flipped.receivesPointer)
// And a card with room keeps the outside placement — the flip must not leak.
await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
await page.waitForTimeout(350)
const outside = await page.evaluate(() => {
  const root = document.querySelector('[data-case=cap] .pm-html-card')
  const t = root.querySelector('.pm-html-card-toolbar').getBoundingClientRect()
  const c = root.getBoundingClientRect()
  return t.bottom <= c.top + 2
})
check('a card with headroom keeps the toolbar outside', outside)

console.log('── 悬停中滚动：live 重测翻转（review_20261011 中5 的回归钉） ──')
// The occlusion decision must track scrolling UNDER A STATIONARY POINTER
// (the wheel over the card fires no mouseenter). The scroll event's target
// is the scroller — an ANCESTOR of the card; the old gate tested the reverse
// direction and admitted ≈ nothing, so this whole sequence measured once at
// hover and went stale. The probe drives: hover with headroom → scroll near
// the edge (flip in) → scroll back (flip out), pointer never moves.
await page.evaluate(() => { document.getElementById('clip-scroller').scrollTop = 0 })
await page.waitForTimeout(100)
// clipBox was captured at scrollTop=110 — re-read at the reset position, or
// the hover lands 110px above the card and the section proves nothing.
const restBox = await page.locator(`${caseSel('clipped')} iframe`).boundingBox()
await page.mouse.move(restBox.x + restBox.width / 2, restBox.y + restBox.height / 2)
await page.waitForTimeout(350)
const liveBefore = await page.evaluate(() => {
  const root = document.querySelector('[data-case=clipped] .pm-html-card')
  const t = root.querySelector('.pm-html-card-toolbar').getBoundingClientRect()
  const c = root.getBoundingClientRect()
  return { flipped: root.className.includes('pm-html-card-flip'), outside: t.bottom <= c.top + 2 }
})
check('hover with headroom starts outside (no flip)', !liveBefore.flipped && liveBefore.outside, `class-flip=${liveBefore.flipped}`)
await page.evaluate(() => { document.getElementById('clip-scroller').scrollTop = 90 })
await page.waitForTimeout(350)
const liveAfter = await page.evaluate(() => {
  const root = document.querySelector('[data-case=clipped] .pm-html-card')
  const t = root.querySelector('.pm-html-card-toolbar').getBoundingClientRect()
  const c = root.getBoundingClientRect()
  const stillHovered = document.elementFromPoint(c.left + c.width / 2, Math.min(c.top + c.height / 2, window.innerHeight - 1))
  return {
    flipped: root.className.includes('pm-html-card-flip'),
    inside: t.top >= c.top,
    pointerStillOnCard: !!stillHovered && !!stillHovered.closest('[data-case=clipped] .pm-html-card'),
  }
})
check('scrolling under the stationary pointer flips the chrome inside', liveAfter.flipped && liveAfter.inside, `flip=${liveAfter.flipped} inside=${liveAfter.inside}`)
check('the pointer stayed on the card through the scroll (mouseleave would fake a pass)', liveAfter.pointerStillOnCard)
await page.evaluate(() => { document.getElementById('clip-scroller').scrollTop = 0 })
await page.waitForTimeout(350)
const liveBack = await page.evaluate(() => {
  const root = document.querySelector('[data-case=clipped] .pm-html-card')
  const t = root.querySelector('.pm-html-card-toolbar').getBoundingClientRect()
  const c = root.getBoundingClientRect()
  return { flipped: root.className.includes('pm-html-card-flip'), outside: t.bottom <= c.top + 2 }
})
check('scrolling back restores the outside placement (the gate admits both directions)', !liveBack.flipped && liveBack.outside)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
