/**
 * @-mention popup position probe (real Chromium).
 *
 * The report: 输入 @ 后提示框的垂直位置经常不正确，会遮挡输入框。The popup
 * (InputArea's expert selector) anchors with `bottom: calc(100% + 8px)` against
 * InputArea's own `position: relative` wrapper. That is only correct when the
 * wrapper *has* height — the inline layouts (welcome page, routine workspace,
 * tool studio, form assist). The main chat renders the composer `floating`,
 * whose root is `position: absolute; bottom: 0` — out of flow — so the wrapper
 * collapses to zero height and `calc(100% + 8px)` degenerates to `8px`: the
 * popup's bottom edge lands 8px above the composer's *bottom* and the list
 * paints over the input card (zIndex 100 over 10).
 *
 * This mounts the production InputArea in a chat-shaped container in BOTH
 * layouts and, with a real keyboard, types `@` so the popup opens, then
 * measures what a user gets:
 *
 *   1. floating (main chat): the popup sits entirely ABOVE the visible
 *      `.ant-sender` card — no pixel of it may cover the card
 *   2. inline (welcome/reuse sites): the same rule
 *   3. the popup is horizontally aligned with the card (same centering), so the
 *      fix may not regress the width mirroring (COMPOSER_MAX_WIDTH)
 *   4. selecting an entry still rewrites the token (the popup stays functional
 *      after the reposition)
 *   5. keyboard navigation (ArrowUp/Down, real keys) keeps the highlighted row
 *      inside the popup's visible box by scrolling the popup alone
 *   6. Enter picks the highlighted expert instead of sending (and the next
 *      Enter sends the picked text); Escape dismisses so a hand-typed @name
 *      can still be sent; a pick closes the popup
 *
 * No Electron, no LLM, no extension: `window.electronAPI` is stubbed and the
 * expert list is fixture data, so this cannot touch a real session.
 *
 * Usage: node scripts/probe-mention-position.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-mention-pos-')), 'harness.js')

const EXPERTS = [
  { id: 'expert-writing', name: '写作专家', description: '文案与润色', enabled: true },
  { id: 'expert-code', name: '代码专家', description: '实现与重构', enabled: true },
  { id: 'expert-data', name: '数据分析专家', description: '表格与图表', enabled: true },
  { id: 'expert-pm', name: '产品专家', description: '需求与排期', enabled: true },
  { id: 'expert-trans', name: '翻译专家', description: '多语言互译', enabled: true },
  { id: 'expert-test', name: '测试专家', description: '用例与回归', enabled: true },
  { id: 'expert-ops', name: '运维专家', description: '部署与监控', enabled: true },
  { id: 'expert-design', name: '设计专家', description: '界面与体验', enabled: true },
  { id: 'expert-off', name: '离职专家', description: '已停用，不应出现', enabled: false },
]

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { InputArea } from './src/renderer/src/components/chat/InputArea'

// knowledgeListBases must answer an array: the @-popup's knowledge-base
// section setKnowledgeBases(es) the answer verbatim, and the fallback
// undefined would blank the list and throw on .slice.
window.electronAPI = new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'expertList' ? ${JSON.stringify(EXPERTS)} : key === 'knowledgeListBases' ? [] : undefined) })

function Case({ id, layout, topSlot }) {
  return (
    <div
      data-case={id}
      style={{ position: 'relative', height: 480, background: '#fff', overflow: 'hidden', fontFamily: 'system-ui' }}
    >
      {/* The chat pane's scroll area is a height:100% in-flow sibling that pins
          InputArea's zero-height wrapper to the pane bottom — the geometry the
          popup's calc(100% + 8px) anchor actually resolves against. Inline sites
          have no such sibling (the composer itself is in flow), so floating only. */}
      {layout === 'floating' && <div style={{ height: '100%' }} />}
      <InputArea
        layout={layout}
        isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
        hasMessages={true}
        topSlot={topSlot}
        onSendMessage={(v) => { window.__sent = v }}
        onCancel={() => {}}
        onChangeApprovalMode={() => {}}
      />
    </div>
  )
}

