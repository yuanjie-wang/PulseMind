/**
 * Probe: 上下文环的「输入预算」刻度线（方案 A，user 2026-11-17 拍板）在真实
 * Chromium 里的效果。
 *
 * 单测能证明 props 传过来了、字符串里有那个 key，但证明不了这四件事，而这四件
 * 才是这个功能成不成立的地方：
 *
 *  1. 角度。刻度是从 (cx,cy) 出发按 cos/sin 画的，填充弧是用 strokeDashoffset
 *     画的 —— 两套完全不同的算式。两者只要差一点，「越过这条线就开始压缩」这
 *     句话就是错的。所以断言它们反算出的比例相等，而不是各自跟常量比。
 *  2. 真的画出来了。1px 的线贴着描边画，一旦伸到 box 边缘就会被抗锯齿吃掉，
 *     DOM 里仍然有一根 `line` 元素、几何全对，屏幕上什么都没有。只有像素能
 *     判定这一点 —— 同位置开/关刻度各截一张，字节必须不同。
 *  3. 该不画的时候真的一根都没有（预算 == 总量 / > 总量 / 0 / 未传）。
 *  4. tooltip 里的真实行序：环读数 → 预算 → 缓存。预算行插错位置就没人读了。
 *
 * 真值不硬编码：预算由引擎同一个 effectiveInputWindow 算出来，probe 读回去比对。
 *
 *   node scripts/probe-context-ring-tick.mjs [--headed]
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-ring-tick-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-ring-tick-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { ContextRing } from './src/renderer/src/components/chat/ContextRing'
import { effectiveInputWindow } from './src/renderer/src/agent/engine/window-budget'

// 与应用同一启动顺序：先变量表、再属性。没有变量表，var(--pm-text-secondary)
// 解析不出来，刻度 stroke 是空的 —— 页面会「正确地」什么都不画。
installThemeVars()
applyThemeAttr('light')

// 真值由引擎自己算，probe 不重复一份算式。
const B200 = effectiveInputWindow(200000, 32000)
const B64 = effectiveInputWindow(65536, 32000)

const state = {
  // used 恰等于预算 —— 刻度与填充弧末端必须落在同一角度
  x200k: { used: B200, total: 200000, budget: B200, cache: null },
  // 同预算、低用量 —— 刻度一动不动：它回答「何时压缩」，不是「现在多满」
  x200kLow: { used: 80000, total: 200000, budget: B200, cache: null },
  // 以下四个都必须一根线都不画
  eqTotal: { used: 100000, total: 200000, budget: 200000, cache: null },
  overTotal: { used: 100000, total: 200000, budget: 220000, cache: null },
  zero: { used: 100000, total: 200000, budget: 0, cache: null },
  absent: { used: 100000, total: 200000, budget: undefined, cache: null },
  // 小窗口：65536 配 32K 的 ask，比例与 200K 完全不同
  small: { used: B64, total: 65536, budget: B64, cache: null },
  // 带缓存读数 —— 验证 tooltip 三行的顺序
  withCache: { used: B200, total: 200000, budget: B200, cache: { hitRate: 0.873, requestCount: 7, reliable: true } },
}

function App() {
  return (
    <div style={{ display: 'flex', gap: 28, padding: 28, alignItems: 'flex-start' }}>
      {Object.keys(state).map((k) => (
        <div key={k} data-case={k} style={{ width: 24, height: 24 }}>
          <ContextRing used={state[k].used} total={state[k].total} diameter={16} cacheHit={state[k].cache} inputBudget={state[k].budget} />
        </div>
      ))}
    </div>
  )
}

const root = createRoot(document.getElementById('root'))
const render = () => root.render(<TranslationProvider><App /></TranslationProvider>)
window.__setBudget = (id, v) => { state[id] = { ...state[id], budget: v }; render() }
window.__realBudget = { b200: B200, b64: B64 }
render()
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
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
// 2x：1px 的线在 1x 下只有一列半透明像素，差分容易被抗锯齿噪声吞掉
const page = await browser.newPage({ viewport: { width: 1100, height: 400 }, deviceScaleFactor: 2 })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })
await page.waitForFunction('window.__ready === true')

const CX = 12
const CY = 12
/** 反算刻度的比例：0% = 顶点，顺时针，与填充弧的 rotate(-90) 同一套约定。 */
function ratioOf(x, y) {
  const a = Math.atan2(y - CY, x - CX) + Math.PI / 2
  const norm = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return norm / (2 * Math.PI)
}

