/**
 * Popout boot probe (real Chromium) — PLAN-conversation-popout 的 UI 级验收。
 *
 * 单测钉住的是纯逻辑与 wiring（boot 参数解析、可测的 store/引擎分支、三层
 * 扫描）；这一段补上唯一没被钉住的环节：PopoutApp 真渲染——挂载真实组件树，
 * 在最小 electronAPI stub 下驱动 snapshot→镜像→激活的启动序，断言「弹出窗口
 * 是精简的会话视图而不是整个工作台」：
 *   1. 转录正文渲染（对话内容在，不是欢迎页）
 *   2. composer 在场（全功能的发送面）
 *   3. 头部标题 = 会话标题（携带 popout 名牌）
 *   4. 右侧工作台切换按钮在场（用户裁定「携带配套右边侧边窗口」）
 *   5. 主窗的侧栏/欢迎页不在（这是第二个窗口，不是 AppLayout）
 *   6. 头部动作簇让开 OS 窗口按钮：Windows/Linux 把标题栏按钮画在右侧
 *      ~138px（原生层盖在网页之上，戳进去的按钮既看不见也点不到），
 *      动作簇的右缘必须落在该条之外；macOS 交通灯在左、右边距仅为常规 24。
 *
 * Usage: node scripts/probe-popout-boot.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-popout-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-popout-shots')
const CONV_ID = 'conv_20261030120000'
const CONV_TITLE = '弹出窗口探针会话'

/** The OS-controls layouts the two sides must reserve for (see
 *  shared/window-chrome.ts resolveWindowControlsLayout). */
const DARWIN_CONTROLS = { side: 'left', inset: 70 }
const WINDOWS_CONTROLS = { side: 'right', inset: 138 }

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import { PopoutApp } from './src/renderer/src/popout/PopoutApp'
import { applyPopoutSeed } from './src/renderer/src/popout/seed'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

const root = createRoot(document.getElementById('root'))
const which = window.__HARNESS__ || 'popout'

// 2026-10-31 裁定「弹出携带侧边窗口的打开状态」: 种子 harness 复刻 main.tsx
// 的契约 — 在 React 挂载之前把 donor seed 播种进本窗口的两个 store。
if (which === 'popout-seed') applyPopoutSeed('${CONV_ID}', window.__SEED__ || null)

if (which !== 'applayout') {
  // 会话区落底（2026-10-31 裁定）的诚实断言需要「落底之后内容继续长高」：
  // 静态内容下一次性 rAF 与落底+bottom-pin 都停在同一处。在 ready 后 150ms
  // 注入 1500px —— 落在 pin 窗口（500ms 静默 / 3s 帽）内，落底路径会被钉在
  // 底，无 pin 路径停在半途。
  setTimeout(() => {
    const el = document.querySelector('[data-pm-chat-scroll]')
    if (el) {
      const late = document.createElement('div')
      late.style.height = '1500px'
      late.textContent = '晚到内容'
      el.appendChild(late)
    }
  }, 150)
}

if (which === 'applayout') {
  // The MAIN window's header (AppLayout) — mounted to compare the action pair
  // (side-pane toggle + popout), which the popout window only half carries.
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AntdApp component={false}>
            <AppLayout
              conversations={[{ key: '${CONV_ID}', label: '${CONV_TITLE}', pinned: false, updatedAt: '2026-10-30T12:00:01.000Z' }]}
              activeConversationKey="${CONV_ID}"
              totalSessions={1}
              autoCleanup={true}
              onCreateNew={() => {}}
              onDeleteConversation={() => {}}
              onRenameConversation={() => {}}
              onSelectConversation={() => {}}
              onTogglePinConversation={() => {}}
              onPopoutConversation={() => {}}
              onFocusPoppedConversation={() => {}}
            ><div /></AppLayout>
          </AntdApp>
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
} else {
  root.render(<AntdApp component={false}><PopoutApp convId='${CONV_ID}' /></AntdApp>)
}

/** Rendered ink of an icon: the SVG's geometry bounds (stroke included) mapped
 *  through its screen CTM — the pixels the user actually sees. Two icons in
 *  one row can share a 14px box and still read as different sizes (that is
 *  exactly what the padded 0..24 viewBox did). */
