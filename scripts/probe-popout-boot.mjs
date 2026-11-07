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
  // 主卡（ChatView 的 data-pm-primary-browser-card 容器）里的内容判别：三态
  // 各有一个独占标记——对话列的滚动容器、工作区的目录树列、浏览器 chrome
  // 的地址输入。dock 里也有对话列（files/browser 优先时 chatSlot 落地），
  // 所以必须 scope 到主卡内，不能全文档查。
  const main = document.querySelector('[data-pm-primary-browser-card]')
  const cycle = document.querySelector('[data-pm-primary-cycle]')
  const mine = (window.__panePushes || []).filter((p) => p.conversationId === '${CONV_ID}')
  return {
    hasTranscript: text.includes('探针助手回复正文'),
    hasUserMessage: text.includes('探针用户消息'),
    hasWelcome: text.includes('开始一段对话'),
    // welcome 页的可靠判别：WelcomeContent 的 logo 盒（文本那几处会随
    // 问候语/语言变，marker 不会）。
    hasWelcomeLogo: !!document.querySelector('[data-welcome-logo]'),
    hasComposer: !!composer,
    hasSidebar: !!document.querySelector('[data-conv-row]'),
    headerTitle,
    hasWorkbenchToggle: Array.from(document.querySelectorAll('button[aria-label]')).some((b) =>
      /侧边窗口|side pane/i.test(b.getAttribute('aria-label') || '')),
    // 会话头三态循环钮（2026-11-04 裁定：弹出窗口也要）。
    hasPrimaryCycle: !!cycle,
    cycleLabel: cycle ? (cycle.getAttribute('aria-label') || '') : '',
    mainHasTranscript: !!(main && main.querySelector('[data-pm-chat-scroll]')),
    // 文档里还有没有对话列：files/browser 优先时 chatSlot 把它搬进 dock，
    // 主卡没有但它必须仍可达（这就是「补开 dock」的意义）。
    docHasTranscript: !!document.querySelector('[data-pm-chat-scroll]'),
    mainHasTree: !!(main && main.querySelector('[data-pm-tree-column]')),
    mainHasBrowserChrome: !!(main && main.querySelector('input[placeholder="输入网址，回车打开"]')),
    // 工作台打开 = 收起按钮（title="收起工作台"）在 DOM 里；关着的
    // WorkbenchPane 返回 <></>，什么都不渲染。
    hasWorkbenchOpen: !!document.querySelector('[title="收起工作台"]'),
    // 文件页签条（工作区 tab 内）：页签文本 + 活动页签（aria-selected）。
    tabTitles: [...document.querySelectorAll('[role="tab"]')].map((t) => (t.textContent || '').trim()),
    activeTabTitle: (document.querySelector('[role="tab"][aria-selected="true"]')?.textContent || '').trim(),
    panePushes: mine.map((p) => ({ browserActive: p.browserActive, viewKind: p.viewKind })),
    // 浏览器主视图的推送契约（68 = pane 页签条 32 + 地址行 36）。卡片形态
    // （2026-11-04 两窗统一）：三个卡片 inset 必须随推送携带，原生 view 才
    // 落进主卡内容盒。
    lastPanePush: mine.length
      ? {
          chromeHeight: mine[mine.length - 1].chromeHeight,
          topInset: mine[mine.length - 1].topInset,
          bottomInset: mine[mine.length - 1].bottomInset,
          rightInset: mine[mine.length - 1].rightInset,
          paneWidth: mine[mine.length - 1].paneWidth,
          browserActive: mine[mine.length - 1].browserActive,
        }
      : null,
    // 卡片形态实测（2026-11-04 用户裁定「弹出独立弹窗应与主窗统一——圆角矩形
    // 包裹主交互区和右侧边窗口」）：主卡相对内容区底衬（antd Layout，即
    // colorBgLayout）的四边内距、圆角、边框，以及底衬本身的颜色（灰底才让
    // 白卡读成卡——弹窗此前铺的是 --pm-bg，白上白）。
    cardBox: (() => {
      const el = document.querySelector('[data-pm-primary-browser-card]')
      const ground = el && el.closest('.ant-layout')
      if (!el || !ground) return null
      const r = el.getBoundingClientRect()
      const g = ground.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        left: Math.round(r.left - g.left),
        top: Math.round(r.top - g.top),
        bottom: Math.round(g.bottom - r.bottom),
        radius: cs.borderTopLeftRadius,
        borderWidth: cs.borderTopWidth,
        background: cs.backgroundColor,
        groundBg: getComputedStyle(ground).backgroundColor,
        // 绝对矩形（跨卡对照用：对话卡右缘 ↔ 工作台卡左缘 = 列间 gap）
        abs: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) },
        groundBottom: Math.round(g.bottom),
      }
    })(),
    // 工作台卡（卡形态的兄弟列，拖拽手柄的父节点）：只在侧边窗口开着时存在。
    // 与对话卡之间应当只剩列间 gap 5（两张卡的 5px 外壳边距各归各）。
    paneCard: (() => {
      const handle = document.querySelector('[data-pm-pane-drag-handle]')
      const el = handle && handle.parentElement
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        radius: cs.borderTopLeftRadius,
        borderWidth: cs.borderTopWidth,
      }
    })(),
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
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.web.json',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
  treeShaking: false,
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
const APP_GLOBAL_CSS = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]

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
    // window.__NO_MESSAGES__ = 空会话（welcome 门控组要一个零消息会话：
    // 头部循环钮必须不出现）。
    const MESSAGES = window.__NO_MESSAGES__ ? [] : ${JSON.stringify(MESSAGES)}
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
async function loadAndBoot(controls, harness = 'popout', search = '?popout=' + CONV_ID, seed = null, noMessages = false) {
  const page = await browser.newPage({ viewport: { width: 640, height: 820 } })
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.addInitScript(
    ([c, h, s, n]) => {
      window.__CONTROLS__ = c
      window.__HARNESS__ = h
      window.__SEED__ = s
      window.__NO_MESSAGES__ = n
    },
    [controls, harness, seed, noMessages],
  )
  await page.route('http://pm-popout.local/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: PAGE_HTML,
    }),
  )
  await page.goto('http://pm-popout.local/' + search)
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction(() => window.__ready)
  await page.waitForTimeout(1200) // let the snapshot→mirror→activate boot settle
  return page
}

