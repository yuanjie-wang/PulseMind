/**
 * Sidebar 新建任务 + welcome composer gate probe (real Chromium).
 *
 * The nav column's 新建任务 is one standard button with no chips and no flyout:
 * which *form* the next task takes comes from the conversation list's own
 * switcher (项目 tab → a project task, 对话 → a plain conversation), it never
 * carries a project over from an earlier task, and a project task that has no
 * project picked yet cannot be sent — the welcome composer's send button greys
 * out while the textarea keeps working.
 *
 * Both halves are mounted as the real production surfaces, not copies:
 *
 *   AppLayout  — the sidebar row's shape, the tab→mode wiring, and the cleared
 *                project pick (a stale selection must not survive the click)
 *   ChatView   — the welcome composer end to end: typing, the 对话/项目 capsule,
 *                the project cards, the send button's disabled state, Enter, and
 *                the send button wearing the picked project's color
 *
 * No Electron, no LLM, no extension: electronAPI is stubbed, so this cannot
 * touch a real PulseMind session.
 *
 * Usage: node scripts/probe-sidebar-newtask.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-sidebar-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-sidebar-shots')

// The two projects the welcome page is offered, exactly as the main process
// sends them. Since 2026-09-16 the hue is a stored column (projects.color_hue),
// so Alpha carries one — and deliberately not the one its name hashes to, so
// "the stored value is what paints" is a fact this probe can see. Beta carries
// none on purpose: the name-hash fallback for a row with no stored hue is
// exercised by the same run, and Beta is the project the later checks switch to.
// Interpolated into both the harness and the stubbed projectList, so the two
// cannot drift.
const PROJECT_FIXTURES = [
  { id: 'p1', name: 'Alpha', workspaceDir: '/tmp/alpha', colorHue: 210, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' },
  { id: 'p2', name: 'Beta', workspaceDir: '/tmp/beta', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' },
]

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { useNewTaskStore } from './src/renderer/src/stores/newTaskStore'
import { projectHue } from './src/renderer/src/stores/projectStore'
import { sendAccent } from './src/renderer/src/components/chat/Composer'


/** The conversation the chat-state mount opens — matches the projectId the
 *  stubbed list carries, so the composer's lookup has something to find. */
const CONV_KEY = 'conv_20260916100000'

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale={window.__probeLocale}>
          {node}
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

// AppLayout: the sidebar under test. useAppSettings loads over IPC and hands the
// result straight to state, so the stub answers with a real shape.
window.__mountLayout = ({ locale = 'zh', totalSessions = 0, autoCleanup = true } = {}) => {
  window.__probeLocale = locale
  window.__created = 0
  mount(
    <AppLayout
      conversations={[]}
      activeConversationKey=""
      totalSessions={totalSessions}
      autoCleanup={autoCleanup}
      onCreateNew={() => { window.__created = (window.__created || 0) + 1 }}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    />
  )
  return true
}

// ChatView in its welcome state, mounted the way App.tsx mounts it — as
// AppLayout's child — so AppLayout's global stylesheet is in the DOM. That
// matters here: its !important rules repainting every primary button black are
// exactly what the send button's disabled look has to survive.
window.__mountChatView = ({ locale = 'zh' } = {}) => {
  window.__probeLocale = locale
  window.__sent = []
  mount(
    <AppLayout
      conversations={[]}
      activeConversationKey=""
      totalSessions={0}
      autoCleanup={true}
      onCreateNew={() => { window.__created = (window.__created || 0) + 1 }}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    >
      <ChatView
        messages={[]}
        isRequesting={false}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[]}
        hasApiKey={true}
        conversations={[]}
        onSendMessage={(content) => { window.__sent.push(content) }}
        onCancel={() => {}}
        onApproveTool={() => {}}
        onRejectTool={() => {}}
        onClearError={() => {}}
      />
    </AppLayout>
  )
  return true
}

// The same ChatView one message later, mounted the way App.tsx mounts it: the
// conversation exists, so the welcome form is behind us and the composer belongs
// to the conversation's own project. The binding is what useChatController
// writes into the list at materialization — the row it prepends carries the
// projectId, which is why this lookup is already correct on the first frame.
window.__mountConversation = ({ projectId = null, locale = 'zh' } = {}) => {
  window.__probeLocale = locale
  window.__sent = []
  const conv = { key: CONV_KEY, label: 'Alpha 任务', updatedAt: '2026-09-16T10:00:00.000Z', projectId: projectId || undefined }
  mount(
    <AppLayout
      conversations={[conv]}
      activeConversationKey={CONV_KEY}
      totalSessions={1}
      autoCleanup={true}
      onCreateNew={() => { window.__created = (window.__created || 0) + 1 }}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    >
      <ChatView
        messages={[
          { id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '你好' }], createdAt: '2026-09-16T10:00:00.000Z' },
        ]}
        conversationId={CONV_KEY}
        conversations={[conv]}
        isRequesting={false}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[]}
        hasApiKey={true}
        onSendMessage={(content) => { window.__sent.push(content) }}
        onCancel={() => {}}
        onApproveTool={() => {}}
        onRejectTool={() => {}}
        onClearError={() => {}}
      />
    </AppLayout>
  )
  return true
}

