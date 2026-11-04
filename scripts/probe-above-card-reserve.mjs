/**
 * Above-card reserve probe (real Chromium) — 「暂存消息会遮挡底部的最新消息」
 *
 * The floating composer's aboveCard slot (the staged-message strip, the plan
 * strip) is absolutely positioned, so it paints OVER the transcript instead of
 * pushing it. The composer's fixed 160px spacer only covers the card itself;
 * without a reserve the newest message ends up underneath the strip.
 *
 * Source wiring is pinned in tests/above-card-reserve.test.ts. What only a real
 * layout engine can answer is:
 *
 *   - the spacer's padding actually equals 160 + the measured slot height + 8
 *   - the last message's bottom really sits above the strip's top
 *   - growth re-pins a reader who was at the tail (padding growth lands below
 *     the fold, so the message would otherwise stay exactly where it was)
 *   - a reader scrolled up is NOT yanked down when a row is staged
 *   - an emptied queue releases the reserve back to 160
 *
 * Mounts the real `ChatView` (transcript arm) with a real `pendingMessageStore`
 * queue — no Electron, no LLM; `onSendStaged` is a stub.
 *
 * Usage: node scripts/probe-above-card-reserve.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Same literal the harness embeds in the last message (kept in sync by hand —
 *  it is a probe marker, not a contract). */
const MARK = 'PROBE-LAST-MESSAGE-MARK'

const SHOTS = join(mkdtempSync(join(tmpdir(), 'pm-above-card-shots-')), 'shots')
const OUT = join(mkdtempSync(join(tmpdir(), 'pm-above-card-reserve-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePendingMessageStore } from './src/renderer/src/stores/pendingMessageStore'

const TABLE = {
  expertList: [],
  projectList: [],
  listConversations: [],
  routineList: [],
  routineRuns: [],
  knowledgeListFiles: [],
  browserHistoryQuery: [],
  getConversationLastUserMessage: '',
  getSettings: { activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' },
}
installThemeVars()
applyThemeAttr('light')

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    return Promise.resolve(TABLE[key])
  },
})

const EMPTY = []
const IDLE = { status: 'idle' }
const MARK = 'PROBE-LAST-MESSAGE-MARK'

// Enough body to push the transcript past the 700px host, so "at the tail"
// is a real scroll position and not a no-op.
const MESSAGES = Array.from({ length: 12 }, (_, i) => {
  const last = i === 11
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

function Shell() {
  return (
    <div style={{ display: 'flex', height: 700 }}>
      <div id="chat-host" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <ChatView
          conversationId="conv_probe"
          messages={MESSAGES}
          isRequesting={false}
          agentStatus={IDLE}
          streamingBlocks={EMPTY}
          hasApiKey={true}
          onSendMessage={() => {}}
          onSendStaged={async () => true}
          onCancel={() => {}} onApproveTool={() => {}} onRejectTool={() => {}}
          onClearError={() => {}}
          conversations={EMPTY}
          onOpenConversation={() => {}}
        />
      </div>
    </div>
  )
}

let root = null
window.__mount = () => {
  if (root) root.unmount()
  const host = document.createElement('div')
  host.id = 'case-chat'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider><Shell /></TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}

window.__stores = { pending: usePendingMessageStore }
window.__mark = MARK
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
  define: { 'process.env.NODE_ENV': '"production"' },
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
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.bringToFront()

// ── helpers ──
const stage = (text) => page.evaluate((t) => window.__stores.pending.getState().stage('conv_probe', t), text)
const clearQueue = () => page.evaluate(() => window.__stores.pending.getState().clear('conv_probe'))

/** One snapshot of everything the assertions read — rects, not styles, for the
 *  clearance claims (the strip really does paint over the transcript). */
const metrics = () =>
  page.evaluate(() => {
    const sc = document.querySelector('[data-pm-chat-scroll]')
    const spacer = document.querySelector('[data-pm-composer-spacer]')
    const wrap = document.querySelector('[data-above-card-reserve]')
    const strip = document.querySelector('[data-staged-strip]')
    const sender = document.querySelector('.ant-sender')
    const rect = (el) => (el ? el.getBoundingClientRect() : null)
    const last = spacer ? spacer.previousElementSibling : null
    const lr = rect(last)
    const sr = rect(strip)
    return {
      pad: spacer ? parseFloat(getComputedStyle(spacer).paddingBottom) : null,
      wrapH: wrap ? wrap.offsetHeight : 0,
      wrapPresent: wrap !== null,
      rows: document.querySelectorAll('[data-staged-item]').length,
      stripTop: sr ? sr.top : null,
      stripH: sr ? sr.height : null,
      stripLeft: sr ? sr.left : null,
      stripRight: sr ? sr.right : null,
      stripW: sr ? sr.width : null,
      // The card is the width reference the strip must match: one content
      // column, both capped at COMPOSER_MAX_WIDTH (952) and centred.
      cardLeft: sender ? rect(sender).left : null,
      cardRight: sender ? rect(sender).right : null,
      cardW: sender ? rect(sender).width : null,
      stripScroll: strip ? strip.scrollHeight : null,
      stripClient: strip ? strip.clientHeight : null,
      lastBottom: lr ? lr.bottom : null,
      lastText: last ? (last.textContent || '').slice(0, 80) : null,
      scrollTop: sc ? sc.scrollTop : null,
      gap: sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight : null,
      senderTop: sender ? rect(sender).top : null,
    }
  })

const waitRows = (n) => page.waitForFunction((count) => document.querySelectorAll('[data-staged-item]').length === count, n, { timeout: 3000 })

const near = (a, b, tol = 1) => a !== null && b !== null && Math.abs(a - b) <= tol

console.log('\n§0 基线：没有暂存条时 spacer 就是 160')
await page.evaluate(() => window.__mount())
await page.waitForTimeout(400)
let m = await metrics()
check('转录渲染出来了(scroller + spacer)', m.pad !== null && m.lastBottom !== null)
check('基线 spacer = 160(卡自身的带)', near(m.pad, 160), String(m.pad))
check('基线没有常驻 aboveCard 内容', !m.wrapPresent && m.rows === 0, `wrap=${m.wrapPresent} rows=${m.rows}`)
check('最后一条是带标记的那条', (m.lastText ?? '').includes(MARK), m.lastText ?? '')
check('挂载即落到底部(follow-tail)', m.gap !== null && m.gap < 2, String(m.gap))
const senderTopBase = m.senderTop
check('composer 卡在位', senderTopBase !== null)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '0-baseline.png') })