/** The header action button's live metrics — footprint, corner radius, symbol
 *  colour and (after a real hover) the fill. All computed styles: this is what
 *  the user actually sees, not what the stylesheet claims. `index` selects
 *  which button in the cluster (0 = the mode-cycle button since 2026-11-04,
 *  1 = the workbench toggle) — both wear the same class, these checks pin that. */
async function measureActionButton(page, index = 0) {
  const sel = '[data-pm-header-actions] button'
  const base = await page.evaluate(
    ([s, i]) => {
      const el = document.querySelectorAll(s)[i]
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        width: Math.round(r.width),
        height: Math.round(r.height),
        radius: cs.borderTopLeftRadius,
        symbol: cs.color,
      }
    },
    [sel, index],
  )
  if (!base) return null
  // page.hover() did not reliably land the :hover state before the style read
  // (measured: transparent here, correct fill from a plain mouse.move + a
  // beat) — move explicitly and let the recalc settle.
  const box = await page.locator(sel).nth(index).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(200)
  const hoverBg = await page.evaluate(
    ([s, i]) => {
      const el = document.querySelectorAll(s)[i]
      return el ? getComputedStyle(el).backgroundColor : null
    },
    [sel, index],
  )
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

// ── 卡片形态（2026-11-04 用户裁定「弹出独立弹窗应与主窗统一——圆角矩形包裹
// 主交互区和右侧边窗口」）──
// 主窗的那套卡片语言原样落到弹窗：对话卡四周 5px 内距、圆角 8、1px
// separator-faint 全边框，底衬是 antd Layout 的 colorBgLayout（白卡只有落在
// 灰底上才读成卡）。
const cardBox = state.cardBox
check(
  '卡片形态：对话卡四周 5px 内距（与主窗同一张卡的几何）',
  !!cardBox && cardBox.left === 5 && cardBox.top === 5 && cardBox.bottom === 5,
  JSON.stringify(cardBox),
)
check('卡片形态：圆角 8 + 1px 全边框', !!cardBox && cardBox.radius === '8px' && cardBox.borderWidth === '1px', JSON.stringify(cardBox))
check(
  '卡片形态：内容区底衬 = antd colorBgLayout 灰（#f7f7f8，卡 = 白）',
  !!cardBox && cardBox.background === 'rgb(255, 255, 255)' && cardBox.groundBg === 'rgb(247, 247, 248)',
  JSON.stringify(cardBox),
)
// macOS: traffic lights on the LEFT → the action cluster needs only the
// header's own 24px padding on the right.
check('macOS：动作簇右边距 = 常规 24px（交通灯在左，右边自由）', state.headerActionsGap === 24, `gap=${state.headerActionsGap}`)
// macOS keeps the app's own rounded icon button (no caption neighbours).
const macBtn = await measureActionButton(page)
check('macOS：保持应用自身的圆角图标按钮（28×28, r6）', macBtn.width === 28 && macBtn.height === 28 && macBtn.radius === '6px', JSON.stringify(macBtn))
const macToggleBtn = await measureActionButton(page, 1)
check(
  'macOS：循环钮与工作台开关同规格（同 class、同一行观感一致）',
  !!macToggleBtn &&
    macToggleBtn.width === macBtn.width &&
    macToggleBtn.height === macBtn.height &&
    macToggleBtn.radius === macBtn.radius &&
    macToggleBtn.symbol === macBtn.symbol,
  `${JSON.stringify(macBtn)} vs ${JSON.stringify(macToggleBtn)}`,
)

