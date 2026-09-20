/**
 * 存为日常任务 probe (real Chromium).
 *
 * The chat's last action row gains a routine entry: 存为日常任务 distills the
 * conversation into a routine draft and jumps to the routine editor, which is
 * the review surface. The gating (only the tail, only on a settled turn, only
 * in the main chat) is pure logic pinned by tests/chat-routine-entry.test.ts;
 * what no other check in this repo can see is the DOM half:
 *
 *   1. the button sits in the action row after the knowledge entry, a real
 *      click reaches the host callback, and exactly once — the latch keeps a
 *      double click (and a click during the in-flight await) inert
 *   2. during the await the button reads 正在提炼… and is visually inert;
 *      when the await settles it reads 存为日常任务 again
 *   3. a host without the callback (the sub-agent preview, the extension
 *      panel's mirror — every non-main-chat renderer) has no button at all
 *   4. an ask_user-only tail hides its whole action row, entry included — the
 *      MessageGroup rule that already hides copy/like keeps ruling here
 *
 * No Electron, no LLM calls, no extension: the harness stubs `window.electronAPI`
 * and the callback, so this cannot touch a real session or quota.
 *
 * Usage: node scripts/probe-chat-extract-routine.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-chat-routine-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SegmentBlock } from './src/renderer/src/components/chat/SegmentView'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'

installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(undefined) })

const NOW = '2026-09-21T10:00:00.000Z'
const user = (text) => ({ id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const assistant = (id, blocks) => ({ id, role: 'assistant', contentBlocks: blocks, createdAt: NOW })

const TAIL_MESSAGES = [user('每周五帮我把工作记录整理成周报'), assistant('a1', [{ type: 'text', text: '好的，这轮对话里的例行工作可以沉淀为一个日常任务。' }])]
/** Every block is an ask_user: MessageGroup hides the whole action row. */
const ASK_USER_MESSAGES = [user('在吗'), assistant('a2', [
  { type: 'tool_use', id: 'q1', name: 'ask_user', status: 'completed', exitCode: 0, input: { question: '选哪个？', options: ['A', 'B'] } },
])]

/** A callback whose completion the probe owns, so the latch is observable.
 *  The resolver rides window so the probe can release the await; the call
 *  counter lives outside the component — a render would otherwise zero it. */
window.__calls = 0
function makeGate() {
  let resolve
  const pending = new Promise((r) => { resolve = r })
  window.__releaseGate = resolve
  return { pending }
}

function Row({ withCallback }) {
  const [gate] = useState(makeGate)
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <SegmentBlock
            seg={{ type: 'single', msg: TAIL_MESSAGES[1] }}
            isLastSegment
            actions="full"
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            {...(withCallback ? {
              onExtractRoutine: () => { window.__calls += 1; return gate.pending }
            } : {})}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

/** The sub-agent preview's own renderer: full actions, never the routine entry. */
function SubAgentPreview() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div id="subagent-preview" style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={TAIL_MESSAGES}
            agentStatus={{ status: 'completed' }}
            streamingBlocks={[]}
            isRequesting={false}
            restoring={false}
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            onKillTool={() => {}}
            onRespondToTool={() => {}}
            onClearError={() => {}}
            onRetry={() => {}}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

function AskUserRow() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div id="askuser-case" style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <SegmentBlock
            seg={{ type: 'single', msg: ASK_USER_MESSAGES[1] }}
            isLastSegment
            actions="full"
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            onExtractRoutine={() => {}}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Row withCallback />)

window.__mountWithout = () => {
  const host = document.createElement('div')
  host.id = 'without-case'
  document.body.appendChild(host)
  createRoot(host).render(<Row withCallback={false} />)
}
window.__mountSubAgent = () => {
  const host = document.createElement('div')
  host.id = 'subagent-case'
  document.body.appendChild(host)
  createRoot(host).render(<SubAgentPreview />)
}
window.__mountAskUser = () => {
  const host = document.createElement('div')
  host.id = 'askuser-host'
  document.body.appendChild(host)
  createRoot(host).render(<AskUserRow />)
}

window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