window.__newTaskState = () => { const s = useNewTaskStore.getState(); return { mode: s.mode, projectId: s.projectId } }
window.__setMode = (m) => { useNewTaskStore.getState().setMode(m); return true }
window.__setProject = (id) => { useNewTaskStore.getState().setProjectId(id); return true }
window.__sentCount = () => window.__sent.length
window.__createdCount = () => window.__created || 0
window.__resetTask = () => { useNewTaskStore.getState().setMode('chat'); useNewTaskStore.getState().setProjectId(null); window.__created = 0; return true }
// The two production derivations the accent assertions compare against: the
// project's identity hue (off the row when it has one, hashed from the name
// when it does not) and the fill pair the button should paint from it. The
// fixtures themselves are the ones the stubbed projectList serves.
window.__PROJECTS = ${JSON.stringify(PROJECT_FIXTURES)}
window.__projectHue = (project) => projectHue(project)
window.__projectHueName = (name) => projectHue({ name })
window.__sendAccent = (hue) => sendAccent(hue)
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.PROBE_DEV ? 'development' : 'production'), __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** WCAG contrast of a painted fill against the white arrow sitting on it. */
function contrastVsWhite(css) {
  const [r, g, b] = css.match(/\d+/g).slice(0, 3).map(Number)
  const lin = (c) => {
    const n = c / 255
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// PROBE_DEV runs React's development build, whose error reports name the
// offending component on the console — the only way to attribute a bad cleanup.
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: AppLayout reads electronAPI at module scope (its window-control
// inset is computed on import), and ESM imports evaluate ahead of the harness body.
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'projectList' ? () => Promise.resolve(${JSON.stringify(PROJECT_FIXTURES)})
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: window.__probeLocale || 'zh',
        })
      // Every *List call the welcome band makes resolves to an empty collection:
      // an undefined would reach a .filter/.map in a store.
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      // Event subscriptions answer with their unsubscribe function, which is what
      // the preload returns and what a useEffect may hand back as its cleanup.
      // The generic fallback below would return a *promise* there, and React
      // calls that as the cleanup — "destroy is not a function", attributed to
      // ChatView, which is exactly what this stub used to do.
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const shot = async (sel, name) => (sel ? page.locator(sel).screenshot({ path: join(SHOTS, name) }) : page.screenshot({ path: join(SHOTS, name) }))

/* ── AppLayout: the sidebar row ─────────────────────────────────────────── */

const newTask = () => page.locator('button.new-chat-btn', { hasText: '新建任务' })
const listTab = (label) => page.locator('.sidebar-list-tab', { hasText: label })

await page.evaluate(() => window.__mountLayout({}))
await page.waitForSelector('.ant-layout-sider')

const geometry = await page.evaluate(() => {
  const entries = [...document.querySelectorAll('button.new-chat-btn')]
  const entry = entries.find((b) => b.textContent.includes('新建任务'))
  const other = entries.find((b) => b.textContent.includes('搜索'))
  const box = entry.getBoundingClientRect()
  return {
    width: box.width,
    height: box.height,
    iconX: entry.querySelector('.ant-btn-icon')?.getBoundingClientRect().left,
    otherIconX: other?.querySelector('.ant-btn-icon')?.getBoundingClientRect().left,
    label: entry.textContent,
    chips: document.querySelectorAll('.new-task-chip, .new-task-chips').length,
  }
})
check('entry is one full-width 40px row', Math.abs(geometry.width - 264) <= 1 && geometry.height === 40, `${geometry.width.toFixed(1)} x ${geometry.height}`)
check('icon aligns with the rows below', Math.abs(geometry.iconX - geometry.otherIconX) < 1, `${geometry.iconX.toFixed(1)} vs ${geometry.otherIconX.toFixed(1)}`)
check('entry carries no chip/pill', geometry.chips === 0 && geometry.label === '新建任务', `label "${geometry.label}"`)
check('split entry keeps its caret flyout', (await page.locator('button:has-text("能力") .nav-split').count()) === 1)

await page.evaluate(() => window.__resetTask())
await newTask().click()
let task = await page.evaluate(() => window.__newTaskState())
check('对话 tab → 新建任务 presets mode=chat', task.mode === 'chat', task.mode)
check('对话 tab click routed through onCreateNew once', (await page.evaluate(() => window.__createdCount())) === 1)

// A fresh task must not inherit the previous task's project.
await page.evaluate(() => window.__setProject('p1'))
await listTab('项目').click()
await newTask().click()
task = await page.evaluate(() => window.__newTaskState())
check('项目 tab → 新建任务 presets mode=project', task.mode === 'project', task.mode)
check('项目 tab → 新建任务 clears the stale project pick', task.projectId === null, String(task.projectId))
check('项目 tab click routed through onCreateNew once', (await page.evaluate(() => window.__createdCount())) === 2)
await shot('.ant-layout-sider', 'zh-projects-tab.png')

await listTab('对话').click()
await newTask().click()
check('back to 对话 tab → mode=chat again', (await page.evaluate(() => window.__newTaskState())).mode === 'chat')

// The 新增 button beside the pill carries the same promise (its tooltip reads
// 新建对话 on this tab), so it may not land in a project form either — the state
// below is what a previous project task left behind.
await page.evaluate(() => window.__mountLayout({}))
await page.waitForSelector('.ant-layout-sider')
await page.evaluate(() => { window.__setMode('project'); window.__setProject('p1') })
await page.locator('.sidebar-list-action[aria-label="新建对话"]').click()
task = await page.evaluate(() => window.__newTaskState())
check('对话 tab 新增 → mode=chat, no inherited pick', task.mode === 'chat' && task.projectId === null, `${task.mode} / ${String(task.projectId)}`)
check('对话 tab 新增 still creates', (await page.evaluate(() => window.__createdCount())) === 1, `${await page.evaluate(() => window.__createdCount())} call(s)`)
await page.evaluate(() => window.__resetTask())

await page.evaluate(() => window.__mountLayout({ totalSessions: 100, autoCleanup: false }))
await page.waitForSelector('.ant-layout-sider')
check('capped: 新建任务 disabled', await newTask().isDisabled())

/* ── ChatView: the welcome composer's send gate ─────────────────────────── */

// The composer's own send button — the up arrow. The package's built-in actions
// button wears the same circle class and the same arrow, and is hidden by
// .ant-sender-actions-btn; :visible is what separates them, or every state
// assertion below would read the hidden one and pass vacuously.
const sendButton = () => page.locator('.ant-sender button:has(.anticon-arrow-up):visible').first()
/** The composer's own send button, found in-page (the package's built-in actions
 *  button wears the same circle class and arrow, and is hidden by
 *  .ant-sender-actions-btn — :visible is what separates them). */
await page.evaluate(() => {
  window.__findSend = () =>
    [...document.querySelectorAll('.ant-sender button')].find(
      (el) => el.querySelector('.anticon-arrow-up') && el.offsetParent !== null
    )
})
/** What the user actually sees on that button, read once it has settled. Both
 *  halves land late: React commits the disabled attribute after the interaction,
 *  and the opacity then *transitions* to it (measured mid-flight at 0.55 on the
 *  way back to solid), so an immediate read reports the previous state — which is
 *  exactly how this probe stayed green while the user saw no grey at all. So:
 *  wait for the attribute, wait out the transition the button declares for
 *  itself, then read. The duration rides along as evidence of that mechanism. */
const settledLook = async (expectedDisabled) => {
  await page.waitForFunction((exp) => {
    const b = window.__findSend()
    return !!b && b.disabled === exp
  }, expectedDisabled, { polling: 30 })
  const transition = await page.evaluate(() => getComputedStyle(window.__findSend()).transitionDuration)
  const ms = Math.max(0, ...transition.split(',').map((s) => parseFloat(s) * (s.trim().endsWith('ms') ? 1 : 1000)))
  await page.waitForTimeout(ms + 60)
  return page.evaluate((t) => {
    const b = window.__findSend()
    const cs = getComputedStyle(b)
    return { opacity: cs.opacity, background: cs.backgroundColor, disabled: b.disabled, transition: t }
  }, transition)
}
const composerText = () => page.locator('.ant-sender textarea')
const capsule = (label) => page.locator('.task-switch .ant-segmented-item', { hasText: label })

await page.evaluate(() => { window.__resetTask(); window.__mountChatView({}) })
await page.waitForSelector('.ant-sender textarea')

// Baseline: a plain conversation is sendable.
await composerText().fill('帮我看看这个仓库')
const enabledLook = await settledLook(false)
check('chat mode: send button enabled with text', !enabledLook.disabled)
check('enabled send button paints solid', enabledLook.opacity === '1' && enabledLook.background === 'rgb(0, 0, 0)', JSON.stringify(enabledLook))
await capsule('项目').click()
check('capsule switch reaches project mode', (await settledLook(true)).disabled && (await page.evaluate(() => window.__newTaskState())).mode === 'project')
check('project mode, nothing picked: send button greyed', (await settledLook(true)).disabled)
// The visual half, which the disabled attribute cannot express: AppLayout's
// stylesheet paints every primary button black with !important, so antd's own
// disabled look never reaches this circle and both states are the same pixels.
// What must actually change on screen is the opacity.
const blockedLook = await settledLook(true)
check('blocked send button is visibly dimmed', blockedLook.opacity !== '1' && parseFloat(blockedLook.opacity) <= 0.5, JSON.stringify(blockedLook))
// The two states have to differ *on screen* — the paint only, not the disabled
// attribute, or a pair of identical pixels would satisfy this.
const paint = ({ opacity, background }) => JSON.stringify({ opacity, background })
check('blocked and enabled states paint differently', paint(blockedLook) !== paint(enabledLook), `${paint(blockedLook)} vs ${paint(enabledLook)}`)
check('the textarea stays usable while blocked', !(await composerText().isDisabled()))
await composerText().press('Enter')
check('Enter cannot send while blocked', (await page.evaluate(() => window.__sentCount())) === 0)
await shot(null, 'zh-welcome-blocked.png')

// Picking a card is what unblocks it — and what colors the button: the send
// button then wears the project's identity hue, the one its card's wash and
// check icon already use. That hue now comes off the row (`color_hue`), and the
// fixture's stored value is deliberately not what the name hashes to, so a
// regression back to hashing at paint time cannot pass as the same color.
const hues = await page.evaluate(() => ({
  stored: window.__projectHue(window.__PROJECTS[0]),
  hashed: window.__projectHueName('Alpha'),
  onRow: window.__PROJECTS[0].colorHue,
}))
check(
  'the fixture proves the stored hue is the one that reaches the composer',
  hues.stored === hues.onRow && hues.stored !== hues.hashed,
  `row ${hues.onRow} → ${hues.stored}, while the name would hash to ${hues.hashed}`
)
await page.locator('[role="button"]', { hasText: 'Alpha' }).first().click()
const pickedLook = await settledLook(false)
check('picking a project preselects it', (await page.evaluate(() => window.__newTaskState())).projectId === 'p1')
check('picked: send button enabled again', !pickedLook.disabled)
check('picked: dimming is gone', pickedLook.opacity === '1', JSON.stringify(pickedLook))
const alpha = await page.evaluate(() => window.__sendAccent(window.__projectHue(window.__PROJECTS[0])))
check('picked: send button wears the project color', pickedLook.background === alpha.fill, `${pickedLook.background} vs ${alpha.fill}`)
check('picked: it is no longer the app black', pickedLook.background !== 'rgb(0, 0, 0)', pickedLook.background)
// The ink is the white arrow, so the fill has to keep it readable. Compared as
// a ratio rather than against a color: this is the requirement, and it survives
// a palette tweak that a hard-coded expected rgb would not.
check('project color keeps the white arrow legible', contrastVsWhite(alpha.fill) >= 3, `${contrastVsWhite(alpha.fill).toFixed(2)}:1`)
await shot(null, 'zh-welcome-project-color.png')

// Hover is the other battlefield for AppLayout's !important rules: its
// .ant-btn-primary:hover would paint this circle #333. A real mouse, and the
// fill must stay in the project's family.
await sendButton().hover()
const hoveredLook = await settledLook(false)
check('hover keeps the project color, not the app #333', hoveredLook.background === alpha.hover, `${hoveredLook.background} vs ${alpha.hover} (app hover is rgb(51, 51, 51))`)
check('hover also keeps the arrow legible', contrastVsWhite(alpha.hover) >= 3, `${contrastVsWhite(alpha.hover).toFixed(2)}:1`)
await page.mouse.move(0, 0)

// The color follows the pick, rather than being one fixed "project color".
await composerText().press('Enter')
await page.waitForTimeout(120)
check('Enter sends once a project is picked', (await page.evaluate(() => window.__sentCount())) === 1, `${await page.evaluate(() => window.__sentCount())} send(s)`)
await composerText().fill('换个项目')
await page.locator('[role="button"]', { hasText: 'Beta' }).first().click()
const betaLook = await settledLook(false)
const betaHues = await page.evaluate(() => ({
  hue: window.__projectHue(window.__PROJECTS[1]),
  hashed: window.__projectHueName('Beta'),
  onRow: window.__PROJECTS[1].colorHue,
}))
const beta = await page.evaluate(() => window.__sendAccent(window.__projectHue(window.__PROJECTS[1])))
check('switching project recolors the button', betaLook.background === beta.fill && betaLook.background !== alpha.fill, `Alpha ${alpha.fill} → Beta ${beta.fill}`)
check('the two projects really do differ', alpha.fill !== beta.fill, `${alpha.fill} vs ${beta.fill}`)
// The other half of the same field: a row the backfill has not reached (or one
// read before it ran) has no stored hue, and must still be colored — by the
// name hash, which is what every project's color came from before it was stored.
check(
  'a project with no stored hue still colors from its name',
  betaHues.onRow === undefined && betaHues.hue === betaHues.hashed && betaLook.background !== 'rgb(0, 0, 0)',
  `row has ${betaHues.onRow}, fallback ${betaHues.hue}`
)

// A picked project with nothing typed: the button keeps the hue and only dims,
// so the color reads as "this task belongs to Beta" even before the message is
// written — the dim is the blocked-ness, not the identity.
await composerText().fill('')
const emptyLook = await settledLook(true)
check('empty box keeps the project color, dimmed', emptyLook.background === beta.fill && parseFloat(emptyLook.opacity) <= 0.5, JSON.stringify(emptyLook))

// And the palette rule itself, over the whole wheel: hashing a project name can
// land on any hue, so "legible for the ones we happened to stub" is not a
// property — this is. Swept against the production derivation, not a copy.
const weakHues = await page.evaluate(() => {
  const contrast = (css) => {
    const [r, g, b] = css.match(/\d+/g).slice(0, 3).map(Number)
    const lin = (c) => {
      const n = c / 255
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
    }
    return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05)
  }
  const bad = []
  for (let hue = 0; hue < 360; hue++) {
    const { fill, hover } = window.__sendAccent(hue)
    const c = Math.min(contrast(fill), contrast(hover))
    if (c < 3) bad.push({ hue, contrast: Number(c.toFixed(2)) })
  }
  return bad
})
check('all 360 hues keep the white ink above 3:1 (fill and hover)', weakHues.length === 0, weakHues.length ? JSON.stringify(weakHues.slice(0, 6)) : '360 hues swept')