// ── 会话头三态循环钮（2026-11-04 裁定「弹出的独立弹窗，也需要切换按钮」）──
// 真点击驱动 chat → files → browser → chat。判别一律 scope 到主卡
// （[data-pm-primary-browser-card]）：files/browser 优先时对话列会被 chatSlot
// 搬进 dock，全文档查 [data-pm-chat-scroll] 会假阳。
check(
  '弹出窗口也有模式循环钮（有消息的会话）',
  state.hasPrimaryCycle && state.mainHasTranscript,
  `cycle=${state.hasPrimaryCycle} mainTranscript=${state.mainHasTranscript}`,
)
check('循环钮文案 = 当前模式（对话视图）', /对话视图/.test(state.cycleLabel), `label=${state.cycleLabel}`)
check(
  '循环钮排在动作簇首位（工作台开关之前）',
  await page.evaluate(() => document.querySelector('[data-pm-header-actions] button')?.hasAttribute('data-pm-primary-cycle') === true),
)

await page.click('[data-pm-primary-cycle]')
await page.waitForTimeout(600)
const filesState = await page.evaluate(() => window.__popoutProbe())
console.log('  files state:', JSON.stringify({ tree: filesState.mainHasTree, open: filesState.hasWorkbenchOpen, tabs: filesState.tabTitles }))
await page.screenshot({ path: join(SHOTS, 'popout-files.png') })
check(
  '点击 1 → 主卡 = 工作区（目录树列在主卡内、对话列不在主卡）',
  filesState.mainHasTree && !filesState.mainHasTranscript,
  `tree=${filesState.mainHasTree} mainTranscript=${filesState.mainHasTranscript}`,
)
check(
  '点击 1 → dock 补开且对话列搬进 dock（主卡没有、文档里仍可达）',
  filesState.hasWorkbenchOpen && filesState.docHasTranscript && !filesState.mainHasTranscript,
  `open=${filesState.hasWorkbenchOpen} doc=${filesState.docHasTranscript} main=${filesState.mainHasTranscript}`,
)
check('点击 1 → 文案随模式（工作区视图）', /工作区视图/.test(filesState.cycleLabel), `label=${filesState.cycleLabel}`)

