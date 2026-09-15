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

/** The 模型下拉 inventory — the shape session.list carries (id/name/provider/model,
 *  no credentials). The second profile has deliberately no name, and a long model
 *  id: the shared modelLabel falls back to 'provider:model' for it, which is also
 *  what exercises the label's truncation instead of assuming it.
 *
 *  Declared out here (not inside the harness) so the checks below can name the
 *  fallback label; interpolated into the harness as data. */
const MODEL = {
  profiles: [
    { id: 'p1', name: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
    { id: 'p2', provider: 'deepseek', model: 'deepseek-chat-with-a-deliberately-long-name' },
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
        <button className="pm-icon-btn" title="历史会话"><Icon name="menu" /></button>
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
  const long = items[1]
  return {
    labels: items.map((i) => i.textContent.trim()),
    insidePanel: Math.round(rect.left) >= Math.round(panel.left) - 1 && Math.round(rect.right) <= Math.round(panel.right) + 1,
    aboveButton: rect.bottom <= btn.top + 1,
    // The long label is clipped by CSS, not by the panel.
    longClipped: long.scrollWidth > long.clientWidth,
    longOverflowsPanel: long.getBoundingClientRect().right > panel.right + 1,
  }
})
check(
  '模型菜单列的是设置里的 profiles（无 name 的退回 provider:model）',
  modelMenu.labels.join('|') === `GPT-4o|${FALLBACK_LABEL}`,
  modelMenu.labels.join('|'),
)
check('模型菜单整个落在面板内、并朝上展开', modelMenu.insidePanel && modelMenu.aboveButton, `inside=${modelMenu.insidePanel}, above=${modelMenu.aboveButton}`)
check('过长的模型名在菜单项里截断而不是撑破面板', modelMenu.longClipped && !modelMenu.longOverflowsPanel, `clipped=${modelMenu.longClipped}, overflow=${modelMenu.longOverflowsPanel}`)

// 选中后按钮文案跟着换：两边同一个 modelLabel，不能一处显示 name、另一处显示 id。
await page.evaluate(() => window.__panels()[0].querySelectorAll('.pm-model-item')[1].click())
await page.waitForTimeout(150)
const afterSwitch = await page.evaluate(() => ({
  label: window.__panels()[0].querySelector('.pm-model-label')?.textContent,
  menuGone: !window.__panels()[0].querySelector('.pm-model-menu'),
}))
check('选中后按钮文案换成同一个 label，且菜单关闭', afterSwitch.label === FALLBACK_LABEL && afterSwitch.menuGone, `${afterSwitch.label} / menuGone=${afterSwitch.menuGone}`)

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
check('all five state panels mounted', panelCount === 5, `${panelCount} panels`)

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
  return {
    chips: [...root.querySelectorAll('.pm-chip-choice')].map((c) => c.textContent.trim()),
    confirmHidden: !root.querySelector('.pm-ask .pm-cmd-btn-primary'),
    hasCustomInput: !!root.querySelector('.pm-ask-input'),
  }
})
check('ask_user renders its choices as chips with a custom-answer box', asking.chips.length === 4 && asking.hasCustomInput, asking.chips.join('/'))
check('multi-select confirm appears only after a pick', asking.confirmHidden)

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

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (failed.length > 0) {
  console.error('failed:', failed.map((f) => f.name).join(' | '))
  process.exit(1)
}