const inkOf = (svg) => {
  if (!svg) return null
  const bb = svg.getBBox()
  const m = svg.getScreenCTM()
  const corners = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
    .map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(m); return [p.x, p.y] })
  const xs = corners.map((p) => p[0]); const ys = corners.map((p) => p[1])
  const stroke = Number(svg.getAttribute('stroke-width') || 0) * Math.hypot(m.a, m.b)
  return [Math.max(...xs) - Math.min(...xs) + stroke, Math.max(...ys) - Math.min(...ys) + stroke]
}

window.__headerPair = () => [...document.querySelectorAll('[data-pm-header-actions] button')].map((b) => {
  const r = b.getBoundingClientRect()
  const ink = inkOf(b.querySelector('svg'))
  return {
    label: b.getAttribute('aria-label'),
    box: [Math.round(r.width), Math.round(r.height)],
    ink: ink ? ink.map((v) => Math.round(v * 10) / 10) : null,
  }
})

window.__popoutProbe = () => {
  const text = document.body.innerText || ''
  const composer = document.querySelector('textarea')
  const headerTitle = Array.from(document.querySelectorAll('span'))
    .map((s) => s.textContent || '')
    .find((t) => t === '${CONV_TITLE}') || ''
  const actions = document.querySelector('[data-pm-header-actions]')
  const rect = actions ? actions.getBoundingClientRect() : null
  return {
    hasTranscript: text.includes('探针助手回复正文'),
    hasUserMessage: text.includes('探针用户消息'),
    hasWelcome: text.includes('开始一段对话'),
    hasComposer: !!composer,
    hasSidebar: !!document.querySelector('[data-conv-row]'),
    headerTitle,
    hasWorkbenchToggle: Array.from(document.querySelectorAll('button[aria-label]')).some((b) =>
      /侧边窗口|side pane/i.test(b.getAttribute('aria-label') || '')),
    // 工作台打开 = 收起按钮（title="收起工作台"）在 DOM 里；关着的
    // WorkbenchPane 返回 <></>，什么都不渲染。
    hasWorkbenchOpen: !!document.querySelector('[title="收起工作台"]'),
    // 文件页签条（工作区 tab 内）：页签文本 + 活动页签（aria-selected）。
    tabTitles: [...document.querySelectorAll('[role="tab"]')].map((t) => (t.textContent || '').trim()),
    activeTabTitle: (document.querySelector('[role="tab"][aria-selected="true"]')?.textContent || '').trim(),
    panePushes: (window.__panePushes || []).filter((p) => p.conversationId === '${CONV_ID}')
      .map((p) => ({ browserActive: p.browserActive, viewKind: p.viewKind })),
    // 会话区滚动位置（2026-10-31 裁定「会话区滚动条滚动到底部」）：距底
    // < 100px 视为在底部（与 ChatView 的 nearBottom 阈值同口径）。
    chatAtBottom: (() => {
      const el = document.querySelector('[data-pm-chat-scroll]')
      if (!el || !el.scrollHeight) return null
      return el.scrollHeight - el.scrollTop - el.clientHeight < 100
    })(),
    headerActionsGap: rect ? Math.round(window.innerWidth - rect.right) : null,
    innerWidth: window.innerWidth,
  }
}
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

const MESSAGES = [
  { id: 'm0', role: 'user', contentBlocks: [{ type: 'text', text: '探针用户消息' }], createdAt: '2026-10-30T12:00:00.000Z' },
  { id: 'm1', role: 'assistant', contentBlocks: [{ type: 'text', text: '探针助手回复正文' }], createdAt: '2026-10-30T12:00:01.000Z' },
]

/** The app's global stylesheet, lifted out of src/renderer/index.html (heads-up
 *  the harness below) — both windows load that file, so this is the shipped
 *  CSS, not a copy. */
const APP_GLOBAL_CSS = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
  .match(/<style>([\s\S]*?)<\/style>/)[1]

