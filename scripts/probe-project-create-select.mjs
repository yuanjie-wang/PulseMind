/**
 * Create-then-select probe (real Chromium).
 *
 * 「在左侧边栏新建项目后，进入项目模式的welcome页面，需要自动选中刚刚新建的
 * 项目」(user 2026-11-09). Both ProjectModal hosts — AppLayout (the sidebar's
 * 项目 tab +, the 新建项目 accelerator) and ProjectCards (the welcome picker's
 * own dashed 新建项目 card) — select the project they just created. They used
 * to lose it at once: the project-list reload was fire-and-forget, the
 * selection was applied while it was still in flight, and ProjectCards'
 * stale-selection guard (陈旧选择自愈) read the already-loaded OLD list, found
 * no such project and cleared the pick. The fix chains the selection after the
 * reload (`reload().then(select)`).
 *
 * Why a probe: the race is between a React effect and an IPC round trip — an
 * ordering of real commits no node-env unit test can mount
 * (tests/project-create-select.test.ts pins the source ordering and the store
 * property the fix rests on; this shows the user-visible outcome).
 *
 * What this mounts (production components, never copies): the real AppLayout
 * with the real ChatView welcome page inside, the real ProjectModal, the real
 * projectStore / newTaskStore — driven with a real mouse through the user's
 * own path. The electronAPI stub keeps a stateful project list (projectCreate
 * really adds to what projectList returns) and answers projectList on a 40ms
 * timer: the main-process round trip + SQLite read the real IPC costs, and the
 * window the guard used to fire in. Non-vacuity: run against the pre-fix
 * source and §1/§2's selection checks fail (the strip never appears).
 *
 *   §1 sidebar: 项目 tab → + → fill → 创建 → welcome in project mode with the
 *      new project selected (compressed strip form), and it stays selected
 *   §2 welcome picker: 更换 → dashed 新建项目 → fill → 创建 → the second new
 *      project replaces the first as the selection
 *
 * No Electron, no LLM: pure renderer components in a plain page.
 *
 * Usage: node scripts/probe-project-create-select.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-project-create-select-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-project-create-select-shots')
mkdirSync(SHOTS, { recursive: true })

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'
import { useProjectStore } from './src/renderer/src/stores/projectStore'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

window.__newTask = useNewTaskStore
window.__projectStore = useProjectStore

window.__mount = () => {
  createRoot(document.getElementById('root')).render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AppLayout
            conversations={[]}
            activeConversationKey={undefined}
            totalSessions={0}
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
              conversationId={undefined}
              conversations={[]}
              isRequesting={false}
              agentStatus={{ status: 'idle' }}
              streamingBlocks={[]}
              hasApiKey={true}
              onSendMessage={() => {}}
              onBrowserTaskStart={() => {}}
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
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
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
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: the stores subscribe at import time and AppLayout reads
// electronAPI at module scope. projectList must come before the /[Ll]ist$/
// catch-all, and must answer a FRESH array every time (the real IPC is a
// structured clone — a shared reference would let React skip the update).
await page.addScriptTag({
  content: `
    const T = '2026-11-08T09:00:00.000Z'
    window.__projects = [
      { id: 'default', name: '默认项目', workspaceDir: '/tmp/pm-probe/default', createdAt: T, updatedAt: T },
      { id: 'p_old', name: '已有项目', workspaceDir: '/tmp/pm-probe/old', colorHue: 120, createdAt: T, updatedAt: T },
    ]
    window.__seq = 0
    window.__calls = []
    const IPC_MS = 40
    const later = (v) => new Promise((resolve) => setTimeout(() => resolve(v), IPC_MS))
    window.electronAPI = new Proxy({}, { get: (_t, key) =>
      key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
        : key === 'getSettings' ? () => Promise.resolve({
            activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
            workspaceDir: '', autoCleanup: true, locale: 'zh',
          })
        : key === 'projectList' ? () => { window.__calls.push('projectList'); return later(window.__projects.map((p) => ({ ...p }))) }
        : key === 'projectValidateDir' ? () => Promise.resolve({ ok: true })
        : key === 'projectCreate' ? (input) => {
            window.__calls.push('projectCreate')
            const now = new Date().toISOString()
            const p = { id: 'proj_new_' + (++window.__seq), name: input.name, workspaceDir: input.workspaceDir, colorHue: 200, createdAt: now, updatedAt: now }
            // Newest first after the synthesized default, as projectStore.list orders.
            window.__projects = [window.__projects[0], p, ...window.__projects.slice(1)]
            return later({ ...p })
          }
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined) })
    document.documentElement.dataset.platform = ''`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

await page.evaluate(() => window.__mount())
await page.waitForSelector('.sidebar-list-tab')

const state = () =>
  page.evaluate(() => {
    const strip = document.querySelector('[data-welcome-project-strip]')
    return {
      mode: window.__newTask.getState().mode,
      projectId: window.__newTask.getState().projectId,
      strip: strip ? strip.querySelector('span[style*="font-weight: 600"]')?.textContent ?? strip.textContent : null,
      createCards: document.querySelectorAll('[data-action="create-project"]').length,
      creates: window.__calls.filter((c) => c === 'projectCreate').length,
    }
  })

/** Fill the visible create modal and submit it. antd 6 names the content box
 *  `.ant-modal-container` (5's `.ant-modal-content`); `:visible` skips the
 *  other host's closed instance, which antd keeps in the DOM. */
