/**
 * TranscriptView follow-the-tail probe (real Chromium).
 *
 * 几个内置助手（任务助手 / 专家创建助手共用的 FormAssistColumn、工具工作室、
 * 例行运行记录、子代理会话视图）的对话区全部是 chat/TranscriptView——它们的
 * 「随消息输出自动滚动」就是这一个组件的滚动行为，而它是不是跟手取决于滚动
 * 容器何时长高、scrollTop 何时被写：布局事实，jsdom 看不见，读源码也裁判不了。
 *
 * 探针按真实时序驱动生产 TranscriptView：
 *   1. 历史一次性落地（运行记录 / 子代理会话恢复、新会话首次 hydrate）→ 必须落到末尾，
 *      并在后续高度增长中钉住（XMarkdown 首帧渲染 null，代码块/图片更晚才撑高）；
 *   2. 流式逐块输出，每块一次加高 > 80px（一整段 markdown 的真实形状）——旧实现
 *      在提交「之后」才测量 nearBottom，第一块就把视口甩出阈值、整轮停止跟随，
 *      正是「内置助手不会自动滚动」的报告；跟随标志必须只由 scroll 事件写；
 *   3. 用户上滚 → 不再被拽回底部；滚回底部 → 恢复跟随；
 *   4. 回合收尾后，一张晚到的图片把内容再撑高 → 收尾钉住必须兜住它。
 *
 * No Electron, no LLM calls, no extension: `window.electronAPI` is stubbed and
 * the page is plain, so this cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-transcript-scroll.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-tscroll-')), 'harness.js')

const NOW = '2026-09-21T10:00:00.000Z'

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'

// main.tsx's boot, in order: the variable sheet, then the attribute — the
// transcript's migrated surfaces read var(--pm-*), and an unset variable
// resolves to nothing, so a probe without the sheet is measuring a page the
// app never renders.
installThemeVars()
applyThemeAttr('light')

// The transcript reaches for electronAPI while rendering (FileRefChip stats a
// file's creation time); every call resolves to undefined, which every caller tolerates.
window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(undefined) })

const NOW = '${NOW}'
const user = (id, text) => ({ id, role: 'user', content: '', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const assistant = (id, text) => ({ id, role: 'assistant', content: '', contentBlocks: [{ type: 'text', text }], createdAt: NOW })

/** One long markdown answer: three paragraphs ≈ 150+ px of column height. */
const longAnswer = (topic, n) => Array.from({ length: n }, (_, i) =>
  topic + '第' + (i + 1) + '段：' + '这是一段足够换行两次的正文内容，用来把这条消息撑到一屏可见的高度。'.repeat(6)
).join('\\n\\n')

/** The one state object, exactly as useConversationEngine keeps it, plus the
 *  handlers — held at module scope on purpose: a fresh arrow per render would
 *  hand the memoized views new props and mask identity bugs. */
const state = {
  messages: [],
  agentStatus: { status: 'idle' },
  streamingBlocks: [],
}
let streamed = ''
let streamSeq = 0

const handlers = {
  approve: () => {},
  reject: () => {},
  kill: () => {},
  respond: () => {},
  clearError: () => {},
  retry: () => {},
}

function Harness() {
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)

  // History landing in ONE commit — a run record / sub-agent session restore,
  // or a form assistant's 新会话 first hydrate.
  window.__hydrate = (count) => {
    state.messages = Array.from({ length: count }, (_, i) =>
      i % 2 === 0 ? user('h' + i, '问题 ' + i) : assistant('h' + i, longAnswer('历史回答' + i + '。', 3))
    )
    rerender()
  }
  // The composer send: user message appended while the view follows.
  window.__send = (text) => {
    state.messages = [...state.messages, user('u' + state.messages.length, text)]
    rerender()
  }
  // One streamed delta — the chunk sizes below deliberately exceed the
  // near-bottom threshold in one commit, the shape that broke measuring
  // after the commit.
  window.__chunk = (text) => {
    streamed += text
    state.agentStatus = { status: 'streaming' }
    state.streamingBlocks = [{ type: 'text', text: streamed }]
    rerender()
  }
  // The turn ends: the streamed text lands as a real message, status settles.
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
        {/* The assistant column's shape: a fixed-height flex column whose only
            scrollable descendant is the transcript itself. */}
        <div className="pm-probe-col" style={{ display: 'flex', flexDirection: 'column', width: 1000, height: 560, margin: '0 auto', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={state.messages}
            agentStatus={state.agentStatus}
            streamingBlocks={state.streamingBlocks}
            isRequesting={state.agentStatus.status !== 'idle'}
            restoring={state.messages.length === 0}
            onApproveTool={handlers.approve}
            onRejectTool={handlers.reject}
            onKillTool={handlers.kill}
            onRespondToTool={handlers.respond}
            onClearError={handlers.clearError}
            onRetry={handlers.retry}
          />
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
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// A real http origin rather than setContent: an opaque about:blank origin denies the
// localStorage access the stores behind the transcript reach for. The one route
// serves the deliberately LATE image (600ms) from section 4.
// The motion kill is the same sheet probe-theme-dark injects, scoped the same way
// (inside #root only — antd portals its dropdown/menu motion to <body>, and a
// document-wide kill leaves the open animation stuck so the menu never becomes
// visible): the transcript now plays entrance/collapse micro-animations
// (chat/motion.tsx), and getComputedStyle reports MID-ANIMATION values — a box
// measured during the 0.22s entrance would fail these geometry checks on the
// animation, not on the code under test.
const PAGE = '<!doctype html><html><head><style>#root *,#root *::before,#root *::after{animation:none!important;transition:none!important}</style></head><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => {
  if (route.request().url().endsWith('late.svg')) {
    setTimeout(() => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="800" height="300" fill="#dde6f0"/></svg>',
    }), 600)
    return
  }
  route.fulfill({ contentType: 'text/html', body: PAGE })
})
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