const STRIP = <div data-top-slot style={{ background: '#f6f6f6', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, padding: '4px 12px', fontSize: 12 }}>计划执行中…</div>

createRoot(document.getElementById('root')).render(
  <TranslationProvider>
    <div style={{ width: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Case id="floating" layout="floating" />
      <Case id="inline" layout="inline" />
      <Case id="floating-strip" layout="floating" topSlot={STRIP} />
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
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

/** Real keyboard into the given case's textarea, then measure the popup against
 *  the visible sender card. The popup has no class of its own; find it
 *  structurally: a child of InputArea's relative wrapper whose text names the
 *  summon title and an expert name, and which is not the card itself. */
async function measure(caseId) {
  const area = page.locator(`[data-case=${caseId}] textarea`)
  await area.click()
  await area.pressSequentially('@')
  await page.waitForFunction(
    (cid) => {
      const root = document.querySelector(`[data-case=${cid}]`)
      return !!root && root.textContent.includes('召唤专家')
    },
    caseId
  )
  return page.evaluate((cid) => {
    const root = document.querySelector(`[data-case=${cid}]`)
    const card = root.querySelector('.ant-sender')
    const popup = root.querySelector('[data-mention-popup]')
    // InputArea's relative wrapper is the direct child of the case root that
    // contains the card (the floating case also has a height:100% spacer sibling).
    let wrapper = card
    while (wrapper && wrapper.parentElement !== root) wrapper = wrapper.parentElement
    if (!wrapper) return { error: 'wrapper not found' }
    if (!popup) return { error: 'popup not found' }
    const p = popup.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const w = wrapper.getBoundingClientRect()
    return {
      popup: { top: p.top, bottom: p.bottom, left: p.left, right: p.right, height: p.height },
      card: { top: c.top, bottom: c.bottom, left: c.left, right: c.right },
      wrapper: { top: w.top, bottom: w.bottom, height: w.height },
      overlapY: Math.min(p.bottom, c.bottom) - Math.max(p.top, c.top),
    }
  }, caseId)
}

console.log('── floating (主聊天布局) ──')
const fl = await measure('floating')
if (fl.error) {
  check('popup opens in floating layout', false, fl.error)
} else {
  console.log(`  [measured] popup bottom=${fl.popup.bottom.toFixed(1)} card top=${fl.card.top.toFixed(1)} card bottom=${fl.card.bottom.toFixed(1)} overlap=${fl.overlapY.toFixed(1)}px (wrapper h=${fl.wrapper.height})`)
  check('floating: popup opens above the card, zero overlap', fl.overlapY <= 0.5, `overlap ${fl.overlapY.toFixed(1)}px`)
  check('floating: popup clears the card top by ≥8px', fl.card.top - fl.popup.bottom >= 7.5, `gap ${(fl.card.top - fl.popup.bottom).toFixed(1)}px`)
  const centerDelta = Math.abs((fl.popup.left + fl.popup.right) / 2 - (fl.card.left + fl.card.right) / 2)
  check('floating: popup centered on the card', centerDelta <= 2, `center delta ${centerDelta.toFixed(1)}px`)
}

console.log('── inline (welcome / 复用布局) ──')
const inl = await measure('inline')
if (inl.error) {
  check('popup opens in inline layout', false, inl.error)
} else {
  console.log(`  [measured] popup bottom=${inl.popup.bottom.toFixed(1)} card top=${inl.card.top.toFixed(1)} overlap=${inl.overlapY.toFixed(1)}px`)
  check('inline: popup opens above the card, zero overlap', inl.overlapY <= 0.5, `overlap ${inl.overlapY.toFixed(1)}px`)
}

console.log('── floating + topSlot (计划条与弹层并存) ──')
const st = await measure('floating-strip')
if (st.error) {
  check('popup opens with a topSlot present', false, st.error)
} else {
  const geo = await page.evaluate(() => {
    const root = document.querySelector('[data-case=floating-strip]')
    const card = root.querySelector('.ant-sender')
    const strip = root.querySelector('[data-top-slot]')
    const popup = root.querySelector('[data-mention-popup]')
    const s = strip.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const p = popup.getBoundingClientRect()
    return {
      stripOverlap: Math.min(s.bottom, c.bottom) - Math.max(s.top, c.top),
      stripAbovePopup: s.bottom <= p.top + 0.5,
    }
  })
  check('floating: plan strip clears the card, zero overlap', geo.stripOverlap <= 0.5, `overlap ${geo.stripOverlap.toFixed(1)}px`)
  check('floating: strip and popup stack (strip above popup)', geo.stripAbovePopup)
}

console.log('── 键盘导航把高亮行滚回视窗 ──')
// 8 enabled experts = the popup's own match cap, and 8 rows exceed the 264px
// maxHeight, so the box really scrolls. Arrow keys move the highlight; the
// highlighted row must stay inside the popup's visible box — scrolled by the
// popup alone, never by the page behind it.
const karea = page.locator('[data-case=floating] textarea')
await karea.fill('')
await karea.pressSequentially('@')
await page.waitForFunction(() => {
  const popup = document.querySelector('[data-case=floating] [data-mention-popup]')
  return !!popup && popup.querySelectorAll('[data-mention-idx]').length >= 8
})

/** The popup's scroll state and each row's highlight/visibility. Visibility is
 *  against the popup's own visible box (rects), the highlight is the
 *  rgba(0,0,0,0.05) wash InputArea paints on the selected row. */
const readKb = () => page.evaluate(() => {
  const popup = document.querySelector('[data-case=floating] [data-mention-popup]')
  const pr = popup.getBoundingClientRect()
  const rows = [...popup.querySelectorAll('[data-mention-idx]')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      idx: Number(el.dataset.mentionIdx),
      top: r.top,
      bottom: r.bottom,
      visible: r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5,
      highlighted: getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0.05)',
    }
  })
  return {
    scrollTop: popup.scrollTop,
    clientHeight: popup.clientHeight,
    scrollHeight: popup.scrollHeight,
    rows,
    highlightedIdx: rows.findIndex((r) => r.highlighted),
  }
})
const hl = (s) => {
  const row = s.rows[s.highlightedIdx]
  return row ? `row${row.idx} [${row.top.toFixed(0)}..${row.bottom.toFixed(0)}] visible=${row.visible}` : 'none'
}

