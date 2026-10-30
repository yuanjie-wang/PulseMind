/**
 * Chat scroll × workbench pane probe (real Chromium) — 2026-10-30 用户报告
 * 「打开右侧边窗口时，上下滚动会话，滚动条的刷新不及时」的数字判官。
 *
 * 真实 AppLayout + ChatView（probe-chat-stream-perf 的配方：真组件、stub 桥、
 * 无 Electron/LLM），500 条消息夹具；CDP `Input.dispatchMouseEvent(mouseWheel)`
 * 发真实滚轮事件连续上下滚动，页内 rAF 记录器量主线程帧间隙 + longtask +
 * 每帧 scrollTop 位移，另有「空闲帧 layout 读代价 / 强制重排代价 / 滚动时刻
 * scrollHeight 读代价」三枚诊断。默认场景：窗格关 / 开而无文件 / 开且预览
 * 800 行代码（真实预览路径）/ 后者 + 流式输出中。
 *
 * 症状的机制：Markdown 正文与滚动条都靠主线程刷新，主线程一卡，合成器滚动的
 * 内容照走、滚动条拇指停住再追。所以帧间隙就是这条症状的直接度量，而本轮
 * 实测的主线程代价落点不是 layout（强制重排 0.2ms）也不是 JS（自采样 ≈0），
 * 而是 PaintArtifactCompositor::Update / Layerize（每次 ~258ms）——见根因条目。
 *
 * 根因（--variants 可复现）：react-syntax-highlighter 在 wrapLongLines 下强制
 * wrapLines=true，且 wrapLongLines + showLineNumbers 时给「每一行」的 span 加
 * display:flex。窄预览列（树 180px 旁的 ~240px）里每个 token 被块化成独立 flex
 * item：空白文本被吞（`exportconst`）、注释溢出到右侧、一行涨到 150px 的空白行；
 * 800 条溢出的 flex 行让每次会话滚动都重付一次全页 Layerize。修法是把行样式
 * 换成 block + 悬挂缩进（CodeHighlight.tsx 的 lineStyle），--variants 的
 * sh-flex（修复前形态，恒卡）与 ch-*（产物路径，恒顺）即正反对照。
 *
 * Usage: node scripts/probe-chat-scroll-pane.mjs [--headed] [--seconds N] [--trace]
 *        [--variants] [--experiments] [--shots]
 *   --trace       在预览场景里跑 CDP Tracing（主线程阶段聚合 + Paint 事件）
 *   --variants    独立 240px 盒里的 DOM 形态扫描（正反对照）
 *   --experiments 二分实验（隐藏树列 / 隐藏预览 / 暂停动画）
 *   --shots       截图到 tmp（库默认 flex 行 vs 真实预览路径）
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-scroll-pane-')), 'harness.js')
const CONV_KEY = 'conv_20261030100000'
const WS = '/pm-probe-ws'
const TS_PATH = `${WS}/src/pipeline.ts`
const SHORT_PATH = `${WS}/src/short.ts`
const AT = '2026-10-30T10:00:00.000Z'
const SECONDS = Number(process.argv.includes('--seconds') ? process.argv[process.argv.indexOf('--seconds') + 1] : 2)

/** ~800 行 TS 供预览（用户的审阅场景：代码文件 + 行号）；短文件 12 行作对照。 */
const TS = Array.from({ length: 800 }, (_, i) => `export const filler_${i + 1}: number = ${i + 1} // padding line to give the file real height`).join('\n')
const SHORT_TS = Array.from({ length: 12 }, (_, i) => `export const s_${i + 1} = ${i + 1}`).join('\n')

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
    out.push(msg('u' + i, 'user', [text('第' + i + '轮：' + fill(40))]))
    const prose = fill(600 + (i % 5) * 500) + '\\n\\n\`\`\`ts\\nconst x_' + i + ' = ' + i + '\\n\`\`\`\\n'
    out.push(msg('a' + i, 'assistant', [think(fill(1500)), text(prose)]))
    out.push(msg('t' + i + 'a', 'assistant', [
      toolUse('tu' + i + 'r', 'read', { file_path: '${WS}/src/file' + i + '.ts' }),
      toolUse('tu' + i + 'w', 'write', { file_path: '${WS}/out/report-' + i + '.md', content: fill(800) }),
    ]))
    out.push(msg('t' + i + 'r', 'user', [toolResult('tu' + i + 'r', fill(1200)), toolResult('tu' + i + 'w', 'ok')]))
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
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { CodeHighlight } from './src/renderer/src/components/common/CodeHighlight'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
const TS_PATH = '${TS_PATH}'
const SHORT_PATH = '${SHORT_PATH}'
${FIXTURE_JS}

