/**
 * TranscriptView scroll-jank probe (real Chromium).
 *
 * 报告：「在和助手聊天时，感觉对话区上下滚动有卡顿」。转录区（chat/TranscriptView）
 * 是任务助手 / 专家创建助手 / 工具工作室 / 例行运行记录共用的那一个组件，它按
 * 设计依赖 `React.memo`：message-segments 的结构共享缓存把未变段落的对象身份
 * 留住（message-segments.ts 的注释原话「cached segment objects keep their
 * identity so React.memo can skip them」），MessageGroup / ExecutionSegment 也
 * 都套了 memo。这套设计有个前提——**传下去的 props 身份必须稳定**。
 *
 * 助手宿主（FormAssistColumn）每次都传新箭头函数：
 *
 *     onApproveTool={(id, alwaysAllow) => session.engineCall('approveTool', id, alwaysAllow === true)}
 *
 * 于是每个流式片段都换了整套 props，memo 全失效 → 整条对话的 Markdown / 工具卡
 * 一起重渲染。流式期间引擎是**每帧**同步一次镜像（useConversationEngine 的
 * rAF flushActiveSync），主线程因此被「重渲染 + XMarkdown 重解析」挤满，
 * 用户摸到的就是滚动卡（静止时滚同一条对话并不卡）。
 *
 * 探针用生产 TranscriptView 跑同一段时序，量两件事：
 *   A. 一次流式 chunk 的**同步渲染成本**（flushSync 包住一次 __chunk，计时）。
 *      这是判别性判据：旧实现里它随对话条数线性增长（整条对话重渲染），修好后只与
 *      「增长中的那一段」有关。校准值（本机，22 条消息）：inline 12.45ms → 1.64ms，
 *      stable 2.37ms → 2.09ms；阈值 ×1.6 落在两态之间，红了就是 memo 又被打破。
 *   B. 流式期间连续滚动的 rAF 帧间隔（p50/p95/max、>50ms 帧、longtask）。
 *      这是真实性下限而不是判别器——vsync 量化后帧间隔只有 16.7ms 一档，单次 chunk
 *      只要还没吃掉整帧余量，帧间隔就看不出来（旧实现 12.4ms 的 chunk 在快机器上
 *      照样凑在 16.7ms 里）。它钉的是真实几何（460px 栏 + 圆角裁切壳）下不掉帧、
 *      无长任务。
 * 三种形状：静止（纯绘制基线）/ 流式 + 稳定 handler / 流式 + 每次新箭头。每个窗口
 * 前重开一条干净对话——流式正文会在窗口间累积，不重置会让最后测的形状白吃亏。
 *
 * 判据：助手宿主形状（inline）的 A 必须回到稳定 handler 的水平——两者之间的差只该
 * 来自「多两个箭头函数」，不该来自「整条对话重渲染」。
 *
 * No Electron, no LLM calls: `window.electronAPI` is stubbed, the page is plain.
 *
 * Usage: node scripts/probe-transcript-perf.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-tperf-')), 'harness.js')
const NOW = '2026-09-21T10:00:00.000Z'

const HARNESS = `
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'

installThemeVars()
applyThemeAttr('light')
window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(undefined) })

const NOW = '${NOW}'
const user = (id, text) => ({ id, role: 'user', content: '', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const assistant = (id, text) => ({ id, role: 'assistant', content: '', contentBlocks: [{ type: 'text', text }], createdAt: NOW })

/** One long markdown answer with a fenced block: the real shape of a turn —
 *  prose plus a highlighted code block, ~300px of column height. */
const longAnswer = (topic, n) => Array.from({ length: n }, (_, i) =>
  topic + '第' + (i + 1) + '段：' + '这是一段足够换行两次的正文内容，用来把这条消息撑到一屏可见的高度。'.repeat(6)
).join('\\n\\n') + '\\n\\n\\u0060\\u0060\\u0060ts\\nconst value = ' + n + '\\nfunction pick(list) { return list.slice(0, 2) }\\n\\u0060\\u0060\\u0060'

const state = { messages: [], agentStatus: { status: 'idle' }, streamingBlocks: [] }
let streamed = ''

/** Module scope on purpose: stable identity is one of the two shapes under test. */
const handlers = {
  onApproveTool: () => {},
  onRejectTool: () => {},
  onKillTool: () => {},
  onPromoteTool: () => {},
  onRespondToTool: () => {},
  onClearError: () => {},
  onRetry: () => {},
}

