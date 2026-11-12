/**
 * 目录树快速连点文件的每击成本判官（2026-10-31，用户报「快速连续点击多个
 * 文件会卡顿，感觉和文件大小无关」）。
 *
 * 真 WorkbenchPane（真 WorkspaceTree + 真 PreviewPane）over 桩 electronAPI。
 * 两场实验：
 *   §A 小→小连点：10 个 ~20KB 代码文件轮流点 8 轮，量每击 long task 与帧间隙；
 *   §B 单击预算；§C 大文件单开 + 滚动。
 * 2026-11-01 PLAN-codemirror-view 重基线：预览查看态已迁入 CM 实例——本探针
 * 的全部数字从「字符串高亮 DOM」换成「CM 视口渲染」口径（挂载 = EditorView
 * 创建 + 视口渲染；大文件 = 全文 doc + 只渲染可见行；滚动目标 = .cm-scroller）。
 * 判官口径：PerformanceObserver longtask + rAF 帧间隙双路。
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-click-jank-')), 'harness.js')
const CONV = 'conv_probe'
const ROOT = '/w'

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { buildThemeCss } from './src/renderer/src/theme/palette'
import { WorkbenchPane } from './src/renderer/src/components/workbench/WorkbenchPane'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'

const CONV = ${JSON.stringify(CONV)}
let root = null
window.__stores = { workbench: useWorkbenchStore, preview: usePreviewPaneStore }
window.__mount = () => {
  if (root) root.unmount()
  if (!document.getElementById('pm-theme-vars')) {
    const style = document.createElement('style')
    style.id = 'pm-theme-vars'
    style.textContent = buildThemeCss()
    document.head.appendChild(style)
  }
  useWorkbenchStore.setState({ openByConversation: { [CONV]: true }, activeTabByConversation: { [CONV]: 'workspace' } })
  usePreviewPaneStore.getState().setWorkspaceDir(${JSON.stringify(ROOT)})
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider theme={buildAntdTheme('light')}>
      <TranslationProvider initialLocale="zh">
        <WorkbenchPane conversationId={CONV} chatAreaWidth={900} plan={null}
          browserPane={{ visible: false, width: 420, conversationId: CONV, tabs: [] }}
          onBrowserAction={() => {}} onBrowserWidth={() => {}} />
      </TranslationProvider>
    </ConfigProvider>,
  )
  return true
}
window.__ready = true
`

await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  minify: false,
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  loader: { '.css': 'text', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
})

const results = []
function check(name, pass, detail) {
  results.push(pass)
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// In-page measurement: long tasks + rAF gaps during a click burst.
const METER = `
window.__longTasks = [];
window.__meterOn = false;
new PerformanceObserver((list) => {
  if (window.__meterOn) window.__longTasks.push(...list.getEntries().map((e) => Math.round(e.duration)));
}).observe({ entryTypes: ['longtask'] });
window.__frameGaps = [];
let last = 0;
const loop = (t) => {
  if (window.__meterOn && last) {
    const gap = t - last;
    if (gap > 34) window.__frameGaps.push(Math.round(gap));
  }
  last = t;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
window.__meterStart = () => { window.__longTasks = []; window.__frameGaps = []; window.__meterOn = true; };
window.__meterStop = () => { window.__meterOn = false; return { long: window.__longTasks, gaps: window.__frameGaps }; };
`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html><body style="margin:0"><div id="root" style="position:relative;width:1200px;height:820px"></div></body></html>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const context = await browser.newContext({ viewport: { width: 1200, height: 820 } })
const page = await context.newPage()
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.goto(`${ORIGIN}/`)

const NL = String.fromCharCode(10)
const SMALL = Array.from({ length: 280 }, (_, i) => `const v${i} = compute(${i}, 'text'); // ${i}`).join(NL)
const BIG = Array.from({ length: 20000 }, (_, i) => `line ${i}: ${'y'.repeat(70)}`).join(NL) // ~1.6MB, 20k real lines — under the 2M-char view cap
await page.addScriptTag({
  content: `
  window.__files = {
    '/w/f0.ts': ${JSON.stringify(SMALL)},
    '/w/f1.ts': ${JSON.stringify(SMALL)},
    '/w/f2.ts': ${JSON.stringify(SMALL)},
    '/w/f3.ts': ${JSON.stringify(SMALL)},
    '/w/f4.ts': ${JSON.stringify(SMALL)},
    '/w/f5.ts': ${JSON.stringify(SMALL)},
    '/w/f6.ts': ${JSON.stringify(SMALL)},
    '/w/f7.ts': ${JSON.stringify(SMALL)},
    '/w/f8.ts': ${JSON.stringify(SMALL)},
    '/w/f9.ts': ${JSON.stringify(SMALL)},
    '/w/big.ts': ${JSON.stringify(BIG)},
    '/w/plain.xyz': ${JSON.stringify(SMALL)},
    '/w/mid.ts': ${JSON.stringify(('z'.repeat(70) + '\n').repeat(715))},
    '/w/mid48.ts': ${JSON.stringify(('w'.repeat(62) + '\n').repeat(782))},
  };
  window.__dirs = {
    '/w': Object.keys(window.__files).map((p) => ({ name: p.slice(3), path: p, isDir: false })),
  };
  window.electronAPI = new Proxy({}, { get: (_t, key) =>
    key === 'listDir' ? (p) => Promise.resolve(window.__dirs[p] === undefined ? null : { entries: window.__dirs[p] })
    : key === 'readFile' ? (p) => Promise.resolve(window.__files[p] ?? null)
    : key === 'getFileStat' ? () => Promise.resolve(null)
    : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
    : /^on[A-Z]/.test(key) ? () => () => {}
    : () => Promise.resolve(undefined) })`,
})
await page.addScriptTag({ content: METER })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.evaluate(() => window.__mount())
await page.locator('.pm-ws-tree').waitFor()

const row = (p) => page.locator(`.pm-ws-row[data-ws-path="${p}"]`)
const nameOf = (p) => row(p).locator('.pm-ws-name')

/** Click one row and report how long the resulting commit stalled the main
 *  thread (long tasks observed within the next 300ms window). */
