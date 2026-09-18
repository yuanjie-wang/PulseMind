/**
 * Chat deliverables probe (real Chromium).
 *
 * The deliverables card (PLAN-deliverables) is a DERIVED view: what files a
 * turn actually wrote, read off the session mirror, plus what the spawn tree
 * wrote (hydrated from the DB at terminal status). Its facts are layout and
 * timing facts no jsdom test can see:
 *
 *   - the card is fed the FULL messages, never ChatView's render window — a
 *     head-truncated feed makes delivered files vanish as the history grows,
 *     which is why this fixture's first files live at the HEAD of a list long
 *     enough (> 50 segments) to truncate;
 *   - an op appears the moment its tool_result lands (streaming, mid-turn),
 *     while a still-pending write shows nothing;
 *   - a row click opens the workbench's file tab through the REAL
 *     previewPaneStore.openFile;
 *   - child conversations hydrate through the real hook and merge with
 *     attribution (来自：…).
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
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
const AT = '${AT}'


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

// The head files live in the FIRST messages of a list long enough to truncate
// the render window (>50 segments): if the card were ever fed the window
// instead of the full list, these two vanish and every count below breaks.
const HEAD = [...writePair('h1', WS + '/head-a.md'), ...writePair('h2', WS + '/head-b.md')]
const FILLER = Array.from({ length: 130 }, (_, i) => text('f' + i, i % 2 ? 'assistant' : 'user', '填充 ' + i))
const TAIL = [
  ...writePair('t1', WS + '/tail-report.md'),
  { id: 'spa', role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 'spu', name: 'spawn_agent', input: { task: '调研' }, subConvId: 'sub_probe_1' }], createdAt: AT },
  { id: 'spr', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 'spu', content: 'spawned' }], createdAt: AT }
]

// ONE mounted tree, state-driven updates — the real chat never unmounts
// ChatView between turns (AppLayout hides it), and useDeliverables' child
// aggregation is component state: an unmount between "streaming steps" would
// fake its loss.
function Harness() {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState({ status: 'idle' })
  window.__mountWelcome = () => { setMessages([]); setStatus({ status: 'idle' }); return true }
  window.__mountConversation = () => {
    setMessages([...HEAD, ...FILLER, ...TAIL])
    setStatus({ status: 'idle' })
    return true
  }
  // A mid-turn op: the pending write adds a row for NOTHING; its paired result
  // (still executing) adds one immediately — D5's live follow.
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


window.__rowCount = () => document.querySelectorAll('[data-testid="deliverables-row"]').length
window.__cardPresent = () => !!document.querySelector('.pm-deliverables-card')
window.__rowPaths = () => [...document.querySelectorAll('[data-testid="deliverables-row"]')].map((el) => el.getAttribute('data-dl-path'))
window.__workbench = () => ({ tab: useWorkbenchStore.getState().activeTab, open: useWorkbenchStore.getState().openByConversation && true })
window.__previewTabs = () => usePreviewPaneStore.getState().tabsByConversation[CONV_KEY]?.map((t) => t.path) ?? []
window.__collapse = () => { document.querySelector('[data-testid="deliverables-head"]').click(); return true }
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

// ── 1. Welcome: no messages, no card ──
{
  console.log('== 欢迎页 ==')
  await page.evaluate(() => window.__mountWelcome())
  await page.waitForTimeout(200)
  check('无消息时零卡片', !(await page.evaluate(() => window.__cardPresent())))
  await page.screenshot({ path: join(SHOTS, 'welcome.png') })
}

// ── 2. Conversation at terminal: head files still counted (full-list feed) ──
{
  console.log('== 回合终态 ==')
  await page.evaluate(() => window.__mountConversation())
  await page.waitForFunction(() => window.__rowCount() > 0, null, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const paths = await page.evaluate(() => window.__rowPaths())
  // head-a + head-b + tail-report + child-report + grand = 5. If the card were
  // fed the RENDER WINDOW, the two head files fall off (3) — the red this
  // probe must show for the windowing red line.
  check('头部分组后的文件仍在列（吃完整 messages）', paths.includes('/pm-probe-ws/head-a.md') && paths.includes('/pm-probe-ws/head-b.md'), JSON.stringify(paths))
  check('五份产物齐全（主会话 3 + 子链 2）', paths.length === 5, `rows=${paths.length}`)
  check('子代理署名：child-report 来自 调研专家', await page.getByText('来自：调研专家').count() === 1)
  check('孙辈署名：grand 来自 汇总专家', await page.getByText('来自：汇总专家').count() === 1)
  check('诚实边界脚注在场', await page.getByText('命令行间接产物不在此列').count() === 1)
  check('数量徽标 = 5', await page.locator('.pm-deliverables-card').textContent().then((s) => s.includes('5')), '')
  await page.screenshot({ path: join(SHOTS, 'terminal.png') })
}

// ── 3. Real click on a row → preview tab + workbench flips to files ──
{
  console.log('== 点击产物行 ==')
  await page.locator('[data-dl-path="/pm-probe-ws/tail-report.md"]').click()
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
  const during = await page.evaluate(() => window.__rowCount())
  check('pending 的 write 不入列', during === 5, `rows=${during}`)
  await page.evaluate(() => window.__completeOp())
  await page.waitForTimeout(250)
  const after = await page.evaluate(() => window.__rowCount())
  check('tool_result 落地即入列', after === 6, `rows=${after}`)
  await page.evaluate(() => window.__finishTurn())
  await page.waitForTimeout(200)
}

// ── 5. Collapse / expand ──
{
  console.log('== 收起与展开 ==')
  await page.evaluate(() => window.__collapse())
  await page.waitForTimeout(150)
  const collapsed = await page.evaluate(() => window.__rowCount())
  check('收起后行隐藏', collapsed === 0, `rows=${collapsed}`)
  check('收起后卡片仍在', await page.evaluate(() => window.__cardPresent()))
  await page.evaluate(() => window.__collapse())
  await page.waitForTimeout(150)
  const expanded = await page.evaluate(() => window.__rowCount())
  const after = await page.evaluate(() => window.__rowPaths())
  check('再点展开，行回来', expanded === 6, `rows=${expanded} paths=${JSON.stringify(after)}`)
  await page.screenshot({ path: join(SHOTS, 'expanded.png') })
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? ' — ALL GREEN' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
