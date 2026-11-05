/**
 * 视图模式 probe (real Chromium + real mouse/keyboard) — PLAN-layout-modes
 * 二期（「模式跟任务走」）：没有全局切换器；welcome 任务表单选「浏览器」=
 * URL 输入 + 近期访问历史，提交即物化浏览器任务（该会话浏览器优先）。
 *
 * Source scans pin the wiring; this probe pins what only a real mount shows:
 *   1. welcome 三档切换器 + browser 快捷区（URL 输入 + 历史项真点击/回车），
 *      提交走 onBrowserTaskStart 且 URL 归一化。
 *   1.45 历史卡高度贴合内容（2026-11-05）：少历史不撑满至底部，多历史收缩
 *      自滚 + 页面零滚动。
 *   2. 浏览器任务的布局：主卡 = 浏览器 chrome（行高 68 实测），dock = 对话/
 *      工作区/计划，推送契约（chromeHeight/insets/paneWidth vs 实测 reserve）。
 *   2.5 零消息浏览器任务的空态开场（2026-11-04）：命名当前页、落在 dock 卡
 *      内、chip 点击即发送（同日翻转「只落草稿」）、无名页回落「页面正在打开…」。
 *   3. 普通会话回归：chat-primary 几何 + dock 三 tab 原样。
 *   3.5 会话头模式循环钮（2026-11-04）：welcome 门控 + 三连击换位
 *      （chat→files→browser→chat，files 的首个 UI 入口；dock 补开臂）。
 *   4. primaryByConversation 不落盘（pulsemind-workbench 无 primary 字段）。
 *
 * Mounts the production surfaces (AppLayout + ChatView + WorkbenchPane +
 * WelcomeContent + BrowserTaskPanel, real stores, real i18n), stubs
 * electronAPI, never talks to an LLM or a real browser session.
 *
 * Usage: node scripts/probe-layout-modes.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-modes-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-modes-shots')

const CONV_KEY = 'conv_20261103090000'
const WORKBENCH_CARD_MARGIN = 5 // shared/browser/pane.ts
const WORKBENCH_CARD_INSET = 6 // TOP/BOTTOM inset = margin 5 + border 1

const HARNESS = `
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useState } from 'react'
import { useBrowserPaneStore } from './src/renderer/src/stores/browserPaneStore'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'

const CONV = { key: '${CONV_KEY}', label: '视图模式任务', updatedAt: '2026-11-03T09:00:00.000Z' }

let root = null
window.__mount = ({
  messages = true,
  mode = 'chat',
  conversationId = messages ? '${CONV_KEY}' : undefined,
  tabs = [],
  dockOpen = messages,
} = {}) => {
  if (root) root.unmount()
  useBrowserPaneStore.getState().setUpdate({
    visible: false,
    width: 420,
    conversationId: conversationId ?? null,
    tabs,
  })
  useNewTaskStore.getState().setMode('chat')
  // 物化绑定（生产路径在 useChatController，这里直打 store）。跨挂载复用
  // 同一 conv 键——store 不重置，每次按参数归一，'chat' 也显式落盘。
  useWorkbenchStore.getState().setConversationPrimary('${CONV_KEY}', mode)
  if (dockOpen) {
    useWorkbenchStore.getState().setOpen('${CONV_KEY}', true)
    // 浏览器任务首帧落对话 tab（转录面）——镜像控制器的 setActiveTab。
    if (mode === 'browser') useWorkbenchStore.getState().setActiveTab('chat')
  }
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={{ token: { colorPrimary: '#000000' } }}>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AppLayout
            conversations={[CONV]}
            activeConversationKey={conversationId}
            activeConvShowCycle={!!conversationId}
            totalSessions={1}
            autoCleanup={true}
            onCreateNew={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onTogglePinConversation={() => {}}
          >
            <ChatView
              card
              messages={messages ? [
                { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: '2026-11-03T09:00:00.000Z' },
              ] : []}
              conversationId={conversationId}
              conversations={[CONV]}
              isRequesting={false}
              agentStatus={{ status: 'idle' }}
              streamingBlocks={[]}
              hasApiKey={true}
              onSendMessage={(content) => { window.__sentMessages.push(content) }}
              onBrowserTaskStart={(url) => { window.__browserTaskStarts.push(url) }}
              onCancel={() => {}}
              onApproveTool={() => {}}
              onRejectTool={() => {}}
              onClearError={() => {}}
              onOpenConversation={() => {}}
            />
          </AppLayout>
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}

// 有状态的 welcome 任务挂载：onBrowserTaskStart 走真实链路（物化绑定 +
// activeKey 切换 + 零消息容器）——只有真键盘回车能复现「keypress 串场进
// dock composer」的时序。
function WelcomeTaskHarness({ children }: { children: (activeKey: string | undefined) => React.ReactNode }): React.ReactElement {
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined)
  window.__startBrowserTask = () => {
    useWorkbenchStore.getState().setConversationPrimary('${CONV_KEY}', 'browser')
    useWorkbenchStore.getState().setOpen('${CONV_KEY}', true)
    useWorkbenchStore.getState().setActiveTab('chat')
    setActiveKey('${CONV_KEY}')
  }
  return <>{children(activeKey)}</>
}

window.__mountWelcomeTask = () => {
  if (root) root.unmount()
  useBrowserPaneStore.getState().setUpdate({ visible: false, width: 420, conversationId: null, tabs: [] })
  useNewTaskStore.getState().setMode('browser')
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={{ token: { colorPrimary: '#000000' } }}>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <WelcomeTaskHarness>
            {(activeKey) => (
              <AppLayout
                conversations={[CONV]}
                activeConversationKey={activeKey}
                totalSessions={1}
                autoCleanup={true}
                onCreateNew={() => {}}
                onDeleteConversation={() => {}}
                onRenameConversation={() => {}}
                onSelectConversation={() => {}}
                onTogglePinConversation={() => {}}
              >
                <ChatView
                  card
                  messages={[]}
                  conversationId={activeKey}
                  conversations={[CONV]}
                  isRequesting={false}
                  agentStatus={{ status: 'idle' }}
                  streamingBlocks={[]}
                  hasApiKey={true}
                  onSendMessage={() => {}}
                  onBrowserTaskStart={(url) => {
                    window.__browserTaskStarts.push(url)
                    window.__startBrowserTask()
                  }}
                  onCancel={() => {}}
                  onApproveTool={() => {}}
                  onRejectTool={() => {}}
                  onClearError={() => {}}
                  onOpenConversation={() => {}}
                />
              </AppLayout>
            )}
          </WelcomeTaskHarness>
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
}

window.__workbench = useWorkbenchStore
window.__setFloatOverlay = (o) => useBrowserPaneStore.getState().setFloatOverlay(o)
window.__newTask = useNewTaskStore
window.__browserTaskStarts = []
window.__sentMessages = []
window.__clearPaneStates = () => { window.__paneStates.length = 0 }
window.__lastPaneState = () => {
  const states = window.__paneStates
  return states.length > 0 ? states[states.length - 1] : null
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
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.PROBE_DEV ? 'development' : 'production'), __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: the stores subscribe at import time and AppLayout reads
// electronAPI at module scope — the stub must exist up front.
await page.addScriptTag({
  content: `window.__paneStates = [];
    window.__paneActions = [];
    window.__historyFixture = [
      { url: 'https://example.com/report', title: '调研报告', visitCount: 3, lastVisitAt: 1699999999000 },
      { url: 'https://www.baidu.com/s?wd=pm', title: null, visitCount: 1, lastVisitAt: 1699999900000 },
    ];
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'browserPaneSetState' ? (state) => { window.__paneStates.push(state); return Promise.resolve() }
      : key === 'browserPaneAction' ? (action) => { window.__paneActions.push(action); return Promise.resolve() }
      : key === 'browserHistoryQuery' ? (text) => Promise.resolve(text ? window.__historyFixture.filter((r) => r.url.includes(text)) : window.__historyFixture)
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: 'zh',
        })
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const shot = async (name) => page.screenshot({ path: join(SHOTS, name) })
const dockTabs = () =>
  page.evaluate(() => {
    // The dock's tab strip = the pane root carrying the drag handle.
    const handle = document.querySelector('[data-pm-pane-drag-handle]')
    if (!handle) return null
    const pane = handle.parentElement
    const labels = Array.from(pane.querySelectorAll('span')).map((s) => s.textContent)
    return labels.filter((l) => ['工作区', '浏览器', '工作计划', '对话'].includes(l))
  })
const switcherChip = (value) => page.locator(`.task-switch .ant-segmented-item:nth-child(${value})`)

/* ── 1. welcome：三档切换器 + 浏览器快捷区（URL + 近期历史）。 ────────────── */
await page.evaluate(() => window.__mount({ messages: false }))
await page.waitForSelector('[data-welcome-switcher]')
const chips = await page.evaluate(() => Array.from(document.querySelectorAll('.task-switch .ant-segmented-item-label')).map((s) => s.textContent))
check('welcome: 切换器三档 对话/项目/浏览器', JSON.stringify(chips) === JSON.stringify(['对话', '项目', '浏览器']), JSON.stringify(chips))
await switcherChip(3).click()
await page.waitForSelector('[data-pm-browser-task-panel]')
check('welcome(browser): URL 输入框在欢迎区下方', await page.locator('[data-pm-browser-task-url]').isVisible())
// 历史是异步取的（browserHistoryQuery）——零历史时分卡不退场，等第一条落位。
await page.waitForSelector('[data-pm-browser-task-history-item]')
const historyItems = await page.evaluate(() => Array.from(document.querySelectorAll('[data-pm-browser-task-history-item]')).map((el) => el.textContent))
check(
  'welcome(browser): 近期访问历史两条（title 兜底 url）',
  historyItems.length === 2 && historyItems[0].includes('调研报告') && historyItems[1].includes('baidu.com'),
  JSON.stringify(historyItems),
)