await page.click('[data-pm-primary-cycle]')
await page.waitForTimeout(600)
const browserState = await page.evaluate(() => window.__popoutProbe())
console.log('  browser state:', JSON.stringify({ chrome: browserState.mainHasBrowserChrome, push: browserState.lastPanePush }))
await page.screenshot({ path: join(SHOTS, 'popout-browser.png') })
check(
  '点击 2 → 主卡 = 浏览器 chrome（地址输入在场、工作区树退场）',
  browserState.mainHasBrowserChrome && !browserState.mainHasTree,
  `chrome=${browserState.mainHasBrowserChrome} tree=${browserState.mainHasTree}`,
)
const bp = browserState.lastPanePush
// 右内距 = reserve（dock 开着时 = clamp 后的 pane 宽）+ 卡边距 5：切到浏览器
// 主视图前循环钮已经把 dock 补开（点击 1 的断言），所以这里必然 > 5——只有
// dock 关着才是纯卡边距。上/下恒为 5 + 1px 卡边框。
check(
  '点击 2 → 推送契约：chromeHeight 68（无工作台页签条）+ 卡片 insets（弹窗套卡）',
  !!bp && bp.chromeHeight === 68 && bp.topInset === 6 && bp.bottomInset === 6 && bp.rightInset > 5 && bp.browserActive === true,
  JSON.stringify(bp),
)
check('点击 2 → 文案随模式（浏览器视图）', /浏览器视图/.test(browserState.cycleLabel), `label=${browserState.cycleLabel}`)

await page.click('[data-pm-primary-cycle]')
await page.waitForTimeout(600)
const chatState = await page.evaluate(() => window.__popoutProbe())
await page.screenshot({ path: join(SHOTS, 'popout-chat-cycle.png') })
check(
  '点击 3 → 回到对话主卡（transcript 回主卡、树/地址栏退场）',
  chatState.mainHasTranscript && !chatState.mainHasTree && !chatState.mainHasBrowserChrome,
  `transcript=${chatState.mainHasTranscript} tree=${chatState.mainHasTree}`,
)
check('点击 3 → 文案回到对话视图', /对话视图/.test(chatState.cycleLabel), `label=${chatState.cycleLabel}`)
check('绕一圈：dock 仍开着（回 chat 不动开合，标准 chat+dock 态）', chatState.hasWorkbenchOpen)