function Harness() {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState([])
  window.__load = () => { setMessages(buildFixture()); setStatus({ status: 'idle' }); setStreamingBlocks([]); return true }
  window.__beginStream = () => { setStreamingBlocks([{ type: 'text', text: '开始长回答：' }]); setStatus({ status: 'streaming' }); return true }
  window.__tick = (chars) => { setStreamingBlocks((prev) => [{ type: 'text', text: (prev[0]?.text ?? '') + chars }]); return true }
  window.__endStream = () => { setStreamingBlocks([]); setStatus({ status: 'idle' }); return true }
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

window.__openPane = (withFile) => {
  useWorkbenchStore.getState().openTab(CONV_KEY, 'workspace')
  if (withFile) usePreviewPaneStore.getState().openFile(CONV_KEY, withFile === 'short' ? SHORT_PATH : TS_PATH)
  return true
}
window.__closePane = () => { useWorkbenchStore.getState().setOpen(CONV_KEY, false); return true }

// ── DOM-shape variants, mounted in a fixed right-side box (the pane's stand-in) ──
const LINES = 800
const LINE = (i) => 'export const filler_' + i + ': number = ' + i + ' // padding line to give the file real height'
let variantRoot = null
window.__unmountVariant = () => {
  if (variantRoot) { variantRoot.unmount(); variantRoot = null }
  document.getElementById('pm-variant')?.remove()
  return true
}
window.__mountVariant = (kind, width = 420) => {
  window.__unmountVariant()
  const box = document.createElement('div')
  box.id = 'pm-variant'
  box.style.cssText = 'position:fixed;right:0;top:0;width:' + width + 'px;height:100%;overflow:auto;background:#fff;border-left:1px solid #ddd;z-index:30'
  document.body.appendChild(box)
  const code = Array.from({ length: LINES }, (_, i) => LINE(i + 1)).join('\\n')
  if (kind === 'pre-plain') {
    box.innerHTML = '<pre style="margin:0;padding:12px;white-space:pre-wrap;font-size:12px">' + code.replace(/</g, '&lt;') + '</pre>'
  } else if (kind === 'pre-tokens') {
    const html = Array.from({ length: LINES }, (_, i) => '<span style="color:#a626a4">export</span> <span style="color:#a626a4">const</span> <span style="color:#383a42">filler_' + (i + 1) + '</span><span style="color:#0184bc">:</span> <span style="color:#e45649">number</span> = <span style="color:#986801">' + (i + 1) + '</span> <span style="color:#a0a1a7">// padding line to give the file real height</span>').join('\\n')
    box.innerHTML = '<pre style="margin:0;padding:12px;white-space:pre-wrap;font-size:12px"><code>' + html + '</code></pre>'
  } else if (kind === 'pre-tokens-gutter') {
    const gutter = Array.from({ length: LINES }, (_, i) => '<span style="display:inline-block;min-width:2.25em;padding-right:1em;text-align:right;user-select:none">' + (i + 1) + '</span>').join('\\n')
    const html = Array.from({ length: LINES }, (_, i) => '<span style="color:#a626a4">export</span> <span style="color:#a626a4">const</span> filler_' + (i + 1) + ' = <span style="color:#986801">' + (i + 1) + '</span> <span style="color:#a0a1a7">// padding line</span>').join('\\n')
    box.innerHTML = '<pre style="margin:0;padding:12px;white-space:pre-wrap;font-size:12px"><code style="float:left;padding-right:10px">' + gutter + '</code><code>' + html + '</code></pre>'
  } else if (kind === 'sh-flex' || kind === 'sh-nowrap' || kind === 'sh-block') {
    // Raw PrismLight shapes (languages registered by the CodeHighlight import):
    // sh-flex = the library's own wrapLongLines + showLineNumbers rendering
    // (display:flex per line — what CodeHighlight produced before 2026-10-30),
    // sh-block = the hanging-indent block rows CodeHighlight now hands over,
    // sh-nowrap = the alternative fix that was not taken (horizontal scroll).
    variantRoot = createRoot(box)
    const common = { language: 'typescript', style: oneLight, PreTag: 'div', showLineNumbers: true,
      customStyle: { margin: 0, padding: 12, fontSize: 12 }, codeTagProps: { style: { fontSize: 12, lineHeight: 1.6 } } }
    const GUTTER = '4.25em'
    const blockLine = { display: 'block', paddingLeft: GUTTER, textIndent: '-' + GUTTER }
    if (kind === 'sh-flex') variantRoot.render(<SyntaxHighlighter {...common} wrapLongLines>{code}</SyntaxHighlighter>)
    else if (kind === 'sh-block') variantRoot.render(<SyntaxHighlighter {...common} wrapLongLines lineProps={{ style: blockLine }}>{code}</SyntaxHighlighter>)
    else variantRoot.render(<SyntaxHighlighter {...common} wrapLongLines={false}>{code}</SyntaxHighlighter>)
  } else {
    // real CodeHighlight: kind = 'ch' | 'ch-nolines'
    variantRoot = createRoot(box)
    variantRoot.render(<CodeHighlight code={code} lang="typescript" lineNumbers={kind === 'ch'} />)
  }
  return true
}
// Cost of one FULL relayout: dirty the root, then force a read.
window.__layoutCost = () => {
  const root = document.getElementById('root')
  root.style.paddingTop = root.style.paddingTop ? '' : '1px'
  const t0 = performance.now()
  void document.body.offsetHeight
  const dirty = performance.now() - t0
  const t1 = performance.now()
  void document.body.offsetHeight
  const clean = performance.now() - t1
  return { fullRelayoutMs: Math.round(dirty * 10) / 10, cleanReadMs: Math.round(clean * 100) / 100 }
}
// Over N idle frames: how much does a layout read cost each frame? Non-zero
// means something dirtied layout between frames.
window.__idleFrames = (n) => new Promise((resolve) => {
  const costs = []
  const step = () => {
    const t0 = performance.now()
    void document.body.offsetHeight
    costs.push(Math.round((performance.now() - t0) * 10) / 10)
    if (costs.length < n) requestAnimationFrame(step)
    else resolve({ max: Math.max(...costs), over5ms: costs.filter((c) => c > 5).length, costs: costs.slice(0, 12) })
  }
  requestAnimationFrame(step)
})
// Capture-phase scroll listener (runs before React's handler): the forced
// layout a scroll handler's scrollHeight read pays at that moment.
window.__scrollCosts = []
document.addEventListener('scroll', (e) => {
  const el = e.target
  if (!el || !el.scrollHeight) return
  const t0 = performance.now()
  void el.scrollHeight
  window.__scrollCosts.push(Math.round((performance.now() - t0) * 10) / 10)
}, true)
window.__takeScrollCosts = () => { const c = window.__scrollCosts; window.__scrollCosts = []; const s = [...c].sort((a, b) => b - a); return { n: c.length, max: s[0] ?? 0, over20ms: c.filter((x) => x > 20).length, top: s.slice(0, 6) } }
window.__paneOpen = () => !!useWorkbenchStore.getState().openByConversation[CONV_KEY]

// The chat scroller: the overflow:auto ancestor of a transcript anchor.
window.__scroller = () => {
  const anchor = document.querySelector('[id^="chat-msg-"]')
  let el = anchor
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return null
}
window.__scrollerGeom = () => {
  const el = window.__scroller()
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: Math.round(r.width), clientWidth: el.clientWidth, offsetWidth: el.offsetWidth, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
}

// rAF recorder: frame gaps, longtasks, per-frame scrollTop.
window.__installRecorder = () => {
  const rec = { gaps: [], longtasks: [], tops: [], obs: null, raf: 0, last: 0, on: false, scrollEvents: 0 }
  const loop = (t) => {
    if (!rec.on) return
    rec.gaps.push(t - rec.last)
    rec.last = t
    const el = window.__scroller()
    rec.tops.push(el ? el.scrollTop : -1)
    rec.raf = requestAnimationFrame(loop)
  }
  window.__rec = rec
  window.__recStart = () => {
    rec.gaps.length = 0; rec.longtasks.length = 0; rec.tops.length = 0; rec.scrollEvents = 0
    rec.on = true; rec.last = performance.now(); rec.raf = requestAnimationFrame(loop)
    rec.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) rec.longtasks.push(e.duration) })
    rec.obs.observe({ entryTypes: ['longtask'] })
    rec.onScroll = () => { rec.scrollEvents += 1 }
    document.addEventListener('scroll', rec.onScroll, true)
  }
  window.__recStop = () => {
    rec.on = false; cancelAnimationFrame(rec.raf); rec.obs?.disconnect()
    document.removeEventListener('scroll', rec.onScroll, true)
    const gaps = rec.gaps.slice(2)
    const sorted = [...gaps].sort((a, b) => a - b)
    const q = (p) => sorted.length ? Math.round(sorted[Math.floor(sorted.length * p)] * 10) / 10 : null
    const lt = [...rec.longtasks].sort((a, b) => b - a)
    // Frames whose gap exceeded 50ms = visible scrollbar stalls (3+ refreshes).
    const stalls = gaps.filter((g) => g > 50).length
    // Largest single-frame scrollTop jump — content that moved while the main
    // thread was away (composited scroll outran the main-thread scrollbar).
    let maxJump = 0
    for (let i = 3; i < rec.tops.length; i++) maxJump = Math.max(maxJump, Math.abs(rec.tops[i] - rec.tops[i - 1]))
    const travel = rec.tops.length ? Math.abs(rec.tops[rec.tops.length - 1] - rec.tops[2]) : 0
    return { frames: gaps.length, gapP50: q(0.5), gapP95: q(0.95), gapMax: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
      stalls, longtasks: lt.length, longtaskMax: lt.length ? Math.round(lt[0]) : 0, maxJumpPx: Math.round(maxJump), scrollEvents: rec.scrollEvents, netTravelPx: Math.round(travel) }
  }
  return true
}
// Streaming ticker for the 流式 scenarios.
window.__streamOn = () => {
  window.__beginStream()
  const chunk = '流式输出的每拍字符，'
  window.__ticker = setInterval(() => window.__tick(chunk), 80)
  return true
}
window.__streamOff = () => { clearInterval(window.__ticker); window.__endStream(); return true }

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
page.on('console', (m) => { if (m.text().startsWith('[tree]')) console.log('  ' + m.text()) })
await page.route('http://pm-scroll.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><style>
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.6); }
    </style><script>
    const TS = ${JSON.stringify(TS)};
    const SHORT_TS = ${JSON.stringify(SHORT_TS)};
    const WS = ${JSON.stringify(WS)};
    const dirs = {
      [WS]: { entries: [
        { name: 'src', path: WS + '/src', isDir: true },
        { name: 'out', path: WS + '/out', isDir: true },
        { name: 'README.md', path: WS + '/README.md', isDir: false },
        { name: 'package.json', path: WS + '/package.json', isDir: false },
      ] },
      [WS + '/src']: { entries: Array.from({ length: 30 }, (_, i) => ({ name: 'file' + i + '.ts', path: WS + '/src/file' + i + '.ts', isDir: false })).concat([{ name: 'pipeline.ts', path: WS + '/src/pipeline.ts', isDir: false }]) },
      [WS + '/out']: { entries: Array.from({ length: 20 }, (_, i) => ({ name: 'report-' + i + '.md', path: WS + '/out/report-' + i + '.md', isDir: false })) },
    };
    window.electronAPI = new Proxy({
      readFile: (p) => Promise.resolve(p === ${JSON.stringify(TS_PATH)} ? TS : p === ${JSON.stringify(SHORT_PATH)} ? SHORT_TS : 'probe file body'),
      statPath: () => Promise.resolve(null),
      listDir: (d) => Promise.resolve(dirs[d] ?? { entries: [] }),
      agentSessionEngineCall: () => Promise.resolve([]),
    }, {
      get: (target, key) => key in target ? target[key]
        : key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
        : key === 'getSettings' ? () => Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: true, locale: 'zh' })
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root" style="height:900px"></div></body></html>`,
}))
await page.goto('http://pm-scroll.local/')
await page.addStyleTag({ path: OUT.replace(/harness\.js$/, 'harness.css') }).catch(() => {})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => typeof window.__load === 'function')
await page.evaluate(() => window.__installRecorder())
await page.waitForFunction(() => document.querySelectorAll('#root div').length > 3)
await page.waitForTimeout(400)
await page.evaluate(() => window.__load())
await page.waitForFunction(() => (window.__count?.() ?? 0) >= 500)
await page.waitForTimeout(1500) // landing pin settles