let shape = 'stable'

function Harness() {
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)

  /** 'inline' = FormAssistColumn's exact shape: a fresh arrow per render. */
  const wired = shape === 'inline'
    ? {
        onApproveTool: (id, alwaysAllow) => handlers.onApproveTool(id, alwaysAllow === true),
        onRejectTool: (id) => handlers.onRejectTool(id),
        onKillTool: (id) => handlers.onKillTool(id),
        onPromoteTool: (id) => handlers.onPromoteTool(id),
        onRespondToTool: (id, response) => handlers.onRespondToTool(id, response),
      }
    : {
        onApproveTool: handlers.onApproveTool,
        onRejectTool: handlers.onRejectTool,
        onKillTool: handlers.onKillTool,
        onPromoteTool: handlers.onPromoteTool,
        onRespondToTool: handlers.onRespondToTool,
      }

  window.__hydrate = (count) => {
    state.messages = Array.from({ length: count }, (_, i) =>
      i % 2 === 0 ? user('h' + i, '问题 ' + i) : assistant('h' + i, longAnswer('历史回答' + i + '。', 3))
    )
    state.agentStatus = { status: 'idle' }
    state.streamingBlocks = []
    streamed = ''
    rerender()
  }
  window.__setShape = (next) => { shape = next; rerender() }
  /** One streamed delta, flushed synchronously so its cost is measurable here
   *  (the real engine schedules the same render on the rAF mirror flush). */
  window.__chunkTimed = (text) => {
    streamed += text
    state.agentStatus = { status: 'streaming' }
    state.streamingBlocks = [{ type: 'text', text: streamed }]
    const t0 = performance.now()
    flushSync(() => rerender())
    return performance.now() - t0
  }
  window.__settle = () => {
    state.messages = [...state.messages, assistant('a' + state.messages.length, streamed)]
    state.agentStatus = { status: 'idle' }
    state.streamingBlocks = []
    streamed = ''
    rerender()
  }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        {/* The assistant column's real geometry: 460px wide flex column whose
            only scrollable child is the transcript (EDITOR_CHAT_CARD), sitting
            inside the wizard's rounded clipping shell (EDITOR_ASSIST_SHELL:
            overflow hidden + radius 8). */}
        <div style={{ width: 484, margin: '0 auto', overflow: 'hidden', borderRadius: 8, border: '1px solid #e6e6e6', background: '#fff' }}>
          <div data-pm-probe-col style={{ display: 'flex', flexDirection: 'column', width: 460, height: 640, background: '#fff', fontFamily: 'system-ui' }}>
            <TranscriptView
              messages={state.messages}
              agentStatus={state.agentStatus}
              streamingBlocks={state.streamingBlocks}
              isRequesting={state.agentStatus.status !== 'idle'}
              restoring={state.messages.length === 0}
              contentInset={0}
              {...wired}
              onClearError={handlers.onClearError}
              onRetry={handlers.onRetry}
            />
          </div>
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
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

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE =
  '<!doctype html><html><head><style>#root *,#root *::before,#root *::after{animation:none!important;transition:none!important}</style></head><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(200)

await page.evaluate(() => window.__hydrate(22))
await page.waitForTimeout(400)

const CRUMB = '追加的一段流式正文，模拟真实 token delta 的提交节奏：它落到正在增长的那一段里。'.repeat(2)

/** Cost of ONE streamed chunk (sync render + commit) at the current shape. */
const chunkCost = (shape, reps = 12) =>
  page.evaluate(
    async ({ shape, CRUMB, reps }) => {
      window.__setShape(shape)
      await new Promise((r) => requestAnimationFrame(r))
      const out = []
      for (let i = 0; i < reps; i++) {
        out.push(window.__chunkTimed(CRUMB))
        await new Promise((r) => requestAnimationFrame(r))
      }
      const sorted = [...out].sort((a, b) => a - b)
      return {
        mean: +(out.reduce((a, b) => a + b, 0) / out.length).toFixed(2),
        p50: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        max: +sorted[sorted.length - 1].toFixed(2),
      }
    },
    { shape, CRUMB, reps },
  )

/**
 * Scroll the transcript for a fixed window, pumping one streamed chunk per
 * frame (the engine's own cadence: one rAF mirror flush per frame), and report
 * frame deltas + long tasks.
 */
