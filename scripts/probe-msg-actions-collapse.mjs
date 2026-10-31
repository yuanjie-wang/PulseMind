/**
 * Message action row collapse probe (real Chromium) — 窄列收纳的几何验收。
 *
 * 2026-10-31 用户裁定：对话工具条在窄列下不再换行——统计组永远全量可见，
 * 按钮渐进收进 ⋯（≥440 全量 / 360–439 收 下载·点赞·日常任务 / <360 再收收藏）。
 * 机制是全局 index.html 的 @container 容器查询 + 常挂载双元素（内联按钮与
 * ⋯ 触发器都渲染，CSS 决定谁可见），单测只能钉字节，钉不住的是：
 *   ① 容器查询真的按行宽分档生效（!important 压过内联 display）；
 *   ② Dropdown 弹层挂进行内（getPopupContainer=trigger.parentElement）后，
 *      @container 真的够得到弹层里的菜单项（收藏项只在最窄档可见）；
 *   ③ 最窄档 320px 地板上整行仍是单行（不回退成两行）。
 *
 * 方法：同页挂三个真实 MessageGroup（600/400/320px 容器），逐档量按钮的
 * computed display；再真实 hover ⋯ 打开菜单量可见菜单项（2026-11-01 起菜单是
 * hover 触发）。CSS 直接从
 * src/renderer/index.html 抽 <style> 原文注入——探针测的就是产线字节。
 *
 * Usage: node scripts/probe-msg-actions-collapse.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-actions-probe-')), 'harness.js')

const MSG = {
  id: 'msg_probe_1',
  role: 'assistant',
  contentBlocks: [{ type: 'text', text: '这是一条用于探针的助手回复，带几个按钮的普通文本。' }],
  processingMs: 1234,
  inputTokens: 2345,
  outputTokens: 1102,
  promptCacheHitTokens: 1947,
}

const HARNESS = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp } from 'antd'
import { MessageGroup } from './src/renderer/src/components/chat/MessageGroup'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

const noop = () => {}
function Row({ id, width }) {
  return (
    <div id={id} style={{ width, marginBottom: 16 }}>
      <MessageGroup
        msg={window.__MSG}
        actions="full"
        onApproveTool={noop} onRejectTool={noop} onKillTool={noop}
        onExtractRoutine={noop}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <AntdApp component={false}>
    <TranslationProvider initialLocale="zh">
      <Row id="w-wide" width={600} />
      <Row id="w-t2" width={400} />
      <Row id="w-t3" width={320} />
    </TranslationProvider>
  </AntdApp>
)

/** 量一档里每个按钮的可见性 + 整行高度（换行 = 高度翻倍）。
 *  可见性必须量按钮自身的 computed display——图标 span 在 display:none 祖先里
 *  computed display 仍是 inline-block（不渲染的子树回报的是指定值）。 */
window.__rowState = (wrapSel) => {
  const wrap = document.querySelector(wrapSel)
  if (!wrap) return { error: 'no wrap: ' + wrapSel }
  const vis = (sel) => {
    const el = wrap.querySelector(sel)
    if (!el) return 'absent'
    const btn = el.closest('button') ?? el
    return getComputedStyle(btn).display === 'none' ? 'hidden' : 'visible'
  }
  const row = wrap.querySelector('.pm-msg-actions')
  if (!row) return { error: 'no action row' }
  return {
    copy: vis('.anticon-copy'),
    download: vis('.anticon-download'),
    like: vis('.anticon-like'),
    book: vis('.anticon-book'),
    routine: vis('.anticon-schedule'),
    more: vis('.pm-msg-overflow'),
    rowW: Math.round(row.getBoundingClientRect().width),
    rowH: Math.round(row.getBoundingClientRect().height),
  }
}