// 点历史项 → onBrowserTaskStart（归一化 URL，历史项已是完整 URL 原样透传）。
await page.locator('[data-pm-browser-task-history-item]').first().click()
let starts = await page.evaluate(() => window.__browserTaskStarts)
check('welcome(browser): 点历史项提交 onBrowserTaskStart', JSON.stringify(starts) === JSON.stringify(['https://example.com/report']), JSON.stringify(starts))

// URL 输入回车：缺 scheme 补 https://（与 pane 地址栏同一把尺）。
await page.evaluate(() => {
  window.__browserTaskStarts.length = 0
})
await page.fill('[data-pm-browser-task-url]', 'example.com/article')
await page.keyboard.press('Enter')
starts = await page.evaluate(() => window.__browserTaskStarts)
check('welcome(browser): URL 回车提交且补全 scheme', JSON.stringify(starts) === JSON.stringify(['https://example.com/article']), JSON.stringify(starts))

// 空输入回车不提交（无假反馈）。
await page.evaluate(() => {
  window.__browserTaskStarts.length = 0
})
await page.fill('[data-pm-browser-task-url]', '')
await page.keyboard.press('Enter')
starts = await page.evaluate(() => window.__browserTaskStarts)
check('welcome(browser): 空输入回车零提交', starts.length === 0, JSON.stringify(starts))
// 四期修正裁定：welcome 浏览器模式无自由输入框（URL 表单是唯一入口）。
const welcomeComposer = await page.evaluate(() => {
  const region = document.querySelector('[data-welcome-region]')
  const host = region ? region.closest('div[style]')?.parentElement?.parentElement : null
  void host
  return document.querySelector('[data-welcome-shake="composer"] textarea') !== null
})
check('welcome(browser): 自由输入框退场（无 textarea）', welcomeComposer === false, String(welcomeComposer))

