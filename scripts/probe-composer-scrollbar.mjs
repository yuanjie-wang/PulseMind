/**
 * Composer-band scrollbar probe (real Chromium).
 *
 * The report: 对话区的垂直滚动条，在与消息发送区同高的位置是无法拖动的。The
 * chat transcript is a `height: 100%` scroller and the composer floats over
 * its lower band — `position: absolute; bottom: 0; left: 0; right: 0` — so the
 * composer ROOT (a transparent box carrying only 12/24px padding around the
 * card) covered the scrollbar track for its whole height and every grab there
 * hit the composer (zIndex 10) instead of the track. The card itself never
 * covers the track: the root's horizontal padding keeps the card ≥24px from
 * the pane edge, wider than any scrollbar.
 *
 * Mounts the production InputArea in a chat-shaped case — a full-height
 * scroller sibling plus the floating composer, the exact ChatView geometry —
 * and asserts, with a real mouse:
 *
 *   1. the floating root is click-through and the inner column (card + the
 *      above-card slot) opts back in (computed pointer-events)
 *   2. the composer root's box really covers the track point in its band
 *      (non-vacuity: the fix is not anchored to an overlap that doesn't exist)
 *   3. `elementFromPoint` at the track inside the band resolves INTO the
 *      scroller, not the composer
 *   4. a real scrollbar drag with the thumb scrolled INTO the band moves the
 *      transcript (the user's actual gesture)
 *   5. the wheel over the band scrolls the transcript (free consequence: the
 *      root used to swallow it — the scroller is a sibling, not an ancestor)
 *   6. the card stays fully interactive: real click, typing, the send button
 *   7. the above-card slot stays interactive (a topSlot button, real click)
 *   8. a file drag onto the card still opens the drop highlight
 *
 * Two passes, because of what a headless Chromium can express: the headless
 * shell renders no scrollbar at all (0px gutter, overlay style — nothing to
 * grab), so checks 1–3 and 5–8 run headless on the DOM hit-test and wheel,
 * and check 4 — the actual drag — re-mounts the same bundle in a HEADED
 * browser where the probe's `::-webkit-scrollbar { width: 14px }` fixture CSS
 * forces a classic, layout-occupying scrollbar that real mouse events engage.
 * (`--headed` runs everything in that one headed pass instead.) The fixture
 * CSS pins the scrollbar's MODE only; the fact under test is mode-independent
 * — the composer blocked the EVENT, and the fix restores the scroller as its
 * target, which is the chain every scrollbar mode engages through.
 *
 * No Electron, no LLM: `window.electronAPI` is stubbed, so this cannot touch a
 * real session.
 *
 * Usage: node scripts/probe-composer-scrollbar.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-composer-sb-')), 'harness.js')

const ROWS = 60

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { InputArea } from './src/renderer/src/components/chat/InputArea'

installThemeVars()
applyThemeAttr('light')

// Every bridge call resolves undefined, which nothing mounted here needs
// beyond the platform probe inside Composer (it catches and keeps the frost) —
// except the expert roster: InputArea loads it on mount and seeds state with
// the raw result, so undefined would crash the first .filter. No experts are
// needed here; an empty roster is the honest mount.
window.electronAPI = new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'expertList' ? [] : undefined) })

// The chat pane's geometry: a height:100% scroller (its scrollbar runs the
// pane's full height at the right edge) and the floating composer absolutely
// pinned over its lower band — ChatView's exact structure. The scrollbar width
// rule is probe fixture: headless Chromium ships overlay scrollbars (zero
// gutter, nothing to grab), and a styled width switches Chromium to a classic,
// layout-occupying scrollbar the drag pass can really pull. See the header.
function ChatCase() {
  return (
    <div
      data-case="chat"
      style={{ position: 'relative', width: 1000, height: 600, background: '#fff', overflow: 'hidden', fontFamily: 'system-ui' }}
    >
      <style>{\`[data-probe-scroller]::-webkit-scrollbar { width: 14px; }\`}</style>
      <div data-probe-scroller style={{ height: '100%', overflow: 'auto', overflowAnchor: 'none' }}>
        {Array.from({ length: ${ROWS} }, (_, i) => (
          <div key={i} style={{ padding: '16px 24px', borderBottom: '1px solid #eee' }}>消息 {i + 1}</div>
        ))}
        <div style={{ height: 160 }} />
      </div>
      <InputArea
        layout="floating"
        isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
        hasMessages={true}
        topSlot={<button data-topslot-btn onClick={() => { window.__topslot = true }}>计划执行中…</button>}
        onSendMessage={(v) => { window.__sent = v }}
        onCancel={() => {}}
        onChangeApprovalMode={() => {}}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <TranslationProvider>
    <ChatCase />
  </TranslationProvider>
)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.web.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'

async function mountIn(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
  await page.goto('http://pm-probe.local/')
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction('window.__ready === true')
  return page
}

/** Geometry of the chat case. The composer ROOT is the absolute box between
 *  the zero-height InputArea wrapper and the inner column — found structurally
 *  (wrapper = card's ancestor whose parent is the case root; root = its first
 *  child), no probe-only hook is planted in the component. */
