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
 *   4. 头部两行：项目名小字行 + 状态灯/会话标题/▾ 行，文字轴对齐；动作簇仅
 *      「新建会话」直钮（工作台切换无处可切）
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
const CONVS_BASE = [
  { id: OLD_CONV, title: '旧会话', pinned: false, updatedAt: '2026-10-30T09:00:01.000Z', projectId: PROJECT_ID },
  { id: NEW_CONV, title: '新会话', pinned: false, updatedAt: '2026-10-30T12:00:01.000Z', projectId: PROJECT_ID },
  { id: OUTSIDE_CONV, title: '别的项目的会话', pinned: false, updatedAt: '2026-10-30T13:00:01.000Z', projectId: 'proj_other' },
]

/** 22 older fillers so the switcher pages for real (2026-11-01 分页裁定):
 *  24 in-project rows — first page 10, one 显示更多 click 20, the next 24.
 *  All older than both originals, so the boot/watch assertions stay untouched. */
const EXTRA_CONVS = Array.from({ length: 22 }, (_, i) => ({
  id: `conv_fill_${String(i).padStart(2, '0')}`,
  title: `填充会话 ${i + 1}`,
  pinned: false,
  updatedAt: `2026-10-30T08:00:${String(59 - i).padStart(2, '0')}.000Z`,
  projectId: PROJECT_ID,
}))
const CONVS = [...CONVS_BASE, ...EXTRA_CONVS]

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
    // ── header (2026-11-01 用户裁定：两行) ──
    hasProjectSwitcher: !!document.querySelector('[data-pm-project-switcher]'),
    headerText: (document.querySelector('[data-pm-project-switcher]') || {}).innerText || '',
    projectNameText: (document.querySelector('[data-pm-project-name]') || {}).innerText || '',
    // 文字轴对齐：两行文字 span 的中心 X 之差（端槽对称后应 ≤ 1.5px）。
    titleAxisDelta: (() => {
      const cx = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return r.left + r.width / 2 }
      const a = cx('[data-pm-project-name-text]'); const b = cx('[data-pm-switcher-title]')
      return a == null || b == null ? null : Math.abs(a - b)
    })(),
    // 标题行状态灯（与切换器菜单同一张表）：state/动画名照菜单行的读法。
    headerLight: (() => {
      const el = document.querySelector('[data-pm-header-light]')
      if (!el) return null
      const dot = el.firstElementChild
      return { state: el.getAttribute('data-pm-header-light'), anim: dot ? getComputedStyle(dot).animationName : null }
    })(),
    headerActionButtons: document.querySelectorAll('[data-pm-header-actions] button').length,
    headerNewTask: !!document.querySelector('[data-pm-header-actions] button[aria-label="新建会话"]'),
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
    hasSearchPanel: !!q('[data-ws-search-panel]'),
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
      // Message ids embed the conversation id — production ids are built as
      // msg_<convId>_<ts>_<n>, so they NEVER collide across conversations.
      // The fixture must respect that: buildSegments' prefix-reuse matches
      // segments by (type, msg id), and shared ids would make a conversation
      // switch render the previous conversation's cached segment objects.
      messages: [
        { id: 'm0_' + id, role: 'user', contentBlocks: [{ type: 'text', text: '探针用户消息' }], createdAt: '2026-10-30T12:00:00.000Z' },
        { id: 'm1_' + id, role: 'assistant', contentBlocks: [{ type: 'text', text: '正文来自 ' + id }], createdAt: '2026-10-30T12:00:01.000Z' },
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
      // The draft's materialization must bind the project (2026-11-01 用户报
      // 「沉浸模式新建的会话归到了普通对话」) — record every write for the
      // draft-send section below.
      setConversationProject: (id, pid) => { (window.__projectBindings = window.__projectBindings || []).push([id, pid]); return Promise.resolve() },
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
      // The switcher's status lights fold from broadcast session events — the
      // harness captures the renderer's subscription so sections can emit.
      onAgentSessionEvent: (cb) => { (window.__sessionCbs = window.__sessionCbs || []).push(cb); return () => {} },
    }, {
      get: (target, key) => key in target
        ? target[key]
        : /^on[A-Z]/.test(key) ? () => () => {}
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /Preferences$/.test(key) ? () => Promise.resolve([])
        : () => Promise.resolve(undefined)
    })
    // Fan one status event out to every live renderer subscription.
    window.__emitSession = (evt) => { for (const cb of window.__sessionCbs || []) { try { cb(evt) } catch { /* torn subscriber */ } } }
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
await page.waitForSelector('[data-ws-search-panel]')
const searchState = await page.evaluate(() => window.__panelProbe())
check('左卡切到全文检索：整卡面板在场、目录树退场',
  searchState.hasSearchPanel && !searchState.hasTreeNow,
  `panel=${searchState.hasSearchPanel} tree=${searchState.hasTreeNow}`)