async function createThroughModal(workspaceDir, name) {
  const modal = page.locator('.ant-modal-container:visible')
  await modal.waitFor()
  // ProjectModal resets its fields in afterOpenChange(true), which antd fires
  // when the open motion ENDS (~300ms) — anything typed before that is wiped.
  // Wait until no enter/appear motion class is left on the visible modal.
  await page.waitForFunction(() => {
    const box = [...document.querySelectorAll('.ant-modal')].find((m) => m.offsetParent !== null)
    return !!box && !/-(enter|appear)/.test(box.className)
  })
  await page.waitForTimeout(100)
  await modal.locator('input[placeholder="/path/to/workspace"]').fill(workspaceDir)
  await modal.locator('input[placeholder="例如：my-app"]').fill(name)
  // Past the dir-probe debounce (DIR_PROBE_DELAY_MS 500) so the verdict is in.
  await page.waitForTimeout(650)
  await modal.locator('.ant-modal-footer .ant-btn-primary').click()
  // create IPC (40ms) + reload (40ms) + React commits, with room for a guard
  // that fires late — a pick cleared after this point would still be caught
  // by the stability re-read below.
  await page.waitForTimeout(600)
}

/* ── §1 sidebar: 项目 tab → + → 创建 ─────────────────────────────────────── */

const before = await state()
check('starts on the chat welcome with nothing selected', before.mode === 'chat' && before.projectId === null && before.strip === null,
  `mode=${before.mode} projectId=${before.projectId}`)

await page.locator('.sidebar-list-tab', { hasText: '项目' }).click()
// The 项目 tab's list (ProjectSidebarList) loads the store on mount, so the
// pre-create snapshot is LOADED — exactly the state the guard misread.
await page.waitForFunction(() => window.__projectStore.getState().loaded)
const loadedBefore = await page.evaluate(() => window.__projectStore.getState().projects.map((p) => p.id).join(','))
check('the sidebar list loaded the pre-create snapshot', loadedBefore === 'default,p_old', loadedBefore)
await page.locator('.sidebar-list-action[aria-label="新建项目"]').click()
const modalTitle = await page.locator('.ant-modal-container:visible .ant-modal-title').textContent()
check('the sidebar + opens the create modal', modalTitle === '新建项目', `title=${modalTitle}`)

await createThroughModal('/tmp/pm-probe/sidebar-new', '侧栏新项目')
const s1 = await state()
check('the project was created exactly once', s1.creates === 1, `projectCreate × ${s1.creates}`)
check('lands on the welcome page in project mode', s1.mode === 'project', `mode=${s1.mode}`)
check('the just-created project is the selection', s1.projectId === 'proj_new_1', `projectId=${s1.projectId}`)
check('compressed form: the strip names the new project', s1.strip === '侧栏新项目', `strip=${s1.strip}`)
check('compressed form: the picker grid (and its create card) is gone', s1.createCards === 0, `create cards=${s1.createCards}`)
await page.screenshot({ path: join(SHOTS, 'sidebar-create-selected.png') })

await page.waitForTimeout(500)
const s1b = await state()
check('the selection survives the settle window', s1b.projectId === 'proj_new_1' && s1b.strip === '侧栏新项目',
  `projectId=${s1b.projectId} strip=${s1b.strip}`)

/* ── §2 welcome picker: 更换 → dashed 新建项目 → 创建 ────────────────────── */

await page.locator('[data-welcome-project-strip] button').click()
await page.waitForSelector('[data-action="create-project"]')
const s2a = await state()
check('更换 returns to the selection form', s2a.projectId === null && s2a.strip === null && s2a.createCards > 0,
  `projectId=${s2a.projectId} create cards=${s2a.createCards}`)

await page.locator('[data-action="create-project"]').first().click()
await createThroughModal('/tmp/pm-probe/welcome-new', '欢迎页新项目')
const s2 = await state()
check('the welcome picker created its project', s2.creates === 2, `projectCreate × ${s2.creates}`)
check('the picker-created project is the selection', s2.projectId === 'proj_new_2', `projectId=${s2.projectId}`)
check('the strip names the picker-created project', s2.strip === '欢迎页新项目', `strip=${s2.strip}`)
await page.screenshot({ path: join(SHOTS, 'welcome-create-selected.png') })

await page.waitForTimeout(500)
const s2b = await state()
check('the picker selection survives the settle window', s2b.projectId === 'proj_new_2' && s2b.strip === '欢迎页新项目',
  `projectId=${s2b.projectId} strip=${s2b.strip}`)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks pass${failed.length ? ` — ${failed.length} FAILED` : ''}`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