// ── 六期：两栏等宽 / 页面零滚动 / 窄窗单列 ──────────────────────────────
// minmax(0,1fr)：裸 1fr 的 auto 最小尺寸会被长 URL 的 nowrap min-content
// 撑歪（实测两栏差 ~25px）。
const colWidths = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('[data-pm-browser-task-history-item]'))
  return items.slice(0, 2).map((el) => Math.round(el.getBoundingClientRect().width))
})
check('六期: 历史两栏等宽（minmax(0,1fr)）', colWidths.length === 2 && Math.abs(colWidths[0] - colWidths[1]) <= 2, JSON.stringify(colWidths))
const regionScroll = await page.evaluate(() => {
  const region = document.querySelector('[data-welcome-region]')
  return region ? { overflow: region.scrollHeight - region.clientHeight } : null
})
check('六期: welcome 页无垂直滚动（region 不溢出）', regionScroll !== null && regionScroll.overflow <= 0, JSON.stringify(regionScroll))
await page.setViewportSize({ width: 720, height: 820 })
await page.waitForTimeout(150)
const stacked = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('[data-pm-browser-task-history-item]'))
  if (items.length < 2) return null
  const r0 = items[0].getBoundingClientRect()
  const r1 = items[1].getBoundingClientRect()
  const grid = document.querySelector('[data-pm-browser-task-grid]')
  const panel = document.querySelector('[data-pm-browser-task-panel]')
  return {
    sameRow: Math.abs(r0.top - r1.top) < 4,
    width: Math.round(r0.width),
    cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    panelW: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    containerType: panel ? getComputedStyle(panel).containerType : null,
  }
})
check('六期: 窄窗(720)历史列变单列（前两条不再同排）', stacked !== null && stacked.sameRow === false, JSON.stringify(stacked))
await page.setViewportSize({ width: 1280, height: 820 })
await page.waitForTimeout(150)
const restored = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('[data-pm-browser-task-history-item]'))
  const r0 = items[0].getBoundingClientRect()
  const r1 = items[1].getBoundingClientRect()
  return { sameRow: Math.abs(r0.top - r1.top) < 4 }
})
check('六期: 复宽恢复两栏', restored.sameRow === true, JSON.stringify(restored))

// ── 八期：滚动区贴右缘 / URL 区无灰卡底 ────────────────────────────────
// flush：grid 右缘 = 历史卡壳右缘（CardShell flush 收掉右 padding，滚动条
// 不隔着 20px 内缩悬空）。
const flushInfo = await page.evaluate(() => {
  const grid = document.querySelector('[data-pm-browser-task-grid]')
  const shell = grid?.parentElement
  if (!grid || !shell) return null
  return { diff: Math.round(shell.getBoundingClientRect().right - grid.getBoundingClientRect().right) }
})
check('八期: 历史滚动区贴卡右缘（flush）', flushInfo !== null && Math.abs(flushInfo.diff) <= 1, JSON.stringify(flushInfo))
// URL 区裸排：输入框的祖先链上不应再有任何 card-soft 灰卡。
const urlCardless = await page.evaluate(() => {
  const input = document.querySelector('[data-pm-browser-task-url]')
  return input ? input.closest('[style*="card-soft"]') !== null : null
})
check('八期: URL 输入区无灰卡底', urlCardless === false, String(urlCardless))
// 十三期裁定（2026-11-04 追加右距 5→10）：打开钮内嵌输入框右端——按钮完全
// 落在输入框矩形内，且 paddingRight ≥ 右距 10 + 钮宽 38（超长 URL 在
// content-box 内裁切，不滚进按钮底下；padding 一旦小于按钮外沿，这条就红）。
const insetBtn = await page.evaluate(() => {
  const input = document.querySelector('[data-pm-browser-task-url]')
  const btn = input?.parentElement?.querySelector('button[aria-label]')
  if (!input || !btn) return null
  const ir = input.getBoundingClientRect()
  const br = btn.getBoundingClientRect()
  return {
    pr: parseFloat(getComputedStyle(input).paddingRight),
    inside: br.left >= ir.left && br.right <= ir.right && br.top >= ir.top && br.bottom <= ir.bottom,
  }
})
check('打开钮内嵌输入框 + paddingRight 预留（长 URL 不被遮挡）', insetBtn !== null && insetBtn.inside && insetBtn.pr >= 48, JSON.stringify(insetBtn))
await shot('modes-welcome-browser.png')