const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连续滚轮：先上后下，各 SECONDS 秒，~90 事件/s × 80px。 */
async function wheelBurst(geom, dir, seconds) {
  const until = Date.now() + seconds * 1000
  let n = 0
  while (Date.now() < until) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geom.x, y: geom.y, deltaX: 0, deltaY: dir * 80 })
    n += 1
    await sleep(8)
  }
  return n
}

async function measure(label, { pane, streaming, profile = false, trace = false, experiment = null, variant = null }) {
  // pane: false | 'none' (open, no file) | 'short' | 'long'
  if (pane) await page.evaluate((f) => window.__openPane(f === 'none' ? null : f), pane)
  else await page.evaluate(() => window.__closePane())
  await page.waitForTimeout(800)
  if (pane === 'long') await page.waitForFunction(() => document.querySelectorAll('.react-syntax-highlighter-line-number').length > 100, null, { timeout: 5000 }).catch(() => console.log('  [warn] preview line numbers not seen'))
  let expLabel = null
  if (experiment) { expLabel = await page.evaluate(experiment.apply); if (!expLabel) throw new Error('experiment apply failed: ' + label) }
  if (variant) { await page.evaluate(([k, w]) => window.__mountVariant(k, w), Array.isArray(variant) ? variant : [variant, 420]); await page.waitForTimeout(900) }
  if (streaming) await page.evaluate(() => window.__streamOn())
  await page.waitForTimeout(300)
  // Park mid-history first so both directions have room (the lazy-load
  // boundary is a product cost of its own; keep it out of the A/B).
  const geom = await page.evaluate(() => window.__scrollerGeom())
  if (!geom) throw new Error('scroller not found')
  await page.evaluate(() => { const el = window.__scroller(); el.scrollTop = Math.max(0, el.scrollHeight / 2) })
  await page.waitForTimeout(400)
  // Layout diagnostics BEFORE the burst (idle).
  const idle = await page.evaluate(() => window.__idleFrames(30))
  const cost1 = await page.evaluate(() => window.__layoutCost())
  const cost2 = await page.evaluate(() => window.__layoutCost())
  await page.evaluate(() => window.__takeScrollCosts())
  if (profile) await cdp.send('Profiler.start')
  const traceEvents = []
  let onTrace = null
  if (trace) {
    onTrace = (ev) => { for (const e of ev.value) traceEvents.push(e) }
    cdp.on('Tracing.dataCollected', onTrace)
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,blink.user_timing', transferMode: 'ReportEvents' })
  }
  await page.evaluate(() => window.__recStart())
  const up = await wheelBurst(geom, -1, SECONDS)
  const down = await wheelBurst(geom, 1, SECONDS)
  const stats = await page.evaluate(() => window.__recStop())
  const scrollCosts = await page.evaluate(() => window.__takeScrollCosts())
  if (experiment) await page.evaluate(experiment.undo)
  if (variant) await page.evaluate(() => window.__unmountVariant())
  let traceSummary = null
  if (trace) {
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r))
    await cdp.send('Tracing.end')
    await done
    cdp.off('Tracing.dataCollected', onTrace)
    // Complete events on the renderer main thread, aggregated by name.
    const byName = new Map()
    const longest = []
    for (const e of traceEvents) {
      if (e.ph !== 'X' || typeof e.dur !== 'number') continue
      const ms = e.dur / 1000
      const cur = byName.get(e.name) ?? { n: 0, ms: 0, max: 0 }
      cur.n += 1; cur.ms += ms; cur.max = Math.max(cur.max, ms)
      byName.set(e.name, cur)
      if (ms > 40) longest.push({ name: e.name, ms: Math.round(ms), args: JSON.stringify(e.args ?? {}).slice(0, 160) })
    }
    const paints = traceEvents.filter((e) => e.name === 'Paint' && e.ph === 'X').map((e) => JSON.stringify({ clip: e.args?.data?.clip, nodeId: e.args?.data?.nodeId, layerId: e.args?.data?.layerId, dur: Math.round(e.dur / 100) / 10 }))
    traceSummary = {
      top: [...byName.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).map(([name, v]) => ({ name, n: v.n, ms: Math.round(v.ms), max: Math.round(v.max) })),
      longest: longest.sort((a, b) => b.ms - a.ms).slice(0, 4),
      paints: [...new Set(paints)].slice(0, 8),
    }
  }
  let prof = null
  if (profile) {
    const { profile: p } = await cdp.send('Profiler.stop')
    const byFn = new Map()
    let total = 0
    for (const node of p.nodes) {
      const hits = node.hitCount ?? 0
      if (!hits) continue
      total += hits
      const name = node.callFrame.functionName || '(anonymous)'
      byFn.set(name, (byFn.get(name) ?? 0) + hits)
    }
    prof = { total, top: [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) }
  }
  if (streaming) await page.evaluate(() => window.__streamOff())
  const after = await page.evaluate(() => window.__scrollerGeom())
  console.log(`\n=== ${label} ===`)
  console.log(`  滚动器宽 ${geom.width}px scrollHeight ${geom.scrollHeight} → ${after?.scrollHeight}`)
  console.log(`  空闲 30 帧 layout 读：max ${idle.max}ms，>5ms 帧 ${idle.over5ms}；整页强制重排：${cost1.fullRelayoutMs}ms / ${cost2.fullRelayoutMs}ms（干净读 ${cost1.cleanReadMs}ms）`)
  console.log(`  滚轮事件 上${up} 下${down}；页内 scroll 事件 ${stats.scrollEvents}；scroll 时刻 scrollHeight 强制读：n=${scrollCosts.n} max ${scrollCosts.max}ms >20ms ${scrollCosts.over20ms} top ${JSON.stringify(scrollCosts.top)}`)
  console.log(`  rAF 帧 ${stats.frames}：gap p50 ${stats.gapP50}ms  p95 ${stats.gapP95}ms  max ${stats.gapMax}ms；>50ms 停顿帧 ${stats.stalls}`)
  console.log(`  longtask ${stats.longtasks} 个（最长 ${stats.longtaskMax}ms）；单帧最大 scrollTop 跳变 ${stats.maxJumpPx}px；净位移 ${stats.netTravelPx}px`)
  if (prof) {
    console.log(`  Profiler 自采样 ${prof.total} 次，Top：`)
    for (const [name, hits] of prof.top) console.log(`    ${String(hits).padStart(5)}  ${name}`)
  }
  if (traceSummary) {
    console.log(`  Tracing（主线程 complete 事件按名聚合，ms 总 / 次数 / 单次最大）：`)
    for (const t of traceSummary.top) console.log(`    ${String(t.ms).padStart(6)}ms  n=${String(t.n).padStart(4)}  max ${String(t.max).padStart(4)}ms  ${t.name}`)
    console.log(`  最长单事件（>40ms）：`)
    for (const l of traceSummary.longest) console.log(`    ${String(l.ms).padStart(4)}ms  ${l.name}  ${l.args}`)
    console.log(`  Paint 事件（去重）：`)
    for (const p of traceSummary.paints) console.log(`    ${p}`)
  }
  return stats
}