// welcome 门控：零消息会话的头部只留工作台开关（没有可换的视图）。
const emptyPage = await loadAndBoot(DARWIN_CONTROLS, 'popout', '?popout=' + CONV_ID, null, true)
const emptyState = await emptyPage.evaluate(() => window.__popoutProbe())
check(
  '零消息会话：welcome 面不出现循环钮（门控与主窗同款）',
  emptyState.hasWelcomeLogo && !emptyState.hasPrimaryCycle,
  `welcomeLogo=${emptyState.hasWelcomeLogo} cycle=${emptyState.hasPrimaryCycle}`,
)
check('零消息会话：工作台开关仍在（头部不是空簇）', emptyState.hasWorkbenchToggle)

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
check(
  '种子组A：预览文件页签条复原（两个页签都在）',
  seedState.tabTitles.includes('notes.md') && seedState.tabTitles.includes('report.md'),
  JSON.stringify(seedState.tabTitles),
)
check('种子组A：活动页签 = donor 的选中文件（report.md）', seedState.activeTabTitle === 'report.md', `active=${seedState.activeTabTitle}`)
check(
  '种子组A：本会话 pane 推送 browserActive:false（工作区 tab）',
  seedState.panePushes.length > 0 && seedState.panePushes.every((p) => p.browserActive === false && p.viewKind === 'chat'),
  JSON.stringify(seedState.panePushes),
)
// 两张卡的分列关系（2026-11-04 两窗统一）：工作台也是一张同款圆角卡，
// 与对话卡之间只剩列间 gap 5；两者上下同高（同一行的两张卡）。
const chatCard = seedState.cardBox
const paneCard = seedState.paneCard
check(
  '种子组A：工作台也是同款圆角卡（r8 + 1px 边框，与对话卡齐平）',
  !!paneCard &&
    paneCard.radius === '8px' &&
    paneCard.borderWidth === '1px' &&
    !!chatCard &&
    paneCard.top === chatCard.abs.top &&
    chatCard.groundBottom - paneCard.bottom === 5,
  `${JSON.stringify(paneCard)} vs ${JSON.stringify(chatCard)}`,
)
check(
  '种子组A：两卡之间只剩列间 gap 5（对话卡右缘 ↔ 工作台卡左缘）',
  !!paneCard && !!chatCard && paneCard.left - chatCard.abs.right === 5,
  `pane.left=${paneCard && paneCard.left} chat.right=${chatCard && chatCard.abs.right}`,
)

const browserSeedPage = await loadAndBoot(DARWIN_CONTROLS, 'popout-seed', '?popout=' + CONV_ID, { workbenchTab: 'browser' })
const browserSeedState = await browserSeedPage.evaluate(() => window.__popoutProbe())
check(
  '种子组B：工作台开在浏览器 tab 且推送 browserActive:true',
  browserSeedState.hasWorkbenchOpen &&
    browserSeedState.panePushes.length > 0 &&
    browserSeedState.panePushes.every((p) => p.browserActive === true && p.viewKind === 'chat'),
  JSON.stringify(browserSeedState.panePushes),
)

// ── 主视图模式种子（2026-11-04 裁定「对话在主窗是什么视图模式，弹出独立弹窗
// 后要保持一致」）：primaryByConversation 是每窗一份的内存态，弹窗只能靠 donor
// seed 继承。组C 文件优先（主卡=工作区树、对话列搬进 dock）、组D 浏览器优先
// （主卡=浏览器 chrome、原生视图推送 browserActive:true）。两组的循环钮文案也
// 必须是模式本身——那就是「这一窗确实从该模式开机」的可视证据。
const filesPrimaryPage = await loadAndBoot(DARWIN_CONTROLS, 'popout-seed', '?popout=' + CONV_ID, {
  primary: 'files',
  // 循环钮切到文件优先后 dock 落在 chat tab（该模式的自然态）：那里正是
  // chatSlot 的落点，对话列在侧栏仍可达。
  workbenchTab: 'chat',
})
const filesPrimary = await filesPrimaryPage.evaluate(() => window.__popoutProbe())
console.log('  files-primary:', JSON.stringify({ cycle: filesPrimary.cycleLabel, tree: filesPrimary.mainHasTree, dock: filesPrimary.hasWorkbenchOpen }))
await filesPrimaryPage.screenshot({ path: join(SHOTS, 'popout-files-primary.png') })
check(
  '种子组C（文件优先）：主卡 = 工作区树，循环钮文案 = 工作区视图',
  filesPrimary.mainHasTree && !filesPrimary.mainHasTranscript && /工作区视图/.test(filesPrimary.cycleLabel),
  `tree=${filesPrimary.mainHasTree} mainTranscript=${filesPrimary.mainHasTranscript} label=${filesPrimary.cycleLabel}`,
)
check(
  '种子组C：dock 随模式补开，对话列搬进侧栏仍可达（chatSlot）',
  filesPrimary.hasWorkbenchOpen && filesPrimary.docHasTranscript,
  `open=${filesPrimary.hasWorkbenchOpen} docTranscript=${filesPrimary.docHasTranscript}`,
)

