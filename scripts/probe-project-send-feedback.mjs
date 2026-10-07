/**
 * Project-mode refused-send feedback probe (real Chromium).
 *
 * 项目模式下未选项目就发送——按钮灰着、Enter 静默——用户读到的是「发送无效」
 * (user report 2026-10-07)。拒绝本身发生在 Composer.send() 的 sendBlocked 分支,
 * 而回答住在知道语义的 ChatView:整个选项目区域摇晃一次(复用新建任务的
 * guidance shake,指向「缺的是项目」)+ 一条 toast 说清原因 + 输入的文字一个
 * 字都不丢。这些都是 DOM 时序事实,jsdom 看不见:
 *
 *   - WAAPI 摇晃(el.getAnimations 的 playState)
 *   - antd message toast 的出现与消失
 *   - sendBlocked 拒绝路径完全绕开 InputArea.submit——文本天然保留
 *   - 选择项目后同一根 Enter 正常发送,文本清空(对照)
 *
 * Mounts the real `ChatView` in an AppLayout-shaped shell (same harness shape
 * as probe-welcome-focus), driven through the real `newTaskStore`. No Electron,
 * no LLM: `onSendMessage` is a counting stub.
 *
 * Usage: node scripts/probe-project-send-feedback.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
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
      {/* 不对称外壳：左侧栏占位。antd message 的 holder 是 body 级 fixed、恒居中
          于整个窗口；toast 必须居中的是聊天列（composer 与项目卡片同列），两者的
          中心在有侧栏时相差侧栏宽的一半 —— 这正是用户报告的「没有水平居中」。 */}
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
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text', '.png': 'dataurl' },
  logLevel: 'warning', treeShaking: false,
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
  page.evaluate(([s, a, v]) => {
    window.__stores[s].getState()[a](v)
  }, [store, action, value])

const shakeState = (target) =>
  page.evaluate((t) => {
    const el = document.querySelector(`[data-welcome-shake="${t}"]`)
    if (!el) return 'missing'
    const anims = el.getAnimations()
    if (!anims.length) return 'idle'
    return anims.some((a) => a.playState === 'running') ? 'running' : 'settling'
  }, target)

const textarea = () => page.locator('.ant-sender textarea').first()
const composerText = () => textarea().inputValue()
const messageVisible = () =>
  page.evaluate((txt) => {
    const box = document.querySelector('.ant-message')
    if (!box) return false
    return box.textContent?.includes(txt) ?? false
  }, '请先选择一个项目作为工作目录')
const sends = () => page.evaluate(() => window.__sends.length)
const sendButtonDisabled = () => page.evaluate(() => {
  const btn = document.querySelector('.pm-send')
  return btn ? btn.disabled : null
})

console.log('\n§1 项目模式未选项目 — 发送被拒的三重回答')
await page.evaluate(() => window.__mount())
await page.waitForTimeout(300)
await setState('newTask', 'setMode', 'project')
await page.waitForTimeout(300)
check('欢迎面进入项目形态(选项目区域已挂载)', (await shakeState('projectPicker')) !== 'missing')
check('未选项目时发送按钮灰着(sendDisabled)', (await sendButtonDisabled()) === true)

// 真实键入 + 真实 Enter —— 按钮是灰的,这条走的是 Sender 的键盘提交路径,
// 也是用户读到「发送无效」的那一拍。
await textarea().fill('帮我整理这个项目的资料')
const before = await composerText()
check('文字已在输入框', before === '帮我整理这个项目的资料', before)
await textarea().press('Enter')
await page.waitForTimeout(120)

check('选项目区域摇晃(拒绝的第一重回答:指向缺的东西)', (await shakeState('projectPicker')) === 'running')
check('toast 说清原因(第二重回答)', await messageVisible())
check('输入的文字一个字不丢(第三重:拒绝不是删除)', (await composerText()) === before)
check('没有任何消息发出(onSendMessage 零调用)', (await sends()) === 0)
check('projectPicker 的信号不波及输入框(按 target 路由)', (await shakeState('composer')) === 'idle')

await page.waitForTimeout(700)
check('摇晃自己停(一次性动画)', (await shakeState('projectPicker')) === 'idle')

// 居中断言：此刻 toast 还活着（3s 寿命）、composer 已停摇（rect 不再被 ±10px
// 的动画污染）。非空转前提先立住：有假侧栏时列中心 ≠ 窗口中心。
const centers = () =>
  page.evaluate(() => {
    const centerOf = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.left + r.width / 2
    }
    return {
      toast: centerOf(document.querySelector('.ant-message-notice')),
      composer: centerOf(document.querySelector('[data-welcome-shake="composer"]')),
      window: window.innerWidth / 2,
    }
  })
const c = await centers()
check('非空转前提：不对称外壳下列中心确实偏离窗口中心', c.composer !== null && Math.abs(c.composer - c.window) > 50, JSON.stringify(c))
check('toast 居中于聊天列(与 composer 包裹盒同轴)', c.toast !== null && Math.abs(c.toast - c.composer) <= 2, JSON.stringify(c))
check('toast 不再是窗口居中(修复前就是窗中心)', c.toast !== null && Math.abs(c.toast - c.window) > 50, JSON.stringify(c))

console.log('\n§2 重复拒绝与解除后的对照')
await textarea().press('Enter')
await page.waitForTimeout(120)
check('再次 Enter 再次摇晃(每次拒绝都有回答,不是只答第一次)', (await shakeState('projectPicker')) === 'running')
check('仍未发出任何消息', (await sends()) === 0)
await page.waitForTimeout(700)

// 选了项目,sendBlocked 解除:同一根 Enter 现在必须真的发送 —— 拒绝路径的
// 存在不能把正常路径也吞了。
await setState('newTask', 'setProjectId', 'proj_x')
await page.waitForTimeout(300)
check('选了项目后发送按钮解除封锁', (await sendButtonDisabled()) === false)
await textarea().press('Enter')
await page.waitForTimeout(150)
check('Enter 正常发出一条消息', (await sends()) === 1, String(await sends()))
check('发送后输入框清空(对照:拒绝路径保留,成功路径清空)', (await composerText()) === '')

console.log('\n§3 对话形态不受影响')
await setState('newTask', 'setMode', 'chat')
await page.waitForTimeout(300)
await textarea().fill('普通对话')
check('对话模式发送按钮可用', (await sendButtonDisabled()) === false)
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