/** 打开的菜单（挂在行内）里可见的菜单项。 */
window.__menuState = (wrapSel) => {
  const wrap = document.querySelector(wrapSel)
  const dd = wrap && wrap.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')
  if (!dd) return { error: 'menu not open' }
  const items = [...dd.querySelectorAll('.ant-dropdown-menu-item')]
  const visible = items.filter((el) => getComputedStyle(el).display !== 'none')
  return {
    total: items.length,
    visible: visible.length,
    texts: visible.map((el) => el.textContent),
    parentIsRow: dd.parentElement.classList.contains('pm-msg-actions'),
  }
}
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
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 产线 CSS 原文（src/renderer/index.html 的 <style>）直接注入——探针测的就是
// 将要上车的字节，不另抄一份断点。
const indexHtml = readFileSync('src/renderer/index.html', 'utf-8')
const cssMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/)
if (!cssMatch) {
  console.error('FATAL: <style> not found in src/renderer/index.html')
  process.exit(1)
}
const prodCss = cssMatch[1]

const PAGE_HTML = `<!doctype html><html><head><style>${prodCss}</style>
<style> body { margin: 0; background: #fff; padding: 12px; } </style><script>
    window.__MSG = ${JSON.stringify(MSG)}
    window.electronAPI = new Proxy({}, {
      get: (target, key) => /^on[A-Z]/.test(key) ? () => () => {} : () => Promise.resolve(undefined)
    })
  </script></head><body><div id="root"></div></body></html>`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.route('http://pm-actions.local/**', (route) =>
  route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: PAGE_HTML,
  }),
)
await page.goto('http://pm-actions.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(400)

const rowState = (sel) => page.evaluate((s) => window.__rowState(s), sel)
const menuState = (sel) => page.evaluate((s) => window.__menuState(s), sel)
// 2026-11-01 用户裁定：⋯ 菜单改 hover 触发（不再点击）——探针跟着 hover。
async function openMenu(wrapSel) {
  await page.mouse.move(5, 5) // 离场清掉上一轮
  await page.waitForTimeout(250) // 上一轮弹层收起
  const btn = page.locator(`${wrapSel} [data-testid="msg-actions-more"]`)
  await btn.hover()
  await page.waitForTimeout(450) // antd hover 开启 + 弹层定位落定
}

// ── 宽档 600px：五个全在，⋯ 隐藏 ──
const wide = await rowState('#w-wide')
console.log('  wide 600:', JSON.stringify(wide))
check(
  '宽档：五个按钮全可见',
  wide.copy === 'visible' && wide.download === 'visible' && wide.like === 'visible' && wide.book === 'visible' && wide.routine === 'visible',
  JSON.stringify(wide),
)
check('宽档：⋯ 隐藏（老行原样）', wide.more === 'hidden', `more=${wide.more}`)

// ── 中档 400px：下载/点赞/日常任务 收起，复制+收藏 内联，菜单 3 项 ──
const t2 = await rowState('#w-t2')
console.log('  tier2 400:', JSON.stringify(t2))
check('中档：复制+收藏 内联保留', t2.copy === 'visible' && t2.book === 'visible', JSON.stringify(t2))
check(
  '中档：下载/点赞/日常任务 收进 ⋯',
  t2.download === 'hidden' && t2.like === 'hidden' && t2.routine === 'hidden' && t2.more === 'visible',
  JSON.stringify(t2),
)
await openMenu('#w-t2')
const menu2 = await menuState('#w-t2')
console.log('  tier2 menu:', JSON.stringify(menu2))
check('中档菜单：3 项可见（收藏项被 @container 藏住）', menu2.visible === 3 && menu2.total === 4, JSON.stringify(menu2))
check('弹层挂进行内（@container 够得到菜单项）', menu2.parentIsRow === true, `parentIsRow=${menu2.parentIsRow}`)

// ── 窄档 320px：只剩 复制+⋯，菜单 4 项，整行单行 ──
const t3 = await rowState('#w-t3')
console.log('  tier3 320:', JSON.stringify(t3))
check('窄档：只剩 复制+⋯ 内联', t3.copy === 'visible' && t3.book === 'hidden' && t3.more === 'visible', JSON.stringify(t3))
check('窄档 320px：整行单行（不回退两行）', t3.rowH > 0 && t3.rowH < 40, `rowH=${t3.rowH}`)
await openMenu('#w-t3')
const menu3 = await menuState('#w-t3')
console.log('  tier3 menu:', JSON.stringify(menu3))
check('窄档菜单：4 项全可见（含收藏）', menu3.visible === 4 && menu3.texts.some((s) => s.includes('收藏')), JSON.stringify(menu3))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
