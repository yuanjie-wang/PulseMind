/**
 * Sidebar drag probe (2026-10-26; real Chromium, real mouse).
 *
 * Mounts the production AppLayout (the real antd Sider, the real sidebar
 * store) over a stubbed electronAPI, and drives the drag handle on the
 * Sider's right edge:
 *
 *   1. the Sider opens at the persisted/default width and the handle is a
 *      full-height col-resize column on its right edge;
 *   2. dragging the handle widens/narrows the sidebar and the width lands in
 *      the persisted store (localStorage `pulsemind-sidebar`);
 *   3. antd's Sider width tween (the collapse animation) is suspended ONLY
 *      while the drag is held — a 0.2s transition would lag every pointermove
 *      behind the cursor — and comes back afterwards;
 *   4. the drag clamps at [220, 45% of the window] — the chat column keeps
 *      most of the window, and shrinking the window may not reclaim the
 *      sidebar's floor;
 *   5. 收起/展开 still works: collapse takes the handle with it (no edge to
 *      grab at width 0), expand restores the persisted width;
 *   6. a plain HOVER across the handle after a drag changes nothing (the
 *      `buttons === 0` guard — a canceled drag fires no pointerup, and the
 *      handle must not keep resizing on hover).
 *
 * Why a browser: vitest here is node-env — no layout, no pointer capture, no
 * antd. Every fact above is a fact about what is on screen.
 *
 * Usage: node scripts/probe-sidebar-drag.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-sidebar-drag-')), 'harness.js')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'

window.__mount = () => {
  const root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">
          <AppLayout
            conversations={[]}
            activeConversationKey={undefined}
            totalSessions={0}
            autoCleanup
            onCreateNew={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onTogglePinConversation={() => {}}
          />
        </TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
  return true
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

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body style="margin:0"><div id="root" style="width:100%;height:100vh"></div></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const VIEWPORT = { width: 1400, height: 900 }
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage()
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.goto(`${ORIGIN}/`)
await page.bringToFront()

// The stub MUST precede the bundle: AppLayout reads getWindowControls at
// module scope, and SettingsProvider's effect needs a real-shaped settings
// object (AppLayout reads settings.shortcuts per render).
await page.addScriptTag({
  content: `window.electronAPI = new Proxy({
    getSettings: () => Promise.resolve({ theme: 'light', locale: 'zh', providers: [], profiles: [], activeProfileId: '', autoCleanup: false, myName: '', soul: '', yourName: '', workspaceDir: '', shortcuts: {} }),
    setSettings: (s) => Promise.resolve(s),
    getWindowControls: () => ({ side: 'right', inset: 0 }),
  }, { get: (t, key) => (key in t ? t[key] : /^on[A-Z]/.test(key) ? () => () => {} : () => Promise.resolve(undefined)) })`,
})
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.locator('.ant-layout-sider').waitFor()

/* ── helpers ── */
const sider = page.locator('.ant-layout-sider')
const handle = page.locator('[data-pm-sidebar-drag-handle]')
const siderWidth = () => sider.evaluate((el) => el.getBoundingClientRect().width)
const storedWidth = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('pulsemind-sidebar') || 'null')?.state?.width ?? null
    } catch {
      return null
    }
  })
const siderTransition = () =>
  sider.evaluate((el) => {
    const cs = getComputedStyle(el)
    return `${cs.transitionProperty} ${cs.transitionDuration}`
  })