const clickAndMeasure = async (p) => {
  await page.evaluate(() => window.__meterStart())
  await nameOf(p).click()
  await page.waitForTimeout(300)
  return page.evaluate(() => window.__meterStop())
}

const summarize = (m) => `long=[${m.long.join(',')}] gaps=[${m.gaps.slice(0, 8).join(',')}${m.gaps.length > 8 ? '…' : ''}] maxGap=${Math.max(0, ...m.gaps)}ms`

/* ── §0 CPU profile, self-time only, no filtering ── */
const cdp = await context.newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
await cdp.send('Profiler.start')
await nameOf('/w/f1.ts').click()
await page.waitForTimeout(1500)
const prof = await cdp.send('Profiler.stop')
await cdp.detach()
const nodes = new Map(prof.profile.nodes.map((n) => [n.id, n]))
const self = new Map()
let summed = 0
for (const [id, dt] of Object.entries(prof.profile.timeDeltas)) {
  summed += dt
  self.set(Number(id), (self.get(Number(id)) || 0) + dt / 1000)
}
console.log('  §0 delta 总和', Math.round(summed / 1000), 'ms, 采样节点数', self.size)
const frame = (cf) => `${(cf.functionName || '(anon)')} @ ${(cf.url || '').split('/').slice(-1)[0]}:${cf.lineNumber}`
const top = [...self.entries()].map(([id, t]) => ({ t, f: frame(nodes.get(id)?.callFrame || { functionName: '???' }) })).sort((a, b) => b.t - a.t).slice(0, 20)
for (const n of top) console.log(`    self=${n.t.toFixed(1).padStart(7)}  ${n.f}`)

/* ── §0f CM(ts)→CM(无语法)（卸载上一个编辑器 DOM 仍在，挂载便宜） ── */
{
  await nameOf('/w/f1.ts').click()
  await page.waitForTimeout(300)
  const m = await clickAndMeasure('/w/plain.xyz')
  console.log('  §0f CM(ts)→CM(无语法)(挂载便宜):', summarize(m))
}
/* ── §0e CM(无语法)→CM(无语法)（无语法解析，基线） ── */
{
  const m = await clickAndMeasure('/w/plain.xyz') // same file — 0 expected
  console.log('  §0e 同纯文本重复击(基线0):', summarize(m))
  // Need a second grammar-less file for a real switch; reuse big.ts (no syntax parse).
  const m2 = await clickAndMeasure('/w/big.ts')
  console.log('  §0e 纯文本→大纯文本:', summarize(m2))
}