/* ── 1.4 零历史：近期访问整卡退场（2026-11-04 用户裁定「没有访问记录就
      不需要近期访问区」）。URL 区不留空壳、也不挪位。 ──────────────────── */
await page.evaluate(() => {
  window.__historyFixture.length = 0
  window.__mountWelcomeTask()
})
await page.waitForSelector('[data-pm-browser-task-url]')
await page.waitForTimeout(150)
const noHistory = await page.evaluate(() => ({
  url: !!document.querySelector('[data-pm-browser-task-url]'),
  card: !!document.querySelector('[data-pm-browser-task-history]'),
  title: (document.body.textContent || '').includes('近期访问'),
}))
check('零历史: 近期访问整卡退场（URL 区仍在）', noHistory.url && !noHistory.card && !noHistory.title, JSON.stringify(noHistory))
await shot('modes-welcome-browser-empty.png')
// 有记录时历史卡照常回来（退场只认「没有记录」，不是一次性形态）。
await page.evaluate(() => {
  window.__historyFixture.push(
    { url: 'https://example.com/report', title: '调研报告', visitCount: 3, lastVisitAt: 1699999999000 },
    { url: 'https://www.baidu.com/s?wd=pm', title: null, visitCount: 1, lastVisitAt: 1699999900000 },
  )
  window.__mountWelcomeTask()
})
await page.waitForSelector('[data-pm-browser-task-history-item]')
check('零历史恢复: 有记录后历史卡回来', await page.locator('[data-pm-browser-task-history]').isVisible())

/* ── 1.45 历史卡高度贴合内容（2026-11-05 用户裁定「历史少不用撑满至底部，
      看上去太空了」）：wrapper flex '0 1 auto'——少历史时卡底悬在半空、下方
      留白（不是一张半空的灰卡）；历史多/短窗时 shrink 收缩贴底、列表内部滚。
      两臂都要钉：改回 flex:1 时第一臂红，改掉 minHeight:0 时第二臂红。 ── */
const hugGap = await page.evaluate(() => {
  const card = document.querySelector('[data-pm-browser-task-history]')
  const band = document.querySelector('[data-welcome-band]')
  if (!card || !band) return null
  return Math.round(band.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom)
})
check('1.45: 少历史卡片贴合内容（卡底不贴 band 底）', hugGap !== null && hugGap > 24, String(hugGap))
await page.evaluate(() => {
  for (let i = 0; i < 30; i++) {
    window.__historyFixture.push({
      url: `https://example.com/page/${i}`,
      title: `页面 ${i}`,
      visitCount: 1,
      lastVisitAt: 1699999000000 + i,
    })
  }
  window.__mountWelcomeTask()
})
await page.waitForSelector('[data-pm-browser-task-history-item]')
await page.waitForTimeout(100)
const overflowInfo = await page.evaluate(() => {
  const card = document.querySelector('[data-pm-browser-task-history]')
  const band = document.querySelector('[data-welcome-band]')
  const grid = document.querySelector('[data-pm-browser-task-grid]')
  const region = document.querySelector('[data-welcome-region]')
  if (!card || !band || !grid) return null
  return {
    glued: Math.round(band.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom),
    scrolls: grid.scrollHeight - grid.clientHeight,
    pageOverflow: region ? region.scrollHeight - region.clientHeight : null,
  }
})
check(
  '1.45: 多历史卡片收缩贴底 + 列表内部滚动 + 页面零滚动',
  overflowInfo !== null && Math.abs(overflowInfo.glued) <= 2 && overflowInfo.scrolls > 0 && overflowInfo.pageOverflow <= 0,
  JSON.stringify(overflowInfo),
)
await page.evaluate(() => {
  window.__historyFixture.length = 2
  window.__mountWelcomeTask()
})
await page.waitForSelector('[data-pm-browser-task-history-item]')
const rehug = await page.evaluate(() => {
  const card = document.querySelector('[data-pm-browser-task-history]')
  const band = document.querySelector('[data-welcome-band]')
  if (!card || !band) return null
  return Math.round(band.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom)
})
check('1.45: 回到少历史重新贴合（动态，非一次性形态）', rehug !== null && rehug > 24, String(rehug))

/* ── 1.5 真键盘回车物化链路：dock composer 不得带入换行（keypress 串场）── */
await page.evaluate(() => window.__mountWelcomeTask())
await page.waitForSelector('[data-pm-browser-task-url]')
await page.fill('[data-pm-browser-task-url]', 'example.com/enter-chain')
await page.keyboard.press('Enter')
// 物化后 dock 对话 tab 挂载 composer（autoFocus）——回车的 keypress 若未被
// preventDefault 掐断，会在这个 textarea 里插进一个换行。
await page.waitForSelector('[data-pm-chat-scroll]')
const composerState = await page.evaluate(() => {
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  const ta = dockRoot?.querySelector('textarea')
  return { present: !!ta, value: JSON.stringify(ta?.value ?? null) }
})
check('回车链路: dock composer 挂载', composerState.present === true, JSON.stringify(composerState))
check('回车链路: composer 无串场换行（value 为空串）', composerState.value === '""', composerState.value)
await shot('modes-enter-chain.png')

