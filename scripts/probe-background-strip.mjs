// ── probe-background-strip（PLAN-background-tasks D）─────────────────────────
//
// 真渲染端探针：挂真的 useConversationEngine 事件折叠 + 真的
// BackgroundTasksStrip，stub electronAPI 的事件通道，驱动：
//   1. tool_status(diff 带 backgroundPid) → 条子出现、行带任务名（镜像块的
//      command 优先，块缺席回落 pid 字面量）；
//   2. background_task exit → 行退场、条子消失；
//   3. 多任务顺序退场（第一个 exit 只退一行、第二个 exit 条子消失）；
//   4. 会话隔离（2026-11-09 用户实锤「后台任务跨会话了」）：别会话的任务
//      不点亮本会话的条子，切会话条子只列自己那一行。
//   5. 指针纪律（2026-11-10 用户实锤「后台任务悬浮气泡和回到底部按钮冲突」）：
//      条子外盒是全卡宽对齐框（zIndex 100），不吃指针的话透明带正盖住居中的
//      【回到底部】圆钮——按真实导航钮几何（居中 36px 圆、z-auto）注入替身，
//      真鼠标点击/悬停验证穿透与不误弹。
//
// 死 pid 不得复活条子的契约修在主进程源头（emitToolStatusDiff 只对
// backgroundByPid 活值发 backgroundPid——回合结束拍的对账清扫会全量重发已
// 结算块，曾把 exit 已退场的行复活成永久卡住），由 tests/background-delivery
// 的源码钉钉住；渲染端折叠对 wire 上不出现的字段无从设防。
//
// 运行：node scripts/probe-background-strip.mjs（exit 0 = 全部通过）。
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-bgstrip-probe-')), 'harness.js')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  → ${detail}` : ''}`)
  if (!ok) failures++
}

const CONV = 'conv_probe_bg'
const MSG = {
  id: 'msg_1',
  role: 'assistant',
  contentBlocks: [
    {
      type: 'tool_use',
      id: 'tu_1',
      name: 'exec',
      status: 'completed',
      input: { command: 'npm run build', background: true },
      output: 'Background process started: pid=4242',
      backgroundPid: 4242,
    },
  ],
  createdAt: new Date().toISOString(),
}

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { useConversationEngine } from './src/renderer/src/hooks/useConversationEngine'
import BackgroundTasksStrip from './src/renderer/src/components/chat/BackgroundTasksStrip'
import { useBackgroundTasksStore } from './src/renderer/src/stores/backgroundTasksStore'

function Harness({ convId }) {
  const engine = useConversationEngine({})
  window.__engine = engine
  return createElement('div', { id: 'strip-host' }, createElement(BackgroundTasksStrip, { conversationId: convId }))
}

window.__ready = false
window.__storeSnapshot = () => JSON.parse(JSON.stringify(useBackgroundTasksStore.getState().byConversation))
const root = createRoot(document.getElementById('root'))
// 换会话重渲染（同一组件同一位置，引擎 hook 状态跨渲染保留）——会话隔离
// 那一节靠它在两个取数键之间切换。
window.__renderStrip = (convId) => root.render(createElement(Harness, { convId }))
window.__renderStrip('conv_probe_bg')
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
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'error',
})

const browser = await chromium.launch({ headless: !process.env.PROBE_DEV })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
if (process.env.PROBE_DEV) page.on('console', (m) => console.log('  [console]', m.text()))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
// Before the bundle: the hook subscribes at mount; the stub must exist up front.
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'onAgentSessionEvent' ? (cb) => { window.__pushAgentEvent = (data, sessionId) => cb({ sessionId: sessionId || '${CONV}', data }); return () => {} }
      : key === 'execLogs' ? (pid) => Promise.resolve('output tail of ' + pid)
      : key === 'getSettings' ? () => Promise.resolve({
          activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
          workspaceDir: '', autoCleanup: true, locale: 'zh',
        })
      : /^on[A-Z]/.test(key) ? () => () => {}
      : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready === true)

// Seed the mirror so the fold's `st` gate passes (real app: engine exists).
await page.evaluate((msg) => {
  window.__engine.seedSessionHistory('conv_probe_bg', [msg])
}, MSG)
const stripVisible = () => page.evaluate(() => !!document.querySelector('[data-pm-background-tasks]'))

/* ── 1. tool_status diff 带 backgroundPid → 条子出现，行带任务名。 ────────── */
await page.evaluate(() =>
  window.__pushAgentEvent({
    type: 'tool_status',
    updates: [{ messageId: 'msg_1', toolUseId: 'tu_1', status: 'completed', backgroundPid: 4242 }],
  }),
)
await page.waitForSelector('[data-pm-background-tasks]')
check('tool_status(backgroundPid) → 条子出现', await stripVisible())
let snap = await page.evaluate(() => window.__storeSnapshot())
check(
  '行登记在本会话名下且带命令名',
  snap[CONV]?.some((r) => r.pid === 4242 && r.label === 'npm run build'),
  JSON.stringify(snap),
)
check('条子文案带任务数', (await page.evaluate(() => document.querySelector('[data-pm-background-tasks]')?.textContent))?.includes('1'))

