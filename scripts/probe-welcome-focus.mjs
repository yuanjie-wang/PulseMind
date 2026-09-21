/**
 * Welcome-composer focus probe (real Chromium).
 *
 * 进入新建状态后焦点必须落在消息输入框: the 新建任务 entry, the sidebar's project
 * 新增, a project-row 新建任务 and the welcome page's 对话/项目 capsule all land on
 * the welcome surface, and the next keystroke is meant to be the message. That is
 * a DOM fact no other layer can see:
 *
 *   - `InputArea`'s `autoFocus` is a *mount* contract (the underlying Sender
 *     honors it once), and the chat view stays mounted while other top-level
 *     views show — its wrapper is only `display: none` — so the welcome
 *     composer that is already up never re-mounts when the user comes back.
 *     The re-run rides `focusToken` instead, and the effect that consumes it is
 *     invisible to jsdom (vitest here is node-env, no layout, no focus model).
 *   - The closing `ProjectModal` restores focus to its trigger by default
 *     (antd's `focusTriggerAfterClose`), *after* the create path has already
 *     handed focus to the composer. Only a real browser shows who wins.
 *
 * What this mounts (production components, never copies):
 *
 *   1. the real `InputArea` in the welcome configuration — the token contract
 *      itself: focuses on mount, re-focuses on a token change, and stays put
 *      while the autoFocus rule is off (messages present / autoFocus={false})
 *   2. the real `ChatView` in an AppLayout-shaped shell (the chat host flips to
 *      `display: none` on another view, exactly as AppLayout does), driven
 *      through the real `newTaskStore` / `navigationStore` — what AppLayout
 *      calls when it jumps into the new-task state after creating a project
 *   3. the real `ProjectModal` in front of a stand-in composer, with the create
 *      path's focus hand-off reproduced in the same commit as the close
 *
 * No Electron, no LLM: pure renderer components in a plain page.
 *
 * Usage: node scripts/probe-welcome-focus.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-welcome-focus-')), 'harness.js')

const HARNESS = `
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { InputArea } from './src/renderer/src/components/chat/InputArea'
import { ProjectModal } from './src/renderer/src/components/project/ProjectModal'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'

// The components read electronAPI on render. Most calls are fire-and-forget, but
// the welcome page's suggestion cards map over what four of them answer, so an
// undefined there would throw before the composer ever mounts.
const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  projectValidateDir: { ok: true },
  showOpenDialog: { canceled: true, filePaths: [] },
  // SettingsProvider (added when ProjectCards grew its own ProjectModal) loads
  // this and useAppSettings setSettings(es) it verbatim — undefined here would
  // blank the whole settings object and throw on settings.profiles.
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
// main.tsx's boot, in order: the variable sheet, then the attribute. The chat's
// migrated surfaces read var(--pm-*), and an unset variable resolves to nothing
// (transparent / inherited) — so a probe that measures them without the sheet is
// measuring a page the app never renders (PLAN-dark-mode D7: the helper ships in
// the same change as the migration, not after it).
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    // Subscribe-style APIs are handed back as an effect cleanup
    // (useEffect(() => api.onX(cb), [])), so they must answer with a function —
    // a Promise there breaks the unmount.
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'projectCreate') {
      const input = args[0] || {}
      return Promise.resolve({ id: 'proj_new', name: input.name, workspaceDir: input.workspaceDir, createdAt: '', updatedAt: '' })
    }
    return Promise.resolve(TABLE[key])
  },
})

/** What has focus, and inside which mounted case — the assertion's one source. */
window.__focus = () => {
  const el = document.activeElement
  const caseHost = el && el.closest ? el.closest('[id^="case-"]') : null
  return { tag: el ? el.tagName : null, caseId: caseHost ? caseHost.id : null, isTextarea: !!el && el.tagName === 'TEXTAREA' }
}

/** A sibling button, so "blur" means a real mouse-driven focus move out of the composer. */
function BlurTarget() {
  return <button data-blur style={{ margin: 8 }}>blur</button>
}

// ── Section 1: the token contract on the real InputArea ──

function TokenCase({ hasMessages, autoFocus }) {
  const [token, setToken] = useState('t0')
  window.__setToken = setToken
  return (
    <div data-case="token">
      <BlurTarget />
      <div style={{ width: 1000 }}>
        <InputArea
          layout="inline"
          focusToken={token}
          hasMessages={hasMessages}
          autoFocus={autoFocus}
          isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
          onSendMessage={() => {}} onCancel={() => {}}
        />
      </div>
    </div>
  )
}

