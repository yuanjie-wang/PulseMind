/**
 * Chat error-display probe (real Chromium).
 *
 * The report was a conversation that died showing 「Unknown error」 — the reason
 * main had sent was simply not in the mirror, because the shared fold
 * (`shared/agent-session/mirror`, `case 'status'`) kept only the status word and
 * dereferenced `error` away. Every client renders
 * `'error' in agentStatus ? agentStatus.error : <its own copy>`, so the loss turns
 * ANY engine failure into the same mystery string on all three surfaces (chat,
 * tool studio, extension panel) — and no test could see it: the reducer's own
 * tests never sent a payload with a reason, and the views render a status object
 * that already looked well-formed.
 *
 * So this mounts the production TranscriptView on a real session mirror and folds
 * the two payloads the app actually produces:
 *
 *   1. the LIVE event — `{ type: 'status', status: 'error', error: … }` folded by
 *      the real `applySessionEvent` (the shape main's `onStatusChanged` emits);
 *   2. the RE-ATTACH seed — `seedSessionState` over the snapshot main's
 *      `agentSessionSnapshot` returns (renderer reload, conversation re-open): the
 *      failing event was delivered while the client was away, so the snapshot is
 *      its only carrier;
 *   3. the NEGATIVE CONTROL — a status that carries no reason must still read the
 *      fallback, which is what makes 1 and 2 mean anything (and is why the fold
 *      leaves the key ABSENT instead of writing an empty string: a present '' would
 *      draw a blank banner where the fallback belongs).
 *
 * No Electron, no LLM calls: `window.electronAPI` is stubbed and the page is
 * plain, so this cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-chat-error-display.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-err-display-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'
import { applySessionEvent, freshSessionState, seedSessionState } from './src/shared/agent-session/mirror'

installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(undefined) })

const NOW = '2026-09-16T10:00:00.000Z'
const state = freshSessionState()
state.messages = [{
  id: 'u1', role: 'user', createdAt: NOW,
  contentBlocks: [{ type: 'text', text: '帮我部署一版' }],
}]

// Stable handler identities, like App's useCallback values: a fresh arrow per render
// would hand the memoized views new props and show a bug that is not there.
const handlers = { approve: () => {}, reject: () => {}, kill: () => {}, respond: () => {}, clearError: () => {}, retry: () => {} }

function Harness() {
  const [, force] = useState(0)
  const rerender = () => force((n) => n + 1)

  // The two carriers, exactly as the clients fold them.
  window.__status = (payload) => { applySessionEvent(state, { type: 'status', ...payload }); rerender() }
  window.__seed = (status) => {
    seedSessionState(state, { messages: state.messages, status, streamingBlocks: [], plan: null })
    rerender()
  }
  window.__messages = (msgs) => { state.messages = msgs; rerender() }

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={state.messages}
            agentStatus={state.agentStatus}
            streamingBlocks={[]}
            isRequesting={false}
            restoring={false}
            onApproveTool={handlers.approve}
            onRejectTool={handlers.reject}
            onKillTool={handlers.kill}
            onRespondToTool={handlers.respond}
            onClearError={handlers.clearError}
            onRetry={handlers.retry}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
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
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(300)

/** The whole transcript's text — the banner is the only error surface here, and
 *  reading it whole is what lets the negative control assert the ABSENCE of the
 *  fallback as well as the presence of the reason. */
const text = () => page.locator('#root').innerText()
const boxOf = (needle) => page.getByText(needle, { exact: true }).first().boundingBox().catch(() => null)

// ── 1. The live event carries the reason into the banner ──
{
  console.log('== 实时事件 ==')
  const REASON = 'API 请求失败 (429)：请求过于频繁，请稍后重试'
  await page.evaluate((reason) => window.__status({ status: 'error', error: reason }), REASON)
  await page.waitForTimeout(200)
  const body = await text()
  check('横幅里是真实原因', body.includes(REASON), body.replace(/\n/g, ' | ').slice(0, 120))
  check('不再回退到 Unknown error', !body.includes('Unknown error'))
  const box = await boxOf(REASON)
  check('原因文字真的画出来了（有高度）', !!box && box.height > 0, box ? `${box.width}x${box.height}` : 'not found')
}

// ── 2. A re-attach seeds the reason from the snapshot ──
{
  console.log('== 重新附着（快照）==')
  // The client came back to a session already parked in error: the failing event
  // was delivered while it was away, so `snapshot.status.error` is the only carrier.
  const REASON = '连接中断：服务返回 502 Bad Gateway'
  await page.evaluate(() => { window.__messages([]) })
  await page.evaluate((reason) => window.__seed({ status: 'error', error: reason }), REASON)
  await page.waitForTimeout(200)
  const body = await text()
  check('快照里的原因进横幅', body.includes(REASON), body.replace(/\n/g, ' | ').slice(0, 120))
  check('同样不回退', !body.includes('Unknown error'))
}

// ── 3. Negative control: no reason on the wire → the fallback is still reachable ──
{
  console.log('== 反向对照：没有原因 ==')
  await page.evaluate(() => { window.__messages([]) })
  await page.evaluate(() => window.__status({ status: 'error' }))
  await page.waitForTimeout(200)
  const body = await text()
  check('没有原因时读回退文案', body.includes('Unknown error'), body.replace(/\n/g, ' | ').slice(0, 120))
  // Same control through the seed path: the fold must leave the key ABSENT, not
  // write an empty string (a present '' would render a blank banner instead).
  await page.evaluate(() => { window.__messages([]) })
  await page.evaluate(() => window.__seed({ status: 'error' }))
  await page.waitForTimeout(200)
  const seeded = await text()
  check('快照没有原因时也回退', seeded.includes('Unknown error'), seeded.replace(/\n/g, ' | ').slice(0, 120))
}

// ── 4. A healthy status draws no banner at all (the control for the whole surface) ──
{
  console.log('== 对照：正常状态 ==')
  await page.evaluate(() => { window.__messages([]) })
  await page.evaluate(() => window.__status({ status: 'streaming' }))
  await page.waitForTimeout(200)
  const body = await text()
  check('streaming 不画错误横幅', !body.includes('Unknown error') && !body.includes('出错'), body.replace(/\n/g, ' | ').slice(0, 80))
}

check('no page errors while rendering', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
