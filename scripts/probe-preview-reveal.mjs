/**
 * Preview reveal probe (real Chromium) — PLAN-ide-linkage 刀一 1a/1b 的 DOM 级验收。
 *
 * 单测钉住的是派生链（edit-reveal 纯函数、store、wiring 扫描）；这一段补上
 * 唯一没被钉住的环节：CodeHighlight 真渲染出的行号、reveal 行 span、滚动
 * 与闪后消费。无 Electron、无 LLM：electronAPI stub（readFile 供给生成的
 * TS 源码），驱动真实 PreviewContent → TextPreview → CodeHighlight 树。
 *
 * 断言五件：
 *   1. 行号渲染（.react-syntax-highlighter-line-number 数 = 行数）
 *   2. line 锚 reveal：data-reveal-line 出现且带高亮背景
 *   3. 真滚动：目标行进入预览滚动容器的可视区
 *   4. 消费：闪窗结束后 data-reveal-line 全部消失（快渲染路径恢复）
 *   5. text 锚（search/replace 模式）：内容定位落在同一行
 *
 * Usage: node scripts/probe-preview-reveal.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-reveal-probe-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-reveal-shots')
const CONV_KEY = 'conv_20261030100000'
const WS = '/pm-probe-ws'
const TS_PATH = `${WS}/pipeline.ts`
const MARKER_LINE = 300

/** ~400 行 TS：每行自带行号注释，第 300 行是唯一 marker（text 锚的目标）。 */
function tsSource() {
  const lines = []
  for (let i = 1; i <= 400; i++) {
    lines.push(
      i === MARKER_LINE
        ? `export const REVEAL_MARKER = 'the change landed here' // line ${i}`
        : `export const filler_${i}: number = ${i} // padding line to give the file real height`,
    )
  }
  return lines.join('\n')
}
const TS = tsSource()

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'

const CONV_KEY = '${CONV_KEY}'
const WS = '${WS}'
const TS_PATH = '${TS_PATH}'

let root = null
const mount = (node) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <SettingsProvider>
        <TranslationProvider initialLocale="zh">{node}</TranslationProvider>
      </SettingsProvider>
    </ConfigProvider>
  )
}

const text = (id, role, s) => ({ id, role, contentBlocks: [{ type: 'text', text: s }], createdAt: '2026-10-30T10:00:00.000Z' })
const MESSAGES = Array.from({ length: 4 }, (_, i) => text('m' + i, i % 2 ? 'assistant' : 'user', '占位消息 ' + i))

function Harness() {
  return (
    <AppLayout
      conversations={[]}
      activeConversationKey=""
      totalSessions={0}
      autoCleanup={true}
      onCreateNew={() => {}}
      onDeleteConversation={() => {}}
      onRenameConversation={() => {}}
      onSelectConversation={() => {}}
      onTogglePinConversation={() => {}}
    >
      <ChatView
        messages={MESSAGES}
        conversationId={CONV_KEY}
        workspaceDir={WS}
        conversations={[]}
        isRequesting={false}
        agentStatus={{ status: 'idle' }}
        streamingBlocks={[]}
        hasApiKey={true}
        onSendMessage={() => {}}
        onCancel={() => {}}
        onApproveTool={() => {}}
        onRejectTool={() => {}}
        onClearError={() => {}}
      />
    </AppLayout>
  )
}
mount(<Harness />)

