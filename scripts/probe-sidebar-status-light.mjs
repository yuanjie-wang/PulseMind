/**
 * Sidebar conversation status-light probe (real Chromium).
 *
 * The task-status light in the sidebar's history rows (ConversationRows, fed
 * by ConversationSidebar/ProjectSidebarList via AppLayout) is a FOUR-state
 * indicator derived from the conversation's mirrored agentStatus
 * (useConversationEngine's statusToLight, user ruling 2026-09-30):
 *
 *   running  自动执行中 (streaming/executing/awaiting_extension)
 *            → the link-blue 6px dot (`--pm-link`) with a SLOW opacity blink
 *              (`conv-dot-blink 2s ease-in-out` — the only animated state;
 *              the ring it replaces read badly, user ruling same day).
 *   waiting  等待用户反馈 (awaiting_approval / awaiting_user_input /
 *            awaiting_continue, the 暂停 park) → STATIC ORANGE dot (`--pm-warn`,
 *            the held-approval family).
 *   error    异常 (retrying backoff, the turn's error end) → STATIC RED dot
 *            (`--pm-error-status`).
 *   unread   任务完成未读 → STATIC GREEN dot (`--pm-success-status`).
 *
 * What only a real DOM can see:
 *
 *   - the GEOMETRY. All four states share the 6px dot inside the 10px gutter —
 *     a size drift between states would make the column shiver.
 *   - the ANIMATION. The running dot's animationName is `conv-dot-blink` at
 *     2s ease-in-out infinite and its computed opacity actually CHANGES
 *     between two samples — a keyframes name that resolves to nothing is
 *     indistinguishable from source, and the light would sit frozen. The
 *     other three dots must be static (animationName none).
 *   - the COLORS. Each dot reads its palette token's computed value, so a
 *     token rename that leaves the row cannot slip through.
 *
 * The mounted surface is the production AppLayout/ConversationSidebar/
 * ConversationRows behind a stubbed electronAPI — no Electron, no LLM.
 *
 * Usage: node scripts/probe-sidebar-status-light.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-sidebar-light-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-sidebar-light-shots')

const iso = (ms) => new Date(ms).toISOString()
const CONVERSATIONS = [
  { key: 'run_a', label: '运行中的会话', updatedAt: iso(Date.now() - 60_000) },
  { key: 'wait_a', label: '等反馈的会话', updatedAt: iso(Date.now() - 120_000) },
  { key: 'err_a', label: '异常的会话', updatedAt: iso(Date.now() - 180_000) },
  { key: 'unread_a', label: '完成未读的会话', updatedAt: iso(Date.now() - 240_000) },
  { key: 'idle_a', label: '空闲的会话', updatedAt: iso(Date.now() - 300_000) },
]
const LIGHTS = { run_a: 'running', wait_a: 'waiting', err_a: 'error', unread_a: 'unread' }

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { installThemeVars } from './src/renderer/src/theme/dom'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'

installThemeVars()

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <SettingsProvider>
        <TranslationProvider initialLocale={window.__probeLocale}>
          {node}
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

window.__selected = []
window.__mountSidebar = ({ locale = 'zh', conversations = [], convLights = {} } = {}) => {
  window.__probeLocale = locale
  window.__selected = []
  mount(
    <AppLayout
      conversations={conversations}
      activeConversationKey=""
      totalSessions={conversations.length}
      autoCleanup={true}
      convLights={convLights}
      onCreateNew={() => {}}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={(key) => { window.__selected.push(key) }}
      onTogglePinConversation={() => {}}
    />
  )
  return true
}

// The status light is the first child of the row's reserved gutter span.
// Reads the computed style that IS the rendered fact.
window.__readLight = (key) => {
  const row = document.querySelector('[data-conv-row="' + key + '"]')
  if (!row) return null
  const gutter = row.firstElementChild
  const light = gutter && gutter.firstElementChild
  if (!light) return { light: false, gutterWidth: getComputedStyle(gutter).width }
  const cs = getComputedStyle(light)
  return {
    light: true,
    width: cs.width, height: cs.height,
    borderRadius: cs.borderRadius,
    background: cs.backgroundColor,
    animationName: cs.animationName,
    animationDuration: cs.animationDuration,
    animationTimingFunction: cs.animationTimingFunction,
    animationIterationCount: cs.animationIterationCount,
    opacity: cs.opacity,
  }
}

// Two opacity samples 400ms apart — a live blink cannot return the same value
// twice inside one 2s ease-in-out breath (a fifth of the cycle in between,
// mid-fall, where the curve is steepest).
window.__sampleBlink = async (key) => {
  const read = () => {
    const row = document.querySelector('[data-conv-row="' + key + '"]')
    return getComputedStyle(row.firstElementChild.firstElementChild).opacity
  }
  const a = read()
  await new Promise((r) => setTimeout(r, 400))
  return [a, read()]
}

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

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
      : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'projectList' ? () => Promise.resolve([])
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: window.__probeLocale || 'zh',
        })
      : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

await page.evaluate(({ convs, lights }) => window.__mountSidebar({ conversations: convs, convLights: lights }),
  { convs: CONVERSATIONS, lights: LIGHTS })
await page.waitForSelector('[data-conv-row="run_a"]')

/* ── The running light is the slow-blinking blue dot ─────────────────────── */