/* ── 1.6 新建任务子菜单（十四期）：hover 三档，档位分流 welcome 形态 ────── */
await page.evaluate(() => window.__mountWelcomeTask())
await page.waitForSelector('[data-welcome-switcher]')
// 悬浮「新建任务」（侧栏第一个 new-chat-btn）→ 子菜单三档（对话/项目/浏览器）。
await page.hover('.new-chat-btn')
await page.waitForSelector('.nav-submenu .ant-dropdown-menu-item')
const subLabels = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-submenu .ant-dropdown-menu-item')).map((el) => el.textContent?.trim()))
check('十四期: 新建任务悬浮子菜单三档', JSON.stringify(subLabels) === JSON.stringify(['对话', '项目', '浏览器']), JSON.stringify(subLabels))
// 十四期修正钉 1：hover 子菜单某一项时只有该项高亮（三档 view 同 key 的
// rc-menu active 串场——key 已按 taskMode 唯一化）。
await page.hover('.nav-submenu .ant-dropdown-menu-item:nth-child(2)')
await page.waitForTimeout(120)
const activeCount = await page.evaluate(() => document.querySelectorAll('.nav-submenu .ant-dropdown-menu-item-active').length)
check('十四期修正: hover 一项只高亮一项', activeCount === 1, String(activeCount))
// 点「浏览器」档 → 浏览器形态 welcome（URL 面板 + 任务切换器高亮浏览器）。
await page.click('.nav-submenu .ant-dropdown-menu-item:nth-child(3)')
await page.waitForSelector('[data-pm-browser-task-panel]')
const browserMode = await page.evaluate(() => window.__newTask.getState().mode)
check('十四期: 子菜单「浏览器」→ browser 模式 welcome', browserMode === 'browser', String(browserMode))
const switcherActive = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.task-switch .ant-segmented-item'))
  const idx = items.findIndex((el) => el.className.includes('ant-segmented-item-selected'))
  return items.map((el) => el.textContent?.trim())[idx]
})
check('十四期: welcome 切换器同步高亮浏览器', switcherActive === '浏览器', String(switcherActive))

// 点「对话」档 → 对话形态 welcome（自由 composer 在、URL 面板退场）。
await page.hover('.new-chat-btn')
await page.waitForSelector('.nav-submenu .ant-dropdown-menu-item')
await page.click('.nav-submenu .ant-dropdown-menu-item:nth-child(1)')
await page.waitForSelector('[data-welcome-shake="composer"]')
const chatMode = await page.evaluate(() => window.__newTask.getState().mode)
const chatComposer = await page.evaluate(() => document.querySelector('[data-welcome-shake="composer"] textarea') !== null)
check('十四期: 子菜单「对话」→ chat 模式 welcome + 自由 composer', chatMode === 'chat' && chatComposer, `mode=${chatMode} composer=${chatComposer}`)
await shot('modes-submenu-chat.png')

// 点按钮本体 → listTab 语义（harness 无 listTab 状态 → chat 兜底）+ welcome
// 回到对话形态。侧栏按钮文本带展开箭头（nav-split）。
await page.click('.new-chat-btn')
await page.waitForTimeout(200)
const bodyMode = await page.evaluate(() => window.__newTask.getState().mode)
check('十四期: 点按钮本体走 listTab 语义（兜底 chat）', bodyMode === 'chat', String(bodyMode))

// 十四期修正钉 2：当前会话是浏览器任务时，点本体进浏览器形态（「与当前
// 模式相同」——mode=browser + shake 指向 URL 表单）。
await page.evaluate(() => window.__startBrowserTask())
await page.waitForTimeout(150)
await page.click('.new-chat-btn')
await page.waitForTimeout(200)
const bodyBrowser = await page.evaluate(() => {
  const st = window.__newTask.getState()
  return { mode: st.mode, shake: st.shake.target }
})
check(
  '十四期修正: 浏览器会话中点本体 → browser 模式 + browserUrl shake',
  bodyBrowser.mode === 'browser' && bodyBrowser.shake === 'browserUrl',
  JSON.stringify(bodyBrowser),
)