const PAGE_HTML = `<!doctype html><html><head><style>
    :root { --pm-bg:#ffffff; --pm-bg-container:#ffffff; --pm-text:#141414; --pm-text-muted:#8c8c8c;
      --pm-ink:#141414; --pm-link:#1677ff; --pm-border-hairline:#f0f0f0; --pm-hover:#f5f5f5; --pm-hover-strong:#ececec;
      --pm-warn:#faad14; --pm-success-status:#52c41a; --pm-error-status:#f5222d; --pm-row-ink:#141414;
      --pm-text-faint:#d9d9d9; --pm-separator-faint:#f0f0f0; --pm-ws-created:#1a7f37; --pm-ws-modified:#9a6700; }
    /* The app's REAL global stylesheet, inlined verbatim (it lives inside
       src/renderer/index.html, so it cannot be imported): this is what makes
       the .header-pane-btn / .pm-caption-btn assertions below measure shipped
       rules rather than a copy that could drift. */
    ${APP_GLOBAL_CSS}
  </style><script>
    // Minimal electronAPI: the boot reads settings + snapshot + conversation
    // list, then streams nothing. Unknown methods resolve harmlessly.
    // window.__CONTROLS__ is injected per page load (addInitScript) so the
    // same bundle can be measured under both OS-controls layouts — the module
    // reads getWindowControls() once, at load.
    const MESSAGES = ${JSON.stringify(MESSAGES)}
    const CONVS = [{ id: '${CONV_ID}', title: '${CONV_TITLE}', pinned: false, updatedAt: '2026-10-30T12:00:01.000Z' }]
    window.electronAPI = new Proxy({
      browserPaneSetState: (state) => { (window.__panePushes = window.__panePushes || []).push(state) },
      popoutSeed: () => Promise.resolve(window.__SEED__ || null),
      getSettings: () => Promise.resolve({
        activeProfileId: 'p1',
        profiles: [{ id: 'p1', name: '探针模型', provider: 'anthropic', model: 'probe-model', maxTokens: 8192, baseURL: '', apiKey: 'sk-probe' }],
        theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '/pm-probe-ws',
        autoCleanup: true, locale: 'zh',
      }),
      getWindowControls: () => (window.__CONTROLS__ || { side: 'left', inset: 70 }),
      getPlatformInfo: () => Promise.resolve({ platform: 'darwin' }),
      listConversations: () => Promise.resolve(CONVS),
      agentSessionCreate: () => Promise.resolve({ sessionId: '${CONV_ID}', agentId: 'default', workspaceDir: '/pm-probe-ws' }),
      agentSessionSnapshot: () => Promise.resolve({
        messages: MESSAGES, status: { status: 'completed' }, streamingBlocks: [], plan: null, fileChanges: [],
      }),
      hydrateConversation: () => Promise.resolve({ messages: MESSAGES, title: '${CONV_TITLE}', historySummary: '', historySummaryFrontier: '' }),
      expertList: () => Promise.resolve([]),
      knowledgeListBases: () => Promise.resolve([]),
      getModelState: () => Promise.resolve({ profiles: [], activeId: 'p1' }),
      modelState: () => Promise.resolve({ profiles: [], activeId: 'p1' }),
    }, {
      get: (target, key) => key in target
        ? target[key]
        : /^on[A-Z]/.test(key) ? () => () => {}
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /Preferences$/.test(key) ? () => Promise.resolve([])
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root"></div></body></html>`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })

/** Fresh page per OS-controls layout (getWindowControls is read at load). */
async function loadAndBoot(controls, harness = 'popout', search = '?popout=' + CONV_ID, seed = null) {
  const page = await browser.newPage({ viewport: { width: 640, height: 820 } })
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.addInitScript(([c, h, s]) => { window.__CONTROLS__ = c; window.__HARNESS__ = h; window.__SEED__ = s }, [controls, harness, seed])
  await page.route('http://pm-popout.local/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: PAGE_HTML,
  }))
  await page.goto('http://pm-popout.local/' + search)
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction(() => window.__ready)
  await page.waitForTimeout(1200) // let the snapshot→mirror→activate boot settle
  return page
}

/** The header action button's live metrics — footprint, corner radius, symbol
 *  colour and (after a real hover) the fill. All computed styles: this is what
 *  the user actually sees, not what the stylesheet claims. */