const geom = (id) =>
  page.evaluate((cid) => {
    const host = document.querySelector(`[data-case="${cid}"]`)
    const svg = host.querySelector('svg')
    const line = svg.querySelector('line')
    const circles = Array.from(svg.querySelectorAll('circle'))
    const filled = circles[circles.length - 1]
    const out = {
      hasLine: line !== null,
      dasharray: parseFloat(filled.getAttribute('stroke-dasharray')),
      dashoffset: parseFloat(filled.getAttribute('stroke-dashoffset')),
      radius: parseFloat(filled.getAttribute('r')),
      box: svg.width.baseVal.value,
    }
    if (line) {
      out.line = {
        x1: +line.getAttribute('x1'),
        y1: +line.getAttribute('y1'),
        x2: +line.getAttribute('x2'),
        y2: +line.getAttribute('y2'),
        sw: +line.getAttribute('stroke-width'),
      }
    }
    return out
  }, id)

const real = await page.evaluate(() => window.__realBudget)
console.log(`── 引擎口径（probe 不另算）── 200K/32K → ${real.b200} · 65536/32K → ${real.b64}`)
check('200K 窗口的输入预算 = 168000（32K 预留）', real.b200 === 168000, String(real.b200))
check('65536 窗口的输入预算 = 33536（半窗守卫生效，reserve=32000）', real.b64 === 33536, String(real.b64))

console.log('── 几何：刻度角度 vs 填充弧角度（两套算式必须重合）──')
const g200 = await geom('x200k')
check('200K case 画出了刻度线', g200.hasLine)
const expect200 = real.b200 / 200000
const tick200 = ratioOf(g200.line.x2, g200.line.y2)
const arc200 = 1 - g200.dashoffset / g200.dasharray
check(`刻度反算比例 = ${expect200.toFixed(6)}（84%）`, Math.abs(tick200 - expect200) < 1e-4, `实测 ${tick200.toFixed(6)}`)
check('填充弧反算比例与之相等（同一套 0%=顶点 顺时针约定）', Math.abs(arc200 - tick200) < 1e-4, `弧 ${arc200.toFixed(6)} vs 刻度 ${tick200.toFixed(6)}`)
check('弧长取整没有引入偏差（dashoffset 是精确值不是 round 过的）', Math.abs(arc200 - expect200) < 1e-6, `${arc200.toFixed(9)}`)

const rEnd = Math.hypot(g200.line.x2 - CX, g200.line.y2 - CY)
const rStart = Math.hypot(g200.line.x1 - CX, g200.line.y1 - CY)
check('刻度起点贴着描边外沿（不压在填充弧上，否则同色看不见）', rStart > g200.radius + g200.line.sw / 2, `r=${rStart.toFixed(3)} 描边外沿 ${(g200.radius + g200.line.sw / 2).toFixed(3)}`)
check('刻度两端都够到了 box 内（到盒边会被抗锯齿抹掉）', rEnd > rStart && rEnd < g200.box / 2 - 0.5, `rStart=${rStart.toFixed(3)} rEnd=${rEnd.toFixed(3)} 盒半宽=${g200.box / 2}`)

console.log('── 刻度独立于用量：换 used 不动刻度 ──')
const gLow = await geom('x200kLow')
const tickLow = ratioOf(gLow.line.x2, gLow.line.y2)
const arcLow = 1 - gLow.dashoffset / gLow.dasharray
check('低用量下刻度角度与高用量完全一致', Math.abs(tickLow - tick200) < 1e-9, `${tickLow.toFixed(9)} vs ${tick200.toFixed(9)}`)
check('但填充弧明显更短（40%）', Math.abs(arcLow - 0.4) < 1e-4, `弧 ${arcLow.toFixed(6)}`)
check('刻度坐标逐位相同（不是巧合的近似）', gLow.line.x2 === g200.line.x2 && gLow.line.y2 === g200.line.y2)

console.log('── 小窗口：65536/32K → 51% ──')
const gSmall = await geom('small')
const expectSmall = real.b64 / 65536
const tickSmall = ratioOf(gSmall.line.x2, gSmall.line.y2)
check('65536 窗口的刻度比例 = 51.2%', Math.abs(tickSmall - expectSmall) < 1e-4, `实测 ${tickSmall.toFixed(6)} 期望 ${expectSmall.toFixed(6)}`)
check('与 200K 的刻度位置不同（比例真的按窗口算，不是写死的 84%）', Math.abs(tickSmall - tick200) > 0.3)

