/**
 * Real-browser probe for the extension panel's NEW state surfaces (2026-10-31
 * PLAN-extension-panel-state-surface): the three folded states (plan checklist /
 * file-change ink / compaction chip), the retry count label, the sessions
 * menu, user-message screenshots and the HTML card's 在浏览器打开.
 *
 * Same recipe as probe-panel-render.mjs: the real `App` bundle (esbuild stdin,
 * production React, real styles.css inside a Shadow Root) on a plain page with
 * chrome.runtime/storage stubbed — this probe does NOT need the MV3 service
 * worker (it drives the App directly), so a plain headless Chromium suffices.
 * The stub answers panel/attach with a snapshot carrying all the new still-life
 * fields; later state arrives as real `panel/event` notifications pushed
 * through the onMessage listener list, exactly as the worker would.
 *
 * Usage: node scripts/probe-panel-state.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-state-probe-')), 'harness.js')

const MODEL = {
  profiles: [{ id: 'p1', name: 'GPT-4o', provider: 'openai', providerName: 'OpenAI', model: 'gpt-4o' }],
  activeId: 'p1',
}

/** The harness is inline (esbuild stdin) so this probe stays one file. It
 *  imports the production App — a copy here would prove nothing. */
const HARNESS = `
import { createRoot } from 'react-dom/client'
import panelStyles from './src/extension/ui/styles.css'
import xMarkdownTheme from '@ant-design/x-markdown/themes/light.css'
import { App } from './src/extension/ui/App'
import { listen } from './src/extension/content/bridge'

// 真事件通路:listen() 把 chrome.runtime.onMessage 接进 content/bridge 的监听器
// 集合——没有这一行,__pushEvent 推的是一个空集,panel/event 永远到不了
// usePanel(首跑实测:重试计数/消息推送/图片/HTML 卡四个检查同因全灭)。
listen()

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
createRoot(rootEl).render(<App />)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'panel-state-harness.tsx' },
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

const NOW = Date.now()
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 980 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))
await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')

await page.addScriptTag({
  content: `
window.__sent = []
window.__listeners = []
if (typeof chrome === 'undefined' || !chrome) { window.chrome = {} }
chrome.runtime = {
  sendMessage: async (msg) => {
    window.__sent.push(msg)
    if (msg.type === 'panel/attach') {
      return { ok: true, snapshot: {
        sessionId: 'ws_1',
        connection: { state: 'open', connected: true },
        panelOpen: true,
        messages: [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '把这一页的要点整理出来' }], createdAt: '${iso(60_000)}' }],
        streamingBlocks: [],
        status: 'idle',
        // ── 2026-10-31 冷附着静物:三个折叠态 + 会话列表 ──
        plan: {
          objective: '整理页面要点并输出报告',
          nodes: [
            { id: 'n1', description: '走查页面结构', status: 'completed', dependsOn: [], summary: '结构已梳理' },
            { id: 'n2', description: '汇总要点成文', status: 'pending', dependsOn: ['n1'] },
          ],
          completed: false,
          version: 2,
          mode: 'direct',
          currentNodeId: 'n2',
        },
        fileChanges: [
          { path: '/workspace/src/summary.ts', kind: 'created' },
          { path: '/workspace/README.md', kind: 'modified' },
        ],
        lastCompaction: { ts: ${NOW}, source: 'request', strategies: ['nano', 'light'], droppedMessages: 3, replayedUserMessages: 0, tokensBefore: 20000, tokensAfter: 9000 },
        sessions: [
          { sessionId: 'ws_1', title: '当前会话', updatedAt: '${iso(60_000)}' },
          { sessionId: 'ws_2', title: '昨天的翻译任务', updatedAt: '${iso(26 * 3600_000)}' },
        ],
        approvalMode: 'auto',
        model: ${JSON.stringify(MODEL)},
      } }
    }
    return { ok: true }
  },
  onMessage: { addListener: (fn) => window.__listeners.push(fn) },
  openOptionsPage: () => {},
}
window.__stored = {}
chrome.storage = {
  local: {
    get: async (key) => (key in window.__stored ? { [key]: window.__stored[key] } : {}),
    set: async (entries) => { Object.assign(window.__stored, entries) },
  },
}
/** The worker's event push: a real notification through the real dispatch
 *  chain — chrome.runtime.onMessage listener → isPanelNotification → the
 *  module-local listener set (sender/sendResponse shaped like the worker's). */