/* ── 2. background_task exit → 行退场、条子消失。 ──────────────────────────── */
await page.evaluate(() => window.__pushAgentEvent({ type: 'background_task', phase: 'exit', pid: 4242, code: 0 }))
await page.waitForFunction(() => !document.querySelector('[data-pm-background-tasks]'))
check('exit 事件 → 条子消失', !(await stripVisible()))
snap = await page.evaluate(() => window.__storeSnapshot())
check('exit 事件 → store 行退场（会话键一并删除）', !snap[CONV], JSON.stringify(snap))

/* ── 3. 多任务顺序退场 + 块缺席时的标签回落。 ──────────────────────────────── */
// 注：死 pid 的 diff 重放复活条子的根因修在主进程源头（emitToolStatusDiff 只
// 对 backgroundByPid 里的活 pid 发 backgroundPid——回合结束拍的对账清扫全量
// 重发死块曾把 exit 已退场的行复活成永久卡住）；渲染端折叠对 wire 上不出现
// 的字段无从设防，该层契约由 tests/background-delivery.test.ts 的源码钉钉住。
await page.evaluate(() =>
  window.__pushAgentEvent({
    type: 'tool_status',
    updates: [
      { messageId: 'msg_1', toolUseId: 'tu_1', status: 'completed', backgroundPid: 4242 },
      { messageId: 'msg_1', toolUseId: 'tu_missing', status: 'completed', backgroundPid: 4243 },
    ],
  }),
)
await page.waitForSelector('[data-pm-background-tasks]')
snap = await page.evaluate(() => window.__storeSnapshot())
check(
  '双任务两行：有名命令 + 块缺席回落 pid 字面量',
  snap[CONV]?.some((r) => r.pid === 4242 && r.label === 'npm run build') && snap[CONV]?.some((r) => r.pid === 4243 && r.label === 'pid=4243'),
  JSON.stringify(snap),
)
await page.evaluate(() => window.__pushAgentEvent({ type: 'background_task', phase: 'exit', pid: 4242, code: 0 }))
await new Promise((r) => setTimeout(r, 150))
snap = await page.evaluate(() => window.__storeSnapshot())
check('第一个 exit → 只退那一行', snap[CONV]?.length === 1 && snap[CONV][0].pid === 4243, JSON.stringify(snap))
await page.evaluate(() => window.__pushAgentEvent({ type: 'background_task', phase: 'exit', pid: 4243, code: null }))
await page.waitForFunction(() => !document.querySelector('[data-pm-background-tasks]'))
check('第二个 exit → 条子消失', !(await stripVisible()))

/* ── 4. 会话隔离（2026-11-09 用户实锤「后台任务跨会话了」）：读侧必须同键
 *      取数——全量摊平曾把别会话的任务搬进本会话的条子。 ─────────────────── */
// conv_other 的镜像先落座（fold 的 st 门：本窗口没有该会话的镜像，事件在
// `if (!st) return` 就被丢弃）。种子块的 id 与 diff 的 msg_x/tu_other 错开，
// 标签因此走 pid 字面量回落。
await page.evaluate(() =>
  window.__engine.seedSessionHistory('conv_other', [
    {
      id: 'msg_seed_other',
      role: 'assistant',
      contentBlocks: [{ type: 'tool_use', id: 'tu_seed_other', name: 'exec', status: 'completed', input: { command: 'sleep 999' } }],
      createdAt: new Date().toISOString(),
    },
  ]),
)
await page.evaluate(() =>
  window.__pushAgentEvent(
    {
      type: 'tool_status',
      updates: [{ messageId: 'msg_x', toolUseId: 'tu_other', status: 'completed', backgroundPid: 5001 }],
    },
    'conv_other',
  ),
)
await new Promise((r) => setTimeout(r, 150))
snap = await page.evaluate(() => window.__storeSnapshot())
check('别会话的 diff 照常入 store（键控正确）', !!snap.conv_other?.some((r) => r.pid === 5001), JSON.stringify(snap))
check('别会话在跑不点亮本会话的条子', !(await stripVisible()))
await page.evaluate(() => window.__renderStrip('conv_other'))
await page.waitForSelector('[data-pm-background-tasks]')
check('切到别会话，条子只列它自己的一行', (await page.evaluate(() => document.querySelector('[data-pm-background-tasks]')?.textContent))?.includes('1'))
check(
  '展开卡里没有本会话的任务',
  await page.evaluate(() => {
    const pill = document.querySelector('[data-pm-background-tasks]')
    pill.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    return new Promise((resolve) =>
      setTimeout(() => {
        const card = document.querySelector('[data-pm-background-tasks-card]')
        resolve(!!card && !card.textContent.includes('npm run build') && card.textContent.includes('5001'))
      }, 300),
    )
  }),
)
await page.evaluate(() => window.__renderStrip('conv_probe_bg'))
await new Promise((r) => setTimeout(r, 100))
check('切回本会话条子仍隐藏（别会话的任务还在跑）', !(await stripVisible()))

