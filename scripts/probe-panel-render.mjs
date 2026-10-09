/**
 * Real-browser render of the extension panel (PLAN-browser-extension M1.2).
 *
 * The panel's look cannot be unit-tested and cannot be reviewed from source:
 * jsdom has no layout engine and no Shadow-DOM cascade, and loading the built
 * extension into the user's Chrome would kick the session they have connected.
 * So this probe mounts the *real* `Transcript` + `Composer` components with the
 * *real* stylesheets — ui/styles.css plus @ant-design/x-markdown/themes/light.css,
 * the two <style> elements content/index.tsx injects, in the same order — inside
 * a Shadow Root, with fixture sessions covering every block the transcript can
 * render, and writes screenshots to a temp dir for eyeballing against the
 * desktop chat.
 *
 * It also asserts the geometry that is the whole point of the alignment (theme
 * applied inside the shadow root, wide table scrolls instead of clipping, panel
 * 380px, message column not overflowing) — the facts a value-by-value copy can
 * still get wrong.
 *
 * Usage: node scripts/probe-panel-render.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-panel-probe-')), 'harness.js')
/** Stable path (not mkdtemp) so the printed screenshots are easy to reopen and
 *  can be compared against the desktop chat side by side. */
const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-panel-shots')
mkdirSync(SHOTS, { recursive: true })

/** Luminance gap below which text is effectively the same colour as its
 *  backdrop. Deliberately small: the chat's own muted text (the #aaa thinking
 *  preview, the #bbb token counts, the #ddd stats divider) is intentional and
 *  copied verbatim, so this guards against *invisible* text — the failure a
 *  missed `color` on a dark card produces — not against low contrast. */
const INVISIBLE_DELTA = 25

/** The 模型下拉 inventory — the shape session.list carries (id/name/provider/
 *  providerName/model, no credentials). The second profile has deliberately no
 *  name, and a long model id: the shared modelLabel falls back to
 *  'provider:model' for it, which is also what exercises the label's truncation
 *  instead of assuming it. Both profiles carry a providerName so the two label
 *  forms genuinely diverge: the collapsed BUTTON shows the bare modelLabel (the
 *  footer row is too tight for the 供应商 prefix — user ruling 2026-10-08),
 *  and menu items are bare modelLabel as well — the group header names the
 *  provider; fullModelLabel survives only as the hover title.
 *
 *  Declared out here (not inside the harness) so the checks below can name the
 *  fallback label; interpolated into the harness as data. */
const MODEL = {
  profiles: [
    { id: 'p1', name: 'GPT-4o', provider: 'openai', providerName: 'OpenAI', model: 'gpt-4o' },
    { id: 'p2', provider: 'deepseek', providerName: 'DeepSeek 官方', model: 'deepseek-chat-with-a-deliberately-long-name' },
  ],
  activeId: 'p1',
}
const FALLBACK_LABEL = 'deepseek:deepseek-chat-with-a-deliberately-long-name'

/** The harness is inline (esbuild stdin) so this probe stays one file. It
 *  imports the production components — a copy here would prove nothing. */
const HARNESS = `
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import panelStyles from './src/extension/ui/styles.css'
import xMarkdownTheme from '@ant-design/x-markdown/themes/light.css'
import { Transcript } from './src/extension/ui/Transcript'
import { Composer } from './src/extension/ui/Composer'
import { Icon } from './src/extension/ui/icons'
import { App } from './src/extension/ui/App'
import { DEFAULT_APPROVAL_MODE } from './src/shared/sandbox/policy'

const NOW = '2026-09-15T10:00:00.000Z'
const text = (t) => ({ type: 'text', text: t })
const noop = () => {}

const MARKDOWN = [
  '# 页面摘要',
  '',
  '这是一个 **示例页面**，包含 \`inline code\` 与 [链接](https://example.com)。',
  '',
  '## 关键点',
  '',
  '- 第一条',
  '- 第二条',
  '  - 嵌套的一条',
  '- 第三条',
  '',
  '| 字段 | 值 | 说明 |',
  '|:--|:-:|--:|',
  '| 标题 | 示例 | https://example.com/docs/getting-started/installation/configuration/providers |',
  '| 语言 | zh | 检测结果 |',
  '',
  '> 引用块也一起看。',
  '',
  '\`\`\`js',
  'const a = { b: 1 }',
  'console.log(a)',
  '\`\`\`',
].join('\\n')

/** One message carrying every assistant block kind, so a single screenshot
 *  shows the whole ladder: thinking (collapsed + redacted), markdown, a
 *  successful tool, a failed tool, a skipped tool, and the action row. */
const ASSISTANT = {
  id: 'm2',
  role: 'assistant',
  createdAt: NOW,
  processingMs: 8421,
  inputTokens: 12043,
  outputTokens: 986,
  promptCacheHitTokens: 4096,
  contentBlocks: [
    { type: 'thinking', thinking: '先读页面，再归纳要点。工具返回的内容里有一段比较长的说明文字，用来检查预览是否按预期截断。' },
    text(MARKDOWN),
    { type: 'tool_use', id: 't1', name: 'page_get_content', status: 'completed', exitCode: 0, input: {}, output: '已读取 128 个节点' },
    { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
    { type: 'tool_use', id: 't2', name: 'exec', status: 'completed', exitCode: 1, input: { command: 'npm run build' }, output: 'error TS2307: 找不到模块' },
    { type: 'tool_result', tool_use_id: 't2', content: 'error TS2307', is_error: true },
    { type: 'tool_use', id: 't3', name: 'page_click', status: 'rejected', input: { index: 12, description: '点击提交按钮' } },
    { type: 'tool_result', tool_use_id: 't3', content: 'skipped', is_error: false },
    { type: 'redacted_thinking', data: 'x' },
  ],
}

const USER = { id: 'm1', role: 'user', contentBlocks: [text('总结这个页面')], createdAt: NOW }

/** The turn's FINAL answer — text-only, after the tools are done. The chat gives
 *  the action row to THIS message only (SegmentBlock hides the narration's row
 *  because an execution segment follows it), so the panel's fixture must end the
 *  same way: narration + tool cards carry no row, this one does. */
const FINAL = {
  id: 'm3',
  role: 'assistant',
  createdAt: NOW,
  processingMs: 5120,
  inputTokens: 15120,
  outputTokens: 1311,
  contentBlocks: [text('要点就三条：页面主体是文档，目录在左侧，示例代码集中在第三节。')],
}

const shell = (session, extra) => ({ messages: [], streamingBlocks: [], plan: null, historySummary: null, agentStatus: { status: 'idle' }, ...session, ...extra })

/** The 模型下拉 inventory — the shape session.list carries (id/name/provider/model,
 *  no credentials). The second profile has deliberately no name, and a long model
 *  id: the shared modelLabel falls back to 'provider:model' for it, which is also
 *  what exercises the label's truncation instead of assuming it. */
const MODEL = ${JSON.stringify(MODEL)}
const FALLBACK_LABEL = ${JSON.stringify(FALLBACK_LABEL)}

/** Five panels side by side: the main transcript, an approval hold, an
 *  ask_user question, the error/empty states, and an in-flight turn. The error
 *  one gets no model — a panel that has never heard from the service
 *  (disconnected) must not draw a picker it has nothing to put in.
 *
 *  A panel that names no approvalMode renders what the real one renders with no
 *  level reported: the shared DEFAULT_APPROVAL_MODE (按需确认), not a harness
 *  hardcode. Panel 0 names 'auto' explicitly because 全部允许's amber is what
 *  the tint checks below measure. */
function Panel({ title, status, session, busy, children, approvalMode, disabled, model = MODEL }) {
  const [mode, setMode] = useState(approvalMode ?? DEFAULT_APPROVAL_MODE)
  const [picked, setModel] = useState(model)
  return (
    <div className="pm-panel" style={{ position: 'static' }}>
      <header className="pm-header">
        <span className="pm-brand">{title}</span>
        <span className="pm-chip pm-chip-ok">已连接</span>
        <span className="pm-status">{status}</span>
        <span className="pm-spacer" />
        <button className="pm-icon-btn" title="新会话"><Icon name="plus" /></button>
        <button className="pm-icon-btn" title="收起"><Icon name="close" /></button>
      </header>
      <Transcript session={session} busy={!!busy} onApprovalResponse={noop} onAnswer={noop} onClearError={noop} />
      {children}
      <Composer
        busy={!!busy}
        disabled={!!disabled}
        approvalMode={mode}
        model={picked ?? undefined}
        onSend={noop}
        onStop={noop}
        onChangeApprovalMode={setMode}
        onSelectModel={(id) => setModel((m) => (m ? { ...m, activeId: id } : m))}
      />
    </div>
  )
}

/** The four fixtures, each mounted into its own host + Shadow Root the way the
 *  real content script does it (one panel per page). */
const PANELS = [
  {
    title: '主对话对齐',
    status: '就绪',
    // 全部允许, so the amber assertions below have their subject.
    approvalMode: 'auto',
    session: shell({ messages: [USER, ASSISTANT, FINAL] }),
  },
  {
    title: '等待批准',
    status: '等待批准',
    busy: true,
    approvalMode: 'always-ask',
    session: shell({
      agentStatus: { status: 'awaiting_approval' },
      messages: [USER, { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [text('这一步要动页面，先确认一下：'), { type: 'tool_use', id: 't9', name: 'page_input', status: 'pending', input: { index: 4, text: '张三', description: '填写姓名' } }] }],
    }),
  },
  {
    title: '等待回答',
    status: '等待回答',
    approvalMode: 'outside-ask',
    session: shell({
      agentStatus: { status: 'awaiting_user_input' },
      messages: [USER, { id: 'a2', role: 'assistant', createdAt: NOW, contentBlocks: [{ type: 'tool_use', id: 't10', name: 'ask_user', status: 'pending', input: { prompt: '要往哪个城市订？', choices: '北京, 上海, 广州, 深圳', multi: true } }] }],
    }),
  },
  {
    title: '出错 / 空态',
    status: '出错',
    disabled: true,
    model: null,
    session: shell({ agentStatus: { status: 'error', error: '服务端返回 429：请求过于频繁，请稍后重试' } }),
  },
  {
    // The action row's busy-tail rule: the landed text is the turn's tail but the
    // turn is still running — no row yet (the chat's in-flight text lives in its
    // streaming segment, which never shows one either).
    title: '进行中',
    status: '生成中',
    busy: true,
    session: shell({
      agentStatus: { status: 'streaming' },
      messages: [USER, { id: 'a4', role: 'assistant', createdAt: NOW, contentBlocks: [text('先看一眼页面结构，马上回来。')] }],
    }),
  },
  {
    // Raw HTML (user 2026-10-09: 面板要像桌面一样渲染 HTML 块): a styled card
    // must render with its inline style, while the hostile samples ride along —
    // a script block degenerates to inert text and an onerror img keeps its src
    // but not its handler (sanitizer: DOMPurify allowlist, ui/markdown.ts).
    title: 'HTML 卡片',
    status: '就绪',
    session: shell({
      messages: [
        USER,
        {
          id: 'a5',
          role: 'assistant',
          createdAt: NOW,
          contentBlocks: [
            text(
              // The fixtures live inside this file's HARNESS template literal, so
              // the newlines of the html sample have to survive one level of
              // template evaluation — hence the doubled backslashes below.
              '<div style="background:#fff7e6;padding:8px;border-radius:8px">橙色卡片</div>\\n\\n<script>alert(1)</script>\\n\\n<img src=x onerror=alert(1)>\\n\\n正文照常',
            ),
          ],
        },
      ],
    }),
  },
]

// ── the host mirrors content/index.tsx exactly (same order, same two sheets) ──
const page = document.createElement('div')
page.id = 'page'
page.style.cssText = 'display:flex; gap:20px; align-items:flex-start; background:#f5f6f8; padding:20px;'
document.body.appendChild(page)

for (const fixture of PANELS) {
  const host = document.createElement('div')
  host.setAttribute('data-pulsemind-panel', '')
  host.style.cssText = 'width:380px; height:900px; flex:none;'
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
  page.appendChild(host)
  createRoot(rootEl).render(<Panel {...fixture} />)
}

window.__panels = () => [...document.querySelectorAll('[data-pulsemind-panel]')].map((h) => h.shadowRoot)
window.__ready = true

/** The launcher: the real App with the panel closed, so the collapsed state the
 *  user actually meets is what gets measured. Mounted on demand — its frost test
 *  lays a striped backdrop over the whole viewport, which would be in the way of
 *  the fixture screenshots above. */
/** The expanded panel, mounted the same way — the real App with \`__openPanel\`
 *  set. It takes the launcher down first: both hosts are fixed at the same
 *  bottom-right corner with the same z-index, and the drag section upstream
 *  always leaves a launcher mounted, so two of them would fight over the same
 *  pixels (and over the clicks aimed at the header). */
window.__mountPanel = () => {
  document.getElementById('launcher')?.remove()
  document.getElementById('wide-panel')?.remove()
  const host = document.createElement('div')
  host.setAttribute('data-pulsemind-panel', '')
  host.id = 'wide-panel'
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
  return true
}

window.__mountLauncher = () => {
  // A remount has to be a *fresh* tree (the drag check re-mounts to prove the
  // position came back from storage, not from React state), so the previous
  // host goes first.
  document.getElementById('launcher')?.remove()
  const host = document.createElement('div')
  host.setAttribute('data-pulsemind-panel', '')
  host.id = 'launcher'
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
  // High-frequency detail behind the launcher. backdrop-filter can only be
  // *seen* against something with detail in it, and this is the layer the
  // pixel check below measures the blur against: 4px black/white stripes, at
  // z-index -1 so they are painted before the button and land in its backdrop.
  const stripes = document.createElement('div')
  stripes.id = 'launcher-backdrop'
  stripes.style.cssText =
    'position:fixed; inset:0; z-index:-1; background:repeating-linear-gradient(90deg,#000 0 4px,#fff 4px 8px);'
  shadow.appendChild(stripes)
  document.body.appendChild(host)
  createRoot(rootEl).render(<App />)
  return true
}
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'panel-harness.tsx' },
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

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))
await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')
// The launcher below is the real `App`, which talks to its worker over
// chrome.runtime — absent on a plain page. Only `panel/attach` needs an answer,
// and it answers with the panel closed, i.e. as the launcher.
await page.addScriptTag({
  content: `