window.__pushEvent = (data) => { window.__listeners.forEach((fn) => fn({ type: 'panel/event', sessionId: 'ws_1', data }, {}, () => {})) }
`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)
await page.waitForTimeout(500)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const shot = (name) => page.screenshot({ path: join(tmpdir(), `pm-state-${name}.png`) })

// ── 状态条三态 ────────────────────────────────────────────────────────────
const strip = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  const q = (sel) => root.querySelector(sel)
  const stripEl = q('[data-state-strip]')
  const plan = q('[data-state-plan]')
  const files = q('[data-state-files]')
  const compaction = q('[data-state-compaction]')
  return {
    hasStrip: !!stripEl,
    planHead: plan?.querySelector('.pm-state-head')?.textContent ?? '',
    planBarWidth: plan?.querySelector('.pm-plan-bar-fill')?.style.width ?? '',
    filesHead: files?.querySelector('.pm-state-head')?.textContent ?? '',
    chipText: compaction?.querySelector('.pm-compaction-chip')?.textContent ?? '',
    planOpen: !!plan?.querySelector('.pm-state-body'),
  }
})
check('state strip renders all three folded states', strip.hasStrip && strip.planHead && strip.filesHead && strip.chipText, JSON.stringify({ strip: strip.hasStrip }))
check('plan header carries objective and the settled count 1/2', /整理页面要点并输出报告/.test(strip.planHead) && /1\/2/.test(strip.planHead), strip.planHead)
check('plan progress bar reads 50%', strip.planBarWidth === '50%', strip.planBarWidth)
check('plan checklist starts collapsed', !strip.planOpen, `open=${strip.planOpen}`)
check('file header counts 2 files', /本会话改动/.test(strip.filesHead) && /2 个文件/.test(strip.filesHead), strip.filesHead)
check(
  'compaction chip reads 已压缩 · 丢弃3 · 释放10.7K with 已生效 (request source)',
  /已压缩 · 丢弃3 · 释放10\.7K/.test(strip.chipText) && /已生效/.test(strip.chipText) && !/下次请求生效/.test(strip.chipText),
  strip.chipText.replace(/\s+/g, ' '),
)
await shot('strip')

// Expand the plan: nodes, the current-node highlight, status glyphs.
await page.locator('[data-state-plan] .pm-state-head').click()
const planBody = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  const rows = [...root.querySelectorAll('[data-plan-node]')]
  return {
    ids: rows.map((r) => r.dataset.planNode),
    current: rows.filter((r) => r.classList.contains('pm-plan-node-current')).map((r) => r.dataset.planNode),
    completedGlyph: rows[0]?.querySelector('.pm-plan-node-glyph')?.textContent ?? '',
    desc: rows.map((r) => r.querySelector('.pm-plan-node-text')?.textContent ?? ''),
  }
})
check(
  'expanded plan lists nodes in order with the current node highlighted',
  planBody.ids.join(',') === 'n1,n2' && planBody.current.join(',') === 'n2',
  `nodes=${planBody.ids.join(',')} current=${planBody.current.join(',')}`,
)
check('completed node shows the ✓ glyph and its summary tooltip', planBody.completedGlyph.includes('✓'), planBody.completedGlyph)
await shot('plan-open')

// File ink: expand and read the computed colors.
await page.locator('[data-state-files] .pm-state-head').click()
const fileRows = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  return [...root.querySelectorAll('.pm-filechange-row')].map((r) => ({
    kind: r.querySelector('.pm-filechange-kind')?.textContent,
    color: getComputedStyle(r.querySelector('.pm-filechange-kind')).color,
    path: r.querySelector('.pm-filechange-path')?.textContent,
  }))
})
check(
  'file rows carry the created/modified ink literals (light tokens)',
  fileRows.length === 2 &&
    fileRows[0].kind === '新建' && fileRows[0].color === 'rgb(88, 124, 12)' &&
    fileRows[1].kind === '修改' && fileRows[1].color === 'rgb(137, 85, 3)',
  JSON.stringify(fileRows.map((r) => `${r.kind}:${r.color}`)),
)

// ── 重试计数(真事件推送)──────────────────────────────────────────────────
await page.evaluate(() => {
  window.__pushEvent({ type: 'status', status: 'retrying', attempt: 2, maxRetries: 5, delayMs: 12000, message: 'rate limited' })
})
await page.waitForTimeout(100)
const retryLabel = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  return root.querySelector('.pm-status')?.textContent ?? ''
})
check(
  'retrying status shows the (n/max · s) label from the event carrier',
  /重试中 \(2\/5 · 12s\)/.test(retryLabel),
  retryLabel,
)
await shot('retrying')
// The countdown ticks: one second later the seconds read decreases.
await page.waitForTimeout(1100)
const retryLabel2 = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  return root.querySelector('.pm-status')?.textContent ?? ''
})
check('the retry countdown ticks down', /重试中 \(2\/5 · 1[01]s\)/.test(retryLabel2) && retryLabel2 !== retryLabel, `${retryLabel} → ${retryLabel2}`)
// Back to idle via a real status event.
await page.evaluate(() => window.__pushEvent({ type: 'status', status: 'idle' }))

// ── 历史会话菜单 ─────────────────────────────────────────────────────────
await page.locator('[title="历史会话"]').click()
const menu = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  const el = root.querySelector('[data-sessions-menu]')
  const rows = [...(el?.querySelectorAll('.pm-sessions-row') ?? [])]
  return {
    present: !!el,
    titles: rows.map((r) => r.querySelector('.pm-sessions-title')?.textContent),
    times: rows.map((r) => r.querySelector('.pm-sessions-time')?.textContent),
    currentMarked: rows.filter((r) => r.classList.contains('pm-sessions-row-current')).length,
  }
})
check('sessions menu lists both sessions with the current one marked', menu.present && menu.titles.join('|') === '当前会话|昨天的翻译任务' && menu.currentMarked === 1, menu.titles.join(' | '))
check('relative times render (分钟级 / 天级)', /分钟前|刚刚/.test(menu.times[0] ?? '') && /天前/.test(menu.times[1] ?? ''), menu.times.join(' | '))
await shot('sessions')

// Resume: clicking the other row sends panel/resume-session with its id.
await page.locator('.pm-sessions-row:nth-child(2) .pm-sessions-open').click()
await page.waitForTimeout(100)
const resumeSent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'panel/resume-session').map((m) => m.sessionId))
check('clicking a row resumes that session over the worker channel', resumeSent.join(',') === 'ws_2', resumeSent.join(','))

// Delete: two-step inline confirm.
await page.locator('[title="历史会话"]').click()
await page.locator('.pm-sessions-row:nth-child(2) .pm-sessions-del').click()
const confirmShown = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  return root.querySelector('.pm-sessions-confirm')?.textContent ?? ''
})
check('the delete button first asks inline (确认删除?)', /确认删除\?/.test(confirmShown), confirmShown)
await page.locator('.pm-sessions-confirm-yes').click()
await page.waitForTimeout(100)
const deleteSent = await page.evaluate(() => window.__sent.filter((m) => m.type === 'panel/delete-session').map((m) => m.sessionId))
check('confirming deletes the session over the worker channel', deleteSent.join(',') === 'ws_2', deleteSent.join(','))
await page.keyboard.press('Escape')
await page.evaluate(() => document.querySelector('[data-pulsemind-panel]').shadowRoot.activeElement?.blur?.())

// ── 用户消息截图 + HTML 卡「在浏览器打开」(真事件推送的消息)───────────────
// 消息数据在 Node 侧构造、经参数传入 evaluate——回调体序列化到页面后,
// Node 侧的模板插值对它不可见(首跑实测:createAt 里的 '${iso(...)}' 落成了字面量)。
const MSGS = {
  type: 'messages',
  messages: [
    { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '把这一页的要点整理出来' }], createdAt: iso(60_000) },
    {
      id: 'm2',
      role: 'user',
      contentBlocks: [
        { type: 'text', text: '这是刚才那步的截图:' },
        { type: 'tool_result', tool_use_id: 't1', content: '', imageData: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
      ],
      createdAt: iso(30_000),
    },
    {
      id: 'm3',
      role: 'assistant',
      contentBlocks: [
        {
          type: 'text',
          text: '整理结果如下：\n\n- 要点一\n\n```html\n<html><body><h1 id="pm-artifact-title">页面要点报告</h1><p>要点一的展开说明。</p></body></html>\n```\n',
        },
      ],
      createdAt: iso(20_000),
    },
  ],
}
await page.evaluate((data) => window.__pushEvent(data), MSGS)
await page.waitForTimeout(300)

const surface = await page.evaluate(() => {
  const root = document.querySelector('[data-pulsemind-panel]').shadowRoot
  const img = root.querySelector('.pm-bubble img.pm-user-image')
  const card = root.querySelector('[data-html-artifact-card]')
  const openBtn = card?.querySelector('button[title="在浏览器打开"]')
  return {
    imgPresent: !!img,
    imgSrc: img?.getAttribute('src')?.slice(0, 15) ?? '',
    cardPresent: !!card,
    openBtnPresent: !!openBtn,
  }
})
check('the user message renders its screenshot inside the bubble', surface.imgPresent && surface.imgSrc.startsWith('data:image/png'), surface.imgSrc)
check('the html artifact card toolbar carries the 在浏览器打开 button', surface.cardPresent && surface.openBtnPresent, `card=${surface.cardPresent}`)

// Click through a REAL user gesture so window.open is honored; the popup is a
// real tab (about:blank) that the write path fills with the card document.
const popupPromise = page.context().waitForEvent('page', { timeout: 5000 })
await page.locator('[data-html-artifact-card]').hover()
await page.locator('button[title="在浏览器打开"]').last().click()
try {
  const popup = await popupPromise
  await popup.waitForTimeout(200)
  const popupInfo = await popup.evaluate(() => ({
    title: document.querySelector('#pm-artifact-title')?.textContent ?? '',
    url: location.href,
  }))
  check('the open button opens a real tab with the card document', popupInfo.title === '页面要点报告' && popupInfo.url === 'about:blank', JSON.stringify(popupInfo))
  await popup.close()
} catch {
  check('the open button opens a real tab with the card document', false, 'no popup event — window.open blocked or not called')
}
await shot('messages')

// ── 收尾 ─────────────────────────────────────────────────────────────────
check('no page errors during the whole probe', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
process.exit(failed.length > 0 ? 1 : 0)