/* ── 2. 浏览器任务的布局：主卡=浏览器 chrome，dock=对话/工作区/计划。 ─────── */
await page.evaluate(() => window.__mount({ messages: true, mode: 'browser' }))
await page.waitForSelector('input[placeholder="输入网址，回车打开"]')
const addrBox = await page.locator('input[placeholder="输入网址，回车打开"]').boundingBox()
check('browser-task: 地址栏在主卡（窗口左半）', addrBox.x + addrBox.width / 2 < 1280 / 2, `x=${Math.round(addrBox.x)}`)
check(
  'browser-task: dock tab 集合 = 对话/工作区/工作计划',
  JSON.stringify(await dockTabs()) === JSON.stringify(['对话', '工作区', '工作计划']),
  JSON.stringify(await dockTabs()),
)
const chromeGeom = await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="输入网址，回车打开"]')
  const row = input.closest('div[style*="border-bottom"]')
  let card = row
  while (card && !(card.style || {}).borderRadius) card = card.parentElement
  return { chrome: row.getBoundingClientRect().bottom - card.getBoundingClientRect().top - 1 }
})
check('browser-task: 主卡 chrome 行高 = 68（无工作台页签条）', Math.round(chromeGeom.chrome) === 68, JSON.stringify(chromeGeom))
const push = await page.evaluate(() => window.__lastPaneState())
check(
  'browser-task: 推送契约 browserActive/chromeHeight/insets/paneWidth',
  push &&
    push.browserActive === true &&
    push.chromeHeight === 68 &&
    push.topInset === WORKBENCH_CARD_INSET &&
    push.bottomInset === WORKBENCH_CARD_INSET &&
    push.rightInset === 420 + WORKBENCH_CARD_MARGIN + WORKBENCH_CARD_MARGIN &&
    typeof push.paneWidth === 'number' &&
    push.paneWidth > 0,
  JSON.stringify(push),
)
// dock 对话 tab 真的装着对话列（转录面在浏览器主视图下的唯一出口）。
const dockChat = await page.evaluate(() => {
  const el = document.querySelector('[data-pm-chat-scroll]')
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  return { present: !!el, inDock: dockRoot ? dockRoot.contains(el) : false, text: el ? el.textContent : '' }
})
check(
  'browser-task: dock 对话 tab 装着转录且正文保留',
  dockChat.present && dockChat.inDock && dockChat.text.includes('你好'),
  JSON.stringify({ present: dockChat.present, inDock: dockChat.inDock }),
)
// 四期修正裁定：dock 对话 tab 的 composer 保留（侧栏对话是浏览器任务的
// 持续输入面——上轮删错了面）。
const dockHasComposer = await page.evaluate(() => {
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  return dockRoot ? dockRoot.querySelector('textarea') !== null : null
})
check('browser-task: dock 对话 tab 保留输入框（textarea 存在）', dockHasComposer === true, String(dockHasComposer))
// dock 关掉：reserve 归零 → rightInset 只剩卡边距。
await page.evaluate(() => window.__clearPaneStates())
await page.evaluate((k) => window.__workbench.getState().setOpen(k, false), CONV_KEY)
await page.waitForTimeout(120)
const pushClosed = await page.evaluate(() => window.__lastPaneState())
check('browser-task: dock 关闭后 rightInset = 5（reserve 归零）', pushClosed && pushClosed.rightInset === WORKBENCH_CARD_MARGIN, JSON.stringify(pushClosed))

// ── 十三期：浮窗让位推送（store → pane-state → dock 内收 view）─────────
await page.evaluate(() => window.__clearPaneStates())
await page.evaluate(() => {
  // 探针 harness 未暴露 browserPaneStore——从 workbench 同族模块拿不到就
  // 走 window.__setFloatOverlay（harness 里接好）。
  window.__setFloatOverlay({ left: 120, right: 0 })
})
await page.waitForTimeout(120)
const pushOverlay = await page.evaluate(() => window.__lastPaneState())
check('十三期: 浮窗越缘推送 leftOverlay=120', pushOverlay && pushOverlay.leftOverlay === 120 && pushOverlay.rightOverlay === 0, JSON.stringify(pushOverlay))
await page.evaluate(() => window.__setFloatOverlay({ left: 0, right: 0 }))
await page.waitForTimeout(120)
const pushOverlayCleared = await page.evaluate(() => window.__lastPaneState())
check('十三期: 浮窗关闭归零 leftOverlay=0', pushOverlayCleared && pushOverlayCleared.leftOverlay === 0, JSON.stringify(pushOverlayCleared))
await shot('modes-browser-task.png')

/* ── 2.5 零消息浏览器任务的静态开场（用户裁定 2026-11-04）─────────────
 * 打开页面但一句没说时，dock 对话 tab 原本一片空白。现在是一条静态开场
 * （页名 + 建议 chip）：它刻意不是 agent 消息——点 chip 直接发送（同日翻转
 * 「只落草稿」：一次点击就能跑起来），开场自身仍不落库、不进上下文。 */
