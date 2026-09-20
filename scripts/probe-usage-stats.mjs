/**
 * Real-browser render of the usage statistics page (用量统计) in BOTH themes.
 * The old page painted the same light-mode series (near-black #1d1d1f output,
 * #d4d4d4 input) in dark mode and inited echarts' built-in 'dark' theme, whose
 * own #100c2a background showed as three navy blocks on the #141414 ground —
 * "深色模式下的用量统计有点丑". The page now wears ZCode's usage palette
 * (sky/teal, brightened rungs in dark) with explicit per-mode chrome.
 *
 * This probe mounts the *real* StatisticsPage with fixture token_usage data and
 * asserts, per mode: no echarts theme background leaks (transparent, never
 * #100c2a), the ZCode series colours (and that the old constants are gone),
 * the input bar's rounded top, the axis/splitLine/legend chrome, and the
 * headline row's dot colours + 万-compacted totals. jsdom has no canvas and no
 * layout, so none of this is visible outside a real browser.
 *
 * Usage: node scripts/probe-usage-stats.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = process.env.PM_SHOT_DIR ?? join(tmpdir(), 'pm-usage-stats-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── Fixture: cumulative monthly sums land in the 万 range so the headline
// exercises the zh compaction (…45789 → 2345.8万 rung, verified against the
// same arithmetic recomputed here). ──
const MONTHS = Array.from({ length: 11 }, (_, i) => ({
  month: i < 3 ? `2025-${String(i + 10).padStart(2, '0')}` : `2026-${String(i - 2).padStart(2, '0')}`,
  inputTokens: 100000 + i * 1000,
  outputTokens: 50000 + i * 5000,
}))
MONTHS.push({ month: '2026-09', inputTokens: 22245789, outputTokens: 8310432 })
const TOTAL_IN = MONTHS.reduce((s, m) => s + m.inputTokens, 0)
const TOTAL_OUT = MONTHS.reduce((s, m) => s + m.outputTokens, 0)
const compactZh = (n) => {
  const trim = (v) => String(Math.round(v * 10) / 10)
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(n)
}

const DATA_FIXTURE = {
  hourly: Array.from({ length: 12 }, (_, i) => ({
    time: `2026-09-20 ${String(i + 8).padStart(2, '0')}:00`,
    inputTokens: i === 3 ? 0 : 40000 + i * 9000,
    outputTokens: i === 3 ? 0 : 8000 + i * 1200,
  })),
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-09-${14 + i}`,
    inputTokens: 300000 + i * 45000,
    outputTokens: 60000 + i * 8000,
  })),
  monthly: MONTHS,
}
const EMPTY_FIXTURE = {
  hourly: [{ time: '2026-09-20 08:00', inputTokens: 0, outputTokens: 0 }],
  daily: [{ date: '2026-09-20', inputTokens: 0, outputTokens: 0 }],
  monthly: [{ month: '2026-09', inputTokens: 0, outputTokens: 0 }],
}

const HARNESS = `
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { setThemeMode } from './src/renderer/src/theme/mode'
installThemeVars()
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme as antdTheme } from 'antd'
import * as echarts from 'echarts'
import StatisticsPage from './src/renderer/src/components/layout/StatisticsPage'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'

const FIXTURES = { data: ${JSON.stringify(DATA_FIXTURE)}, empty: ${JSON.stringify(EMPTY_FIXTURE)} }
window.electronAPI = {
  getTokenStats: () => Promise.resolve(FIXTURES[window.__fixture ?? 'data']),
}

function Harness({ mode }) {
  return (
    <ConfigProvider theme={{
      token: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
      algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    }}>
      <TranslationProvider initialLocale="zh">
        <div style={{ width: 808, margin: '0 auto' }}>
          <StatisticsPage />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

const root = createRoot(document.getElementById('app'))
window.__echarts = echarts
window.__render = (mode, fixture) => {
  window.__fixture = fixture
  setThemeMode(mode)
  applyThemeAttr(mode)
  // key 换新强制卸载重挂：同一组件复用会保留上一相位的 stats state，
  // 而 getTokenStats 的 effect 依赖为空，不会重新 fetch。
  root.render(<Harness key={mode + fixture} mode={mode} />)
}
window.__render('light', 'empty')
`

const OUT = join(tmpdir(), `pm-usage-stats-${process.pid}.js`)
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
})

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 960, height: 1500 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
const PAGE = '<!doctype html><html><body style="margin:0"><div id="app"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
await page.goto('http://pm-probe.local/')
await page.addScriptTag({ path: OUT })

// ── Phase 0: empty data still reads as 暂无数据, no chart canvases ──
await page.waitForFunction(
  () => {
    const empty = [...document.querySelectorAll('.ant-empty-description')].some((el) => el.textContent?.includes('暂无数据'))
    return empty
  },
  null,
  { timeout: 15000 },
)
check('空数据分支仍是 暂无数据（不渲染图表）', (await page.locator('canvas').count()) === 0)

const CHARTS_READY = () => document.querySelectorAll('div[_echarts_instance_]').length === 3

/** Read one chart's live echarts option off its _echarts_instance_ dom. */
const readOption = (page, index) =>
  page.evaluate((i) => {
    const el = document.querySelectorAll('div[_echarts_instance_]')[i]
    return window.__echarts.getInstanceByDom(el).getOption()
  }, index)