const s0 = await readKb()
check('popup lists 8 rows and the box actually scrolls', s0.rows.length === 8 && s0.scrollHeight > s0.clientHeight + 10, `rows=${s0.rows.length} scrollHeight=${s0.scrollHeight} clientHeight=${s0.clientHeight}`)
check('open: first row highlighted and visible, unscrolled', s0.highlightedIdx === 0 && s0.rows[0].visible && s0.scrollTop === 0, `highlight=${s0.highlightedIdx} scrollTop=${s0.scrollTop}`)

await karea.press('ArrowUp')
await page.waitForTimeout(50)
const s1 = await readKb()
const lastIdx = s1.rows.length - 1
check('wrap-up: highlight lands on the last row', s1.highlightedIdx === lastIdx, hl(s1))
check('wrap-up: popup scrolled down to reach it', s1.scrollTop > 0 && s1.scrollTop + s1.clientHeight >= s1.scrollHeight - 5, `scrollTop=${s1.scrollTop} max=${s1.scrollHeight - s1.clientHeight}`)
check('wrap-up: highlighted row is inside the popup box', s1.rows[lastIdx].visible, hl(s1))

await karea.press('ArrowDown')
await page.waitForTimeout(50)
const s2 = await readKb()
// keep-in-view scrolls back the minimum distance (row 0 flush at the top),
// not a full reset to scrollTop 0 — visibility is the contract
check('wrap-down: back to the first row, scrolled back into view', s2.highlightedIdx === 0 && s2.rows[0].visible && s2.scrollTop < s1.scrollTop, `highlight=${s2.highlightedIdx} scrollTop=${s2.scrollTop}`)

