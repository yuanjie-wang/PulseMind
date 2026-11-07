/**
 * Staged-strip × newest-message overlap, REAL HOST probe (real Chromium) —
 * 2026-11-04 用户复报「暂存消息会遮挡底部的最新消息」
 *
 * scripts/probe-above-card-reserve.mjs already proved the reserve wiring on a
 * bare ChatView with a one-line composer. The user still sees the overlap, so
 * this probe reproduces the REAL host instead: AppLayout + ChatView (the
 * probe-chat-scroll-pane recipe), and it walks the states a bare harness never
 * entered — above all a draft tall enough to make the composer card grow.
 *
 * The geometry that decides the question (all from the scroller's bottom edge):
 *
 *   stripTop   = cardTop − ABOVE_CARD_GAP − stripHeight
 *   lastBottom = scrollBottom − spacerPad                 (at the tail)
 *   spacerPad  = 160 + stripHeight + 8                    (today's formula)
 *
 * so the clearance is `160 − (scrollBottom − cardTop)`: any composer card taller
 * than ~136px eats it. The card is an autosizing Sender — a five-line draft adds
 * ~90px — and the fixed 160 was only ever sized for a one-line card.
 *
 * Usage: node scripts/probe-staged-overlap-realhost.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MARK = 'PROBE-REALHOST-LAST-MARK'
const SHOTS = join(mkdtempSync(join(tmpdir(), 'pm-staged-realhost-shots-')), 'shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-staged-realhost-')), 'harness.js')

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePendingMessageStore } from './src/renderer/src/stores/pendingMessageStore'

const CONV_KEY = 'conv_probe_realhost'
const MARK = '${MARK}'
installThemeVars()
applyThemeAttr('light')

const EMPTY = []
// Long enough that "at the tail" is a real scroll position in a 900px window.
const MESSAGES = Array.from({ length: 14 }, (_, i) => {
  const last = i === 13
  const body = last
    ? MARK + ' — 这条消息必须完整露在暂存条上方。'
    : (i % 2 === 0 ? '用户：' : '助手：') + '为了把转录撑到视口以外，这里写一段足够长的正文。'.repeat(8)
  return {
    id: 'm' + i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    contentBlocks: [{ type: 'text', text: body }],
    createdAt: new Date(Date.UTC(2026, 10, 4, 0, i)).toISOString(),
  }
})

function Harness() {
  const [status, setStatus] = useState({ status: 'idle' })
  return (
    <div style={{ height: 900, display: 'flex' }}>
      <AppLayout conversations={[]} activeConversationKey={CONV_KEY} totalSessions={1} autoCleanup={true}
        onCreateNew={() => {}} onDeleteConversation={() => {}} onRenameConversation={() => {}}
        onSelectConversation={() => {}} onTogglePinConversation={() => {}}>
        <ChatView messages={MESSAGES} conversationId={CONV_KEY}
          isRequesting={status.status !== 'idle'} agentStatus={status} streamingBlocks={EMPTY}
          hasApiKey={true} onSendMessage={() => {}} onSendStaged={async () => true}
          onCancel={() => {}} onApproveTool={() => {}} onRejectTool={() => {}} onClearError={() => {}}
          conversations={EMPTY} />
      </AppLayout>
    </div>
  )
}

let root = null
window.__mount = () => {
  if (root) root.unmount()
  const host = document.createElement('div')
  host.id = 'case-app'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><Harness /></TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

window.__stores = { pending: usePendingMessageStore }
window.__convKey = CONV_KEY
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
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message, '\n', err.stack))
// The bridge stub must exist BEFORE the bundle runs: AppLayout reads
// window.electronAPI.getWindowControls at module scope (one-time read), so a
// stub assigned inside the harness body would run too late — ES imports are
// hoisted. An inline page script (the probe-chat-scroll-pane recipe) is the fix.
const PAGE = `<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>
<script>
window.electronAPI = new Proxy({}, {
  get: (_t, key) => key === 'getWindowControls'
    ? () => ({ side: 'left', inset: 70 })
    : key === 'getPlatformInfo'
      ? () => Promise.resolve({ platform: 'darwin' })
      : key === 'getSettings'
        ? () => Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' })
        : /[Ll]ist$|^list[A-Z]?/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined),
})
</script>`
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.bringToFront()

// ── helpers ──
const stage = (text) => page.evaluate((t) => window.__stores.pending.getState().stage(window.__convKey, t), text)
const clearQueue = () => page.evaluate(() => window.__stores.pending.getState().clear(window.__convKey))
const metrics = () =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-pm-chat-scroll]')
    const spacer = document.querySelector('[data-pm-composer-spacer]')
    const wrap = document.querySelector('[data-above-card-reserve]')
    const strip = document.querySelector('[data-staged-strip]')
    const sender = document.querySelector('.ant-sender')
    const area = document.querySelector('[data-pm-chat-scroll]')
    const ta = document.querySelector('.ant-sender textarea')
    const rect = (el) => (el ? el.getBoundingClientRect() : null)
    const last = spacer ? spacer.previousElementSibling : null
    const lr = rect(last)
    const sr = rect(strip)
    const ar = rect(sender)
    const cr = rect(area)
    return {
      pad: spacer ? parseFloat(getComputedStyle(spacer).paddingBottom) : null,
      wrapH: wrap ? wrap.offsetHeight : 0,
      wrapPresent: wrap !== null,
      rows: document.querySelectorAll('[data-staged-item]').length,
      stripTop: sr ? sr.top : null,
      stripH: sr ? sr.height : null,
      cardTop: ar ? ar.top : null,
      cardH: ar ? ar.height : null,
      scrollBottom: cr ? cr.bottom : null,
      // card band: the two edges the fixed 160 is standing in for
      band: ar && cr ? cr.bottom - ar.top : null,
      lastBottom: lr ? lr.bottom : null,
      lastText: last ? (last.textContent || '').slice(0, 80) : null,
      textareaLines: ta ? ta.value.split('\n').length : 0,
      gap: sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight : null,
    }
  })

const waitRows = (n) => page.waitForFunction((count) => document.querySelectorAll('[data-staged-item]').length === count, n, { timeout: 3000 })
const near = (a, b, tol = 1) => a !== null && b !== null && Math.abs(a - b) <= tol
/** Negative = the newest message's bottom sits above the strip = visible. */
const overlap = (m) => (m.lastBottom === null || m.stripTop === null ? null : m.lastBottom - m.stripTop)