window.__openWithReveal = (target) => {
  const store = usePreviewPaneStore.getState()
  store.openFile(CONV_KEY, TS_PATH)
  if (target) store.requestReveal(TS_PATH, target)
  return true
}
window.__revealProbe = () => {
  const spans = document.querySelectorAll('[data-reveal-line]')
  const target = document.querySelector('[data-reveal-line="${MARKER_LINE}"]')
  let scrolled = false
  let highlighted = false
  let debug = ''
  if (target) {
    const box = target.getBoundingClientRect()
    // 视口内即可视（scrollIntoView 会滚动每一个滚动祖先；容器归属不再手猜）
    scrolled = box.top >= 0 && box.bottom <= window.innerHeight
    const cs = getComputedStyle(target)
    highlighted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    debug = 'attr=' + target.getAttribute('data-reveal-line')
      + ' rect=' + [box.top, box.bottom, box.left, box.right].map((v) => Math.round(v)).join(',')
      + ' scrollW=' + target.scrollWidth + ' clientW=' + target.clientWidth
      + ' bg=' + cs.backgroundColor + ' display=' + cs.display
  }
  return {
    revealSpans: spans.length,
    targetExists: !!target,
    scrolled,
    highlighted,
    debug,
    lineNumbers: document.querySelectorAll('.react-syntax-highlighter-line-number').length,
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

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
await page.route('http://pm-probe.local/**', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><style>
    /* The harness mounts components without the app's global stylesheet, so
       the theme tokens the preview surfaces read must be stubbed here. */
    :root {
      --pm-warn-bg: #fff7e6;
      --pm-success: #52c41a;
      --pm-error: #f44747;
      --pm-separator-faint: #f0f0f0;
      --pm-bg: #ffffff;
      --pm-text-muted: #8c8c8c;
      --pm-text-quiet: #bfbfbf;
      --pm-text-faint: #d9d9d9;
      --pm-link: #1677ff;
      --pm-ws-created: #1a7f37;
      --pm-ws-modified: #9a6700;
    }
  </style><script>
    window.electronAPI = new Proxy({
      readFile: (p) => Promise.resolve(p.endsWith('.ts') ? (window.__TS_SOURCE ?? '') : 'probe file body'),
      statPath: () => Promise.resolve(null),
      updateMessageMetadata: () => Promise.resolve(undefined)
    }, {
      get: (target, key) => key in target
        ? target[key]
        : key === 'getWindowControls' ? () => ({ side: 'left', inset: 70 })
        : key === 'getPlatformInfo' ? () => Promise.resolve({ platform: 'darwin' })
        : key === 'getSettings' ? () => Promise.resolve({
            activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '', yourName: '',
            workspaceDir: '', autoCleanup: true, locale: 'zh',
          })
        : /[Ll]ist$/.test(key) ? () => Promise.resolve([])
        : /^on[A-Z]/.test(key) ? () => () => {}
        : () => Promise.resolve(undefined)
    })
  </script></head><body style="margin:0"><div id="root"></div></body></html>`,
}))
await page.goto('http://pm-probe.local/')
await page.evaluate((src) => { window.__TS_SOURCE = src }, TS)
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForTimeout(400)

// ── 1a: 行号随预览常通行号渲染 ──
await page.evaluate(() => window.__openWithReveal(null))
await page.waitForTimeout(900)
const base = await page.evaluate(() => window.__revealProbe())
check('行号渲染（400 行文件 400 个行号 span）', base.lineNumbers === 400, `lineNumbers=${base.lineNumbers}`)
check('无 reveal 时无 reveal span（快渲染路径）', base.revealSpans === 0, `revealSpans=${base.revealSpans}`)

// ── 1b: line 锚 reveal → 渲染 + 滚动 + 高亮 ──
// 滚动在 wrapLines 重排（400 行逐行 span + 重令牌化）之后才落定，轮询等它。
async function pollReveal(need) {
  for (let i = 0; i < 10; i++) {
    const state = await page.evaluate(() => window.__revealProbe())
    if (need(state)) return state
    await page.waitForTimeout(200)
  }
  return page.evaluate(() => window.__revealProbe())
}

await page.evaluate((n) => window.__openWithReveal({ mode: 'line', line: n }), MARKER_LINE)
const revealed = await pollReveal((s) => s.targetExists && s.scrolled && s.highlighted)
check('reveal 行 span 出现（wrapLines 窗口）', revealed.revealSpans === 400, `spans=${revealed.revealSpans}`)
check('目标行滚动进视口', revealed.scrolled, revealed.debug)
check('目标行带高亮背景', revealed.highlighted, revealed.debug)
await page.screenshot({ path: join(SHOTS, 'revealed.png') })

// ── 消费：闪窗结束回到快路径 ──
await page.waitForTimeout(2100)
const consumed = await page.evaluate(() => window.__revealProbe())
check('闪窗后 reveal span 全部消失（已消费）', consumed.revealSpans === 0, `spans=${consumed.revealSpans}`)

// ── text 锚（search/replace 模式的定位臂）：new_str 首行原文，不是子串 ──
await page.evaluate((lineText) => window.__openWithReveal({ mode: 'text', text: lineText }), `export const REVEAL_MARKER = 'the change landed here' // line ${MARKER_LINE}`)
const textRevealed = await pollReveal((s) => s.targetExists)
check('text 锚内容定位落在 marker 行', textRevealed.targetExists && textRevealed.scrolled, textRevealed.debug)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? ' — ALL GREEN' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
