/**
 * Project (immersive) window boot probe (real Chromium) — 项目窗口的 UI 级验收。
 *
 * 单测钉住纯逻辑与 wiring（?project 解析、clamp、watch 广播调点、三处守卫）；
 * 这一段补上唯一没被钉住的环节：PopoutApp 在 **project 模式**下真渲染 —— 挂载
 * 真实组件树，在最小 electronAPI stub 下驱动「列项目会话 → 选最新 → snapshot
 * 镜像 → 激活」的启动序，断言三栏到位且工作台确实不在：
 *   1. 左栏 explorer 在场（目录树 + 地址栏），宽度 = clamp 后的持久值
 *   2. 对话列在场（转录正文 + composer），且它右边的宽度 ≥ chat 下限
 *   3. 工作台 pane 不在 DOM（hideWorkbench —— 否则它的绝对定位会盖住对话列）
 *   4. 头部 = 项目名牌 + 会话切换器，且没有工作台切换按钮
 *   5. 启动挑的是项目里 updatedAt 最新的会话（快照按 id 内容区分，能验真）
 *   6. 当前会话已通过 secondaryWatch 报给主进程（单写者链的入口）
 *   7. 头部动作簇仍让开 OS 标题栏按钮条（Windows/Linux 138px）
 *
 * Usage: node scripts/probe-project-window.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-project-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-project-window-shots')
const PROJECT_ID = 'proj_20261030120000'
const PROJECT_NAME = '探针项目'
const WS_DIR = '/pm-probe-project-ws'
/** The project row the stub serves — with an explicit hue so the send-button
 *  accent is deterministic (projectStore must carry it for the composer). */
