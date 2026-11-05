/**
 * Keyless welcome probe (real Chromium): 未配置 API Key 的两个裁定（2026-11-04）
 *
 *  1. 对话模式的输入框整块退场（条件渲染，不是 display:none）——没有密钥，
 *     发送必然失败，输入框只是诱饵。
 *  2. 原来那块 warn 色「豆腐干」换成 ApiKeyGuide 卡：elevated 实底 + veil 边框
 *     + 16 圆角 + 蓝色 Key 图标座 + 主按钮，点按钮进设置（密钥页）。
 *  3. 浏览器模式的 URL 面板同样整块退场（2026-11-04 追加裁定「未配置密钥的时候，
 *     浏览器面板不允许输入URL」）——打开的任务没有 agent 可驱动，URL 输入框与
 *     可点的近期访问行都只是诱饵。
 *
 * 同一台的对照态（hasApiKey=true）必须原样：composer 在、引导卡不在。
 * 这两种形态都是宿主按 hasApiKey 直接分支的 DOM 事实，jsdom 看不见（jsdom 里
 * 条件渲染也"看得见"，但样式/几何/点击都不成立），所以走真 Chromium。
 *
 * Mounts the real `ChatView` in an AppLayout-shaped shell; hasApiKey 由 harness
 * 变量驱动（__setKey 重挂根）。No Electron, no LLM.
 *
 * Usage: node scripts/probe-api-key-guide.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(mkdtempSync(join(tmpdir(), 'pm-apikey-shots-')), 'shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-apikey-probe-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'

const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  getConversationLastUserMessage: '',
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
  browserHistoryQuery: [],
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
window.__hasKey = false

function ChatShell() {
  return (
    <div style={{ display: 'flex', height: 900 }}>
      <div id="fake-sidebar" style={{ width: 264, flexShrink: 0 }} />
      <div id="chat-host" style={{ flex: 1 }}>
        <ChatView
          messages={EMPTY}
          isRequesting={false}
          agentStatus={IDLE}
          streamingBlocks={EMPTY}
          hasApiKey={window.__hasKey}
          onSendMessage={() => true}
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
  useNewTaskStore.getState().setMode('chat')
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
window.__setKey = (v) => { window.__hasKey = v; window.__mount() }
// 任务形态是 store 的活状态（WelcomeContent 订阅），挂载后切即重渲染。
window.__setMode = (m) => {
  window.__mount()
  useNewTaskStore.getState().setMode(m)
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

const composerPresent = () => page.evaluate(() => document.querySelector('[data-welcome-shake="composer"]') !== null)
const textareaPresent = () => page.evaluate(() => document.querySelector('.ant-sender textarea') !== null)
const guidePresent = () => page.evaluate(() => document.querySelector('[data-pm-api-key-guide]') !== null)
const guideStyle = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-pm-api-key-guide]')
    if (!el) return null
    const cs = getComputedStyle(el)
    const badge = el.querySelector('div')
    const badgeStyle = badge ? getComputedStyle(badge) : null
    const button = el.querySelector('button')
    return {
      radius: cs.borderRadius,
      background: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
      badgeBg: badgeStyle?.backgroundColor ?? '',
      buttonKind: button?.className ?? '',
      text: el.textContent ?? '',
    }
  })

console.log('\n§1 未配置密钥：输入框整块退场 + 引导卡接管')
await page.evaluate(() => window.__mount())
await page.waitForTimeout(400)
check('composer 挂载点不存在(条件渲染)', !(await composerPresent()))
check('输入框不存在', !(await textareaPresent()))
check('引导卡出现', await guidePresent())
const g = await guideStyle()
check('卡片是 elevated 实底(不再是 warn 米黄 #fff7e6)', g !== null && g.background !== 'rgb(255, 247, 230)', g?.background)
check('卡片圆角 16', g !== null && g.radius === '16px', g?.radius)
check('卡片带 1px 边框(veil 语言)', g !== null && g.border === '1px solid', g?.border)
check('图标座淡蓝 wash(--pm-link-bg)', g !== null && g.badgeBg === 'rgba(22, 119, 255, 0.08)', g?.badgeBg)
check('按钮是 antd primary', g !== null && g.buttonKind.includes('ant-btn-primary'), g?.buttonKind ?? '')
check('标题文案在卡上', g !== null && g.text.includes('还差一步'), g?.text?.slice(0, 40))
check('正文说明在卡上', g !== null && g.text.includes('填入一个模型提供商的密钥即可开始对话'))
check('CTA 文案在卡上', g !== null && g.text.includes('配置 API 密钥'))
// 2026-11-05 一次性模板包入口：次级导入按钮与主 CTA 并排（compact 竖排），
// DOM 顺序主 CTA 在前——上面的 buttonKind 取 first() 不受影响。
check('导入模板包按钮在卡上', await page.evaluate(() => document.querySelector('[data-pm-api-key-guide] [data-pm-template-import]') !== null))
check('导入按钮文案在卡上', g !== null && g.text.includes('导入模板包'))
// 几何：卡片顶替的是 composer 原来的位置——welcome 区不因引导卡出垂直
// 滚动条，卡片贴住列的底部（原来输入框所在处），不是飘在中间。
const layout = await page.evaluate(() => {
  const region = document.querySelector('[data-welcome-region]')
  const card = document.querySelector('[data-pm-api-key-guide]')
  const host = document.querySelector('#chat-host')
  return {
    scroll: region?.scrollHeight ?? 0,
    client: region?.clientHeight ?? 0,
    cardBottom: card?.getBoundingClientRect().bottom ?? 0,
    hostBottom: host?.getBoundingClientRect().bottom ?? 0,
  }
})
check('welcome 页不出垂直滚动条', layout.scroll <= layout.client + 1, `${layout.scroll} <= ${layout.client}`)
check(
  '引导卡贴住列的底部(输入框原位)',
  layout.hostBottom - layout.cardBottom > 0 && layout.hostBottom - layout.cardBottom < 60,
  `gap ${Math.round(layout.hostBottom - layout.cardBottom)}px`,
)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, 'keyless-welcome.png') })

console.log('\n§2 点引导卡按钮 → 进设置(密钥页)')
const before = await page.evaluate(() => JSON.stringify(window.__stores.navigation.getState().view))
await page.locator('[data-pm-api-key-guide] button').first().click()
await page.waitForTimeout(150)
const view = await page.evaluate(() => window.__stores.navigation.getState().view)
check('导航到设置视图', view.kind === 'settings', JSON.stringify(view))
check('落在密钥设置页', view.settingsTab === 'settings', JSON.stringify(view))
check('点前不在设置视图', !before.includes('settings'), before)

console.log('\n§3 对照态(已配密钥)：composer 回归，引导卡退场')
await page.evaluate(() => window.__setKey(true))
await page.waitForTimeout(400)
check('composer 挂载点回归', await composerPresent())
check('输入框回归', await textareaPresent())
check('引导卡退场', !(await guidePresent()))
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, 'keyed-welcome.png') })

console.log('\n§4 未配置密钥 + 浏览器模式：URL 面板显示但禁用(2026-11-04 第四裁定翻转本节的退场断言)')
await page.evaluate(() => window.__setKey(false))
await page.evaluate(() => window.__setMode('browser'))
await page.waitForTimeout(400)
check(
  'browser URL 输入框仍在，但 disabled',
  await page.evaluate(() => {
    const el = document.querySelector('[data-pm-browser-task-url]')
    return !!el && el.disabled === true
  }),
)
check('browser 面板仍在(退场会让这个形态在无密钥机器上完全不可见)', await page.evaluate(() => document.querySelector('[data-pm-browser-task-panel]') !== null))
check('引导卡出现', await guidePresent())
const browserLayout = await page.evaluate(() => {
  const region = document.querySelector('[data-welcome-region]')
  const card = document.querySelector('[data-pm-api-key-guide]')
  const host = document.querySelector('#chat-host')
  return {
    scroll: region?.scrollHeight ?? 0,
    client: region?.clientHeight ?? 0,
    cardBottom: card?.getBoundingClientRect().bottom ?? 0,
    hostBottom: host?.getBoundingClientRect().bottom ?? 0,
  }
})
check('welcome 页不出垂直滚动条', browserLayout.scroll <= browserLayout.client + 1, `${browserLayout.scroll} <= ${browserLayout.client}`)
check(
  '引导卡仍在列底(与 chat 形态同位置)',
  browserLayout.hostBottom - browserLayout.cardBottom > 0 && browserLayout.hostBottom - browserLayout.cardBottom < 60,
  `gap ${Math.round(browserLayout.hostBottom - browserLayout.cardBottom)}px`,
)
await page.screenshot({ path: join(SHOTS, 'keyless-browser-welcome.png') })

console.log('\n§5 对照态(已配密钥)+浏览器模式：URL 面板回归')
await page.evaluate(() => window.__setKey(true))
await page.evaluate(() => window.__setMode('browser'))
await page.waitForTimeout(400)
check('browser URL 输入框回归', await page.evaluate(() => document.querySelector('[data-pm-browser-task-url]') !== null))
check('browser 面板回归', await page.evaluate(() => document.querySelector('[data-pm-browser-task-panel]') !== null))
check('引导卡退场', !(await guidePresent()))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