console.log('── 该不画时必须一根都没有 ──')
for (const [id, why] of [
  ['eqTotal', '预算 == 总量（正落在顶点，无信息）'],
  ['overTotal', '预算 > 总量（宿主口径不一致）'],
  ['zero', '预算 = 0'],
  ['absent', '预算未传'],
]) {
  const g = await geom(id)
  check(`${id}：${why} → 不画`, g.hasLine === false)
}

console.log('── tooltip：真实 DOM 的行与序 ──')
const tipText = async (id) => {
  const sel = `[data-case="${id}"] .pm-context-ring`
  await page.hover(sel)
  await page.waitForTimeout(450)
  // antd v5 没有 .ant-tooltip-inner：文本在 .ant-tooltip 容器里。取「可见且最后一个」
  // —— 连续 hover 两个 case 时上一个还在退场动画里，残留节点会串行。
  const txt = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.ant-tooltip:not(.ant-tooltip-hidden)'))
    const vis = nodes.filter((n) => n.getBoundingClientRect().height > 0)
    return vis.length ? vis[vis.length - 1].innerText : ''
  })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
  return txt
}
// 与 ContextRing 的 inK 同一口径（1024 进制、一位小数），不另算一套
const inK = (v) => `${Math.round((v / 1024) * 10) / 10}K`
const tCache = await tipText('withCache')
const lines = tCache.split('\n').map((s) => s.trim()).filter(Boolean)
console.log(`  [measured] tooltip = ${JSON.stringify(lines)}`)
check('tooltip 三行齐全（环读数 / 预算 / 缓存）', lines.length === 3, `${lines.length} 行`)
check('第一行是环读数，含 84%', /84%/.test(lines[0]), lines[0])
const budgetK = inK(real.b200)
// 不能用 includes(budgetK) 定位：这个 case 的 used 恰好等于 budget，环读数是
// "84% · 164.1K / …"，两行都含 164.1K。行序本身就是契约，按索引判。
const budgetIdx = lines.findIndex((l, i) => i > 0 && l.includes(budgetK))
check(`预算行是第 2 行，带自己的绝对量 ${budgetK}（1024 进制，与环读数同口径）`, budgetIdx === 1, `行 ${budgetIdx}`)
check('预算行含刻度百分比 84%', budgetIdx > 0 && /84%/.test(lines[budgetIdx]), lines[budgetIdx])
const cacheIdx = lines.findIndex((l) => /87%/.test(l))
check('缓存行在预算行之后（顺序：环 → 预算 → 缓存）', cacheIdx > budgetIdx, `budget=${budgetIdx} cache=${cacheIdx}`)

const tPlain = await tipText('x200k')
const plainLines = tPlain.split('\n').map((s) => s.trim()).filter(Boolean)
console.log(`  [measured] 无缓存时 tooltip = ${JSON.stringify(plainLines)}`)
check('没有缓存读数时不显示缓存行（不把缺读数画成 0%）', plainLines.length === 2, `${plainLines.length} 行`)

console.log('── 像素：线真的被画出来了（不是只有 DOM 元素）──')
mkdirSync(SHOTS, { recursive: true })
const box = await page.locator('[data-case="x200k"] .pm-context-ring').boundingBox()
const clip = { x: Math.round(box.x) - 3, y: Math.round(box.y) - 3, width: Math.round(box.width) + 6, height: Math.round(box.height) + 6 }
// 同位置、同用量、同填充弧，只切换刻度有无：布局不变（line 不占布局），
// 两图唯一的差异就只能来自那 1px 的线。
await page.evaluate(() => window.__setBudget('x200k', 200000))
await page.waitForTimeout(450)
const offShot = await page.screenshot({ clip })
await page.screenshot({ path: join(SHOTS, 'tick-off.png'), clip })
await page.evaluate(() => window.__setBudget('x200k', window.__realBudget.b200))
await page.waitForTimeout(450)
const onShot = await page.screenshot({ clip })
await page.screenshot({ path: join(SHOTS, 'tick-on.png'), clip })
check('开关刻度的两张截图字节不同（线确实可见，没被抗锯齿吃掉）', !offShot.equals(onShot), `bytes ${offShot.length} vs ${onShot.length}`)
const gBack = await geom('x200k')
check('切回后刻度回到原位（重渲染没有留下错位的线）', Math.abs(ratioOf(gBack.line.x2, gBack.line.y2) - expect200) < 1e-4)

// 整页：给一张能直接看的图
await page.screenshot({ path: join(SHOTS, 'context-ring-ticks.png'), fullPage: true })
console.log(`\n截图：${SHOTS}`)

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