console.log('\n§0 真实宿主基线：无暂存条')
await page.evaluate(() => window.__mount())
await page.waitForTimeout(600)
let m = await metrics()
check('真实 AppLayout + ChatView 渲染了转录', m.pad !== null && m.lastBottom !== null)
check('最后一条是带标记的那条', (m.lastText ?? '').includes(MARK), m.lastText ?? '')
check('基线 spacer = 160', near(m.pad, 160), String(m.pad))
check('挂载即落底', m.gap !== null && m.gap < 2, String(m.gap))
check('composer 卡在位', m.cardTop !== null, JSON.stringify({ band: m.band, cardH: m.cardH }))
console.log(`  · 宿主几何：scrollBottom=${m.scrollBottom} cardTop=${m.cardTop} band=${m.band} cardH=${m.cardH}`)

console.log('\n§1 单行草稿 + 两行暂存：现有修复应当成立')
await stage('暂存一')
await stage('暂存二')
await waitRows(2)
await page.waitForTimeout(300)
m = await metrics()
check('暂存条两行', m.rows === 2 && m.stripTop !== null)
check('spacer = 160 + 槽位高 + 8', near(m.pad, 160 + m.wrapH + 8), `${m.pad} vs ${160 + m.wrapH + 8}`)
check('最新消息没有被遮（单行卡）', overlap(m) !== null && overlap(m) <= 0.5, `overlap=${overlap(m)}`)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '1-single-line.png') })

console.log('\n§2 同一屏里把草稿写高（五行的 Sender 卡）：这正是真实使用里的形态')
const ta = page.locator('.ant-sender textarea').first()
await ta.click()
for (let i = 1; i <= 5; i += 1) {
  await page.keyboard.type(`第${i}行草稿`)
  if (i < 5) await page.keyboard.press('Shift+Enter')
}
await page.waitForTimeout(400)
const tall = await metrics()
console.log(`  · 五行草稿：textareaLines=${tall.textareaLines} cardH=${tall.cardH} band=${tall.band} pad=${tall.pad}`)
check('草稿真的把卡写高了(>=2 行)', tall.textareaLines >= 2 && tall.cardH > m.cardH, `lines=${tall.textareaLines} cardH=${tall.cardH}/${m.cardH}`)
check('spacer 跟着卡一起长', tall.pad > m.pad, `${m.pad} -> ${tall.pad}`)
check('最新消息仍完整露在暂存条上方(高卡)', overlap(tall) !== null && overlap(tall) <= 0.5, `overlap=${overlap(tall)}`)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '2-tall-card.png') })

console.log('\n§3 清空草稿：预留回落到单行基线')
await ta.fill('')
await page.waitForTimeout(400)
m = await metrics()
check('草稿清空后 card 回矮', m.cardH < tall.cardH, `${tall.cardH} -> ${m.cardH}`)
check('spacer 回落', m.pad <= tall.pad, `${tall.pad} -> ${m.pad}`)
check('最新消息仍完整', overlap(m) !== null && overlap(m) <= 0.5, `overlap=${overlap(m)}`)

console.log('\n§4 清空队列：预留归零')
await clearQueue()
await page.waitForFunction(() => !document.querySelector('[data-staged-strip]'), null, { timeout: 3000 })
await page.waitForTimeout(300)
m = await metrics()
check('暂存条退场', m.rows === 0 && m.stripTop === null)
check('spacer 回到 160', near(m.pad, 160), String(m.pad))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