/* ── §0g 150K CM(ts) 单击挂载 ── */
{
  await nameOf('/w/plain.xyz').click()
  await page.waitForTimeout(300)
  const m = await clickAndMeasure('/w/mid.ts')
  console.log('  §0g 150K CM(ts)单击挂载:', summarize(m))
  const m2 = await clickAndMeasure('/w/plain.xyz')
  console.log('  §0g 150K→小(卸载大编辑器):', summarize(m2))
}

/* ── §0h 48K CM(ts) 单击挂载 ── */
{
  await nameOf('/w/plain.xyz').click()
  await page.waitForTimeout(300)
  const m = await clickAndMeasure('/w/mid48.ts')
  console.log('  §0h 48K CM(ts)单击挂载:', summarize(m))
}

/* ── §0x 差分：间隔 300ms 的单击 vs 背靠背 ── */
{
  await nameOf('/w/f0.ts').click()
  await page.waitForTimeout(500)
  const spaced = []
  for (let i = 1; i <= 4; i++) {
    spaced.push(await clickAndMeasure(`/w/f${i}.ts`))
  }
  console.log('  §0x 间隔300ms×4:', spaced.map((m) => `long=[${m.long.join(',')}]`).join('  '))
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__meterStart())
  for (let i = 5; i <= 8; i++) {
    await nameOf(`/w/f${i}.ts`).click()
  }
  await page.waitForTimeout(600)
  const burst = await page.evaluate(() => window.__meterStop())
  console.log('  §0x 背靠背×4:', `long=[${burst.long.join(',')}]`)
}

/* ── §A 连发：8 击背靠背（真实连点节奏，无等待） ── */
await nameOf('/w/f0.ts').click()
await page.waitForTimeout(400) // settle
{
  await page.evaluate(() => window.__meterStart())
  for (let i = 1; i <= 8; i++) {
    await nameOf(`/w/f${i}.ts`).click()
  }
  await page.waitForTimeout(600) // let the final (deferred) render land
  const m = await page.evaluate(() => window.__meterStop())
  const total = m.long.reduce((s, n) => s + n, 0)
  check('§A 8击连发总阻塞 < 250ms（中间击不排队，只有最终渲染一次）', total < 250, `total=${total}ms long=[${m.long.join(',')}] maxGap=${Math.max(0, ...m.gaps)}ms`)
}
/* ── §B 单击预算（去抖 leading 路径，20KB CM(ts) 视图挂载） ── */
await page.waitForTimeout(400)
{
  const m = await clickAndMeasure('/w/f3.ts')
  const worst = Math.max(0, ...m.long)
  check('§B 单击(距上次>150ms)阻塞 < 120ms', worst < 120, summarize(m))
}
/* ── §C 大文件：1.6MB doc 走 CM 视口渲染，单开 < 100ms ── */
await page.waitForTimeout(400)
{
  const m = await clickAndMeasure('/w/big.ts')
  const worst = Math.max(0, ...m.long)
  check('§C 1.6MB CM 视口单开 < 100ms（全文 doc + 只渲染可见行）', worst < 100, summarize(m))
  const info = await page.evaluate(() => {
    const view = window.__pmPreviewCM
    return {
      hosts: document.querySelectorAll('[data-pm-cm-editor]').length,
      lines: view ? view.state.doc.lines : -1,
      scroller: !!document.querySelector('.cm-scroller'),
    }
  })
  console.log(`    （CM host 数=${info.hosts} doc 行数=${info.lines} scroller 在场=${info.scroller}）`)
  // 滚动：CM 的 scroller 自己滚——wrapper 被 height:100% 的 host 占满，滚它没用。
  await page.evaluate(() => window.__meterStart())
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => { const el = document.querySelector('.cm-scroller'); if (el) el.scrollTop += 600; return true })
    await page.waitForTimeout(0)
  }
  await page.waitForTimeout(300)
  const s = await page.evaluate(() => window.__meterStop())
  const sTotal = s.long.reduce((x, y) => x + y, 0)
  check('§C-滚动 1.6MB CM 视口 25 步总阻塞 < 150ms', sTotal < 150, `total=${sTotal}ms long=[${s.long.join(',')}] maxGap=${Math.max(0, ...s.gaps)}ms`)
}
const failed = results.filter((r) => !r).length
console.log(failed === 0 ? `\n${results.length}/${results.length} checks passed — ALL GREEN` : `\n${results.length - failed}/${results.length} checks passed`)
await browser.close()
server.close()
process.exit(failed === 0 ? 0 : 1)
