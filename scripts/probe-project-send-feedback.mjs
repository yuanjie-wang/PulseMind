/**
 * Welcome-page project-mode TWO-FORM probe (real Chromium).
 *
 * 项目模式两形态（2026-11-04 裁定）：形态完全由 newTaskStore.projectId 派生——
 * 未选项目 = 输入框整块退场（卡片网格是唯一入口，不再有灰按钮/拒发 toast 的
 * 「发送无效」迷局）；已选项目 = 输入框出现（自动聚焦），项目选择区压缩成一条
 * 项目色横条（选中卡的 wash 配方）贴住 composer，「更换」= setProjectId(null)
 * 回形态一。这些都是 DOM 存在性/时序事实，jsdom 看不见：
 *
 *   - 形态一：composer 挂载点整体不存在（条件渲染，非 display:none），试试
 *     区也不渲染——没有发送通道，chips 点了无处可发
 *   - 点卡 → 形态二：横条出现（含项目名 + wash 渐变底）、网格退场、composer
 *     挂载且自动聚焦，试试区只在这一形态
 *   - 「更换」→ 回形态一；手打文字不跨卸载（输入文字是 InputArea 的本地
 *     state，不是持久层；一次性草稿通道已随「点一下即发送」一并退役）
 *   - 新建任务的 projectPicker 摇晃在两种形态都落在这根 root 上
 *   - 对话模式不受影响（composer 恒显，Enter 正常发送）
 *
 * 灰钮拒发路径（shake + toast）只剩 dock 窄面（ChatBody welcome 臂，无项目卡
 * 可点）——那条路径由 tests/welcome-shake.test.ts 的 wiring 扫描钉住。
 *
 * Mounts the real `ChatView` in an AppLayout-shaped shell, driven through the
 * real `newTaskStore` / `projectStore`. No Electron, no LLM: `onSendMessage`
 * is a counting stub.
 *
 * Usage: node scripts/probe-project-send-feedback.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(mkdtempSync(join(tmpdir(), 'pm-project-forms-shots-')), 'shots')

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-project-send-feedback-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'

const PROJECTS = [
  { id: 'proj_a', name: '项目甲', workspaceDir: '/tmp/proj-a', colorHue: 200, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
]

const TABLE = {
  expertList: [],
  projectList: PROJECTS,
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  getConversationLastUserMessage: '',
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    return Promise.resolve(TABLE[key])
  },
})

const EMPTY = []
const IDLE = { status: 'idle' }
window.__sends = []

function ChatShell() {
  const viewKind = useNavigationStore((s) => s.view.kind)
  return (
    <div style={{ display: 'flex', height: 900 }}>
      <div id="fake-sidebar" style={{ width: 264, flexShrink: 0 }} />
      <div id="chat-host" style={{ flex: 1, display: viewKind === 'chat' ? 'block' : 'none' }}>
        <ChatView
          messages={EMPTY}
          isRequesting={false}
          agentStatus={IDLE}
          streamingBlocks={EMPTY}
          hasApiKey={true}
          onSendMessage={(content) => { window.__sends.push(content); return true }}
          onCancel={() => {}} onApproveTool={() => {}} onRejectTool={() => {}}
          onClearError={() => {}}
          conversations={EMPTY}
          onOpenConversation={() => {}}
        />
      </div>
    </div>
  )
}

let roots = []
window.__mount = () => {
  for (const r of roots) r.unmount()
  roots = []
  const host = document.createElement('div')
  host.id = 'case-chat'
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><ChatShell /></TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

window.__stores = { newTask: useNewTaskStore, navigation: useNavigationStore }
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
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.bringToFront()

const setState = (store, action, value) =>
  page.evaluate(
    ([s, a, v]) => {
      window.__stores[s].getState()[a](v)
    },
    [store, action, value],
  )

const shakeState = (target) =>
  page.evaluate((t) => {
    const el = document.querySelector(`[data-welcome-shake="${t}"]`)
    if (!el) return 'missing'
    const anims = el.getAnimations()
    if (!anims.length) return 'idle'
    return anims.some((a) => a.playState === 'running') ? 'running' : 'settling'
  }, target)

const composerPresent = () => page.evaluate(() => document.querySelector('[data-welcome-shake="composer"]') !== null)
const gridPresent = () => page.evaluate(() => document.querySelector('[data-action="create-project"]') !== null)
const stripInfo = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-welcome-project-strip]')
    if (!el) return null
    return { name: el.textContent ?? '', bg: getComputedStyle(el).backgroundImage }
  })
const textarea = () => page.locator('.ant-sender textarea').first()
const textareaPresent = () => page.evaluate(() => document.querySelector('.ant-sender textarea') !== null)
const composerText = () => textarea().inputValue()
const focusIsTextarea = () =>
  page.evaluate(() => {
    const el = document.activeElement
    return !!el && el.tagName === 'TEXTAREA' && !!el.closest('.ant-sender')
  })
const sends = () => page.evaluate(() => window.__sends.length)

console.log('\n§1 项目模式未选项目 — 形态一：输入框整块退场')
await page.evaluate(() => window.__mount())
await page.waitForTimeout(300)
await setState('newTask', 'setMode', 'project')
await page.waitForTimeout(300)
check('欢迎面进入项目形态(选项目区域已挂载)', (await shakeState('projectPicker')) !== 'missing')
check('composer 挂载点不存在(条件渲染,不是 display:none)', !(await composerPresent()))
check('输入框不存在(没有灰按钮可拒发)', !(await textareaPresent()))
check('卡片网格在(选项目是唯一入口)', await gridPresent())
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, 'form-1-unpicked.png') })

// 新建任务的引导摇晃仍指向这根 picker root。
await setState('newTask', 'requestShake', 'projectPicker')
check('projectPicker 摇晃仍落在选项目区域', (await shakeState('projectPicker')) === 'running')
check('composer 目标缺失(输入框已退场,无目标可摇)', (await shakeState('composer')) === 'missing')
await page.waitForTimeout(700)
check('摇晃自己停(一次性动画)', (await shakeState('projectPicker')) === 'idle')

console.log('\n§2 点卡选中 — 形态二：横条 + 输入框')
await page.locator('div[role="button"]', { hasText: '项目甲' }).first().click()
await page.waitForTimeout(60)
// 形态切换入场（同日追加）：token 变化即播 220ms 淡入+位移，横条与 composer
// 同期各播一份（transform+opacity，不动布局）。等它播完再做存在性/几何断言。
const enterRunning = (sel) => page.evaluate((s) => (document.querySelector(s)?.getAnimations().length ?? 0) > 0, sel)
check('picker root 播入场动画(WAAPI 在播)', await enterRunning('[data-welcome-shake="projectPicker"]'))
check('composer 同期播入场动画', await enterRunning('[data-welcome-shake="composer"]'))
await page.waitForTimeout(300)
const strip = await stripInfo()
check('压缩横条出现', strip !== null)
check('横条显示项目名', strip !== null && strip.name.includes('项目甲'), strip?.name ?? '')
check('横条穿着项目色 wash(渐变底,选中卡配方)', strip !== null && strip.bg.includes('linear-gradient'), strip?.bg ?? '')
check('卡片网格退场', !(await gridPresent()))
check('composer 挂载点出现', await composerPresent())
check('输入框可输入', await textareaPresent())

// focusToken 含 projectId，composer 新挂载即自动聚焦。
await page.waitForTimeout(200)
check('选中后自动聚焦输入框', await focusIsTextarea())

await textarea().fill('帮我整理这个项目的资料')
await textarea().press('Enter')
await page.waitForTimeout(150)
check('Enter 正常发出一条消息', (await sends()) === 1, String(await sends()))
check('发送后输入框清空', (await composerText()) === '')
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, 'form-2-selected.png') })

// 摇晃机制在压缩形态仍挂同一根 root。
await setState('newTask', 'requestShake', 'projectPicker')
check('压缩形态下 projectPicker 摇晃仍落在横条区域', (await shakeState('projectPicker')) === 'running')
await page.waitForTimeout(700)

console.log('\n§3 更换 — 回形态一；试试区只属于形态二')
await textarea().fill('手打的字')
await page.locator('[data-welcome-project-strip] button').first().click()
await page.waitForTimeout(300)
check('更换后横条退场', (await stripInfo()) === null)
check('更换后 composer 退场', !(await composerPresent()))
check('更换后卡片网格回归', await gridPresent())
// 手打文字活在 InputArea 的本地 state（一次性草稿通道已随「点一下即发送」
// 退役），卸载即失——与 browser 模式切走同规，刻意钉住。
await page.locator('div[role="button"]', { hasText: '项目甲' }).first().click()
await page.waitForTimeout(300)
check('重新选中回到形态二', (await stripInfo()) !== null && (await composerPresent()))
check('手打文字不跨卸载(browser 同规)', (await composerText()) === '', JSON.stringify(await composerText()))

// 试试区只属于形态二（2026-11-04 追加裁定）：选择形态没有输入框，chips 点了
// 无处可发——整组不渲染；已选形态的横条下方才有。
const startersCount = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-welcome-shake="projectPicker"] span')].filter(
        (el) => el.textContent?.trim() === '看一下这个项目里的文件，给我讲讲整体结构',
      ).length,
  )
await page.locator('[data-welcome-project-strip] button').first().click()
await page.waitForTimeout(300)
check('形态一没有试试区(点了没法用的入口不出现)', (await startersCount()) === 0)
await page.locator('div[role="button"]', { hasText: '项目甲' }).first().click()
await page.waitForTimeout(300)
check('形态二横条下方有试试区(输入框已挂载,点了能落)', (await startersCount()) === 1)

console.log('\n§4 对话形态不受影响')
await setState('newTask', 'setMode', 'chat')
await page.waitForTimeout(300)
check('对话模式 composer 存在', await composerPresent())
await textarea().fill('普通对话')
await textarea().press('Enter')
await page.waitForTimeout(150)
check('对话模式 Enter 正常发送', (await sends()) === 2, String(await sends()))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
