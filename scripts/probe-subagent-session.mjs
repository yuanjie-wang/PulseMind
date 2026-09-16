/**
 * Sub-agent session view probe (real Chromium) — PLAN-workbench W12.
 *
 * The ruling for this screen was 严格一致 with the main chat, with exactly two
 * differences: no composer, and a 返回主对话 button at the top-left. It renders
 * the production `chat/TranscriptView`, and there is nothing on this side of the
 * wire but the sub-conversation id — engines are hosted in the main process — so
 * "follow the run" means polling the stored transcript while the node is open.
 *
 * Those are all browser facts: no composer is a DOM fact, the back button landing
 * is a click fact, and the poll is a timing fact (jsdom sees none of it, and the
 * component's only signals are a caption and a timer). This mounts the real
 * component against a stubbed `window.electronAPI`, so it needs no Electron, no
 * LLM call and no sub-agent run.
 *
 * Usage: node scripts/probe-subagent-session.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(tmpdir(), 'pm-subagent-session-shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-subagent-session-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SubAgentSessionView } from './src/renderer/src/components/subagent/SubAgentSessionView'

// The transcript touches electronAPI on render (file chips, copy) — everything
// resolves to undefined. hydrateConversation is the one this probe drives.
const calls = []
window.__calls = calls
window.__failNext = 0
window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (key === 'hydrateConversation') {
      calls.push(String(args[0]))
      if (window.__failNext > 0) { window.__failNext--; return Promise.reject(new Error('读取失败')) }
      return Promise.resolve(window.__conv)
    }
    return Promise.resolve(undefined)
  },
})

const NOW = '2026-09-16T10:00:00.000Z'
// A sub-agent turn as it lands in the DB: the kick-off message, then the answer.
window.__conv = {
  id: 'sub_1', title: '写作专家', createdAt: NOW, updatedAt: NOW,
  messages: [
    { id: 'm1', role: 'user', content: 'Please execute the task described in the system prompt.',
      contentBlocks: [{ type: 'text', text: 'Please execute the task described in the system prompt.' }], createdAt: NOW },
    { id: 'm2', role: 'assistant', content: '子代理的回答',
      contentBlocks: [{ type: 'text', text: '子代理的回答：周末从补觉开始。' }], createdAt: NOW },
  ],
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [live, setLive] = useState(true)
  return (
    <div style={{ width: 900, height: 520, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button id="toggle-live" onClick={() => setLive(v => !v)}>toggle-live:{String(live)}</button>
        <button id="reopen" onClick={() => setOpen(true)}>reopen</button>
      </div>
      <div id="view" style={{ flex: 1, border: '1px solid #ccc', minHeight: 0 }}>
        {open
          ? <SubAgentSessionView
              subConvId="sub_1"
              title="n1 · 撰写 5 个程序员周末场景"
              live={live}
              onBack={() => { window.__backed = (window.__backed || 0) + 1; setOpen(false) }}
            />
          : <div id="main-chat-stub">主对话</div>}
      </div>
    </div>
  )
}

createRoot(document.getElementById('app')).render(
  <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
    <TranslationProvider><Harness /></TranslationProvider>
  </ConfigProvider>
)
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), sourcefile: 'probe-subagent-session.tsx', loader: 'tsx' },
  bundle: true,
  outfile: OUT,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
})

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForSelector('#view', { timeout: 15000 })
await page.waitForTimeout(400)

// ── The screen itself ──
const text = await page.locator('#view').innerText()
check('[view] renders the sub-agent transcript (its own messages, not the main one)',
  text.includes('子代理的回答') && text.includes('system prompt'), text.split('\n').slice(0, 3).join(' / '))
check('[view] header names the node and offers 返回主对话',
  text.includes('n1 · 撰写 5 个程序员周末场景') && text.includes('返回主对话'), '')
check('[view] the run-state tag follows the live flag, and reads 子代理运行中 while open',
  text.includes('子代理运行中'), '')

// Exactly the two ruled differences: no composer of any kind.
const composerBits = await page.evaluate(() => ({
  textarea: document.querySelectorAll('#view textarea').length,
  textInputs: document.querySelectorAll('#view input[type="text"], #view [contenteditable="true"]').length,
}))
check('[view] no composer — the one deliberate difference from the chat',
  composerBits.textarea === 0 && composerBits.textInputs === 0, JSON.stringify(composerBits))

// ── 返回主对话 (the other deliberate difference) ──
await page.locator('#view', { hasText: '返回主对话' }).locator('text=返回主对话').first().click()
await page.waitForTimeout(150)
const backed = await page.evaluate(() => window.__backed || 0)
const backToMain = await page.locator('#main-chat-stub').count()
check('[view] a real click on 返回主对话 leaves the session for the main conversation',
  backed === 1 && backToMain === 1, `onBack×${backed}, main chat stub=${backToMain}`)

// ── Follow-the-run polling ──
await page.locator('#reopen').click()
await page.waitForTimeout(200)
const liveCalls = await page.evaluate(() => window.__calls.length)
await page.waitForTimeout(2400) // one 2000ms poll must land
const liveCalls2 = await page.evaluate(() => window.__calls.length)
const calledIds = await page.evaluate(() => [...new Set(window.__calls)])
check('[view] an open node keeps polling the stored transcript',
  liveCalls2 > liveCalls && calledIds.length === 1 && calledIds[0] === 'sub_1',
  `${liveCalls} → ${liveCalls2} reads of ${calledIds.join(',')}`)

// Growing transcript: the next poll must show up without any interaction.
await page.evaluate(() => {
  window.__conv = {
    ...window.__conv,
    messages: [...window.__conv.messages, {
      id: 'm3', role: 'assistant',
      contentBlocks: [{ type: 'text', text: '第二轮：新增了一段文案。' }],
      createdAt: '2026-09-16T10:01:00.000Z',
    }],
  }
})
await page.waitForTimeout(2400)
const grew = await page.locator('#view').innerText()
check('[view] new turns appear on their own while the run is open',
  grew.includes('第二轮：新增了一段文案'), '')

// Settled: the tag flips and the polling stops.
await page.locator('#toggle-live').click()
await page.waitForTimeout(300)
const settledText = await page.locator('#view').innerText()
const settledCalls = await page.evaluate(() => window.__calls.length)
await page.waitForTimeout(2400)
const settledCalls2 = await page.evaluate(() => window.__calls.length)
check('[view] a settled session reads 已结束 and stops polling',
  settledText.includes('已结束') && settledCalls2 === settledCalls,
  `${settledCalls} → ${settledCalls2} reads after settling`)

// A read failure surfaces instead of blank-screening (and is retried while open).
await page.locator('#toggle-live').click() // live again
await page.waitForTimeout(200)
await page.evaluate(() => { window.__failNext = 1 })
await page.waitForTimeout(2400)
const recovered = await page.locator('#view').innerText()
check('[view] a failed read recovers on the next poll instead of sticking',
  recovered.includes('第二轮：新增了一段文案') && !recovered.includes('读取失败'),
  recovered.includes('读取失败') ? 'error text stuck' : 'recovered')

check('[view] renders without a page error', pageErrors.length === 0, pageErrors.join(' | '))

await page.screenshot({ path: join(SHOTS, 'subagent-session.png') })
console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks passed — screenshot: ${SHOTS}`)
await browser.close()
if (results.some(r => !r.pass)) process.exit(1)