const geo = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-case=chat]')
    const sc = root.querySelector('[data-probe-scroller]')
    const card = root.querySelector('.ant-sender')
    let wrapper = card
    while (wrapper && wrapper.parentElement !== root) wrapper = wrapper.parentElement
    const composerRoot = wrapper ? wrapper.firstElementChild : null
    const column = composerRoot ? composerRoot.firstElementChild : null
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }
    }
    return {
      scroller: r(sc),
      card: r(card),
      composerRoot: r(composerRoot),
      gutter: sc.offsetWidth - sc.clientWidth,
      rootPe: composerRoot ? getComputedStyle(composerRoot).pointerEvents : null,
      columnPe: column ? getComputedStyle(column).pointerEvents : null,
      cardPe: card ? getComputedStyle(card).pointerEvents : null,
      scrollTop: sc.scrollTop,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
    }
  })

// The track point inside the composer band: the classic scrollbar occupies the
// rightmost 14px; the point sits in the root's transparent bottom padding,
// below the card — squarely 与消息发送区同高.
const BAND = { dx: 7, dy: 12 }
const bandPoint = (page) =>
  page.evaluate(({ dx, dy }) => {
    const root = document.querySelector('[data-case=chat]')
    const sc = root.querySelector('[data-probe-scroller]')
    const card = root.querySelector('.ant-sender')
    let wrapper = card
    while (wrapper && wrapper.parentElement !== root) wrapper = wrapper.parentElement
    const composerRoot = wrapper.firstElementChild
    const s = sc.getBoundingClientRect()
    const c = composerRoot.getBoundingClientRect()
    return { x: s.right - dx, y: c.bottom - dy, scroller: s, composer: c }
  }, BAND)

/** The drag pass: scroll the thumb INTO the composer band and pull it with the
 *  mouse — the user's actual gesture. Runs headed (see header). The settle
 *  wait is not decoration: on a freshly-created headed window the input
 *  pipeline occasionally dropped part of the drag (measured Δ 110 vs the
 *  ~870 full mapping), so the pass warms the pointer up before committing. */
async function dragSection(page) {
  await page.waitForTimeout(250)
  const g = await geo(page)
  check('drag pass: the fixture scrollbar is a classic 14px gutter', g.gutter === 14, `gutter=${g.gutter}`)
  await page.evaluate(() => {
    document.querySelector('[data-probe-scroller]').scrollTop = 999999
  })
  await page.waitForTimeout(80)
  const thumb = await page.evaluate(() => {
    const sc = document.querySelector('[data-probe-scroller]')
    const card = document.querySelector('[data-case=chat] .ant-sender')
    let wrapper = card
    while (wrapper && wrapper.parentElement !== document.querySelector('[data-case=chat]')) wrapper = wrapper.parentElement
    const band = wrapper.firstElementChild.getBoundingClientRect()
    const r = sc.getBoundingClientRect()
    const track = sc.clientHeight
    const h = Math.max(20, Math.round((track * track) / sc.scrollHeight))
    const top = (sc.scrollTop / (sc.scrollHeight - sc.clientHeight)) * (track - h)
    return { x: r.right - 7, y: r.top + top + h / 2, bandTop: band.top, scrollTop: sc.scrollTop }
  })
  check(
    'non-vacuity: the thumb center is inside the composer band',
    thumb.y >= thumb.bandTop,
    `thumb y ${thumb.y.toFixed(0)} vs band top ${thumb.bandTop.toFixed(0)}`,
  )
  await page.mouse.move(thumb.x, thumb.y)
  await page.mouse.down()
  await page.mouse.move(thumb.x, thumb.y - 150, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(50)
  const afterDrag = await page.evaluate(() => document.querySelector('[data-probe-scroller]').scrollTop)
  check('dragging the thumb in the band moves the transcript', afterDrag <= thumb.scrollTop - 100, `scrollTop ${thumb.scrollTop} → ${afterDrag}`)
  const typedDuringDrag = await page.evaluate(() => document.querySelector('[data-case=chat] textarea').value)
  check('the drag typed nothing into the composer', typedDuringDrag === '', JSON.stringify(typedDuringDrag))
}

const headed = process.argv.includes('--headed')
const browser = await chromium.launch({ headless: !headed })

const page = await mountIn(browser)

console.log('── 结构与 pointer-events ──')
const g0 = await geo(page)
check(
  'case mounts: scroller scrolls, card floats over its lower band',
  g0.scrollHeight > g0.clientHeight * 3 && g0.composerRoot && g0.card,
  `scrollHeight=${g0.scrollHeight} clientHeight=${g0.clientHeight}`,
)
check('floating root is click-through (pointer-events none)', g0.rootPe === 'none', String(g0.rootPe))
check('inner column opts back in (pointer-events auto)', g0.columnPe === 'auto', String(g0.columnPe))
check('card itself stays interactive (pointer-events auto)', g0.cardPe === 'auto', String(g0.cardPe))

const bp = await bandPoint(page)
check(
  'non-vacuity: the composer root really covers the track point',
  bp.x >= bp.composer.left && bp.x <= bp.composer.right && bp.y >= bp.composer.top && bp.y <= bp.composer.bottom,
  `point (${bp.x.toFixed(0)}, ${bp.y.toFixed(0)}) vs root [${bp.composer.top.toFixed(0)}..${bp.composer.bottom.toFixed(0)}]`,
)
check(
  'non-vacuity: the point is inside the scroller box too',
  bp.y >= bp.scroller.top && bp.y <= bp.scroller.bottom,
  `scroller [${bp.scroller.top.toFixed(0)}..${bp.scroller.bottom.toFixed(0)}]`,
)

console.log('── 命中测试：带内轨道点落进滚动容器 ──')
const hitInBand = await page.evaluate(({ x, y }) => {
  const root = document.querySelector('[data-case=chat]')
  const sc = root.querySelector('[data-probe-scroller]')
  let wrapper = root.querySelector('.ant-sender')
  while (wrapper && wrapper.parentElement !== root) wrapper = wrapper.parentElement
  const composerRoot = wrapper.firstElementChild
  const el = document.elementFromPoint(x, y)
  return {
    inScroller: !!el && (el === sc || sc.contains(el)),
    inComposer: !!el && composerRoot.contains(el),
    tag: el ? el.tagName + '.' + (el.className || '') : 'null',
  }
}, bp)
check('elementFromPoint in the band resolves into the scroller', hitInBand.inScroller && !hitInBand.inComposer, hitInBand.tag)
const hitOnCard = await page.evaluate(() => {
  const card = document.querySelector('[data-case=chat] .ant-sender')
  const r = card.getBoundingClientRect()
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + 8)
  return card === el || card.contains(el)
})
check('elementFromPoint on the card still resolves to the card', hitOnCard)

