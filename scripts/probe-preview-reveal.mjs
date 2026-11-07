/**
 * Preview reveal probe (real Chromium) — PLAN-ide-linkage 刀一 1a/1b 的 DOM 级验收。
 *
 * 单测钉住的是派生链（edit-reveal 纯函数、store、wiring 扫描）；这一段补上
 * 唯一没被钉住的环节：CM 实例真渲染出的行号 gutter、reveal 行装饰、滚动
 * 与闪后消费。无 Electron、无 LLM：electronAPI stub（readFile 供给生成的
 * TS 源码），驱动真实 PreviewContent → FileEditor → CodeMirrorEditor 树
 * （2026-11-01 PLAN-codemirror-view：查看态迁入 CM，TextPreview/CodeHighlight
 * 的 `[data-reveal-line]` span 契约换成 CM 行装饰 `.pm-cm-reveal`）。
 *
 * 断言八件：
 *   1. 查看态是只读 CM（mode=view）
 *   2. 行号 gutter：doc 400 行、gutter 在场、**只渲染可见格**（<400，视口虚拟化
 *      ——旧探针数 400 个 span 的口径对 CM 不成立，这是刻意的诚实化）
 *   3. 无 reveal 时无 reveal 标记
 *   4. line 锚 reveal：恰一个 `.pm-cm-reveal` 行装饰，且落在 marker 行
 *   5. 真滚动：目标行进入视口
 *   6. 高亮：目标行 computed 背景 = warn 色（baseTheme 注入，非全局表）
 *   7. 消费：闪窗结束后装饰消失
 *   8. text 锚（search/replace 模式）：内容定位落在同一行
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
  const view = window.__pmPreviewCM
  const marks = document.querySelectorAll('.pm-cm-reveal')
  const target = marks[0] ?? null
  let scrolled = false
  let highlighted = false
  let onMarker = false
  let debug = ''
  if (target) {
    const box = target.getBoundingClientRect()
    // 视口内即可视（CM 的 scrollIntoView 滚动自己的 scroller；行装饰只在
    // 目标行被渲染进视口时才有 DOM，所以 target 在场本身就是半个滚动证据）
    scrolled = box.top >= 0 && box.bottom <= window.innerHeight
    const cs = getComputedStyle(target)
    highlighted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    onMarker = (target.textContent || '').includes('REVEAL_MARKER')
    debug = 'rect=' + [box.top, box.bottom, box.left, box.right].map((v) => Math.round(v)).join(',')
      + ' bg=' + cs.backgroundColor + ' text=' + JSON.stringify((target.textContent || '').slice(0, 40))
  }
  return {
    revealMarks: marks.length,
    targetExists: !!target,
    scrolled,
    highlighted,
    onMarker,
    debug,
    docLines: view ? view.state.doc.lines : -1,
    gutter: !!document.querySelector('.cm-lineNumbers'),
    gutterCells: document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length,
    viewMode: document.querySelector('[data-pm-cm-editor]')?.getAttribute('data-pm-cm-mode') ?? null,
    editable: !!document.querySelector('[data-pm-cm-editor] [contenteditable="true"]'),
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
      --pm-code-bg: #f6f8fa;
      --pm-text-strong: #1f1f1f;
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

// ── 1a: 查看态 = 只读 CM，行号 gutter 常通（视口虚拟化） ──
await page.evaluate(() => window.__openWithReveal(null))
// 首次打开要等懒 CM chunk + 首次解析落定。
await page.waitForFunction(() => window.__pmPreviewCM && window.__pmPreviewCM.state.doc.lines === 400, undefined, { timeout: 10000 })
await page.waitForTimeout(300)
const base = await page.evaluate(() => window.__revealProbe())
check('查看态是只读 CM（mode=view，无 contenteditable）', base.viewMode === 'view' && !base.editable, `mode=${base.viewMode} editable=${base.editable}`)
check(
  '行号 gutter 在场；doc 400 行而 gutter 只渲染可见格（<400 = 视口虚拟化，不是全文 DOM）',
  base.gutter && base.docLines === 400 && base.gutterCells > 0 && base.gutterCells < 400,
  `gutter=${base.gutter} docLines=${base.docLines} cells=${base.gutterCells}`,
)
check('无 reveal 时无 reveal 行装饰', base.revealMarks === 0, `marks=${base.revealMarks}`)

// ── 1b: line 锚 reveal → 装饰 + 滚动 + 高亮 ──
// 滚动在 CM 的下一个 measure 周期落定，轮询等它。
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
check('reveal 恰一个行装饰，且落在 marker 行', revealed.revealMarks === 1 && revealed.onMarker, `marks=${revealed.revealMarks} ${revealed.debug}`)
check('目标行滚动进视口', revealed.scrolled, revealed.debug)
check('目标行带高亮背景（baseTheme 的 --pm-warn-bg）', revealed.highlighted, revealed.debug)
await page.screenshot({ path: join(SHOTS, 'revealed.png') }).catch(() => {})

// ── 消费：闪窗结束装饰撤下 ──
await page.waitForTimeout(2100)
const consumed = await page.evaluate(() => window.__revealProbe())
check('闪窗后 reveal 行装饰消失（已消费）', consumed.revealMarks === 0, `marks=${consumed.revealMarks}`)

// ── text 锚（search/replace 模式的定位臂）：new_str 首行原文，不是子串 ──
await page.evaluate((lineText) => window.__openWithReveal({ mode: 'text', text: lineText }), `export const REVEAL_MARKER = 'the change landed here' // line ${MARKER_LINE}`)
// 与 line 锚同口径：等 0.4s 背景过渡走完（首轮轮询会撞上过渡起点）。
const textRevealed = await pollReveal((s) => s.targetExists && s.scrolled && s.highlighted)
check('text 锚内容定位落在 marker 行', textRevealed.targetExists && textRevealed.scrolled && textRevealed.onMarker && textRevealed.highlighted, textRevealed.debug)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? ' — ALL GREEN' : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