// ── Section 2: the real ChatView, in an AppLayout-shaped shell ──

const EMPTY = []
const IDLE = { status: 'idle' }
const ONE_MESSAGE = [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: '2026-09-16T10:00:00.000Z' }]

function ChatShell({ messages }) {
  // AppLayout hides the chat view behind display:none, it never unmounts it —
  // reproducing that is the whole point: a remount would autoFocus for free.
  const viewKind = useNavigationStore((s) => s.view.kind)
  return (
    <div data-case="chat">
      <BlurTarget />
      <div id="chat-host" style={{ display: viewKind === 'chat' ? 'block' : 'none', height: 600 }}>
        <ChatView
          messages={messages}
          isRequesting={false}
          agentStatus={IDLE}
          streamingBlocks={EMPTY}
          hasApiKey={true}
          onSendMessage={() => {}} onCancel={() => {}}
          onApproveTool={() => {}} onRejectTool={() => {}}
          onClearError={() => {}}
          conversations={EMPTY}
          onOpenConversation={() => {}}
        />
      </div>
    </div>
  )
}

// ── Section 3: the create path's focus hand-off vs the modal's close ──

function ModalCase() {
  const [open, setOpen] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  // The composer's side of the hand-off: focused by an effect in the same commit
  // that closes the modal, which is what ChatView's focusToken effect does.
  useEffect(() => {
    if (focusTick) document.getElementById('stand-in')?.focus()
  }, [focusTick])
  return (
    <div data-case="modal">
      <button id="new-project" onClick={() => setOpen(true)}>新增</button>
      <textarea id="stand-in" />
      <ProjectModal
        open={open}
        editing={null}
        onClose={() => setOpen(false)}
        onSaved={(project) => { window.__saved = project; setFocusTick((t) => t + 1) }}
      />
    </div>
  )
}

// ── Mounting: one case at a time, so no other composer competes for focus ──

