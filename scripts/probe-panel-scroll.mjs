/**
 * Panel follow-the-tail probe (real Chromium, no extension loaded).
 *
 * "输入内容时消息要能自动滚动" — whether the panel keeps the newest content in
 * view cannot be settled by reading the source: it depends on when a scroll
 * container grows versus when its scrollTop is written, which is a layout fact.
 * jsdom has no layout engine (and no shadow-DOM cascade), so the vitest suite
 * cannot even mount the panel. Hence a real browser: the production `App` runs
 * untouched, notifications are pushed through the **real** content-script
 * bridge (`listen()` → the same `chrome.runtime.onMessage` path the worker
 * uses), and the transcript's scrollTop/scrollHeight are measured directly.
 *
 * The page is deliberately taller than the viewport, so the panel's own writes
 * are held to its transcript: this overlay shares a page the user is reading, and
 * anything that scrolled the document instead would show up here. No desktop app,
 * no LLM calls — `chrome.runtime` is stubbed, so this cannot spend the user's
 * quota or disturb a running PulseMind.
 *
 * Run: node scripts/probe-panel-scroll.mjs [--headed]   (exit code = failed checks)
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-scroll-probe-')), 'harness.js')

const SESSION_ID = 'ws_1'
const NOW = '2026-09-15T10:00:00.000Z'

/** The harness mirrors content/index.tsx: same host flags, same two stylesheets
 *  in the same order, and the real `listen()` wiring — a copy here would prove
 *  nothing about the panel that ships. */
const HARNESS = `
import { createRoot } from 'react-dom/client'
import panelStyles from './src/extension/ui/styles.css'
import xMarkdownTheme from '@ant-design/x-markdown/themes/light.css'
import { App } from './src/extension/ui/App'
import { listen } from './src/extension/content/bridge'

document.body.style.margin = '0'
// A tall page: the panel is fixed, so it must never move the document itself.
const spacer = document.createElement('div')
spacer.style.cssText = 'height:3000px;background:linear-gradient(#fff,#eee);'
document.body.appendChild(spacer)

const host = document.createElement('div')
host.setAttribute('data-pulsemind-panel', '')
host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;'
const shadow = host.attachShadow({ mode: 'open' })
const themeEl = document.createElement('style')
themeEl.textContent = xMarkdownTheme
shadow.appendChild(themeEl)
const styleEl = document.createElement('style')
styleEl.textContent = panelStyles
shadow.appendChild(styleEl)
const rootEl = document.createElement('div')
rootEl.className = 'pm-root'
shadow.appendChild(rootEl)
document.body.appendChild(host)

listen()
createRoot(rootEl).render(<App />)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'scroll-harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.extension.json',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  logLevel: 'warning',
})

/** Enough prose that one update lands far past the panel's inner height, which
 *  is the magnitude a real answer arrives in (a `messages_append` after the
 *  turn, or a chunk of streamed markdown). */
const tallMarkdown = (sections) =>
  Array.from(
    { length: sections },
    (_, i) =>
      `### 要点 ${i + 1}\n\n第 ${i + 1} 段说明，用来把这条消息撑得比面板更高。\n\n- 子项 A\n- 子项 B`,
  ).join('\n\n')

const text = (t) => ({ type: 'text', text: t })
const userMessage = (content) => ({
  id: 'm1',
  role: 'user',
  contentBlocks: [text(content)],
  createdAt: NOW,
})
const assistantMessage = (id, md) => ({ id, role: 'assistant', contentBlocks: [text(md)], createdAt: NOW })

/** The snapshot `panel/attach` answers with: a connected panel on a one-line
 *  history, so the transcript starts short and every growth below is caused by
 *  the events this probe pushes. */
const SNAPSHOT = {
  sessionId: SESSION_ID,
  connection: { state: 'open', connected: true },
  panelOpen: true,
  messages: [userMessage('总结这个页面')],
  streamingBlocks: [],
  status: 'idle',
  sessions: [{ sessionId: SESSION_ID, title: '总结' }],
  approvalMode: 'auto',
}

/** Installed as a plain <script> before the bundle: the panel talks to its
 *  worker through chrome.runtime, which a normal page does not have. */