const browserPrimaryPage = await loadAndBoot(DARWIN_CONTROLS, 'popout-seed', '?popout=' + CONV_ID, {
  primary: 'browser',
})
const browserPrimary = await browserPrimaryPage.evaluate(() => window.__popoutProbe())
console.log('  browser-primary:', JSON.stringify({ cycle: browserPrimary.cycleLabel, chrome: browserPrimary.mainHasBrowserChrome }))
await browserPrimaryPage.screenshot({ path: join(SHOTS, 'popout-browser-primary.png') })
check(
  '种子组D（浏览器优先）：主卡 = 浏览器 chrome，循环钮文案 = 浏览器视图',
  browserPrimary.mainHasBrowserChrome && !browserPrimary.mainHasTranscript && /浏览器视图/.test(browserPrimary.cycleLabel),
  `chrome=${browserPrimary.mainHasBrowserChrome} label=${browserPrimary.cycleLabel}`,
)
check(
  '种子组D：原生视图推送 browserActive:true（主卡即浏览器）',
  browserPrimary.panePushes.length > 0 && browserPrimary.panePushes.every((p) => p.browserActive === true),
  JSON.stringify(browserPrimary.panePushes),
)

check('种子组：会话区滚动条在底部（首水合走 switch 落底 + bottom-pin）', seedState.chatAtBottom === true, `atBottom=${seedState.chatAtBottom}`)
check('对照组：会话区滚动条同样在底部', state.chatAtBottom === true, `atBottom=${state.chatAtBottom}`)

check('对照组：无种子时工作台保持关（默认行为不变）', !state.hasWorkbenchOpen)
check(
  '对照组：无种子时本会话推送 browserActive:false',
  state.panePushes.length > 0 && state.panePushes.every((p) => p.browserActive === false),
  JSON.stringify(state.panePushes),
)

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
// …and hugs it: the app's own gutter beside the caption buttons is 0 — the two
// clusters read as ONE row of caption buttons (2026-11-04 rulings: 先减 15px，
// 随后「干脆把那 9px 也去掉」).
check('Windows/Linux：动作簇与窗口按钮间距 = 0（inset 138 即右偏移）', winState.headerActionsGap === 138, `gap=${winState.headerActionsGap} (期望 138)`)
// …and it wears the caption-button look: the same 46×56 strip the OS draws its
// own min/max/close in (titleBarOverlay.height = TITLE_BAR_HEIGHT), square
// corners, with the neutral hover fill the native buttons use.
const winBtn = await measureActionButton(winPage)
check(
  'Windows/Linux：动作按钮 = 46×56 无圆角（与原生标题栏按钮同规格）',
  winBtn.width === 46 && winBtn.height === 56 && winBtn.radius === '0px',
  JSON.stringify(winBtn),
)
check('Windows/Linux：悬停填灰（贴近原生标题栏按钮的悬停）', /rgba?\(229, 229, 229/.test(winBtn.hoverBg || ''), `hoverBg=${winBtn.hoverBg}`)
check('Windows/Linux：符号色 = OS 描画色（#333333 → rgb(51, 51, 51)）', winBtn.symbol === 'rgb(51, 51, 51)', `symbol=${winBtn.symbol}`)

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
check(
  '两个按钮盒子同尺寸',
  pair.length === 2 && pair[0].box[0] === pair[1].box[0] && pair[0].box[1] === pair[1].box[1],
  pair.map((p) => p.box.join('×')).join(' vs '),
)
check(
  '两个按钮的图标墨迹等高（±1px，观感等大）',
  pair.length === 2 && Math.abs(pair[0].ink[1] - pair[1].ink[1]) <= 1,
  pair.map((p) => p.ink && p.ink.join('×')).join(' vs '),
)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