await page.evaluate(
  (key) =>
    window.__mount({
      messages: false,
      mode: 'browser',
      conversationId: key,
      dockOpen: true,
      tabs: [{ id: 't1', url: 'https://github.com/pulls', title: 'Pull requests · GitHub', active: true }],
    }),
  CONV_KEY,
)
await page.waitForSelector('[data-browser-task-starter]')
const starterText = await page.evaluate(() => document.querySelector('[data-browser-task-starter]')?.textContent ?? '')
check('浏览器任务空态: 静态开场命名当前页', starterText.includes('「Pull requests · GitHub」已打开'), starterText.slice(0, 80))
// 开场住在 dock 卡的对话 tab 里，且不越出卡片（窄列里 maxWidth 1000 不该撑破）。
const starterGeom = await page.evaluate(() => {
  const el = document.querySelector('[data-browser-task-starter]')
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  if (!el || !dockRoot) return null
  const a = el.getBoundingClientRect()
  const b = dockRoot.getBoundingClientRect()
  return {
    inDock: dockRoot.contains(el),
    inside: a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1,
    w: Math.round(a.width),
    dockW: Math.round(b.width),
  }
})
check(
  '浏览器任务空态: 开场落在 dock 卡内且不越界',
  !!starterGeom && starterGeom.inDock && starterGeom.inside && starterGeom.w <= starterGeom.dockW,
  JSON.stringify(starterGeom),
)
await page.evaluate(() => {
  window.__sentMessages.length = 0
})
await page.locator('[data-browser-task-starter] span').nth(1).click()
await page.waitForTimeout(150)
const starterState = await page.evaluate(() => {
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  const ta = dockRoot?.querySelector('textarea')
  return {
    draft: ta ? ta.value : null,
    sent: window.__sentMessages.length,
    sentText: window.__sentMessages[window.__sentMessages.length - 1] ?? null,
    // 开场是否还在只作诊断信息：夹具的消息列表是静态的（真机上这条乐观消息
    // 一到，emptySlot 就让位给转录），这里不能拿它当断言。
    starter: !!document.querySelector('[data-browser-task-starter]'),
  }
})
check(
  '浏览器任务空态: 点 chip 直接发送（一次点击，不经过草稿/回车）',
  starterState.sent === 1 && starterState.sentText === '提取页面里的关键信息' && starterState.draft === '',
  JSON.stringify(starterState),
)
// 页名缺省（about:blank 无标题）→ 「页面正在打开…」，绝不编造名字。
await page.evaluate(
  (key) =>
    window.__mount({
      messages: false,
      mode: 'browser',
      conversationId: key,
      dockOpen: true,
      tabs: [{ id: 't1', url: 'about:blank', title: '', active: true }],
    }),
  CONV_KEY,
)
await page.waitForSelector('[data-browser-task-starter]')
const starterPending = await page.evaluate(() => document.querySelector('[data-browser-task-starter]')?.textContent ?? '')
check('浏览器任务空态: 无名页回落「页面正在打开…」', starterPending.includes('页面正在打开'), starterPending.slice(0, 60))
await shot('modes-browser-task-starter.png')

/* ── 3. 普通会话回归：chat-primary 几何 + dock 三 tab 原样。 ─────────────── */
await page.evaluate(() => window.__mount({ messages: true, mode: 'chat' }))
await page.waitForSelector('[data-pm-chat-scroll]')
const chatInfo = await page.evaluate(() => {
  const el = document.querySelector('[data-pm-chat-scroll]')
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  // chat-primary：对话列不在 dock 内（在主卡）。
  return { present: !!el, inDock: dockRoot ? dockRoot.contains(el) : false }
})
check('chat-task: 对话列在主卡（不在 dock 内）', chatInfo.present && !chatInfo.inDock, JSON.stringify(chatInfo))
check(
  'chat-task: dock tab 集合 = 工作区/浏览器/工作计划',
  JSON.stringify(await dockTabs()) === JSON.stringify(['工作区', '浏览器', '工作计划']),
  JSON.stringify(await dockTabs()),
)
const pushChat = await page.evaluate(() => window.__lastPaneState())
check(
  'chat-task: 推送不带 chromeHeight（侧栏契约回落 100）',
  pushChat && pushChat.chromeHeight === undefined && pushChat.browserActive === false,
  JSON.stringify(pushChat),
)
await shot('modes-chat-task.png')

/* ── 3.5 会话头模式循环钮（2026-11-04）：chat → files → browser → chat。 ── */
// welcome 门控：welcome 正在显示（chat 优先 + 零消息）时循环钮不出现。
await page.evaluate(() => window.__mount({ messages: false }))
await page.waitForSelector('[data-welcome-switcher]')
check('cycle: welcome 页无循环钮（门控）', (await page.locator('[data-pm-primary-cycle]').count()) === 0)

await page.evaluate(() => window.__mount({ messages: true, mode: 'chat' }))
await page.waitForSelector('[data-pm-chat-scroll]')
const cycleBtn = page.locator('[data-pm-primary-cycle]')
const cycleLabel = () => cycleBtn.getAttribute('aria-label')
// 图标即状态（用户裁定 2026-11-04）：图标/文案展示当前模式，不宣传下一档。
const cycleIconCls = () => page.evaluate(() => document.querySelector('[data-pm-primary-cycle] .anticon')?.getAttribute('class') ?? '')
check(
  'cycle: 会话界面出现循环钮，图标/文案=对话（当前档）',
  (await cycleBtn.count()) === 1 && (await cycleLabel()) === '对话视图 · 点击切换' && (await cycleIconCls()).includes('anticon-message'),
  `${await cycleLabel()} / ${await cycleIconCls()}`,
)
// 补开臂的对照态：先关掉 dock，循环到 files 必须把它打开——chatSlot 只在
// dock 渲染，不开则对话列不可达。
await page.evaluate((k) => window.__workbench.getState().setOpen(k, false), CONV_KEY)
await page.waitForTimeout(120)
check('cycle: 起点 dock 已关（对照态）', await page.evaluate(() => !document.querySelector('[data-pm-pane-drag-handle]')), '')