const PROJECT = { id: PROJECT_ID, name: PROJECT_NAME, workspaceDir: WS_DIR, colorHue: 210, createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z' }
// Two conversations in the project, deliberately ordered so the OLDER name
// comes first in the list: only an updatedAt sort can pick the newer one.
const OLD_CONV = 'conv_20261030090000'
const NEW_CONV = 'conv_20261030120000'
const OUTSIDE_CONV = 'conv_20261030130000'

const DARWIN_CONTROLS = { side: 'left', inset: 70 }
const WINDOWS_CONTROLS = { side: 'right', inset: 138 }

/** Conversation rows exactly as the std listConversations shape carries them
 *  (id/title/pinned/updatedAt/projectId). OUTSIDE_CONV is newer than both but
 *  belongs to another project — it must NOT be picked. */
const CONVS = [
  { id: OLD_CONV, title: '旧会话', pinned: false, updatedAt: '2026-10-30T09:00:01.000Z', projectId: PROJECT_ID },
  { id: NEW_CONV, title: '新会话', pinned: false, updatedAt: '2026-10-30T12:00:01.000Z', projectId: PROJECT_ID },
  { id: OUTSIDE_CONV, title: '别的项目的会话', pinned: false, updatedAt: '2026-10-30T13:00:01.000Z', projectId: 'proj_other' },
]

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { App as AntdApp } from 'antd'
import { PopoutApp } from './src/renderer/src/popout/PopoutApp'

createRoot(document.getElementById('root')).render(
  <AntdApp component={false}><PopoutApp projectId='${PROJECT_ID}' /></AntdApp>
)

/** Rendered ink of an icon — same helper the popout probe uses (kept for the
 *  header-action geometry checks). */
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

window.__projectProbe = () => {
  const text = document.body.innerText || ''
  const r = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null }
  const explorer = r('[data-pm-explorer-column]')
  const chat = r('[data-pm-chat-column]')
  const actions = r('[data-pm-header-actions]')
  const treeCol = r('[data-pm-tree-column]')
  const tabstrip = r('[data-ws-tabstrip-row]')
  const previewCard = r('[data-pm-preview-column]')
  // 卡片化（2026-10-31 用户裁定）：圆角读 computed style，间距读矩形差。
  const radiusOf = (sel) => {
    const el = document.querySelector(sel)
    return el ? Number(getComputedStyle(el).borderTopLeftRadius.replace('px', '')) : null
  }
  return {
    // ── three columns ──
    hasExplorer: !!explorer,
    hasTree: !!document.querySelector('.pm-ws-tree'),
    // 2026-10-31 用户裁定：地址栏整行退场，页签条收进预览列（不再跨树列），
    // 预览动作由条右端的 ⋯ 承接。
    hasAddressBar: !!document.querySelector('[data-ws-address]'),
    hasTabStrip: !!tabstrip,
    hasStripActions: !!document.querySelector('[data-ws-strip-actions]'),
    tabstripLeft: tabstrip ? Math.round(tabstrip.left) : null,
    treeColumnRight: treeCol ? Math.round(treeCol.right) : null,
    hasExplorerHandle: !!document.querySelector('[data-pm-explorer-drag-handle]'),
    explorerWidth: explorer ? Math.round(explorer.width) : null,
    // ── cards（2026-10-31 圆角矩形裁定）──
    hasPreviewCard: !!previewCard,
    treeCardLeft: treeCol ? Math.round(treeCol.left) : null,
    treeCardRight: treeCol ? Math.round(treeCol.right) : null,
    treeCardRadius: radiusOf('[data-pm-tree-column]'),
    previewCardLeft: previewCard ? Math.round(previewCard.left) : null,
    previewCardRadius: radiusOf('[data-pm-preview-column]'),
    chatCardLeft: chat ? Math.round(chat.left) : null,
    chatCardRight: chat ? Math.round(chat.right) : null,
    chatCardRadius: radiusOf('[data-pm-chat-column]'),
    explorerRight: explorer ? Math.round(explorer.right) : null,
    // ── 三面板切换器（2026-10-31）──
    hasLeftSwitcher: !!document.querySelector('[data-pm-left-panel-switcher]'),
    hasRightSwitcher: !!document.querySelector('[data-pm-right-panel-switcher]'),
    // ── conversation column ──
    hasComposer: !!document.querySelector('textarea'),
    chatWidth: chat ? Math.round(chat.width) : null,
    // The picked conversation proves itself by CONTENT: each snapshot's body
    // names its own id, so a wrong pick cannot pass.
    pickedNew: text.includes('正文来自 ${NEW_CONV}'),
    pickedOld: text.includes('正文来自 ${OLD_CONV}'),
    pickedOutside: text.includes('正文来自 ${OUTSIDE_CONV}'),
    // ── workbench must be absent (hideWorkbench) ──
    hasWorkbenchPane: !!document.querySelector('[data-pm-pane-drag-handle]'),
    hasTaskSwitcher: !!document.querySelector('[data-welcome-switcher]'),
    // ── header ──
    hasProjectSwitcher: !!document.querySelector('[data-pm-project-switcher]'),
    headerText: (document.querySelector('[data-pm-project-switcher]') || {}).innerText || '',
    headerActionButtons: document.querySelectorAll('[data-pm-header-actions] button').length,
    headerActionsGap: actions ? Math.round(window.innerWidth - actions.right) : null,
    // ── single-writer entry ──
    watchCalls: window.__watchCalls || [],
    innerWidth: window.innerWidth,
  }
}
/** 三面板交互态（2026-10-31）：切换后的 DOM 形态 + 主进程收到的最后一次
 *  pane 状态推送（browserActive/insets/paneWidth 都在推送里验）。 */