/** The transcript is the flex column's only scrollable child. */
const scroller = () => page.evaluate(() => {
  const el = document.querySelector('.pm-probe-col').firstElementChild
  return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }
})
const tailVisible = (text) => page.getByText(text).first().isVisible().catch(() => false)
const wheel = async (deltaY) => {
  const box = await page.locator('.pm-probe-col').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(120)
}
const chunkText = (i) => `流式输出第${i}块。` + '这是流式增量里的一整段内容，单块高度必须超过自动滚动的判定阈值。'.repeat(6)

// ── 1. 历史一次性落地：恢复的会话必须落到末尾并钉住 ──
{
  console.log('== 历史落地 ==')
  await page.evaluate(() => window.__hydrate(6))
  await page.waitForTimeout(700)
  const m = await scroller()
  check('恢复后视口在末尾（真的滚动过，不是零高度）', m.gap === 0 && m.top > 0, `gap=${m.gap} top=${Math.round(m.top)}`)
  check('最后一条消息可见', await tailVisible('历史回答5。第3段'))
}

// ── 2. 流式逐块输出：每块 >80px 也要块块贴底（旧实现在第一块就断跟） ──
{
  console.log('== 流式跟随 ==')
  await page.evaluate(() => window.__send('帮我写一份调研提纲'))
  await page.waitForTimeout(120)
  check('发送后仍在底部', (await scroller()).gap === 0)
  for (let i = 1; i <= 5; i++) {
    await page.evaluate((t) => window.__chunk(t), chunkText(i))
    await page.waitForTimeout(80)
    const m = await scroller()
    check(`第${i}块落地后贴底（gap=0，含底部 padding）`, m.gap === 0, `gap=${m.gap}`)
  }
  check('最新内容就在视口里', await tailVisible('流式输出第5块'))
}

// ── 3. 用户上滚不被拽回；滚回底部后恢复跟随 ──
{
  console.log('== 用户上滚 ==')
  await wheel(-600)
  const before = await scroller()
  check('上滚后离开了底部', before.gap > 300, `gap=${before.gap}`)
  for (let i = 6; i <= 7; i++) {
    await page.evaluate((t) => window.__chunk(t), chunkText(i))
    await page.waitForTimeout(80)
  }
  const during = await scroller()
  check('继续输出时视口停在原地（没有被拽回）', Math.abs(during.top - before.top) <= 2 && during.gap > 100,
    `top ${Math.round(before.top)}→${Math.round(during.top)} gap=${during.gap}`)
  await wheel(6000)
  check('滚回底部', (await scroller()).gap === 0)
  await page.evaluate((t) => window.__chunk(t), chunkText(8))
  await page.waitForTimeout(80)
  check('回底之后恢复自动跟随', (await scroller()).gap === 0, `gap=${(await scroller()).gap}`)
}

// ── 4. 收尾后晚到的图片：收尾钉住必须兜住提交之后的高度增长 ──
{
  console.log('== 收尾钉住 ==')
  await page.evaluate(() => window.__chunk('最后附一张示意图：\\n\\n![late](http://pm-probe.local/late.svg)'))
  await page.waitForTimeout(80)
  await page.evaluate(() => window.__settle())
  // The img element commits with the settle render but only LOADS 600ms later —
  // height grows after the last React commit, where the per-commit snap is deaf.
  await page.waitForTimeout(1600)
  const m = await scroller()
  check('图片加载撑高后仍贴底', m.gap === 0, `gap=${m.gap}`)
  check('图片已渲染', await page.locator('.pm-probe-col img').first().isVisible().catch(() => false))
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
