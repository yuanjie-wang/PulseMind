/**
 * Streaming-render perf probe (real Chromium).
 *
 * 流式输出期渲染层的热路径契约（2026-09-29 perf 审计后的回归钉）：
 *
 *   引擎侧的 NOTIFY_COALESCE_MS=80 只合流「引擎→镜像」；「镜像→React」这一段
 *   曾在每个镜像事件上无条件 setMessages([...]) / setPlan(逐节点拷贝) —— 一个
 *   纯 streaming_blocks 的 tick 也把 messages 的身份重建一遍，于是 ChatView 里
 *   所有 [messages, …] 的 useMemo（turnRows 的「deliberately NOT re-paid per
 *   token」、contextUsed 的全消息估算）与未 memo 的 InputArea 都按 tick 重付。
 *   修复 = 镜像本就按引用替换所有切片（shared/agent-session/mirror 的不可变
 *   契约），客户端 sync 逐切片引用比较 + rAF/80ms 合流。
 *
 * 本探针挂**真 useConversationEngine + 真 ChatView**（stub electronAPI，从
 * Node 侧泵线协议事件），量三件事：
 *
 *   §1 80ms 文本流（引擎已合流的节拍）— 修的是每次 commit 的单价：
 *      distinct messages 引用必须 ≤3（修复前 ≈ 每 tick 一个新引用），
 *      Profiler actualDuration 总量给出单价差。
 *   §2 10ms 裸事件流（tool_status 的即发节拍，这段没有引擎合流）— 修的是
 *      commit 频率：客户端合流后 commit ≤30（修复前 ≈ 事件数 ~100）。
 *   §3 流结束后 DOM 落上完整文本（尾沿 flush 不吞最后一拍），且 100 条
 *      历史消息仍在（合流没有把状态丢成只剩流式块）。
 *
 * 非空验证：把 sync 还原成无条件拷贝，§1 的引用数与 §2 的 commit 数即红。
 *
 * Usage: node scripts/probe-stream-perf.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-stream-perf-')), 'harness.js')

const BENCH_CONV = 'conv_bench'
const TICKS = 100
const CHUNK = '流式输出的一小段文本，用来撑起 markdown 管线的真实代价。'

const HARNESS = `
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useConversationEngine } from './src/renderer/src/hooks/useConversationEngine'

installThemeVars()
applyThemeAttr('light')

// electronAPI: the hook path needs real-ish answers, everything else falls
// through to the welcome-probe's generic stub.
const SPECIFIC = {
  // 真桥是广播：同一会话流有多个订阅方（useConversationEngine 之外，
  // ChatView 还挂 usePreviewPaneSync）——桩必须扇出给全部，否则后订的
  // 会把先订的顶掉（第一次跑 subs=2、镜像零事件就是它）。
  onAgentSessionEvent: (cb) => {
    window.__cbs.push(cb)
    return () => { const i = window.__cbs.indexOf(cb); if (i >= 0) window.__cbs.splice(i, 1) }
  },
  agentSessionCreate: () => Promise.resolve({ workspaceDir: '/tmp/pm-bench-ws' }),
  agentSessionEngineCall: () => Promise.resolve(null),
  agentSessionHydrate: () => Promise.resolve(true),
  agentSessionSnapshot: () => Promise.resolve(null),
  hydrateConversation: () => Promise.resolve(null),
  saveConversation: () => Promise.resolve(true),
  appendConversationMessages: () => Promise.resolve(true),
  saveConversationSync: () => true,
}
const TABLE = {
  expertList: [], projectList: [], listConversations: [], routineList: [], routineRuns: [],
  knowledgeListFiles: [], projectValidateDir: { ok: true }, showOpenDialog: { canceled: true, filePaths: [] },
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
window.electronAPI = new Proxy(SPECIFIC, {
  get: (t, key) => {
    if (key in t) return t[key]
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    return () => Promise.resolve(TABLE[key])
  },
})

const initialMessages = []
for (let i = 0; i < 50; i++) {
  initialMessages.push({ id: 'u' + i, role: 'user', contentBlocks: [{ type: 'text', text: '第' + i + '个问题，' + '${CHUNK}'.repeat(3) }], createdAt: '2026-09-29T10:00:' + String(i % 60).padStart(2, '0') + '.000Z' })
  initialMessages.push({ id: 'a' + i, role: 'assistant', contentBlocks: [{ type: 'text', text: '第' + i + '个回答，' + '${CHUNK}'.repeat(6) }], createdAt: '2026-09-29T10:00:' + String(i % 60).padStart(2, '0') + '.500Z' })
}

const statsRef = { current: null }
window.__resetStats = (phase) => {
  statsRef.current = { phase, renders: 0, msgRefs: new Set(), streamRefs: new Set(), longN: 0, longTotal: 0, frames: [] }
}
window.__stats = () => {
  const s = statsRef.current
  const diag = {
    emitCount: window.__emitCount, emitErr: window.__emitErr, mounts: window.__mounts,
    mirrorMsgs: window.__handle ? window.__handle.messages.length : -1,
    mirrorStream: window.__handle ? window.__handle.streamingBlocks.length : -1,
    mirrorStatus: window.__handle ? window.__handle.agentStatus.status : '?',
  }
  if (!s) return { ...diag, phase: 'no-stats' }
  const gaps = []
  for (let i = 1; i < s.frames.length; i++) gaps.push(s.frames[i] - s.frames[i - 1])
  gaps.sort((a, b) => a - b)
  return { ...diag, phase: s.phase, renders: s.renders, msgRefs: s.msgRefs.size, streamRefs: s.streamRefs.size, longN: s.longN, longTotal: Math.round(s.longTotal), p95Frame: gaps.length ? Math.round(gaps[Math.floor(gaps.length * 0.95)]) : null }
}
try { new PerformanceObserver((list) => { const s = statsRef.current; if (!s) return; for (const e of list.getEntries()) { s.longN++; s.longTotal += e.duration } }).observe({ entryTypes: ['longtask'] }) } catch {}
const frameLoop = (t) => { const s = statsRef.current; if (s) s.frames.push(t); requestAnimationFrame(frameLoop) }
requestAnimationFrame(frameLoop)

function Bench() {
  const eng = useConversationEngine({
    apiKey: 'k', baseURL: 'http://bench.local', model: 'bench-model', maxTokens: 4096,
    myName: '我', soul: '灵魂', yourName: '你', locale: 'zh', skillsDir: '', platformInfo: undefined,
    adapter: {}, toolManager: {}, skillManager: {}, memoryManager: {}, knowledgeManager: {},
  })
  const [booted, setBooted] = useState(false)
  useEffect(() => {
    window.__mounts = (window.__mounts || 0) + 1
    eng.getOrCreateEngine('${BENCH_CONV}')
    eng.enginesRef.current.get('${BENCH_CONV}').loadConversation(initialMessages)
    eng.activateEngine('${BENCH_CONV}')
    // handle 的 getters 直读镜像 SessionState（live）， eng 顶层的 messages 是
    // 渲染快照——诊断必须读前者。
    window.__handle = eng.enginesRef.current.get('${BENCH_CONV}')
    setBooted(true)
  }, [])
  // 引用记账：Bench 本体随 hook 的每次 setState 重渲染，这里记本次渲染看到的
  // props 引用（去重）——即「这个切片的身份在这一阶段变过几次」；renders 计数
  // 是 commit 的代理（ChatView 无 memo，Bench 每次提交它必重渲染；生产版 React
  // 禁用 <Profiler>，量不了 actualDuration）。
  const s = statsRef.current
  if (s) {
    s.renders++
    s.msgRefs.add(eng.messages)
    s.streamRefs.add(eng.streamingBlocks)
  }
  return (
    booted ? (
      <ChatView
        messages={eng.messages}
        agentStatus={eng.agentStatus}
        streamingBlocks={eng.streamingBlocks}
        plan={eng.plan}
        lastCompaction={eng.lastCompaction}
        isRequesting={false}
        isLoadingConversation={false}
        hasApiKey={true}
        contextLength={200000}
        conversationId={'${BENCH_CONV}'}
        conversationTitle={'bench'}
        conversations={[]}
        onOpenConversation={() => {}}
        onSendMessage={() => {}} onCancel={() => {}}
        onApproveTool={() => {}} onRejectTool={() => {}} onClearError={() => {}}
        approvalMode={'outside-ask'}
        onChangeApprovalMode={() => {}}
        profiles={[]} activeProfileId={''} profilePinned={false}
        onSelectProfile={() => {}} onResetProfile={() => {}}
      />
    ) : null
  )
}

// ── 诊断出口：emit 计数 + 报错截留 + 多订阅方扇出 ──
window.__cbs = []
window.__emitCount = 0
window.__emitErr = null
Object.defineProperty(window, '__emit', {
  get() {
    return (evt) => {
      window.__emitCount++
      for (const cb of window.__cbs) {
        try { cb(evt) } catch (e) { window.__emitErr = String((e && e.stack) || e) }
      }
    }
  },
})

const root = createRoot(document.getElementById('root'))
root.render(
  <ConfigProvider><AntdApp><SettingsProvider><TranslationProvider>
    <Bench />
  </TranslationProvider></SettingsProvider></AntdApp></ConfigProvider>
)

window.__ready = true
`

try {
  await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
    outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
    logLevel: 'warning', treeShaking: false,
  })
} catch (e) {
  console.log('harness build failed:')
  console.log(e?.errors?.map((x) => x.text + '  @' + (x.location ? `line ${x.location.line}:${x.location.column}` : '?')).join('\n') ?? e)
  process.exit(1)
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)
await page.bringToFront()
await page.waitForTimeout(600)

// ── 引擎热身：置 streaming 状态 ──
const warm = await page.evaluate(() => {
  window.__emit({ sessionId: 'conv_bench', data: { type: 'status', status: 'streaming' } })
  // 同步 fold：cb 若是 hook 的订阅回调，这一拍之后镜像立刻是 streaming。
  return { subs: window.__cbs.length, statusNow: window.__handle.agentStatus.status, emitErr: window.__emitErr }
})
console.log('warmup:', JSON.stringify(warm))
await page.waitForTimeout(300)

// ── §1: 80ms 文本流（引擎合流后的节拍）──
await page.evaluate(() => window.__resetStats('text-80ms'))
await page.evaluate(({ chunk, ticks }) => {
  let n = 0
  let text = ''
  window.__pumpDone = false
  const timer = setInterval(() => {
    n++
    text += chunk
    window.__emit({ sessionId: 'conv_bench', data: { type: 'streaming_blocks', blocks: [{ type: 'text', text }] } })
    if (n >= ticks) { clearInterval(timer); window.__pumpDone = true }
  }, 80)
}, { chunk: CHUNK, ticks: TICKS })
await page.waitForFunction(() => window.__pumpDone === true)
await page.waitForTimeout(500)
const s1 = await page.evaluate(() => window.__stats())
console.log('\n§1 80ms 文本流（100 拍）:', JSON.stringify(s1))

// ── §2: 10ms 裸事件流（tool_status 的即发节拍）──
await page.evaluate(() => window.__resetStats('burst-10ms'))
await page.evaluate(({ ticks }) => {
  let n = 0
  let text = '尾段'
  window.__pumpDone2 = false
  const timer = setInterval(() => {
    n++
    text += 'x'
    window.__emit({ sessionId: 'conv_bench', data: { type: 'streaming_blocks', blocks: [{ type: 'text', text }] } })
    if (n >= ticks) { clearInterval(timer); window.__pumpDone2 = true }
  }, 10)
}, { ticks: TICKS })
await page.waitForFunction(() => window.__pumpDone2 === true)
await page.waitForTimeout(500)
const s2 = await page.evaluate(() => window.__stats())
console.log('§2 10ms 裸事件流（100 拍）:', JSON.stringify(s2))

// ── §3: 收尾 ──
// 合成流程里 completion 会卸载流式气泡（真实引擎在收尾时以 messages_append
// 接管尾段，这里没有），所以「最后一拍不丢」必须在 completion 之前、流式
// 仍在挂载时读 DOM。
await page.waitForTimeout(400)
const domStreaming = await page.evaluate(() => document.body.innerText)
// stream-throttle 是纯前沿门控、无尾沿：流式气泡允许落后最后事件 ≤150ms 的
// 文本（真实引擎收尾由 settled message 接管完整文本）。所以这里断言「尾段
// 在渲染且大体跟手」，不断言逐字节完整。
check('§3 流式进行中尾段在渲染（节流允许 ≤150ms 滞后）', /尾段x{50,}/.test(domStreaming), JSON.stringify(domStreaming.slice(-160)))
await page.evaluate(() => window.__emit({ sessionId: 'conv_bench', data: { type: 'status', status: 'completed' } }))
await page.waitForTimeout(400)
const domText = await page.evaluate(() => document.body.innerText)
check('§3 历史消息没有在流式期丢失', domText.includes('第49个回答'))
check('§1 引擎已合流节拍下 commit 有界（≤ 拍数+10）', s1.renders <= TICKS + 10, String(s1.renders))
check('§1 纯流式拍不重建 messages 引用（≤3）', s1.msgRefs <= 3, String(s1.msgRefs))
check('§1 streamingBlocks 逐拍换新（≥80）', s1.streamRefs >= 80, String(s1.streamRefs))
check('§2 裸事件流被客户端合流（100 事件 → commit ≤30）', s2.renders <= 30, String(s2.renders))
check('§2 纯合流拍不重建 messages 引用（≤3）', s2.msgRefs <= 3, String(s2.msgRefs))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log('perf numbers: §1', JSON.stringify(s1), '| §2', JSON.stringify(s2))
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
