/**
 * Row-menu parity probe (real Chromium) — 侧栏两套行菜单的几何一致性验收。
 *
 * 项目行的 ⋯ 菜单在 2026-10-30 改成与对话行同一套契约（hover 触发 + 受控
 * open + 显形条件含 menuOpen + 菜单项自关）；本探针钉住单测看不到的那一半：
 * **菜单展开的几何方向**。对话行的 Dropdown 不带 placement（antd 默认
 * bottomLeft），项目行曾自带 `placement="bottomRight"` —— 交互对齐了，但一个
 * 向右下展开、一个向左下展开（2026-10-30 用户报「还是不一样」）。
 *
 * 方法：同页挂真实的 ConversationRows 与 ProjectSidebarList（300px 容器模拟
 * 侧栏宽），各自真实 hover 出菜单，量 `.ant-dropdown` 相对触发器的水平关系，
 * 判定「向左 / 向右展开」，断言两者一致。
 *
 * Usage: node scripts/probe-row-menus.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-rowmenu-probe-')), 'harness.js')

const PROJECT = { id: 'proj_probe', name: '探针项目', workspaceDir: '/pm-probe-ws', createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z' }
const CONV = { key: 'conv_probe', label: '探针会话', pinned: false, updatedAt: '2026-10-30T12:00:01.000Z' }

const HARNESS = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp } from 'antd'
import ConversationRows from './src/renderer/src/components/layout/ConversationRows'
import ProjectSidebarList from './src/renderer/src/components/layout/ProjectSidebarList'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

createRoot(document.getElementById('root')).render(
  <AntdApp component={false}>
    <TranslationProvider initialLocale="zh">
      {/* 300px 列：菜单无论朝哪边展开都留在视口内，排掉 antd 的自动翻转干扰。 */}
      <div id="col" style={{ width: 300 }}>
        <ConversationRows
          conversations={[{ ...window.__CONV }]}
          onSelect={() => {}} onDelete={() => {}} onRename={() => {}} onTogglePin={() => {}}
        />
        <ProjectSidebarList
          conversations={[]}
          activeKey={undefined}
          onOpenConversation={() => {}} onDelete={() => {}} onRename={() => {}} onTogglePin={() => {}}
          onEnterImmersive={() => {}}
        />
      </div>
    </TranslationProvider>
  </AntdApp>
)

/** 量一个打开的行菜单相对其触发器的水平关系。
 *  返回 null = 菜单没开。方向按「菜单体在触发器两侧的外伸量」判：
 *  向右外伸多 = 向右下展开（bottomLeft：menu.left 贴 trigger.left，主体右伸），
 *  向左外伸多 = 向左下展开（bottomRight：menu.right 贴 trigger.right，主体左伸）。
 *  注意不能用 menu.left 与 trigger.left 的差值判——bottomLeft 对齐的就是左缘，
 *  那个差值恒为 ~0，会把 bottomLeft 误判成向左。 */
window.__measure = (triggerSel) => {
  const trigger = document.querySelector(triggerSel)
  if (!trigger) return { error: 'no trigger: ' + triggerSel }
  const menu = [...document.querySelectorAll('.ant-dropdown')]
    .find((el) => !el.className.includes('hidden') && el.getBoundingClientRect().width > 0)
  if (!menu) return { error: 'menu not open' }
  const t = trigger.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  const leftOverflow = Math.round(t.left - m.left)   // 菜单向左伸出的量
  const rightOverflow = Math.round(m.right - t.right) // 菜单向右伸出的量
  const dir = Math.max(leftOverflow, rightOverflow) <= 2 ? 'aligned'
    : rightOverflow > leftOverflow ? 'right' : 'left'
  return {
    dir,
    trigger: { left: Math.round(t.left), right: Math.round(t.right), width: Math.round(t.width) },
    menu: { left: Math.round(m.left), right: Math.round(m.right), width: Math.round(m.width) },
    leftOverflow, rightOverflow,
  }
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const PAGE_HTML = `<!doctype html><html><head><style>
    body { margin: 0; background: #fff; }
  </style><script>
    window.__CONV = ${JSON.stringify(CONV)}
    window.electronAPI = new Proxy({
      projectList: () => Promise.resolve([${JSON.stringify(PROJECT)}]),
    }, {
      get: (target, key) => key in target
        ? target[key]
        : /^on[A-Z]/.test(key) ? () => () => {}
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : () => Promise.resolve(undefined)
    })
  </script></head><body><div id="root"></div></body></html>`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.route('http://pm-rowmenu.local/**', (route) => route.fulfill({
  contentType: 'text/html; charset=utf-8',
  body: PAGE_HTML,
}))
await page.goto('http://pm-rowmenu.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(600) // projectStore.reload() 落地、行渲染齐

/** 真实 hover 出一行菜单再量：先移到行上（显形触发器），再移到 ⋯ 上（开菜单）。 */
async function openAndMeasure(rowSel, triggerSel) {
  await page.mouse.move(10, 10) // 先离场，清掉上一轮的 hover 态
  await page.waitForTimeout(250)
  const row = page.locator(rowSel).first()
  const box = await row.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300) // React 重渲染：时间文本换 ⋯ / 悬停簇挂载
  const trig = page.locator(triggerSel).first()
  const tbox = await trig.boundingBox()
  if (!tbox) return { error: 'trigger not revealed: ' + triggerSel }
  await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2)
  await page.waitForTimeout(400) // antd hover 开启 + 弹层定位落定
  return page.evaluate((sel) => window.__measure(sel), triggerSel)
}

const conv = await openAndMeasure('[data-conv-row]', '[data-conv-row] .anticon-ellipsis')
console.log('  conversation:', JSON.stringify(conv))
check('对话行菜单 hover 可开', !conv.error, JSON.stringify(conv))
check('对话行菜单向右下展开（antd 默认 bottomLeft，无 placement）', conv.dir === 'right', `dir=${conv.dir}`)

const proj = await openAndMeasure('[data-project-header]', '[data-project-more]')
console.log('  project:     ', JSON.stringify(proj))
check('项目行菜单 hover 可开（沿用受控 open）', !proj.error, JSON.stringify(proj))

check('两套行菜单展开方向一致', !conv.error && !proj.error && conv.dir === proj.dir,
  `conversation=${conv.dir} project=${proj.dir}`)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