window.__panelProbe = () => {
  const q = (sel) => document.querySelector(sel)
  const chatPanel = q('[data-pm-panel-chat]')
  return {
    searchVariant: q('[data-ws-search-panel]')?.getAttribute('data-ws-search-variant') ?? null,
    hasTreeNow: !!q('.pm-ws-tree'),
    hasSearchHit: !!q('[data-ws-search-hit]'),
    tabStripTabs: document.querySelectorAll('[data-ws-tabstrip-row] [data-tab-path]').length,
    hasBrowserPanel: !!q('[data-pm-panel-browser]'),
    hasPlanPanel: !!q('[data-pm-panel-plan]'),
    hasBrowserEmpty: !!q('[data-pm-panel-browser] [data-pm-empty]'),
    hasBrowserAddress: !!q('[data-pm-panel-browser] input[placeholder="输入网址，回车打开"]'),
    hasChatPanel: !!chatPanel,
    chatPanelDisplay: chatPanel ? getComputedStyle(chatPanel).display : null,
    hasComposer: !!q('textarea'),
    lastPaneState: (window.__paneStateCalls || []).slice(-1)[0] ?? null,
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

const APP_GLOBAL_CSS = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
  .match(/<style>([\s\S]*?)<\/style>/)[1]

const PAGE_HTML = `<!doctype html><html><head><style>
    :root { --pm-bg:#ffffff; --pm-bg-container:#ffffff; --pm-text:#141414; --pm-text-muted:#8c8c8c;
      --pm-ink:#141414; --pm-link:#1677ff; --pm-border-hairline:#f0f0f0; --pm-hover:#f5f5f5; --pm-hover-strong:#ececec;
      --pm-hover-weak:#fafafa; --pm-warn:#faad14; --pm-success:#52c41a; --pm-error:#f5222d; --pm-row-ink:#141414;
      --pm-text-faint:#d9d9d9; --pm-separator-faint:#f0f0f0; --pm-pop-border:#f0f0f0; --pm-border-soft:#f0f0f0;
      --pm-ws-created:#1a7f37; --pm-ws-modified:#9a6700; --pm-elevated:#ffffff; --pm-tile-soft:#f5f5f5;
      --pm-shadow-chip:none; --pm-shadow-soft:none; --pm-badge-muted:#bfbfbf; --pm-text-quiet:#8c8c8c;
      --pm-text-strong:#141414; --pm-text-secondary:#595959; --pm-text-disabled:#bfbfbf; --pm-text-body:#141414;
      --pm-scrollbar:#d9d9d9; --pm-veil:rgba(255,255,255,.6); }
    ${APP_GLOBAL_CSS}
  </style><script>
    const CONVS = ${JSON.stringify(CONVS)}
    window.__watchCalls = []
    // Each conversation's snapshot names its own id in the body, so the probe
    // can tell WHICH conversation booted rather than merely that one did.
    const snapshotFor = (id) => ({
      messages: [
        { id: 'm0', role: 'user', contentBlocks: [{ type: 'text', text: '探针用户消息' }], createdAt: '2026-10-30T12:00:00.000Z' },
        { id: 'm1', role: 'assistant', contentBlocks: [{ type: 'text', text: '正文来自 ' + id }], createdAt: '2026-10-30T12:00:01.000Z' },
      ],
      status: { status: 'completed' }, streamingBlocks: [], plan: null, fileChanges: [],
    })
    let lastSession = null
    window.electronAPI = new Proxy({
      getSettings: () => Promise.resolve({
        activeProfileId: 'p1',
        profiles: [{ id: 'p1', name: '探针模型', provider: 'anthropic', model: 'probe-model', maxTokens: 8192, baseURL: '', apiKey: 'sk-probe' }],
        theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '${WS_DIR}',
        autoCleanup: true, locale: 'zh',
      }),
      getWindowControls: () => (window.__CONTROLS__ || { side: 'left', inset: 70 }),
      getPlatformInfo: () => Promise.resolve({ platform: 'darwin' }),
      listConversations: () => Promise.resolve(window.__SCENARIO__ === 'empty' ? [] : CONVS),
      projectGet: () => Promise.resolve({ id: '${PROJECT_ID}', name: '${PROJECT_NAME}', workspaceDir: '${WS_DIR}', createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z' }),
      projectList: () => Promise.resolve([${JSON.stringify(PROJECT)}]),
      agentSessionCreate: (opts) => { lastSession = (opts && opts.conversationId) || null; return Promise.resolve({ sessionId: lastSession || '${NEW_CONV}', agentId: 'default', workspaceDir: '${WS_DIR}' }) },
      agentSessionSnapshot: (id) => Promise.resolve(snapshotFor(id)),
      secondaryWatch: (sessionId) => { window.__watchCalls.push(sessionId); return Promise.resolve() },
      hydrateConversation: (id) => Promise.resolve({ messages: snapshotFor(id).messages, title: '探针会话', historySummary: '', historySummaryFrontier: '' }),
      // The explorer's tree needs a directory listing to render rows at all.
      listDir: () => Promise.resolve({ entries: [
        { name: 'src', path: '${WS_DIR}/src', isDir: true },
        { name: 'README.md', path: '${WS_DIR}/README.md', isDir: false },
      ] }),
      readFile: () => Promise.resolve('探针文件内容'),
      expertList: () => Promise.resolve([]),
      knowledgeListBases: () => Promise.resolve([]),
      getModelState: () => Promise.resolve({ profiles: [], activeId: 'p1' }),
      // ── 三面板（2026-10-31）：pane 状态记录 + rg 命中一条 + 浏览器历史空表 ──
      browserPaneSetState: (s) => { (window.__paneStateCalls = window.__paneStateCalls || []).push(s); return Promise.resolve() },
      browserPaneSetWidth: () => Promise.resolve(),
      browserPaneAction: () => Promise.resolve(),
      browserHistoryQuery: () => Promise.resolve([]),
      searchWorkspace: () => Promise.resolve({ ok: true, lines: ['${WS_DIR}/README.md:1:探针文件内容'], truncated: false }),
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

async function loadAndBoot(controls, viewport = { width: 1440, height: 900 }, scenario = 'main') {
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.addInitScript(([c, s]) => { window.__CONTROLS__ = c; window.__SCENARIO__ = s }, [controls, scenario])
  await page.route('http://pm-project.local/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: PAGE_HTML,
  }))
  await page.goto('http://pm-project.local/?project=' + PROJECT_ID)
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction(() => window.__ready)
  await page.waitForTimeout(1400) // list → pick latest → snapshot → activate
  return page
}

const page = await loadAndBoot(DARWIN_CONTROLS)
const state = await page.evaluate(() => window.__projectProbe())
console.log('  state:', JSON.stringify(state))
await page.screenshot({ path: join(SHOTS, 'project-window.png'), fullPage: false })

// ── the three columns ──
check('左栏 explorer 在场（目录树 + 中列页签条；地址栏已退场）',
  state.hasExplorer && state.hasTree && state.hasTabStrip && state.hasStripActions && !state.hasAddressBar,
  `explorer=${state.hasExplorer} tree=${state.hasTree} tabstrip=${state.hasTabStrip} stripActions=${state.hasStripActions} addressBar=${state.hasAddressBar}`)
check('页签条收进中列（左缘越过树列右缘进入卡内）',
  state.tabstripLeft !== null && state.treeColumnRight !== null && state.tabstripLeft >= state.treeColumnRight + 3,
  `tabstrip.left=${state.tabstripLeft} tree.right=${state.treeColumnRight}`)
// 卡片化（2026-10-31 用户裁定「三列各用圆角矩形包裹，与边缘、互相之间都留
// 5px」）：树↔预览与 explorer↔chat 的间隙、窗口左右缘的内缩、三卡圆角。
check('卡间距 = 5px（树↔预览、explorer↔chat）',
  state.previewCardLeft - state.treeCardRight === 5 && state.chatCardLeft - state.explorerRight === 5,
  `tree↔preview=${state.previewCardLeft - state.treeCardRight} explorer↔chat=${state.chatCardLeft - state.explorerRight}`)
check('窗口边缘内缩 = 5px（左缘、右缘）',
  state.treeCardLeft === 5 && Math.abs(state.chatCardRight - state.innerWidth) === 5,
  `left=${state.treeCardLeft} rightInset=${state.innerWidth - state.chatCardRight}`)
check('三卡圆角 = 8px',
  state.treeCardRadius === 8 && state.previewCardRadius === 8 && state.chatCardRadius === 8,
  `tree=${state.treeCardRadius} preview=${state.previewCardRadius} chat=${state.chatCardRadius}`)
check('explorer 分隔手柄在场（可拖宽）', state.hasExplorerHandle)
// Default 760, clamped against a 1440−360=1080 ceiling → 760 stands (the +1 is
// the column's own border-right, which getBoundingClientRect includes).
check('explorer 宽度 = 持久默认 760（未被 clamp 压缩）',
  state.explorerWidth !== null && Math.abs(state.explorerWidth - 760) <= 1, `w=${state.explorerWidth}`)
check('对话列在场（转录正文渲染）', state.hasComposer && state.pickedNew, `composer=${state.hasComposer} pickedNew=${state.pickedNew}`)
check('对话列宽度 ≥ 360 下限', state.chatWidth !== null && state.chatWidth >= 360, `w=${state.chatWidth}`)
check('左右卡面板切换器在场（2026-10-31 三面板裁定）', state.hasLeftSwitcher && state.hasRightSwitcher,
  `left=${state.hasLeftSwitcher} right=${state.hasRightSwitcher}`)

// ── 三面板切换链（2026-10-31：左 目录树|全文检索，右 对话|浏览器|工作计划）──
// 纯 Chromium 探针驱动不了原生 WebContentsView——浏览器面板验的是 chrome
// DOM + pane 状态推送；原生 view 落位（insets 像素级对齐）只有 Electron 实跑可见。
await page.locator('[data-pm-left-panel-switcher] [data-panel-id="search"]').click()
await page.waitForSelector('[data-ws-search-variant="panel"]')
const searchState = await page.evaluate(() => window.__panelProbe())
check('左卡切到全文检索：整卡面板在场、目录树退场',
  searchState.searchVariant === 'panel' && !searchState.hasTreeNow,
  `variant=${searchState.searchVariant} tree=${searchState.hasTreeNow}`)
await page.fill('[data-ws-search-variant="panel"] input[aria-label="搜索内容"]', '探针')
await page.waitForSelector('[data-ws-search-hit]')
check('全文检索命中行渲染（stub rg 返回 README.md:1）', true)
await page.locator('[data-ws-search-hit]').first().click()
await page.waitForTimeout(400)
const hitState = await page.evaluate(() => window.__panelProbe())
check('命中点击 → 中卡预览页签打开（文件页联动免费）', hitState.tabStripTabs >= 1, `tabs=${hitState.tabStripTabs}`)
await page.locator('[data-pm-left-panel-switcher] [data-panel-id="tree"]').click()
await page.waitForSelector('.pm-ws-tree')

await page.locator('[data-pm-right-panel-switcher] [data-panel-id="plan"]').click()
await page.waitForSelector('[data-pm-panel-plan]')
check('右卡切到工作计划：面板在场', (await page.evaluate(() => window.__panelProbe())).hasPlanPanel)

await page.locator('[data-pm-right-panel-switcher] [data-panel-id="browser"]').click()
await page.waitForSelector('[data-pm-panel-browser]')
const browserState = await page.evaluate(() => window.__panelProbe())
check('右卡切到浏览器：chrome 空态 + 地址栏在场',
  browserState.hasBrowserPanel && browserState.hasBrowserEmpty && browserState.hasBrowserAddress,
  `panel=${browserState.hasBrowserPanel} empty=${browserState.hasBrowserEmpty} address=${browserState.hasBrowserAddress}`)
check('浏览器在前 → pane 推送 browserActive=true + 卡片 insets(38/5/6) + paneWidth 直通',
  browserState.lastPaneState?.browserActive === true &&
    browserState.lastPaneState?.topInset === 38 &&
    browserState.lastPaneState?.rightInset === 5 &&
    browserState.lastPaneState?.bottomInset === 6 &&
    (browserState.lastPaneState?.paneWidth ?? 0) > 0,
  JSON.stringify(browserState.lastPaneState))
check('对话面板保活隐藏（display:none，流式/composer 状态不丢）',
  browserState.hasChatPanel && browserState.chatPanelDisplay === 'none',
  `display=${browserState.chatPanelDisplay}`)

await page.locator('[data-pm-right-panel-switcher] [data-panel-id="chat"]').click()
await page.waitForTimeout(200)
const chatBack = await page.evaluate(() => window.__panelProbe())
check('切回对话：composer 回归 + pane 推送 browserActive=false',
  chatBack.hasComposer && chatBack.lastPaneState?.browserActive === false && chatBack.chatPanelDisplay !== 'none',
  `composer=${chatBack.hasComposer} active=${chatBack.lastPaneState?.browserActive}`)

// The clamp is a RENDER-time consumption, not just a drag-time one: a window
// too narrow for the stored 760 must squeeze the explorer, never the chat.
// (The chat reads one pixel under its nominal floor because the explorer
// column's own 1px border-right is inside the row — the same off-by-one the
// pre-existing tree↔preview clamp carries.)
// The session sidebar eats into the row first, so this scenario COLLAPSES it
// via the header toggle — collapse is exactly the narrow-window escape hatch.
const narrow = await loadAndBoot(DARWIN_CONTROLS, { width: 900, height: 760 })
// explorer 的 clamp 依赖 ResizeObserver 带回的行宽，等它落定再量。
// 卡片化（2026-10-31）后行宽口径：900 − 四周 padding 2×5 − explorer↔chat gap 5
// = 可分给 explorer+chat 的 885；explorer 上限 = 885 − 360（对话下限）= 525。
await narrow.waitForFunction(() => {
  const el = document.querySelector('[data-pm-explorer-column]')
  return el && Math.abs(el.getBoundingClientRect().width - (900 - 360 - 15)) <= 2
})
const narrowState = await narrow.evaluate(() => window.__projectProbe())
console.log('  narrow state:', JSON.stringify({ explorerWidth: narrowState.explorerWidth, chatWidth: narrowState.chatWidth }))
check('窄窗（侧栏收起后）explorer 被 clamp 到 (row − 360 − 卡片间距 15)，对话列守住 360',
  Math.abs((narrowState.explorerWidth ?? 0) - (900 - 360 - 15)) <= 1 && (narrowState.chatWidth ?? 0) >= 359,
  `explorer=${narrowState.explorerWidth} chat=${narrowState.chatWidth}`)

// ── the workbench must NOT dock in this window ──
check('工作台 pane 不在 DOM（hideWorkbench：否则会盖住对话列）', !state.hasWorkbenchPane)
check('欢迎表单的任务切换器不在（项目已钉住，不给逃出项目的口子）', !state.hasTaskSwitcher)

// ── the header ──
check('头部 = 项目名牌 + 会话切换器', state.hasProjectSwitcher && state.headerText.includes(PROJECT_NAME),
  `switcher=${state.hasProjectSwitcher} text=${JSON.stringify(state.headerText)}`)
check('头部没有工作台切换按钮（无处可切）', state.headerActionButtons === 0, `n=${state.headerActionButtons}`)
check('macOS：动作簇右边距 = 常规 24px', state.headerActionsGap === 24, `gap=${state.headerActionsGap}`)

// ── boot picked the project's LATEST conversation ──
check('启动挑的是项目内 updatedAt 最新的会话', state.pickedNew && !state.pickedOld, `new=${state.pickedNew} old=${state.pickedOld}`)
check('别的项目里更新的会话没有被挑走', !state.pickedOutside)

// ── single-writer entry ──
check('当前会话已报给主进程（secondaryWatch 的末次调用 = 被挑中的会话）',
  state.watchCalls[state.watchCalls.length - 1] === NEW_CONV,
  JSON.stringify(state.watchCalls))

// 输入区宽度帽（2026-10-30 用户裁定「输入区的宽度太大」）：composer 卡不超过 640。
const senderWidth = await page.locator('.ant-sender').first().evaluate((el) => el.getBoundingClientRect().width)
check('输入区 composer 卡 ≤ 640（沉浸窗口的宽度帽）', senderWidth <= 641, `w=${Math.round(senderWidth)}`)
// 发送按钮的项目配色：accent 类在场（没加载项目 store 时恒是中性 .pm-send）。
check('发送按钮带项目 accent（.pm-accent-send 在场）', !!(await page.locator('.pm-accent-send').count()))

// ── Windows/Linux: the action cluster still clears the caption-button strip ──
const winPage = await loadAndBoot(WINDOWS_CONTROLS)
const winState = await winPage.evaluate(() => window.__projectProbe())
console.log('  win32 state:', JSON.stringify(winState))
await winPage.screenshot({ path: join(SHOTS, 'project-window-win32.png') })
check('Windows/Linux：动作簇让开标题栏按钮条（≥138px）',
  winState.headerActionsGap !== null && winState.headerActionsGap >= 138,
  `gap=${winState.headerActionsGap}`)

// ── 空项目 → 草稿面（2026-10-30 用户裁定「新建会话不需要 welcome 页面」）──
// 没有会话可接时走草稿：输入框上方只放一段提示文字，欢迎页的 logo/问候/
// 建议/项目卡一台机器都不该进来。
const emptyPage = await loadAndBoot(DARWIN_CONTROLS, { width: 1440, height: 900 }, 'empty')
await emptyPage.waitForTimeout(600) // 草稿路径：list → 空 → startProjectDraft
const emptyState = await emptyPage.evaluate((projectName) => {
  const text = document.body.innerText || ''
  return {
    hasHint: !!document.querySelector('[data-pm-draft-hint]'),
    hintHasName: text.includes(projectName),
    hintHasTitle: text.includes('开始新任务'),
    // welcome 页的副标题（WelcomeContent 独有）——出现即说明整页进来了。
    hasWelcomeSubtitle: text.includes('每一次脉动'),
    hasTaskSwitcher: !!document.querySelector('[data-welcome-switcher]'),
    hasComposer: !!document.querySelector('textarea'),
    watchCalls: window.__watchCalls || [],
  }
}, PROJECT_NAME)
console.log('  empty state:', JSON.stringify(emptyState))
await emptyPage.screenshot({ path: join(SHOTS, 'project-window-draft.png') })
check('空项目走草稿面：提示块在场且带项目名',
  emptyState.hasHint && emptyState.hintHasName && emptyState.hintHasTitle,
  `hint=${emptyState.hasHint} name=${emptyState.hintHasName} title=${emptyState.hintHasTitle}`)
check('welcome 页没进来（副标题与任务切换器都不在）',
  !emptyState.hasWelcomeSubtitle && !emptyState.hasTaskSwitcher,
  `subtitle=${emptyState.hasWelcomeSubtitle} switcher=${emptyState.hasTaskSwitcher}`)
check('composer 照常在底部', emptyState.hasComposer)
const draftGeom = await emptyPage.evaluate(() => {
  const sender = document.querySelector('.ant-sender')
  const col = document.querySelector('[data-pm-chat-column]')
  if (!sender || !col) return { error: 'missing' }
  const sr = sender.getBoundingClientRect()
  const cr = col.getBoundingClientRect()
  return {
    sender: { left: Math.round(sr.left), right: Math.round(sr.right), width: Math.round(sr.width) },
    column: { left: Math.round(cr.left), right: Math.round(cr.right), width: Math.round(cr.width) },
    maxW: getComputedStyle(sender).maxWidth,
  }
})
console.log('  draft geometry:', JSON.stringify(draftGeom))
check('composer 卡完全在对话列内（右缘不越窗）',
  !draftGeom.error && draftGeom.sender.right <= draftGeom.column.right + 1 && draftGeom.sender.left >= draftGeom.column.left - 1,
  JSON.stringify(draftGeom.sender || draftGeom))
check('…composer wrapper 也不再越列（border-box 生效）',
  !draftGeom.error && draftGeom.sender.right <= draftGeom.column.right + 1,
  `wrapper 链见 geometry`)
check('草稿无会话 id：watch 末次为 null',
  emptyState.watchCalls[emptyState.watchCalls.length - 1] === null,
  JSON.stringify(emptyState.watchCalls))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
