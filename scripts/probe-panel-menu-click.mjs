/**
 * Real-browser probe: the panel's three dropdowns under the REAL mount shape
 * (2026-11-03). `probe-panel-state.mjs` mounts the App in an **open** shadow
 * root because its `page.locator` calls need to pierce it; production
 * (`content/index.tsx`) uses `attachShadow({ mode: 'closed' })`. That gap hid a
 * dead-click defect: `useDropdown`'s outside-click test read
 * `e.composedPath()` from a `document` listener, and a closed shadow root
 * truncates that path at the host — `path.includes(anchor)` was false for the
 * menu's OWN items, so mousedown closed the menu and the click never landed.
 * Every dropdown item was dead to the mouse (历史会话 rows, 授权, 模型).
 *
 * This probe drives the real App inside a closed shadow root and clicks with
 * real mouse coordinates (page.mouse — Playwright locators cannot pierce a
 * closed root). The harness keeps the shadow reference, so only the probe's
 * geometry helper can see inside.
 *
 * Usage: node scripts/probe-panel-menu-click.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-menu-probe-')), 'harness.js')

const MODEL = {
  profiles: [
    { id: 'p1', name: 'GPT-4o', provider: 'openai', providerName: 'OpenAI', model: 'gpt-4o' },
    { id: 'p2', name: 'Claude', provider: 'anthropic', providerName: 'Anthropic', model: 'claude-3-5-sonnet' },
  ],
  activeId: 'p1',
}

const HARNESS = `
import { createRoot } from 'react-dom/client'
import panelStyles from './src/extension/ui/styles.css'
import xMarkdownTheme from '@ant-design/x-markdown/themes/light.css'
import { App } from './src/extension/ui/App'
import { listen } from './src/extension/content/bridge'

listen()

const host = document.createElement('div')
host.setAttribute('data-pulsemind-panel', '')
host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;'
// The production mode. Everything below must work without the page being able
// to inspect the panel — that is the point of the closed root.
const shadow = host.attachShadow({ mode: 'closed' })
const themeEl = document.createElement('style')
themeEl.textContent = xMarkdownTheme
shadow.appendChild(themeEl)
const styleEl = document.createElement('style')
styleEl.textContent = panelStyles
shadow.appendChild(styleEl)
const rootEl = document.createElement('div')
rootEl.className = 'pm-root'
shadow.appendChild(rootEl)
document.body.appendChild(host)
createRoot(rootEl).render(<App />)
// Only the harness can hold the closed root; the probe asks it for geometry and
// for DOM facts by selector, then drives the mouse at real coordinates.
window.__root = shadow
window.__rect = (sel) => {
  const el = shadow.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
}
window.__has = (sel) => !!shadow.querySelector(sel)
window.__text = (sel) => shadow.querySelector(sel)?.textContent ?? null
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'panel-menu-harness.tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  outfile: OUT,
  tsconfig: 'tsconfig.extension.json',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  logLevel: 'warning',
})

const NOW = new Date().toISOString()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 980 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))
await page.setContent('<!doctype html><html><body style="margin:0"><div id="outside" style="position:fixed;left:0;top:0;width:80px;height:40px;background:#fff">page</div></body></html>')

const SNAPSHOT = {
  sessionId: 'ws_1',
  connection: { state: 'open', connected: true },
  panelOpen: true,
  messages: [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '第一句' }], createdAt: NOW }],
  streamingBlocks: [],
  status: 'idle',
  sessions: [
    { sessionId: 'ws_1', title: '当前会话', updatedAt: NOW },
    { sessionId: 'ws_2', title: '另一个会话', updatedAt: NOW },
  ],
  approvalMode: 'auto',
  model: MODEL,
}

await page.addScriptTag({
  content: `
window.__sent = []
window.__listeners = []
const SNAPSHOT = ${JSON.stringify(SNAPSHOT)}
if (typeof chrome === 'undefined' || !chrome) { window.chrome = {} }
chrome.runtime = {
  sendMessage: async (msg) => {
    window.__sent.push(msg)
    if (msg.type === 'panel/attach') return { ok: true, snapshot: SNAPSHOT }
    if (msg.type === 'panel/resume-session') {
      return { ok: true, snapshot: { ...SNAPSHOT, sessionId: msg.sessionId,
        messages: [{ id: 'm2', role: 'user', contentBlocks: [{ type: 'text', text: '切过去的那段' }], createdAt: SNAPSHOT.messages[0].createdAt }] } }
    }
    return { ok: true }
  },
  onMessage: { addListener: (fn) => window.__listeners.push(fn) },
  openOptionsPage: () => {},
}
window.__stored = {}
chrome.storage = {
  local: {
    get: async (key) => (key in window.__stored ? { [key]: window.__stored[key] } : {}),
    set: async (entries) => { Object.assign(window.__stored, entries) },
  },
}
`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)
await page.waitForTimeout(400)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
/** Real mouse click on a (closed-)shadow-DOM element, by geometry. */
const clickIn = async (sel) => {
  const box = await page.evaluate((s) => window.__rect(s), sel)
  if (!box) throw new Error(`no element for ${sel}`)
  await page.mouse.click(Math.round(box.x), Math.round(box.y))
  await page.waitForTimeout(120)
}
const sent = (type) => page.evaluate((t) => window.__sent.filter((m) => m.type === t), type)

// ── 历史会话 ──────────────────────────────────────────────────────────────
await clickIn('[title="历史会话"]')
check('the sessions menu opens from a real click inside the closed shadow root', await page.evaluate(() => window.__has('[data-sessions-menu]')))

await clickIn('.pm-sessions-row:nth-child(2) .pm-sessions-open')
const resumed = (await sent('panel/resume-session')).map((m) => m.sessionId)
check('clicking a row sends panel/resume-session with that row\'s id', resumed.join(',') === 'ws_2', resumed.join(','))
const seeded = await page.evaluate(() => window.__text('.pm-transcript'))
check('the resumed transcript is rendered', /切过去的那段/.test(seeded ?? ''), (seeded ?? '').slice(0, 40))

// ── 授权 ────────────────────────────────────────────────────────────────
await clickIn('[title$="工具调用审批"]')
check('the approval menu opens', await page.evaluate(() => window.__has('.pm-approval-menu')))
await clickIn('.pm-approval-item:not(.pm-approval-item-active)')
const approvals = (await sent('panel/set-approval')).map((m) => m.mode)
check('clicking an approval item sends panel/set-approval', approvals.length === 1, approvals.join(','))

// ── 模型 ────────────────────────────────────────────────────────────────
await clickIn('.pm-model')
check('the model menu opens', await page.evaluate(() => window.__has('.pm-model-menu')))
await clickIn('.pm-model-item:not(.pm-model-item-active)')
const models = (await sent('panel/set-model')).map((m) => m.profileId)
check('clicking a model item sends panel/set-model', models.join(',') === 'p2', models.join(','))

// ── outside click still closes ───────────────────────────────────────────
await clickIn('[title="历史会话"]')
const openedAgain = await page.evaluate(() => window.__has('[data-sessions-menu]'))
await page.mouse.click(40, 20) // #outside, the page behind the panel
await page.waitForTimeout(120)
const closedByOutside = !(await page.evaluate(() => window.__has('[data-sessions-menu]')))
check('a click on the page outside the panel still closes the menu', openedAgain && closedByOutside)

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exitCode = 1