/* ── 5. 指针纪律（2026-11-10 用户实锤「后台任务悬浮气泡和回到底部按钮冲突」）──
 * 条子外盒是全卡宽（952）对齐框且 zIndex 100 压过导航根的 z-auto：不吃指针
 * 的话，药丸右侧那截透明带正盖住居中的【回到底部】圆钮——悬停中位弹卡、
 * 点击被吞。修法 = 外框 pointerEvents none、药丸/展开卡各自 auto（同
 * MessageNavControls 的根框纪律）；悬停开卡依赖 React 合成 enter/leave 沿
 * 祖先链派发，外框上的防抖逻辑不动。这里的替身按钮按真实导航钮几何注入
 * （fixed 覆盖条子带、居中 36px 圆、z-auto → 被条子带压住），全部走真鼠标。 */
await page.evaluate(() =>
  window.__pushAgentEvent({
    type: 'tool_status',
    updates: [{ messageId: 'msg_1', toolUseId: 'tu_1', status: 'completed', backgroundPid: 6001 }],
  }),
)
await page.waitForSelector('[data-pm-background-tasks]')
const pointerOf = () =>
  page.evaluate(() => {
    const wrapper = document.querySelector('[data-pm-background-tasks]')
    return {
      wrapper: getComputedStyle(wrapper).pointerEvents,
      pill: getComputedStyle(wrapper.firstElementChild).pointerEvents,
    }
  })
let pe = await pointerOf()
check('条子外框透明于指针（computed none）', pe.wrapper === 'none', JSON.stringify(pe))
check('药丸恢复可点（computed auto）', pe.pill === 'auto', JSON.stringify(pe))

// 替身【回到底部】圆钮：贴条子带下缘、水平居中、z-auto（真实 slot 里它被
// zIndex 100 的条子外盒压住）——真点击必须穿透外盒落到按钮上。
await page.evaluate(() => {
  const r = document.querySelector('[data-pm-background-tasks]').getBoundingClientRect()
  const nav = document.createElement('div')
  nav.id = 'fake-nav'
  nav.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom - 36}px;width:${r.width}px;height:36px;pointer-events:none;`
  const btn = document.createElement('button')
  btn.id = 'fake-bottom-btn'
  btn.setAttribute('aria-label', '回到底部')
  btn.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:0;width:36px;height:36px;border-radius:50%;pointer-events:auto;'
  btn.onclick = () => {
    window.__btnClicks = (window.__btnClicks ?? 0) + 1
  }
  nav.appendChild(btn)
  document.body.appendChild(nav)
})
const btnAt = await page.evaluate(() => {
  const r = document.getElementById('fake-bottom-btn').getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
await page.mouse.click(btnAt.x, btnAt.y)
check(
  '回到底部位（药丸右侧透明带之下）真点击落到按钮上',
  (await page.evaluate(() => window.__btnClicks ?? 0)) === 1,
  `clicks=${await page.evaluate(() => window.__btnClicks ?? 0)}`,
)

// 悬停开卡不受外框 none 影响：真实 hover 落在 auto 药丸上，React 合成
// enter 沿祖先链派发到外框，OPEN_DELAY 120ms 后弹卡。
const pillAt = await page.evaluate(() => {
  const r = document.querySelector('[data-pm-background-tasks]').firstElementChild.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
await page.mouse.move(pillAt.x, pillAt.y)
await page.waitForSelector('[data-pm-background-tasks-card]', { timeout: 1500 })
pe = await page.evaluate(() => getComputedStyle(document.querySelector('[data-pm-background-tasks-card]')).pointerEvents)
check('悬停药丸 → 展开卡浮出且可点（auto）', pe === 'auto', pe)
await page.mouse.move(600, 200)
await page.waitForTimeout(450)
check('移开指针 → 展开卡按 CLOSE_DELAY 收起', !(await page.evaluate(() => !!document.querySelector('[data-pm-background-tasks-card]'))))
// 透明带的死区（药丸右侧、替身钮左侧）：指针命中其下的宿主层，外框不进入，
// 不得误弹卡——这正是「悬停中位弹卡」冲突的另一半。
const deadAt = await page.evaluate(() => {
  const r = document.querySelector('[data-pm-background-tasks]').getBoundingClientRect()
  return { x: r.left + 200, y: r.top + r.height / 2 }
})
await page.mouse.move(deadAt.x, deadAt.y)
await page.waitForTimeout(400)
check('悬停药丸右侧的透明带死区不弹卡', !(await page.evaluate(() => !!document.querySelector('[data-pm-background-tasks-card]'))))

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