// ── experiments (applied in page after the pane opens, undone after the burst) ──
// The bisect that led to the root cause, kept runnable: `--experiments` shows
// the tree column and the preview area are BOTH needed for the stall (hiding
// either one alone restores 16.7ms frames), and the animation in the tree is
// NOT the cause (pausing it changes nothing).
const EXP_HIDE_TREE = {
  apply: () => { const el = document.querySelector('[data-pm-tree-column]'); if (el) el.style.display = 'none'; return !!el },
  undo: () => { const el = document.querySelector('[data-pm-tree-column]'); if (el) el.style.display = '' },
}
const EXP_HIDE_PREVIEW = {
  apply: () => { const el = document.querySelector('[data-pm-tree-column]')?.nextElementSibling; if (el) el.style.display = 'none'; return !!el },
  undo: () => { const el = document.querySelector('[data-pm-tree-column]')?.nextElementSibling; if (el) el.style.display = '' },
}
const EXP_PAUSE_ANIMS = {
  apply: () => { const a = document.getAnimations(); a.forEach((x) => x.pause()); return a.length || 'none' },
  undo: () => { document.getAnimations().forEach((x) => x.play()) },
}

const results = {}
if (process.argv.includes('--shots')) {
  const { mkdirSync } = await import('node:fs')
  const dir = join(tmpdir(), 'pm-scroll-shots'); mkdirSync(dir, { recursive: true })
  // 库默认 flex 行（修复前形态）与真实预览路径（修复后）各一张。
  await page.evaluate(() => window.__openPane(null)); await page.waitForTimeout(600)
  await page.evaluate(() => window.__mountVariant('sh-flex', 240)); await page.waitForTimeout(900)
  await page.screenshot({ path: join(dir, 'lib-flex-240.png'), clip: { x: 1440 - 240, y: 0, width: 240, height: 420 } })
  await page.evaluate(() => window.__unmountVariant())
  await page.evaluate(() => window.__openPane('long')); await page.waitForTimeout(1200)
  await page.screenshot({ path: join(dir, 'real-preview-420.png'), clip: { x: 1440 - 420, y: 0, width: 420, height: 420 } })
  console.log('shots →', dir)
  await browser.close(); process.exit(0)
}
if (process.argv.includes('--experiments')) {
  results.openLong = await measure('B2 窗格开 · 800 行预览（对照）', { pane: 'long', streaming: false })
  results.hideTree = await measure('X1 B2 + 隐藏目录树列', { pane: 'long', streaming: false, experiment: EXP_HIDE_TREE })
  results.hidePreview = await measure('X2 B2 + 隐藏预览区', { pane: 'long', streaming: false, experiment: EXP_HIDE_PREVIEW })
  results.pauseAnims = await measure('X3 B2 + 暂停全部动画', { pane: 'long', streaming: false, experiment: EXP_PAUSE_ANIMS })
} else if (process.argv.includes('--variants')) {
  // DOM-shape sweep in a stand-alone 240px box (the real preview column's width
  // beside a 180px tree): what exactly inflates the layerize.
  results.pre240 = await measure('V1 纯文本 pre-wrap @240px', { pane: 'none', streaming: false, variant: ['pre-plain', 240] })
  results.tok240 = await measure('V2 pre + token span @240px', { pane: 'none', streaming: false, variant: ['pre-tokens', 240] })
  results.chNo240 = await measure('V3 CodeHighlight 无行号 @240px', { pane: 'none', streaming: false, variant: ['ch-nolines', 240] })
  results.ch420 = await measure('V4 CodeHighlight 带行号 @420px（不换行）', { pane: 'none', streaming: false, variant: ['ch', 420] })
  results.ch240 = await measure('V5 CodeHighlight 带行号 @240px（当前产物）', { pane: 'none', streaming: false, variant: ['ch', 240] })
  results.flex240 = await measure('V6 库默认 flex 行 @240px（修复前形态，对照）', { pane: 'none', streaming: false, variant: ['sh-flex', 240] })
  results.nowrap240 = await measure('V7 关 wrapLongLines（浮动行号列）@240px', { pane: 'none', streaming: false, variant: ['sh-nowrap', 240] })
} else {
  // The real path: closed / open without a file / open with the 800-line preview.
  results.closedIdle = await measure('A 窗格关 · 空闲', { pane: false, streaming: false })
  results.openNone = await measure('B0 窗格开 · 无文件', { pane: 'none', streaming: false })
  results.openLong = await measure('B2 窗格开 · 800 行代码预览（真实预览路径）', { pane: 'long', streaming: false, trace: process.argv.includes('--trace') })
  results.openLongStream = await measure('D 窗格开 · 800 行预览 · 流式输出中', { pane: 'long', streaming: true })
  results.closedIdle2 = await measure('A2 窗格关 · 空闲（复测）', { pane: false, streaming: false })
}

console.log('\n=== 汇总（p95 / max / 停顿帧 / longtask）===')
for (const [k, s] of Object.entries(results)) {
  console.log(`  ${k.padEnd(14)} p95 ${String(s.gapP95).padStart(6)}ms  max ${String(s.gapMax).padStart(7)}ms  stalls ${String(s.stalls).padStart(3)}  longtasks ${String(s.longtasks).padStart(3)} (${s.longtaskMax}ms)`)
}

if (!process.argv.includes('--headed')) await browser.close()
else console.log('\n(headed) 浏览器保持打开，Ctrl+C 退出')