let roots = []
window.__mount = (kind, opts) => {
  for (const r of roots) r.unmount()
  roots = []
  document.querySelectorAll('[id^="case-"]').forEach((el) => el.remove())
  const host = document.createElement('div')
  host.id = 'case-' + kind
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  const body =
    kind === 'token' ? <TokenCase hasMessages={!!opts?.hasMessages} autoFocus={opts?.autoFocus} />
    : kind === 'chat' ? <ChatShell messages={opts?.withMessages ? ONE_MESSAGE : EMPTY} />
    : <ModalCase />
  root.render(
    <ConfigProvider>
      <AntdApp>
        {/* The real app wraps everything in SettingsProvider (App.tsx), and the
            welcome project form now renders ProjectModal through ProjectCards —
            ProjectModal reads useSettings, so without the provider the 项目
            capsule switch throws before the composer can take focus. */}
        <SettingsProvider>
          <TranslationProvider>{body}</TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

window.__stores = { newTask: useNewTaskStore, navigation: useNavigationStore }

const root = createRoot(document.getElementById('root'))
root.render(<div />)
roots.push(root)
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

const focusNow = () => page.evaluate(() => window.__focus())
const mount = async (kind, opts) => {
  await page.evaluate(([k, o]) => window.__mount(k, o), [kind, opts ?? {}])
  await page.waitForTimeout(250)
}
/** Blur the composer with a real click — a synthetic .blur() would leave the
 *  document's focus nowhere in particular and hide a wrongly-focusing effect. */
const blur = async () => {
  await page.locator('[data-blur]').first().click()
  await page.waitForTimeout(50)
}
const token = async (value) => {
  await page.evaluate((v) => window.__setToken(v), value)
  await page.waitForTimeout(150)
}
const setState = (path, value) =>
  page.evaluate(([p, v]) => {
    const [store, action] = p
    window.__stores[store].getState()[action](v)
  }, [path, value])
const composerFocused = async (caseId) => {
  const f = await focusNow()
  return f.isTextarea && f.caseId === caseId
}
/** The stand-in composer lives outside a case host on purpose (it stands for the
 *  chat view's composer, which the modal knows nothing about). */
const standInFocused = () => page.evaluate(() => document.activeElement?.id === 'stand-in')

console.log('\n§1 InputArea — focusToken 重跑 autoFocus 规则（欢迎配置）')
await mount('token', { hasMessages: false })
check('挂载即聚焦（hasMessages=false 的默认规则）', await composerFocused('case-token'), JSON.stringify(await focusNow()))

await blur()
check('blur 后焦点确实离开输入框', !(await composerFocused('case-token')), JSON.stringify(await focusNow()))

await token('t1')
check('focusToken 变化把焦点交回输入框', await composerFocused('case-token'), JSON.stringify(await focusNow()))

await mount('token', { hasMessages: true })
check('有消息时不自动聚焦', !(await composerFocused('case-token')), JSON.stringify(await focusNow()))
await blur()
await token('t2')
check('有消息时 focusToken 变化也不聚焦（规则关闭）', !(await composerFocused('case-token')), JSON.stringify(await focusNow()))

await mount('token', { hasMessages: false, autoFocus: false })
await blur()
await token('t3')
check('autoFocus={false} 时 focusToken 变化不聚焦', !(await composerFocused('case-token')), JSON.stringify(await focusNow()))

console.log('\n§2 ChatView 欢迎面 — 从别的视图回来 / 预选项目后焦点回到输入框')
await mount('chat')
check('欢迎面挂载即聚焦输入框', await composerFocused('case-chat'), JSON.stringify(await focusNow()))

await setState(['navigation', 'navigate'], { kind: 'settings' })
await page.waitForTimeout(150)
const hidden = await page.evaluate(() => document.getElementById('chat-host')?.style.display)
check('切走后聊天视图是 display:none（不是卸载）', hidden === 'none', String(hidden))
check('隐藏期间焦点没有被吸进输入框', !(await composerFocused('case-chat')), JSON.stringify(await focusNow()))

await setState(['navigation', 'navigate'], { kind: 'chat' })
await page.waitForTimeout(200)
check('切回聊天视图后焦点回到输入框', await composerFocused('case-chat'), JSON.stringify(await focusNow()))

await blur()
await setState(['newTask', 'setProjectId'], 'proj_new')
await page.waitForTimeout(200)
check('给下一个任务预选项目后焦点回到输入框（新建项目后的落地态）', await composerFocused('case-chat'), JSON.stringify(await focusNow()))

await blur()
await setState(['newTask', 'setMode'], 'project')
await page.waitForTimeout(200)
check('切到 项目 形态后焦点回到输入框（侧边栏 项目 chip / 项目行 新建任务）', await composerFocused('case-chat'), JSON.stringify(await focusNow()))

await blur()
await setState(['newTask', 'setMode'], 'chat')
await page.waitForTimeout(200)
check('切回 对话 形态后焦点回到输入框', await composerFocused('case-chat'), JSON.stringify(await focusNow()))

await mount('chat', { withMessages: true })
await blur()
await setState(['navigation', 'navigate'], { kind: 'settings' })
await setState(['navigation', 'navigate'], { kind: 'chat' })
await page.waitForTimeout(200)
check('有消息的会话切回来时不抢焦点（只有新建态才聚焦）', !(await composerFocused('case-chat')), JSON.stringify(await focusNow()))

console.log('\n§3 ProjectModal — 关闭后不把焦点从输入框抢回触发按钮')
await mount('modal')
await page.locator('#new-project').click()
await page.waitForTimeout(400)
const modalFocus = await page.evaluate(() => ({
  inModal: !!document.activeElement?.closest?.('.ant-modal'),
  tag: document.activeElement?.tagName ?? null,
}))
check('弹窗打开时焦点在弹窗里（首字段：工作区输入框）', modalFocus.inModal && modalFocus.tag === 'INPUT', JSON.stringify(modalFocus))

// 创建态字段顺序是 工作区 → 名称 → 概述：工作区的输入会触发 500ms 防抖的主进程
// 校验，通过后 创建 才可点（填路径还会把尾段自动带进空名称，这里随后显式覆写）。
const inputs = page.locator('.ant-modal input')
await inputs.nth(0).fill('/tmp/pm-probe-project')
await inputs.nth(1).fill('pm-probe-project')
await page.waitForTimeout(900)
const okEnabled = await page.locator('.ant-modal .ant-btn-primary').isEnabled()
check('校验通过后 创建 可点', okEnabled)

await page.locator('.ant-modal .ant-btn-primary').click()
await page.waitForTimeout(900)
const saved = await page.evaluate(() => window.__saved?.name ?? null)
check('创建成功后 onSaved 带回新项目（进入新建态的信号）', saved === 'pm-probe-project', String(saved))
check('弹窗已关闭', !(await page.locator('.ant-modal .ant-btn-primary').isVisible()))
check('关闭动画结束后焦点仍在输入框，而不是被还回 新增 按钮', await standInFocused(), JSON.stringify(await focusNow()))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
