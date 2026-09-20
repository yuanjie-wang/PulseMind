/**
 * Chat streaming performance probe (PLAN-long-task-perf M0-T1) — the plan's
 * number judge.
 *
 * Mounts the REAL ChatView inside the real AppLayout (probe-chat-deliverables'
 * recipe: real components, stubbed bridge, no Electron / LLM / extension) and
 * drives two scenarios the 2026-09-20 卡顿 report points at:
 *
 *   ① a 500-message long conversation plus a 1000-tick simulated stream —
 *      every tick appends text to the live streaming block, so the cost that
 *      grows with the answer's length (the A4 suspicion) is actually grown;
 *   ② five parallel experts: five spawn tool_use blocks whose tool_status
 *      patches land staggered (the mirror's patch cadence), which rebuilds one
 *      message object per patch and forces the transcript to regroup (the B1/B3
 *      renderer half).
 *
 * Measurements, and what each CAN and CANNOT say:
 *   - CDP Profiler (sampling, 100µs) over each scenario → self-hit counts per
 *     function and per module (chat / react / antd / x-markdown / highlighter).
 *     The harness bundle is NOT minified, so function names survive.
 *   - an in-page rAF gap recorder → frame gaps (p50/p95/max) while the work
 *     runs; a long task shows up as one long gap.
 *   - PerformanceObserver('longtask') → count and worst duration > 50ms.
 *   - performance.memory.usedJSHeapSize before load / after load / after the
 *     stream, plus a byte-share breakdown of the fixture itself by block kind
 *     (text / thinking / tool_use.input / tool_result) — the cheap stand-in for
 *     a full heap snapshot (M0-T3's composition question: which category
 *     dominates the growth).
 *
 * The probe never modifies product code; everything rides CDP or the harness's
 * own state setters.
 *
 * Usage: node scripts/probe-chat-stream-perf.mjs [--headed] [--ticks N] [--dump]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-stream-perf-')), 'harness.js')

const CONV_KEY = 'conv_20260920100000'
const WS = '/pm-probe-ws'
const AT = '2026-09-20T10:00:00.000Z'
const TICKS = Number(process.env.TICKS || (process.argv.includes('--ticks') ? process.argv[process.argv.indexOf('--ticks') + 1] : 1000))

// ── the 500-message fixture ──────────────────────────────────────────────────
// A realistic long task: short user turns, assistant answers of 0.5–3KB,
// thinking blocks, and tool rounds whose results run 1–8KB — plus ~1% 200KB
// monsters (the per-block output cap is 200k chars, so these are in-family).
// Built IN THE HARNESS (it must live in the page's heap for the memory story).
const FIXTURE_JS = `
const AT = '${AT}'
const msg = (id, role, blocks) => ({ id, role, contentBlocks: blocks, createdAt: AT })
const text = (s) => ({ type: 'text', text: s })
const think = (s) => ({ type: 'thinking', thinking: s })
const toolUse = (id, name, input, extra) => ({ type: 'tool_use', id, name, input, status: 'completed', exitCode: 0, ...extra })
const toolResult = (id, s) => ({ type: 'tool_result', tool_use_id: id, content: s })
const WORD = '性能测量填充词句，'
const fill = (n) => WORD.repeat(Math.ceil(n / WORD.length)).slice(0, n)

function buildFixture() {
  const out = []
  for (let i = 0; i < 125; i++) {
    // user turn
    out.push(msg('u' + i, 'user', [text('第' + i + '轮：' + fill(40))]))
    // assistant: thinking + prose (size cycles 0.5–3KB)
    const prose = fill(600 + (i % 5) * 500)
    out.push(msg('a' + i, 'assistant', [think(fill(1500)), text(prose)]))
    // a tool round: read + write, results 1–8KB
    out.push(msg('t' + i + 'a', 'assistant', [
      toolUse('tu' + i + 'r', 'read', { file_path: '${WS}/src/file' + i + '.ts' }),
      toolUse('tu' + i + 'w', 'write', { file_path: '${WS}/out/report-' + i + '.md', content: fill(800) }),
    ]))
    out.push(msg('t' + i + 'r', 'user', [
      toolResult('tu' + i + 'r', fill(1200)),
      toolResult('tu' + i + 'w', 'ok'),
    ]))
    // every 100th round carries a 200KB monster result (the cap's own scale)
    if (i % 100 === 99) {
      out.push(msg('m' + i + 'a', 'assistant', [toolUse('mu' + i, 'read', { file_path: '${WS}/logs/huge-' + i + '.log' })]))
      out.push(msg('m' + i + 'r', 'user', [toolResult('mu' + i, fill(200000))]))
    }
  }
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

  window.__load = () => {
    setMessages(buildFixture())
    setStatus({ status: 'idle' })
    setStreamingBlocks([])
    return true
  }
  window.__beginStream = () => {
    setStreamingBlocks([{ type: 'text', text: '开始长回答：' }])
    setStatus({ status: 'streaming' })
    return true
  }
  // One coalesced tick: append to the streaming text block. A NEW array each
  // time — the engine's streamingBlocks behave the same way, and the memo deps
  // key off the reference.
  window.__tick = (chars) => {
    setStreamingBlocks((prev) => [{ type: 'text', text: (prev[0]?.text ?? '') + chars }])
    return true
  }
  // Scenario ②: patch ONE of the five spawn tool_use blocks — a new message and
  // a new block object (the mirror's identity contract), longer output each time.
  window.__patchExpert = (slot, chars) => {
    setMessages((prevMsgs) => prevMsgs.map((m) => {
      if (m.id !== 'spawn-host') return m
      return {
        ...m,
        contentBlocks: m.contentBlocks.map((b) => {
          if (b.type !== 'tool_use' || b.id !== 'spawn-' + slot) return b
          return { ...b, output: ((b.output ?? '') + chars).slice(-200000) }
        }),
      }
    }))
    return true
  }
  window.__endStream = (finalText) => {
    setMessages((m) => [...m, { id: 'a-final', role: 'assistant', contentBlocks: [{ type: 'text', text: finalText }], createdAt: AT }])
    setStreamingBlocks([])
    setStatus({ status: 'completed' })
    return true
  }
  // Byte share of the fixture by block kind — M0-T3's composition answer at
  // the data level (what dominates the growth), not a heap-snapshot parse.
  window.__fixtureShare = () => {
    let all = 0
    const byKind = {}
    for (const m of window.__messages()) {
      for (const b of m.contentBlocks) {
        const n = JSON.stringify(b).length
        all += n
        const kind = b.type === 'tool_use' ? 'tool_use' : b.type === 'tool_result' ? 'tool_result' : b.type === 'thinking' ? 'thinking' : 'text'
        byKind[kind] = (byKind[kind] ?? 0) + n
      }
    }
    return { totalBytes: all, byKind, messages: window.__messages().length }
  }
  window.__messages = () => messages
  window.__heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)

  // ── the drivers (run in-page; Node only reads the results) ──
  window.__installRecorder = () => {
    const rec = { gaps: [], longtasks: [], obs: null, raf: 0, last: 0, on: false }
    const loop = (t) => {
      if (!rec.on) return
      rec.gaps.push(t - rec.last)
      rec.last = t
      rec.raf = requestAnimationFrame(loop)
    }
    window.__rec = rec
    window.__recStart = () => {
      rec.gaps.length = 0
      rec.longtasks.length = 0
      rec.on = true
      rec.last = performance.now()
      rec.raf = requestAnimationFrame(loop)
      rec.obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) rec.longtasks.push(e.duration)
      })
      rec.obs.observe({ entryTypes: ['longtask'] })
    }
    window.__recStop = () => {
      rec.on = false
      cancelAnimationFrame(rec.raf)
      rec.obs?.disconnect()
      const gaps = rec.gaps.slice(2) // drop the first frames (recorder warm-up)
      gaps.sort((a, b) => a - b)
      const q = (p) => gaps.length ? Math.round(gaps[Math.floor(gaps.length * p)] * 10) / 10 : null
      const lt = [...rec.longtasks].sort((a, b) => b - a)
      return {
        frames: gaps.length,
        gapP50: q(0.5), gapP95: q(0.95), gapMax: gaps.length ? Math.round(gaps[gaps.length - 1] * 10) / 10 : null,
        longtasks: lt.length, longtaskMax: lt.length ? Math.round(lt[0]) : 0,
      }
    }
    return true
  }
  window.__runStream = async ({ ticks, intervalMs, charsPerTick }) => {
    window.__recStart()
    window.__beginStream()
    const t0 = performance.now()
    const chunk = '流式输出的每拍字符，'
    // Per-tick LOOP period (setTimeout cadence + render). Once the render cost
    // exceeds intervalMs the period IS the cost — this series is the growth
    // curve the A4 suspicion asks for (parse cost grows with the answer).
    const periods = new Array(ticks)
    let last = performance.now()
    for (let i = 0; i < ticks; i++) {
      window.__tick(chunk.repeat(Math.ceil(charsPerTick / chunk.length)).slice(0, charsPerTick))
      if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs))
      const now = performance.now()
      periods[i] = now - last
      last = now
    }
    const streamMs = Math.round(performance.now() - t0)
    const pct = (arr) => {
      const ss = [...arr].sort((a, b) => a - b)
      return { avg: Math.round(ss.reduce((a, b) => a + b, 0) / ss.length * 10) / 10, p95: Math.round(ss[Math.floor(ss.length * 0.95)] * 10) / 10 }
    }
    const tickHead = pct(periods.slice(0, 100))
    const tickTail = pct(periods.slice(-100))
    // The settle: the full answer lands as a message, the streaming tail goes.
    const t1 = performance.now()
    window.__endStream(fill(Math.min(ticks * charsPerTick, 24000)))
    await new Promise((r) => setTimeout(r, 300))
    const settleMs = Math.round(performance.now() - t1)
    const frames = window.__recStop()
    return { streamMs, settleMs, finalChars: ticks * charsPerTick, tickHead, tickTail, ...frames }
  }
  window.__runPatches = async ({ patches, intervalMs }) => {
    window.__recStart()
    const t0 = performance.now()
    const chunk = '专家增量输出，'
    for (let i = 0; i < patches; i++) {
      window.__patchExpert(i % 5, chunk)
      if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs))
    }
    const wallMs = Math.round(performance.now() - t0)
    await new Promise((r) => setTimeout(r, 200))
    const frames = window.__recStop()
    return { wallMs, patches, ...frames }
  }
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
        streamingBlocks={streamingBlocks}
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

// The five spawn blocks scenario ② patches live in ONE message near the tail.
window.__installSpawnHost = () => {
  window.__messagesBeforeHost = null
  return true
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider>
    <SettingsProvider>
      <TranslationProvider initialLocale="zh">
        <Harness />
      </TranslationProvider>
    </SettingsProvider>
  </ConfigProvider>
)
`

// Scenario ②'s host message: the harness's __load builds the fixture, then the
// driver appends the spawn-host message through __patchExpert's own pathway —
// simplest is to add it via a dedicated evaluate that mutates through __load's
// fixture builder output. The harness exposes __load only, so the host message
// is folded into the fixture build here: patch AFTER load via a second load.
const HARNESS_FINAL = HARNESS.replace(
  'window.__load = () => {\n    setMessages(buildFixture())',
  `window.__load = () => {
    const fx = buildFixture()
    // the five spawn blocks scenario ② patches (status updates on the wire)
    fx.push(msg('spawn-host', 'assistant', Array.from({ length: 5 }, (_, s) =>
      toolUse('spawn-' + s, 'spawn_agent', { task: '专家' + s, }, { subConvId: 'sub_' + s }))))
    setMessages(fx)`,
)

await build({
  stdin: { contents: HARNESS_FINAL, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  // Deliberately NO minify: the Profiler's function-name attribution is the
  // whole point (A2/A4 suspect names must survive the bundle).
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// Before the bundle: AppLayout reads electronAPI at module scope
// (probe-chat-deliverables' stub).
await page.route('http://pm-perf.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><script>
window.electronAPI = new Proxy({
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
  </script></head><body style="margin:0"><div id="root" style="height:900px"></div></body></html>`,
}))
await page.goto('http://pm-perf.local/')
await page.addStyleTag({ path: OUT.replace(/harness\.js$/, 'harness.css') }).catch(() => {})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => typeof window.__load === 'function')
await page.evaluate(() => window.__installRecorder())
await page.waitForFunction(() => document.querySelectorAll('#root div').length > 3)
await page.waitForTimeout(400) // let the welcome mount settle

const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 100 })

const results = { ticks: TICKS }

// ── fixture composition (M0-T3's data-level answer) ──────────────────────────
console.log('\n=== 场景准备：500 消息夹具 ===')
await page.evaluate(() => window.__load())
await page.waitForFunction(() => (window.__messages()?.length ?? 0) > 500)
const share = await page.evaluate(() => window.__fixtureShare())
const heapAfterLoad = await page.evaluate(() => window.__heap())
console.log(`夹具：${share.messages} 条消息，内容字节 ${(share.totalBytes / 1048576).toFixed(2)} MB`)
for (const [kind, n] of Object.entries(share.byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(12)} ${(n / 1048576).toFixed(2)} MB  (${Math.round((n / share.totalBytes) * 100)}%)`)
}
console.log(`JS 堆（加载后）：${heapAfterLoad} MB`)
results.fixture = { ...share, heapAfterLoad }

async function profiled(name, fn) {
  await cdp.send('Profiler.start')
  const r = await fn()
  const { profile } = await cdp.send('Profiler.stop')
  // Self-hit attribution: node hitCount → its own callFrame only. The bundle is
  // one file, so URL attribution is useless — names are the story.
  const byFn = new Map()
  let total = 0
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0
    if (hits <= 0) continue
    total += hits
    const fname = node.callFrame.functionName || '(anonymous)'
    byFn.set(fname, (byFn.get(fname) ?? 0) + hits)
  }
  // Inclusive hits for the hot names: who is `clone` (or groupMessages) actually
  // working FOR? Tree walk with a write-before-recurse guard.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const node of profile.nodes) {
    for (const c of node.children ?? []) parent.set(c, node.id)
  }
  const inclusiveMemo = new Map()
  const inclusive = (id) => {
    if (inclusiveMemo.has(id)) return inclusiveMemo.get(id)
    const node = byId.get(id)
    let sum = node ? (node.hitCount ?? 0) : 0
    inclusiveMemo.set(id, 0)
    for (const c of node?.children ?? []) sum += inclusive(c)
    inclusiveMemo.set(id, sum)
    return sum
  }
  const inclusiveOf = (fname) => {
    let sum = 0
    for (const node of profile.nodes) {
      if ((node.callFrame.functionName || '(anonymous)') === fname) sum += inclusive(node.id)
    }
    return sum
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)
  const hotNames = [...new Set(['groupMessages', 'buildSegments', 'matchSegment', 'estimateContextUsed', 'collectTurnDeliverables', ...top.slice(0, 6).map(([f]) => f)])]
  const inclusiveRows = hotNames.map((f) => ({ fn: f, self: byFn.get(f) ?? 0, incl: inclusiveOf(f) })).sort((a, b) => b.incl - a.incl).slice(0, 10)
  // Callers of the top self-name: its sampled parents' frames.
  const callersOf = (fname, depth = 3) => {
    // Aggregate sampled hits of `fname` by their ancestor frames at each depth.
    const out = []
    for (const node of profile.nodes) {
      if ((node.callFrame.functionName || '(anonymous)') !== fname) continue
      let id = node.id
      for (let d = 0; d < depth; d++) {
        const p = byId.get(parent.get(id))
        const pname = p ? (p.callFrame.functionName || '(anonymous)') : '(root)'
        ;(out[d] ??= new Map()).set(pname, (out[d].get(pname) ?? 0) + (node.hitCount ?? 0))
        id = p ? p.id : id
      }
    }
    return out.map((m, di) => ({ depth: di + 1, rows: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) }))
  }
  const hotSelf = top[0]?.[0]
  const callers = new Map()
  if (hotSelf) {
    for (const node of profile.nodes) {
      if ((node.callFrame.functionName || '(anonymous)') !== hotSelf) continue
      const p = byId.get(parent.get(node.id))
      const pname = p ? (p.callFrame.functionName || '(anonymous)') : '(root)'
      callers.set(pname, (callers.get(pname) ?? 0) + (node.hitCount ?? 0))
    }
  }
  return { r, total, top, inclusiveRows, callers: [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6), hotSelf, sanitizeCallers: callersOf('DOMPurify.sanitize', 4) }
}

const printTop = (top, total) => {
  for (const [fn, hits] of top) {
    console.log(`  ${(hits / total * 100).toFixed(2).padStart(6)}%  ${hits.toString().padStart(6)}  ${fn}`)
  }
}
const printInclusive = (rows, total) => {
  for (const { fn, self, incl } of rows) {
    console.log(`  incl ${(incl / total * 100).toFixed(1).padStart(5)}%  self ${(self / total * 100).toFixed(2).padStart(5)}%  ${fn}`)
  }
}

// ── scenario ①: the long stream ──────────────────────────────────────────────
console.log('\n=== 场景① 长会话 + 1000 拍流式 ===')
await page.evaluate(() => { window.__load(); return true })
await page.waitForFunction(() => (window.__messages()?.length ?? 0) > 500)
await page.waitForTimeout(300)
const heapBeforeStream = await page.evaluate(() => window.__heap())
const s1 = await profiled('stream', () => page.evaluate(async (ticks) => {
  // 8ms cadence: the per-tick cost is what we measure; the engine's real
  // cadence is 80ms (NOTIFY_COALESCE_MS) — noted in the report, not simulated,
  // so the whole stream fits the probe's runtime while per-tick work is unchanged.
  return window.__runStream({ ticks, intervalMs: 8, charsPerTick: 20 })
}, TICKS))
const heapAfterStream = await page.evaluate(() => window.__heap())
console.log(`流式 wall=${s1.r.streamMs}ms  落定 settle=${s1.r.settleMs}ms  终稿 ${s1.r.finalChars} 字符`)
console.log(`每拍周期：前 100 拍 avg=${s1.r.tickHead.avg}ms/p95=${s1.r.tickHead.p95}ms  →  后 100 拍 avg=${s1.r.tickTail.avg}ms/p95=${s1.r.tickTail.p95}ms  （增长曲线）`)
console.log(`帧间隙 p50=${s1.r.gapP50}ms  p95=${s1.r.gapP95}ms  max=${s1.r.gapMax}ms  (frames=${s1.r.frames})`)
console.log(`长任务(>50ms) n=${s1.r.longtasks}  最长=${s1.r.longtaskMax}ms`)
console.log(`JS 堆：流前 ${heapBeforeStream} MB → 流后 ${heapAfterStream} MB`)
console.log('函数自采样占比 top:')
printTop(s1.top, s1.total)
console.log('inclusive（含子调用）top:')
printInclusive(s1.inclusiveRows, s1.total)
console.log(`热点「${s1.hotSelf}」的调用方:`)
for (const [f, n] of s1.callers) console.log(`  ${n}  ${f}`)
console.log('DOMPurify.sanitize 的调用链（深1→4）:')
for (const lvl of s1.sanitizeCallers) console.log(`  深度${lvl.depth}: ${lvl.rows.map(([f, n]) => `${f}(${n})`).join(' ← ')}`)
results.stream = { ...s1.r, heapBeforeStream, heapAfterStream, top: s1.top.slice(0, 12), inclusive: s1.inclusiveRows }

// ── scenario ②: five parallel experts' tool_status patches ───────────────────
console.log('\n=== 场景② 5 专家并行 tool_status patch ===')
await page.evaluate(() => { window.__load(); return true })
await page.waitForFunction(() => (window.__messages()?.length ?? 0) > 500)
await page.waitForTimeout(300)
const s2 = await profiled('patches', () => page.evaluate(() => window.__runPatches({ patches: 600, intervalMs: 8 })))
console.log(`patch wall=${s2.r.wallMs}ms  n=${s2.r.patches}`)
console.log(`帧间隙 p50=${s2.r.gapP50}ms  p95=${s2.r.gapP95}ms  max=${s2.r.gapMax}ms  (frames=${s2.r.frames})`)
console.log(`长任务(>50ms) n=${s2.r.longtasks}  最长=${s2.r.longtaskMax}ms`)
console.log('函数自采样占比 top:')
printTop(s2.top, s2.total)
console.log('inclusive（含子调用）top:')
printInclusive(s2.inclusiveRows, s2.total)
console.log(`热点「${s2.hotSelf}」的调用方:`)
for (const [f, n] of s2.callers) console.log(`  ${n}  ${f}`)
results.patches = { ...s2.r, top: s2.top.slice(0, 12), inclusive: s2.inclusiveRows }

console.log('\n（说明）每拍渲染成本不随拍间隔变化，因此 8ms 档测得的每拍成本即 80ms 档的每拍成本；帧间隙绝对值不可直接搬进 80ms 档。')

await browser.close()
console.log('\nDONE — 数字回填 _task/20260920/PLAN-long-task-perf.md §一/M0')