await page.fill('[data-ws-search-panel] input[aria-label="搜索内容"]', '探针')
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
// 两行形状（2026-11-01 用户裁定）：第一行 = 小字项目名（data-pm-project-name，
// 纯身份、不触发切换器），第二行 = 状态灯 + 会话标题 + ▾（data-pm-project-
// switcher，切换器触发区）。
check('头部两行 = 项目名行（小字）+ 会话标题行（灯 + 标题 + ▾）',
  state.hasProjectSwitcher && state.projectNameText.includes(PROJECT_NAME) && state.headerText.includes('新会话'),
  `switcher=${state.hasProjectSwitcher} project=${JSON.stringify(state.projectNameText)} conv=${JSON.stringify(state.headerText)}`)
check('上下两行文字轴对齐（|ΔcenterX| ≤ 1.5px，端槽对称配重）',
  state.titleAxisDelta != null && state.titleAxisDelta <= 1.5,
  `delta=${state.titleAxisDelta}`)
check('头部动作 = 仅「新建会话」直钮（工作台切换无处可切）',
  state.headerActionButtons === 1 && state.headerNewTask,
  `n=${state.headerActionButtons} new=${state.headerNewTask}`)
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

// ── 头部会话切换器：状态灯 + 分页（2026-11-01 用户裁定）──
// 状态灯读本窗口的 convLights（statusToLight）：向被挑中的会话发一条
// streaming，其菜单行带 running 灯（共享 ConversationLightDot，动画名
// conv-dot-blink——与侧栏同一张表）。分页：默认 10 行，「显示更多」每次
// +10、原地展开且不关下拉（受控 open 吞掉 menu 来源的那一次关闭）；换
// 会话照旧关闭。
await page.evaluate((id) => window.__emitSession({ sessionId: id, data: { type: 'status', status: 'streaming' } }), NEW_CONV)
await page.waitForTimeout(150)
// 标题行状态灯（2026-11-01 用户裁定「附加 icon」）：与切换器菜单行同一张表。
const litState = await page.evaluate(() => window.__projectProbe())
check('标题行状态灯亮 running（conv-dot-blink）',
  litState.headerLight?.state === 'running' && litState.headerLight?.anim === 'conv-dot-blink',
  JSON.stringify(litState.headerLight))
check('灯亮后文字轴仍对齐（槽位恒占位，亮灭都不挤文字）',
  litState.titleAxisDelta != null && litState.titleAxisDelta <= 1.5,
  `delta=${litState.titleAxisDelta}`)
await page.locator('[data-pm-project-switcher]').click()
await page.waitForSelector('.pm-switcher-dropdown .ant-dropdown-menu')
const switcherPage1 = await page.evaluate((newConv) => {
  const menu = document.querySelector('.pm-switcher-dropdown .ant-dropdown-menu')
  const more = menu.querySelector('[data-menu-id$="__more__"]')
  const gutter = menu.querySelector(`[data-menu-id$="${newConv}"] [data-pm-switcher-light]`)
  const dot = gutter ? gutter.firstElementChild : null
  return {
    // rc-menu prefixes keys: data-menu-id="rc-menu-uuid-<key>" — match the
    // conversation ids by substring, the synthetic keys by suffix.
    rows: menu.querySelectorAll('[data-menu-id*="conv_"]').length,
    hasMore: !!more,
    moreLabel: more ? more.textContent : '',
    light: gutter ? { state: gutter.getAttribute('data-pm-switcher-light'), anim: dot ? getComputedStyle(dot).animationName : null } : null,
  }
}, NEW_CONV)
check('切换器默认 10 行 + 显示更多（还有 14 条）',
  switcherPage1.rows === 10 && switcherPage1.hasMore && switcherPage1.moreLabel.includes('14'),
  `rows=${switcherPage1.rows} more=${JSON.stringify(switcherPage1.moreLabel)}`)
check('被挑中的会话 streaming → 菜单行带 running 灯（conv-dot-blink 动画）',
  switcherPage1.light?.state === 'running' && switcherPage1.light?.anim === 'conv-dot-blink',
  JSON.stringify(switcherPage1.light))

await page.locator('[data-menu-id$="__more__"]').click()
await page.waitForTimeout(400) // 若吞闭失败，此刻关闭动画已落 display:none
const menuStillOpen = await page.locator('.pm-switcher-dropdown .ant-dropdown-menu').isVisible()
const switcherPage2 = await page.evaluate(() => {
  const menu = document.querySelector('.pm-switcher-dropdown .ant-dropdown-menu')
  return {
    rows: menu.querySelectorAll('[data-menu-id*="conv_"]').length,
    moreLabel: menu.querySelector('[data-menu-id$="__more__"]')?.textContent || '',
  }
})
check('显示更多点击后下拉不关闭 + 第二页 20 行（还有 4 条）',
  menuStillOpen && switcherPage2.rows === 20 && switcherPage2.moreLabel.includes('4'),
  `open=${menuStillOpen} rows=${switcherPage2.rows} more=${JSON.stringify(switcherPage2.moreLabel)}`)