const scrollWindow = ({ shape, stream, ms = 2400 }) =>
  page.evaluate(
    async ({ shape, stream, ms, CRUMB }) => {
      window.__setShape(shape)
      await new Promise((r) => requestAnimationFrame(r))
      const scroller = document.querySelector('[data-pm-probe-col]').firstElementChild
      scroller.scrollTop = 0

      const long = []
      let po = null
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) long.push(e.duration)
        })
        po.observe({ entryTypes: ['longtask'] })
      } catch {
        /* longtask unsupported: frames still tell the story */
      }

      const frames = []
      let chunks = 0
      let last = performance.now()
      const t0 = performance.now()
      let dir = 1
      while (performance.now() - t0 < ms) {
        if (stream) {
          window.__chunkTimed(CRUMB)
          chunks++
        }
        scroller.scrollTop += 36 * dir
        const max = scroller.scrollHeight - scroller.clientHeight
        if (scroller.scrollTop >= max) dir = -1
        if (scroller.scrollTop <= 0) dir = 1
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        frames.push(now - last)
        last = now
      }
      po?.disconnect()

      const sorted = [...frames].sort((a, b) => a - b)
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      return {
        frames: frames.length,
        chunks,
        p50: +q(0.5).toFixed(1),
        p95: +q(0.95).toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
        over50: frames.filter((d) => d > 50).length,
        long: long.length,
      }
    },
    { shape, stream, ms, CRUMB },
  )

const show = (label, m) =>
  console.log(
    `  ${label.padEnd(24)}` +
      `frames=${String(m.frames).padStart(3)}  p50=${String(m.p50).padStart(5)}ms  p95=${String(m.p95).padStart(6)}ms  ` +
      `max=${String(m.max).padStart(6)}ms  >50ms=${String(m.over50).padStart(2)}  longtask=${String(m.long).padStart(2)}`,
  )

console.log('\nA. 一次流式 chunk 的同步渲染成本（22 条消息，其中一条在增长）')
const costStable = await chunkCost('stable')
console.log(`  稳定 handler                mean=${costStable.mean}ms  p50=${costStable.p50}ms  max=${costStable.max}ms`)
const costInline = await chunkCost('inline')
console.log(`  每次新箭头（助手宿主形状）  mean=${costInline.mean}ms  p50=${costInline.p50}ms  max=${costInline.max}ms`)
const costRatio = costStable.mean > 0 ? costInline.mean / costStable.mean : 0
check(
  '每次新箭头不放大单次 chunk 的渲染成本',
  costRatio < 1.6,
  `inline mean=${costInline.mean}ms vs stable mean=${costStable.mean}ms（×${costRatio.toFixed(2)}）`,
)

await page.evaluate(() => window.__hydrate(22))
await page.waitForTimeout(300)

console.log('\nB. 流式期间连续滚动的帧预算（每帧一个 chunk）')
// 每个窗口前重开一条干净的对话：上一窗积累的流式正文会留在 state 里（__chunkTimed
// 只往 streamed 追加），不重置的话后测的形状天然吃亏——第一版正因此把「最后测的
// inline」读数顶高了 3.7ms，看上去像没修好。
const freshThread = async () => {
  await page.evaluate(() => window.__hydrate(22))
  await page.waitForTimeout(250)
}
await freshThread()
const idle = await scrollWindow({ shape: 'stable', stream: false })
show('静止滚动（纯绘制基线）', idle)
await freshThread()
const stable = await scrollWindow({ shape: 'stable', stream: true })
show('流式 + 稳定 handler', stable)
await freshThread()
const inline = await scrollWindow({ shape: 'inline', stream: true })
show('流式 + 每次新箭头', inline)

check('静止滚动的 p95 在 2 帧以内（纯绘制基线）', idle.p95 < 34, `p95=${idle.p95}ms max=${idle.max}ms`)
check(
  '助手宿主形状不在流式滚动里打穿帧预算',
  inline.p95 < stable.p95 * 1.6 + 6 && inline.over50 <= Math.max(2, stable.over50),
  `inline p95=${inline.p95}ms vs stable p95=${stable.p95}ms，>50ms 帧 ${inline.over50} vs ${stable.over50}`,
)
check('流式期间确有内容增长（测量本身有效）', inline.chunks > 60 && inline.frames > 60, `chunks=${inline.chunks} frames=${inline.frames}`)

await page.screenshot({ path: join(process.cwd(), '_probe_out', 'transcript-perf.png') }).catch(() => {})
await browser.close()

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