// antd's rest state reads e.g. "all, background 0.2s, 0s" — the width tween
// is the `all 0.2s` head; a second 0s entry (a background micro-transition)
// rides along and is irrelevant here.
const hasWidthTween = (t) => /all/.test(t) && /0\.\d+s/.test(t)
/** One drag gesture: press at the handle's mid-height, travel `dx` px, release. */
const dragBy = async (dx) => {
  const h = await handle.boundingBox()
  const y = h.y + h.height / 2
  await page.mouse.move(h.x + h.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 + dx, y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(80)
}

console.log('§1 初始形状 — 默认宽 280，通栏手柄带 col-resize')
{
  const w = await siderWidth()
  check('the Sider opens at the default 280', Math.abs(w - 280) <= 1.5, `w=${w}`)
  const hb = await handle.boundingBox()
  const sb = await sider.boundingBox()
  check('the handle rides the Sider’s right edge', Math.abs(hb.x + hb.width - (sb.x + sb.width)) <= 1.5, `handleRight=${hb.x + hb.width} siderRight=${sb.x + sb.width}`)
  check('the handle spans the Sider’s full height', Math.abs(hb.height - sb.height) <= 1.5, `h=${hb.height} vs ${sb.height}`)
  const cursor = await handle.evaluate((el) => getComputedStyle(el).cursor)
  check('the handle advertises col-resize', cursor === 'col-resize', cursor)
  const restTransition = await siderTransition()
  check('at rest the Sider keeps its width tween (the collapse animation)', hasWidthTween(restTransition), restTransition)
  var restTransitionKept = restTransition
}

console.log('§2 拖宽 +120 — 宽度跟手，落库')
{
  await dragBy(120)
  const w = await siderWidth()
  check('dragging right widens the sidebar to 400', Math.abs(w - 400) <= 1.5, `w=${w}`)
  check('…and the width persisted to localStorage', (await storedWidth()) === Math.round(w), `store=${await storedWidth()}`)
}

console.log('§3 拖拽期间关闭 Sider 的宽度补间，松手恢复')
{
  const h = await handle.boundingBox()
  const y = h.y + h.height / 2
  await page.mouse.move(h.x + h.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 + 12, y, { steps: 2 })
  const during = await siderTransition()
  await page.mouse.up()
  await page.waitForTimeout(80)
  check('mid-drag the transition is suspended (none 0s)', during === 'none 0s', during)
  check('…and restored on release', (await siderTransition()) === restTransitionKept, await siderTransition())
}

console.log('§4 钳制 — 上限 45% 窗宽，下限 220')
{
  await dragBy(2000)
  const wide = await siderWidth()
  const max = Math.floor(VIEWPORT.width * 0.45)
  check('a huge rightward drag clamps at 45% of the window', Math.abs(wide - max) <= 1.5, `w=${wide} max=${max}`)
  await dragBy(-4000)
  const narrow = await siderWidth()
  check('a huge leftward drag clamps at the 220 floor', Math.abs(narrow - 220) <= 1.5, `w=${narrow}`)
  check('…and the clamped value persisted', (await storedWidth()) === 220, `store=${await storedWidth()}`)
}

console.log('§5 收起 / 展开 — 折叠时手柄随行，展开回到持久宽')
{
  await page.locator('[aria-label="切换侧边栏"]').click()
  await page.waitForTimeout(400)
  const collapsedW = await siderWidth()
  check('collapse takes the Sider to 0', collapsedW <= 1, `w=${collapsedW}`)
  check('…and the handle with it (no edge to grab at width 0)', (await handle.count()) === 0)
  await page.locator('[aria-label="切换侧边栏"]').click()
  await page.waitForTimeout(400)
  const restored = await siderWidth()
  check('expand restores the persisted 220', Math.abs(restored - 220) <= 1.5, `w=${restored}`)
  check('…and the handle is back', (await handle.count()) === 1)
}

console.log('§6 悬停守卫 — 拖拽结束后划过手柄不改变宽度')
{
  const before = await siderWidth()
  const h = await handle.boundingBox()
  await page.mouse.move(h.x - 40, h.y + h.height / 2)
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2, { steps: 4 })
  await page.mouse.move(h.x + 60, h.y + h.height / 2, { steps: 4 })
  await page.waitForTimeout(60)
  check('a plain hover across the handle changes nothing', Math.abs((await siderWidth()) - before) <= 0.5, `w=${await siderWidth()} before=${before}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await browser.close()
server.close()
process.exit(failed.length ? 1 : 0)