await page.locator('[data-menu-id$="__more__"]').click()
await page.waitForTimeout(200)
const switcherPage3 = await page.evaluate(() => {
  const menu = document.querySelector('.pm-switcher-dropdown .ant-dropdown-menu')
  return {
    rows: menu.querySelectorAll('[data-menu-id*="conv_"]').length,
    hasMore: !!menu.querySelector('[data-menu-id$="__more__"]'),
  }
})
check('再点一次：24 行全出、显示更多退场（依次类推到尽头）',
  switcherPage3.rows === 24 && !switcherPage3.hasMore,
  `rows=${switcherPage3.rows} more=${switcherPage3.hasMore}`)

// A real switch closes the dropdown (the swallow names __more__ only) and
// re-attaches onto the target conversation — the transcript proves the pick.
await page.locator(`[data-menu-id$="${OLD_CONV}"]`).click()
// The re-attach is content-proven: wait for the TARGET transcript body rather
// than a blind timeout (the attach is async: snapshot → seed → activate).
await page.waitForFunction((old) => (document.body.innerText || '').includes('正文来自 ' + old), OLD_CONV, { timeout: 5000 })
// 等关闭动画真正落 display:none，而不是和 leave motion 赛跑（上一拍 isVisible 仍真）。
let menuClosedAfterSwitch = true
try {
  await page.locator('.pm-switcher-dropdown .ant-dropdown-menu').waitFor({ state: 'hidden', timeout: 3000 })
} catch { menuClosedAfterSwitch = false }
const afterSwitch = await page.evaluate(() => window.__projectProbe())
check('点会话行：下拉关闭 + 切换生效（watch 末次 = 目标会话，转录验真）',
  menuClosedAfterSwitch && afterSwitch.pickedOld && !afterSwitch.pickedNew &&
    afterSwitch.watchCalls[afterSwitch.watchCalls.length - 1] === OLD_CONV,
  `closed=${menuClosedAfterSwitch} pickedOld=${afterSwitch.pickedOld} watch=${JSON.stringify(afterSwitch.watchCalls)}`)

// ── Windows/Linux: the action cluster still clears the caption-button strip ──
const winPage = await loadAndBoot(WINDOWS_CONTROLS)
const winState = await winPage.evaluate(() => window.__projectProbe())
console.log('  win32 state:', JSON.stringify(winState))
await winPage.screenshot({ path: join(SHOTS, 'project-window-win32.png') })
check('Windows/Linux：动作簇让开标题栏按钮条（≥138px）',
  winState.headerActionsGap !== null && winState.headerActionsGap >= 138,
  `gap=${winState.headerActionsGap}`)
// 2026-11-04 用户裁定两次收窄：24 → 9（「间距过大，减少 15px 左右」），再
// 9 → 0（「干脆把那 9px 也去掉」）——Win/Linux 动作簇贴住 OS 条（inset 138）。
check('Windows/Linux：动作簇与窗口按钮间距 = 0（期望 138）',
  winState.headerActionsGap === 138,
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

// ── 沉浸草稿的首条消息必须落进项目（2026-11-01 用户报「沉浸模式新建的会话
// 归到了普通对话」）──驱动一次真实发送：草稿态由 startProjectDraft 钉住
// newTaskStore + pendingProjectIdRef，handleRequest 物化行时应带着项目调
// setConversationProject（stub-insert 语义，DB 层幂等），且单写者链随即认领。
await emptyPage.fill('textarea', '探针首条消息')
await emptyPage.keyboard.press('Enter')
await emptyPage.waitForFunction(() => (window.__projectBindings || []).length > 0, undefined, { timeout: 5000 })
  .catch(() => {})
const bindings = await emptyPage.evaluate(() => window.__projectBindings || [])
const boundConv = bindings[0]?.[0] || ''
check('沉浸草稿首条消息 → setConversationProject(会话, 项目) 被调（归属随行物化）',
  bindings.length === 1 && boundConv.startsWith('conv_') && bindings[0][1] === PROJECT_ID,
  JSON.stringify(bindings))
await emptyPage.waitForFunction(() => (window.__watchCalls || []).length >= 2, undefined, { timeout: 5000 })
  .catch(() => {})
const draftWatch = await emptyPage.evaluate(() => window.__watchCalls || [])
check('物化后单写者链认领该会话（watch 末次 = 新会话 id）',
  draftWatch[draftWatch.length - 1] === boundConv && boundConv !== '',
  JSON.stringify(draftWatch))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