const stub = (snapshot) => `
window.__sent = [];
window.__snapshot = ${JSON.stringify(snapshot)};
window.__listeners = [];
if (typeof chrome === 'undefined' || !chrome) { window.chrome = {}; }
chrome.runtime = {
  sendMessage: async (msg) => {
    window.__sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === 'panel/attach') return { ok: true, snapshot: window.__snapshot };
    if (msg.type === 'panel/ask') {
      // Mirrors the panel-bridge handler: the send answers with a fresh snapshot
      // that already carries the user's message.
      const snap = JSON.parse(JSON.stringify(window.__snapshot));
      snap.messages = [...snap.messages, {
        id: 'u' + snap.messages.length,
        role: 'user',
        contentBlocks: [{ type: 'text', text: msg.content }],
        createdAt: '2026-09-15T10:00:00.000Z',
      }];
      snap.status = 'streaming';
      window.__snapshot = snap;
      return { ok: true, snapshot: snap };
    }
    return { ok: true };
  },
  // The real bridge registers here (content/bridge.ts listen()); __push feeds it
  // exactly what the service worker would send.
  onMessage: { addListener: (fn) => window.__listeners.push(fn) },
  openOptionsPage: () => {},
};
window.__push = (msg) => { for (const fn of window.__listeners) fn(msg, {}, () => {}); };
`

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 500, height: 800 } })
page.on('pageerror', (e) => check('no page error', false, e.message))
await page.setContent('<!doctype html><html><body></body></html>')
await page.addScriptTag({ content: stub(SNAPSHOT) })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)
// Attach lands asynchronously (the hook's mount effect), and the panel only
// exists once the snapshot says it is open.
await page.waitForFunction(() => !!document.querySelector('[data-pulsemind-panel]')?.shadowRoot?.querySelector('.pm-transcript'))
await page.waitForTimeout(300)

/** Push one worker notification through the real listener set. */
async function push(payload) {
  await page.evaluate((p) => window.__push(p), payload)
  await page.waitForTimeout(120)
}
const event = (data) => ({ type: 'panel/event', sessionId: SESSION_ID, data })

/** Where the transcript is scrolled to, plus where the page is scrolled to. */
const metrics = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
    const el = root.querySelector('.pm-transcript')
    // The last bubble of either kind: querySelectorAll returns document order.
    const bubbles = root.querySelectorAll('.pm-bubble, .pm-bubble-assistant')
    const last = bubbles[bubbles.length - 1] ?? null
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      pageScroll: window.scrollY,
      rect: el.getBoundingClientRect().toJSON(),
      lastBubble: last ? last.getBoundingClientRect().toJSON() : null,
    }
  })

/** Wheel over the middle of the transcript — a real user gesture, so the
 *  browser does the scrolling (and fires the scroll events the panel sees). */