window.__sent = []
window.__listeners = []
if (typeof chrome === 'undefined' || !chrome) { window.chrome = {} }
chrome.runtime = {
  sendMessage: async (msg) => {
    window.__sent.push(msg)
    if (msg.type === 'panel/attach') {
      var one = [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '总结这个页面' }], createdAt: '2026-09-15T10:00:00.000Z' }]
      var many = []
      for (var i = 0; i < 24; i++) {
        many.push({
          id: 'm' + i,
          role: i % 2 === 0 ? 'user' : 'assistant',
          contentBlocks: [{ type: 'text', text: '第 ' + (i + 1) + ' 轮：把这一段的结论写清楚，并且说明它是从页面的哪一部分得出的。' }],
          createdAt: '2026-09-15T10:00:0' + (i % 10) + '.000Z',
        })
      }
      return { ok: true, snapshot: {
        sessionId: 'ws_1',
        // __disconnected（未连接横幅段）时回答断连态：真 App 据此画 .pm-banner。
        connection: window.__disconnected === true
          ? { state: 'closed', connected: false, reason: '未连接到手动指定的服务（ws://192.168.1.100:8765 无响应）' }
          : { state: 'open', connected: true },
        panelOpen: window.__openPanel === true,
        messages: window.__longTranscript === true ? many : one,
        streamingBlocks: [],
        status: 'idle',
        sessions: [],
        approvalMode: 'auto',
      } }
    }
    return { ok: true }
  },
  onMessage: { addListener: (fn) => window.__listeners.push(fn) },
  openOptionsPage: () => {},
}
// The launcher's dragged position lives in chrome.storage.local (a content
// script cannot read storage.session — see background/state.ts), so the stub
// backs it with a plain object the drag checks can seed and read back.
window.__stored = {}
window.__storedWrites = []
chrome.storage = {
  local: {
    get: async (key) => (key in window.__stored ? { [key]: window.__stored[key] } : {}),
    set: async (entries) => {
      Object.assign(window.__stored, entries)
      window.__storedWrites.push(entries)
    },
  },
}
`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)
await page.waitForTimeout(500)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const probe = await page.evaluate(() => {
  const root = window.__panels()[0]
  const pendingRoot = window.__panels()[1]
  const q = (sel) => root.querySelector(sel)
  const cs = (sel) => {
    const el = q(sel)
    return el ? getComputedStyle(el) : null
  }
  const pendingHead = pendingRoot.querySelector('.pm-tool-head-pending')
  const panel = q('.pm-panel').getBoundingClientRect()
  const bubble = q('.pm-bubble').getBoundingClientRect()
  const transcript = q('.pm-transcript')
  const table = q('.pm-md table')
  return {
    h1: `${cs('.pm-md h1')?.fontSize}/${cs('.pm-md h1')?.fontWeight}`,
    bodyFont: cs('.pm-panel')?.fontFamily,
    bubbleBg: cs('.pm-bubble')?.backgroundColor,
    bubbleRadius: cs('.pm-bubble')?.borderRadius,
    bubbleAlign: cs('.pm-row-user')?.justifyContent,
    // 气泡底边到正文最后一行的距离：应当只剩气泡自己的 padding-bottom(8px)。
    // 多出来的 16px 就是「reset 层缺位」——x-markdown 的 :last-child 清零挂在
    // 组件根类 `.x-markdown` 上，桌面端的根同时带它和主题类，面板的根只有主题类。
    bubbleTrail: (() => {
      const b = q('.pm-bubble')
      const last = b?.firstElementChild?.lastElementChild
      return b && last ? Math.round(b.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : null
    })(),
    lastBlockMargin: (() => {
      const last = q('.pm-bubble')?.firstElementChild?.lastElementChild
      return last ? getComputedStyle(last).marginBottom : null
    })(),
    cardRadius: cs('.pm-input-card')?.borderRadius,
    cardBg: cs('.pm-input-card')?.backgroundColor,
    cardBlur: cs('.pm-input-card')?.backdropFilter,
    cardShadow: cs('.pm-input-card')?.boxShadow,
    toolBg: cs('.pm-tool-head')?.backgroundColor,
    pendingBg: pendingHead ? getComputedStyle(pendingHead).backgroundColor : null,
    pendingBorder: pendingHead ? getComputedStyle(pendingHead).borderColor : null,
    tableOverflowX: table ? getComputedStyle(table).overflowX : null,
    tableScrolls: table ? table.scrollWidth > table.clientWidth && getComputedStyle(table).overflowX === 'auto' : false,
    preOverflowX: cs('.pm-md pre')?.overflowX,
    panelWidth: Math.round(panel.width),
    scrollbar: transcript.offsetWidth - transcript.clientWidth,
    panelRight: Math.round(panel.right),
    widest: Math.round(bubble.right),
    svgGlyphs: root.querySelectorAll('svg path').length,
    imgGlyphs: root.querySelectorAll('img').length,
    caretInThinking: !!q('.pm-thinking .pm-thinking-caret svg'),
    actionRow: !!q('.pm-actions'),
    actionButtons: [...root.querySelectorAll('.pm-action-btn')].map((b) => b.title),
    actionStats: q('.pm-stats')?.textContent ?? '',
  }
})

check('x-markdown light theme applied inside the shadow root', probe.h1 === '24px/600', `h1 ${probe.h1}`)
check('app fontFamily reaches the panel', /-apple-system|PingFang|system-ui/.test(probe.bodyFont ?? ''), probe.bodyFont)
check(
  'user bubble matches the chat (#f0f2f4, radius 12, right-aligned)',
  probe.bubbleBg === 'rgb(240, 242, 244)' && probe.bubbleRadius === '12px' && probe.bubbleAlign === 'flex-end',
  `${probe.bubbleBg} / ${probe.bubbleRadius} / ${probe.bubbleAlign}`,
)
// The desktop's Sender card: pill radius, frosted white, the shared blue shadow.
check(
  'input card carries the chat radius 20 + frosted white + shadow',
  probe.cardRadius === '20px' && /255, 255, 255/.test(probe.cardBg ?? '') && /blur/.test(probe.cardBlur ?? '') && /rgba\(80, 100, 200/.test(probe.cardShadow ?? ''),
  `${probe.cardRadius} / ${probe.cardBg} / ${probe.cardBlur} / ${probe.cardShadow}`,
)
check(
  'tool header uses the chat greys, the approval hold its amber',
  probe.toolBg === 'rgb(245, 245, 245)' && probe.pendingBg === 'rgb(255, 247, 230)' && probe.pendingBorder === 'rgb(255, 213, 145)',
  `${probe.toolBg} / held ${probe.pendingBg} + ${probe.pendingBorder}`,
)
// The theme sets `table { overflow: hidden }`; the panel overrides it, because a
// 380px column would otherwise clip a table the chat's 1000px column fits.
check('wide table scrolls instead of being clipped', probe.tableOverflowX === 'auto' && probe.tableScrolls, `${probe.tableOverflowX}, scrolls=${probe.tableScrolls}`)
check('code fence scrolls horizontally', probe.preOverflowX === 'auto', probe.preOverflowX)
// 正文最后一块不许带下边距：气泡里多出来的 16px 就是这么来的（reset 层缺位）。
// 桌面端由组件自带样式表的 `.x-markdown :last-child { margin-bottom: 0 }` 保证。
check('last markdown block carries no trailing margin', probe.lastBlockMargin === '0px', probe.lastBlockMargin)
check('the bubble padding is the only space under the text', probe.bubbleTrail === 8, `${probe.bubbleTrail}px below the text`)
check('the panel itself draws no horizontal scrollbar', probe.scrollbar <= 6, `${probe.scrollbar}px`)
check('no block overflows the 380px panel', probe.widest <= probe.panelRight + 1, `${probe.widest} vs ${probe.panelRight}`)
// Every glyph is an inline SVG copy of the antd path: importing the icon package
// would inject cssinjs into the *page's* head.
check('every glyph is an inline SVG, none an <img> or font icon', probe.svgGlyphs >= 15 && probe.imgGlyphs === 0 && probe.caretInThinking, `${probe.svgGlyphs} paths, ${probe.imgGlyphs} imgs`)
check(
  'action row is the chat viewOnly variant (复制 / 下载 + 耗时 · Token)',
  probe.actionRow && probe.actionButtons.join('/') === '复制/下载' && /耗时|s|ms/.test(probe.actionStats) && !probe.actionStats.includes('收藏'),
  `${probe.actionButtons.join('/')} — ${probe.actionStats.replace(/\s+/g, ' ').trim()}`,
)

// ── HTML 卡片（真浏览器里的消毒渲染，user 2026-10-09）────────────────────
// jsdom 里的 vitest 已经验过 sanitizer 的字符串输出；这里补的是字符串之后的
// 一环：innerHTML 进 shadow root 后 inline style 真的生效、script 真的不成
// 元素、img 的 onerror 真的不在属性里。
const htmlCard = await page.evaluate(() => {
  // Assistant markdown lands in `.pm-bubble-assistant` → `.pm-md` (Transcript's
  // user bubble is `.pm-bubble` — not this fixture's container).
  const root = window.__panels()[5]
  const card = root.querySelector('.pm-bubble-assistant div[style]')
  const style = card ? getComputedStyle(card) : null
  return {
    cardText: card?.textContent ?? '',
    cardBg: style?.backgroundColor ?? '',
    cardRadius: style?.borderRadius ?? '',
    scriptEl: !!root.querySelector('.pm-bubble-assistant script'),
    bodyTexts: [...root.querySelectorAll('.pm-bubble-assistant p, .pm-bubble-assistant div')].map((n) => n.textContent ?? ''),
    // Elements don't survive page.evaluate's serialization — read the
    // attributes here, not at the assertion.
    imgOnerror: root.querySelector('.pm-bubble-assistant img')?.getAttribute('onerror') ?? null,
    imgSrc: root.querySelector('.pm-bubble-assistant img')?.getAttribute('src') ?? null,
  }
})
check(
  'html 卡片渲染且 inline style 生效（底色 + 圆角）',
  htmlCard.cardText === '橙色卡片' && htmlCard.cardBg === 'rgb(255, 247, 230)' && htmlCard.cardRadius === '8px',
  `${htmlCard.cardBg} / ${htmlCard.cardRadius}`,
)
check(
  'script 块退化为惰性正文（无 script 元素，payload 是可见文本）',
  !htmlCard.scriptEl && htmlCard.bodyTexts.some((t) => t.includes('alert(1)')),
  `script=${htmlCard.scriptEl}`,
)
check(
  'img 保留 src 但 onerror 被剥掉，正文照常',
  htmlCard.imgOnerror === null && htmlCard.imgSrc === 'x' && htmlCard.bodyTexts.some((t) => t.includes('正文照常')),
  `onerror=${htmlCard.imgOnerror}, src=${htmlCard.imgSrc}`,
)

// 操作行的可见性（镜像 SegmentBlock 的 actionsVisible，M2.9）：同一轮里只有
// 最终输出带一行 —— 工具前的叙述（带工具卡的那条）没有，进行中的尾条也没有；
// 历史重放则是每轮的最终答案各一行，而不是整条流水线每条都挂一个。
const rowPlacement = await page.evaluate(() => {
  const rowsOf = (i) => window.__panels()[i].querySelectorAll('.pm-actions').length
  const assistantRows = [...window.__panels()[0].querySelectorAll('.pm-row-assistant')]
  return {
    transcriptRows: rowsOf(0),
    narrationHasRow: !!assistantRows[0]?.querySelector('.pm-actions'),
    finalHasRow: !!assistantRows[assistantRows.length - 1]?.querySelector('.pm-actions'),
    heldRows: rowsOf(1),
    busyRows: rowsOf(4),
  }
})
check(
  '同一轮只有最终输出带操作行，过程中的叙述没有',
  rowPlacement.transcriptRows === 1 && rowPlacement.finalHasRow && !rowPlacement.narrationHasRow,
  `rows=${rowPlacement.transcriptRows}, narration=${rowPlacement.narrationHasRow}, final=${rowPlacement.finalHasRow}`,
)
check('审批挂起与进行中的面板都不出现操作行', rowPlacement.heldRows === 0 && rowPlacement.busyRows === 0, `held=${rowPlacement.heldRows}, busy=${rowPlacement.busyRows}`)
check('no page errors while rendering', pageErrors.length === 0, pageErrors.join(' | '))

// ── guards for the failures a glance would catch ─────────────────────
// The screenshots below are for a human; these catch the gross breakages
// (invisible text, a clipped label, the composer pushed out of the panel) so a
// broken render cannot pass silently just because the CSS parsed.
const layout = await page.evaluate((INVISIBLE_DELTA) => {
  const root = window.__panels()[0]
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  /** Effective background behind an element: the nearest ancestor that paints an
   *  opaque one. Translucent fills are skipped — the theme's inline `code` sits
   *  on `rgba(0,0,0,0.04)`, which is a near-white wash over the panel, not a
   *  black surface (Chrome reports opaque backgrounds as `rgb(...)`, everything
   *  with an alpha channel as `rgba(...)`). */
  const backdrop = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg?.startsWith('rgb(')) return bg
    }
    return 'rgb(255, 255, 255)'
  }
  /** Every leaf that renders text, with the contrast it actually has. */
  const textLeaves = (scope) =>
    [...scope.querySelectorAll('*')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
  const lowContrast = (scope) =>
    textLeaves(scope)
      .filter((el) => Math.abs(lum(backdrop(el)) - lum(getComputedStyle(el).color)) <= INVISIBLE_DELTA)
      .map((el) => `${el.className || el.tagName}(${getComputedStyle(el).color} on ${backdrop(el)})`)

  const panel = root.querySelector('.pm-panel').getBoundingClientRect()
  const composer = root.querySelector('.pm-composer').getBoundingClientRect()
  const clipped = []
  for (const sel of ['.pm-tool-name', '.pm-tool-summary', '.pm-brand', '.pm-actions']) {
    for (const el of root.querySelectorAll(sel)) {
      if (el.scrollHeight > el.clientHeight + 1 || el.getBoundingClientRect().width === 0) clipped.push(sel)
    }
  }
  return {
    clipped,
    composerInsidePanel: Math.round(composer.bottom) <= Math.round(panel.bottom) + 1,
    lightLowContrast: lowContrast(root),
  }
}, INVISIBLE_DELTA)
check('no label is clipped or collapsed to zero width', layout.clipped.length === 0, layout.clipped.join(', ') || 'all sized')
check('composer stays inside the 380×900 panel', layout.composerInsidePanel)
check('no text run is invisible against its backdrop (light theme)', layout.lightLowContrast.length === 0, layout.lightLowContrast.join(', ') || 'all visible')

// ── 全部允许 的图标与文案必须是警示橙 ────────────────────────────────
// 这一档工具调用不再经过批准，橙色就是那条持续提醒，图标与文案同一套颜色。
// 桌面端把它写死在 InputArea 的 UNRESTRICTED_COLOR，面板按同一个值复制，所以
// 这里量的是同一个 rgb(212, 107, 8)：面板 0 是 auto，面板 1 是 always-ask。
const tint = await page.evaluate(() => {
  const el = (i, sel) => window.__panels()[i].querySelector(sel)
  const color = (i, sel) => getComputedStyle(el(i, sel)).color
  return {
    autoIcon: color(0, '.pm-approval-icon'),
    autoLabel: color(0, '.pm-approval-label'),
    askIcon: color(1, '.pm-approval-icon'),
    askLabel: color(1, '.pm-approval-label'),
  }
})
check('全部允许 的图标与文案同为警示橙（#d46b08）', tint.autoIcon === 'rgb(212, 107, 8)' && tint.autoLabel === tint.autoIcon, `${tint.autoIcon} / ${tint.autoLabel}`)
// 其余档位是 InputArea 给 Button 的 inline color:'#666'（它同时压过 antd 的
// text-color-hover，所以 hover 也不变色）—— 面板此前用的是 rgba(0,0,0,0.45)。
check('其余档位的图标与文案是桌面端那个 #666', tint.askIcon === 'rgb(102, 102, 102)' && tint.askLabel === tint.askIcon, `${tint.askIcon} / ${tint.askLabel}`)

// The option is tinted before it is picked, so 全部允许 is recognisable in the
// open menu too — then closed again so the screenshots stay the resting state.
await page.evaluate(() => window.__panels()[0].querySelector('.pm-approval').click())
await page.waitForTimeout(150)
const menu = await page.evaluate(() => {
  const items = [...window.__panels()[0].querySelectorAll('.pm-approval-item')]
  return items.map((i) => ({
    label: i.textContent.trim(),
    color: getComputedStyle(i.querySelector('.pm-approval-item-label')).color,
    icon: getComputedStyle(i.querySelector('.pm-approval-item-icon')).color,
  }))
})
const autoItem = menu.find((i) => i.label === '全部允许')
const otherItem = menu.find((i) => i.label === '始终询问')
check('下拉里 全部允许 一项的图标与文案同样标橙', menu.length === 3 && autoItem?.color === 'rgb(212, 107, 8)' && autoItem?.icon === autoItem?.color, menu.map((i) => `${i.label} ${i.icon}/${i.color}`).join(', '))
check('下拉里其余档位不变色', otherItem?.color !== 'rgb(212, 107, 8)' && otherItem?.icon !== 'rgb(212, 107, 8)', `${otherItem?.icon}/${otherItem?.color}`)
await page.evaluate(() => window.__panels()[0].querySelector('.pm-approval').click())
await page.waitForTimeout(150)

// 没有档位可报时的默认值（未连接 / 新会话）：按需确认，图标与文案一起是普通灰。
// 面板此前硬写 APPROVAL_LEVELS[2]（全部允许），于是它会一边把工具调用拦下来、
// 一边在按钮上写着「没人拦」—— 默认值现在来自共享的 DEFAULT_APPROVAL_MODE。
const unset = await page.evaluate(() => {
  const btn = window.__panels()[3].querySelector('.pm-approval')
  return btn
    ? { label: btn.querySelector('.pm-approval-label').textContent.trim(), color: getComputedStyle(btn.querySelector('.pm-approval-label')).color }
    : null
})
check(
  '没有档位上报时显示共享默认（按需确认）而非全部允许',
  unset?.label === '按需确认' && unset?.color === 'rgb(102, 102, 102)',
  `${unset?.label ?? 'no button'} / ${unset?.color}`,
)

// ── 模型下拉：与授权按钮同一套小按钮指标，菜单反过来贴右边 ──────────────
// 桌面端的模型按钮是 Button size="small" type="text" iconPlacement="end" +
// inline fontSize:12/color:'#666'，antd 的根是 inline-flex + gap:iconGap(8px)；
// 授权按钮多一个 marginLeft:4 的箭头（10px / #bbb）。
const model = await page.evaluate(() => {
  const root = window.__panels()[0]
  const btn = root.querySelector('.pm-model')
  const caret = root.querySelector('.pm-model-caret svg')
  const approvalCaret = root.querySelector('.pm-approval-caret svg')
  const approvalBtn = root.querySelector('.pm-approval')
  const cs = getComputedStyle(btn)
  const acs = getComputedStyle(approvalBtn)
  return {
    label: root.querySelector('.pm-model-label')?.textContent,
    height: cs.height,
    padding: `${cs.paddingLeft}/${cs.paddingRight}`,
    radius: cs.borderRadius,
    font: cs.fontSize,
    color: cs.color,
    gap: cs.gap,
    bg: cs.backgroundColor,
    caretSize: caret ? getComputedStyle(caret).width : null,
    approvalHeight: acs.height,
    approvalColor: acs.color,
    approvalGap: acs.gap,
    approvalCaretSize: approvalCaret ? getComputedStyle(approvalCaret).width : null,
    approvalCaretColor: approvalCaret ? getComputedStyle(approvalCaret).color : null,
  }
})
check(
  '模型按钮与授权按钮同一套小按钮指标（24px / 7px / 4px / 12px / #666）',
  model.height === '24px' && model.padding === '7px/7px' && model.radius === '4px' && model.font === '12px' && model.color === 'rgb(102, 102, 102)',
  `${model.height} / ${model.padding} / ${model.radius} / ${model.font} / ${model.color}`,
)
check('两个按钮的按钮内间距同为 antd iconGap（8px）', model.gap === '8px' && model.approvalGap === '8px', `${model.gap} / ${model.approvalGap}`)
check(
  '授权按钮补上了桌面端那个箭头（10px / #bbb），模型按钮的箭头继承按钮字号',
  model.approvalCaretSize === '10px' && model.approvalCaretColor === 'rgb(187, 187, 187)' && model.caretSize === '12px',
  `approval ${model.approvalCaretSize}/${model.approvalCaretColor}, model ${model.caretSize}`,
)
check('模型按钮回显的是当前生效的档位', model.label === 'GPT-4o', model.label)

// The menu opens upward and to the *left* (right:0): the button sits at the
// panel's right edge, so a left-anchored menu would grow past the 380px panel.
await page.evaluate(() => window.__panels()[0].querySelector('.pm-model').click())
await page.waitForTimeout(150)
const modelMenu = await page.evaluate(() => {
  const root = window.__panels()[0]
  const menu = root.querySelector('.pm-model-menu')
  const panel = root.querySelector('.pm-panel').getBoundingClientRect()
  const rect = menu.getBoundingClientRect()
  const btn = root.querySelector('.pm-model').getBoundingClientRect()
  const items = [...root.querySelectorAll('.pm-model-item')]
  const titles = [...root.querySelectorAll('.pm-model-group-title')]
  const activeIdx = items.findIndex((i) => i.classList.contains('pm-model-item-active'))
  const long = items[1]
  const titleStyle = titles[0] ? getComputedStyle(titles[0]) : null
  return {
    labels: items.map((i) => i.textContent.trim()),
    groupTitles: titles.map((t) => t.textContent.trim()),
    groupTitleColor: titleStyle?.color ?? null,
    groupTitleFontSize: titleStyle?.fontSize ?? null,
    groupTitlePaddingLeft: titleStyle?.paddingLeft ?? null,
    activeIdx,
    activeBg: activeIdx >= 0 ? getComputedStyle(items[activeIdx]).backgroundColor : null,
    insidePanel: Math.round(rect.left) >= Math.round(panel.left) - 1 && Math.round(rect.right) <= Math.round(panel.right) + 1,
    aboveButton: rect.bottom <= btn.top + 1,
    // The long label is clipped by CSS, not by the panel.
    longClipped: long.scrollWidth > long.clientWidth,
    longOverflowsPanel: long.getBoundingClientRect().right > panel.right + 1,
  }
})
check(
  '模型菜单与桌面同款分组：条目是裸 modelLabel，供应商在分组头上（无 name 的退回 provider:model）',
  modelMenu.labels.join('|') === `GPT-4o|${FALLBACK_LABEL}` && modelMenu.groupTitles.join('|') === 'OpenAI|DeepSeek 官方',
  `items=${modelMenu.labels.join('|')}, groups=${modelMenu.groupTitles.join('|')}`,
)
check(
  '分组头是 antd 分组标题的样式（弱化墨色、条目同字号、与条目同横向内缩）',
  modelMenu.groupTitleColor === 'rgba(0, 0, 0, 0.45)' && modelMenu.groupTitleFontSize === '13px' && modelMenu.groupTitlePaddingLeft === '8px',
  `color=${modelMenu.groupTitleColor}, size=${modelMenu.groupTitleFontSize}, pad=${modelMenu.groupTitlePaddingLeft}`,
)
check('模型菜单整个落在面板内、并朝上展开', modelMenu.insidePanel && modelMenu.aboveButton, `inside=${modelMenu.insidePanel}, above=${modelMenu.aboveButton}`)
check('过长的模型名在菜单项里截断而不是撑破面板', modelMenu.longClipped && !modelMenu.longOverflowsPanel, `clipped=${modelMenu.longClipped}, overflow=${modelMenu.longOverflowsPanel}`)
// 打开时当前档位带选中态（pm-model-item-active 与授权菜单同款 #e6f4ff）——
// 当前位置先于第一次点击可见。
check(
  '打开时当前档位恰一行带选中态，底色 = antd controlItemBgActive',
  modelMenu.activeIdx === 0 && modelMenu.activeBg === 'rgb(230, 244, 255)',
  `idx=${modelMenu.activeIdx}, bg=${modelMenu.activeBg}`,
)

// 选中后按钮文案跟着换：按钮显示不带供应商前缀的 modelLabel（页脚空间有限，
// 全称在 tooltip 里），菜单项同为裸 modelLabel + tooltip 全称 —— 两个形态由这组断言分开钉。
await page.evaluate(() => window.__panels()[0].querySelectorAll('.pm-model-item')[1].click())
await page.waitForTimeout(150)
const afterSwitch = await page.evaluate(() => ({
  label: window.__panels()[0].querySelector('.pm-model-label')?.textContent,
  title: window.__panels()[0].querySelector('.pm-model')?.getAttribute('title'),
  menuGone: !window.__panels()[0].querySelector('.pm-model-menu'),
}))
check(
  '选中后按钮文案换成不带前缀的 label（tooltip 保留全称），且菜单关闭',
  afterSwitch.label === FALLBACK_LABEL && afterSwitch.title === `DeepSeek 官方 · ${FALLBACK_LABEL}` && afterSwitch.menuGone,
  `${afterSwitch.label} / title=${afterSwitch.title} / menuGone=${afterSwitch.menuGone}`,
)

// 选中态跟着状态走，不是钉在第一行：换档后重开菜单，active 行换到新档位上。
await page.evaluate(() => window.__panels()[0].querySelector('.pm-model').click())
await page.waitForTimeout(150)
const activeAfter = await page.evaluate(() => {
  const items = [...window.__panels()[0].querySelectorAll('.pm-model-item')]
  return items.findIndex((i) => i.classList.contains('pm-model-item-active'))
})
check('换档后重开菜单，选中行跟着换到新档位', activeAfter === 1, `idx=${activeAfter}`)
await page.evaluate(() => window.__panels()[0].querySelector('.pm-model').click())

// 最挤的静止态：最长模型名生效时，页脚是 授权 + 弹性空白 + 模型 + 发送 抢同一行
// 324px（面板 380 − composer 2×16 − 输入卡 2×12）。回归过一次：标签上限 160px
// 时整行溢出，flex 按基准宽分摊收缩把授权按钮压窄，「按需确认」在固定 24px 高里
// 折成两行。现在的契约：模型标签 120px 封顶自己截断，授权按钮 flex:none + nowrap
// 永不折行 —— 内联盒的 rect 数就是折行数，这里必须恒为 1。
const squeezed = await page.evaluate(() => {
  const root = window.__panels()[0]
  const approvalLabel = root.querySelector('.pm-approval-label')
  const modelLabel = root.querySelector('.pm-model-label')
  const footer = root.querySelector('.pm-input-footer')
  return {
    approvalWidth: root.querySelector('.pm-approval').getBoundingClientRect().width,
    approvalLabelLines: approvalLabel.getClientRects().length,
    footerOverflow: footer.scrollWidth - footer.clientWidth,
    modelLabelClipped: modelLabel.scrollWidth > modelLabel.clientWidth,
    modelLabelMaxWidth: getComputedStyle(modelLabel).maxWidth,
  }
})
check(
  '长模型名生效时授权文案仍是一行（不折行、页脚不溢出）',
  squeezed.approvalLabelLines === 1 && squeezed.footerOverflow <= 1,
  `lines=${squeezed.approvalLabelLines}, overflow=${squeezed.footerOverflow}px`,
)
check(
  '长模型名在按钮里被 CSS 截断（120px 上限 + 省略号），而不是挤压邻位',
  squeezed.modelLabelClipped && squeezed.modelLabelMaxWidth === '120px',
  `clipped=${squeezed.modelLabelClipped}, max-width=${squeezed.modelLabelMaxWidth}`,
)

// Back to the first profile so the screenshots show the resting state.
await page.evaluate(() => window.__panels()[0].querySelector('.pm-model').click())
await page.waitForTimeout(100)
await page.evaluate(() => window.__panels()[0].querySelectorAll('.pm-model-item')[0].click())
await page.waitForTimeout(150)
const approvalAtRest = await page.evaluate(
  () => window.__panels()[0].querySelector('.pm-approval').getBoundingClientRect().width,
)
check(
  '授权按钮宽度不随模型名长短变化（flex:none，挤压不落在它身上）',
  Math.abs(approvalAtRest - squeezed.approvalWidth) < 0.5,
  `long=${squeezed.approvalWidth.toFixed(1)}px, short=${approvalAtRest.toFixed(1)}px`,
)

// ── the held call: the decision arrives below the header, unexpanded ──
// A held call lays 跳过/运行 in an approval strip *below* its collapsed header —
// in the panel as in the chat, where those two buttons otherwise sit at the bottom
// of two collapsed layers (the execution segment, then the tool card). Nothing here
// clicks the header: the strip has to be there with the card still shut. Then the
// header is clicked once, to keep checking the dark card it opens onto.
const panelCount = await page.evaluate(() => window.__panels().length)
check('all six state panels mounted', panelCount === 6, `${panelCount} panels`)

const held = await page.evaluate(() => {
  const root = window.__panels()[1]
  const head = root.querySelector('.pm-tool-head-pending')
  if (!head) return { pendingHead: false }
  const strip = head.nextElementSibling
  const row = strip?.querySelector('.pm-approve-row')
  const buttons = [...(strip?.querySelectorAll('.pm-approve-btn') ?? [])]
  const name = strip?.className ?? null
  const headRect = head.getBoundingClientRect()
  const rowRect = row?.getBoundingClientRect()
  const runStyle = buttons[1] ? getComputedStyle(buttons[1]) : null
  return {
    pendingHead: true,
    cardOpen: !!root.querySelector('.pm-cmd'),
    stripClass: name,
    isStrip: !!strip && (name ?? '').includes('pm-approve-area'),
    buttons: buttons.map((b) => b.textContent.trim()),
    bg: strip ? getComputedStyle(strip).backgroundColor : null,
    border: strip ? getComputedStyle(strip).borderTopColor : null,
    belowHead: !!rowRect && rowRect.top >= headRect.bottom - 1,
    rowHeight: rowRect ? Math.round(rowRect.height) : null,
    // The metrics the chat's antd Button size="small" has, measured there in
    // scripts/probe-chat-approval.mjs: the iconGap is 8px, which is why the icons
    // here carry no inline margin.
    btnHeight: runStyle?.height ?? null,
    btnPadding: runStyle ? `${runStyle.paddingLeft}/${runStyle.paddingRight}` : null,
    btnGap: runStyle?.gap ?? null,
    btnFont: runStyle?.fontSize ?? null,
    btnColor: runStyle?.color ?? null,
  }
})
check('the held call is marked 待批准', held.pendingHead)
check('the held card stays collapsed — nothing opens itself', held.pendingHead && !held.cardOpen)
check('an approval strip sits directly below the header', held.isStrip, held.stripClass ?? 'no strip')
check(
  '跳过 / 运行 are in the strip, visible with zero clicks',
  held.buttons.length === 2 && held.buttons[0].includes('跳过') && held.buttons[1].includes('运行'),
  held.buttons.join(' | ') || 'no buttons',
)
check('the strip is the chat\'s amber area, below the header', held.belowHead && held.bg === 'rgb(255, 247, 230)' && held.border === 'rgb(255, 213, 145)', `below=${held.belowHead} ${held.bg} / ${held.border}`)
check(
  'strip buttons carry antd size="small" metrics (24px / 7px / iconGap 8px / 12px)',
  held.btnHeight === '24px' && held.btnPadding === '7px/7px' && held.btnGap === '8px' && held.btnFont === '12px',
  `${held.btnHeight} / ${held.btnPadding} / gap ${held.btnGap} / ${held.btnFont} / ${held.btnColor}`,
)
// The unexpanded held panel, for eyeballing the strip against the desktop chat
// (the shot below is taken after the header is clicked, so it shows the other state).
await page.locator('[data-pulsemind-panel]').nth(1).screenshot({ path: join(SHOTS, 'panel-held-strip.png') })

// Opening the card by hand: the strip hands the pair back to the card, so the two
// never stack, and the card has to be the chat's own dark one.
await page.evaluate(() => window.__panels()[1].querySelector('.pm-tool-head-pending').click())
await page.waitForTimeout(200)

const approval = await page.evaluate((INVISIBLE_DELTA) => {
  const root = window.__panels()[1]
  const card = root.querySelector('.pm-cmd')
  const buttons = [...root.querySelectorAll('.pm-cmd-actions .pm-cmd-btn')].map((b) => b.textContent.trim())
  // The dark card's own `color` is inherited; what matters is each text run
  // inside it, so measure the leaves against the nearest painted backdrop.
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const backdrop = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg?.startsWith('rgb(')) return bg
    }
    return 'rgb(255, 255, 255)'
  }
  const dim = card
    ? [...card.querySelectorAll('*')]
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .filter((el) => Math.abs(lum(backdrop(el)) - lum(getComputedStyle(el).color)) <= INVISIBLE_DELTA)
        .map((el) => `${el.className || el.tagName}(${getComputedStyle(el).color} on ${backdrop(el)})`)
    : ['card did not render']
  return {
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
    buttons,
    lowContrast: dim,
    stripGone: !root.querySelector('.pm-approve-area'),
  }
}, INVISIBLE_DELTA)
check('approval card is the chat dark CommandCard', approval.cardBg === 'rgb(30, 30, 30)', approval.cardBg)
check('dark tool card text reads against its background', approval.lowContrast.length === 0, approval.lowContrast.join(', ') || 'all pass')
check('跳过 / 运行 buttons appear in the held card', approval.buttons.length === 2 && approval.buttons[0].includes('跳过') && approval.buttons[1].includes('运行'), approval.buttons.join(' | '))
check('the strip hands the pair back to the open card', approval.stripGone, approval.stripGone ? 'strip removed' : 'both shown at once')

const asking = await page.evaluate(() => {
  const root = window.__panels()[2]
  const confirm = root.querySelector('.pm-ask .pm-cmd-btn-primary')
  return {
    chips: [...root.querySelectorAll('.pm-chip-choice')].map((c) => c.textContent.trim()),
    confirmText: confirm?.textContent.trim() ?? null,
    confirmDisabledBeforePick: confirm?.disabled ?? null,
    hasCustomInput: !!root.querySelector('.pm-ask-input'),
  }
})
check('ask_user renders its choices as chips with a custom-answer box', asking.chips.length === 4 && asking.hasCustomInput, asking.chips.join('/'))
// 确认常驻（2026-10-06）：出现于首_pick 会让按钮的位置在用户开始点击时跳变——
// 未选时禁用而非隐藏，标签不带计数。
check('multi-select confirm is persistent, disabled before a pick, count-free', asking.confirmText === '确认' && asking.confirmDisabledBeforePick === true, JSON.stringify(asking))

const last = await page.evaluate(() => {
  const root = window.__panels()[3]
  return {
    error: root.querySelector('.pm-error')?.textContent ?? '',
    empty: root.querySelector('.pm-empty')?.textContent ?? '',
    composerDisabled: root.querySelector('.pm-input')?.disabled === true,
    // Nothing to switch to → no picker. The footer keeps its own shape: 授权 on
    // the left, the send button still pinned right.
    modelPicker: !!root.querySelector('.pm-model'),
    approvalPresent: !!root.querySelector('.pm-approval'),
    sendPresent: !!root.querySelector('.pm-send'),
  }
})
check('error card and empty state render', /429/.test(last.error) && last.empty.includes('在当前页面里直接对话'))
check('composer is disabled while disconnected', last.composerDisabled)
check(
  '服务端没报模型时不画选择器，页脚其余部件照旧',
  !last.modelPicker && last.approvalPresent && last.sendPresent,
  `picker=${last.modelPicker}, approval=${last.approvalPresent}, send=${last.sendPresent}`,
)

await page.screenshot({ path: join(SHOTS, 'panels.png'), fullPage: true })
await page.locator('[data-pulsemind-panel]').first().screenshot({ path: join(SHOTS, 'panel-main.png') })

// ── 输入帽（4K，桌面裁定的面板镜像）────────────────────────────────────
// 面板此前没有 UI 钳，超限粘贴走 prepareTurn 的静默裁切——用户永远不知道尾巴
// 没了。现在钳在 onChange 上、计数器说明发生了什么。这里用真输入事件驱动真实
// Composer：4500 字的 fill 必须被裁到 4000，计数器八成满（3200）出现、到线变
// 琥珀 #d46b08（与桌面同值）、回落即消失。面板 0（主对话对齐）承载本节。
// 位置：紧接夹具截图之后——后面的拖拽/放大段会让夹具宿主塌成 0×0（既有现象，
// 与本节无关），fill 的可见性判定在那里会假死。
{
  console.log('== 输入帽（4K） ==')
  const panel0 = page.locator('[data-pulsemind-panel]').first()
  const input = panel0.locator('.pm-input')
  const counter = panel0.locator('.pm-composer-count')
  const counterColor = () => counter.evaluate((el) => getComputedStyle(el).color)

  await input.fill('字'.repeat(3300))
  await page.waitForTimeout(200)
  check('八成满（≥3200）计数器出现', (await counter.count()) === 1)
  check('未到线时计数是弱化墨色 #999', (await counterColor()) === 'rgb(153, 153, 153)', await counterColor())
  check('计数值如实反映字数', (await counter.textContent()) === '3300/4000', await counter.textContent())

  await input.fill('x'.repeat(4500))
  await page.waitForTimeout(200)
  const value = await input.inputValue()
  check('4500 字的粘贴被钳到 4000（头保留）', value.length === 4000, String(value.length))
  check('到线计数是琥珀 #d46b08', (await counterColor()) === 'rgb(212, 107, 8)', await counterColor())
  check('计数器文本是 4000/4000', (await counter.textContent()) === '4000/4000', await counter.textContent())

  await input.fill('短文本')
  await page.waitForTimeout(200)
  check('回落后计数器消失', (await counter.count()) === 0)
}

// ── 启动球（收起态）：浅灰毛玻璃圆盘 + 品牌标记 ─────────────────────────
// 用户裁定 2026-09-16：「把 pulsemind_extension.png 作为植入到页面中的悬浮球
// 按钮，并配圆形浅灰色背景，毛玻璃效果」。这几件事都只有真浏览器能证：
// 圆、透明度、backdrop-filter 是否**真的**虚化了身后的页面（声明了不等于生效，
// 任何祖先建立 backdrop root 就会让它退化成一层灰），以及标记在圆里画对了没有。
// 像素部分是关键：4px 黑白条纹铺在身后，圆内应当被抹平、圆外应当仍是条纹。
console.log('== 启动球（浅灰毛玻璃）==')
await page.evaluate(() => window.__mountLauncher())
await page.waitForTimeout(400)

const fab = await page.evaluate(() => {
  const shadow = document.querySelector('#launcher').shadowRoot
  const el = shadow.querySelector('.pm-fab')
  if (!el) return { missing: true }
  const box = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const svg = el.querySelector('svg')
  const svgBox = svg?.getBoundingClientRect()
  const logo = svg ? getComputedStyle(svg) : null
  return {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    radius: style.borderTopLeftRadius,
    background: style.backgroundColor,
    border: style.borderTopColor,
    backdrop: style.backdropFilter || style.webkitBackdropFilter || '',
    transform: style.transform,
    hasImg: !!el.querySelector('img'),
    svg: svgBox ? { x: svgBox.x, y: svgBox.y, width: svgBox.width, height: svgBox.height } : null,
    viewBox: svg?.getAttribute('viewBox') ?? null,
    fill: svg?.getAttribute('fill') ?? null,
    ink: style.color,
    shadow: style.boxShadow,
    font: logo?.fontSize ?? null,
    // The mark's own box, handed to the pixel pass so ink is excluded from the
    // backdrop measurement.
    logoBox: svgBox ? { x: svgBox.x, y: svgBox.y, width: svgBox.width, height: svgBox.height } : null,
  }
})

const rgb = (s) => (s.match(/[\d.]+/g) ?? []).map(Number)
check('面板收起时渲染启动球', !fab.missing && !!fab.svg, fab.missing ? 'no .pm-fab' : 'ok')
check(
  '启动球是正圆（44px，border-radius 50%）',
  fab.box && Math.abs(fab.box.width - 44) < 0.5 && Math.abs(fab.box.height - 44) < 0.5 && fab.radius === '50%',
  fab.box ? `${fab.box.width}x${fab.box.height} r=${fab.radius}` : 'no box',
)
const [br, bg, bb, ba] = rgb(fab.background ?? '')
const spread = Math.max(br, bg, bb) - Math.min(br, bg, bb)
const lum = 0.2126 * br + 0.7152 * bg + 0.0722 * bb
check(
  '底色是半透明的浅灰（R≈G≈B，亮，alpha 明显小于 1）',
  ba > 0.4 && ba < 0.95 && spread <= 6 && lum > 200 && lum < 250,
  `${fab.background} -> luminance ${lum.toFixed(0)}, spread ${spread}`,
)
check(
  '毛玻璃：backdrop-filter 带 12px blur',
  /blur\(12px\)/.test(fab.backdrop),
  fab.backdrop || 'none declared',
)
const [er, eg, eb, ea] = rgb(fab.border ?? '')
check('玻璃边缘是半透明白描边', ea > 0 && ea < 1 && er > 240 && eg > 240 && eb > 240, fab.border)
check(
  '玻璃厚度：外投影 + 顶部内高光',
  /rgba?\(80, 100, 200/.test(fab.shadow ?? '') && /inset/.test(fab.shadow ?? ''),
  fab.shadow?.slice(0, 64),
)
check(
  '标记是内联 SVG（不是 <img>，页面 CSP 管不到它）',
  !!fab.svg && !fab.hasImg && fab.viewBox === '0 0 622 446' && fab.fill === 'currentColor',
  `img=${fab.hasImg}, viewBox=${fab.viewBox}, fill=${fab.fill}`,
)
check(
  '标记宽 32px，高度按标记自身比例（不被拉伸）',
  fab.svg && Math.abs(fab.svg.width - 32) < 0.5 && Math.abs(fab.svg.height - (32 * 446) / 622) < 0.5,
  fab.svg ? `${fab.svg.width.toFixed(1)}x${fab.svg.height.toFixed(1)} (expect 32x${((32 * 446) / 622).toFixed(1)})` : 'no svg',
)
const margins = fab.svg
  ? [
      fab.svg.x - fab.box.x,
      fab.svg.y - fab.box.y,
      fab.box.x + fab.box.width - (fab.svg.x + fab.svg.width),
      fab.box.y + fab.box.height - (fab.svg.y + fab.svg.height),
    ]
  : null
check(
  '标记居中且四周留白（不贴边、不越界）',
  margins !== null && margins.every((m) => m >= 4 && m <= 12) && Math.abs(margins[0] - margins[2]) < 0.5 && Math.abs(margins[1] - margins[3]) < 0.5,
  margins ? margins.map((m) => m.toFixed(1)).join('/') : 'no svg',
)
const [ir, ig, ib] = rgb(fab.ink ?? '')
check(
  '标记用深色墨水画在浅灰上（可读）',
  ir < 90 && ig < 90 && ib < 90,
  `${fab.ink} on ${fab.background}`,
)

// ── 像素：毛玻璃到底有没有起作用 ───────────────────────────────────────
// 身后是 4px 黑白竖条纹 —— 极端但有意义的高频内容。圆内应当被抹平，圆外应当
// 依旧清晰。量的是**局部对比度**（相邻像素的平均绝对差）而不是亮度跨度：跨度对
// 平滑的渐变同样敏感（外投影在圆内的余韵就有 50 多），而用户看得见的失败只有一种
// ——"隔着球还能看见条纹"。两个方向一起断言，否则"条纹没铺上"会让这条检查空转。
const PAD = 24
const clip = {
  x: fab.box.x - PAD,
  y: fab.box.y - PAD,
  width: fab.box.width + 2 * PAD,
  height: fab.box.height + 2 * PAD,
}
const shot = await page.screenshot({ clip })
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
const scale = info.width / clip.width
const at = (ix, iy) => {
  const i = (iy * info.width + ix) * info.channels
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
}
const toImage = (cx, cy) => [(cx - clip.x) * scale, (cy - clip.y) * scale]
const cx = fab.box.x + fab.box.width / 2
const cy = fab.box.y + fab.box.height / 2
const logo = fab.logoBox
const [icx, icy] = toImage(cx, cy)

/** Mean |horizontal gradient| over one sampled region: high for crisp stripes,
 *  near zero once they are blurred away, and blind to a smooth gradient. */
function roughness(predicate) {
  let sum = 0
  let count = 0
  let min = 255
  let max = 0
  const reach = 40 * scale
  for (let iy = Math.max(1, Math.floor(icy - reach)); iy < Math.min(info.height - 1, icy + reach); iy++) {
    for (let ix = Math.max(1, Math.floor(icx - reach)); ix < Math.min(info.width - 1, icx + reach); ix++) {
      const dx = (ix - icx) / scale
      const dy = (iy - icy) / scale
      if (!predicate(dx, dy)) continue
      sum += Math.abs(at(ix + 1, iy) - at(ix - 1, iy)) / 2
      count++
      const v = at(ix, iy)
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return { mean: count ? sum / count : 0, count, range: max - min }
}
// Inside the disc, clear of the 1px border (r<19) and clear of the mark: the
// mark's own box is excluded, and only the caps above/below it are sampled —
// the mark's edges are exactly the high-frequency content that must not count
// as backdrop detail.
const interior = roughness((dx, dy) => {
  const inLogo = logo && Math.abs(dx) < logo.width / 2 + 2 && Math.abs(dy) < logo.height / 2 + 2
  return Math.hypot(dx, dy) < 19 && !inLogo
})
const exterior = roughness((dx, dy) => {
  const r = Math.hypot(dx, dy)
  return r >= 26 && r <= 38
})
const attenuation = exterior.mean / (interior.mean || 1)
check(
  '对照：圆外的条纹依旧清晰（身后确实有高频内容）',
  exterior.count > 1000 && exterior.mean > 15,
  `圆外局部对比度 ${exterior.mean.toFixed(1)}（${exterior.count}px）`,
)
// Measured: interior 2.5 against exterior 30.5. With the element's own 62%
// overlay and no blur at all the interior would still be 38% of the exterior
// (~11.6), so the ratio is what separates "frosted" from "transparent" — and
// the leftover 2.5 is the box-blur approximation's sidelobe residue on an
// extreme 4px fixture (real pages are far smoother; range here 0..57).
check(
  '毛玻璃真的把身后的高频内容压掉了（圆内被抹平）',
  interior.mean < 6 && attenuation > 5,
  `圆内局部对比度 ${interior.mean.toFixed(2)}，衰减 ${attenuation.toFixed(1)}x（无毛玻璃时约 11.6 = 1.0x）`,
)

// The mark itself, measured as ink coverage inside its own box. A broken trace,
// a transparent fill or a zero-size <svg> all land outside this window, while
// the source drawing covers 16.3% of its box (scripts/trace-brand-mark.mjs).
const inkPass = (() => {
  if (!logo) return null
  let dark = 0
  let total = 0
  let darkest = 255
  for (let iy = Math.round((logo.y - clip.y) * scale); iy < Math.round((logo.y + logo.height - clip.y) * scale); iy++) {
    for (let ix = Math.round((logo.x - clip.x) * scale); ix < Math.round((logo.x + logo.width - clip.x) * scale); ix++) {
      if (ix < 0 || iy < 0 || ix >= info.width || iy >= info.height) continue
      const v = at(ix, iy)
      total++
      if (v < 130) dark++
      if (v < darkest) darkest = v
    }
  }
  return { coverage: dark / total, darkest, total }
})()
check(
  '标记在圆内画出了正确的墨量（不是空 SVG，也没糊成一片）',
  !!inkPass && inkPass.coverage > 0.08 && inkPass.coverage < 0.3 && inkPass.darkest < 90,
  inkPass ? `墨量 ${(inkPass.coverage * 100).toFixed(1)}%（源图 16.3%），最深 ${inkPass.darkest.toFixed(0)}` : 'no logo box',
)
await page.screenshot({ path: join(SHOTS, 'launcher-frost.png'), clip })
// The disc on its own, for eyeballing the mark at the size it ships at. Note the
// selector: the host is a zero-size fixed element (its children are fixed too),
// so screening the *host* is not a thing — the button is what has a box.
await page.locator('#launcher .pm-fab').screenshot({ path: join(SHOTS, 'launcher.png') })

// Hover, with a real mouse: the glass lifts (lighter fill, slight scale).
await page.mouse.move(cx, cy)
await page.waitForTimeout(300)
const hovered = await page.evaluate(() => {
  const style = getComputedStyle(document.querySelector('#launcher').shadowRoot.querySelector('.pm-fab'))
  return { background: style.backgroundColor, transform: style.transform }
})
const hoverLum = (() => {
  const [r, g, b] = rgb(hovered.background)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
})()
check(
  'hover 时玻璃变亮、轻微放大',
  hoverLum > lum && hovered.background !== fab.background && /matrix\(1\.06/.test(hovered.transform),
  `${fab.background} -> ${hovered.background}, transform ${hovered.transform}`,
)
await page.screenshot({ path: join(SHOTS, 'launcher-hover.png'), clip })

// ── 启动球可上下拖动（用户裁定 2026-09-16）────────────────────────────────
// 拖动的每一条正确性都是**时序**问题，源码读起来一样对：按下时指针捕获生效了
// 没有（指针离开球体后还能不能收到 move）、松手后浏览器补发的那次 click 有没有
// 被吞掉（否则一拖就弹面板）、夹紧区间对不对、存下的值在重新挂载（≈ 页面刷新）
// 后能不能回到原位。jsdom 既没有指针也没有布局，只能真浏览器 + 真鼠标。
console.log('== 启动球可上下拖动 ==')

const VH = await page.evaluate(() => window.innerHeight)
const BOTTOM_TOP = VH - 44 - 20

/** The ball's geometry + the two state facts the drag owns. The position is read
 *  from the computed style, not the rect: hovering scales the ball 1.06 and a
 *  rect reports a box 1.3px off the layout one (and reports it *mid-transition*,
 *  which is a reading of the animation rather than of the drag) — exactly the
 *  error these checks are trying to catch in the implementation. */
const readFab = () =>
  page.evaluate(() => {
    const el = document.querySelector('#launcher')?.shadowRoot?.querySelector('.pm-fab')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      top: Number.parseFloat(style.top),
      left: Number.parseFloat(style.left),
      right: Number.parseFloat(style.right),
      cursor: style.cursor,
      touchAction: style.touchAction,
      stored: { ...window.__stored },
    }
  })
const writes = () => page.evaluate(() => window.__storedWrites.length)
const panelOpen = () =>
  page.evaluate(() => !!document.querySelector('#launcher')?.shadowRoot?.querySelector('.pm-panel'))

/** Press the ball, travel `dy` in steps, release. Steps matter: a single jump
 *  would be one pointermove, and a drag that only worked for one event would
 *  pass. */
async function dragFab(dy, steps = 10) {
  const box = await readFab()
  const x = box.rect.x + box.rect.w / 2
  const y = box.rect.y + box.rect.h / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(x, y + (dy * i) / steps)
  await page.mouse.up()
  await page.waitForTimeout(80)
  return { x, y }
}

const rest = await readFab()
check(
  '默认停在右下角（右 20 / 下 20）',
  Math.abs(rest.right - 20) < 0.5 && Math.abs(rest.top - BOTTOM_TOP) < 0.5,
  `right ${rest.right}, top ${rest.top}, 期望 ${BOTTOM_TOP}`,
)
check(
  '球上是可抓取光标 + touch-action: none（触摸拖动不会滚页面）',
  rest.cursor === 'grab' && rest.touchAction === 'none',
  `cursor ${rest.cursor}, touch-action ${rest.touchAction}`,
)

// 跟手：指针上移 300，球的上边沿必须同步上移 300 —— 不是补间动画，也不是
// "滚"上去的；横轴一动不动。面板是否误展开先判，因为一旦展开球就没了（.pm-fab
// 不存在），后面几条几何检查会直接崩；先判能让负控跑出一行像样的 FAIL。
const beforeDrag = await readFab()
const writesBeforeDrag = await writes()
await dragFab(-300)
check('拖完不会误触展开（浏览器补发的那次 click 被吞掉了）', !(await panelOpen()), 'panel expanded after drag')
const afterDrag = await readFab()
check(
  '拖动跟手：指针上移 300px，球的上边沿同步上移 300px',
  Math.abs(beforeDrag.top - afterDrag.top - 300) < 1,
  `Δtop ${(beforeDrag.top - afterDrag.top).toFixed(2)}`,
)
check(
  '只走纵轴：右边缘恒为 20px，横坐标不动',
  Math.abs(afterDrag.right - 20) < 0.5 && Math.abs(afterDrag.left - beforeDrag.left) < 0.5,
  `left ${beforeDrag.left} -> ${afterDrag.left}, right ${afterDrag.right}`,
)
check(
  '松手时把位置写进 chrome.storage.local（一次拖动一次写入）',
  (await writes()) === writesBeforeDrag + 1 && afterDrag.stored.fabTop === Math.round(afterDrag.top),
  `${JSON.stringify(afterDrag.stored)}, 写入 ${writesBeforeDrag} -> ${await writes()}`,
)

// 夹紧：拖过头停在视口内，两端各留 20px。
await dragFab(-2000)
const clampedTop = await readFab()
check('上端夹紧：拖过头停在 20px，不会跑出视口', Math.abs(clampedTop.top - 20) < 0.5, `top ${clampedTop.top}`)
await dragFab(4000)
const clampedBottom = await readFab()
check(
  '下端夹紧：拖过头停在 视口高 - 球高 - 20',
  Math.abs(clampedBottom.top - BOTTOM_TOP) < 0.5,
  `top ${clampedBottom.top}, 期望 ${BOTTOM_TOP}`,
)

// 指针捕获 + "抓着"光标：指针横向离开球体后拖动必须继续（否则指针一飘出去
// 球就卡住），而且此时仍是 :active。
{
  const box = await readFab()
  const x = box.rect.x + box.rect.w / 2
  const y = box.rect.y + box.rect.h / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 300, y - 60, { steps: 6 })
  const held = await readFab()
  check(
    '指针捕获生效：指针横向离开球体后仍在拖动（Δtop 仍是 60）',
    Math.abs(box.top - held.top - 60) < 1 && Math.abs(held.left - box.left) < 0.5,
    `Δtop ${(box.top - held.top).toFixed(2)}, left ${box.left} -> ${held.left}`,
  )
  check('按住时是抓着光标（指针已不在球上，:active 仍跟着球）', held.cursor === 'grabbing', `cursor ${held.cursor}`)
  await page.mouse.up()
  await page.waitForTimeout(80)
}

// 重新挂载（≈ 页面刷新 / 换页）后回到记住的位置，而不是右下角。
await page.mouse.move(300, 300)
await page.evaluate(() => {
  window.__stored.fabTop = 123
})
await page.evaluate(() => window.__mountLauncher())
await page.waitForTimeout(400)
const restored = await readFab()
check('重新挂载后回到记住的位置（123），不是右下角默认值', Math.abs(restored.top - 123) < 0.5, `top ${restored.top}`)

// 视口变小要重新夹回可见范围，但**不写回存储** —— 否则一次窗口缩小就会把用户的
// 选择永久改成那个临时值，放大回去也回不来。
await dragFab(4000)
const atBottom = await readFab()
await page.setViewportSize({ width: 1680, height: 400 })
await page.waitForTimeout(200)
const narrowed = await readFab()
check(
  '视口变小时球被夹回可见范围（视口 400 -> top 336）',
  Math.abs(narrowed.top - (400 - 64)) < 0.5,
  `top ${narrowed.top}, 期望 ${400 - 64}`,
)
await page.setViewportSize({ width: 1680, height: VH })
await page.waitForTimeout(200)
const regrown = await readFab()
check(
  '夹紧不写回存储：视口放大回去后回到用户原来的位置',
  Math.abs(regrown.top - atBottom.top) < 0.5 && regrown.stored.fabTop === Math.round(atBottom.top),
  `top ${regrown.top}（期望 ${atBottom.top}）, 存储 ${JSON.stringify(regrown.stored)}`,
)

// 最后才动"点开面板"，因为那会换掉整棵树。阈值不能把正常的点击吃掉：原地点击、
// 以及手抖 1~2px，都必须照常展开。
const clickWrites = await writes()
{
  const box = await readFab()
  const x = box.rect.x + box.rect.w / 2
  const y = box.rect.y + box.rect.h / 2
  await page.mouse.click(x, y)
  await page.waitForTimeout(250)
  check('原地点击仍然展开面板（拖动没有吃掉点击）', await panelOpen(), 'panel did not open')
  check('点击不写存储（只有拖动才写）', (await writes()) === clickWrites, `写入 ${clickWrites} -> ${await writes()}`)
  await page.locator('#launcher button[title="收起"]').click()
  await page.waitForTimeout(250)
}
{
  const box = await readFab()
  const x = box.rect.x + box.rect.w / 2
  const y = box.rect.y + box.rect.h / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 1)
  await page.mouse.up()
  await page.waitForTimeout(250)
  check('手抖 1px 仍算点击（阈值 3px 之上才当拖动）', await panelOpen(), 'panel did not open')
  await page.locator('#launcher button[title="收起"]').click()
  await page.waitForTimeout(250)
}

// ── 放大：对话区铺到窗口高度的 100% / 宽度的 40%（用户 2026-09-16）──────────
// 这是面板唯一会改自身尺寸的地方，而尺寸一变就有三件只有真浏览器能证的事：
// 四道边距是否都还在（右 20、上 20、下 20，与常态同一个数）、放大后有没有被顶出
// 视口（高度写成 100vh 会让上边沿落在 -20、头部被裁 19px），以及**长会话的"跟随
// 底部"是否还在** —— 尺寸带 200ms 补间（用户 2026-10-07），过渡期间 React 不
// 提交，跟随靠 Transcript 的 ResizeObserver 逐帧吸底顶住：那条检查现在是该 RO
// 的回归钉（摘掉它，动画跑完尾巴会停在离底差几像素的位置，直到下一条分片）。
console.log('== 放大（高度 100% / 宽度 40%，上下留固定边距）==')
await page.evaluate(() => {
  window.__openPanel = true
  window.__longTranscript = true
  const fixtureRow = document.getElementById('page')
  if (fixtureRow) fixtureRow.style.display = 'none' // 夹具面板与放大后的面板会在同一片像素上
})
await page.evaluate(() => window.__mountPanel())
await page.waitForTimeout(400)

const VW = await page.evaluate(() => window.innerWidth)
const readPanel = () =>
  page.evaluate(() => {
    const panel = document.querySelector('#wide-panel')?.shadowRoot?.querySelector('.pm-panel')
    if (!panel) return null
    const rect = panel.getBoundingClientRect()
    const style = getComputedStyle(panel)
    const transcript = panel.querySelector('.pm-transcript')
    const composer = panel.querySelector('.pm-composer')
    const composerBox = composer?.getBoundingClientRect()
    return {
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      width: style.width,
      height: style.height,
      right: Number.parseFloat(style.right),
      bottom: Number.parseFloat(style.bottom),
      title: panel.querySelector('.pm-header .pm-icon-btn[title="放大"], .pm-header .pm-icon-btn[title="还原"]')?.getAttribute('title'),
      glyph: panel.querySelector('.pm-header .pm-icon-btn[title="放大"] path, .pm-header .pm-icon-btn[title="还原"] path')?.getAttribute('d')?.length ?? 0,
      headers: [...panel.querySelectorAll('.pm-header .pm-icon-btn')].map((b) => b.getAttribute('title')),
      headerTop: panel.querySelector('.pm-header')?.getBoundingClientRect().top ?? null,
      headerBottom: panel.querySelector('.pm-header')?.getBoundingClientRect().bottom ?? null,
      composerBottom: composerBox ? composerBox.bottom - rect.bottom : null,
      composerInside: composerBox ? composerBox.right <= rect.right + 0.5 && composerBox.left >= rect.left - 0.5 : false,
      scroll: transcript ? { top: transcript.scrollTop, height: transcript.scrollHeight, client: transcript.clientHeight } : null,
    }
  })

// 高度是「尽可能高」还是「刚好铺满」由一条界定：上下各留同一道固定边距。
const gaps = (p) => (p ? { top: p.rect.y, bottom: VH - (p.rect.y + p.rect.h), right: VW - (p.rect.x + p.rect.w) } : null)

// 尺寸补间的三个读取助手。中间宽度用轮询而非固定睡 N ms：读早了还在起点、读晚
// 了已经到位，轮询到「已离开起点且未到终点」才算观测到补间；超时交由 check 判
// 负，不让探针直接崩掉。settle 后才做几何断言——旧的固定 150ms 会量到补间中途。
const midFlightWidth = (from, to, timeout = 2000) =>
  page
    .waitForFunction(
      ([a, b]) => {
        const el = document.querySelector('#wide-panel')?.shadowRoot?.querySelector('.pm-panel')
        if (!el) return false
        const w = el.getBoundingClientRect().width
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        return w > lo + 0.5 && w < hi - 0.5
      },
      [from, to],
      { timeout },
    )
    .then(
      () => true,
      () => false,
    )

const waitSettled = (w, h) =>
  page
    .waitForFunction(
      ([ew, eh]) => {
        const el = document.querySelector('#wide-panel')?.shadowRoot?.querySelector('.pm-panel')
        if (!el) return false
        const r = el.getBoundingClientRect()
        return Math.abs(r.width - ew) < 0.5 && Math.abs(r.height - eh) < 0.5
      },
      [w, h],
      { timeout: 2000 },
    )
    .then(
      () => true,
      () => false,
    )

const waitAnimatingClassGone = () =>
  page
    .waitForFunction(
      () => {
        const el = document.querySelector('#wide-panel')?.shadowRoot?.querySelector('.pm-panel')
        return !!el && !el.classList.contains('pm-panel-animating')
      },
      undefined,
      { timeout: 2000 },
    )
    .then(
      () => true,
      () => false,
    )

const normal = await readPanel()
const normalGaps = gaps(normal)
check(
  '常态尺寸 380 × min(600, 100vh-40)，锚在右下 20px',
  Math.abs(normal.rect.w - 380) < 0.5 && Math.abs(normal.rect.h - 600) < 0.5 && Math.abs(normal.right - 20) < 0.5 && Math.abs(normal.bottom - 20) < 0.5,
  `${normal.rect.w}x${normal.rect.h}, right ${normal.right} / bottom ${normal.bottom}`,
)
check(
  '头部三颗按钮：新会话 / 放大 / 收起（放大在收起之前）',
  JSON.stringify(normal.headers) === JSON.stringify(['新会话', '放大', '收起']),
  normal.headers.join(' | '),
)
check(
  '放大态还没打开时按钮写的是「放大」',
  normal.title === '放大',
  `title=${normal.title}`,
)

await page.locator('#wide-panel button[title="放大"]').click()
check('放大是补间不是瞬跳（中途量到过中间宽度）', await midFlightWidth(380, VW * 0.4))
check('动画结束后过渡类被摘掉（残留会让窗口缩放跟着 tween）', await waitAnimatingClassGone())
check('尺寸到位后再做下面的几何断言', await waitSettled(VW * 0.4, VH - 40))
const wide = await readPanel()
const wideGaps = gaps(wide)
check(
  '点放大后：宽 = 窗口的 40%、高 = 窗口高 − 上下两道边距',
  Math.abs(Number.parseFloat(wide.width) - VW * 0.4) < 1 && Math.abs(Number.parseFloat(wide.height) - (VH - 40)) < 1,
  `${wide.width} x ${wide.height}（期望 ${(VW * 0.4).toFixed(0)} x ${VH - 40}）`,
)
check(
  '上下留出固定边距：上 20 / 下 20，与右边缘那道 20px 同一数值',
  Math.abs(wideGaps.top - 20) < 0.5 && Math.abs(wideGaps.bottom - 20) < 0.5 && Math.abs(wideGaps.right - 20) < 0.5,
  `上 ${wideGaps.top.toFixed(0)} / 下 ${wideGaps.bottom.toFixed(0)} / 右 ${wideGaps.right.toFixed(0)}`,
)
check(
  '上下边距与常态面板完全一致（放大只改尺寸，不改边距）',
  Math.abs(wideGaps.top - normalGaps.bottom) < 0.5 && Math.abs(wideGaps.bottom - normalGaps.bottom) < 0.5 && Math.abs(wideGaps.right - normalGaps.right) < 0.5,
  `常态 下 ${normalGaps.bottom.toFixed(0)} / 右 ${normalGaps.right.toFixed(0)} vs 放大 上 ${wideGaps.top.toFixed(0)} / 下 ${wideGaps.bottom.toFixed(0)} / 右 ${wideGaps.right.toFixed(0)}`,
)
check(
  '放大后上边沿与下边沿都留在视口内（100vh 会顶出去 20px、把头部裁掉）',
  wideGaps.top >= 0 && wideGaps.bottom >= 0 && wide.rect.x >= 0 && wide.rect.x + wide.rect.w <= VW + 0.5,
  `x ${wide.rect.x.toFixed(0)} y ${wide.rect.y.toFixed(0)}, ${wide.rect.w}x${wide.rect.h} in ${VW}x${VH}`,
)
check(
  '头部三颗按钮完整落在视口内（上边距真的留出来了）',
  !!wide.headerTop && wide.headerTop >= 0 && !!wide.headerBottom && wide.headerBottom <= VH,
  wide.headerTop === null ? 'no header' : `header ${wide.headerTop.toFixed(0)}..${wide.headerBottom.toFixed(0)} in ${VH}`,
)
check(
  '按钮换成「还原」且换了字形（一对 expand/compress，两边都是真路径）',
  wide.title === '还原' && normal.glyph > 100 && wide.glyph > 100 && wide.glyph !== normal.glyph,
  `title=${wide.title}, path ${normal.glyph} -> ${wide.glyph} chars`,
)
check(
  '两颗字形在**常态**下就已画出（不是靠宽度撑开的空 svg）',
  normal.glyph > 100,
  `常态 path ${normal.glyph} chars`,
)
check(
  '输入框跟着面板长高，仍在面板内（没被挤出底部）',
  wide.composerInside && wide.composerBottom !== null && wide.composerBottom <= 0,
  `composer 贴底 ${wide.composerBottom?.toFixed(1)}px, inside=${wide.composerInside}`,
)
check(
  '对照：夹具会话确实长到需要滚动（否则下面那条跟随检查是空转）',
  !!wide.scroll && wide.scroll.height > wide.scroll.client + 50,
  wide.scroll ? `scrollHeight ${wide.scroll.height} > clientHeight ${wide.scroll.client}` : 'no transcript',
)
check(
  '放大后长会话仍在底部（跟随底部没有因为视口变大而掉队）',
  !!wide.scroll && wide.scroll.top + wide.scroll.client >= wide.scroll.height - 2,
  wide.scroll ? `离底 ${(wide.scroll.height - wide.scroll.top - wide.scroll.client).toFixed(1)}px` : 'no transcript',
)
await page.screenshot({ path: join(SHOTS, 'panel-wide.png'), clip: { x: wide.rect.x, y: wide.rect.y, width: wide.rect.w, height: wide.rect.h } })

// 窄窗口：40vw 会小于常态的 380px，照抄 40vw 就成了"放大反而变窄"。
await page.setViewportSize({ width: 800, height: VH })
await page.waitForTimeout(150)
const narrow = await readPanel()
const narrowGaps = gaps(narrow)
check(
  '窗口窄到 40vw < 380 时宽度不缩水（max(380px, 40vw)）',
  Math.abs(narrow.rect.w - 380) < 0.5,
  `视口 800 -> 宽 ${narrow.rect.w}（40vw 只有 320）`,
)
check(
  '窗口变窄后上下边距照旧是 20（高度跟着视口走，边距不跟着变）',
  Math.abs(narrowGaps.top - 20) < 0.5 && Math.abs(narrowGaps.bottom - 20) < 0.5,
  `上 ${narrowGaps.top.toFixed(0)} / 下 ${narrowGaps.bottom.toFixed(0)}`,
)
await page.setViewportSize({ width: VW, height: VH })
await page.waitForTimeout(150)

await page.locator('#wide-panel button[title="还原"]').click()
check('还原同样是补间（中途量到过中间宽度）', await midFlightWidth(380, VW * 0.4))
check('还原后过渡类也被摘掉', await waitAnimatingClassGone())
check('尺寸到位', await waitSettled(380, 600))
const backToNormal = await readPanel()
check(
  '点还原后回到常态尺寸与「放大」字样',
  Math.abs(backToNormal.rect.w - 380) < 0.5 && Math.abs(backToNormal.rect.h - 600) < 0.5 && backToNormal.title === '放大',
  `${backToNormal.rect.w}x${backToNormal.rect.h}, title=${backToNormal.title}`,
)

// reduced-motion：媒体查询把补间整个关掉——放大必须瞬跳（量不到中间宽度），
// transitionend 永不到来，摘类落在 App 的兜底定时器（400ms）上。
await page.emulateMedia({ reducedMotion: 'reduce' })
await page.locator('#wide-panel button[title="放大"]').click()
check('prefers-reduced-motion 下没有补间（量不到中间宽度）', !(await midFlightWidth(380, VW * 0.4, 600)))
check('reduced-motion 下瞬跳到位', await waitSettled(VW * 0.4, VH - 40))
check('reduced-motion 下兜底定时器摘掉过渡类', await waitAnimatingClassGone())
await page.emulateMedia({ reducedMotion: 'no-preference' })
await page.locator('#wide-panel button[title="还原"]').click()
check('还原回常态（reduced-motion 往返不留尾巴）', await waitSettled(380, 600))

// ── 未连接横幅（真 App）：一句话术 + 四字「打开设置」不得折行 ──────────────
// 话术就一句（user 2026-10-09 裁定：诊断原因不上横幅，options 页/日志才是诊断
// 面）。右侧四字按钮此前被长 reason 挤成两行，nowrap + shrink 0 的声明仍在：
// 现在的挤压源只剩主行自身折行（span 承担），声明钉保证它不会复发。
console.log('== 未连接横幅（真 App，380px 收缩态） ==')
await page.evaluate(() => {
  window.__disconnected = true
  window.__longTranscript = false
  window.__mountPanel()
})
await page.waitForTimeout(400)

const banner = await page.evaluate(() => {
  const root = document.querySelector('#wide-panel')?.shadowRoot
  const bannerEl = root?.querySelector('.pm-banner')
  if (!bannerEl) return null
  const panelRect = root.querySelector('.pm-panel').getBoundingClientRect()
  const titleEl = bannerEl.querySelector('.pm-banner-title')
  const btnEl = bannerEl.querySelector('.pm-link')
  const btnRect = btnEl?.getBoundingClientRect()
  return {
    title: titleEl?.textContent ?? '',
    titleColor: titleEl ? getComputedStyle(titleEl).color : null,
    btnHeight: btnRect?.height ?? null,
    btnNowrap: btnEl ? getComputedStyle(btnEl).whiteSpace : null,
    btnShrink: btnEl ? getComputedStyle(btnEl).flexShrink : null,
    btnInside: btnRect ? btnRect.right <= panelRect.right + 0.5 : false,
  }
})
check('断连时真 App 画出未连接横幅与打开设置按钮', banner != null && banner.btnHeight != null, `${banner?.title} / 按钮 h=${banner?.btnHeight?.toFixed(1)}`)
check('话术就一句：请先打开桌面端并稍等片刻', banner?.title === '请先打开 PulseMind 桌面端，并稍等片刻', banner?.title)
check('主行比横幅本体深一档（0.65），提示站得出来', banner?.titleColor === 'rgba(0, 0, 0, 0.65)', banner?.titleColor)
check(
  '打开设置保持单行（flex-shrink 0 + nowrap 声明在位）',
  banner != null && banner.btnHeight <= 24 && banner.btnNowrap === 'nowrap' && banner.btnShrink === '0',
  `h=${banner?.btnHeight?.toFixed(1)}, white-space=${banner?.btnNowrap}, shrink=${banner?.btnShrink}`,
)
check('nowrap 的按钮没有把自己顶出面板', !!banner && banner.btnInside)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