console.log('\n§1 暂存两行：spacer 长到 160 + 槽位高 + 8，最新消息露出')
await stage('暂存一')
await stage('暂存二')
await waitRows(2)
await page.waitForTimeout(200)
m = await metrics()
check('暂存条出现(两行)', m.rows === 2 && m.stripTop !== null, `rows=${m.rows}`)
check('量测 wrapper 挂载', m.wrapPresent && m.wrapH > 0, `wrapH=${m.wrapH}`)
// 这条是整件事的核心等式：预留 = 槽位实测高 + ABOVE_CARD_GAP(8)。
check('spacer = 160 + wrapper.offsetHeight + 8', near(m.pad, 160 + m.wrapH + 8), `${m.pad} vs ${160 + m.wrapH + 8}`)
check('最新消息底边在暂存条顶边之上(不再被遮)', m.lastBottom <= m.stripTop + 0.5, `msgBottom=${m.lastBottom} stripTop=${m.stripTop}`)
// The wrapper that carries the reserve is a flex COLUMN, and the strip inside
// it has `margin: 0 auto` — auto margins on a flex item beat `align-self:
// stretch`, so without an explicit width the strip shrink-to-fits its content
// (user report 2026-11-04: 「还把暂存区宽度缩小了」). Both must read as the one
// content column: same width, same edges, as the composer card.
check(
  '暂存条与输入卡等宽(同一内容列 952)',
  near(m.stripW, m.cardW, 1.5) && near(m.stripLeft, m.cardLeft, 1.5) && near(m.stripRight, m.cardRight, 1.5),
  `strip=${m.stripW}@${m.stripLeft}–${m.stripRight} card=${m.cardW}@${m.cardLeft}–${m.cardRight}`,
)
check('尾部读者被重钉回底部', m.gap !== null && m.gap < 2, String(m.gap))
check('暂存条浮在 composer 卡之上(不挤动它)', m.senderTop === senderTopBase && m.stripTop < senderTopBase, `sender=${m.senderTop}/${senderTopBase}`)
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '1-staged-two-rows.png') })