/** The headline blocks are the only divs styled with tabular-nums (StatBlock's
 *  value line); walk up one parent for the block and read its dot swatch. */
const readHeader = (page) =>
  page.evaluate(() => {
    const values = [...document.querySelectorAll('div')].filter((d) => d.style.fontVariantNumeric === 'tabular-nums')
    return values.map((v) => {
      const block = v.parentElement
      const dot = block.querySelector('span[style*="border-radius"]')
      return { text: block.textContent, dot: dot ? getComputedStyle(dot).backgroundColor : null }
    })
  })

const groundColor = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('div[style*="var(--pm-bg)"]')
    return el ? getComputedStyle(el).backgroundColor : null
  })

// ── Phase 1: light, with data ──
await page.evaluate(() => window.__render('light', 'data'))
await page.waitForFunction(CHARTS_READY, null, { timeout: 15000 })

const lightHourly = await readOption(page, 0)
check(
  '浅色：echarts 无主题底色（transparent，不是 dark 主题的 #100c2a）',
  lightHourly.backgroundColor === 'transparent' || lightHourly.backgroundColor === undefined,
  JSON.stringify(lightHourly.backgroundColor),
)
check('浅色：输出=sky-600 #0284c7（ZCode usage-chart-1）', lightHourly.series[0].itemStyle.color === '#0284c7', String(lightHourly.series[0].itemStyle.color))
check('浅色：输入=teal-600 #0d9488（ZCode usage-chart-2）', lightHourly.series[1].itemStyle.color === '#0d9488', String(lightHourly.series[1].itemStyle.color))
check(
  '浅色：堆叠段顺序 输出在下、输入（圆角顶 [3,3,0,0]）在上',
  Array.isArray(lightHourly.series[1].itemStyle.borderRadius) &&
    lightHourly.series[1].itemStyle.borderRadius.join(',') === '3,3,0,0' &&
    lightHourly.series[0].name === '输出 Token' &&
    lightHourly.series[1].name === '输入 Token',
  JSON.stringify({ order: lightHourly.series.map((s) => s.name), radius: lightHourly.series[1].itemStyle.borderRadius }),
)
check(
  '浅色：坐标轴/网格线是浅色 chrome',
  lightHourly.xAxis[0].axisLabel.color === '#999999' && lightHourly.yAxis[0].splitLine.lineStyle.color === '#f0f0f0',
  JSON.stringify({ label: lightHourly.xAxis[0].axisLabel.color, split: lightHourly.yAxis[0].splitLine.lineStyle.color }),
)
check(
  '浅色：图例右上、圆点 marker、secondary 墨色',
  lightHourly.legend[0].right === 0 && lightHourly.legend[0].icon === 'circle' && lightHourly.legend[0].textStyle.color === '#666666',
  JSON.stringify({ right: lightHourly.legend[0].right, icon: lightHourly.legend[0].icon }),
)
check(
  '浅色：旧配色（#1d1d1f/#d4d4d4）不再出现在任何系列',
  !JSON.stringify(lightHourly).includes('#1d1d1f') && !JSON.stringify(lightHourly).includes('"#d4d4d4"'),
)

