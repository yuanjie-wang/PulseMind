/**
 * Sidebar status-light WIRING probe (real Chromium, real useConversationEngine).
 *
 * The rendering of the four lights is pinned by probe-sidebar-status-light.mjs
 * (real AppLayout, static light map); THIS probe pins the wiring that decides
 * the map — the exact seam where the 2026-09-30 green-dot bug lived: 已读 was
 * remembered as "opened once ever", so a conversation the user had sent a
 * message in and then left stayed read forever and its background completion
 * never lit the green dot. The rule since: 已读 is judged AT EVENT TIME —
 * watching the conversation when the status lands.
 *
 * The harness mounts the real useConversationEngine behind a broadcast
 * onAgentSessionEvent stub (the probe-stream-perf recipe) and pumps wire
 * status events from Node:
 *
 *   §1 watched streaming → blue (running) on the active conversation.
 *   §2 switch away → its completed lands as UNREAD (the bug: this stayed dark).
 *   §3 opening the conversation clears the unread light (read receipt).
 *   §4 completing while watched stays dark.
 *   §5 error/retrying land as error and SURVIVE opening (status-tied).
 *   §6 awaiting_approval lands as waiting.
 *
 * Usage: node scripts/probe-conversation-lights.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-conv-lights-')), 'harness.js')

const HARNESS = `
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { useConversationEngine } from './src/renderer/src/hooks/useConversationEngine'

installThemeVars()
applyThemeAttr('light')

// Broadcast stub (the stream-perf recipe): the hook path needs real-ish
// answers, everything else falls through to a generic table.
const SPECIFIC = {
  onAgentSessionEvent: (cb) => {
    window.__cbs.push(cb)
    return () => { const i = window.__cbs.indexOf(cb); if (i >= 0) window.__cbs.splice(i, 1) }
  },
  agentSessionCreate: () => Promise.resolve({ workspaceDir: '/tmp/pm-lights-ws' }),
  agentSessionEngineCall: () => Promise.resolve(null),
  agentSessionHydrate: () => Promise.resolve(true),
  agentSessionSnapshot: () => Promise.resolve(null),
  hydrateConversation: () => Promise.resolve(null),
  saveConversation: () => Promise.resolve(true),
  appendConversationMessages: () => Promise.resolve(true),
  saveConversationSync: () => true,
}
const TABLE = {
  expertList: [], projectList: [], listConversations: [], routineList: [], routineRuns: [],
  knowledgeListFiles: [], projectValidateDir: { ok: true }, showOpenDialog: { canceled: true, filePaths: [] },
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
window.electronAPI = new Proxy(SPECIFIC, {
  get: (t, key) => {
    if (key in t) return t[key]
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    return () => Promise.resolve(TABLE[key])
  },
})

function Bench() {
  const eng = useConversationEngine({
    apiKey: 'k', baseURL: 'http://bench.local', model: 'bench-model', maxTokens: 4096,
    myName: '我', soul: '灵魂', yourName: '你', locale: 'zh', skillsDir: '', platformInfo: undefined,
    adapter: {}, toolManager: {}, skillManager: {}, memoryManager: {}, knowledgeManager: {},
  })
  useEffect(() => {
    window.__eng = eng
    window.__ready = true
  })
  return null
}

// ── 诊断出口：emit 计数 + 报错截留 + 多订阅方扇出 ──
window.__cbs = []
window.__emitCount = 0
window.__emitErr = null
Object.defineProperty(window, '__emit', {
  get() {
    return (evt) => {
      window.__emitCount++
      for (const cb of window.__cbs) {
        try { cb(evt) } catch (e) { window.__emitErr = String((e && e.stack) || e) }
      }
    }
  },
})

const root = createRoot(document.getElementById('root'))
root.render(
  <ConfigProvider><AntdApp><SettingsProvider><TranslationProvider>
    <Bench />
  </TranslationProvider></SettingsProvider></AntdApp></ConfigProvider>
)
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)

const lights = () => page.evaluate(() => window.__eng.convLights)
const activate = (id) => page.evaluate((convId) => { window.__eng.activateEngine(convId) }, id)
const emit = (sessionId, status, extra = {}) =>
  page.evaluate(({ sessionId, status, extra }) => window.__emit({ sessionId, data: { type: 'status', status, ...extra } }),
    { sessionId, status, extra })
// Wait until the hook's setState has flushed into the render the ref mirrors.
const waitLights = (expected, ms = 2000) =>
  page.waitForFunction((exp) => JSON.stringify(window.__eng.convLights) === JSON.stringify(exp), expected, { timeout: ms })
  .then(() => true).catch(() => false)
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

// Seed both sessions (ensureSession is what lets the subscription accept a
// session's events) and start on conv_a, like a user sending a message.
await page.evaluate(() => {
  window.__eng.getOrCreateEngine('conv_a')
  window.__eng.getOrCreateEngine('conv_b')
  window.__eng.activateEngine('conv_a')
})
await settle(100)

/* ── §1 watched streaming → blue while active ────────────────────────────── */

await emit('conv_a', 'streaming')
check('§1 streaming on the ACTIVE conversation lights running',
  await waitLights({ conv_a: 'running' }), JSON.stringify(await lights()))

/* ── §2 the bug: switch away, completion lands as UNREAD ─────────────────── */

await activate('conv_b')
await settle(50)
await emit('conv_a', 'completed')
check('§2 completed AFTER switching away lights unread (the green-dot bug)',
  await waitLights({ conv_a: 'unread' }), JSON.stringify(await lights()))

/* ── §3 opening the conversation is the read receipt ─────────────────────── */

await activate('conv_a')
await settle(50)
check('§3 activating the conversation clears the unread light',
  await waitLights({}), JSON.stringify(await lights()))

/* ── §4 completing while watched stays dark ──────────────────────────────── */

await emit('conv_a', 'streaming')
await waitLights({ conv_a: 'running' })
await emit('conv_a', 'completed')
await settle(250)
check('§4 a turn that completes while watched never lights unread',
  await waitLights({}), JSON.stringify(await lights()))

/* ── §5 error lands and SURVIVES opening (status-tied, not read-tied) ────── */

await activate('conv_b')
await settle(50)
await emit('conv_a', 'retrying', { attempt: 1, maxRetries: 3, message: 'upstream 502' })
check('§5a retrying (api exception) lights error',
  await waitLights({ conv_a: 'error' }), JSON.stringify(await lights()))
await emit('conv_a', 'error', { error: 'bad response' })
await waitLights({ conv_a: 'error' })
await activate('conv_a')
await settle(50)
check('§5b opening an errored conversation does NOT clear the red light',
  await waitLights({ conv_a: 'error' }), JSON.stringify(await lights()))

/* ── §6 waiting parks light orange, even on the active conversation ──────── */

await emit('conv_a', 'awaiting_approval', { tools: [] })
check('§6 awaiting_approval on the active conversation lights waiting (it needs the nudge)',
  await waitLights({ conv_a: 'waiting' }), JSON.stringify(await lights()))

check('every pumped event reached the subscribers without an error',
  await page.evaluate(() => window.__emitErr === null && window.__emitCount >= 7),
  `emits=${await page.evaluate(() => window.__emitCount)}`)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
