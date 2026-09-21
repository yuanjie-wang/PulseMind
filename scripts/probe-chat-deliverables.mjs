/**
 * Chat deliverables probe (real Chromium).
 *
 * The deliverables surfaces (2026-09-19 rework) are DERIVED views: what files
 * each turn actually wrote, read off the session mirror, plus what the spawn
 * tree wrote (hydrated from the DB at terminal status). Their facts are layout
 * and timing facts no jsdom test can see:
 *
 *   - the per-turn card is an IN-FLOW card after each turn's last segment — it
 *     exists for turns with rows only (here: the head turn and the last turn,
 *     65 filler turns in between get nothing), and the LAST turn's card trails
 *     the live tail while the turn is still working;
 *   - the whole-conversation aggregate moved into the workbench's 产物 tab;
 *     the full-list feed red line lives THERE now: the panel is derived from
 *     the FULL messages, never ChatView's render window — which is why this
 *     fixture's first files sit at the HEAD of a list long enough (> 50
 *     segments) to truncate;
 *   - turn-card attribution is DIRECT-child only: the spawned 调研专家's rows
 *     join the turn that launched it, the grandchild's rows stay
 *     aggregate-only;
 *   - an op appears the moment its tool_result lands (streaming, mid-turn),
 *     while a still-pending write shows nothing;
 *   - a row click opens the workbench's file tab through the REAL
 *     previewPaneStore.openFile.
 *
 * No Electron, no LLM calls, no extension: electronAPI is stubbed (hydrate
 * serves the two-layer spawn fixture), so this cannot touch a real session.
 *
 * Usage: node scripts/probe-chat-deliverables.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-deliv-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-deliv-shots')

const CONV_KEY = 'conv_20260918100000'
const WS = '/pm-probe-ws'
const AT = '2026-09-18T10:00:00.000Z'

// The spawn chain the stubbed hydrateConversation serves: a child that writes
// its own file AND spawns a grandchild that writes another. Stored-shape rows
// (no tool_use.status) — the derivation must read pairing, not status.
const CHILD_CONVS = {
  sub_probe_1: {
    id: 'sub_probe_1',
    title: '调研专家',
    createdAt: AT,
    updatedAt: AT,
    messages: [
      { id: 'c1a', role: 'assistant', content: '', createdAt: AT, contentBlocks: [
        { type: 'tool_use', id: 'c1u', name: 'write', input: { file_path: `${WS}/child-report.md` } },
        { type: 'tool_use', id: 'c1s', name: 'spawn_agent', input: { task: '汇总' }, subConvId: 'sub_probe_2' }
      ] },
      { id: 'c1r', role: 'user', content: '', createdAt: AT, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'c1u', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'c1s', content: 'spawned' }
      ] }
    ]
  },
  sub_probe_2: {
    id: 'sub_probe_2',
    title: '汇总专家',
    createdAt: AT,
    updatedAt: AT,
    messages: [
      { id: 'c2a', role: 'assistant', content: '', createdAt: AT, contentBlocks: [
        { type: 'tool_use', id: 'c2u', name: 'write', input: { file_path: `${WS}/grand.md` } }
      ] },
      { id: 'c2r', role: 'user', content: '', createdAt: AT, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'c2u', content: 'ok' }
      ] }
    ]
  }
}

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
const AT = '${AT}'

// main.tsx's boot, in order: the variable sheet, then the attribute. The chat's
// migrated surfaces read var(--pm-*), and an unset variable resolves to nothing
// (transparent / inherited) — so a probe that measures them without the sheet is
// measuring a page the app never renders (PLAN-dark-mode D7: the helper ships in
// the same change as the migration, not after it). It lives here rather than in
// the page's own script above, which is a plain page script with no imports.
installThemeVars()
applyThemeAttr('light')


let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">{node}</TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

const writePair = (id, path) => ([
  { id: id + 'a', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: id + 'u', name: 'write', input: { file_path: path } }], createdAt: AT },
  { id: id + 'r', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: id + 'u', content: 'ok' }], createdAt: AT }
])
const text = (id, role, s) => ({ id, role, contentBlocks: [{ type: 'text', text: s }], createdAt: AT })

// The head files live in the FIRST turn of a list long enough to truncate the
// render window (>50 segments): if the aggregate panel were ever fed the
// window instead of the full list, these two vanish and every count below
// breaks. u0 / uL make the two producing turns explicit user turns.
const U0 = text('u0', 'user', '第一轮：整理头部文件')
const HEAD = [...writePair('h1', WS + '/head-a.md'), ...writePair('h2', WS + '/head-b.md')]
const FILLER = Array.from({ length: 130 }, (_, i) => text('f' + i, i % 2 ? 'assistant' : 'user', '填充 ' + i))
const UL = text('uL', 'user', '最后一轮：产出报告与调研')
const TAIL = [
  ...writePair('t1', WS + '/tail-report.md'),
  { id: 'spa', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 'spu', name: 'spawn_agent', input: { task: '调研' }, subConvId: 'sub_probe_1' }], createdAt: AT },
  { id: 'spr', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 'spu', content: 'spawned' }], createdAt: AT },
  // The closing text: it makes the last turn end on assistant TEXT, which is
  // the case where the card must mount INSIDE the message, above its 对话工具条.
  text('end', 'assistant', '两份报告已经生成完毕：tail-report.md 与调研专家产出的 child-report.md。')
]

// ONE mounted tree, state-driven updates — the real chat never unmounts
// ChatView between turns (AppLayout hides it), and useDeliverables' child
// aggregation is component state: an unmount between "streaming steps" would
// fake its loss.
function Harness() {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState({ status: 'idle' })
  window.__mountWelcome = () => { setMessages([]); setStatus({ status: 'idle' }); return true }
  // A conversation that never wrote a file: the chat branch renders (so the
  // workbench exists — the welcome branch returns before it), and the 产物
  // tab must honestly say empty.
  window.__mountTextOnly = () => {
    setMessages([
      text('w0', 'user', '讲个笑话'),
      text('w1', 'assistant', '好的：为什么程序员分不清万圣节和圣诞节？因为 OCT 31 == DEC 25。'),
      text('w2', 'user', '再来一个'),
      text('w3', 'assistant', '世界上有 10 种人：懂二进制的，和不懂的。')
    ])
    setStatus({ status: 'idle' })
    return true
  }
  window.__mountConversation = () => {
    setMessages([U0, ...HEAD, ...FILLER, UL, ...TAIL])
    setStatus({ status: 'idle' })
    return true
  }
  // A mid-turn op: the pending write adds a row for NOTHING; its paired result
  // (still executing) adds one immediately — D5's live follow, on the last
  // turn's card.
  window.__startOp = () => {
    setMessages((m) => [...m, { id: 's1a', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 's1u', name: 'write', input: { file_path: WS + '/streaming.md' }, status: 'running' }], createdAt: AT }])
    setStatus({ status: 'executing', toolUseId: 's1u' })
    return true
  }
  window.__completeOp = () => {
    setMessages((m) => [...m, { id: 's1r', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 's1u', content: 'ok' }], createdAt: AT }])
    return true
  }
  window.__finishTurn = () => { setStatus({ status: 'completed' }); return true }
  return (
    <AppLayout
      conversations={[]}
      activeConversationKey=""
      totalSessions={0}
      autoCleanup={true}
      onCreateNew={() => {}}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    >
      <ChatView
        messages={messages}
        conversationId={CONV_KEY}
        workspaceDir={WS}
        conversations={[]}
        isRequesting={status.status !== 'idle'}
        agentStatus={status}
        streamingBlocks={[]}
        hasApiKey={true}
        onSendMessage={() => {}}
        onCancel={() => {}}
        onApproveTool={() => {}}
        onRejectTool={() => {}}
        onClearError={() => {}}
      />
    </AppLayout>
  )
}
mount(<Harness />)


window.__turnCards = () => [...document.querySelectorAll('[data-testid="turn-deliverables"]')]
window.__turnCardPaths = (i) => [...(window.__turnCards()[i]?.querySelectorAll('[data-testid="turn-deliverables-row"]') ?? [])].map((el) => el.getAttribute('data-dl-path'))
window.__turnCardText = (i) => window.__turnCards()[i]?.textContent ?? ''
// The LAST turn's card — the one that survives a window collapse to the tail
// (a click near the bottom auto-scrolls, near-bottom collapses extraTop, and
// the head turn's card unmounts with its segments; that is the design, not a
// bug, so sections below the widening read the last card).
window.__lastCardPaths = () => {
  const cards = window.__turnCards()
  return window.__turnCardPaths(cards.length - 1)
}
window.__rect = (el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
}
// Geometry facts: (1) the last card sits ABOVE the turn's action toolbar with
// a real gap; (2) a card never overlaps the next turn's user bubble — the
// card's 12px bottom margin is the only spacing there (assistant messages and
// execution segments carry no bottom margin of their own).
window.__placement = () => {
  const cards = window.__turnCards()
  const last = cards[cards.length - 1]
  if (!last) return null
  const toolbarBtn = last.parentElement?.parentElement?.querySelector('[data-testid="knowledge-save"]')
  const head = cards[0]
  const nextUserMsg = head ? document.getElementById('chat-msg-f0') : null
  return {
    cardAboveToolbar: toolbarBtn
      ? window.__rect(last).bottom <= window.__rect(toolbarBtn).top
      : null,
    toolbarGap: toolbarBtn ? Math.round(window.__rect(toolbarBtn).top - window.__rect(last).bottom) : null,
    nextMsgGap: nextUserMsg && head ? Math.round(window.__rect(nextUserMsg).top - window.__rect(head).bottom) : null
  }
}
window.__pageText = () => document.body.textContent
// Horizontal alignment (user report 2026-09-21: 产物框和消息输入框没有垂直
// 居中对齐): width:100% + the card's 16px side margins pushed both mounts'
// cards 16px RIGHT of the column — left edge inset from the bubble while the
// right edge stuck out past it, off the composer's centerline. Margins ride
// outside a percentage width in a flex-start column just as in a block.
window.__hAlign = () => {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, cx: Math.round((r.left + r.right) / 2 * 10) / 10 }
  }
  const sender = document.querySelector('.ant-sender')
  const cards = [...document.querySelectorAll('[data-testid="turn-deliverables"]')]
  // The in-message card's bubble: first child of MessageGroup's flex column
  // (the card itself is a later child via the aboveActions slot).
  const inMsgCard = cards[cards.length - 1]
  const bubble = inMsgCard?.parentElement?.children[0]
  return {
    sender: sender ? rect(sender) : null,
    cards: cards.map(rect),
    inMsgBubble: bubble ? rect(bubble) : null
  }
}
window.__workbench = () => {
  const s = useWorkbenchStore.getState()
  return { tab: s.activeTab, open: !!s.openByConversation[CONV_KEY] }
}
window.__previewTabs = () => usePreviewPaneStore.getState().tabsByConversation[CONV_KEY]?.map((t) => t.path) ?? []
window.__scrollContainer = () =>
  [...document.querySelectorAll('div')].find((d) => d.style.overflow === 'auto' && d.scrollHeight > d.clientHeight) ?? null
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// Before the bundle: AppLayout reads electronAPI at module scope. hydrate
// serves the spawn-chain fixture; everything else is the standard stub.
await page.route('http://pm-probe.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><script>
window.electronAPI = new Proxy({
      hydrateConversation: (id) => Promise.resolve(window.__CHILD_CONVS[id] ?? null),
      // The preview pane reads the clicked file; an undefined body crashes its
      // markdown preview (unwrapRef) and unmounts the whole tree.
      readFile: () => Promise.resolve('probe file body'),
      statPath: () => Promise.resolve(null)
    }, {
      get: (target, key) => key in target
        ? target[key]
        : key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
        : key === 'getSettings' ? () => Promise.resolve({
            activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
            workspaceDir: '', autoCleanup: true, locale: 'zh',
          })
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root"></div></body></html>`,
}))
await page.goto('http://pm-probe.local/')
// Hand the fixture to the page before the harness reads it on mount.
await page.evaluate((fixture) => { window.__CHILD_CONVS = fixture }, CHILD_CONVS)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

// ── 1. Welcome: no turn cards (the welcome branch returns before the
//        workbench even mounts — the empty tab is checked in §1b) ──
{
  console.log('== 欢迎页 ==')
  await page.evaluate(() => window.__mountWelcome())
  await page.waitForTimeout(200)
  check('无消息时零轮卡', (await page.evaluate(() => window.__turnCards())).length === 0)
}

// ── 1b. A conversation that wrote nothing: zero cards, nothing else ──
{
  console.log('== 无产物会话 ==')
  await page.evaluate(() => window.__mountTextOnly())
  await page.waitForTimeout(250)
  check('纯文本会话零轮卡', (await page.evaluate(() => window.__turnCards())).length === 0)
}

// ── 2. Conversation at terminal: per-turn cards, in-flow and placed ──
{
  console.log('== 回合终态 ==')
  await page.evaluate(() => window.__mountConversation())
  await page.waitForFunction(() => window.__turnCards().length > 0, null, { timeout: 5000 }).catch(() => {})
  // The head turn lives OUTSIDE the 50-segment render window — like its
  // segments, its card comes back when the user scrolls up and the window
  // widens. Drive the real lazy-load path (nudge down, then to the top;
  // scrollTop=0 while already 0 fires no scroll event) until every segment
  // — and with it both turn cards — is rendered.
  for (let i = 0; i < 8; i++) {
    if ((await page.evaluate(() => window.__turnCards().length)) >= 2) break
    await page.evaluate(() => { const el = window.__scrollContainer(); if (el) el.scrollTop = 600 })
    await page.waitForTimeout(120)
    await page.evaluate(() => { const el = window.__scrollContainer(); if (el) el.scrollTop = 0 })
    await page.waitForTimeout(400)
  }
  await page.waitForFunction(
    () => window.__turnCardPaths(1)?.includes('/pm-probe-ws/child-report.md'),
    null, { timeout: 5000 },
  ).catch(() => {})
  await page.waitForTimeout(300)
  const cardCount = await page.evaluate(() => window.__turnCards().length)
  // Turn 0 (head writes) and the last turn (tail + spawn) produce cards; the
  // 65 filler turns in between produce none.
  check('只有两个有产出的轮次出卡（0 + 最后一轮）', cardCount === 2, `cards=${cardCount}`)
  const headPaths = await page.evaluate(() => window.__turnCardPaths(0))
  check('第一轮卡 = 头部两份文件（滚回顶部后出现）', headPaths.length === 2 && headPaths.includes('/pm-probe-ws/head-a.md') && headPaths.includes('/pm-probe-ws/head-b.md'), JSON.stringify(headPaths))
  const lastPaths = await page.evaluate(() => window.__turnCardPaths(1))
  check('最后一轮卡 = 报告 + 直接子代理产物', lastPaths.length === 2 && lastPaths.includes('/pm-probe-ws/tail-report.md') && lastPaths.includes('/pm-probe-ws/child-report.md'), JSON.stringify(lastPaths))
  const lastText = await page.evaluate(() => window.__turnCardText(1))
  check('轮卡署名：child-report 来自 调研专家', lastText.includes('来自：调研专家'))
  check('轮卡无孙辈（无汇总面板，孙辈产物不展示）', !lastText.includes('grand.md') && !lastText.includes('来自：汇总专家'))

  // Geometry: the last card mounts INSIDE the closing message, above its
  // 对话工具条; the head card keeps a real gap to the next turn's user bubble.
  const placement = await page.evaluate(() => window.__placement())
  check('轮卡在对话工具条上方', placement.cardAboveToolbar === true && placement.toolbarGap >= 4, JSON.stringify(placement))
  check('轮卡与下一轮用户消息有间距不重叠', placement.nextMsgGap >= 8, `gap=${placement.nextMsgGap}px`)
  // Horizontal alignment: the card must sit on the composer's centerline —
  // 16px inset per side (the documented spacing contract), never pushed right.
  const ha = await page.evaluate(() => window.__hAlign())
  check('轮卡与输入框同轴（中心差 ≤ 1px）', !!ha.sender && ha.cards.every((c) => Math.abs(c.cx - ha.sender.cx) <= 1), JSON.stringify(ha.cards.map((c) => Math.round((c.cx - ha.sender.cx) * 10) / 10)))
  check('轮卡两侧各内缩 16px 不越过气泡', !!ha.inMsgBubble && ha.cards.every((c) => Math.abs(c.width - (ha.sender.width - 32)) <= 1) && Math.abs(ha.cards[0].right - ha.inMsgBubble.right + 16) <= 1 && Math.abs(ha.cards[0].left - ha.inMsgBubble.left - 16) <= 1, `cardW=${ha.cards[0].width} senderW=${ha.sender.width} inMsgΔL=${Math.round((ha.cards[ha.cards.length - 1].left - ha.inMsgBubble.left) * 10) / 10} inMsgΔR=${Math.round((ha.cards[ha.cards.length - 1].right - ha.inMsgBubble.right) * 10) / 10}`)
  // Screenshot at the last turn's card, not wherever the widening left us.
  await page.evaluate(() => {
    const cards = window.__turnCards()
    cards[cards.length - 1]?.scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, 'turn-cards.png') })
}

// ── 3. Real click on a turn-card row → preview tab + workbench flips to files ──
{
  console.log('== 点击轮卡产物行 ==')
  await page.locator('[data-testid="turn-deliverables-row"][data-dl-path="/pm-probe-ws/tail-report.md"]').click()
  await page.waitForTimeout(250)
  const tabs = await page.evaluate(() => window.__previewTabs())
  const wb = await page.evaluate(() => window.__workbench())
  check('预览页签注册了该文件', tabs.includes('/pm-probe-ws/tail-report.md'), JSON.stringify(tabs))
  check('工作台翻到文件预览', wb.tab === 'files', JSON.stringify(wb))
}

// ── 4. Streaming: pending op shows nothing, landed op shows immediately ──
{
  console.log('== 流式推进 ==')
  await page.evaluate(() => window.__startOp())
  await page.waitForTimeout(250)
  const during = await page.evaluate(() => window.__lastCardPaths().length)
  check('pending 的 write 不入列', during === 2, `rows=${during}`)
  await page.evaluate(() => window.__completeOp())
  await page.waitForTimeout(250)
  const afterPaths = await page.evaluate(() => window.__lastCardPaths())
  check('tool_result 落地即入列（最后一轮 3 行）', afterPaths.length === 3 && afterPaths.includes('/pm-probe-ws/streaming.md'), JSON.stringify(afterPaths))
  await page.evaluate(() => window.__finishTurn())
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, 'expanded.png') })
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? ' — ALL GREEN' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