for (let i = 0; i < 7; i++) await karea.press('ArrowDown')
await page.waitForTimeout(50)
const s3 = await readKb()
check('walk-down: last row visible after 7 ArrowDown', s3.highlightedIdx === lastIdx && s3.rows[lastIdx].visible, hl(s3))

// Typing filters the matches and resets the selection to row 0 (handleInputChange);
// the popup must give up its scroll position so that row 0 is what the user sees.
await karea.fill('@数据')
await page.waitForTimeout(50)
const s4 = await readKb()
check('typing: selection resets to the first (visible) match', s4.rows.length === 1 && s4.highlightedIdx === 0 && s4.rows[0].visible && s4.scrollTop === 0, `rows=${s4.rows.length} scrollTop=${s4.scrollTop}`)

console.log('── 回车选中专家而不是发送 ──')
/** Sender's Enter-submit runs its own internal handler after the composer's
 *  onKeyDown and only skips it when that handler returns `false` —
 *  preventDefault alone cannot veto it. So the popup's Enter must be proven
 *  end to end: token rewritten, popup closed, and the NEXT Enter really sends. */
const popupOpen = () => page.evaluate(() => !!document.querySelector('[data-case=floating] [data-mention-popup]'))

await karea.fill('')
await page.waitForFunction(() => !document.querySelector('[data-case=floating] [data-mention-popup]'))
await karea.pressSequentially('@')
await page.waitForFunction(() => document.querySelectorAll('[data-case=floating] [data-mention-idx]').length >= 8)
await karea.press('Enter')
await page.waitForTimeout(50)
const enterVal = await karea.inputValue()
check('Enter picks the highlighted (first) expert', enterVal === '@写作专家 ', `value="${enterVal}"`)
check('Enter pick closes the popup', !(await popupOpen()))
await page.evaluate(() => { window.__sent = undefined })
await karea.press('Enter')
await page.waitForTimeout(50)
const sentVal = await page.evaluate(() => window.__sent)
// submit() trims, so the trailing space of the picked token does not survive
check('the next Enter sends the picked text', sentVal === '@写作专家', `sent="${sentVal}"`)

await karea.fill('')
await page.waitForFunction(() => !document.querySelector('[data-case=floating] [data-mention-popup]'))
await karea.pressSequentially('@')
await page.waitForFunction(() => document.querySelectorAll('[data-case=floating] [data-mention-idx]').length >= 8)
for (let i = 0; i < 3; i++) await karea.press('ArrowDown')
await karea.press('Enter')
await page.waitForTimeout(50)
check('Enter picks the row the arrows moved to', (await karea.inputValue()) === '@产品专家 ', `value="${await karea.inputValue()}"`)

await karea.fill('')
await page.waitForFunction(() => !document.querySelector('[data-case=floating] [data-mention-popup]'))
await karea.pressSequentially('@写')
await page.waitForFunction(() => !!document.querySelector('[data-case=floating] [data-mention-popup]'))
await karea.press('Escape')
await page.waitForTimeout(50)
check('Escape dismisses the popup', !(await popupOpen()))
await page.evaluate(() => { window.__sent = undefined })
await karea.press('Enter')
await page.waitForTimeout(50)
check('Enter after Escape sends the raw text', (await page.evaluate(() => window.__sent)) === '@写', `sent=${await page.evaluate(() => window.__sent)}`)

console.log('── 选择仍然生效 ──')
const area = page.locator('[data-case=floating] textarea')
await area.fill('')
await area.pressSequentially('@')
await page.waitForTimeout(50)
// click the list row through its name label; the click bubbles to the row's onClick
const row = page.locator('[data-case=floating] div', { hasText: '写作专家' }).last()
await row.click()
await page.waitForTimeout(50)
const val = await area.inputValue()
check('floating: clicking an entry rewrites the token', val.includes('@写作专家'), `value="${val}"`)
check('floating: clicking an entry closes the popup', !(await popupOpen()))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