console.log('\n§2 上滚的读者不被拽下来')
// 用真实滚轮：会话落地的 bottom-pin 以真实输入事件（wheel/pointer/key）为
// 「用户接管」信号，程序化写 scrollTop 不在其列——那样测到的「被拽回」是
// pin 在补高度，不是暂存预留的锅。
const scroller = await page.locator('[data-pm-chat-scroll]').boundingBox()
await page.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2)
await page.mouse.wheel(0, -1500)
await page.waitForTimeout(300)
const before = await metrics()
check('已离开尾部(真实滚轮上滚生效)', before.gap !== null && before.gap > 100, String(before.gap))
const padBefore = before.pad
await stage('暂存三(上滚时加入)')
await waitRows(3)
await page.waitForTimeout(250)
m = await metrics()
check('槽位长高(spacer 跟着长)', m.pad > padBefore, `${padBefore} -> ${m.pad}`)
check(
  '上滚位置纹丝不动(没有被强制贴底)',
  m.scrollTop !== null && before.scrollTop !== null && Math.abs(m.scrollTop - before.scrollTop) <= 1,
  `${before.scrollTop} -> ${m.scrollTop}`,
)

console.log('\n§3 回到尾部再堆到上限：预留封顶、消息仍露')
await page.evaluate(() => {
  const sc = document.querySelector('[data-pm-chat-scroll]')
  sc.scrollTop = sc.scrollHeight
})
await page.waitForTimeout(250)
m = await metrics()
check('再次落到底部', m.gap !== null && m.gap < 2, String(m.gap))
for (let i = 4; i <= 8; i += 1) await stage(`暂存${i}(堆高)`)
await waitRows(8)
await page.waitForTimeout(250)
m = await metrics()
check('八行都渲染了(条自身滚动)', m.rows === 8, `rows=${m.rows}`)
// maxHeight 200 是 content-box，外加 padding 6/8 与 1px 边框 = 216 的外框高；
// 关键是它停在帽上、不再随行数线性增长，并且自身可滚。
check(
  '条高被 maxHeight 200 钳住',
  m.stripH !== null && m.stripH <= 216 && m.stripScroll > m.stripClient,
  `h=${m.stripH} scroll=${m.stripScroll} client=${m.stripClient}`,
)
check('spacer 仍等于 160 + 实高 + 8(封顶后不线性增长)', near(m.pad, 160 + m.wrapH + 8), `${m.pad} vs ${160 + m.wrapH + 8}`)
check('堆到上限后最新消息依然完整', m.lastBottom <= m.stripTop + 0.5, `msgBottom=${m.lastBottom} stripTop=${m.stripTop}`)
check('仍在尾部', m.gap !== null && m.gap < 2, String(m.gap))
mkdirSync(SHOTS, { recursive: true })
await page.screenshot({ path: join(SHOTS, '2-strip-at-cap.png') })

console.log('\n§4 清空队列：预留归零，spacer 回 160')
await clearQueue()
await page.waitForFunction(() => !document.querySelector('[data-staged-strip]'), null, { timeout: 3000 })
await page.waitForTimeout(250)
m = await metrics()
check('暂存条退场', m.rows === 0 && m.stripTop === null)
check('量测 wrapper 退场(预留释放)', !m.wrapPresent)
check('spacer 回到 160', near(m.pad, 160), String(m.pad))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