async function measureActionButton(page) {
  const sel = '[data-pm-header-actions] button'
  const base = await page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      radius: cs.borderTopLeftRadius,
      symbol: cs.color,
    }
  }, sel)
  if (!base) return null
  // page.hover() did not reliably land the :hover state before the style read
  // (measured: transparent here, correct fill from a plain mouse.move + a
  // beat) — move explicitly and let the recalc settle.
  const box = await page.locator(sel).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(200)
  const hoverBg = await page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? getComputedStyle(el).backgroundColor : null
  }, sel)
  return { ...base, hoverBg }
}

const page = await loadAndBoot(DARWIN_CONTROLS)
const state = await page.evaluate(() => window.__popoutProbe())
console.log('  state:', JSON.stringify(state))
await page.screenshot({ path: join(SHOTS, 'popout.png') })

check('转录正文渲染（快照启动序生效）', state.hasTranscript && state.hasUserMessage, `transcript=${state.hasTranscript} user=${state.hasUserMessage}`)
check('composer 在场（全功能发送面）', state.hasComposer)
check('头部标题 = 会话标题', state.headerTitle === CONV_TITLE, `title=${JSON.stringify(state.headerTitle)}`)
check('右侧工作台切换按钮在场（携带配套侧边窗口）', state.hasWorkbenchToggle)
check('主窗侧栏/欢迎页不在（这是第二个窗口）', !state.hasSidebar && !state.hasWelcome, `sidebar=${state.hasSidebar} welcome=${state.hasWelcome}`)
// macOS: traffic lights on the LEFT → the action cluster needs only the
// header's own 24px padding on the right.
check('macOS：动作簇右边距 = 常规 24px（交通灯在左，右边自由）', state.headerActionsGap === 24, `gap=${state.headerActionsGap}`)
// macOS keeps the app's own rounded icon button (no caption neighbours).
const macBtn = await measureActionButton(page)
check('macOS：保持应用自身的圆角图标按钮（28×28, r6）',
  macBtn.width === 28 && macBtn.height === 28 && macBtn.radius === '6px',
  JSON.stringify(macBtn))

// ── 侧边窗口打开态种子（2026-10-31 裁定「弹出携带侧边窗口的打开状态」）──
// 种子组 A（工作区 + 文件页签）：工作台首帧即开、页签条复原、活动页签命中、
// 本会话 pane 推送 browserActive:false（工作区 tab 本来就不激活原生视图）。
// 种子组 B（浏览器）：pane 推送 browserActive:true — 主进程据此把原生视图
// 跨 dock re-parent 到弹窗。对照组：无种子维持关 — 默认行为不回归。
const seedPage = await loadAndBoot(DARWIN_CONTROLS, 'popout-seed', '?popout=' + CONV_ID, {
  workbenchTab: 'workspace',
  previewPaths: ['/pm-probe-ws/notes.md', '/pm-probe-ws/report.md'],
  activePreviewPath: '/pm-probe-ws/report.md',
})
const seedState = await seedPage.evaluate(() => window.__popoutProbe())
console.log('  seed state:', JSON.stringify({ open: seedState.hasWorkbenchOpen, tabs: seedState.tabTitles, active: seedState.activeTabTitle }))
await seedPage.screenshot({ path: join(SHOTS, 'popout-seeded.png') })
check('种子组A：工作台首帧即开（收起按钮在场）', seedState.hasWorkbenchOpen)
check('种子组A：预览文件页签条复原（两个页签都在）',
  seedState.tabTitles.includes('notes.md') && seedState.tabTitles.includes('report.md'),
  JSON.stringify(seedState.tabTitles))
check('种子组A：活动页签 = donor 的选中文件（report.md）', seedState.activeTabTitle === 'report.md', `active=${seedState.activeTabTitle}`)
check('种子组A：本会话 pane 推送 browserActive:false（工作区 tab）',
  seedState.panePushes.length > 0 && seedState.panePushes.every((p) => p.browserActive === false && p.viewKind === 'chat'),
  JSON.stringify(seedState.panePushes))