const BTN = '[data-testid="routine-extract"]'
const titleOf = (root = '') => page.locator(`${root}${BTN}`).first().getAttribute('title')

/* ── 1. The entry sits in the action row and a real click reaches the host ── */
console.log('== the entry rides the last action row ==')
{
  const btn = page.locator(BTN)
  await btn.waitFor()
  check('the button renders in the row with the 存为日常任务 label', (await titleOf()) === '存为日常任务', await titleOf())
  // Position: after the knowledge entry, same row — a sibling button the user
  // can reach, not a floating panel. Measured, because "in the row" is geometry.
  const rowGeo = await page.locator(BTN).evaluate((el) => {
    const box = el.getBoundingClientRect()
    const kb = el.parentElement.querySelector('[data-testid="knowledge-save"]')?.getBoundingClientRect()
    return { sameRow: kb ? Math.abs(kb.top - box.top) < 2 : false, after: kb ? box.left > kb.left : false }
  })
  check('it sits beside the knowledge entry, to its right', rowGeo.sameRow && rowGeo.after, JSON.stringify(rowGeo))

  await btn.click()
  await page.waitForTimeout(120)
  check('a real click reaches the host callback', (await page.evaluate(() => window.__calls)) === 1, String(await page.evaluate(() => window.__calls)))
}

/* ── 2. The latch: one click, one extraction; the label flips and returns ── */
console.log('== the latch ==')
{
  const btn = page.locator(BTN)
  check('while the await is in flight the label reads 正在提炼…', (await titleOf()) === '正在提炼…', await titleOf())
  const cursor = await btn.evaluate((el) => getComputedStyle(el).cursor)
  check('and the cursor says wait, not pointer', cursor === 'wait', cursor)
  await btn.click()
  await page.waitForTimeout(60)
  const callsDuring = await page.evaluate(() => window.__calls)
  check('a second click during the await is swallowed by the latch', callsDuring === 1, String(callsDuring))
  await page.evaluate(() => window.__releaseGate())
  await page.waitForTimeout(150)
  check('when the await settles the label returns to 存为日常任务', (await titleOf()) === '存为日常任务', await titleOf())
  const callsAfter = await page.evaluate(() => window.__calls)
  check('the whole affair produced exactly one extraction', callsAfter === 1, String(callsAfter))
  // And it works again afterwards — the latch is a gate, not a one-way lock.
  await btn.click()
  await page.waitForTimeout(120)
  check('a later click extracts again (the entry is reusable)', (await page.evaluate(() => window.__calls)) === 2, String(await page.evaluate(() => window.__calls)))
  await page.evaluate(() => window.__releaseGate())
  await page.waitForTimeout(120)
}

/* ── 3. Hosts without the callback render no button ── */
console.log('== other hosts never see the entry ==')
{
  await page.evaluate(() => window.__mountWithout())
  await page.evaluate(() => window.__mountSubAgent())
  await page.waitForTimeout(250)
  const without = await page.locator('#without-case [data-testid="routine-extract"]').count()
  check('a row without the callback has no button (hosts pass it only for the tail)', without === 0, `${without} button(s)`)
  // The sub-agent preview renders the SAME transcript with full actions —
  // copy/like must exist there, the routine entry must not.
  const previewActions = await page.locator('#subagent-case [data-testid="knowledge-save"]').count()
  const previewRoutine = await page.locator('#subagent-case [data-testid="routine-extract"]').count()
  check('the sub-agent preview keeps its action row but gains no entry', previewActions === 1 && previewRoutine === 0, `knowledge:${previewActions} routine:${previewRoutine}`)
}

/* ── 4. An ask_user tail hides its whole row, entry included ── */
console.log('== the ask_user rule still rules ==')
{
  await page.evaluate(() => window.__mountAskUser())
  await page.waitForTimeout(250)
  const askRoutine = await page.locator('#askuser-case [data-testid="routine-extract"]').count()
  const askCopy = await page.locator('#askuser-case button').count()
  check('an ask_user-only tail renders no action row and no entry', askRoutine === 0 && askCopy === 0, `buttons:${askCopy} routine:${askRoutine}`)
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