console.log('── 滚轮在带内也能滚动对话 ──')
await page.evaluate(() => {
  document.querySelector('[data-probe-scroller]').scrollTop = 0
})
await page.waitForTimeout(50)
await page.mouse.move(bp.x, bp.y)
await page.mouse.wheel(0, 240)
await page.waitForTimeout(50)
const afterWheel = await page.evaluate(() => document.querySelector('[data-probe-scroller]').scrollTop)
check('wheel over the band scrolls the transcript', afterWheel > 0, `scrollTop=${afterWheel}`)

console.log('── 卡片与 above-card 层仍可交互 ──')
const area = page.locator('[data-case=chat] textarea')
await area.click()
await page.keyboard.type('你好')
const val = await area.inputValue()
check('clicking the card focuses it and typing lands', val === '你好', `value="${val}"`)
await page.evaluate(() => {
  window.__sent = undefined
})
await page.locator('[data-case=chat] .pm-send, [data-case=chat] .ant-sender button.ant-btn').last().click()
const sent = await page.evaluate(() => window.__sent)
check('the send button sends', sent === '你好', `sent=${JSON.stringify(sent)}`)
await page.evaluate(() => {
  window.__topslot = undefined
})
await page.locator('[data-case=chat] [data-topslot-btn]').click()
check('a topSlot button (above-card layer) still clicks', (await page.evaluate(() => window.__topslot)) === true)

console.log('── 文件拖到卡片上仍亮起投放高亮 ──')
// handleDragEnter guards on dragHasFiles — a bare DataTransfer never opens the
// highlight, so the synthetic drag carries a real File (types gains 'Files').
const dt = await page.evaluateHandle(() => {
  const d = new DataTransfer()
  d.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }))
  return d
})
await page.locator('[data-case=chat] .ant-sender').dispatchEvent('dragenter', { dataTransfer: dt })
await page.waitForTimeout(50)
const dropOn = await page.evaluate(() => {
  const card = document.querySelector('[data-case=chat] .ant-sender')
  let wrapper = card
  while (wrapper && wrapper.parentElement !== document.querySelector('[data-case=chat]')) wrapper = wrapper.parentElement
  return wrapper.firstElementChild.className
})
check('dragenter on the card opens the drop highlight', String(dropOn).includes('pm-drop-active'), String(dropOn))
await page.locator('[data-case=chat] .ant-sender').dispatchEvent('dragleave', { dataTransfer: dt })
await page.waitForTimeout(50)
const dropOff = await page.evaluate(() => {
  const card = document.querySelector('[data-case=chat] .ant-sender')
  let wrapper = card
  while (wrapper && wrapper.parentElement !== document.querySelector('[data-case=chat]')) wrapper = wrapper.parentElement
  return wrapper.firstElementChild.className
})
check('dragleave clears it', !String(dropOff).includes('pm-drop-active'), String(dropOff))

await browser.close()

if (headed) {
  await dragSection(page)
} else {
  console.log('── 真实拖动（有头实例：headless 无实体滚动条可拖） ──')
  const dragBrowser = await chromium.launch({ headless: false })
  const dragPage = await mountIn(dragBrowser)
  await dragSection(dragPage)
  await dragBrowser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