const run = await page.evaluate(() => window.__readLight('run_a'))
check('running row lights a status light', !!run && run.light, JSON.stringify(run))
check('running dot is a 6px circle, same size as the static dots',
  run.width === '6px' && run.height === '6px' && run.borderRadius === '50%',
  `${run.width}/${run.height}/${run.borderRadius}`)
check('running dot is link blue (light theme value)', run.background === 'rgb(22, 119, 255)', run.background)
check('animation is conv-dot-blink 2s ease-in-out infinite',
  run.animationName === 'conv-dot-blink' && run.animationDuration === '2s' &&
  run.animationTimingFunction === 'ease-in-out' && run.animationIterationCount === 'infinite',
  `${run.animationName} ${run.animationDuration} ${run.animationTimingFunction} ${run.animationIterationCount}`)
check('the dot actually blinks (opacity changes between samples)',
  await page.evaluate(() => window.__sampleBlink('run_a')).then(([a, b]) => a !== b),
  'two samples 400ms apart')

/* ── The other three states are static solid dots ────────────────────────── */

const waiting = await page.evaluate(() => window.__readLight('wait_a'))
check('waiting dot is a static 6px orange circle (--pm-warn, the approval family)',
  waiting.width === '6px' && waiting.height === '6px' && waiting.borderRadius === '50%' &&
  waiting.background === 'rgb(212, 107, 8)' && waiting.animationName === 'none',
  `${waiting.width} ${waiting.background} anim=${waiting.animationName}`)

const error = await page.evaluate(() => window.__readLight('err_a'))
check('error dot is a static 6px red circle (--pm-error-status)',
  error.width === '6px' && error.height === '6px' && error.borderRadius === '50%' &&
  error.background === 'rgb(255, 77, 79)' && error.animationName === 'none',
  `${error.width} ${error.background} anim=${error.animationName}`)

const unread = await page.evaluate(() => window.__readLight('unread_a'))
check('unread dot is a static 6px green circle (--pm-success-status)',
  unread.width === '6px' && unread.height === '6px' && unread.borderRadius === '50%' &&
  unread.background === 'rgb(82, 196, 26)' && unread.animationName === 'none',
  `${unread.width} ${unread.background} anim=${unread.animationName}`)

/* ── Idle rows stay dark ─────────────────────────────────────────────────── */

const idle = await page.evaluate(() => window.__readLight('idle_a'))
check('idle row paints no light', !!idle && !idle.light, JSON.stringify(idle))

// The welcome card's badge still borrows the pulse keyframes — which used to
// live in ConversationRows' style block and moved into WelcomeSuggestions
// (2026-09-30); its home must be the component that animates with them.
const welcomeSource = readFileSync(join(process.cwd(), 'src/renderer/src/components/welcome/WelcomeSuggestions.tsx'), 'utf-8')
check('WelcomeSuggestions defines the ant-status-processing keyframes it uses',
  welcomeSource.includes('@keyframes ant-status-processing'))

const rowsShot = page.locator('.ant-layout-sider')
await rowsShot.screenshot({ path: join(SHOTS, 'sidebar-lights.png') }).catch(() => page.screenshot({ path: join(SHOTS, 'sidebar-lights.png') }))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