const lightHead = await readHeader(page)
check(
  '浅色：头部三个汇总块（输出/输入/合计）',
  lightHead.length === 3 && lightHead[0].text.includes('输出 Token') && lightHead[1].text.includes('输入 Token') && lightHead[2].text.includes('合计'),
  JSON.stringify(lightHead.map((b) => b.text)),
)
check(
  '浅色：汇总数值按 万 压缩且等于累计值',
  lightHead[0].text.includes(compactZh(TOTAL_OUT)) &&
    lightHead[1].text.includes(compactZh(TOTAL_IN)) &&
    lightHead[2].text.includes(compactZh(TOTAL_OUT + TOTAL_IN)),
  JSON.stringify({ expected: [compactZh(TOTAL_OUT), compactZh(TOTAL_IN), compactZh(TOTAL_OUT + TOTAL_IN)], got: lightHead.map((b) => b.text) }),
)
check(
  '浅色：汇总圆点与系列同色（合计块无圆点）',
  lightHead[0].dot === 'rgb(2, 132, 199)' && lightHead[1].dot === 'rgb(13, 148, 136)' && lightHead[2].dot === null,
  JSON.stringify(lightHead.map((b) => b.dot)),
)
check('浅色：页面地面跟随 --pm-bg（#ffffff）', (await groundColor(page)) === 'rgb(255, 255, 255)', String(await groundColor(page)))

// echarts 的入场动画 ~1s，立即截图会拍到从零长起的中途帧。
await page.waitForTimeout(1400)
await page.screenshot({ path: join(SHOTS, 'light.png'), fullPage: true })

// ── Phase 2: dark (the user's complaint) ──
await page.evaluate(() => window.__render('dark', 'data'))
await page.waitForFunction(CHARTS_READY, null, { timeout: 15000 })

const darkHourly = await readOption(page, 0)
check(
  '深色：echarts 仍无主题底色（此前这里画出 #100c2a 深蓝块）',
  darkHourly.backgroundColor === 'transparent' || darkHourly.backgroundColor === undefined,
  JSON.stringify(darkHourly.backgroundColor),
)
check('深色：输出提亮为 sky-500 #0ea5e9（ZCode .dark 覆盖）', darkHourly.series[0].itemStyle.color === '#0ea5e9', String(darkHourly.series[0].itemStyle.color))
check('深色：输入提亮为 teal-400 #2dd4bf（ZCode .dark 覆盖）', darkHourly.series[1].itemStyle.color === '#2dd4bf', String(darkHourly.series[1].itemStyle.color))
check(
  '深色：坐标轴/网格线用暗色 chrome（白 alpha，不是浅色实灰）',
  darkHourly.xAxis[0].axisLabel.color === '#8c8c8c' && darkHourly.yAxis[0].splitLine.lineStyle.color === 'rgba(255, 255, 255, 0.08)',
  JSON.stringify({ label: darkHourly.xAxis[0].axisLabel.color, split: darkHourly.yAxis[0].splitLine.lineStyle.color }),
)
check('深色：图例文字是暗色 secondary', darkHourly.legend[0].textStyle.color === '#a6a6a6', String(darkHourly.legend[0].textStyle.color))
check('深色：旧配色（#1d1d1f/#d4d4d4）不再出现在任何系列', !JSON.stringify(darkHourly).includes('#1d1d1f') && !JSON.stringify(darkHourly).includes('"#d4d4d4"'))

const darkHead = await readHeader(page)
check(
  '深色：汇总圆点换深色亮档（sky-500 / teal-400），数值不变',
  darkHead[0].dot === 'rgb(14, 165, 233)' &&
    darkHead[1].dot === 'rgb(45, 212, 191)' &&
    darkHead[0].text.includes(compactZh(TOTAL_OUT)) &&
    darkHead[2].text.includes(compactZh(TOTAL_OUT + TOTAL_IN)),
  JSON.stringify(darkHead.map((b) => ({ text: b.text, dot: b.dot }))),
)
check('深色：页面地面跟随 --pm-bg（#141414）', (await groundColor(page)) === 'rgb(20, 20, 20)', String(await groundColor(page)))

await page.waitForTimeout(1400)
await page.screenshot({ path: join(SHOTS, 'dark.png'), fullPage: true })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}/light.png, ${SHOTS}/dark.png`)
process.exit(failed.length > 0 ? 1 : 0)