async function wheel(dy) {
  const m = await metrics()
  await page.mouse.move(m.rect.x + m.rect.width / 2, m.rect.y + m.rect.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(250)
}

// ── 1. content arriving ────────────────────────────────────────────────
// The reported symptom: content comes in and stays out of view. Each step is a
// *single* update that adds more than the panel's inner height, which is the
// shape of a real turn (the whole answer appended at once, or a streamed chunk).
console.log('== 内容到来时跟随末尾 ==')
{
  await push(event({ type: 'status', status: 'streaming' }))
  await push(event({ type: 'messages_append', fromIndex: 1, items: [assistantMessage('m2', tallMarkdown(6))] }))

  const afterMessage = await metrics()
  check('the transcript is the scroll container', afterMessage.scrollHeight > afterMessage.clientHeight + 100, `${afterMessage.scrollHeight} > ${afterMessage.clientHeight}`)
  check('a whole answer appended at once is followed to the tail', afterMessage.distance <= 1, `${afterMessage.distance}px below the tail`)

  await push(event({ type: 'streaming_blocks', blocks: [text(tallMarkdown(2))] }))
  const afterChunk1 = await metrics()
  check('a streamed chunk keeps the tail in view', afterChunk1.distance <= 1, `${afterChunk1.distance}px below the tail`)

  await push(event({ type: 'streaming_blocks', blocks: [text(tallMarkdown(5))] }))
  const afterChunk2 = await metrics()
  check('a chunk larger than the panel is still followed', afterChunk2.distance <= 1, `${afterChunk2.distance}px below the tail`)
  // The panel's own writes must stay inside the transcript: it shares a page
  // with the user, and the page here is 3000px tall so a stray page scroll would
  // show. Asserted here, before any wheel, because a wheel that reaches the
  // transcript's end chains to the document by itself (the user's gesture, and
  // enough to hide what this check is for).
  check('following the transcript never scrolls the page itself', afterChunk2.pageScroll === 0, `document.scrollY = ${afterChunk2.pageScroll}`)
}

// ── 2. the panel closing and reopening ────────────────────────────────
// 收起 → 打开 is the same question from a fresh mount (the FAB render unmounts
// the transcript), and it is how a user meets a long conversation again.
console.log('== 收起再打开 ==')
{
  const root = page.locator('[data-pulsemind-panel]')
  await root.locator('.pm-icon-btn[title="收起"]').click()
  await page.waitForTimeout(200)
  check('the header collapses the panel to its launcher', await root.locator('.pm-fab').count() === 1)
  await root.locator('.pm-fab').click()
  await page.waitForTimeout(400)

  const reopened = await metrics()
  check('reopening lands on the newest message, not the oldest', reopened.distance <= 1, `${reopened.distance}px below the tail`)
}

// ── 3. the user reading history ───────────────────────────────────────
// Whatever the panel does to keep up, it must not fight a person who scrolled
// back through an earlier part of the conversation.
console.log('== 用户上滚时不被拽回 ==')
{
  await wheel(-400)
  const afterWheel = await metrics()
  check('a real wheel scrolls the transcript up', afterWheel.distance > 200, `${afterWheel.distance}px from the tail`)

  await push(event({ type: 'messages_append', fromIndex: 2, items: [assistantMessage('m3', tallMarkdown(3))] }))
  const afterAppend = await metrics()
  // The invariant is about the tail, not about scrollTop: the browser's own
  // scroll anchoring moves scrollTop by the inserted height to keep the text the
  // user is reading in place, which is correct and not ours to fight. What must
  // never happen is the panel writing scrollTop itself while the user is up here.
  check('content arriving while reading history does not follow the tail', afterAppend.distance > 200, `${afterAppend.distance}px from the tail`)
  check('and the gap to the tail never shrinks under the reader', afterAppend.distance >= afterWheel.distance - 1, `${afterWheel.distance} → ${afterAppend.distance}`)
  check('and the new content is genuinely off screen', afterAppend.lastBubble && afterAppend.lastBubble.bottom > afterAppend.rect.bottom + 100, `bubble ends ${Math.round((afterAppend.lastBubble?.bottom ?? 0) - afterAppend.rect.bottom)}px below the fold`)
}

// ── 4. coming back ────────────────────────────────────────────────────
console.log('== 回到底部后恢复跟随 ==')
{
  await wheel(4000)
  const back = await metrics()
  check('scrolling back to the bottom is detected', back.distance <= 1, `${back.distance}px from the tail`)

  await push(event({ type: 'messages_append', fromIndex: 3, items: [assistantMessage('m4', tallMarkdown(4))] }))
  const followed = await metrics()
  check('following resumes for the next message', followed.distance <= 1, `${followed.distance}px below the tail`)
}

// ── 5. the message the user just sent ─────────────────────────────────
// 输入内容时消息要能自动滚动: the send itself is the first message of a turn, so
// it has to be in view without the user touching the scrollbar. The snapshot the
// worker answers with carries the whole (tall) history, exactly as a resumed
// session does, so the tail really is below the fold when the bubble lands.
console.log('== 发送的消息进入视野 ==')
{
  // The turn has to be over before the next send: the composer refuses to send
  // while 停止 is showing (Composer.submit), so the panel must be idle here.
  await push(event({ type: 'status', status: 'completed' }))
  await page.evaluate(
    (md) =>
      window.__snapshot.messages.push({
        id: 'm5',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: md }],
        createdAt: '2026-09-15T10:00:00.000Z',
      }),
    tallMarkdown(4),
  )

  const root = page.locator('[data-pulsemind-panel]')
  await root.locator('.pm-input').fill('把刚才的要点整理成表格')
  await root.locator('.pm-input').press('Enter')
  await page.waitForTimeout(400)

  const sent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'panel/ask'))
  check('Enter in the composer sends the question', sent.length === 1 && sent[0].content === '把刚才的要点整理成表格', JSON.stringify(sent[0] ?? null))

  const after = await metrics()
  check('the answered history is taller than the panel', after.scrollHeight > after.clientHeight + 100, `${after.scrollHeight} > ${after.clientHeight}`)
  check('the sent message is scrolled into view', after.distance <= 1, `${after.distance}px below the tail`)
  check('the sent bubble is inside the transcript, not past its edge', !!after.lastBubble && after.lastBubble.bottom <= after.rect.bottom + 1 && after.lastBubble.top >= after.rect.top - 1, after.lastBubble ? `bubble ${Math.round(after.lastBubble.top)}–${Math.round(after.lastBubble.bottom)} in ${Math.round(after.rect.top)}–${Math.round(after.rect.bottom)}` : 'no bubble')
}

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.label).join('; '))
  process.exit(1)
}