// click 1：chat → files——主卡让给工作台，对话列退到 dock 的对话 tab。
await cycleBtn.click()
await page.waitForTimeout(150)
const filesState = await page.evaluate(() => {
  const chat = document.querySelector('[data-pm-chat-scroll]')
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  return {
    dockOpen: !!dockRoot,
    chatInDock: !!(chat && dockRoot && dockRoot.contains(chat)),
    // data-pm-primary-browser-card 标在主卡容器本身（十三期浮窗测量的
    // webview 矩形基准，全模式常驻）——不是 browser 档判别器；地址栏才是。
    hasAddr: !!document.querySelector('input[placeholder="输入网址，回车打开"]'),
  }
})
check('cycle→files: dock 补开且对话列在 dock', filesState.dockOpen && filesState.chatInDock, JSON.stringify(filesState))
check(
  'cycle→files: dock tab 集合 = 对话/浏览器/工作计划',
  JSON.stringify(await dockTabs()) === JSON.stringify(['对话', '浏览器', '工作计划']),
  JSON.stringify(await dockTabs()),
)
check('cycle→files: 主卡不是浏览器（无地址栏）', !filesState.hasAddr, String(filesState.hasAddr))
// 图标与新建任务子菜单同源同形（2026-11-04 裁定）：工作区档 = 子菜单「项目」
// 的 FolderOutlined（anticon-folder）。
check(
  'cycle→files: 图标/文案=工作区（当前档，图标同新建任务子菜单）',
  (await cycleLabel()) === '工作区视图 · 点击切换' && (await cycleIconCls()).includes('anticon-folder'),
  `${await cycleLabel()} / ${await cycleIconCls()}`,
)

// click 2：files → browser——浏览器 chrome 整卡 + 推送契约（空态也带地址栏）。
await cycleBtn.click()
await page.waitForTimeout(150)
const browserState = await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="输入网址，回车打开"]')
  const row = input ? input.closest('div[style*="border-bottom"]') : null
  let card = row
  while (card && !(card.style || {}).borderRadius) card = card.parentElement
  return { hasAddr: !!input, chrome: row && card ? Math.round(row.getBoundingClientRect().bottom - card.getBoundingClientRect().top - 1) : null }
})
check('cycle→browser: 主卡 = 浏览器 chrome（地址栏 + 行高 68）', browserState.hasAddr && browserState.chrome === 68, JSON.stringify(browserState))
const pushCycle = await page.evaluate(() => window.__lastPaneState())
check(
  'cycle→browser: 推送契约 browserActive/chromeHeight=68',
  !!pushCycle && pushCycle.browserActive === true && pushCycle.chromeHeight === 68,
  JSON.stringify(pushCycle),
)
check(
  'cycle→browser: dock tab 集合 = 对话/工作区/工作计划',
  JSON.stringify(await dockTabs()) === JSON.stringify(['对话', '工作区', '工作计划']),
  JSON.stringify(await dockTabs()),
)
check(
  'cycle→browser: 图标/文案=浏览器（当前档）',
  (await cycleLabel()) === '浏览器视图 · 点击切换' && (await cycleIconCls()).includes('anticon-global'),
  `${await cycleLabel()} / ${await cycleIconCls()}`,
)

// click 3：browser → chat——对话列回主卡，dock tab 回三件套（activeTab 调和）。
await cycleBtn.click()
await page.waitForTimeout(150)
const chatState = await page.evaluate(() => {
  const chat = document.querySelector('[data-pm-chat-scroll]')
  const dockRoot = document.querySelector('[data-pm-pane-drag-handle]')?.parentElement
  return { chatInMain: !!(chat && dockRoot && !dockRoot.contains(chat)), hasAddr: !!document.querySelector('input[placeholder="输入网址，回车打开"]') }
})
check('cycle→chat: 对话列回主卡（浏览器 chrome 退场）', chatState.chatInMain && !chatState.hasAddr, JSON.stringify(chatState))
check(
  'cycle→chat: dock tab 集合 = 工作区/浏览器/工作计划',
  JSON.stringify(await dockTabs()) === JSON.stringify(['工作区', '浏览器', '工作计划']),
  JSON.stringify(await dockTabs()),
)
check(
  'cycle→chat: 循环闭环，回到对话档',
  (await cycleLabel()) === '对话视图 · 点击切换' && (await cycleIconCls()).includes('anticon-message'),
  `${await cycleLabel()} / ${await cycleIconCls()}`,
)
await shot('modes-primary-cycle.png')

/* ── 4. 按会话的模式不落盘。 ─────────────────────────────────────────────── */
const persisted = await page.evaluate(() => {
  const raw = localStorage.getItem('pulsemind-workbench')
  return raw ? JSON.parse(raw) : null
})
check(
  'persist: pulsemind-workbench 无 primary 字段',
  persisted && persisted.state && persisted.state.primary === undefined && persisted.state.primaryByConversation === undefined,
  JSON.stringify(persisted?.state),
)
const modeMap = await page.evaluate(() => window.__workbench.getState().primaryByConversation)
check(
  'persist: 内存里的会话模式照常存活（conv 键绑定 browser）',
  modeMap && modeMap['${CONV_KEY}'.replace('${CONV_KEY}', '')] !== 'never',
  JSON.stringify(modeMap),
)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`)
process.exit(failed.length ? 1 : 0)