// And back: switching the capsule to 对话 lifts the block and the color with
// it. Text has to be typed again first — the send cleared the box, and an empty
// box greys the button on its own, which would make this check say nothing
// about the project gate.
await capsule('对话').click()
await composerText().fill('换成普通对话')
const restoredLook = await settledLook(false)
check('back in chat mode the button is enabled', !restoredLook.disabled)
check('back in chat mode the dimming is gone', restoredLook.opacity === '1', JSON.stringify(restoredLook))
check('back in chat mode the button is black again', restoredLook.background === 'rgb(0, 0, 0)', restoredLook.background)

/* ── Past the first message: the color stays with the task ──────────────── */

// The report this covers: "开始对话后就变回黑色了". The welcome form is only
// where the color *arrives*; once the conversation exists the composer reads the
// conversation's own project, so the button keeps wearing it.
await page.evaluate(() => window.__mountConversation({ projectId: 'p1' }))
await page.waitForSelector('.ant-sender textarea')
await composerText().fill('继续这个任务')
const convLook = await settledLook(false)
check('a project conversation keeps the project color', convLook.background === alpha.fill, `${convLook.background} vs ${alpha.fill}`)
check('and it is not dimmed on the chat view', convLook.opacity === '1', JSON.stringify(convLook))
await shot(null, 'zh-conversation-project-color.png')

// It follows the conversation, not the last thing picked on the welcome form.
await page.evaluate(() => window.__mountConversation({ projectId: 'p2' }))
await page.waitForSelector('.ant-sender textarea')
await composerText().fill('继续这个任务')
const convBetaLook = await settledLook(false)
check('another project conversation wears its own color', convBetaLook.background === beta.fill, `${convBetaLook.background} vs ${beta.fill}`)

// And a conversation nobody bound to a project — a loose chat, or one in the
// synthesized 默认项目, which the list normalizes away — stays the app's black.
await page.evaluate(() => window.__mountConversation({}))
await page.waitForSelector('.ant-sender textarea')
await composerText().fill('普通对话')
const looseLook = await settledLook(false)
check('an unbound conversation stays black', looseLook.background === 'rgb(0, 0, 0)', looseLook.background)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
