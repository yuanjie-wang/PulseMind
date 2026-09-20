/**
 * Sub-agent session view probe (real Chromium) — PLAN-workbench W12, plus the
 * spawn card's own door into it (2026-09-17).
 *
 * The ruling for this screen was 严格一致 with the main chat, with exactly two
 * differences: no composer, and a 返回主对话 button at the top-left. It renders
 * the production `chat/TranscriptView`, and there is nothing on this side of the
 * wire but the sub-conversation id — engines are hosted in the main process — so
 * "follow the run" means polling the stored transcript while the node is open.
 *
 * Those are all browser facts: no composer is a DOM fact, the back button landing
 * is a click fact, and the poll is a timing fact (jsdom sees none of it, and the
 * component's only signals are a caption and a timer). This mounts the real
 * component against a stubbed `window.electronAPI`, so it needs no Electron, no
 * LLM call and no sub-agent run.
 *
 * The second half is the spawn card, which used to open its own hand-rolled
 * preview modal (deleted: a second message renderer) and now hands
 * `(subConvId, title)` up to the host, which opens this same view. It mounts the
 * real `SegmentView` — the card's two routes, single and execution segment — in
 * four fixture hosts and drives the eye with a real mouse: the hand-off must
 * carry the ID and the card's own title, the click must not also collapse or
 * expand the card, the card must read no transcript of its own (the stub counts
 * reads), and the two states that must *not* show the eye — a read-only host and
 * a card with no `subConvId` (a nested spawn, restored from the DB) — are the
 * negative controls, so a gate that got dropped cannot pass.
 *
 * Usage: node scripts/probe-subagent-session.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(tmpdir(), 'pm-subagent-session-shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-subagent-session-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SubAgentSessionView } from './src/renderer/src/components/subagent/SubAgentSessionView'
import { SegmentView } from './src/renderer/src/components/chat/SegmentView'

// The transcript touches electronAPI on render (file chips, copy) — everything
// resolves to undefined. hydrateConversation is the one this probe drives.
const calls = []
window.__calls = calls
window.__failNext = 0
// main.tsx's boot, in order: the variable sheet, then the attribute. The chat's
// migrated surfaces read var(--pm-*), and an unset variable resolves to nothing
// (transparent / inherited) — so a probe that measures them without the sheet is
// measuring a page the app never renders (PLAN-dark-mode D7: the helper ships in
// the same change as the migration, not after it).
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (key === 'hydrateConversation') {
      calls.push(String(args[0]))
      if (window.__failNext > 0) { window.__failNext--; return Promise.reject(new Error('读取失败')) }
      return Promise.resolve(window.__conv)
    }
    return Promise.resolve(undefined)
  },
})

const NOW = '2026-09-16T10:00:00.000Z'
// A sub-agent turn as it lands in the DB: the kick-off message, then the answer.
window.__conv = {
  id: 'sub_1', title: '写作专家', createdAt: NOW, updatedAt: NOW,
  messages: [
    { id: 'm1', role: 'user', content: 'Please execute the task described in the system prompt.',
      contentBlocks: [{ type: 'text', text: 'Please execute the task described in the system prompt.' }], createdAt: NOW },
    { id: 'm2', role: 'assistant', content: '子代理的回答',
      contentBlocks: [{ type: 'text', text: '子代理的回答：周末从补觉开始。' }], createdAt: NOW },
  ],
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [live, setLive] = useState(true)
  return (
    <div style={{ width: 900, height: 520, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button id="toggle-live" onClick={() => setLive(v => !v)}>toggle-live:{String(live)}</button>
        <button id="reopen" onClick={() => setOpen(true)}>reopen</button>
      </div>
      <div id="view" style={{ flex: 1, border: '1px solid #ccc', minHeight: 0 }}>
        {open
          ? <SubAgentSessionView
              subConvId="sub_1"
              title="n1 · 撰写 5 个程序员周末场景"
              live={live}
              onBack={() => { window.__backed = (window.__backed || 0) + 1; setOpen(false) }}
            />
          : <div id="main-chat-stub">主对话</div>}
      </div>
    </div>
  )
}

// ── The spawn card's own door into the view above ──
// The card lives in a SegmentView, so the fixtures mount the real one: the
// single-block route renders the card directly, the execution route keeps it one
// layer down (and starts collapsed, like the chat's).
const opened = []
window.__opened = opened
const hostOpen = (subConvId, title) => { opened.push([subConvId, title]) }
const noop = () => {}

const spawnBlock = (id, input, extra) => ({
  type: 'tool_use', id, name: 'spawn_agent', status: 'completed', exitCode: 0,
  output: 'SPAWN_OUTPUT_MARKER', input, ...extra,
})
const spawnMsg = (id, block) => ({ id, role: 'assistant', createdAt: NOW, contentBlocks: [block] })

function CardCases() {
  const single = { type: 'single', msg: spawnMsg('msg_single', spawnBlock('tu_single',
    { subAgentId: 'exp_writer', task: '写一段周末文案\\n第二行' }, { subConvId: 'sub_single' })) }
  const execSeg = { type: 'execution', msgs: [spawnMsg('msg_exec', spawnBlock('tu_exec',
    { subAgentId: 'exp_reviewer', task: '审阅第一章' }, { subConvId: 'sub_exec' }))] }
  const otherTool = { type: 'single', msg: spawnMsg('msg_other', {
    type: 'tool_use', id: 'tu_other', name: 'exec', status: 'completed', exitCode: 0,
    output: 'SPAWN_OUTPUT_MARKER', input: { command: 'echo hi' }, subConvId: 'sub_ignored',
  }) }
  const noHandler = { type: 'single', msg: spawnMsg('msg_nohandler', spawnBlock('tu_nohandler',
    { subAgentId: 'exp_writer', task: '只读宿主里不该有眼睛' }, { subConvId: 'sub_readonly' })) }
  const noId = { type: 'single', msg: spawnMsg('msg_noid', spawnBlock('tu_noid',
    { subAgentId: 'exp_writer', task: '嵌套的子代理' }, {})) }
  const common = { isLastSegment: false, actions: 'none', onApproveTool: noop, onRejectTool: noop }
  return (
    <div id="card-cases" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div id="single-live" style={{ border: '1px solid #ddd', padding: 8 }}>
        <SegmentView seg={single} onOpenSubAgent={hostOpen} {...common} />
      </div>
      <div id="exec-live" style={{ border: '1px solid #ddd', padding: 8 }}>
        <SegmentView seg={execSeg} onOpenSubAgent={hostOpen} {...common} />
      </div>
      <div id="other-tool" style={{ border: '1px solid #ddd', padding: 8 }}>
        <SegmentView seg={otherTool} onOpenSubAgent={hostOpen} {...common} />
      </div>
      <div id="no-handler" style={{ border: '1px solid #ddd', padding: 8 }}>
        <SegmentView seg={noHandler} {...common} />
      </div>
      <div id="no-id" style={{ border: '1px solid #ddd', padding: 8 }}>
        <SegmentView seg={noId} onOpenSubAgent={hostOpen} {...common} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('app')).render(
  <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
    <TranslationProvider><Harness /><CardCases /></TranslationProvider>
  </ConfigProvider>
)
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), sourcefile: 'probe-subagent-session.tsx', loader: 'tsx' },
  bundle: true,
  outfile: OUT,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
})

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForSelector('#view', { timeout: 15000 })
await page.waitForTimeout(400)

// ── The screen itself ──
const text = await page.locator('#view').innerText()
check('[view] renders the sub-agent transcript (its own messages, not the main one)',
  text.includes('子代理的回答') && text.includes('system prompt'), text.split('\n').slice(0, 3).join(' / '))
check('[view] header names the node and offers 返回主对话',
  text.includes('n1 · 撰写 5 个程序员周末场景') && text.includes('返回主对话'), '')
check('[view] the run-state tag follows the live flag, and reads 子代理运行中 while open',
  text.includes('子代理运行中'), '')

// Exactly the two ruled differences: no composer of any kind.
const composerBits = await page.evaluate(() => ({
  textarea: document.querySelectorAll('#view textarea').length,
  textInputs: document.querySelectorAll('#view input[type="text"], #view [contenteditable="true"]').length,
}))
check('[view] no composer — the one deliberate difference from the chat',
  composerBits.textarea === 0 && composerBits.textInputs === 0, JSON.stringify(composerBits))

// ── 返回主对话 (the other deliberate difference) ──
await page.locator('#view', { hasText: '返回主对话' }).locator('text=返回主对话').first().click()
await page.waitForTimeout(150)
const backed = await page.evaluate(() => window.__backed || 0)
const backToMain = await page.locator('#main-chat-stub').count()
check('[view] a real click on 返回主对话 leaves the session for the main conversation',
  backed === 1 && backToMain === 1, `onBack×${backed}, main chat stub=${backToMain}`)

// ── Follow-the-run polling ──
await page.locator('#reopen').click()
await page.waitForTimeout(200)
const liveCalls = await page.evaluate(() => window.__calls.length)
// POLL_MS is 5000 (review 2026-09-18 M12 slowed it from 2000 — polling faster only
// re-read the same bytes), so the wait has to cover the *current* interval: at
// 2400ms this check had been failing since that commit, on a correct component.
await page.waitForTimeout(5400) // one poll must land
const liveCalls2 = await page.evaluate(() => window.__calls.length)
const calledIds = await page.evaluate(() => [...new Set(window.__calls)])
check('[view] an open node keeps polling the stored transcript',
  liveCalls2 > liveCalls && calledIds.length === 1 && calledIds[0] === 'sub_1',
  `${liveCalls} → ${liveCalls2} reads of ${calledIds.join(',')}`)

// Growing transcript: the next poll must show up without any interaction.
await page.evaluate(() => {
  window.__conv = {
    ...window.__conv,
    messages: [...window.__conv.messages, {
      id: 'm3', role: 'assistant',
      contentBlocks: [{ type: 'text', text: '第二轮：新增了一段文案。' }],
      createdAt: '2026-09-16T10:01:00.000Z',
    }],
  }
})
await page.waitForTimeout(5400)
const grew = await page.locator('#view').innerText()
check('[view] new turns appear on their own while the run is open',
  grew.includes('第二轮：新增了一段文案'), '')

// Settled: the tag flips and the polling stops.
await page.locator('#toggle-live').click()
await page.waitForTimeout(300)
const settledText = await page.locator('#view').innerText()
const settledCalls = await page.evaluate(() => window.__calls.length)
await page.waitForTimeout(2400)
const settledCalls2 = await page.evaluate(() => window.__calls.length)
check('[view] a settled session reads 已结束 and stops polling',
  settledText.includes('已结束') && settledCalls2 === settledCalls,
  `${settledCalls} → ${settledCalls2} reads after settling`)

// A read failure surfaces instead of blank-screening (and is retried while open).
await page.locator('#toggle-live').click() // live again
await page.waitForTimeout(200)
await page.evaluate(() => { window.__failNext = 1 })
await page.waitForTimeout(2400)
const recovered = await page.locator('#view').innerText()
check('[view] a failed read recovers on the next poll instead of sticking',
  recovered.includes('第二轮：新增了一段文案') && !recovered.includes('读取失败'),
  recovered.includes('读取失败') ? 'error text stuck' : 'recovered')

check('[view] renders without a page error', pageErrors.length === 0, pageErrors.join(' | '))

await page.screenshot({ path: join(SHOTS, 'subagent-session.png') })

// ── The spawn card's door into the same view ──
// These fixtures stand alone: nothing here mounts SubAgentSessionView, so any
// hydrateConversation read after this point would be the card reading for
// itself. The counter already holds the view section's polls, hence the
// baseline.
const readsBeforeCards = await page.evaluate(() => window.__calls.length)
const eyes = await page.evaluate(() => {
  const c = (sel) => document.querySelectorAll(sel).length
  // Presence is counted through the icon's title, not through
  // `[data-open-subagent]`: a card that lost the ID half of the gate would pass
  // a bogus `undefined` into that attribute, React writes nothing for it, and
  // the attribute selector would then read the same as "no eye at all" — the
  // negative control below went green against exactly that bug.
  return {
    single: c('#single-live [data-open-subagent]'),
    singleTitle: c('#single-live [title="查看子代理会话"]'),
    execCollapsed: c('#exec-live [title="查看子代理会话"]'),
    otherTool: c('#other-tool [title="查看子代理会话"]'),
    noHandler: c('#no-handler [title="查看子代理会话"]'),
    noId: c('#no-id [title="查看子代理会话"]'),
    modals: c('.ant-modal'),
  }
})
check('[card] the eye is on a spawn card that has an ID and a host, and nowhere else',
  eyes.single === 1 && eyes.singleTitle === 1 && eyes.otherTool === 0 && eyes.noHandler === 0 && eyes.noId === 0,
  `spawn+host=${eyes.single}(id)/${eyes.singleTitle}(eye) exec-collapsed=${eyes.execCollapsed} otherTool=${eyes.otherTool} noHandler=${eyes.noHandler} noId=${eyes.noId}`)
check('[card] the hand-rolled preview Modal is gone from the document',
  eyes.modals === 0, `ant-modal×${eyes.modals}`)

// A real click on the eye: the hand-off carries the ID and the card's own title.
await page.locator('#single-live [data-open-subagent]').click()
await page.waitForTimeout(150)
const handed = await page.evaluate(() => ({
  opened: window.__opened,
  reads: window.__calls.length,
  marker: document.querySelector('#single-live').innerText.includes('SPAWN_OUTPUT_MARKER'),
}))
check('[card] the click hands the view its ID and the card’s own title, exactly once',
  handed.opened.length === 1 && handed.opened[0][0] === 'sub_single' &&
  handed.opened[0][1] === 'exp_writer · 写一段周末文案',
  JSON.stringify(handed.opened))
check('[card] the card reads no transcript of its own — the host owns the session view',
  handed.reads === readsBeforeCards, `hydrateConversation×${handed.reads - readsBeforeCards}`)
check('[card] the click does not also collapse or expand the card', !handed.marker,
  handed.marker ? 'card body opened on the eye click' : 'still collapsed')

// Non-vacuity for that signal: the card's own header does open it.
await page.locator('#single-live [data-tool-head="tu_single"]').click()
await page.waitForTimeout(150)
check('[card] the header still toggles the card (the check above measures the card)',
  await page.evaluate(() => document.querySelector('#single-live').innerText.includes('SPAWN_OUTPUT_MARKER')),
  '')
await page.locator('#single-live [data-tool-head="tu_single"]').click()
await page.waitForTimeout(150)

// The execution route: the card is one layer down and the segment starts closed.
await page.locator('#exec-live [data-segment-head]').click()
await page.waitForTimeout(200)
const execEye = await page.evaluate(() => document.querySelectorAll('#exec-live [data-open-subagent]').length)
await page.locator('#exec-live [data-open-subagent]').click()
await page.waitForTimeout(150)
const execHanded = await page.evaluate(() => ({
  opened: window.__opened.slice(1),
  reads: window.__calls.length,
  segmentOpen: !!document.querySelector('#exec-live [data-tool-head="tu_exec"]'),
  marker: document.querySelector('#exec-live').innerText.includes('SPAWN_OUTPUT_MARKER'),
}))
check('[card] the execution segment’s spawn card hands off too, without closing anything',
  execEye === 1 && execHanded.opened.length === 1 && execHanded.opened[0][0] === 'sub_exec' &&
  execHanded.opened[0][1] === 'exp_reviewer · 审阅第一章' && execHanded.segmentOpen && !execHanded.marker &&
  execHanded.reads === readsBeforeCards,
  `eye×${execEye} ${JSON.stringify(execHanded.opened)} segmentOpen=${execHanded.segmentOpen} reads=${execHanded.reads - readsBeforeCards}`)

check('[card] the card section renders without a page error', pageErrors.length === 0, pageErrors.join(' | '))

await page.locator('#card-cases').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(SHOTS, 'subagent-session-cards.png') })

console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed — screenshots: ${SHOTS}`)
await browser.close()
if (results.some(r => !r.pass)) process.exit(1)
