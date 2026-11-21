/**
 * 回到底部按钮不消失的复现探针（2026-11-22 用户报告：【明日天气冷暖对比】
 * 滚动到底部后按钮仍在）。
 *
 * 配方同 probe-chat-scroll-pane：真 AppLayout + ChatView（stub 桥、无
 * Electron/LLM），CDP `Input.dispatchMouseEvent(mouseWheel)` 发真实滚轮事件。
 * 判官是按钮 DOM 本身（aria-label=回到底部），页内 capture 监听记录滚轮与
 * 滚动事件的 (top, gap) 轨迹，直接对照 tail-follow 的重挂条件
 * （st > prevTop && gap <= 8px）看最后一拍到底发生了什么。
 *
 * Usage: node scripts/probe-tail-follow-reattach.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-tail-reattach-')), 'harness.js')
const CONV_KEY = 'conv_20261122001434'
const WS = '/pm-probe-ws'

const FIXTURE_JS = `
const AT = '2026-11-22T00:14:34.000Z'
const msg = (id, role, blocks) => ({ id, role, contentBlocks: blocks, createdAt: AT })
const text = (s) => ({ type: 'text', text: s })
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input, status: 'completed', exitCode: 0 })
const toolResult = (id, s) => ({ type: 'tool_result', tool_use_id: id, content: s })
// 仿【明日天气冷暖对比】：两轮问答 + 天气表格收尾（markdown 表格是最后一屏的主体）。
function buildFixture() {
  const weatherTable = [
    '| 指标 | 今天 11/22 周日 | 明天 11/23 周一 |',
    '|---|---|---|',
    '| 天气 | 晴到多云 | 多云转阴 |',
    '| 气温 | 8~17℃ | 10~15℃ |',
    '| 风力 | 东北风 3-4 级 | 北风 4-5 级 |',
    '| 湿度 | 45% | 65% |',
    '| 体感 | 早晚偏冷 | 全天偏冷 |',
    '| 空气 | 优 | 良 |',
    '| 降水 | 10% | 30% |',
    '| 紫外线 | 中等 | 弱 |',
    '| 穿衣 | 抓卫衣 | 加薄羽绒 |',
  ].join('\\n')
  const out = []
  out.push(msg('u1', 'user', [text('明天的天气会比今天冷吗')]))
  out.push(msg('a1t', 'assistant', [toolUse('tu1', 'web_search', { query: '上海 明天天气' })]))
  out.push(msg('a1r', 'user', [toolResult('tu1', '上海 11/23 多云转阴 10~15℃ 北风4-5级')]))
  out.push(msg('a1', 'assistant', [text('上海是吧，老大？我按上海给你查今天（11/22）和明天（11/23）的对比。')]))
  out.push(msg('u2', 'user', [text('嗯')]))
  out.push(msg('a2t', 'assistant', [toolUse('tu2', 'web_search', { query: '上海 未来两天天气' })]))
  out.push(msg('a2r', 'user', [toolResult('tu2', '上海 11/22 晴到多云 8~17℃；11/23 多云转阴 10~15℃')]))
  out.push(msg('a2', 'assistant', [text('**上海**（数据源：上海发布、上观新闻、解放日报 11/21 晚间预报）\\n\\n' + weatherTable + '\\n\\n明天比今天早晨暖一点，但白天最高温反而低 2℃，加上风大，体感更冷，建议加件外套。')]))
  return out
}
`

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
${FIXTURE_JS}

function Harness() {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState([])
  window.__load = () => { setMessages(buildFixture()); setStatus({ status: 'idle' }); setStreamingBlocks([]); return true }
  window.__count = () => messages.length
  return (
    <AppLayout conversations={[]} activeConversationKey="" totalSessions={0} autoCleanup={true}
      onCreateNew={() => {}} onDeleteConversation={() => {}} onRenameConversation={() => {}}
      onSelectConversation={() => {}} onTogglePinConversation={() => {}}>
      <ChatView messages={messages} conversationId={CONV_KEY} workspaceDir={WS} conversations={[]}
        isRequesting={status.status !== 'idle'} agentStatus={status} streamingBlocks={streamingBlocks}
        hasApiKey={true} onSendMessage={() => {}} onCancel={() => {}} onApproveTool={() => {}}
        onRejectTool={() => {}} onClearError={() => {}} />
    </AppLayout>
  )
}

// ── 判官与轨迹记录 ──
window.__navBtn = () => document.querySelector('button[aria-label="回到底部"]')
window.__navVisible = () => !!window.__navBtn()
window.__scroller = () => document.querySelector('[data-pm-chat-scroll]')
window.__geom = () => {
  const el = window.__scroller()
  if (!el) return null
  return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), sh: el.scrollHeight, ch: el.clientHeight }
}
window.__log = []
window.__install = () => {
  const el = window.__scroller()
  el.addEventListener('wheel', (e) => {
    window.__log.push({ kind: 'wheel', dy: e.deltaY, prevented: e.defaultPrevented, top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) })
  }, { passive: true })
  el.addEventListener('scroll', () => {
    window.__log.push({ kind: 'scroll', top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) })
  }, { passive: true })
  return true
}
window.__dispatchPoint = () => {
  const el = window.__scroller()
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  const at = document.elementFromPoint(x, y)
  const chain = []
  let n = at
  while (n && n !== document.body) { chain.push(n.tagName + '.' + (n.className || '').toString().slice(0, 50)); n = n.parentElement }
  return { x, y, at: at?.tagName, chain: chain.slice(0, 8), n: document.querySelectorAll('[data-pm-chat-scroll]').length }
}
window.__tail = (n) => window.__log.slice(-n)
window.__clearLog = () => { window.__log.length = 0; return true }

createRoot(document.getElementById('root')).render(
  <ConfigProvider><SettingsProvider><TranslationProvider initialLocale="zh"><Harness /></TranslationProvider></SettingsProvider></ConfigProvider>
)
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.route('http://pm-tail.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><style>
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 3px; }
    </style><script>
    window.electronAPI = new Proxy({
      getPlatformInfo: () => Promise.resolve({ platform: 'darwin' }),
      getSettings: () => Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: true, locale: 'zh' }),
    }, {
      get: (target, key) => key in target ? target[key]
        : key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root" style="height:900px"></div></body></html>`,
}))
await page.goto('http://pm-tail.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => typeof window.__load === 'function')
await page.waitForFunction(() => document.querySelectorAll('#root div').length > 3)
await page.waitForTimeout(400)
await page.evaluate(() => window.__load())
await page.waitForFunction(() => (window.__count?.() ?? 0) >= 8)
await page.waitForTimeout(1500) // landing pin settles

await page.evaluate(() => window.__install())
const cdp = await page.context().newCDPSession(page)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('[dispatch point]', JSON.stringify(await page.evaluate(() => window.__dispatchPoint())))

const geom = () => page.evaluate(() => window.__geom())
const navVisible = () => page.evaluate(() => window.__navVisible())

async function wheelAt(dir, deltaY, times, intervalMs = 60) {
  const el = await page.evaluate(() => {
    const s = window.__scroller()
    const r = s.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  for (let i = 0; i < times; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: el.x, y: el.y, deltaX: 0, deltaY: dir * Math.abs(deltaY) })
    await sleep(intervalMs)
  }
}

async function settleScroll() {
  // 等滚动动画彻底结束（120ms 内 gap 无变化）。
  let last = null
  for (let i = 0; i < 60; i += 1) {
    await sleep(120)
    const g = await geom()
    const key = `${g.top}/${g.gap}`
    if (key === last) return g
    last = key
  }
  return geom()
}

const report = { steps: [] }

// ── 场景 1：向上滚（按钮出现）→ 一格一格滚回底部 ──
{
  const before = { geom: await geom(), nav: await navVisible() }
  report.steps.push({ name: 'initial', ...before })
  await wheelAt(-1, -120, 5, 120) // 向上 5 格
  await settleScroll()
  const up = { geom: await geom(), nav: await navVisible() }
  report.steps.push({ name: 'after-wheel-up', ...up })

  await page.evaluate(() => window.__clearLog())
  // 模拟轨迹板下滚：密度高、增量衰减（动量收尾），最后一格落在底部。
  const deltas = [-1, -1].map((d) => -d) // placeholder to keep shape obvious
  void deltas
  await wheelAt(1, 160, 3, 80)
  await wheelAt(1, 80, 4, 60)
  await wheelAt(1, 40, 6, 40)
  await settleScroll()
  const down = { geom: await geom(), nav: await navVisible(), log: await page.evaluate(() => window.__tail(40)) }
  report.steps.push({ name: 'after-wheel-down-to-bottom', ...down })
}

// ── 场景 2：快速甩动（fling）到底，动量自然衰减 ──
{
  await wheelAt(-1, -120, 5, 120)
  await settleScroll()
  report.steps.push({ name: 'fling-prep', nav: await navVisible(), geom: await geom() })
  await page.evaluate(() => window.__clearLog())
  // fling：一串大 delta 快速连发，然后停手（动量交给浏览器）。
  for (let i = 0; i < 12; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY: 260 })
    await sleep(10)
  }
  await settleScroll()
  report.steps.push({ name: 'after-fling-down', nav: await navVisible(), geom: await geom(), log: await page.evaluate(() => window.__tail(40)) })
}

// ── 场景 3：拖滚动条到底 ──
{
  await wheelAt(-1, -120, 5, 120)
  await settleScroll()
  report.steps.push({ name: 'scrollbar-prep', nav: await navVisible(), geom: await geom() })
  await page.evaluate(() => window.__clearLog())
  // scrollbar 拖拽：直接设置 scrollTop 模拟（CDP 拖 thumb 太脆），逐帧递减 gap。
  await page.evaluate(async () => {
    const el = window.__scroller()
    const max = el.scrollHeight - el.clientHeight
    // 一次性跳到底（拖拽的真实形态是大步长跳跃）
    el.scrollTop = max
    await new Promise((r) => setTimeout(r, 50))
    el.scrollTop = max
  })
  await settleScroll()
  report.steps.push({ name: 'after-scrollbar-jump', nav: await navVisible(), geom: await geom(), log: await page.evaluate(() => window.__tail(20)) })
}

// ── 场景 4：底部上的微动（2026-11-22 用户报告的确定性复现）──
// 在 gap=0 的尾部上，一个 deltaY<0 的滚轮事件（轨迹板抬手指尾流/指尖微调）
// 会 release——而重挂条件要求 st > prevTop，gap=0 时视口再也动不了，
// 之后怎么向下滚都没有 scroll 事件，按钮永久卡住。修复后的两条出路：
// 4a 尾部上的向下滚轮 → 立即重挂；4b 静置 1.2s → 静置时钟自动重挂。
{
  await wheelAt(-1, -120, 5, 120)
  await settleScroll()
  await wheelAt(1, 160, 6, 80) // 滚回底部（这一步会重挂、按钮消失）
  await settleScroll()
  report.steps.push({ name: 'deadzone-prep', nav: await navVisible(), geom: await geom() })
  await page.evaluate(() => window.__clearLog())
  await wheelAt(-1, -1, 2, 60) // 尾部上的微上滚：release，但滚动几乎不可见
  await settleScroll()
  report.steps.push({ name: 'after-micro-wheel-up-at-tail', nav: await navVisible(), geom: await geom(), log: await page.evaluate(() => window.__tail(20)) })

  // 4a：卡住状态下向下滚（用户的第一反应）→ 立即消失。
  await page.evaluate(() => window.__clearLog())
  await wheelAt(1, 200, 2, 80)
  await settleScroll()
  report.steps.push({ name: 'escape-wheel-down-at-tail', nav: await navVisible(), geom: await geom(), log: await page.evaluate(() => window.__tail(20)) })

  // 4b：再次卡住，然后完全静置 → 静置时钟重挂、按钮自动消失。
  await wheelAt(-1, -1, 2, 60)
  await settleScroll()
  report.steps.push({ name: 'restranded-for-dwell', nav: await navVisible(), geom: await geom() })
  await page.waitForTimeout(1800)
  report.steps.push({ name: 'escape-quiet-dwell', nav: await navVisible(), geom: await geom() })
}

console.log('REPORT_JSON=' + JSON.stringify(report))
// 判定：逐步骤显式期望——底部态按钮必须消失，离开底部/复现卡住态按钮必须在，
// 两条出路（escape-*）必须把按钮收掉。
const EXPECT = {
  initial: false,
  'after-wheel-up': true,
  'after-wheel-down-to-bottom': false,
  'fling-prep': true,
  'after-fling-down': false,
  'scrollbar-prep': true,
  'after-scrollbar-jump': false,
  'deadzone-prep': false,
  'after-micro-wheel-up-at-tail': true, // 复现态：微上滚 release，属引擎语义
  'escape-wheel-down-at-tail': false,
  'restranded-for-dwell': true,
  'escape-quiet-dwell': false,
}
const bad = report.steps.filter((s) => s.name in EXPECT && s.nav !== EXPECT[s.name])
if (bad.length > 0) {
  console.log('\n[FAIL] ' + bad.map((s) => `${s.name}: nav=${s.nav} want=${EXPECT[s.name]}`).join('; '))
  process.exitCode = 1
} else {
  console.log('\n[PASS] all 12 steps match expectations — both stranded-tail escapes work')
}
await browser.close()