const browserSeedPage = await loadAndBoot(DARWIN_CONTROLS, 'popout-seed', '?popout=' + CONV_ID, { workbenchTab: 'browser' })
const browserSeedState = await browserSeedPage.evaluate(() => window.__popoutProbe())
check('种子组B：工作台开在浏览器 tab 且推送 browserActive:true',
  browserSeedState.hasWorkbenchOpen && browserSeedState.panePushes.length > 0
    && browserSeedState.panePushes.every((p) => p.browserActive === true && p.viewKind === 'chat'),
  JSON.stringify(browserSeedState.panePushes))

check('种子组：会话区滚动条在底部（首水合走 switch 落底 + bottom-pin）',
  seedState.chatAtBottom === true, `atBottom=${seedState.chatAtBottom}`)
check('对照组：会话区滚动条同样在底部', state.chatAtBottom === true, `atBottom=${state.chatAtBottom}`)

check('对照组：无种子时工作台保持关（默认行为不变）', !state.hasWorkbenchOpen)
check('对照组：无种子时本会话推送 browserActive:false',
  state.panePushes.length > 0 && state.panePushes.every((p) => p.browserActive === false),
  JSON.stringify(state.panePushes))

// ── Windows/Linux: the action cluster must clear the caption-button strip ──
const winPage = await loadAndBoot(WINDOWS_CONTROLS)
const winState = await winPage.evaluate(() => window.__popoutProbe())
console.log('  win32 state:', JSON.stringify(winState))
await winPage.screenshot({ path: join(SHOTS, 'popout-win32.png') })
check(
  'Windows/Linux：动作簇让开标题栏按钮条（138px，右缘不侵入）',
  winState.headerActionsGap !== null && winState.headerActionsGap >= 138,
  `gap=${winState.headerActionsGap} (需要 ≥138)`,
)
// …and it wears the caption-button look: the same 46×56 strip the OS draws its
// own min/max/close in (titleBarOverlay.height = TITLE_BAR_HEIGHT), square
// corners, with the neutral hover fill the native buttons use.
const winBtn = await measureActionButton(winPage)
check('Windows/Linux：动作按钮 = 46×56 无圆角（与原生标题栏按钮同规格）',
  winBtn.width === 46 && winBtn.height === 56 && winBtn.radius === '0px',
  JSON.stringify(winBtn))
check('Windows/Linux：悬停填灰（贴近原生标题栏按钮的悬停）',
  /rgba?\(229, 229, 229/.test(winBtn.hoverBg || ''),
  `hoverBg=${winBtn.hoverBg}`)
check('Windows/Linux：符号色 = OS 描画色（#333333 → rgb(51, 51, 51)）',
  winBtn.symbol === 'rgb(51, 51, 51)',
  `symbol=${winBtn.symbol}`)

// ── The MAIN window's header pair must read as one row ──
// User report 2026-10-30「怎么感觉右上角两个按钮不一样大」: the two button
// BOXES were identical (28×28) while the hand-drawn pane glyph rendered
// visibly smaller than the antd export icon — a padded 0..24 viewBox left the
// ink at 11.7×10.5px against 12.5×12.5px at the same 14px box. The fix is a
// tight viewBox; these checks pin the outcome (equal boxes + equal ink height).
const appPage = await loadAndBoot(DARWIN_CONTROLS, 'applayout')
const pair = await appPage.evaluate(() => window.__headerPair())
console.log('  header pair:', JSON.stringify(pair))
await appPage.screenshot({ path: join(SHOTS, 'app-header.png') })
check('主窗头部动作簇有两个按钮（工作台开关 + 弹出）', pair.length === 2, `n=${pair.length}`)
check('两个按钮盒子同尺寸',
  pair.length === 2 && pair[0].box[0] === pair[1].box[0] && pair[0].box[1] === pair[1].box[1],
  pair.map((p) => p.box.join('×')).join(' vs '))
check('两个按钮的图标墨迹等高（±1px，观感等大）',
  pair.length === 2 && Math.abs(pair[0].ink[1] - pair[1].ink[1]) <= 1,
  pair.map((p) => p.ink && p.ink.join('×')).join(' vs '))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
