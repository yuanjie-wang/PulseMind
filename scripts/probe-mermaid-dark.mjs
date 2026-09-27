/**
 * Mermaid dark-theme probe (real Chromium).
 *
 * The report: 深色模式下，mermaid图的文字看不清，因为图块背景色是浅色，文字是白色.
 *
 * Root cause, measured: the diagram text is painted by the x-markdown *theme*
 * CSS, not by mermaid. Flowchart-v2 renders labels as HTML inside the SVG's
 * foreignObject — `<span class="nodeLabel"><p>…</p></span>` — and
 * `.x-markdown-dark p { color: var(--text-color) }` (white, 0.85) legitimately
 * reaches that <p>: it sits inside the markdown container like any other
 * paragraph. Mermaid's own injected rules style `span`/`text` (#333) but never
 * the <p>, so the painted ink is white on the default theme's light #ECECFF
 * nodes. Light mode never showed it because `.x-markdown-light p` is dark.
 *
 * The fix follows the Prism oneLight/oneDark precedent in CodeHighlight: the
 * mermaid THEME is chosen in JS from useThemeMode — dark mode renders
 * `theme: 'dark'` (dark #1F2020 nodes, light ink, so the app's white <p> is
 * correct there too) — and is handed to LazyMermaid as `config`, which
 * re-initializes and re-renders on the config identity change.
 *
 * Sections:
 *   1. production CodeBlock + XMarkdown, dark: node fill dark, every sampled
 *      label ink (span and the <p> the app CSS owns) light — readable, with the
 *      boundary values named
 *   2. a real mode flip (setThemeMode) re-renders the diagram to the light
 *      theme: fill back to #ECECFF, inks dark — the config must ride the mode,
 *      not a one-time initialize
 *   3. non-vacuity: the reverted shape (Mermaid mounted with NO config) inside
 *      the same dark container reproduces the report exactly — light #ECECFF
 *      fill with the white <p> — so section 1's assertions can detect the bug
 *      they claim to fix
 *
 * No Electron, no LLM, no extension: a plain page and stubbed bridges, so this
 * cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-mermaid-dark.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-mermaid-dark-')), 'harness.js')

// App.tsx's layering: base reset first, then the two theme families — the class
// on the container picks one.
const BASE_CSS = readFileSync('node_modules/@ant-design/x-markdown/es/XMarkdown/index.css', 'utf8')
const THEME_LIGHT = readFileSync('node_modules/@ant-design/x-markdown/themes/light.css', 'utf8')
const THEME_DARK = readFileSync('node_modules/@ant-design/x-markdown/themes/dark.css', 'utf8')

const CODE = 'flowchart TD\n  A[开始] --> B[处理数据]\n  B --> C[结束]'

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme as antdTheme } from 'antd'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { setThemeMode, useThemeMode } from './src/renderer/src/theme/mode'
import { CodeBlock } from './src/renderer/src/components/chat/CodeBlock'
import MermaidNoConfig from '@ant-design/x/es/mermaid/Mermaid'

installThemeVars()

const CODE = ${JSON.stringify(CODE)}
const CASE = window.__CASE

function MarkdownCase() {
  const mode = useThemeMode()
  const dark = mode === 'dark'
  applyThemeAttr(mode)
  return (
    <ConfigProvider theme={{ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      <div
        className={dark ? 'x-markdown-dark' : 'x-markdown-light'}
        style={{ background: dark ? '#1f1f1f' : '#ffffff', color: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)', padding: 16, width: 800 }}
      >
        <XMarkdown content={'\\\`\\\`\\\`mermaid\\n' + CODE + '\\n\\\`\\\`\\\`'} components={{ code: CodeBlock }} />
      </div>
    </ConfigProvider>
  )
}
import XMarkdown from '@ant-design/x-markdown'

// The reverted shape: the component as CodeBlock mounted it before the fix —
// no config, so the package's own \`theme: 'default'\` initialize stands.
function RawNoConfigCase() {
  applyThemeAttr('dark')
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <div className="x-markdown-dark" style={{ background: '#1f1f1f', color: 'rgba(255,255,255,0.85)', padding: 16, width: 800 }}>
        <MermaidNoConfig>{CODE}</MermaidNoConfig>
      </div>
    </ConfigProvider>
  )
}

if (CASE === 'codeblock') {
  setThemeMode('dark')
  createRoot(document.getElementById('root')).render(<MarkdownCase />)
} else {
  createRoot(document.getElementById('root')).render(<RawNoConfigCase />)
}
window.__setThemeMode = setThemeMode
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
  // antd's look comes from cssinjs at render time; the markdown sheets the import
  // graph reaches are loaded explicitly below, in App.tsx's order.
  loader: { '.css': 'text', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning',
  treeShaking: false,
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const PAGE = `<!doctype html><html><head><style>${BASE_CSS}</style><style>${THEME_LIGHT}</style><style>${THEME_DARK}</style></head><body style="margin:0"><div id="root"></div></body></html>`

function channels(color) {
  const m = color.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => parseFloat(s))
  return { r, g, b, a }
}
const isLight = (c) => c && c.a > 0.7 && c.r > 140 && c.g > 140 && c.b > 140
const isDark = (c) => c && c.a > 0.7 && c.r < 110 && c.g < 110 && c.b < 110

async function measure(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.ant-mermaid')
    const rect = root.querySelector('g.node rect')
    // Every ink inside a node label: the span mermaid styles AND the <p> the
    // app's theme CSS owns — the white paint of the report.
    const inks = [...new Set([...root.querySelectorAll('.nodeLabel, .nodeLabel p')].map((el) => getComputedStyle(el).color))]
    return {
      fill: getComputedStyle(rect).fill,
      inks,
    }
  })
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })

async function loadPage(caseId) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on('pageerror', (err) => console.log('  [page error]', err.message))
  await page.route('http://pm-mermaid.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
  await page.goto('http://pm-mermaid.local/')
  await page.evaluate((c) => {
    window.__CASE = c
  }, caseId)
  await page.addScriptTag({ path: OUT })
  await page.waitForFunction('window.__ready === true')
  await page.waitForSelector('.nodeLabel', { timeout: 20000 })
  await page.waitForTimeout(600)
  return page
}

console.log('§1 dark mode, production CodeBlock (config rides useThemeMode)')
{
  const page = await loadPage('codeblock')
  const m = await measure(page)
  const fill = channels(m.fill)
  check('node fill is dark', isDark(fill), m.fill)
  check('every node-label ink is light (span + the app-owned <p>)', m.inks.length > 0 && m.inks.every((c) => isLight(channels(c))), m.inks.join(' | '))

  console.log('§2 a real setThemeMode flip re-renders the diagram to the light theme')
  await page.evaluate(() => window.__setThemeMode('light'))
  await page.waitForTimeout(1500)
  const m2 = await measure(page)
  check('fill returns to the default #ECECFF', m2.fill === 'rgb(236, 236, 255)', m2.fill)
  check('inks return to dark', m2.inks.length > 0 && m2.inks.every((c) => isDark(channels(c))), m2.inks.join(' | '))
  await page.close()
}

console.log('§3 non-vacuity: the reverted shape (no config) shows the reported bug')
{
  const page = await loadPage('nocfg')
  const m = await measure(page)
  const fill = channels(m.fill)
  const whiteP = m.inks.some((c) => {
    const ch = channels(c)
    return ch && ch.a > 0.7 && ch.r > 200 && ch.g > 200 && ch.b > 200
  })
  check('fill is the light #ECECFF the report describes', m.fill === 'rgb(236, 236, 255)', m.fill)
  check('an ink is white (the app theme <p>)', whiteP, m.inks.join(' | '))
  check('section 1 would fail on this shape', !isDark(fill) && !m.inks.every((c) => isLight(channels(c))))
  await page.screenshot({ path: join(tmpdir(), 'pm-mermaid-dark-bug.png'), fullPage: true })
  await page.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(failed.length === 0 ? `\nALL ${results.length} PASS` : `\n${failed.length}/${results.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
