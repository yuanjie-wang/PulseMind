/**
 * Dark-mode theme probe (real Chromium).
 *
 * PLAN-dark-mode M2-T1 moved the markdown theme out of the settings pages and
 * into App.tsx, where BOTH families are imported once and the container's class
 * picks one (theme/mode.ts). Two facts about that move cannot be read off the
 * source:
 *
 *   1. **The layer order decides `li`'s margins, and the move flipped it.**
 *      Vite emits the imported stylesheets in import order; the theme used to
 *      arrive *after* the base reset (it came in via the settings pages, deep in
 *      the graph) and the naive hoist made it arrive *before*. The two layers
 *      declare the same custom properties, and on `li` they declare the property
 *      itself at equal specificity — theme `.x-markdown-light li { margin:
 *      var(--margin-block) }` vs base `.x-markdown li { margin: var(--margin-li) }`
 *      — so source order picked the winner: measured 14px of air between list
 *      items with the base first, 3.5px with the theme first. App.tsx now imports
 *      the base explicitly, first, and §1.3 brackets the two orders to prove it.
 *   2. **What light mode actually computes.** The pre-dark-mode app is the
 *      contract; the probe freezes the light vector and requires the dark switch
 *      to change colors and *only* colors.
 *
 * The whole point is that reading the CSS is not evidence — the desktop's theme
 * class sits on an ancestor div while the base reset declares its own variables
 * on the `.x-markdown` root, so the *nearer* declaration wins and several of the
 * theme's values are dead in this app (measured below, §1.6). Only a real
 * cascade can say which.
 *
 * Sections:
 *   1. the two theme sheets are in the bundle, the base layer precedes them, and
 *      that order is the pre-dark-mode one — verified by appending each family in
 *      turn: the theme appended changes nothing (it is the order we already have),
 *      the base appended changes exactly `li`'s margins (the order the accidental
 *      hoist produced), and a deliberately-modified sheet must move the vector, so
 *      a broken read cannot pass vacuously
 *   2. the frozen light vector — the pre-dark-mode app, item by item
 *   3. the dark flip: class, attribute, colors, and geometry unchanged
 *   4. non-vacuity: the class name IS the switch, the `--pm-*` sheet IS the source
 *      of the migrated values, and light → dark → light round-trips exactly
 *   5. the message layer (M2/T2): every surface the migration moved onto
 *      `var(--pm-*)` reads, in both modes, the value it had before — read in the
 *      two states the transcript actually has (collapsed: the approval area on
 *      the segment, no tool cards; expanded: the cards, the pair inside the held
 *      one), with the geometry required to be identical across the flip and the
 *      sheet removed to prove the readings come from it
 *   6. the input layer (M2/T3): the composer card, the send circle in both its
 *      states, the 授权/模型 footers, the @-popup, the picked-folder and file
 *      chips, the transcript's file chip and the per-turn deliverables card —
 *      same discipline, plus the one role no flat table can carry (the file
 *      chip's gradient, whose hue is data and must survive the flip while the
 *      two tokens mixed into it must not)
 *   7. the ChatView surroundings (M2/T4): the welcome page's ground and the chat
 *      ground, the logo (inverted by `filter`), the no-API-key box, the plan
 *      strip, the retry banner (including its spinner's mode-independent
 *      stroke), the error box, the loop-limit prompt, the paused-execution
 *      strip, the starter-prompt pill, the context ring and the empty
 *      transcript's hint — with the pill's hover and the ring's hover disc
 *      driven by a real mouse, since both are written by handlers rather than
 *      by the sheet alone
 *   8. the code highlighter (M2/T5): the one migrated surface split across two
 *      mechanisms — the card is CSS (`--pm-code-bg`) and the tokens are Prism's
 *      JS theme — so the light column, the dark column, the measured split
 *      (remove the sheet: only the card moves) and the chat's own fenced block
 *      each get their own evidence, and the measured colours are required to BE
 *      oneLight/oneDark's own values
 *   9. the deletion control (M2/T6): the same sheet with its `[data-theme='dark']`
 *      section cut out, installed while the attribute still reads dark — every
 *      dark reading above must fall back to its light value, and the one JS-side
 *      reading (the Prism tokens) must not move at all
 *  10. the shell's own surfaces (M3/T0): the real AppLayout — sider, gradient
 *      background and its edge, title/version, nav buttons, the 对话/项目 pill,
 *      its actions, the conversation and project rows, the bottom icon row, the
 *      header and the chat ground — plus the surfaces the shell opens (the ⌘K
 *      palette, the search center, the usage center's CenteredPage, the project
 *      modal, the error boundary's fallback and the editor-layout trio). Three
 *      kinds of evidence, because the three kinds of surface fail differently:
 *      (a) flat-ground roles are analytic — the declared role against the
 *      declared ground, with a contrast floor and a dark-vs-light no-regression
 *      guard; (b) translucent roles (hover/veil) sit over the *gradient* sidebar,
 *      so the ground is a measured pixel from a real screenshot and only the fold
 *      is arithmetic; (c) token-borne surfaces (the Sider's border, the header's
 *      fill, the modal's paper, the palette's active row) must move with antd's
 *      own algorithm rather than with the sheet, and are required to *not* follow
 *      it when the sheet's dark section is cut — the half of the boundary §9
 *      cannot see. §10.6 pins the one surface the ALIAS tokens paint directly —
 *      the Dropdown's selected row (the 项目 sort popup; the composer's 授权 and
 *      the Table filter dropdown share the sheet), which the ink primary used to
 *      render black-on-#404040 in light — value pins per mode plus a var-follow
 *      control proving the binding.
 *  15. the workbench shell (post-M4 fix): WorkbenchPane's frame and tool-tab
 *      strip — the side window the user reported as still light in dark mode —
 *      plus the workspace tree's path bar/row buttons and the text editor's
 *      ground, the two literals in the same window. §14's discipline: role
 *      readings in both passes, the flip check, and the cut control.
 *  17. the knowledge table's selection paints: the two antd paints that derive
 *      from the ink primary and break on it — the Table's selected row
 *      (controlItemBgActive, a charcoal stripe in light) and the checkbox's
 *      colorWhite tick (white on the near-white dark primary) — read off the
 *      real KnowledgePanel with a real click, plus the batch bar the selection
 *      summons. Token-borne, so exact values and no cut control.
 *
 * Build note: unlike every other probe in this repo, this one compiles CSS
 * (`loader: {'.css': 'css'}`) and loads the emitted stylesheet into the page.
 * The others load `.css` as inert text — which is why migrating class names
 * could not break them, and why none of them could ever check a color.
 *
 * No Electron, no LLM, no extension: a stubbed `window.electronAPI` and a plain
 * page, so this cannot touch a real PulseMind session.
 *
 * Usage: node scripts/probe-theme-dark.mjs [--headed] [--dump]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// §14 builds its preview fixtures Node-side with the SAME libraries the real
// renderers parse with (probe-xlsx/pptx-preview's recipe): a workbook from
// exceljs, a deck from pptxgenjs, a hand-zipped docx and a handcrafted PDF.
import ExcelJS from 'exceljs'
import pptxgen from 'pptxgenjs'
import { zipSync, strToU8 } from 'fflate'
// §10 is the one section that judges a *composite*: the shell's hover/veil roles
// are translucent fills, and their visible result depends on the surface under
// them — a gradient no CSS read can hand back. sharp decodes the screenshot the
// probe takes anyway, so the ground is a measured pixel and the composite is
// arithmetic over it (see §10.5). Nothing else in this probe needs an image lib.
import sharp from 'sharp'

// The two property groups the vector is built from. Node scope on purpose: the
// harness reads them by interpolation and the checks below re-use LAYOUT to prove
// a mode flip moves no geometry.
const INK = ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'borderBottomColor', 'boxShadow']
const LAYOUT = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'display', 'overflowX', 'fontSize', 'lineHeight', 'fontWeight', 'borderRadius', 'borderTopWidth', 'borderLeftWidth', 'borderCollapse']
// The input layer's own ink group: wider than the message layer's — it carries
// backgroundImage (the file chip's gradient, which no flat color can express)
// and all four borders. Interpolated into the harness like LAYOUT, so §6's
// checks and the reading they judge cannot drift apart.
const INK_FULL = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'boxShadow']
// §7's own group: INK_FULL plus the two properties that only exist on its
// surfaces — `filter` (the welcome logo is a black PNG and dark inverts it) and
// `stroke` (the retry spinner's ring, the context ring's two arcs). Kept apart
// from INK_FULL on purpose: §6's vector is a measured baseline, and widening it
// would silently change what "the input layer's ink" means.
const INK_CHROME = [...INK_FULL, 'filter', 'stroke']
// §8's own group: INK_FULL plus `textShadow`, which only one of the two Prism
// themes declares (oneDark carries `0 1px rgba(0, 0, 0, 0.3)` on the card, and
// `text-shadow` inherits into the code inside it). Kept apart for the same
// reason as INK_CHROME: the other sections' vectors are measured baselines.
const INK_CODE = [...INK_FULL, 'textShadow']

const DIR = mkdtempSync(join(tmpdir(), 'pm-theme-dark-'))
const OUT = join(DIR, 'harness.js')
const OUT_CSS = join(DIR, 'harness.css')
// §14: esbuild has no ?url idiom (probe-pdf-preview's recipe) — alias the
// Vite-style worker import to a shim naming the URL the route table below
// serves the real worker file at.
const WORKER_SHIM = join(DIR, 'worker-url-shim.mjs')
writeFileSync(WORKER_SHIM, 'export default window.location.origin + "/pdf.worker.min.mjs"\n')

// ── §14's preview fixtures (base64 for the bridge stub) ──────────────────────
// xlsx: a styled A1 (data fill the probe pins as mode-independent), a plain
// cell (its ink is --pm-sheet-ink — the whole point of that role) and a
// formula cell (the kind tint that must NOT move with the mode).
const xlsxWb = new ExcelJS.Workbook()
const xlsxWs = xlsxWb.addWorksheet('数据')
xlsxWs.getCell('A1').value = '标题'
xlsxWs.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
xlsxWs.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
xlsxWs.getCell('B2').value = '总计'
// A result-LESS formula: only that shape gets the purple formula kind (a
// cached result renders as a plain value by design — shared/preview/xlsx.ts).
xlsxWs.getCell('C3').value = { formula: 'NOPE()' }
const XLSX_B64 = Buffer.from(await xlsxWb.xlsx.writeBuffer()).toString('base64')

// pptx: one slide, no explicit background → the model's `?? '#FFFFFF'` paper.
const deck = new pptxgen()
const slide1 = deck.addSlide()
slide1.addText('深色检查', { x: 1, y: 0.8, w: 8, h: 1, fontSize: 40, bold: true, color: '1F3864', align: 'center' })
const PPTX_B64 = Buffer.from(await deck.write({ outputType: 'nodebuffer' })).toString('base64')

// docx: the three parts docx-preview needs; one plain paragraph.
const DOCX_B64 = Buffer.from(
  zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>dark check</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
    ),
  })
).toString('base64')

// pdf: one page, one Helvetica text run — the same handcraft probe-pdf-preview
// uses, so pdf.js parses it without a Node pdf library.
function buildMinimalPdf() {
  const ascii = (s) => Buffer.from(s, 'latin1')
  const objects = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ]
  const content = 'BT /F1 24 Tf 20 100 Td (dark check) Tj ET'
  objects.push(Buffer.concat([ascii(`<< /Length ${content.length} >>\nstream\n`), ascii(content), ascii('\nendstream')]))
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  let pos = chunks[0].length
  const offsets = []
  for (let n = 1; n <= objects.length; n++) {
    offsets[n] = pos
    const body = Buffer.concat([ascii(`${n} 0 obj\n`), objects[n - 1], ascii('\nendobj\n')])
    chunks.push(body)
    pos += body.length
  }
  const xrefStart = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= objects.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  chunks.push(ascii(xref))
  return Buffer.concat(chunks)
}
const PDF_B64 = buildMinimalPdf().toString('base64')

// ── the pre-module init script ────────────────────────────────────────────────
// Runs before the bundle is even parsed, which is the only place early enough for
// AppLayout's module-scope read of window.electronAPI (§10); every earlier section
// mounts components whose stubs are read during render and would not care.
const INIT_SCRIPT = `
const PM_EXPERTS = [
  { id: 'expert-writing', name: '写作专家', description: '文案与润色', enabled: true },
  { id: 'expert-code', name: '代码专家', description: '实现与重构', enabled: true },
  { id: 'expert-data', name: '数据分析专家', description: '表格与图表', enabled: true },
]
const PM_BASES = [{ id: 'kb1', name: '产品知识库' }]
// The welcome band (§7 mounts the real ChatView) maps over four lists on mount,
// and an undefined there throws before the logo ever renders. Empty is the
// honest fixture: the band's cards each have an empty state of their own. §10
// flips projectList per phase through window.__pmProjects — its default stays []
// so §7's welcome band keeps the exact fixture it was written against.
window.__pmProjects = []
// §14's preview fixtures ride the same per-test override pattern: the bridge
// hands back the bytes/injection made before __mountT4(). The inits here are
// inert for §1–§13 — nothing earlier calls these three.
window.__pmBinaries = {}
window.__pmFiles = {}
const PM_EMPTY_LISTS = ['listConversations', 'routineList', 'routineRuns', 'knowledgeListFiles']
// §10's shell: one complete AppSettings (SettingsProvider calls getSettings() on
// mount and every reader below it assumes the shape — profile lookup, locale,
// projectSortMode) and the four search stores' hits. The search fixtures are not
// empty on purpose: the migrated search rows only exist when a store answered.
const PM_SETTINGS = {
  activeProfileId: 'pm-profile',
  profiles: [{ id: 'pm-profile', name: '探针', provider: 'openai', apiKey: 'sk-probe', baseURL: '', model: 'pm-probe', maxTokens: 4096 }],
  theme: 'light',
  myName: '',
  soul: '',
  yourName: '',
  autoCleanup: false,
  locale: 'zh',
  projectSortMode: 'created'
}
const PM_SEARCH = {
  searchConversationsByKeyword: [
    { id: 'hit-c1', title: '会话命中一', summary: '摘要一' },
    { id: 'hit-c2', title: '会话命中二', summary: null }
  ],
  searchMessagesByKeyword: [
    { conversationId: 'hit-c1', conversationTitle: '会话命中一', role: 'user', snippet: '消息片段' }
  ],
  searchMemories: [{ id: 'mem1', content: '记忆命中', createdAt: '2026-09-20T10:00:00.000Z' }],
  knowledgeSearchContent: [{ id: 'kb-h1', filePath: '/tmp/pm-fixtures/kb.md', title: '知识命中', excerpts: ['摘录一句'] }]
}
window.electronAPI = new Proxy({}, {
  get: (_t, key) => {
    // The subscription shape is the preload's own: register, get an unsubscribe
    // back. Returning the generic promise factory here (the shape used before
    // §10) would hand a Promise to a cleanup function and throw on unmount.
    if (typeof key === 'string' && key.indexOf('on') === 0) {
      // The native menu is the only channel that reaches the palette / search /
      // usage surfaces the way a user does (the accelerator's own path), so its
      // callback is kept: §10 fires it by name and reads whatever it opened.
      if (key === 'onMenuAction') {
        return (cb) => { window.__pmMenu = cb; return () => { window.__pmMenu = null } }
      }
      return () => () => {}
    }
    // __pmHangLists makes a slice stay in flight forever (the skeleton is the
    // loading state, and only a never-resolving promise holds it deterministically).
    if (window.__pmHangLists && key === 'listConversations') return () => new Promise(() => {})
    if (key === 'readFileBinary') return (p) => Promise.resolve((window.__pmBinaries || {})[p] ?? null)
    if (key === 'readFile') return (p) => Promise.resolve((window.__pmFiles || {})[p] ?? null)
    // §15's workspace tree: the dir comes from the preview store, the rows from
    // this table (empty table → an empty listing, still a rendered path bar).
    if (key === 'listDir') return (dir) => Promise.resolve((window.__pmListDir || {})[dir] ?? { entries: [] })
    if (key === 'getFileStat') return () => Promise.resolve({ size: 1234, mtime: '2026-09-20T08:00:00.000Z' })
    return (arg) => Promise.resolve(
      key === 'expertList' ? PM_EXPERTS
        : key === 'knowledgeListBases' ? PM_BASES
          : key === 'getSettings' ? PM_SETTINGS
            : key === 'getWindowControls' ? { side: 'right', inset: 0 }
              : key === 'projectList' ? (window.__pmProjects || [])
                : key === 'projectValidateDir' ? (window.__pmDirResult || { ok: true })
                  : key === 'getConversationLastUserMessage' ? ((window.__pmQuotes || {})[arg] ?? null)
      : key === 'showOpenDialog'
        ? { canceled: false, filePaths: [arg && arg.properties && arg.properties.indexOf('openDirectory') >= 0 ? '/tmp/pm-fixtures/docs' : '/tmp/pm-fixtures/notes.md'] }
        : key === 'knowledgeListAdvanced' ? (() => { const items = window.__pmKnowledgeFiles || []; return { items, total: items.length, page: 1, pageSize: 50 } })()
          : key === 'knowledgeGetStats' ? (() => { const items = window.__pmKnowledgeFiles || []; return { total: items.length, raw: items.filter((f) => f.status === 'raw').length, compiled: items.filter((f) => f.status === 'compiled').length, wikiFileCount: 0 } })()
            : Object.prototype.hasOwnProperty.call(PM_SEARCH, key) ? PM_SEARCH[key]
                        : window.__pmLists && window.__pmLists[key] != null ? window.__pmLists[key]
                          : PM_EMPTY_LISTS.indexOf(key) >= 0 ? []
                            : undefined
    )
  }
})
`

const HARNESS = `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
// The two markdown layers, imported exactly where App.tsx imports them and in
// the same order: the base reset first (explicitly — see App.tsx), then the two
// theme sheets. esbuild emits CSS in import order, so this is what pins §1.2's
// layer order in the harness; swapping these two lines is what reproduces the
// order the hoisted imports produced by accident.
import '@ant-design/x-markdown/es/XMarkdown/index.css'
import '@ant-design/x-markdown/themes/light.css'
import '@ant-design/x-markdown/themes/dark.css'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { TranscriptView } from './src/renderer/src/components/chat/TranscriptView'
import { MessageGroup } from './src/renderer/src/components/chat/MessageGroup'
import { StreamingBlockPreview } from './src/renderer/src/components/chat/StreamingBlockPreview'
import { ThinkingBlockView } from './src/renderer/src/components/chat/ThinkingBlockView'
import { StreamingCursor } from './src/renderer/src/components/chat/StreamingCursor'
import CommandCard from './src/renderer/src/components/terminal/CommandCard'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'
import { buildThemeCss } from './src/renderer/src/theme/palette'
import { setThemeMode, getThemeMode, useThemeMode } from './src/renderer/src/theme/mode'
import { buildAntdTheme } from './src/renderer/src/theme/tokens'
import { InputArea } from './src/renderer/src/components/chat/InputArea'
import { FileChipComponent } from './src/renderer/src/components/chat/FileRefChip'
import { TurnDeliverablesCard } from './src/renderer/src/components/chat/TurnDeliverablesCard'
import ChatView from './src/renderer/src/components/layout/ChatView'
import { ErrorDisplay } from './src/renderer/src/components/chat/ErrorDisplay'
import { ExtensionPrompt, SubAgentStopPrompt } from './src/renderer/src/components/chat/ExtensionPrompt'
import { PromptChip } from './src/renderer/src/components/chat/PromptChip'
import { ContextRing } from './src/renderer/src/components/chat/ContextRing'
import { CodeHighlight, PlainCode } from './src/renderer/src/components/common/CodeHighlight'
// §8 compares the measured token colours against the two themes' own values, so
// the harness imports the same objects CodeHighlight picks between.
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
// §10 — the shell's own surfaces (PLAN-dark-mode M3/T0). The shell mounts the
// real AppLayout, the four sidebar files, the palette, the search center, the
// project modal, the error boundary and the editor-layout trio. What is *not*
// read there is a written-down boundary, not an oversight: the scrollbar
// pseudo-elements (T0 migrated them — \`--pm-scrollbar\` is #d0d0d0 light and
// #3a3a3a dark — but Chromium reports no computed style for
// \`::-webkit-scrollbar-thumb\`, so the probe reads the empty string and says so
// rather than pretending to check it; the VALUES are pinned by
// tests/theme-palette.test.ts, which reads the palette directly),
// \`.centers-switch-btn\` and SettingsPage's \`#fff\`/\`#333\`/\`#f0f0f0\` (T1's
// targets, and the probe never navigates to settings), the ErrorBoundary reload
// button's UA face, and \`.project-row-action:disabled\`, which no fixture can
// reach because the menus it lives in are opened only on hover.
import { App as AntdApp, Radio, theme as themeApi } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AppLayout from './src/renderer/src/components/layout/AppLayout'
import ConversationSidebar from './src/renderer/src/components/layout/ConversationSidebar'
import ProjectSidebarList from './src/renderer/src/components/layout/ProjectSidebarList'
import CenteredPage from './src/renderer/src/components/layout/CenteredPage'
import { SearchView } from './src/renderer/src/components/search/SearchView'
import ErrorBoundary from './src/renderer/src/components/ErrorBoundary'
import { ProjectModal } from './src/renderer/src/components/project/ProjectModal'
import { EDITOR_CHAT_CARD, EDITOR_COLUMN_HEADER, EDITOR_SURFACE } from './src/renderer/src/components/layout/editor-layout'
// §16 — the assistant column the two form editors render (任务助手 / 专家创建助手).
import { FormAssistColumn } from './src/renderer/src/components/form-assist/FormAssistColumn'
// §11 — the welcome band (PLAN-dark-mode M3/T1). Both welcome components read
// the four content stores directly on mount, so the fixtures arrive through the
// INIT stub's __pmLists / __pmQuotes / __pmProjects overrides and the mounts
// are staggered: the data host loads with lists present, the empty host mounts
// after the stub switches to empty + a hung listConversations (its skeleton).
import { WelcomeSuggestions } from './src/renderer/src/components/welcome/WelcomeSuggestions'
import { ProjectCards } from './src/renderer/src/components/welcome/ProjectCards'
// §17 — the knowledge table (the ink-primary selection paints).
import KnowledgePanel from './src/renderer/src/components/knowledge/KnowledgePanel'
import { KnowledgeManager } from './src/renderer/src/knowledge/KnowledgeManager'
// §12 — the workbench + routine surfaces (PLAN-dark-mode M3/T2).
import { PlanGraphView } from './src/renderer/src/components/workbench/PlanGraphView'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'
import { SubAgentSessionView } from './src/renderer/src/components/subagent/SubAgentSessionView'
import { createPlanDag } from './src/shared/plan/graph'
// §13 — capability center / settings page / browser pane chrome (M3/T3–T5).
import CapabilityCenter from './src/renderer/src/components/capability/CapabilityCenter'
import SettingsPage from './src/renderer/src/components/settings/SettingsPage'
import { BrowserPaneChrome } from './src/renderer/src/components/browser/BrowserPaneChrome'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import { useProjectStore } from './src/renderer/src/stores/projectStore'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'
import { useCommandPaletteStore } from './src/renderer/src/stores/commandPaletteStore'
// §14 — the preview pane family (M4/T1–T3): the pane chrome and one mount per
// renderer, the element-edit panel in both of its states, the shared footer
// pieces. MarkdownPreview needs no mount — M2/T2 already reads its class on
// the chat's own wrappers.
import { PreviewPane } from './src/renderer/src/components/preview/PreviewPane'
import { PreviewContent } from './src/renderer/src/components/preview/PreviewContent'
import { XlsxPreview } from './src/renderer/src/components/preview/XlsxPreview'
import { PdfPreview } from './src/renderer/src/components/preview/PdfPreview'
import { DocxPreview } from './src/renderer/src/components/preview/DocxPreview'
import { PptxPreview } from './src/renderer/src/components/preview/PptxPreview'
import { CsvPreview } from './src/renderer/src/components/preview/CsvPreview'
import { FallbackCard } from './src/renderer/src/components/preview/FallbackCard'
import { ElementEditPanel } from './src/renderer/src/components/preview/ElementEditPanel'
import { usePreviewPaneStore } from './src/renderer/src/stores/previewPaneStore'
import { useHtmlEditStore } from './src/renderer/src/stores/htmlEditStore'
// §15 — the workbench shell: WorkbenchPane's own frame and tool-tab strip (the
// surface the preview wave's siblings left behind — the user report that
// started this section), plus the workspace tree's path bar / row buttons and
// the text editor's ground, the two literals in the same window.
import { WorkbenchPane } from './src/renderer/src/components/workbench/WorkbenchPane'
import { WorkspaceTree } from './src/renderer/src/components/workbench/WorkspaceTree'
import { useWorkbenchStore } from './src/renderer/src/stores/workbenchStore'
import { FileEditor } from './src/renderer/src/components/preview/FileEditor'

// main.tsx's boot, in order: the variable sheet, then the attribute.
installThemeVars()
applyThemeAttr('light')

// Three of these answer the input layer (§6) and are inert for the rest: the
// message layer never mounts InputArea, and the expert fixtures only reach the
// @-popup and the bound-expert chip. showOpenDialog is the one the two
// attachment buttons share — answered by their own 'properties' argument, so a
// real click on either mounts its chip (the file/folder chips are part of the
// input layer's colour surface, and no other route reaches them).
//
// They live in the INIT SCRIPT below rather than here: §10 mounts AppLayout,
// whose module body reads window.electronAPI.getWindowControls() at import time,
// and an assignment written in this file can only run after every import has
// been evaluated (the bundle hoists them above all statements — measured: the
// module throws "Cannot read properties of undefined" with the stub in here).

const NOW = '2026-09-20T10:00:00.000Z'
const user = (text) => ({ id: 'u1', role: 'user', contentBlocks: [{ type: 'text', text }], createdAt: NOW })
const assistant = (id, blocks) => ({ id, role: 'assistant', contentBlocks: blocks, createdAt: NOW })

/** One markdown-heavy answer: every element the theme styles. */
const DOC = [
  '# 一级标题',
  '',
  '## 二级标题',
  '',
  '普通段落，带 \\\`行内代码\\\` 与 [链接](https://example.com)。',
  '',
  '- 无序项一',
  '- 无序项二',
  '- 无序项三',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '3. 有序项三',
  '',
  '> 引用一行',
  '',
  '\\\`\\\`\\\`ts',
  'const answer: number = 42',
  'console.log(answer)',
  '\\\`\\\`\\\`',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '---',
  '',
  '收尾段落。',
].join('\\n')

const MESSAGES = [
  user('深色模式检查'),
  assistant('a1', [{ type: 'text', text: DOC }]),
]

/** A live tail: SegmentView's StreamingText carries the migrated inline color. */
const STREAMING = [{ type: 'text', text: '正在输出…' }]

function Harness() {
  // A state bump so the re-render the mode store drives is visible to the probe
  // even if a future React makes external-store updates non-sync.
  const [, bump] = useState(0)
  window.__setMode = (mode) => {
    setThemeMode(mode)
    applyThemeAttr(mode)
    bump((n) => n + 1)
  }
  window.__getMode = () => getThemeMode()
  window.__installVars = installThemeVars
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#000000' } }}>
      <TranslationProvider>
        <div id="chat" style={{ width: 1000, padding: '12px 0', background: '#fff', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={MESSAGES}
            agentStatus={{ status: 'streaming' }}
            streamingBlocks={STREAMING}
            isRequesting
            restoring={false}
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            onKillTool={() => {}}
            onRespondToTool={() => {}}
            onClearError={() => {}}
            onRetry={() => {}}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)

// ── the measuring tape ────────────────────────────────────────────────────────
// Every markdown block the app renders sits under one wrapper div carrying the
// theme class (MessageGroup / SegmentView / StreamingBlockPreview), and the
// package's own root (.x-markdown) is INSIDE it — that nesting is what §1.5
// asserts, because it is what lets the base reset's variables win.
const WRAP_SEL = 'div.x-markdown-light, div.x-markdown-dark'

const INK = ${JSON.stringify(INK)}
const LAYOUT = ${JSON.stringify(LAYOUT)}

window.__wraps = () => document.querySelectorAll(WRAP_SEL).length
window.__wrapInfo = () => {
  const w = document.querySelectorAll(WRAP_SEL)
  return [...w].map((el) => {
    const root = el.querySelector('.x-markdown')
    return {
      cls: el.className,
      hasRoot: !!root,
      rootInside: !!root && el.contains(root) && root !== el,
      // the wrapper's own font-size reaches the root through --font-size: inherit
      rootFontSize: root ? getComputedStyle(root).fontSize : null,
      rootWidth: root ? getComputedStyle(root).width : null,
    }
  })
}

/** The assistant wrapper's whole style vector, keyed by element role. */
window.__vector = () => {
  const wrap = document.querySelectorAll(WRAP_SEL)[1]
  const at = (sel) => wrap.querySelector(sel)
  const read = (sel, props) => {
    const el = at(sel)
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = s[p]
    return o
  }
  const readNth = (sel, nth, props) => {
    const el = wrap.querySelectorAll(sel)[nth]
    if (!el) return null
    const st = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = st[p]
    return o
  }
  const both = (sel, nth = 0) => readNth(sel, nth, [...INK, ...LAYOUT])
  return {
    h2: both('h2'),
    p: both('p'),
    // The SECOND item, not the first: li:first-child pins margin-top to 0 in
    // both orders, so only a middle item shows the tie (§1.3).
    li: both('li', 1),
    liFirst: both('li', 0),
    codeInline: both('p code'),
    pre: both('pre'),
    codeBlock: both('pre code'),
    table: both('table'),
    thead: both('thead'),
    tbody: both('tbody'),
    th: both('th'),
    td: both('td'),
    blockquote: both('blockquote'),
    hr: both('hr'),
  }
}

/** The streaming text wrapper's color — the one migrated to a variable. */
window.__streamColor = () => {
  const wraps = document.querySelectorAll(WRAP_SEL)
  const last = wraps[wraps.length - 1]
  return last ? getComputedStyle(last).color : null
}

/** Appended stylesheet control (section 1's cascade canary). */
window.__appendSheet = (text, id) => {
  const el = document.createElement('style')
  el.id = id
  el.textContent = text
  document.head.appendChild(el)
}
window.__removeSheet = (id) => document.getElementById(id)?.remove()
/** §9's control sheet (M2/T6): buildThemeCss()'s text with its dark-theme
 *  section DELETED — the light block alone, injected under the same id. Cut out
 *  of the real builder's text rather than re-typed, so the control cannot end up
 *  measuring a sheet the app never emits; §9 installs it while the attribute
 *  still reads dark and requires every dark reading to fall back to its light
 *  value. That is the plan's "delete the dark section" control, run in-probe
 *  instead of as a one-off patch of the palette. */
window.__installVarsNoDark = () => {
  const full = buildThemeCss()
  const cut = full.indexOf("[data-theme='dark']")
  const el = document.createElement('style')
  el.id = 'pm-theme-vars'
  el.textContent = cut > 0 ? full.slice(0, cut) : full
  document.head.appendChild(el)
}
/** The exact text of an applied sheet, so §1.1 can look for both families. */
window.__sheetText = () => [...document.styleSheets]
  .map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\\n') } catch { return '' } })
  .join('\\n')
/** Where the theme layer and the base reset sit in the emitted stylesheet. */
window.__layerOrder = () => {
  const text = window.__sheetText()
  const theme = text.indexOf('.x-markdown-dark')
  // the base reset's root rule, which also declares the same variable names
  const base = text.indexOf('--code-inline-text')
  return { theme, base, themeFirst: theme >= 0 && base >= 0 && theme < base }
}
window.__swapClass = (cls) => {
  const w = document.querySelectorAll(WRAP_SEL)[1]
  w.className = cls
  return w.className
}

// ── the message layer (PLAN-dark-mode M2/T2) ─────────────────────────────────
// A second root, mounted on demand. The surfaces that migration touched need a
// held call, a settled call, a folded tool_result, an ask_user card and the
// streaming caret — and mounting them into the markdown harness above would move
// the wrapper count sections 1–4 measure (it is exactly 3 there).
const LAYER_MESSAGES = [
  user('清一下构建目录'),
  assistant('L1', [
    { type: 'thinking', thinking: '先确认这个目录是构建产物，别误删源码。' },
    { type: 'text', text: '这一步会删掉 build/，先确认：' },
    { type: 'tool_use', id: 't1', name: 'exec', status: 'pending', input: { command: 'rm -rf ./build', description: '清理构建目录' } },
    { type: 'tool_use', id: 't2', name: 'write', status: 'completed', exitCode: 0, input: { file_path: 'src/a.ts', content: 'export const a = 1', description: '写入入口文件' }, output: 'wrote src/a.ts' },
  ]),
  // The engine folds a round's tool results into ONE user-role message, so the
  // well is what a user actually sees after a tool call.
  { id: 'r1', role: 'user', contentBlocks: [{ type: 'tool_result', toolUseId: 't2', content: 'wrote src/a.ts' }], createdAt: NOW },
]

/** ask_user is the one card in the terminal family that is *not* a terminal: it
 *  asks a question in the chat's own voice (PLAN-dark-mode M2/T2), so it carries
 *  the message layer's surfaces while every exec/read/write card keeps #1e1e1e.
 *  running and not pending: a pending block with no approve handler is
 *  CommandCard's "still streaming" state, which hides the choices entirely. */
const ASK_USER = { type: 'tool_use', id: 'q1', name: 'ask_user', status: 'running', input: { prompt: '要保留哪一份？', choices: '保留 A,保留 B' } }

/** The folded tool_result well, reached by mounting MessageGroup directly rather
 *  than through the transcript: hasDisplayableContent admits a tool_result only
 *  when it carries imageData, so the results-only message the engine folds a round
 *  into renders nothing live. The two surfaces read here are the component's own
 *  (the pre-migration #f6f8fa on a #e8e8e8 frame), and a direct mount is the only
 *  way to read them. */
const WELL_MSG = {
  id: 'w1',
  role: 'user',
  createdAt: NOW,
  contentBlocks: [
    { type: 'text', text: '结果：' },
    { type: 'tool_result', toolUseId: 't2', content: 'wrote src/a.ts' },
  ],
}

/** The streaming preview: the answer as it arrives, in the two inks the
 *  migration moved — the markdown half (#333) and the tool-name half (#555). */
const STREAM_BLOCKS = [
  { type: 'text', text: '正在写入口文件。' },
  { type: 'tool_use', id: 's1', name: 'write', status: 'pending', input: {} },
]

function LayerHarness() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <TranslationProvider>
        <div id="layer-chat" style={{ width: 1000, padding: '12px 0', background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={LAYER_MESSAGES}
            agentStatus={{ status: 'awaiting_approval' }}
            streamingBlocks={[]}
            isRequesting
            restoring={false}
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            onKillTool={() => {}}
            onRespondToTool={() => {}}
            onClearError={() => {}}
            onRetry={() => {}}
          />
        </div>
        <div data-case="ask-user" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <CommandCard block={ASK_USER} />
        </div>
        <div data-case="thinking" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <ThinkingBlockView block={{ type: 'thinking', thinking: '一行推理。' }} />
        </div>
        <div data-case="cursor" style={{ width: 1000, background: 'var(--pm-bg)' }}>
          <StreamingCursor show />
        </div>
        <div data-case="result-well" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <MessageGroup msg={WELL_MSG} actions="none" onApproveTool={() => {}} onRejectTool={() => {}} onKillTool={() => {}} />
        </div>
        <div data-case="streaming" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <StreamingBlockPreview blocks={STREAM_BLOCKS} />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}
window.__mountLayer = () => {
  const host = document.createElement('div')
  host.id = 'layer'
  document.body.appendChild(host)
  createRoot(host).render(<LayerHarness />)
}

/** Every migrated surface's style vector, keyed by role. Roles that only exist in
 *  one state come back null there: the approval area is *only* mounted while the
 *  segment is collapsed and the tool cards *only* while it is open (that is the
 *  M2.4 "one decision surface at a time" rule), so the two states are read in
 *  turn rather than side by side. */
window.__layerVector = () => {
  const INKP = ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor']
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of [...INKP, ...LAYOUT]) o[p] = s[p]
    return o
  }
  const q = (sel) => document.querySelector(sel)
  const userRow = q('#layer-chat div[style*="justify-content: flex-end"]')
  const head = q('[data-segment-head]')
  // Leaf divs only: the segment header nests the text in a flex wrapper, and the
  // wrapper's textContent is the same string — it comes first in document order
  // and inherits the page's black, which is exactly the reading a wrong element
  // would produce.
  const hint = head
    ? [...head.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === '待批准')
    : null
  const ask = q('[data-case="ask-user"] > div')
  // The ExecutionSegment's expanded body — the frame the cards sit in. Found by
  // walking up from a card to the first ancestor with a real border, because the
  // frame carries no hook of its own and the card's own header has a 1px border
  // too (transparent when nothing is held).
  const framed = (el) => {
    let p = el ? el.parentElement : null
    while (p && p !== document.body) {
      const s = getComputedStyle(p)
      if (s.borderTopWidth === '1px' && s.borderTopStyle === 'solid') return p
      p = p.parentElement
    }
    return null
  }
  return {
    ground: paint(q('#layer-chat')),
    userBubble: paint(userRow ? userRow.firstElementChild : null),
    heldHead: paint(q('[data-tool-head="t1"]')),
    doneHead: paint(q('[data-tool-head="t2"]')),
    expandedFrame: paint(framed(q('[data-tool-head="t1"]'))),
    approvalArea: paint(q('[data-approval-area]')),
    heldHint: paint(hint),
    // The folded tool_result box: the element carrying the pre-migration maxHeight
    // 400, in its own case wrapper (the thinking <pre> has the same maxHeight but
    // belongs to a different case).
    resultWell: paint(q('[data-case="result-well"] div[style*="max-height: 400px"]')),
    askUserCard: paint(ask),
    askUserPrompt: paint(q('[data-case="ask-user"] div[style*="margin-bottom: 12px"]')),
    caret: paint(q('[data-case="cursor"] span')),
    thinkingRoot: paint(q('[data-case="thinking"] > div')),
    streamMd: paint(q('[data-case="streaming"] div[class*="x-markdown"]')),
    // Matched by its text, not by its style attribute: React sets padding: 4px 0
    // and the CSSOM serializes the shorthand back as 4px 0px.
    streamTool: paint(
      [...document.querySelectorAll('[data-case="streaming"] div')].find((d) => d.children.length === 0 && d.textContent.includes('指令生成中'))
    ),
  }
}

/** Where the held pair currently lives — the M2.4 rule read as containment: on
 *  the segment while it is closed, inside the card once it is open, never both.
 *  Kept out of the style vector so that stays homogeneous. */
window.__areaHome = () => {
  const area = document.querySelector('[data-approval-area]')
  const card = document.querySelector('[data-tool-head="t1"]')
  if (!area) return 'none'
  if (!card) return 'segment'
  return card.parentElement.contains(area) ? 'card' : 'segment'
}

// ── the input layer (PLAN-dark-mode M2/T3) ───────────────────────────────────
// A third root, mounted on demand. It carries the real InputArea (both
// approval levels, so the amber 全部允许 button and the grey 按需确认 one are
// read from the same component), the transcript's file/web chips and the
// per-turn deliverables card. The ConfigProvider is the app's OWN builder over
// the resolved mode rather than a pinned token: the send circle's fill IS
// colorPrimary (the composer pins only the disabled case), so a harness that
// hard-coded it would be measuring its own fixture — this is what lets §6 assert
// the dark circle is light ink.
const PM_PROFILE = { id: 'p1', name: '默认模型', provider: 'openai', model: 'gpt-4o', baseURL: '', apiKey: '', maxTokens: 4096 }

const PM_DELIVERABLE = {
  rows: [
    { path: '/tmp/pm-fixtures/notes.md', ops: [{ tool: 'write', at: NOW, ok: true }], lastAt: NOW, fromConvIds: [] },
    {
      path: '/tmp/pm-fixtures/report.xlsx',
      ops: [{ tool: 'xlsx_edit', at: NOW, ok: true }, { tool: 'write', at: NOW, ok: true }],
      lastAt: NOW,
      fromConvIds: ['sub_1'],
    },
  ],
  sources: [{ convId: 'sub_1', title: '子代理一' }],
}

function InputAreaCase({ id, approvalMode }) {
  return (
    <div
      data-case={id}
      id={id === 'input' ? 'input-chat' : undefined}
      style={{ position: 'relative', height: 420, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}
    >
      {/* The chat pane's scroll area: a height:100% in-flow sibling, which is what
          pins the floating composer (and its @-popup anchor) to the pane bottom. */}
      <div style={{ height: '100%' }} />
      <InputArea
        layout="floating"
        isRequesting={false} isStreaming={false} isAwaitingApproval={false} isAwaitingInput={false}
        hasMessages
        onSendMessage={(v) => { window.__inputSent = v }}
        onCancel={() => {}}
        profiles={[PM_PROFILE]}
        activeProfileId="p1"
        onSelectProfile={() => {}}
        boundExpertId="expert-writing"
        approvalMode={approvalMode}
        onChangeApprovalMode={() => {}}
      />
    </div>
  )
}

function InputHarness() {
  // The app's own theme builder, re-run on a mode flip: the send circle's
  // enabled fill and its arrow colour come from the antd theme, not from CSS.
  const mode = useThemeMode()
  return (
    <ConfigProvider theme={buildAntdTheme(mode)}>
      <TranslationProvider>
        <InputAreaCase id="input" approvalMode="always-ask" />
        <InputAreaCase id="input-auto" approvalMode="auto" />
        <div data-case="file-ref" style={{ padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <FileChipComponent dataPath="/tmp/pm-fixtures/notes.md" dataExt="md" dataType="file" dataLetter="M" dataTime="2026-09-20 10:00" />
          <FileChipComponent dataPath="/tmp/pm-fixtures/report.xlsx" dataExt="xlsx" dataType="file" dataLetter="X" dataTime="2026-09-20 10:00" />
        </div>
        <div data-case="turn-card" style={{ width: 1000, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <TurnDeliverablesCard deliverable={PM_DELIVERABLE} workspaceDir="/tmp/pm-fixtures" />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}
window.__mountInput = () => {
  const host = document.createElement('div')
  host.id = 'input-layer'
  document.body.appendChild(host)
  createRoot(host).render(<InputHarness />)
}

/** The chip's hue is the component's own data, so it is read out of the markup
 *  the component wrote — its letter carries an hsla(hue, 30%, …) inline — and
 *  never re-derived here (a copy of extToHue would prove only that the copy
 *  agrees with itself). */
window.__chipHue = (chip) => {
  const letter = chip ? chip.querySelector('[style*="hsla"]') : null
  const m = letter ? /hsla\\((\\d+(?:\\.\\d+)?)/.exec(letter.getAttribute('style') || '') : null
  return m ? Number(m[1]) : null
}

/** A variable's value as the browser resolves it IN THE MODE IN FORCE, read
 *  through a throwaway box rather than from the stylesheet: a literal here would
 *  be the probe asserting its own copy of the palette. */
window.__varColor = (name) => {
  const d = document.createElement('div')
  d.style.background = 'var(' + name + ')'
  document.body.appendChild(d)
  const v = getComputedStyle(d).backgroundColor
  d.remove()
  return v
}

/** The same trick for a role that is not a flat color: --pm-sidebar is a
 *  gradient, so its value only ever appears in backgroundImage and a
 *  backgroundColor read returns transparent for both modes. §10's sider row
 *  compares the element's backgroundImage against this. */
window.__varBg = (name) => {
  const d = document.createElement('div')
  d.style.background = 'var(' + name + ')'
  document.body.appendChild(d)
  const v = getComputedStyle(d).backgroundImage
  d.remove()
  return v
}

/** A role's declared alpha, parsed from its own text rather than written down
 *  here: §10's composite rows fold \`alpha × ground\`, and a literal 0.08 in the
 *  probe would keep passing after the palette moved. Returns null for an opaque
 *  role (rgb, no alpha channel), which is how a row that was supposed to be
 *  translucent but is not gets caught. */
window.__varAlpha = (name) => {
  const v = window.__varColor(name)
  const m = /rgba\\(\\s*[\\d.]+,\\s*[\\d.]+,\\s*[\\d.]+,\\s*([\\d.]+)\\s*\\)/.exec(v || '')
  return m ? Number(m[1]) : null
}

/** One element's ink by selector — for the two hover reads, which happen one
 *  element at a time: a whole-vector read while the pointer is parked on a pill
 *  would also re-measure the transcript and the retry countdown, and the pill's
 *  state is the only thing that changed. */
window.__paintAt = (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const s = getComputedStyle(el)
  return { color: s.color, borderTopColor: s.borderTopColor, backgroundColor: s.backgroundColor }
}

/** The chip paper's recipe, assembled from that hue and the live tokens and
 *  resolved by the browser — the one role a table of flat colors cannot carry.
 *  Built from a formula this probe writes out, so it fails if the component's
 *  own formula changes, while the hue and the colors stay the app's. */
window.__chipGradientExpect = (chip) => {
  const hue = window.__chipHue(chip)
  if (hue == null) return null
  const d = document.createElement('div')
  d.style.background = 'linear-gradient(to right, var(--pm-chip-from), hsl(' + hue + ', 30%, var(--pm-chip-tint-l)))'
  document.body.appendChild(d)
  const v = getComputedStyle(d).backgroundImage
  d.remove()
  return v
}

/** Every migrated surface of the input layer, keyed by role. Read in three
 *  passes because the surfaces arrive at different moments: the resting composer
 *  and the deliverables card are there on mount, the @-popup needs a real
 *  keyboard, and the attachment chips need a real click on the two buttons that
 *  raise the (stubbed) file dialog. */
window.__inputVector = () => {
  const INKP = ${JSON.stringify(INK_FULL)}
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of [...INKP, ...LAYOUT]) o[p] = s[p]
    return o
  }
  const q = (sel) => document.querySelector(sel)
  const within = (caseId, sel) => {
    const root = q('[data-case="' + caseId + '"]')
    return root ? root.querySelector(sel) : null
  }
  const leafByText = (root, text) =>
    root ? [...root.querySelectorAll('div, span')].find((d) => d.children.length === 0 && d.textContent.trim() === text) : null
  /** The three header chips (bound expert, picked folder, picked file) all render
   *  as the same span with an inline border-radius; the icon inside says which.
   *  The footer's pick buttons are button elements, so they cannot match — the two
   *  same-named glyphs live in both places. */
  const chipWith = (icon) =>
    [...(q('#input-chat')?.querySelectorAll('span[style*="border-radius: 12px"]') ?? [])].find((s) =>
      s.querySelector('.anticon-' + icon)
    ) || null
  const chat = q('#input-chat')
  const auto = q('[data-case="input-auto"]')
  const card = q('[data-case="turn-card"]')
  const rows = card ? card.querySelectorAll('[data-testid="turn-deliverables-row"]') : []
  const row = rows[0] || null
  const officeRow = rows[1] || null
  // The model picker is the only title-less button carrying a caret; the 授权
  // button's caret sits next to its label, and that button has a title.
  const modelButton = chat
    ? [...chat.querySelectorAll('.ant-btn')].find((b) => b.querySelector('.anticon-down') && !b.getAttribute('title'))
    : null
  const approvalButton = chat
    ? [...chat.querySelectorAll('.ant-btn')].find((b) => b.getAttribute('title') && b.querySelector('.anticon-down'))
    : null
  const fileChipEl = within('file-ref', 'span[style*="width: 250px"]')
  // 来自 lives on the row a sub-agent contributed to — the xlsx one, whose
  // fromConvIds is non-empty. The md row has no source, by construction.
  const fromSpan = officeRow ? [...officeRow.querySelectorAll('span')].find((s) => s.textContent.indexOf('来自') === 0) : null
  return {
    // the composer card: the glass recipe (--pm-elevated-glass / --pm-shadow-glass)
    // and its edge, which is antd's own colorBorderInput — see the light table.
    sender: paint(chat ? chat.querySelector('.ant-sender') : null),
    // Both states of the send circle, because they have different owners: the
    // DISABLED one is the composer's own pin (--pm-ink), the enabled one is
    // antd's primary fill. They are read from two different composers so that
    // neither can be mistaken for the other: #input-chat has an at-sign typed
    // into it (enabled), input-auto's box is empty (disabled).
    sendDisabled: paint(auto ? auto.querySelector('.pm-send') : null),
    sendEnabled: paint(chat ? chat.querySelector('.pm-send') : null),
    // the 授权 button at the two levels: grey for the gated ones, amber for 全部允许
    approvalGated: paint(chat ? chat.querySelector('button[title$="工具调用审批"]') : null),
    approvalAuto: paint(auto ? auto.querySelector('button[title$="工具调用审批"]') : null),
    // The two carets of the footer, which deliberately differ: the model
    // picker's inherits its button's --pm-text-secondary, the 授权 one carries
    // its own --pm-text-faint.
    modelCaret: paint(modelButton ? modelButton.querySelector('.anticon-down') : null),
    approvalCaret: paint(approvalButton ? approvalButton.querySelector('.anticon-down') : null),
    // the bound-expert chip (--pm-pill / --pm-border-veil-weak) and its icon
    expertChip: paint(chat ? chat.querySelector('[title="文案与润色"]') : null),
    expertIcon: paint(chat ? chat.querySelector('[title="文案与润色"] .anticon-user') : null),
    // the @-popup: box, its legend line, the highlighted row, an expert's blurb
    mentionPopup: paint(q('[data-mention-idx="0"]') ? q('[data-mention-idx="0"]').parentElement : null),
    mentionTitle: paint(leafByText(document, '召唤专家')),
    mentionRowActive: paint(q('[data-mention-idx="0"]')),
    mentionRowIdle: paint(q('[data-mention-idx="1"]')),
    mentionDesc: paint(leafByText(document, '文案与润色')),
    // the picked-folder / picked-file chips in the composer header, --pm-pill-strong
    folderChip: paint(chipWith('folder')),
    folderIcon: paint(chipWith('folder') ? chipWith('folder').querySelector('.anticon-folder') : null),
    fileChipIcon: paint(chipWith('file') ? chipWith('file').querySelector('.anticon-file') : null),
    // the transcript's file chip: the hue gradient, its frame, name and time
    fileChip: paint(fileChipEl),
    fileChipName: paint(fileChipEl ? fileChipEl.querySelector('span[style*="font-weight: 900"]') : null),
    fileChipTime: paint(fileChipEl ? leafByText(fileChipEl, '2026-09-20 10:00') : null),
    // the deliverables card: box, title, count badge, then a row and its badges
    turnCard: paint(card ? card.querySelector('[data-testid="turn-deliverables"]') : null),
    turnTitle: paint(card ? card.querySelector('[data-testid="turn-deliverables"] span[style*="font-weight: 600"]') : null),
    turnBadge: paint(card ? card.querySelector('[data-testid="turn-deliverables"] span[style*="border-radius: 9px"]') : null),
    turnRows: paint(card ? card.querySelector('[data-testid="deliverables-rows"]') : null),
    turnRow: paint(row),
    turnGlyph: paint(row ? row.firstElementChild : null),
    turnOfficeBadge: paint(officeRow ? officeRow.querySelector('span[style*="padding: 1px 6px"]') : null),
    turnOps: paint(row ? row.querySelector('span[style*="gap: 6px"]') : null),
    turnFrom: paint(fromSpan),
    turnPreview: paint(row ? row.querySelector('.pm-dl-preview') : null),
  }
}

// ── 7. the ChatView surroundings (M2/T4) ─────────────────────────────────────
// Two of these surfaces are not components anyone can mount on their own: the
// welcome page's ground and the retry banner live in ChatView's own markup, and
// the plan strip is passed to InputArea as a slot. So the case mounts the REAL
// ChatView twice — once on the welcome branch (no messages, no API key: the
// logo, the info glyph and the amber "configure your key" box), once past it
// with a live plan and a retrying status (both grounds, the strip, the banner).
// The remaining five are ordinary components and are mounted directly.

const PM_PLAN = {
  objective: '整理发布说明',
  version: 2,
  completed: false,
  nodes: [
    { id: 'n1', description: '收集变更', status: 'completed', dependsOn: [] },
    { id: 'n2', description: '撰写文稿', status: 'pending', dependsOn: ['n1'] },
  ],
}
// A long delay on purpose: the banner's countdown is a real 1s interval that
// stops at 0 and unmounts its own span, and this probe reads the vector five
// times. 60s keeps the element present for the whole section.
const PM_RETRY = { status: 'retrying', attempt: 1, maxRetries: 3, delay: 60000 }
const PM_MSGS = [
  user('看看计划'),
  assistant('pa1', [{ type: 'text', text: '好的，已排好两步。' }]),
]

const CHROME_PROPS = {
  isRequesting: false,
  streamingBlocks: [],
  onSendMessage: () => {},
  onCancel: () => {},
  onApproveTool: () => {},
  onRejectTool: () => {},
  onClearError: () => {},
  conversations: [],
  onOpenConversation: () => {},
}

function ChromeHarness() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#000000' } }}>
      <TranslationProvider>
        <div data-case="chat-welcome" style={{ width: 1000, height: 700 }}>
          <ChatView {...CHROME_PROPS} messages={[]} agentStatus={{ status: 'idle' }} hasApiKey={false} />
        </div>
        <div data-case="chat-live" style={{ width: 1000, height: 700 }}>
          <ChatView {...CHROME_PROPS} messages={PM_MSGS} agentStatus={PM_RETRY} hasApiKey plan={PM_PLAN} />
        </div>
        <div data-case="error-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <ErrorDisplay message="连接失败：请求超时。" onDismiss={() => {}} onRetry={() => {}} />
        </div>
        <div data-case="extend-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <ExtensionPrompt currentCount={50} limit={50} onExtend={() => {}} onStop={() => {}} />
        </div>
        <div data-case="stop-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <SubAgentStopPrompt onResume={() => {}} onConfirm={() => {}} />
        </div>
        <div data-case="chip-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <PromptChip label="帮我写一份周报" onClick={() => {}} />
        </div>
        <div data-case="ring-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <ContextRing used={12000} total={64000} />
        </div>
        <div data-case="empty-box" style={{ width: 1000, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <TranscriptView
            messages={[]}
            agentStatus={{ status: 'idle' }}
            streamingBlocks={[]}
            isRequesting={false}
            restoring={false}
            emptyHint="暂无对话内容"
            onApproveTool={() => {}}
            onRejectTool={() => {}}
            onKillTool={() => {}}
            onRespondToTool={() => {}}
            onClearError={() => {}}
            onRetry={() => {}}
          />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}
window.__mountChrome = () => {
  const host = document.createElement('div')
  host.id = 'chrome'
  document.body.appendChild(host)
  createRoot(host).render(<ChromeHarness />)
}

/** Every migrated surface of the ChatView surroundings, keyed by role. */
window.__chromeVector = () => {
  const INKP = ${JSON.stringify(INK_CHROME)}
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of [...INKP, ...LAYOUT]) o[p] = s[p]
    return o
  }
  const q = (sel) => document.querySelector(sel)
  const within = (caseId, sel) => {
    const root = q('[data-case="' + caseId + '"]')
    return root ? root.querySelector(sel) : null
  }
  const welcome = q('[data-case="chat-welcome"]')
  const live = q('[data-case="chat-live"]')
  // Inline style is the one attribute React writes verbatim, so the variable a
  // surface was migrated to is also its most precise selector: the element that
  // names the var IS the element that paints. Structural guessing would have to
  // survive antd's wrappers, and a text lookup would be language-bound.
  const banner = live ? live.querySelector('div[style*="--pm-retry-bg"]') : null
  const strip = live ? live.querySelector('div[style*="--pm-pop-border"]') : null
  // The no-API-key paragraph is found by its own key glyph: the welcome band
  // below it renders cards that may carry paragraphs of their own.
  const noKey = welcome ? [...welcome.querySelectorAll('p')].find((p) => p.querySelector('.anticon-key')) : null
  const ring = q('[data-case="ring-box"] .pm-context-ring')
  const circles = ring ? ring.querySelectorAll('circle') : []
  const links = q('[data-case="stop-box"]') ? [...q('[data-case="stop-box"]').querySelectorAll('a')] : []
  // The empty transcript's hint — selected structurally: it is the innermost
  // div in the case, i.e. the only one with text and no element children (the
  // case root and TranscriptView's own scroller both have children).
  const emptyRoot = q('[data-case="empty-box"]')
  const emptyHint = emptyRoot
    ? [...emptyRoot.querySelectorAll('div')].find((d) => d.children.length === 0 && (d.textContent || '').trim())
    : null
  return {
    // the welcome branch's ground (--pm-bg) and the three pieces inside it
    welcomeGround: paint(welcome ? welcome.firstElementChild : null),
    logo: paint(welcome ? welcome.querySelector('img') : null),
    infoCircle: paint(welcome ? welcome.querySelector('.anticon-info-circle') : null),
    noKeyBox: paint(noKey ? noKey.parentElement : null),
    noKeyInk: paint(noKey),
    // the chat branch's ground, and the plan strip slotted above the composer
    chatGround: paint(live ? live.firstElementChild : null),
    planStrip: paint(strip),
    planDot: paint(strip ? strip.querySelector('span[style*="border-radius: 3px"]') : null),
    planLink: paint(strip ? strip.querySelector('span[style*="color: var(--pm-link)"]') : null),
    // the retry banner: the row, the spinner's own stroke (mode-independent),
    // the ring's stroke, and the countdown that rides --pm-text-muted
    retryBanner: paint(banner),
    retrySpinner: paint(banner ? banner.querySelector('svg') : null),
    retryRing: paint(banner ? banner.querySelector('circle') : null),
    retryCountdown: paint(banner ? banner.querySelector('span[style*="--pm-text-muted"]') : null),
    // the error box, its dismiss button and the outlined retry beside it
    errorBox: paint(within('error-box', 'div')),
    errorDismiss: paint(within('error-box', 'button')),
    errorRetry: paint(within('error-box', 'button:nth-of-type(2)')),
    // the loop-limit prompt: the solid gold button and the box around it
    extendButton: paint(within('extend-box', 'button')),
    extendBox: paint(within('extend-box', 'div')),
    // the paused-execution strip: its fill, the resume link, the separator, stop
    stopBox: paint(within('stop-box', 'div')),
    stopResume: paint(links[0]),
    stopSep: paint(within('stop-box', 'span')),
    stopStop: paint(links[1]),
    // the starter-prompt pill (its hover is read by hovering for real)
    promptChip: paint(within('chip-box', 'span')),
    // the context ring: the hover disc, the track and the arc
    contextRingDisc: paint(ring),
    contextRingTrack: paint(circles[0]),
    contextRingArc: paint(circles[1]),
    // the empty transcript's one line of hint text
    emptyHint: paint(emptyHint),
  }
}

// ── 8. the code highlighter (M2/T5) ──────────────────────────────────────────
// CodeHighlight is the one migrated surface whose colours do NOT all come from
// the sheet: Prism's theme is a JS object, so the TOKENS flip by subscription
// while the CARD flips by variable. Each half needs its own evidence, and the
// chat's own markdown fence is a third reading — it is what a user sees, and it
// is where x-markdown's theme paints the inner <code> on top of the card.
//
// The fixture is a small TS snippet on purpose: the keyword and the number give
// two token families whose colours differ between the two Prism themes, and the
// doc comment gives a third that is italic in both (the one token the flip must
// NOT be judged by).
const CODE_TS = [
  '// 统计',
  'const answer: number = 42',
  'export function twice(n: number): number {',
  '  return n * 2',
  '}',
].join('\\n')

function CodeHarness() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#000000' } }}>
      <TranslationProvider>
        <div data-case="code-standalone" style={{ width: 600, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <CodeHighlight code={CODE_TS} lang="typescript" fontSize={14} />
        </div>
        <div data-case="code-plain" style={{ width: 600, padding: 12, background: 'var(--pm-bg)', fontFamily: 'system-ui' }}>
          <PlainCode code={CODE_TS} />
        </div>
      </TranslationProvider>
    </ConfigProvider>
  )
}
window.__mountCode = () => {
  const host = document.createElement('div')
  host.id = 'code'
  document.body.appendChild(host)
  createRoot(host).render(<CodeHarness />)
}

/** §8's vector. The card is found structurally (the case root's own first
 *  element child IS the highlighter's PreTag div — with PreTag="div" there is
 *  no pre element to look for), and the tokens BY THEIR TEXT.
 *
 *  Not by a type-class selector: measured in this probe, that class is not in the
 *  DOM. react-syntax-highlighter's create-element runs with inline styles, and
 *  that branch keeps only the class names the stylesheet does NOT know (it seeds
 *  the list with 'token', then filters out every class that appears as a
 *  selector) — so 'keyword' and 'number' are dropped and the token's colour
 *  exists ONLY in its inline style. That is the sharpest form of this section's
 *  premise: no sheet can reach a token. The chat reading reuses the transcript
 *  sections 1–4 already mounted. */
window.__codeVector = () => {
  const INKP = ${JSON.stringify(INK_CODE)}
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of [...INKP, ...LAYOUT]) o[p] = s[p]
    return o
  }
  const tokenByText = (root, text) => {
    if (!root) return null
    const spans = [...root.querySelectorAll('span')]
    return spans.find((s) => s.textContent === text && s.className.indexOf('token') >= 0) || null
  }
  const card = document.querySelector('[data-case="code-standalone"] > div')
  const code = card ? card.querySelector('code') : null
  const wrap = document.querySelectorAll(WRAP_SEL)[1]
  const chatCode = wrap ? wrap.querySelector('pre code') : null
  return {
    card: paint(card),
    cardCode: paint(code),
    token: paint(tokenByText(code, 'const')),
    tokenNum: paint(tokenByText(code, '42')),
    plain: paint(document.querySelector('[data-case="code-plain"] > pre')),
    chatToken: paint(tokenByText(chatCode, 'const')),
  }
}
/** The standalone card's inline style string. The card's *reading* is structural
 *  on purpose (see §7's note on var-name selectors), so that the element names
 *  the variable is asserted separately — the two halves of that claim have two
 *  different failure modes and must not be merged into one selector. */
window.__cardStyle = () => {
  const card = document.querySelector('[data-case="code-standalone"] > div')
  return card ? card.getAttribute('style') || '' : null
}
/** The two Prism themes' own values for what §8 pins, normalised by the browser
 *  (hsl -> rgb, and textShadow -> its computed form) so a check can say "the
 *  measured colour IS this theme's value" without re-implementing hsl parsing in
 *  the probe. */
window.__prismValues = () => {
  const norm = (prop, css) => {
    const el = document.createElement('span')
    el.style[prop] = css
    document.body.appendChild(el)
    const out = getComputedStyle(el)[prop]
    el.remove()
    return out
  }
  const root = 'code[class*="language-"]'
  const pick = (theme) => ({
    keyword: norm('color', theme.keyword.color),
    number: norm('color', theme.number.color),
    base: norm('color', theme[root].color),
    shadow: theme[root].textShadow ? norm('textShadow', theme[root].textShadow) : 'none',
  })
  return { light: pick(oneLight), dark: pick(oneDark) }
}

/** §9's read: all four migrated layers' vectors in one round trip, so the three
 *  readings it compares (light / dark / dark with the section cut) are taken of
 *  the same mounted fixtures and cannot drift apart between passes. Every host
 *  the four sections mount stays in the DOM for the whole run, so one call sees
 *  the message layer, the composer, the ChatView surroundings and the code block
 *  together. */
window.__allVectors = () => ({
  layer: window.__layerVector(),
  input: window.__inputVector(),
  chrome: window.__chromeVector(),
  code: window.__codeVector(),
})

// ── §10 — the shell's own surfaces (PLAN-dark-mode M3/T0) ───────────────────
// The whole shell in one fixture: the real AppLayout (nav column, 对话/项目 pill,
// history list, bottom bar), the real project list, the real CommandPalette, the
// real SearchView, the real ProjectModal, the real ErrorBoundary and the
// editor-layout trio. Three KINDS of evidence come off it and they are not
// interchangeable:
//
//   (1) ROLE rows — an element painted by a \`--pm-*\` role. The checks are that
//       the element IS that role (byte-equal to the variable, in both modes) and
//       that it clears a contrast floor against the ground it really sits on.
//   (2) TOKEN rows — an element antd paints (the sider's edge, the header, the
//       modal paper, an antd input). Their values come out of the antd theme's
//       algorithm, so what is checked is the BINDING (element === the token it
//       claims) and that the token itself moved between modes. Where a token's
//       value comes from is antd's business and deliberately not re-derived
//       here: tests/theme-palette.test.ts owns the \`--pm-*\` palette, no tokens
//       test exists, and the token tier is pinned by binding plus the cut-sheet
//       control below.
//   (3) COMPOSITE rows — a translucent role over the Sider's GRADIENT, whose
//       ground no computed style can report (a gradient is an image and the
//       alpha is folded by the compositor). Those are measured out of a real
//       screenshot instead: the per-channel MODE over the element's rect against
//       fold(declared alpha, the bare gradient pixel at the same y).
//
// The host is a fixed, viewport-sized, opaque --pm-bg box, and that is
// load-bearing twice: the shell's own layout then starts at the viewport origin,
// so a screenshot's pixel coordinates ARE the element's client rects (no scroll,
// no offset arithmetic), and the §1..§9 fixtures stay in the DOM behind it for
// their own reads without ever appearing inside §10's pixels.

/** §10's conversation fixture. The 置顶/今天/昨天/更早 buckets are LOCAL CALENDAR
 *  DAY comparisons, so the timestamps are computed off the current clock when the
 *  fixture is built: a literal ISO date would fall out of 今天 the day after it
 *  was written and the group headers this section pins would silently stop
 *  existing. One row per bucket plus a project-bound one (which the 对话 tab
 *  filters out and the 项目 tab owns — that filter is the two tabs' contract). */
const shellConversations = () => {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  // updatedAt is an ISO STRING — the DB row's shape, and the row sort does
  // localeCompare on it (a number here throws before anything renders).
  const iso = (t) => new Date(t).toISOString()
  return [
    { key: 'conv-shell-pin', label: '置顶的会话', pinned: true, updatedAt: iso(now - DAY * 4) },
    { key: 'conv-shell-today', label: '今天的会话', updatedAt: iso(now - 5 * 60 * 1000) },
    { key: 'conv-shell-yest', label: '昨天的会话', updatedAt: iso(now - DAY) },
    { key: 'conv-shell-old', label: '更早的会话', updatedAt: iso(now - DAY * 9) },
    { key: 'conv-shell-proj', label: '项目下的会话', updatedAt: iso(now - 9 * 60 * 1000), projectId: 'proj-shell' }
  ]
}
/** Two projects: one with a conversation and one empty, because the empty group's
 *  hint is a different element with its own role. createdAt/updatedAt are strings
 *  on the row (the DB's shape), and the sort mode is 'created' (PM_SETTINGS), so
 *  the order is by createdAt DESC — listed oldest-first here so a fixture that
 *  silently stopped sorting would show. */
const shellProjects = () => {
  const now = Date.now()
  return [
    { id: 'proj-empty', name: '空项目', workspaceDir: '/tmp/pm-fixtures/empty', createdAt: new Date(now - 86400000).toISOString(), updatedAt: new Date(now - 86400000).toISOString(), colorHue: 20 },
    { id: 'proj-shell', name: '有会话的项目', workspaceDir: '/tmp/pm-fixtures/shell', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), colorHue: 210 }
  ]
}

/** Publishes the LIVE antd token object: the token rows have to compare an
 *  element against the very token it claims, and a copy written down here would
 *  only prove the copy agrees with itself (the same reason __varColor reads the
 *  sheet through a throwaway box). Rendered inside the ConfigProvider, so it is
 *  the app's own algorithm output that lands on window. */
function ShellTokens() {
  window.__tokens = themeApi.useToken().token
  return null
}
window.__tokenValue = (name) => (window.__tokens ? window.__tokens[name] ?? null : null)
/** A token/role value in the form getComputedStyle would report it, so an ink
 *  token (#f0f0f0) can be compared to an element's computed \`color\` without the
 *  probe parsing colours itself. */
window.__normColor = (value, prop) => {
  if (value == null) return null
  const d = document.createElement('div')
  d.style[prop] = value
  document.body.appendChild(d)
  const out = getComputedStyle(d)[prop]
  d.remove()
  return out
}

function ShellHarness() {
  const mode = useThemeMode()
  const [convs, setConvs] = useState(shellConversations())
  // Handed out during render like the other sections' globals: the node side
  // drives the empty-list phase through it, and it must point at THIS mount.
  window.__setShellConvs = (list) => setConvs(list)
  // The empty phase's way back: the timestamps must be recomputed against the
  // CURRENT clock (the 置顶/今天/昨天 buckets are local-calendar comparisons),
  // so the node side cannot hold a stale copy of the initial list.
  window.__resetShellConvs = () => setConvs(shellConversations())
  return (
    <SettingsProvider>
      <TranslationProvider initialLocale="zh">
        <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
          <AntdApp>
            <ShellTokens />
            <div id="shell" style={{ position: 'fixed', inset: 0, zIndex: 10, overflow: 'hidden', background: 'var(--pm-bg)' }}>
              <AppLayout
                conversations={convs}
                activeConversationKey="conv-shell-today"
                totalSessions={100}
                autoCleanup={false}
                activeLoopConvIds={['conv-shell-old']}
                retryingConvIds={['conv-shell-yest']}
                onCreateNew={() => {}}
                onDeleteConversation={() => {}}
                onRenameConversation={() => {}}
                onSelectConversation={() => {}}
                onTogglePinConversation={() => {}}
                onCreateTask={() => {}}
              >
                <div data-pm-ground="chat" style={{ height: '100%', background: 'var(--pm-bg)' }} />
              </AppLayout>
            </div>
          </AntdApp>
        </ConfigProvider>
      </TranslationProvider>
    </SettingsProvider>
  )
}
let shellRoot = null
window.__mountShell = async () => {
  // The earlier sections' fixtures are still in the document and make it tall,
  // so the page scrollbar would be in the way of §10's readings (and of the
  // screenshot's leftmost columns). None of their assertions run again, and the
  // shell is viewport-sized and fixed, so clipping the page here changes nothing
  // the shell reads.
  document.documentElement.style.overflow = 'hidden'
  // The projects the project tab renders come from the shared store, which has
  // its own reload() — the stub answers projectList() from window.__pmProjects.
  window.__pmProjects = shellProjects()
  // Unmount-and-reset rather than append: the node side runs this once per mode,
  // and three things outlive a second mount — the previous root (with antd's
  // portals and the palette's Modal still in them), the project store's list, and
  // the two module-level zustand stores the shell drives (a phase that navigated
  // to search would otherwise leave the dark run starting on the search view, and
  // a palette left open would make the dark run's first phase read the palette's
  // own modal as the shell's paper).
  if (shellRoot) {
    shellRoot.unmount()
    shellRoot = null
  }
  const old = document.getElementById('shell-host')
  if (old) old.remove()
  useNavigationStore.getState().navigate({ kind: 'chat' })
  useCommandPaletteStore.getState().setOpen(false)
  const host = document.createElement('div')
  host.id = 'shell-host'
  document.body.appendChild(host)
  shellRoot = createRoot(host)
  shellRoot.render(<ShellHarness />)
  await useProjectStore.getState().reload()
}

/** The Sider's own columns, as functions rather than CSS paths: the Sider's
 *  children are [title header, nav column, list area, bottom bar] and the macOS
 *  traffic-light band only exists when the window controls sit left, which this
 *  fixture never has (getWindowControls says 'right'). One walk, in one place. */
const sid = () => document.querySelector('.ant-layout-sider-children')
const sidChild = (i) => { const el = sid(); return el ? el.children[i] || null : null }
const sidList = () => { const area = sidChild(2); return area ? area.children[1] || null : null }
const viewRoot = () => {
  const holder = document.querySelector('#shell .ant-layout-content > div')
  if (!holder) return null
  const visible = Array.prototype.filter.call(holder.children, (el) => getComputedStyle(el).display !== 'none')
  return visible.length ? visible[visible.length - 1] : null
}
const projHeader = (id) => document.querySelector('[data-project-header="' + id + '"]')
const rowEl = (key) => document.querySelector('[data-conv-row="' + key + '"]')
const kid = (el, i) => (el ? el.children[i] || null : null)
// antd v6 renamed the dialog paper: .ant-modal > .ant-modal-container >
// .ant-modal-body (there is no .ant-modal-content). The container is the
// element carrying the elevated token.
const modal = () => { const all = document.querySelectorAll('.ant-modal .ant-modal-container'); return all.length ? all[all.length - 1] : null }

/** Every §10 element, by the key the node side's row table knows it as. Flat
 *  (selector-like walks only, no chained state) so the paint reader and the
 *  composite-rect reader cannot point at two different elements. */
const SHELL_FLAT = [
  ['sider', () => document.querySelector('.ant-layout-sider')],
  ['title', () => kid(kid(sidChild(0), 0), 0)],
  ['version', () => kid(kid(sidChild(0), 0), 1)],
  ['navActive', () => document.querySelector('.new-chat-btn.active-mode-btn')],
  ['navIdle', () => document.querySelector('.new-chat-btn:not(.active-mode-btn)')],
  ['navCaret', () => document.querySelector('.new-chat-btn .nav-split .anticon')],
  ['iconIdle', () => document.querySelector('.sidebar-icon-btn:not(.active-mode-btn)')],
  ['iconActive', () => document.querySelector('.sidebar-icon-btn.active-mode-btn')],
  ['bottomBar', () => sidChild(3)],
  ['track', () => document.querySelector('.sidebar-list-track')],
  ['tabOn', () => document.querySelector('.sidebar-list-tab.on')],
  ['tabOff', () => document.querySelector('.sidebar-list-tab:not(.on)')],
  ['action', () => document.querySelector('.sidebar-list-action')],
  ['actionLast', () => { const all = document.querySelectorAll('.sidebar-list-action'); return all.length ? all[all.length - 1] : null }],
  // The same node as actionLast, and a key of its own because its ROLE differs by
  // tab: on 对话 it is the disabled 新增 (canCreateNew is false — 100 sessions, no
  // auto-cleanup), on 项目 it is an enabled one next to the sort button. Two rows
  // with disjoint phase scopes is how the table says that.
  ['actionNew', () => { const all = document.querySelectorAll('.sidebar-list-action'); return all.length ? all[all.length - 1] : null }],
  ['listScroll', () => sidList()],
  ['groupHead', () => document.querySelector('[data-conv-group]')],
  ['rowPin', () => kid(kid(rowEl('conv-shell-pin'), 2), 0)],
  ['rowTime', () => kid(kid(rowEl('conv-shell-pin'), 2), 1)],
  ['rowIdle', () => kid(rowEl('conv-shell-pin'), 1)],
  ['rowActive', () => rowEl('conv-shell-today')],
  ['rowActiveLabel', () => kid(rowEl('conv-shell-today'), 1)],
  ['rowEllipsis', () => kid(kid(rowEl('conv-shell-today'), 2), 0)],
  ['rowRetry', () => kid(kid(rowEl('conv-shell-yest'), 0), 0)],
  ['rowRunning', () => kid(kid(rowEl('conv-shell-old'), 0), 0)],
  ['rowHover', () => rowEl('conv-shell-yest')],
  ['chatsEmpty', () => kid(sidList(), 0)],
  ['projHeader', () => projHeader('proj-shell')],
  ['projChevron', () => kid(projHeader('proj-shell'), 0)],
  ['projFolder', () => kid(projHeader('proj-shell'), 1)],
  ['projName', () => kid(projHeader('proj-shell'), 2)],
  ['projAction', () => (projHeader('proj-shell') || {}).querySelector ? projHeader('proj-shell').querySelector('.project-row-action') : null],
  ['projActionDanger', () => (projHeader('proj-shell') || {}).querySelector ? projHeader('proj-shell').querySelector('.project-row-action-danger') : null],
  ['projEmptyHint', () => { const h = projHeader('proj-empty'); return h && h.parentElement ? kid(h.parentElement, 1) : null }],
  ['header', () => document.querySelector('#shell .ant-layout-header')],
  ['headerTitle', () => kid(kid(document.querySelector('#shell .ant-layout-header'), 1), 0)],
  ['paneBtn', () => document.querySelector('.header-pane-btn')],
  ['chatGround', () => document.querySelector('[data-pm-ground="chat"]')],
  ['palettePaper', () => modal()],
  ['paletteRow', () => document.querySelector('[data-idx="0"]')],
  ['paletteLabel', () => kid(document.querySelector('[data-idx="0"]'), 0)],
  // The group header is the row's *sibling* — one per-item wrapper holds the
  // header and its row, and the header is always present for idx 0 (the group
  // tracker starts empty, so the first item always differs from it).
  ['paletteGroup', () => { const r = document.querySelector('[data-idx="0"]'); return r && r.parentElement ? kid(r.parentElement, 0) : null }],
  ['paletteHint', () => document.querySelector('[data-idx="0"] > span:nth-child(2)')],
  ['paletteEmpty', () => { const m = modal(); return m ? m.querySelector('.auto-hide-scroll > div') : null }],
  ['pmPaper', () => modal()],
  ['pmLabel', () => { const m = modal(); return m ? kid(kid(m.querySelector('.ant-modal-body'), 0), 0) : null }],
  ['pmInput', () => { const m = modal(); return m ? m.querySelector('input.ant-input') : null }],
  ['pmDirError', () => { const m = modal(); return m ? m.querySelector('[style*="--pm-error-status"]') : null }],
  ['searchRoot', () => viewRoot()],
  ['searchInput', () => { const r = viewRoot(); return r ? kid(kid(r, 0), 0) : null }],
  ['searchPrefix', () => document.querySelector('.ant-input-prefix .anticon')],
  ['searchScroll', () => kid(viewRoot(), 1)],
  ['searchHint', () => kid(kid(viewRoot(), 1), 0)],
  ['searchGroupHead', () => kid(kid(kid(viewRoot(), 1), 0), 0)],
  ['searchGroupCount', () => kid(kid(kid(kid(viewRoot(), 1), 0), 0), 1)],
  ['searchGroupBox', () => kid(kid(kid(viewRoot(), 1), 0), 1)],
  ['searchRow', () => document.querySelector('.search-row')],
  // The same node as searchRow, and a key of its own because only ONE of the two
  // carries a wash: a search row's \`:hover\` background is the row's own paint and
  // the α rows read a patch, so the hovered and the bare reading cannot share a
  // row — they differ by phase, exactly like actionLast/actionNew above.
  ['searchRowHover', () => document.querySelector('.search-row')],
  ['searchRowTitle', () => kid(kid(document.querySelector('.search-row'), 0), 0)],
  ['searchRowIcon', () => kid(kid(kid(document.querySelector('.search-row'), 0), 0), 0)],
  // Only the message hits carry a meta span, and the conversations group lists
  // first — so the meta is read off the THIRD row (the first message hit).
  ['searchRowMeta', () => { const rows = document.querySelectorAll('.search-row'); return rows[2] ? kid(kid(rows[2], 0), 1) : null }],
  ['searchRowBody', () => kid(document.querySelector('.search-row'), 1)],
  // StatisticsPage renders CenteredPage, so the usage phase reaches the real
  // whole-page sheet in situ — the root is the one carrying \`settings-scroll\`.
  ['centeredRoot', () => document.querySelector('#shell .settings-scroll')],
  ['centeredColumn', () => kid(document.querySelector('#shell .settings-scroll'), 0)],
  // The same shell mounted twice: in situ above (the usage phase) and on its own
  // in the extras fixture (below), because the page's ground and the column's cap
  // are two things T0.3 moved and neither reading should depend on the other
  // fixture's data branch. \`#extras\` is scoped so the two cannot collide.
  ['extrasCenteredRoot', () => document.querySelector('#extras .settings-scroll')],
  ['extrasCenteredColumn', () => kid(document.querySelector('#extras .settings-scroll'), 0)],
  ['extrasGround', () => document.querySelector('#extras')],
  ['errRoot', () => { const box = document.querySelector('[data-case="err-boundary"]'); return box ? kid(box, 0) : null }],
  ['errPre', () => { const box = document.querySelector('[data-case="err-boundary"]'); return box ? box.querySelectorAll('pre')[0] || null : null }],
  ['errStack', () => { const box = document.querySelector('[data-case="err-boundary"]'); return box ? box.querySelectorAll('pre')[1] || null : null }],
  ['editorHeader', () => document.querySelector('[data-case="editor-header"]')],
  ['editorSurface', () => document.querySelector('[data-case="editor-surface"]')],
  ['editorCard', () => document.querySelector('[data-case="editor-card"]')]
]

/** The translucent-over-gradient rows: the element, the role whose alpha its band
 *  must fold, and WHERE in that element the band is sampled. Read through a
 *  screenshot rather than a computed style — see the header above.
 *
 *  The sample geometry is per row and load-bearing: an α element's own box is
 *  usually covered by its children (the pill track's two pills, a row's label and
 *  action slot, the nav buttons' icon and text), and sampling the whole rect
 *  would return the CHILD's colour with the element's role nowhere in it. Each
 *  sampler below returns a small patch that lies inside the element's own paint
 *  and nowhere else — the padding band of a row, the empty right end of a nav
 *  button, the 2px ring inside the pill track. The probe asserts the patch is
 *  uniform, so a sampler that drifts onto a child fails loudly instead of
 *  quietly measuring the wrong surface. */
const SAMPLE_RIGHT = (r) => ({ x: r.x + r.w - 46, y: r.y + r.h / 2 - 1, w: 12, h: 2 })
const SAMPLE_ICON = (r) => ({ x: r.x + 2, y: r.y + r.h / 2 - 1, w: 4, h: 2 })
const SAMPLE_TRACK = (r) => ({ x: r.x + r.w / 2 - 3, y: r.y + 1, w: 6, h: 1 })
const SAMPLE_TOP = (r) => ({ x: r.x + 10, y: r.y + 2, w: 24, h: 2 })

const SHELL_ALPHA = [
  ['navActive', '--pm-veil-strong', SAMPLE_RIGHT],
  ['navIdle', '--pm-veil', SAMPLE_RIGHT],
  ['iconActive', '--pm-veil-strong', SAMPLE_ICON],
  ['iconIdle', '--pm-veil', SAMPLE_ICON],
  ['track', '--pm-hover', SAMPLE_TRACK],
  ['rowActive', '--pm-hover-strong', SAMPLE_TOP],
  ['rowHover', '--pm-hover', SAMPLE_TOP],
  ['projHeader', '--pm-hover-weak', SAMPLE_TOP],
  // The one row here whose role is OPAQUE (--pm-row-hover is a hex, not an alpha
  // wash), so its fold degenerates to "the pixel IS the role" — still worth a
  // pixel: an opaque hover wash on a --pm-bg ground is exactly the kind of value
  // a computed style can report and the compositor can fail to paint.
  ['searchRowHover', '--pm-row-hover', SAMPLE_TOP]
]

const shellPaint = (el) => {
  if (!el) return null
  const s = getComputedStyle(el)
  return {
    color: s.color,
    backgroundColor: s.backgroundColor,
    backgroundImage: s.backgroundImage,
    borderTopColor: s.borderTopColor,
    borderRightColor: s.borderRightColor,
    borderBottomColor: s.borderBottomColor,
    borderLeftColor: s.borderLeftColor,
    boxShadow: s.boxShadow
  }
}

/** One phase's reading: every element that exists right now, a client rect for
 *  each of them, and — for the composite rows — the patch inside the element
 *  whose own paint the fold must reproduce. All three come off the SAME elements
 *  object, so a row can never be sampled off one render and measured off
 *  another: the node side screenshots immediately after this call, and nothing
 *  between the two moves an element (taking a screenshot does not move the
 *  pointer).
 *
 *  The rect is what the node side turns into a GROUND probe — the bare gradient
 *  column at the element's own vertical centre — so it is emitted for every
 *  element, not only the composite rows: an ink row over the sidebar is a third
 *  of §10's rows and each of them needs the pixel its ink sits on. A rect is
 *  omitted (undefined) when the element is absent or has no box: a row that was
 *  read but has no rect is a real failure and the node side says so. */
/** The ground an element's ink is really read against — the contrast floor's
 *  other operand. Three answers, in priority order: the element's own OPAQUE
 *  background (text painted on a filled element reads against that fill — the
 *  ink pill of the active tab, a <pre>'s paper); else, inside the Sider, the
 *  GRADIENT (no computed style can report it; the node side substitutes the
 *  measured pixel); else the nearest ancestor with an opaque background. A
 *  translucent wash on the way up is NOT a ground (it is itself a composite —
 *  the hover row under a palette row would otherwise pose as one), so only
 *  alpha-1 backgrounds qualify. null only when nothing opaque is behind the
 *  element at all, which for a §10 element is itself a bug. */
const groundOf = (el) => {
  if (!el) return null
    // Backslashes doubled: this code lives in a template literal, which eats one.
  const opaque = (s) => {
    const m = /rgba?\\(\\s*[\\d.]+,\\s*[\\d.]+,\\s*[\\d.]+(?:,\\s*([\\d.]+))?\\s*\\)/.exec(s || '')
    return m ? (m[1] === undefined ? true : Number(m[1]) === 1) : false
  }
  const visible = (s) => !!s && s !== 'rgba(0, 0, 0, 0)' && s !== 'transparent'
  const own = getComputedStyle(el).backgroundColor
  if (visible(own) && opaque(own)) return own
  if (el.closest && el.closest('.ant-layout-sider')) return 'gradient'
  let n = el.parentElement
  while (n && n !== document.body) {
    const s = getComputedStyle(n)
    if (visible(s.backgroundColor) && opaque(s.backgroundColor)) return s.backgroundColor
    n = n.parentElement
  }
  return null
}

window.__shellVector = () => {
  const els = {}
  SHELL_FLAT.forEach(([key, get]) => {
    try { els[key] = get() } catch (err) { els[key] = null }
  })
  const rows = {}
  const grounds = {}
  Object.keys(els).forEach((key) => {
    const p = shellPaint(els[key])
    if (p) rows[key] = p
    const g = groundOf(els[key])
    if (g) grounds[key] = g
  })
  const rects = {}
  const patches = {}
  const alpha = {}
  const patched = {}
  SHELL_ALPHA.forEach(([key, role, sample]) => { patched[key] = sample; alpha[key] = role })
  Object.keys(els).forEach((key) => {
    const el = els[key]
    if (!el || !el.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    rects[key] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    if (patched[key]) patches[key] = patched[key]({ x: r.left, y: r.top, w: r.width, h: r.height })
  })
  return { rows, rects, patches, alpha, grounds }
}

// ── §10's extras: the two surfaces no shell phase reaches ──
// The error boundary's fallback only exists after a child throws, and the
// editor-layout trio is a set of exported style objects (EDITOR_COLUMN_HEADER /
// EDITOR_SURFACE / EDITOR_CHAT_CARD) applied by four different views, so §10
// applies them to plain boxes. What is asserted is the constants themselves —
// the views' own nesting is not this section's claim.
//
// The fallback's reload button deliberately keeps its UA face (buttonface /
// buttontext is a pair the browser guarantees; --pm-ink on a light button plate
// would not be legible), so it is not read here at all — it is asserted to exist
// and left alone. console.error is muted for the mount because the fixture's
// whole point is a component that throws: React's own report and the boundary's
// 'PulseMind Error:' line are the fixture working, not a failure, and nothing in
// this probe reads the page's console (uncaught errors arrive through
// page.on('pageerror'), which a caught render error never reaches).
function Boom() {
  throw new Error('probe: the fallback is the subject')
}
function ExtrasHarness() {
  const mode = useThemeMode()
  return (
    <SettingsProvider>
      <TranslationProvider initialLocale="zh">
        <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
          <AntdApp>
            <div id="extras" style={{ padding: 24, background: 'var(--pm-bg)' }}>
              <div data-case="err-boundary">
                <ErrorBoundary>
                  <Boom />
                </ErrorBoundary>
              </div>
              <div data-case="editor" style={{ marginTop: 16, padding: 12, background: 'var(--pm-bg)' }}>
                <div data-case="editor-header" style={EDITOR_COLUMN_HEADER}>工作区</div>
                <div data-case="editor-surface" style={EDITOR_SURFACE}>
                  <div data-case="editor-card" style={EDITOR_CHAT_CARD}>卡片</div>
                </div>
              </div>
              {/* The usage view renders this same shell in situ (§10's centeredRoot);
                  mounted here as well because the page's ground and the column's
                  cap are the two things T0.3 moved, and they are worth a reading
                  that does not depend on StatisticsPage's own data branch. */}
              <div data-case="centered" style={{ height: 120, marginTop: 16 }}>
                <CenteredPage>
                  <div style={{ padding: 8, background: 'var(--pm-card)' }}>居中页</div>
                </CenteredPage>
              </div>
            </div>
          </AntdApp>
        </ConfigProvider>
      </TranslationProvider>
    </SettingsProvider>
  )
}
window.__mountExtras = () => {
  const realError = console.error
  console.error = () => {}
  try {
    const host = document.createElement('div')
    host.id = 'extras-host'
    document.body.appendChild(host)
    createRoot(host).render(<ExtrasHarness />)
  } finally {
    console.error = realError
  }
}

// ── §11 — the welcome band (M3/T1) ──
// Two WelcomeSuggestions mounts (data / empty-with-hang) and one ProjectCards
// mount, all restyled per mode through useThemeMode like the shell's harness.
// Timestamps are computed at mount time: the chat card's meta and the project
// rows are relative times.
const welcomeConversations = () => {
  const now = Date.now()
  const iso = (t) => new Date(t).toISOString()
  return [
    { key: 'conv-welcome-1', label: '官网改版的讨论', projectId: 'proj-w1', updatedAt: iso(now - 30 * 3600 * 1000), messageCount: 3 },
  ]
}
const WELCOME_LISTS = () => ({
  listConversations: [
    { id: 'conv-welcome-1', title: '昨天的会话', updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(), messageCount: 2 },
  ],
  routineList: [{ id: 'rt-w1', name: '每日站报', enabled: true, schedule: { kind: 'daily' }, nextRunAt: new Date(Date.now() + 3600 * 1000).toISOString() }],
  routineRuns: [{ routineId: 'rt-w1', status: 'success', startedAt: new Date(Date.now() - 7200 * 1000).toISOString() }],
  knowledgeListFiles: [{ id: 'kb-w1', title: '入职手册', sourceType: 'file', status: 'compiled', createdAt: new Date(Date.now() - 600 * 1000).toISOString(), wikiOutputs: [{ id: 'w1' }] }],
})
const WELCOME_PROJECTS = () => {
  const t = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
  return [
    { id: 'proj-w1', name: '官网改版', workspaceDir: '/tmp/pm-fixtures/site', createdAt: t, updatedAt: t, colorHue: 210 },
    { id: 'proj-w2', name: '空白项目', workspaceDir: '/tmp/pm-fixtures/blank', createdAt: t, updatedAt: t, colorHue: 40 },
  ]
}
const WELCOME_QUOTES = { 'conv-welcome-1': '把周报整理一下', c_w1: '把周报整理一下' }

function WelcomeMode({ children }) {
  const mode = useThemeMode()
  return (
    <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div style={{ padding: 24, background: 'var(--pm-bg)', width: 1000 }}>{children}</div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}
window.__mountWelcomeData = () => {
  window.__pmLists = WELCOME_LISTS()
  window.__pmQuotes = WELCOME_QUOTES
  window.__pmProjects = WELCOME_PROJECTS()
  const host = document.createElement('div')
  host.id = 'welcome-data'
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <WelcomeMode>
      <WelcomeSuggestions activeLoopConvIds={['conv-welcome-1']} onOpenConversation={() => {}} />
    </WelcomeMode>
  )
  return useProjectStore.getState().reload()
}
window.__mountWelcomeEmpty = () => {
  window.__pmLists = {}
  window.__pmHangLists = true
  const host = document.createElement('div')
  host.id = 'welcome-empty-host'
  document.body.appendChild(host)
  createRoot(host).render(
    <WelcomeMode>
      <WelcomeSuggestions activeLoopConvIds={[]} onOpenConversation={() => {}} />
    </WelcomeMode>
  )
}
window.__mountWelcomeProjects = () => {
  const host = document.createElement('div')
  host.id = 'welcome-projects-host'
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <WelcomeMode>
      <ProjectCards conversations={welcomeConversations()} onOpenConversation={() => {}} />
    </WelcomeMode>
  )
  return useProjectStore.getState().reload()
}

/** The §11 reader. Structural walks only — the band cards have no probe hooks,
 *  but their shapes are fixed (label row over CardBody over optional link row).
 *  Only elements that EXIST in the fixture are read; a role whose element is
 *  absent reports null and the node side fails loudly. */
const welcomePaint = (el) => {
  if (!el) return null
  const s = getComputedStyle(el)
  return { color: s.color, backgroundColor: s.backgroundColor, borderTopColor: s.borderTopColor }
}
const welcomeLeaf = (root, text) =>
  [...root.querySelectorAll('div, span, a, button')].find((d) => d.children.length === 0 && d.textContent.trim() === text)
window.__welcomeVector = () => {
  const paint = welcomePaint
  const data = document.getElementById('welcome-data')
  const empty = document.getElementById('welcome-empty-host')
  const projects = document.getElementById('welcome-projects-host')
  const rows = {}
  // The band row is the one flex line wearing minHeight 158px — found by style
  // signature, not by index, because the mounts wrap the component in padding
  // divs whose nesting is nobody's contract.
  const findBand = (host) => {
    if (!host) return null
    return [...host.querySelectorAll('div')].find(
      (d) => d.style.display === 'flex' && d.style.minHeight === '158px'
    ) || null
  }
  const dataBand = findBand(data)
  const bandCards = dataBand ? [...dataBand.children] : []
  const cardKids = (i) => (bandCards[i] ? [...bandCards[i].children] : [])
  // chat card: [label row, headline, detail, meta]
  const chatKids = cardKids(0)
  rows.chatCard = paint(bandCards[0])
  rows.chatLabel = chatKids[0] ? paint(chatKids[0].children[1]) : null
  rows.chatHeadline = paint(chatKids[1])
  rows.chatDetail = paint(chatKids[2])
  rows.chatMeta = paint(chatKids[3])
  // badge slots: children[3] IS the dot / the status span (no wrapper element)
  rows.chatDot = paint(chatKids[0] && chatKids[0].children[3])
  // routine card: badge = 成功 status span + the run-now button in the label row
  const routineKids = cardKids(1)
  rows.runCard = paint(bandCards[1])
  rows.runBadge = paint(routineKids[0] && routineKids[0].children[3])
  rows.runNow = routineKids[0] ? paint(routineKids[0].querySelector('button')) : null
  // knowledge card
  const knowKids = cardKids(2)
  rows.knowCard = paint(bandCards[2])
  rows.knowMeta = paint(knowKids[3])
  // empty host: muted headline + haze detail on the routine card, skeleton bars
  if (empty) {
    const cards = (() => { const b = findBand(empty); return b ? [...b.children] : [] })()
    const rkids = cards[1] ? [...cards[1].children] : []
    rows.emptyHeadline = paint(rkids[1])
    rows.emptyDetail = paint(rkids[2])
    const skel = cards[0] ? [...cards[0].querySelectorAll('div')].find((d) => d.style.borderRadius === '5px') : null
    rows.skelBar = paint(skel)
  }
  // projects host: heading row, grid cards, create button, starters. The mount
  // wraps the component in a padding div (and antd's App adds one more), so the
  // walks key on style signatures: the heading is the 952px column, the grid
  // the one display:grid box.
  if (projects) {
    const heading = [...projects.querySelectorAll('div')].find((d) => d.style.maxWidth === '952px')
    const grid = [...projects.querySelectorAll('div')].find((d) => d.style.display === 'grid')
    const gcardsAll = grid ? [...grid.children] : []
    // The heading div's first child is a TEXT node (its ink is inherited), so
    // the div itself is the painted element — not children[0] (the arrow icon).
    rows.projHeading = paint(heading)
    rows.projPill = heading ? paint(heading.querySelector('button')) : null
    const gcards = gcardsAll
    const meta = (c) => (c ? [...c.children].find((k) => k.children.length >= 2) : null)
    const card1 = gcards[0]
    const m1 = meta(card1)
    rows.projCard = paint(card1)
    // name row: [name span] (+ hover edit / check icon when present)
    rows.projName = card1 ? paint(card1.children[0] && card1.children[0].children[0]) : null
    rows.projTime = m1 ? paint(m1.children[0]) : null
    rows.projQuote = m1 ? paint(m1.children[1]) : null
    rows.projPlay = m1 ? paint(m1.querySelector('button')) : null
    const card2 = gcards[1]
    const m2 = meta(card2)
    rows.projStart = m2 ? paint(m2.children[0]) : null
    rows.createCard = paint(gcards[2])
    const starters = grid && grid.nextElementSibling && grid.nextElementSibling.firstElementChild
    rows.starterLabel = starters ? paint(starters.firstElementChild) : null
  }
  return rows
}

// ── §17's mount — the real knowledge table. WelcomeMode is the same wrapper
// the §11 mounts use: the theme must flip with __setMode, and SettingsProvider
// is what the panel's i18n/settings readers expect. The stub electronAPI
// answers the three loads (list/stats/bases) from window.__pmKnowledgeFiles.
window.__mountKnowledge = () => {
  const host = document.createElement('div')
  host.id = 'knowledge-host'
  document.body.appendChild(host)
  createRoot(host).render(
    <WelcomeMode>
      <KnowledgePanel knowledgeManager={new KnowledgeManager()} />
    </WelcomeMode>
  )
}
/** §17's reader. The tick is the checkbox's ::after pseudo and its VISIBLE edges
 *  are right/bottom (top/inline-start are 0-width) — borderTop carries a colour
 *  too, but reading it instead sent me chasing a black tick never painted. */
window.__knowledgeVector = () => {
  const host = document.getElementById('knowledge-host')
  if (!host) return null
  const row = host.querySelector('.ant-table-tbody tr.ant-table-row-selected')
  const td = row ? row.querySelector('td') : null
  const tds = row ? row.querySelectorAll('td') : []
  const lastTd = tds.length ? tds[tds.length - 1] : null
  const box = host.querySelector('.ant-table-tbody .ant-checkbox-checked')
  const after = box ? getComputedStyle(box, ':after') : null
  const bar = [...host.querySelectorAll('div')].find((d) => d.style.background === 'var(--pm-wash)') || null
  return {
    rowSelected: !!row,
    selRowBg: td ? getComputedStyle(td).backgroundColor : null,
    hoverTdBg: lastTd ? getComputedStyle(lastTd).backgroundColor : null,
    boxBg: box ? getComputedStyle(box).backgroundColor : null,
    tick: after ? after.borderRightColor : null,
    tickBottom: after ? after.borderBottomColor : null,
    batchBarBg: bar ? getComputedStyle(bar).backgroundColor : null,
  }
}

// ── §17b's mount — a plain Radio.Group under the same WelcomeMode wrapper
// (the MCP 传输类型 radios are the app's Radio.Group consumers; the group's
// shape — one checked option — is all the reader needs). The dot is the
// radio inner's ::after painting colorWhite over the colorPrimary disc,
// which is the Checkbox-tick mechanism's second consumer (review0924 M8).
window.__mountRadio = () => {
  const host = document.createElement('div')
  host.id = 'radio-host'
  document.body.appendChild(host)
  createRoot(host).render(
    <WelcomeMode>
      <Radio.Group
        defaultValue="stdio"
        options={[
          { label: 'stdio', value: 'stdio' },
          { label: 'SSE', value: 'sse' },
          { label: '流式 HTTP', value: 'http' },
        ]}
      />
    </WelcomeMode>
  )
}
window.__radioVector = () => {
  const host = document.getElementById('radio-host')
  if (!host) return null
  // antd v6 dropped the -inner span: the .ant-radio span IS the disc (checked
  // paints radioBgColor on it) and the dot is its ::after (radioColor).
  const disc = host.querySelector('.ant-radio-checked')
  const dot = disc ? getComputedStyle(disc, '::after') : null
  return {
    checked: !!disc,
    discBg: disc ? getComputedStyle(disc).backgroundColor : null,
    dotBg: dot ? dot.backgroundColor : null,
  }
}

// ── §12 — plan graph / routine center / sub-agent header (M3/T2) ──
window.__mountT2 = () => {
  window.__pmLists = {
    ...window.__pmLists,
    routineList: [{ id: 'rt-t2', name: '每日报表', enabled: true, description: '汇总昨日数据并生成简报', schedule: { cron: '0 9 * * *' } }],
    routineRuns: [{ id: 'run-t2', routineId: 'rt-t2', status: 'success', startedAt: new Date(Date.now() - 3600 * 1000).toISOString(), trigger: 'schedule' }],
  }
  const plan = createPlanDag('上线协作版本', [
    { description: '调研并输出纪要' },
    { description: '撰写需求文档', dependsOn: [1] },
  ])
  plan.nodes[0].status = 'completed'
  plan.nodes[1].execution = { status: 'running' }
  const T2Mode = ({ children }) => {
    const mode = useThemeMode()
    return (
      <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
        <AntdApp>
          <SettingsProvider>
            <TranslationProvider initialLocale="zh">{children}</TranslationProvider>
          </SettingsProvider>
        </AntdApp>
      </ConfigProvider>
    )
  }
  // The sizing/background rides the HOST divs and T2Mode renders the
  // components bare: antd's App already inserts its own .ant-app div, and the
  // reader's ant-app-child walk assumes the component root is that element's
  // first child — an extra wrapper here would pose as the component (measured:
  // the wrapper also carried var(--pm-bg), so the subBg row passed on it and
  // only the header rows failed).
  const mk = (id, h) => {
    const el = document.createElement('div')
    el.id = id
    el.style.marginBottom = '16px'
    el.style.background = 'var(--pm-bg)'
    el.style.height = h
    document.body.appendChild(el)
    return el
  }
  const hosts = [mk('t2-graph', '320px'), mk('t2-routine', '480px'), mk('t2-sub', '300px')]
  const roots = hosts.map((h) => createRoot(h))
  roots[0].render(<T2Mode><div style={{ width: 420, height: '100%' }}><PlanGraphView plan={plan} onJumpToStep={() => {}} /></div></T2Mode>)
  roots[1].render(<T2Mode><RoutineCenter /></T2Mode>)
  roots[2].render(<T2Mode><SubAgentSessionView subConvId="sub-t2" title="调研子任务" live={false} onBack={() => {}} /></T2Mode>)

  // The 新建任务 dashed card is the EMPTY page's affordance only (user ruling
  // 2026-09-23: 有任务时它变成【我的任务】行里的普通按钮), so it needs its own
  // host — the stub answers routineList with whatever list is set when the
  // call lands, and roots mounted in the same tick would all read the populated
  // one. The outer probe calls this AFTER the populated hosts have rendered
  // (it waits for their .routine-card first), which is what makes the list flip
  // to [] safe.
  window.__mountT2Empty = () => {
    window.__pmLists = { ...window.__pmLists, routineList: [], routineRuns: [] }
    const el = mk('t2-routine-empty', '320px')
    createRoot(el).render(<T2Mode><RoutineCenter /></T2Mode>)
  }
}

/** §12's reader. The plan graph is SVG: its fills/strokes are computed reads
 *  (the attributes carry var() strings). */
window.__t2Vector = () => {
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    return { color: s.color, backgroundColor: s.backgroundColor, borderTopColor: s.borderTopColor, borderLeftColor: s.borderLeftColor, fill: s.fill, stroke: s.stroke }
  }
  const rows = {}
  const graph = document.getElementById('t2-graph')
  const viewport = graph && graph.querySelector('[data-graph-viewport]')
  rows.graphCanvas = paint(viewport && viewport.parentElement)
  const objective = graph && graph.querySelector('[data-objective]')
  rows.objective = paint(objective)
  const progressRow = objective && objective.parentElement && objective.parentElement.nextElementSibling
  const track = progressRow && progressRow.children[0]
  rows.progressTrack = paint(track)
  rows.progressFill = paint(track && track.children[0])
  const readyNode = graph && [...graph.querySelectorAll('g[data-node]')].find((g) => g.querySelector('[data-icon="spinner"]'))
  const readyRect = readyNode && readyNode.querySelector('rect')
  rows.readyStroke = readyRect ? { stroke: getComputedStyle(readyRect).stroke } : null
  // A task card, not the 开始/结束 anchor pills (those wear --pm-fill once done).
  const anyNode = graph && [...graph.querySelectorAll('g[data-node]')]
    .filter((g) => !g.dataset.node.startsWith('__'))
    .map((g) => g.querySelector('rect'))[0]
  rows.nodeFill = anyNode ? { fill: getComputedStyle(anyNode).fill } : null
  const routine = document.getElementById('t2-routine')
  const routineRoot = routine && routine.querySelector('.ant-app > div')
  rows.pageBg = paint(routineRoot)
  rows.cardBorder = paint(routine && routine.querySelector('.routine-card'))
  rows.pill = paint(routine && routine.querySelector('.routine-pill'))
  // The dashed create card rides the EMPTY-state host — since the 2026-09-23
  // ruling it renders only while no routine exists, so the populated t2-routine
  // host no longer has one to paint.
  const emptyHost = document.getElementById('t2-routine-empty')
  const newCard = emptyHost && emptyHost.querySelector('[data-action="create-task"]')
  rows.newCard = paint(newCard)
  const tasksSection = routine && routine.querySelector('[data-section="tasks"]')
  rows.headInk = paint(tasksSection && tasksSection.querySelector('span'))
  const aside = routine && routine.querySelector('[data-section="runs"]')
  rows.runsRule = paint(aside)
  const sub = document.getElementById('t2-sub')
  const subRoot = sub && sub.querySelector('.ant-app > div')
  rows.subBg = paint(subRoot)
  const header = subRoot && subRoot.children[0]
  rows.subBack = paint(header && header.children[0])
  rows.subTitle = paint(header && header.children[2])
  const badge = header && [...header.children].find((c) => c.tagName === 'SPAN' && c.children.length === 0)
  rows.subBadge = paint(badge)
  return rows
}

// ── §13 — capability / settings / browser chrome (M3/T3–T5) ──
window.__mountT3 = () => {
  const T3Mode = ({ children }) => {
    const mode = useThemeMode()
    return (
      <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
        <AntdApp>
          <SettingsProvider>
            <TranslationProvider initialLocale="zh">{children}</TranslationProvider>
          </SettingsProvider>
        </AntdApp>
      </ConfigProvider>
    )
  }
  const mk = (id, h) => {
    const el = document.createElement('div')
    el.id = id
    el.style.marginBottom = '16px'
    el.style.height = h
    document.body.appendChild(el)
    return el
  }
  const hosts = [mk('t3-capability', '520px'), mk('t3-settings', '600px'), mk('t3-browser', '420px')]
  const roots = hosts.map((h) => createRoot(h))
  roots[0].render(<T3Mode><CapabilityCenter /></T3Mode>)
  roots[1].render(<T3Mode><SettingsPage /></T3Mode>)
  roots[2].render(
    <T3Mode>
      <BrowserPaneChrome
        pane={{ visible: true, width: 420, conversationId: null, tabs: [{ id: 'tab-t1', url: 'https://example.com', title: '示例页', active: true }] }}
        onAction={() => {}}
      />
    </T3Mode>
  )
}

/** §13's reader: one or two key roles per surface — enough that a dark column
 *  that stopped carrying them fails here by name. */
window.__t3Vector = () => {
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    return { color: s.color, backgroundColor: s.backgroundColor }
  }
  const rows = {}
  const cap = document.getElementById('t3-capability')
  rows.capPageBg = paint(cap && cap.querySelector('.ant-app > div'))
  const activePill = cap && cap.querySelector('.pm-cap-pill-active')
  rows.capPillActive = paint(activePill)
  const settings = document.getElementById('t3-settings')
  rows.settingsSheet = paint(settings && settings.querySelector('.ant-app > div'))
  rows.settingsTab = paint(settings && settings.querySelector('[data-settings-menu="environment"]'))
  const browser = document.getElementById('t3-browser')
  rows.browserGround = paint(browser && browser.querySelector('.ant-app > div > div'))
  rows.browserTabActive = paint(browser && [...browser.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('--pm-tile-soft')))
  // the address bar is an <input>, not a div
  rows.browserAddress = paint(browser && [...browser.querySelectorAll('input')].find((d) => (d.getAttribute('style') || '').includes('--pm-wash-cool')))
  return rows
}

// ── §14 — the preview pane family (PLAN-dark-mode M4/T1–T3) ──────────────────
// One host per renderer, plus the pane in its three states (tabs, empty,
// element editing). Every preview reads its bytes through the bridge stub
// (window.__pmBinaries / __pmFiles, injected by the driver before the mount),
// so the real loaders run: exceljs parses the workbook, pdf.js the handcrafted
// PDF, docx-preview the zip, the pptx model the deck.
window.__mountT4 = () => {
  const T4Mode = ({ children }) => {
    const mode = useThemeMode()
    return (
      <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
        <AntdApp>
          <SettingsProvider>
            <TranslationProvider initialLocale="zh">{children}</TranslationProvider>
          </SettingsProvider>
        </AntdApp>
      </ConfigProvider>
    )
  }
  const mk = (id, h) => {
    const el = document.createElement('div')
    el.id = id
    el.style.marginBottom = '16px'
    el.style.height = h
    document.body.appendChild(el)
    return el
  }
  const roots = []
  const mount = (id, h, node) => {
    const el = mk(id, h)
    const r = createRoot(el)
    r.render(<T4Mode>{node}</T4Mode>)
    roots.push(r)
  }
  // The pane store: two tabs over the DRAFT key (PreviewPane with no
  // conversation id), the markdown one active — its content fails to load on
  // purpose (no readFile fixture), which lands the ErrorCard, itself migrated.
  usePreviewPaneStore.setState({
    tabsByConversation: {
      __draft__: [
        { path: '/w/报.md', title: '报.md' },
        { path: '/w/注.txt', title: '注.txt' },
      ],
    },
    activeByConversation: { __draft__: '/w/报.md' },
  })
  // The element panel's session: a selection on the h1 — enough for the full
  // chrome (crumbs, actions, AI row); resolveElementSmart may fail on the
  // synthetic pmPath, which only simplifies the typed controls.
  const pageText = '<html><body><h1 id="t">Hello</h1></body></html>'
  useHtmlEditStore.setState({
    sessions: {
      '/w/page.html': {
        fileText: pageText,
        originalText: pageText,
        selection: {
          pmPath: '1.4.0',
          tag: 'h1',
          rect: { x: 8, y: 8, w: 120, h: 32 },
          text: 'Hello',
          ancestors: [
            { pmPath: '1', tag: 'html', id: null, classes: [] },
            { pmPath: '1.4', tag: 'body', id: null, classes: [] },
            { pmPath: '1.4.0', tag: 'h1', id: 't', classes: [] },
          ],
          computed: { 'font-size': '16px', 'font-weight': '400' },
        },
        scrollY: 0,
        undo: [],
        pendingReselect: null,
        aiBusy: false,
        aiError: null,
      },
    },
  })
  mount('t4-pane', '300px', <PreviewPane conversationId={undefined} />)
  // A conversation id the store has no tabs for → the pane's empty state.
  mount('t4-pane-empty', '120px', <PreviewPane conversationId="probe-empty" />)
  mount('t4-xlsx', '260px', <XlsxPreview path="/w/表.xlsx" kind="office" reloadTick={0} />)
  mount('t4-pdf', '300px', <PdfPreview path="/w/文.pdf" kind="office" reloadTick={0} />)
  mount('t4-docx', '300px', <DocxPreview path="/w/文.docx" kind="office" reloadTick={0} />)
  mount('t4-pptx', '300px', <PptxPreview path="/w/片.pptx" kind="office" reloadTick={0} />)
  mount('t4-csv', '160px', <CsvPreview text={'名,量\\n甲,1\\n乙,2'} path="/w/单.csv" />)
  mount('t4-fallback', '160px', <FallbackCard path="/w/包.zip" kind="binary" />)
  mount('t4-element', '150px', <ElementEditPanel path="/w/page.html" />)
  mount('t4-element-hint', '60px', <ElementEditPanel path="/w/none.html" />)
}

/** §14's reader: the chrome surfaces of every preview, plus the registered
 *  mode-independent paper/data literals. Keys whose spec is a role must flip
 *  with the mode; keys whose spec is a literal must NOT. */
window.__t4Vector = () => {
  const pick = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = s[p]
    return o
  }
  const appRoot = (id) => {
    const host = document.getElementById(id)
    return host ? host.querySelector('.ant-app > div') : null
  }
  const v = {}
  const pane = appRoot('t4-pane')
  // PreviewPane's root renders a <style> element as its FIRST child, so the
  // rows start at index 1: [style, stripRow, toolbarRow, content].
  const tabActive = pane && pane.querySelector("[data-tab-path='/w/报.md']")
  const tabIdle = pane && pane.querySelector("[data-tab-path='/w/注.txt']")
  v.paneGround = pick(pane, ['backgroundColor'])
  v.tabActive = pick(tabActive, ['backgroundColor', 'boxShadow', 'color'])
  v.tabIdle = pick(tabIdle, ['color'])
  v.stripBorder = pick(tabActive && tabActive.parentElement.parentElement, ['borderBottomColor'])
  const toolRow = pane && pane.children[2]
  v.toolInk = pick(toolRow && toolRow.children[0], ['color'])
  v.pathInk = pick(toolRow && toolRow.children[3], ['color'])
  const content = pane && pane.children[3]
  v.errInk = pick(content && content.querySelector('div'), ['color'])
  const empty = appRoot('t4-pane-empty')
  v.emptyIcon = pick(empty && empty.children[0], ['color'])
  v.emptyHint = pick(empty && empty.children[1], ['color'])

  const xlsxRoot = appRoot('t4-xlsx')
  const grid = document.querySelector('#t4-xlsx [data-xlsx-grid]')
  const ths = grid ? grid.querySelectorAll('thead th') : []
  // Empty grid cells render <td> elements too (kind 'empty'), so position
  // arithmetic over td lists is fragile — the three cells we judge are picked
  // by their text, which the fixture makes unique ('标题' styled, '总计' plain,
  // '=NOPE()' the result-less formula; the gutter and column headers are th).
  const tdWithText = (t) => {
    if (!grid) return null
    return [...grid.querySelectorAll('tbody td')].find((td) => td.textContent === t) ?? null
  }
  v.sheetHeader = pick(ths[1], ['backgroundColor', 'color'])
  v.sheetDataFill = pick(tdWithText('标题'), ['backgroundColor'])
  v.sheetPlainInk = pick(tdWithText('总计'), ['color'])
  v.sheetFormulaInk = pick(tdWithText('=NOPE()'), ['color'])
  const sheetbar = document.querySelector('#t4-xlsx [data-xlsx-sheetbar]')
  v.sheetbarBorder = pick(sheetbar, ['borderTopColor'])
  v.sheetTabActive = pick(sheetbar && sheetbar.querySelector("[data-sheet='数据']"), ['backgroundColor', 'color'])
  v.sheetFooter = pick(xlsxRoot && xlsxRoot.lastElementChild, ['borderTopColor'])
  v.zoomLabel = pick(xlsxRoot && xlsxRoot.querySelector('[data-zoom-label]'), ['color'])

  const pdfRoot = appRoot('t4-pdf')
  v.pdfDesk = pick(document.querySelector('#t4-pdf [data-pdf-scroll]'), ['backgroundColor'])
  v.pdfPage = pick(document.querySelector('#t4-pdf [data-pdf-page="1"]'), ['backgroundColor', 'boxShadow'])
  v.pdfInput = pick(document.querySelector('#t4-pdf [data-pdf-page-input]'), ['color', 'borderBottomColor'])
  v.pdfTotal = pick(document.querySelector('#t4-pdf [data-pdf-page-input]') && document.querySelector('#t4-pdf [data-pdf-page-input]').nextElementSibling, ['color'])
  v.pdfFooter = pick(pdfRoot && pdfRoot.lastElementChild, ['borderTopColor'])

  const docxRoot = appRoot('t4-docx')
  v.docxDesk = pick(document.querySelector('#t4-docx .pm-docx-preview'), ['backgroundColor'])
  v.docxFooter = pick(docxRoot && docxRoot.lastElementChild, ['borderTopColor'])

  const pptxRoot = appRoot('t4-pptx')
  v.pptxNote = pick(pptxRoot && pptxRoot.children[0], ['color', 'backgroundColor', 'borderBottomColor'])
  v.pptxDesk = pick(document.querySelector('#t4-pptx .pm-pptx-scroll'), ['backgroundColor'])
  v.pptxSlide = pick(document.querySelector('#t4-pptx [data-pptx-slide="1"]'), ['backgroundColor'])
  v.pptxFooter = pick(pptxRoot && pptxRoot.lastElementChild, ['borderTopColor'])

  const csvRoot = appRoot('t4-csv')
  v.csvHead = pick(csvRoot && csvRoot.querySelector('th'), ['backgroundColor', 'color'])
  v.csvCell = pick(csvRoot && csvRoot.querySelector('td'), ['color', 'borderBottomColor'])

  const fbRoot = appRoot('t4-fallback')
  v.fallbackName = pick(fbRoot && fbRoot.children[0], ['color'])
  v.fallbackMeta = pick(fbRoot && fbRoot.children[1], ['color'])
  v.fallbackHint = pick(fbRoot && fbRoot.children[2], ['color'])

  const elRoot = appRoot('t4-element')
  const crumbRow = elRoot && elRoot.children[0]
  // The crumbs live in the row's FIRST child (the overflow wrap); the action
  // spans are its siblings — a plain span[title] walk would catch the
  // ActionIcons too (they carry titles as well).
  const crumbWrap = crumbRow && crumbRow.children[0]
  const crumbs = crumbWrap ? [...crumbWrap.querySelectorAll('span[title]')] : []
  v.crumbInk = pick(crumbs[crumbs.length - 1], ['color'])
  v.crumbChevron = pick(crumbWrap && crumbWrap.querySelector('svg'), ['color'])
  const actions = crumbRow ? [...crumbRow.children].filter((el) => el.tagName === 'SPAN') : []
  v.actionDisabled = pick(actions[0], ['color'])
  v.actionNormal = pick(actions[1], ['color'])
  v.actionDanger = pick(actions[2], ['backgroundColor', 'borderBottomColor', 'color'])
  const aiBtn = elRoot && elRoot.querySelector('button')
  v.aiBtn = pick(aiBtn, ['backgroundColor', 'color'])
  v.aiSparkle = pick(elRoot && elRoot.querySelector('.ant-input-affix-wrapper svg'), ['color'])

  const hintRoot = appRoot('t4-element-hint')
  v.hintBar = pick(hintRoot, ['backgroundColor', 'color', 'borderTopColor'])
  return v
}

// ── §15 — the workbench shell ─────────────────────────────────────────────────
// Three mounts, one host each: the pane (its frame + tool-tab strip), the
// workspace tree (path bar + one row's buttons), the text editor. Tabs and the
// path bar are found structurally/by label, not by index — the strip is the
// pane root's SECOND child (the drag handle is the first), which is a fact of
// the JSX, not a contract.
window.__mountWB = () => {
  const WBMode = ({ children }) => {
    const mode = useThemeMode()
    return (
      <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
        <AntdApp>
          <SettingsProvider>
            <TranslationProvider initialLocale="zh">{children}</TranslationProvider>
          </SettingsProvider>
        </AntdApp>
      </ConfigProvider>
    )
  }
  const mk = (id, h) => {
    const el = document.createElement('div')
    el.id = id
    el.style.cssText = 'position: relative; height: ' + h + 'px; width: 420px; margin-bottom: 16px;'
    document.body.appendChild(el)
    return el
  }
  // The pane needs one conversation open (persisted store — forced here), a
  // plan with two nodes (工作计划's link-blue progress badge) and a browser tab
  // (浏览器's muted count badge) so both badge roles have an element to ride.
  useWorkbenchStore.setState({ openByConversation: { 'wb-conv': true }, activeTab: 'files', width: 420 })
  createRoot(mk('wb-shell', 300)).render(
    <WBMode>
      <WorkbenchPane
        conversationId="wb-conv"
        chatAreaWidth={800}
        plan={{ nodes: [{ status: 'completed' }, { status: 'pending' }] }}
        browserPane={{ visible: false, width: 420, conversationId: null, tabs: [{ id: 'bt1', title: '示例页', url: 'about:blank' }] }}
        onPlanJump={() => {}}
        onOpenPlanNode={() => {}}
        canOpenNode={() => false}
        onBrowserAction={() => {}}
        onBrowserWidth={() => {}}
      />
    </WBMode>
  )
  // The tree's root dir comes from the preview store; its rows from the
  // listDir stub the INIT script installed.
  usePreviewPaneStore.setState({ workspaceDir: '/w/工作区' })
  createRoot(mk('wb-tree', 200)).render(<WBMode><WorkspaceTree conversationId="wb-conv" /></WBMode>)
  createRoot(mk('wb-editor', 120)).render(<WBMode><FileEditor value="hello" onChange={() => {}} onSave={() => {}} /></WBMode>)
}

window.__wbVector = () => {
  const pick = (el, props) => {
    if (!el) return null
    const s = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = s[p]
    return o
  }
  const v = {}
  const pane = document.querySelector('#wb-shell .ant-app > div')
  v.paneGround = pick(pane, ['backgroundColor', 'borderLeftColor'])
  const strip = pane && pane.children[1]
  v.stripGround = pick(strip, ['backgroundColor', 'borderBottomColor'])
  const tabsRow = strip && strip.children[0]
  const tabByLabel = (label) => tabsRow && [...tabsRow.children].find((d) => d.textContent && d.textContent.indexOf(label) >= 0)
  v.tabActive = pick(tabByLabel('文件预览'), ['backgroundColor', 'boxShadow', 'color'])
  v.tabIdle = pick(tabByLabel('工作区'), ['color'])
  const badgeOf = (tab) => (tab && tab.children.length > 1 ? tab.children[1] : null)
  v.badgeCount = pick(badgeOf(tabByLabel('浏览器')), ['backgroundColor'])
  v.badgePlan = pick(badgeOf(tabByLabel('工作计划')), ['backgroundColor'])
  v.closeInk = pick(strip && strip.children[1], ['color'])

  const treeHost = document.getElementById('wb-tree')
  const pathBar = treeHost && [...treeHost.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').indexOf('--pm-separator-faint') >= 0)
  v.wsPathBar = pick(pathBar, ['borderBottomColor'])
  v.wsPathText = pick(pathBar && [...pathBar.children].find((d) => d.tagName === 'SPAN'), ['color'])
  v.wsBtnInk = pick(treeHost && treeHost.querySelector('.pm-ws-btn'), ['color'])

  v.editorInk = pick(document.querySelector('#wb-editor textarea'), ['color', 'backgroundColor'])
  return v
}

// ── §16 — the assistant column's chat card ───────────────────────────────────
// The two form assistants (任务助手 in the routine editor, 专家创建助手 in the
// expert editor) do NOT put the transcript on the ground the chat uses: the
// shared FormAssistColumn renders the chat's own TranscriptView inside
// EDITOR_CHAT_CARD, whose dark ground is --pm-card (#262626) — and the user
// bubble is --pm-sunk, which in the dark column was ALSO #262626. The bubble
// therefore had no visible fill at all (user report 2026-09-21: 「深色模式下，
// 在各种助手中，用户输入的消息的气泡，看不到背景色了，是不是和对话区的背景色
// 相同导致的」 — the hypothesis was right). Light was never affected: the card is
// #ffffff there and the bubble #f0f2f4.
// §10 already reads the editor trio, but as three bare boxes: a card with no
// transcript in it cannot show this. This section mounts the real column, so the
// reading is of the COMPOSITE the user sees — the bubble's fill against the
// ground it is actually painted on (found by walking up to the first ancestor
// that paints, not by trusting a nesting the JSX may change) — plus the tool
// card header's two fills, which sit on the same ground and are the only other
// pair in the transcript that could vanish into it (rest --pm-fill is below the
// card's ground in dark, hover --pm-fill-hover was the same #262626).
const ASSIST_MESSAGES = [
  user('帮我建一个每天早上的采集任务'),
  assistant('as1', [
    { type: 'text', text: '好，先把这一步写进任务文件。' },
    { type: 'tool_use', id: 'as-t1', name: 'write', status: 'completed', exitCode: 0, input: { file_path: 'routine.json', content: '{}', description: '写入任务文件' }, output: 'wrote routine.json' },
  ]),
]
/** A FormAssistSession literal: the column's props are what this section is
 *  about, and the real session hook would need a ws-hosted engine to mount. */
const ASSIST_SESSION = {
  messages: ASSIST_MESSAGES,
  agentStatus: { status: 'completed' },
  streamingBlocks: [],
  isBusy: false,
  restoring: false,
  appliedPatch: null,
  clearAppliedPatch: () => {},
  send: () => {},
  cancel: () => {},
  engineCall: () => {},
  refreshOptions: () => {},
  approvalMode: 'outside-ask',
  setApprovalMode: () => {},
}
function AssistHarness() {
  const mode = useThemeMode()
  return (
    <ConfigProvider locale={zhCN} theme={buildAntdTheme(mode)}>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            {/* The editors' own composition (RoutineEditorPage / ExpertEditor):
                the grey EDITOR_SURFACE with the column's card inside it. The
                explicit height is what gives the transcript a scrollport. */}
            <div id="assist-case" style={{ padding: 24, background: 'var(--pm-bg)', height: 460 }}>
              <div style={EDITOR_SURFACE}>
                <FormAssistColumn
                  session={ASSIST_SESSION}
                  title="任务助手"
                  placeholder="描述你要建的任务…"
                  onSendMessage={() => {}}
                />
              </div>
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
}
window.__mountAssist = () => {
  const host = document.createElement('div')
  host.id = 'assist-host'
  document.body.appendChild(host)
  createRoot(host).render(<AssistHarness />)
}

window.__assistVector = () => {
  const host = document.getElementById('assist-host')
  const q = (sel) => (host ? host.querySelector(sel) : null)
  const paint = (el) => {
    if (!el) return null
    const s = getComputedStyle(el)
    return { backgroundColor: s.backgroundColor, color: s.color }
  }
  // The user row is the transcript's right-aligned flex row (§5's selector); its
  // first element child is the bubble MessageGroup paints --pm-sunk on.
  const row = q('div[style*="justify-content: flex-end"]')
  const bubble = row ? row.firstElementChild : null
  // The ground is whatever the bubble is actually painted ON: the nearest
  // ancestor with a non-transparent fill. Walking up beats naming the card's own
  // element, because this section's whole point is that the two are too close.
  const groundOf = (el) => {
    let p = el ? el.parentElement : null
    while (p && p !== document.body) {
      const bg = getComputedStyle(p).backgroundColor
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return p
      p = p.parentElement
    }
    return null
  }
  const ground = groundOf(bubble)
  const head = q('[data-tool-head="as-t1"]')
  // Mean |ΔRGB| between two computed colours — the reading the eye makes. Kept in
  // the page so the check table has one number per pair rather than six channels.
  const rgb = (s) => {
    const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(s || '')
    return m ? [+m[1], +m[2], +m[3]] : null
  }
  const delta = (a, b) => {
    const x = rgb(a)
    const y = rgb(b)
    if (!x || !y) return null
    return Math.round((Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2])) / 3)
  }
  const bubbleBg = bubble ? getComputedStyle(bubble).backgroundColor : null
  const groundBg = ground ? getComputedStyle(ground).backgroundColor : null
  const headBg = head ? getComputedStyle(head).backgroundColor : null
  const lum = (s) => {
    const x = rgb(s)
    return x ? (x[0] + x[1] + x[2]) / 3 : null
  }
  return {
    bubble: paint(bubble),
    ground: paint(ground),
    toolHead: paint(head),
    bubbleVsGround: delta(bubbleBg, groundBg),
    headVsGround: delta(headBg, groundBg),
    // Which way the bubble sits off its ground: +1 means lighter (the dark
    // column's "recessed one step", inverted), -1 darker (the light reading).
    bubbleIsLighter: lum(bubbleBg) === null || lum(groundBg) === null ? null : (lum(bubbleBg) > lum(groundBg) ? 1 : -1),
  }
}

/** The tool block's header, read live: the check hovers it with a REAL cursor
 *  (Playwright) and then asks for this, because the header animates its fill
 *  with transition: background 0.15s — a reading taken in the same tick as the
 *  event is the OLD value, i.e. a reading of the tween, not of the hover. */
window.__assistHead = () => {
  const head = document.querySelector('#assist-host [data-tool-head="as-t1"]')
  if (!head) return null
  return { backgroundColor: getComputedStyle(head).backgroundColor }
}

window.__ready = true
`
await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'harness.tsx' },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome114',
  outfile: OUT, tsconfig: 'tsconfig.web.json', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"0.0.0-probe"' },
  // §14: PdfPreview's Vite-style worker import (see WORKER_SHIM above).
  alias: { 'pdfjs-dist/build/pdf.worker.min.mjs?url': WORKER_SHIM },
  // THE difference from every other probe: CSS is compiled, not inert text, so
  // the emitted harness.css carries the real cascade. Fonts stay text — the
  // katex/antd webfonts are dead weight and no assertion touches a glyph. The
  // welcome logo is a real PNG import, so it needs a loader of its own (a data
  // URL: the page has an http origin, and §7 only ever reads the img's `filter`,
  // which computes whether or not the bytes decode).
  loader: { '.css': 'css', '.png': 'dataurl', '.ttf': 'text', '.woff': 'text', '.woff2': 'text' },
  logLevel: 'warning', treeShaking: false,
})

if (!existsSync(OUT_CSS)) {
  console.error('FAIL: esbuild emitted no stylesheet — the CSS loader is not in effect')
  process.exit(1)
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
// A React render that throws is logged, not re-thrown (production build), so the
// console is the only place a failed mount shows up — §16's own first run died
// here with a timeout and nothing else to go on.
page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console error]', msg.text().slice(0, 300)) })
// A real http origin rather than setContent: an opaque about:blank origin denies
// the localStorage the theme mirror reaches for.
const PAGE = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
// §14: the real pdf.js worker, same-origin so PdfPreview's loader runs its
// normal path (probe-pdf-preview's route, same body).
await page.route('**/pdf.worker.min.mjs', async (route) => {
  await route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')) })
})
// Before goto, so the stub is in place before the bundle's module bodies run.
await page.addInitScript({ content: INIT_SCRIPT })
await page.goto('http://pm-probe.local/')
await page.addStyleTag({ path: OUT_CSS })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)
await page.waitForFunction(() => document.querySelectorAll('div.x-markdown-light, div.x-markdown-dark').length === 3)

// Read settled values, never a transition in flight. The theme animates
// background-color on blockquote (light.css:150, transition: .2s ease), and a
// flip read immediately after the class swap returns the PREVIOUS mode's color —
// measured: 205/255 of the way through, which would have failed this probe on
// correct code. Nothing here asserts motion, so it is switched off inside the
// fixture roots — scoped there on purpose, not document-wide: antd's Modal
// portals to the body, and rc-motion's leave needs a real transitionend, so a
// global kill leaves every closed modal stuck at ant-zoom-leave (measured).
await page.addStyleTag({ content: '#root *, #layer *, #input-layer *, #chrome *, #code *, #shell-host *, #extras-host *, #welcome-data *, #welcome-empty-host *, #welcome-projects-host *, #t2-graph *, #t2-routine *, #t2-sub *, #t3-capability *, #t3-settings *, #t3-browser *, #t4-pane *, #t4-pane-empty *, #t4-xlsx *, #t4-pdf *, #t4-docx *, #t4-pptx *, #t4-csv *, #t4-fallback *, #t4-element *, #t4-element-hint * { transition: none !important; animation: none !important; }' })

const dump = process.argv.includes('--dump')
const vec = () => page.evaluate(() => window.__vector())
const show = (o) => JSON.stringify(o)

// ── 1. the theme layer, its order, and whether the order matters ──────────────
console.log('\n=== 1. 主题层与层序 ===')
const sheetText = await page.evaluate(() => window.__sheetText())
check('light.css 的变量块在页面里', sheetText.includes('--table-head-bg: rgba(250, 250, 250, 1)') || sheetText.includes('rgba(250, 250, 250, 1)'))
check('dark.css 的变量块在页面里', sheetText.includes('rgba(29, 29, 29, 1)'))

const order = await page.evaluate(() => window.__layerOrder())
check('基类排在主题层之前（旧应用的层序，由 App.tsx 显式钉住）', order.base < order.theme && order.base >= 0, `base@${order.base} theme@${order.theme}`)

const lightVec = await vec()
const LIGHT = JSON.parse(JSON.stringify(lightVec))
if (dump) {
  console.log('  [dump] light =', JSON.stringify(LIGHT, null, 1))
}

// The two layers disagree on exactly one declaration pair, and source order
// decides it: both `.x-markdown-light li` (theme) and `.x-markdown li` (base)
// set `margin` at specificity (0,1,1). Appending a whole sheet at the end of the
// document therefore simulates the other order — and the two orders must NOT
// agree, or App.tsx's explicit base import would be doing nothing.
//
// Whole sheets, not a rule-level copy: splitting the emitted CSS per rule also
// reorders rules *inside* a family, which is a different experiment (light.css
// declares `.x-markdown-light li` twice — the group rule's `margin`, then
// `position: relative` — so a rule-level copy measures that instead).
const THEME_FILES = [
  readFileSync('node_modules/@ant-design/x-markdown/themes/light.css', 'utf8'),
  readFileSync('node_modules/@ant-design/x-markdown/themes/dark.css', 'utf8'),
]
const BASE_FILE = readFileSync('node_modules/@ant-design/x-markdown/es/XMarkdown/index.css', 'utf8')

// (a) theme appended = theme wins every tie = what the app renders today. The
// vector must not move: this is the pre-dark-mode rendering, reproduced.
for (const [i, text] of THEME_FILES.entries()) {
  await page.evaluate(([t, id]) => window.__appendSheet(t, id), [text, `pm-reorder-${i}`])
}
const afterThemeLast = await vec()
const themeLastDiff = diffVector(LIGHT, afterThemeLast)
check('层序等价：主题层胜出时取值与现状逐项一致（旧应用的渲染）', themeLastDiff.length === 0, themeLastDiff.length ? themeLastDiff.slice(0, 6).join(' | ') : `${Object.keys(afterThemeLast).length} 组`)
for (const i of THEME_FILES.keys()) await page.evaluate((id) => window.__removeSheet(id), `pm-reorder-${i}`)

// (b) base appended = base wins the tie = the order the hoisted imports
// produced by accident. `li`'s margins are the whole difference, and they are a
// visible one (14px of air between list items, or none).
await page.evaluate((t) => window.__appendSheet(t, 'pm-reorder-base'), BASE_FILE)
const afterBaseLast = await vec()
const baseLastDiff = diffVector(LIGHT, afterBaseLast)
const isLiMargin = (d) => /^li(First)?\.margin/.test(d)
const liMoved = baseLastDiff.some(isLiMargin)
check('非空对照：层序反了就会变——li 的上下外边距', liMoved, baseLastDiff.slice(0, 4).join(' | ') || '逐项相同（层序没被真的翻转）')
check('翻转只动 li 的 margin，别的取值都不动', baseLastDiff.length > 0 && baseLastDiff.every(isLiMargin), baseLastDiff.length ? `${baseLastDiff.length} 项：${baseLastDiff.slice(0, 8).join(' | ')}` : '逐项相同（层序没被真的翻转）')
await page.evaluate(() => window.__removeSheet('pm-reorder-base'))

// The canary: a modified sheet at the same position MUST move the vector, or the
// check above is passing because the read sees nothing.
await page.evaluate(() => window.__appendSheet('.x-markdown-light h2 { color: rgb(1, 2, 3) !important; }', 'pm-canary'))
const afterCanary = await vec()
const canaryMoved = afterCanary.h2.color === 'rgb(1, 2, 3)'
check('非空对照：改动版主题表能改变取值', canaryMoved, `h2 color = ${afterCanary.h2.color}`)
await page.evaluate(() => window.__removeSheet('pm-canary'))

const wrapInfo = await page.evaluate(() => window.__wrapInfo())
check('三个 markdown 外层（用户/助手/流式）都带主题类', wrapInfo.length === 3 && wrapInfo.every((w) => w.cls === 'x-markdown-light'), show(wrapInfo.map((w) => w.cls)))
check('主题类挂在外层 div、.x-markdown 在它里面', wrapInfo.every((w) => w.hasRoot && w.rootInside))

// The theme styles links (`a` + its `↗` marker), but the chat never renders an
// anchor: a markdown link becomes a card component. Recorded so the dark review
// does not chase a rule that cannot fire — the card's own ink is a chat concern.
const linkCard = await page.evaluate(() => {
  const p = document.querySelectorAll('div.x-markdown-light, div.x-markdown-dark')[1].querySelector('p')
  return { anchors: p.querySelectorAll('a').length, card: !!p.querySelector('span[style*="inline-flex"]') }
})
check('链接渲染成卡片而非 <a>（主题的 a 规则在对话里不生效）', linkCard.anchors === 0 && linkCard.card, `a=${linkCard.anchors} card=${linkCard.card}`)

// The known dead value: base declares --margin-pre on the .x-markdown root
// (nearer than the wrapper), so the theme's own `0 0 16px 0` never applies.
check('pre 的 margin 是基类的 1em 0，不是主题的 0 0 16px 0', lightVec.pre.marginTop === '14px' && lightVec.pre.marginBottom === '14px', `${lightVec.pre.marginTop}/${lightVec.pre.marginBottom}`)

// ── 2. the frozen light vector ────────────────────────────────────────────────
console.log('\n=== 2. 浅色冻结值（旧应用的取值） ===')
const LIGHT_EXPECT = {
  // The bottom margins are the base layer's variables, not the theme's: base
  // declares --margin-block / --margin-li on the .x-markdown root (nearer than
  // the wrapper), so 1em of each element's own font-size decides and the theme's
  // 16px/14px never apply. h2 is 20px, p 14px.
  //
  // li is the one element where the two layers disagree on the *declaration*
  // (both `margin` at specificity 0,1,1), so its margins come from whichever
  // sheet is last: 0 top / 14px bottom with the base first — the order this app
  // has always had, and the one App.tsx now names explicitly (§1.3).
  h2: { color: 'rgb(0, 0, 0)', fontSize: '20px', lineHeight: '32px', fontWeight: '600', marginBottom: '20px' },
  p: { color: 'rgba(0, 0, 0, 0.85)', marginBottom: '14px' },
  li: { color: 'rgba(0, 0, 0, 0.85)', marginTop: '0px', marginBottom: '14px' },
  liFirst: { marginTop: '0px', marginBottom: '14px' },
  codeInline: { backgroundColor: 'rgba(0, 0, 0, 0.04)', color: 'rgba(0, 0, 0, 0.85)', paddingTop: '2px', paddingLeft: '6px', borderRadius: '4px' },
  pre: { marginTop: '14px', marginBottom: '14px' },
  codeBlock: { backgroundColor: 'rgba(0, 0, 0, 0.04)', color: 'rgba(0, 0, 0, 0.85)', paddingTop: '16px', paddingLeft: '16px', borderRadius: '6px', display: 'block' },
  thead: { backgroundColor: 'rgb(250, 250, 250)' },
  tbody: { backgroundColor: 'rgb(255, 255, 255)' },
  th: { color: 'rgb(0, 0, 0)' },
  td: { color: 'rgba(0, 0, 0, 0.85)' },
  blockquote: { backgroundColor: 'rgba(0, 0, 0, 0.1)', borderLeftColor: 'rgb(240, 240, 240)', borderLeftWidth: '4px' },
  // 21px = base's `--hr-margin: 1.5em 0` at 14px, not the theme's own 24px — the same
  // nearer-declaration shadowing as --margin-pre above.
  hr: { borderTopColor: 'rgba(5, 5, 5, 0.06)', borderTopWidth: '1px', marginTop: '21px' },
}
for (const [role, expected] of Object.entries(LIGHT_EXPECT)) {
  const got = LIGHT[role]
  if (!got) { check(`light ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`light ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}

// ── 3. the dark flip ──────────────────────────────────────────────────────────
console.log('\n=== 3. 深色切换 ===')
await page.evaluate(() => window.__setMode('dark'))
await page.waitForFunction(() => document.querySelectorAll('div.x-markdown-dark').length === 3)
check('html[data-theme=dark]', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
const darkWrapInfo = await page.evaluate(() => window.__wrapInfo())
check('三个外层 div 的类名切到 x-markdown-dark', darkWrapInfo.every((w) => w.cls === 'x-markdown-dark'), show(darkWrapInfo.map((w) => w.cls)))

const darkVec = await vec()
if (dump) console.log('  [dump] dark =', JSON.stringify(darkVec, null, 1))
const DARK_EXPECT = {
  h2: { color: 'rgb(255, 255, 255)' },
  p: { color: 'rgba(255, 255, 255, 0.85)' },
  li: { color: 'rgba(255, 255, 255, 0.85)' },
  codeInline: { backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.85)' },
  codeBlock: { backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.85)' },
  thead: { backgroundColor: 'rgb(29, 29, 29)' },
  tbody: { backgroundColor: 'rgb(20, 20, 20)' },
  th: { color: 'rgb(255, 255, 255)' },
  td: { color: 'rgba(255, 255, 255, 0.85)' },
  blockquote: { backgroundColor: 'rgba(255, 255, 255, 0.1)', borderLeftColor: 'rgb(48, 48, 48)' },
  hr: { borderTopColor: 'rgba(253, 253, 253, 0.12)' },
}
for (const [role, expected] of Object.entries(DARK_EXPECT)) {
  const got = darkVec[role]
  if (!got) { check(`dark ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`dark ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}

// Colors only: a mode flip must not move a single layout number.
const geoDiff = diffVector(LIGHT, darkVec, LAYOUT)
check('深色只改颜色：几何与浅色逐项相同', geoDiff.length === 0, geoDiff.length ? geoDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 4. non-vacuity and the round trip ─────────────────────────────────────────
console.log('\n=== 4. 非空验证与往返 ===')
const swapped = await page.evaluate(() => window.__swapClass('x-markdown-light'))
const swappedVec = await vec()
check('类名就是开关：深色下换回 light 类，取值回到浅色', swapped === 'x-markdown-light' && swappedVec.h2.color === 'rgb(0, 0, 0)' && swappedVec.thead.backgroundColor === 'rgb(250, 250, 250)', `h2 = ${swappedVec.h2.color}`)
await page.evaluate(() => window.__swapClass('x-markdown-dark'))

const darkStream = await page.evaluate(() => window.__streamColor())
check('--pm-* 通路：深色下流式文本取到 --pm-text-strong 的深色值', darkStream === 'rgb(236, 236, 236)', darkStream)

await page.evaluate(() => window.__setMode('light'))
const lightStream = await page.evaluate(() => window.__streamColor())
check('--pm-* 通路：浅色下 = rgb(51, 51, 51)，即迁移前的字面量 #333', lightStream === 'rgb(51, 51, 51)', lightStream)

// The negative control for the whole `var(--pm-*)` migration: a variable that is
// never defined resolves to nothing, which for `color` means "inherit" — so a
// component migrated to a variable while the sheet is missing looks plausible and
// is wrong. Removing the sheet must therefore move this reading.
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
const noSheet = await page.evaluate(() => window.__streamColor())
check('非空对照：摘掉变量表后该取值失效', noSheet !== 'rgb(51, 51, 51)' && noSheet !== 'rgb(236, 236, 236)', `实得 ${noSheet}`)
await page.evaluate(() => window.__installVars())

const backVec = await vec()
const roundDiff = diffVector(LIGHT, backVec)
check('往返：回到浅色后向量与第 2 节逐项一致', roundDiff.length === 0, roundDiff.length ? roundDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 5. the message layer (M2/T2) ──────────────────────────────────────────────
// The migration's contract is byte-identity in light: every `var(--pm-*)` the
// message layer now reads has to resolve to the literal it replaced. That cannot
// be read off the palette — a variable defined on `:root` and read from a
// component is a cascade, and an unset one resolves to nothing at all.
console.log('\n=== 5. 消息层（M2/T2 迁移面） ===')
await page.evaluate(() => window.__mountLayer())
await page.waitForFunction(() => !!document.querySelector('[data-approval-area]'))
await page.waitForTimeout(150)

/** The collapsed state, then the same tree with the segment opened by hand: the
 *  tool cards and their amber header only exist in the second, the approval area
 *  only in the first. Both states are read in each mode. */
async function layerStates() {
  const collapsed = await page.evaluate(() => window.__layerVector())
  const homeCollapsed = await page.evaluate(() => window.__areaHome())
  await page.locator('[data-segment-head]').first().click()
  await page.waitForFunction(() => !!document.querySelector('[data-tool-head="t1"]'))
  const expanded = await page.evaluate(() => window.__layerVector())
  const homeExpanded = await page.evaluate(() => window.__areaHome())
  await page.locator('[data-segment-head]').first().click()
  await page.waitForFunction(() => !!document.querySelector('[data-approval-area]'))
  return { collapsed, expanded, homeCollapsed, homeExpanded }
}
const flat = (states) => {
  const out = {}
  for (const state of ['collapsed', 'expanded']) {
    for (const [role, paint] of Object.entries(states[state])) if (paint) out[`${state}.${role}`] = paint
  }
  return out
}

const LAYER_LIGHT = await layerStates()
const LIGHT_LAYER = flat(LAYER_LIGHT)
if (dump) console.log('  [dump] layer light =', JSON.stringify(LIGHT_LAYER, null, 1))

// Every value here is the literal the component carried before the migration
// (`git show HEAD:<file>`), which is the whole point of D3: a user on the light
// theme must not be able to tell that dark mode shipped.
const LAYER_LIGHT_EXPECT = {
  // #fff, the chat ground the harness itself paints
  'collapsed.ground': { backgroundColor: 'rgb(255, 255, 255)' },
  // MessageGroup's user bubble, #f0f2f4
  'collapsed.userBubble': { backgroundColor: 'rgb(240, 242, 244)' },
  // the held-approval surface: #fff7e6 ground, #ffd591 border, #d46b08 ink
  'collapsed.approvalArea': { backgroundColor: 'rgb(255, 247, 230)', borderTopColor: 'rgb(255, 213, 145)' },
  'collapsed.heldHint': { color: 'rgb(212, 107, 8)' },
  // ask_user: the light card in the terminal family — #f5f5f5 ground, #000 ink
  'collapsed.askUserCard': { backgroundColor: 'rgb(245, 245, 245)', color: 'rgb(0, 0, 0)' },
  'collapsed.askUserPrompt': { color: 'rgb(0, 0, 0)' },
  // the streaming caret, #000
  'collapsed.caret': { backgroundColor: 'rgb(0, 0, 0)' },
  // the thinking block's rule, #d0d0d0
  'collapsed.thinkingRoot': { borderLeftColor: 'rgb(208, 208, 208)' },
  // the streaming answer's two inks: the markdown half #333, the tool half #555
  'collapsed.streamMd': { color: 'rgb(51, 51, 51)' },
  'collapsed.streamTool': { color: 'rgb(85, 85, 85)' },
  // opened by hand: the held card is amber (#fff7e6 / #ffd591), the settled one
  // grey (#f5f5f5) on a transparent border, inside the #e8e8e8 body frame
  'expanded.heldHead': { backgroundColor: 'rgb(255, 247, 230)', borderTopColor: 'rgb(255, 213, 145)' },
  'expanded.doneHead': { backgroundColor: 'rgb(245, 245, 245)', borderTopColor: 'rgba(0, 0, 0, 0)' },
  'expanded.expandedFrame': { borderTopColor: 'rgb(232, 232, 232)' },
  // the folded tool_result box: #f6f8fa on a #e8e8e8 frame
  'collapsed.resultWell': { backgroundColor: 'rgb(246, 248, 250)', borderTopColor: 'rgb(232, 232, 232)' },
}
for (const [role, expected] of Object.entries(LAYER_LIGHT_EXPECT)) {
  const got = LIGHT_LAYER[role]
  if (!got) { check(`light ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`light ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
// The two states must not be able to show a decision at once: that is the M2.4
// rule the migration must not have disturbed. Opening the segment moves the pair
// *into* the held card rather than adding a second one.
check('浅色：收起时审批区挂在执行段上、工具卡不在屏', LAYER_LIGHT.homeCollapsed === 'segment' && !LIGHT_LAYER['collapsed.heldHead'], `home=${LAYER_LIGHT.homeCollapsed}`)
check('浅色：展开后审批区移入工具卡、执行段上不再有', LAYER_LIGHT.homeExpanded === 'card', `home=${LAYER_LIGHT.homeExpanded}`)

// The thinking <pre> only exists while its block is open, so it is read here:
// #f6f6f6 ground, #555 ink.
await page.locator('[data-case="thinking"] > div').click()
await page.waitForFunction(() => !!document.querySelector('[data-case="thinking"] pre'))
const lightPre = await page.evaluate(() => {
  const el = document.querySelector('[data-case="thinking"] pre')
  const s = getComputedStyle(el)
  return { backgroundColor: s.backgroundColor, color: s.color }
})
check('light thinking <pre> = #f6f6f6 / #555', lightPre.backgroundColor === 'rgb(246, 246, 246)' && lightPre.color === 'rgb(85, 85, 85)', `${lightPre.backgroundColor} / ${lightPre.color}`)

// ── 5.1 the dark counterparts ────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('dark'))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
const DARK_LAYER = flat(await layerStates())
if (dump) console.log('  [dump] layer dark =', JSON.stringify(DARK_LAYER, null, 1))
const LAYER_DARK_EXPECT = {
  'collapsed.ground': { backgroundColor: 'rgb(20, 20, 20)' },
  'collapsed.userBubble': { backgroundColor: 'rgb(51, 51, 51)' },
  'collapsed.approvalArea': { backgroundColor: 'rgb(43, 33, 17)', borderTopColor: 'rgb(124, 89, 20)' },
  'collapsed.heldHint': { color: 'rgb(216, 150, 20)' },
  'collapsed.askUserCard': { backgroundColor: 'rgb(31, 31, 31)', color: 'rgb(230, 230, 230)' },
  'collapsed.askUserPrompt': { color: 'rgb(230, 230, 230)' },
  'collapsed.caret': { backgroundColor: 'rgb(230, 230, 230)' },
  'collapsed.thinkingRoot': { borderLeftColor: 'rgb(77, 77, 77)' },
  'collapsed.streamMd': { color: 'rgb(236, 236, 236)' },
  'collapsed.streamTool': { color: 'rgb(194, 194, 194)' },
  'expanded.heldHead': { backgroundColor: 'rgb(43, 33, 17)', borderTopColor: 'rgb(124, 89, 20)' },
  'expanded.doneHead': { backgroundColor: 'rgb(31, 31, 31)', borderTopColor: 'rgba(0, 0, 0, 0)' },
  'expanded.expandedFrame': { borderTopColor: 'rgb(51, 51, 51)' },
  'collapsed.resultWell': { backgroundColor: 'rgb(15, 15, 15)', borderTopColor: 'rgb(51, 51, 51)' },
}
for (const [role, expected] of Object.entries(LAYER_DARK_EXPECT)) {
  const got = DARK_LAYER[role]
  if (!got) { check(`dark ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`dark ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
// No pinned value may survive the flip — the negative half of byte-identity.
// Compared over exactly the properties the light table pins, so a role whose
// vector carries an unpinned inherited value (a border color on a box with no
// border, say) cannot report a false positive.
const survived = []
for (const [role, expected] of Object.entries(LAYER_LIGHT_EXPECT)) {
  const l = LIGHT_LAYER[role]
  const d = DARK_LAYER[role]
  if (!l || !d) continue
  for (const p of Object.keys(expected)) if (l[p] === d[p]) survived.push(`${role}.${p}`)
}
// The one value that is mode-independent by design: the settled tool card's
// border is `transparent` (its pre-migration literal) so the card's box metrics
// match the held card's amber one — there is no color there to flip. It computes
// as rgba(0, 0, 0, 0) in both modes, which is what makes it look like a survivor.
// Registered rather than skipped, and the comparison runs both ways: a NEW
// survivor fails here, and so does an entry that stops being mode-independent.
const MODE_INDEPENDENT = ['expanded.doneHead.borderTopColor']
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
check(
  '深色下被钉住的每个取值都翻转了（模式无关项须显式登记）',
  same(survived, MODE_INDEPENDENT),
  `survivors=${survived.join(', ') || '无'} / registered=${MODE_INDEPENDENT.join(', ')}`
)

const darkGeoDiff = diffVector(LIGHT_LAYER, DARK_LAYER, LAYOUT)
check('消息层深色只改颜色：几何与浅色逐项相同', darkGeoDiff.length === 0, darkGeoDiff.length ? darkGeoDiff.slice(0, 6).join(' | ') : '全部一致')

const darkPre = await page.evaluate(() => {
  const el = document.querySelector('[data-case="thinking"] pre')
  const s = getComputedStyle(el)
  return { backgroundColor: s.backgroundColor, color: s.color }
})
check('dark thinking <pre> = #101010 / #c2c2c2', darkPre.backgroundColor === 'rgb(16, 16, 16)' && darkPre.color === 'rgb(194, 194, 194)', `${darkPre.backgroundColor} / ${darkPre.color}`)

// ── 5.2 non-vacuity: the readings come from the sheet, not from a fallback ───
// The same negative control §4 runs for the streaming color, now over the whole
// message layer: with the sheet gone, `background: var(--pm-fill)` resolves to
// nothing and the box paints transparent — which is what a probe would be
// measuring if the helper had been forgotten.
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.waitForTimeout(50)
const noVars = flat(await layerStates())
const emptied = ['collapsed.userBubble', 'collapsed.approvalArea', 'collapsed.askUserCard', 'expanded.heldHead']
  .filter((role) => noVars[role] && (noVars[role].backgroundColor === 'rgba(0, 0, 0, 0)' || noVars[role].backgroundColor === 'transparent'))
check('非空对照：摘掉变量表后迁移面全部失去底色', emptied.length === 4, emptied.join(', ') || '底色还在（变量不是取值的来源）')
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
const restored = flat(await layerStates())
const restoreDiff = diffVector(DARK_LAYER, restored)
check('往返：装回变量表后与 5.1 逐项一致', restoreDiff.length === 0, restoreDiff.length ? restoreDiff.slice(0, 6).join(' | ') : '全部一致')
await page.evaluate(() => window.__setMode('light'))

// ── 6. the input layer (M2/T3) ───────────────────────────────────────────────
console.log('\n=== 6. 输入层（M2/T3 迁移面） ===')
await page.evaluate(() => window.__mountInput())
await page.waitForFunction(() => !!document.querySelector('#input-chat .ant-sender'))
// The expert roster and the KB list arrive over the stubbed bridge, and the
// bound-expert chip with them.
await page.waitForFunction(() => !!document.querySelector('#input-chat [title="文案与润色"]'))

// The @-popup is derived from the textarea's value, so it takes a real keyboard
// (the same route the user takes). Row 0 is the highlighted one, row 1 idle.
await page.click('#input-chat textarea')
await page.keyboard.type('@')
await page.waitForFunction(() => !!document.querySelector('[data-mention-idx="1"]'))
const INPUT_REST = await page.evaluate(() => window.__inputVector())

// The picked-folder / picked-file chips need the two pick buttons pressed; the
// dialog is the harness stub, so nothing touches the user's disk.
await page.click('#input-chat button:has(.anticon-plus)')
await page.click('#input-chat button:has(.anticon-folder)')
await page.waitForFunction(() => (document.querySelector('#input-chat')?.querySelectorAll('span[style*="border-radius: 12px"]').length ?? 0) >= 3)
const INPUT_PICKED = await page.evaluate(() => window.__inputVector())

// One table, read in two passes: the resting surfaces (popup included) and the
// ones the pick buttons add. Merged per role, first non-null wins — so the
// composer card's own geometry stays the resting one (the header grows when the
// chips land, and the card is bottom-anchored).
const INPUT_LIGHT = {}
for (const role of Object.keys(INPUT_REST)) INPUT_LIGHT[role] = INPUT_REST[role] ?? INPUT_PICKED[role]
if (dump) console.log('  [dump] input light =', JSON.stringify(INPUT_LIGHT, null, 1))

// The two passes must agree wherever they overlap: pressing a pick button may
// add a chip, never repaint what was already there.
const passDrift = []
for (const role of Object.keys(INPUT_REST)) {
  const a = INPUT_REST[role]
  const b = INPUT_PICKED[role]
  if (!a || !b) continue
  for (const p of INK_FULL) if (a[p] !== b[p]) passDrift.push(`${role}.${p}`)
}
check('两次读数（加附件前/后）颜色逐项一致', passDrift.length === 0, passDrift.slice(0, 6).join(' | ') || '全部一致')

const missingRoles = Object.entries(INPUT_LIGHT).filter(([, v]) => !v).map(([k]) => k)
check('输入层角色全部渲染出来', missingRoles.length === 0, missingRoles.join(', ') || `${Object.keys(INPUT_LIGHT).length} 个角色`)

// ── 6.1 the light table: the pre-dark-mode app, byte for byte ────────────────
const INPUT_LIGHT_EXPECT = {
  // The composer card: the glass recipe (--pm-elevated-glass / --pm-shadow-glass)
  // and an edge that is NOT the sheet's. Composer.tsx writes
  // `border: 1px solid var(--pm-border-veil)` (0.08 / 0.14), but @ant-design/x's
  // own Sender rule sets `borderColor: token.colorBorderInput` and wins the
  // cascade, so the computed edge is antd's 0.1-alpha in both modes. Measured,
  // and identical before the migration (git-verified) — the pin names the
  // declaration that actually paints, so it cannot paper over a dark-mode hole.
  sender: { backgroundColor: 'rgba(255, 255, 255, 0.85)', borderTopColor: 'rgba(0, 0, 0, 0.1)', boxShadow: 'rgba(80, 100, 200, 0.2) 0px 5px 20px 2px' },
  // The send circle's two states, which have two different owners. DISABLED is
  // the composer's own !important pin (--pm-ink on --pm-ink-contrast) — the one
  // that must not fall back to antd's washed-out disabled grey. ENABLED is
  // antd's primary fill, which in light happens to be the ink (colorPrimary is
  // INK) and in dark is the algorithm's own derivation — see the dark table.
  sendDisabled: { backgroundColor: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' },
  sendEnabled: { backgroundColor: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' },
  // 授权: the gated levels grey (#666), 全部允许 amber (--pm-warn)
  approvalGated: { color: 'rgb(102, 102, 102)' },
  approvalAuto: { color: 'rgb(212, 107, 8)' },
  // the footer's two carets, which deliberately differ: the model picker's
  // inherits its button (--pm-text-secondary), the 授权 one is --pm-text-faint
  modelCaret: { color: 'rgb(102, 102, 102)' },
  approvalCaret: { color: 'rgb(187, 187, 187)' },
  // the bound-expert chip (--pm-pill / --pm-border-veil-weak) and its glyph
  expertChip: { backgroundColor: 'rgb(240, 240, 240)', borderTopColor: 'rgba(0, 0, 0, 0.06)' },
  expertIcon: { color: 'rgb(102, 102, 102)' },
  // the @-popup: --pm-elevated / --pm-border-veil / --pm-shadow-pop (Chromium
  // serializes a shadow without a spread with an explicit 0px)
  mentionPopup: { backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgba(0, 0, 0, 0.08)', boxShadow: 'rgba(0, 0, 0, 0.12) 0px 6px 24px 0px' },
  mentionTitle: { color: 'rgb(153, 153, 153)' },
  mentionRowActive: { backgroundColor: 'rgba(0, 0, 0, 0.05)' },
  mentionRowIdle: { backgroundColor: 'rgba(0, 0, 0, 0)' },
  mentionDesc: { color: 'rgb(153, 153, 153)' },
  // the picked-folder / picked-file chips, --pm-pill-strong
  folderChip: { backgroundColor: 'rgb(232, 232, 232)' },
  folderIcon: { color: 'rgb(102, 102, 102)' },
  fileChipIcon: { color: 'rgb(102, 102, 102)' },
  // the transcript's file chip: its frame and the two inks on it
  fileChip: { borderTopColor: 'rgb(230, 230, 230)' },
  fileChipName: { color: 'rgb(0, 0, 0)' },
  fileChipTime: { color: 'rgb(153, 153, 153)' },
  // the per-turn deliverables card and one row of it
  turnCard: { backgroundColor: 'rgb(250, 251, 252)', borderTopColor: 'rgb(236, 238, 242)' },
  turnTitle: { color: 'rgb(51, 51, 51)' },
  turnBadge: { backgroundColor: 'rgb(240, 241, 244)', color: 'rgb(85, 85, 85)' },
  turnRows: { borderTopColor: 'rgb(240, 241, 244)' },
  turnRow: { color: 'rgb(68, 68, 68)' },
  turnGlyph: { backgroundColor: 'rgb(240, 241, 244)', color: 'rgb(119, 119, 119)' },
  turnOfficeBadge: { backgroundColor: 'rgb(232, 240, 232)', color: 'rgb(46, 125, 50)' },
  turnOps: { color: 'rgb(153, 153, 153)' },
  turnFrom: { color: 'rgb(153, 153, 153)' },
  turnPreview: { color: 'rgb(26, 115, 232)' },
}
for (const [role, expected] of Object.entries(INPUT_LIGHT_EXPECT)) {
  const got = INPUT_LIGHT[role]
  if (!got) { check(`light input ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`light input ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
// The chip's paper is the one role a table of flat colors cannot carry: it is a
// gradient built from the extension's hue and the sheet's lightness. Both halves
// are derived rather than written down — the hue out of the component's own
// markup, the two stops out of the sheet in the mode in force — and the browser
// resolves them, so this compares two computed strings.
const chipLight = await page.evaluate(() => ({
  hue: window.__chipHue(document.querySelector('[data-case="file-ref"] span[style*="width: 250px"]')),
  expect: window.__chipGradientExpect(document.querySelector('[data-case="file-ref"] span[style*="width: 250px"]')),
  from: window.__varColor('--pm-chip-from'),
}))
check(
  'light file chip 渐变 = 该模式下 --pm-chip-from → hsl(组件自己的色相, 30%, --pm-chip-tint-l)',
  chipLight.expect !== null && INPUT_LIGHT.fileChip.backgroundImage === chipLight.expect && INPUT_LIGHT.fileChip.backgroundImage.includes(chipLight.from),
  `hue=${chipLight.hue} from=${chipLight.from} / 期望 ${chipLight.expect} / 实得 ${INPUT_LIGHT.fileChip.backgroundImage}`
)

// ── 6.2 the dark counterparts ────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('dark'))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
const INPUT_DARK = await page.evaluate(() => window.__inputVector())
if (dump) console.log('  [dump] input dark =', JSON.stringify(INPUT_DARK, null, 1))
const INPUT_DARK_EXPECT = {
  sender: { backgroundColor: 'rgba(31, 31, 31, 0.85)', borderTopColor: 'rgba(255, 255, 255, 0.1)', boxShadow: 'rgba(0, 0, 0, 0.55) 0px 5px 20px 2px' },
  // the ink inverts, and so does the text painted on it
  sendDisabled: { backgroundColor: 'rgb(230, 230, 230)', color: 'rgb(0, 0, 0)' },
  // The enabled fill is antd's, not the sheet's: colorPrimary is #e6e6e6 here,
  // but the dark algorithm derives the button's own primary from that seed and
  // reverses the palette (a light seed yields a darker rung), so the circle
  // paints #c7c7c7 — a step below --pm-ink, consistent with every other
  // type="primary" button in the app. Pinned as measured: it is a real dark-mode
  // color, and a future "make it the ink" change should have to fail here.
  sendEnabled: { backgroundColor: 'rgb(199, 199, 199)' },
  approvalGated: { color: 'rgb(166, 166, 166)' },
  approvalAuto: { color: 'rgb(216, 150, 20)' },
  modelCaret: { color: 'rgb(166, 166, 166)' },
  approvalCaret: { color: 'rgb(89, 89, 89)' },
  expertChip: { backgroundColor: 'rgb(38, 38, 38)', borderTopColor: 'rgba(255, 255, 255, 0.1)' },
  expertIcon: { color: 'rgb(166, 166, 166)' },
  mentionPopup: { backgroundColor: 'rgb(31, 31, 31)', borderTopColor: 'rgba(255, 255, 255, 0.14)', boxShadow: 'rgba(0, 0, 0, 0.6) 0px 6px 24px 0px' },
  mentionTitle: { color: 'rgb(140, 140, 140)' },
  mentionRowActive: { backgroundColor: 'rgba(255, 255, 255, 0.07)' },
  mentionRowIdle: { backgroundColor: 'rgba(0, 0, 0, 0)' },
  mentionDesc: { color: 'rgb(140, 140, 140)' },
  folderChip: { backgroundColor: 'rgb(51, 51, 51)' },
  folderIcon: { color: 'rgb(166, 166, 166)' },
  fileChipIcon: { color: 'rgb(166, 166, 166)' },
  fileChip: { borderTopColor: 'rgb(61, 61, 61)' },
  fileChipName: { color: 'rgb(230, 230, 230)' },
  fileChipTime: { color: 'rgb(140, 140, 140)' },
  turnCard: { backgroundColor: 'rgb(26, 26, 26)', borderTopColor: 'rgb(44, 44, 44)' },
  turnTitle: { color: 'rgb(236, 236, 236)' },
  turnBadge: { backgroundColor: 'rgb(47, 47, 47)', color: 'rgb(194, 194, 194)' },
  turnRows: { borderTopColor: 'rgb(47, 47, 47)' },
  turnRow: { color: 'rgb(200, 200, 200)' },
  turnGlyph: { backgroundColor: 'rgb(47, 47, 47)', color: 'rgb(160, 160, 160)' },
  turnOfficeBadge: { backgroundColor: 'rgb(22, 40, 26)', color: 'rgb(95, 191, 106)' },
  turnOps: { color: 'rgb(140, 140, 140)' },
  turnFrom: { color: 'rgb(140, 140, 140)' },
  turnPreview: { color: 'rgb(106, 169, 248)' },
}
for (const [role, expected] of Object.entries(INPUT_DARK_EXPECT)) {
  const got = INPUT_DARK[role]
  if (!got) { check(`dark input ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`dark input ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
const chipDark = await page.evaluate(() => ({
  hue: window.__chipHue(document.querySelector('[data-case="file-ref"] span[style*="width: 250px"]')),
  expect: window.__chipGradientExpect(document.querySelector('[data-case="file-ref"] span[style*="width: 250px"]')),
  from: window.__varColor('--pm-chip-from'),
}))
check(
  'dark file chip 渐变 = 该模式下 --pm-chip-from → hsl(组件自己的色相, 30%, --pm-chip-tint-l)',
  chipDark.expect !== null && INPUT_DARK.fileChip.backgroundImage === chipDark.expect && INPUT_DARK.fileChip.backgroundImage.includes(chipDark.from),
  `hue=${chipDark.hue} from=${chipDark.from} / 期望 ${chipDark.expect} / 实得 ${INPUT_DARK.fileChip.backgroundImage}`
)
// The half a per-mode comparison cannot see: the hue is DATA and must survive
// the flip, while the two tokens it is mixed into must not. Both ends are read
// live, so a hue that got remapped per mode fails here.
check(
  'file chip：色相跨模式不变，两端颜色各自翻转',
  chipLight.hue !== null && chipLight.hue === chipDark.hue && chipLight.from !== chipDark.from && INPUT_LIGHT.fileChip.backgroundImage !== INPUT_DARK.fileChip.backgroundImage,
  `hue ${chipLight.hue} → ${chipDark.hue} / from ${chipLight.from} → ${chipDark.from}`
)

const inputSurvived = []
for (const [role, expected] of Object.entries(INPUT_LIGHT_EXPECT)) {
  const l = INPUT_LIGHT[role]
  const d = INPUT_DARK[role]
  if (!l || !d) continue
  for (const p of Object.keys(expected)) if (l[p] === d[p]) inputSurvived.push(`${role}.${p}`)
}
// Registered, like §5's: an idle row's background is `transparent` (its literal
// before the migration) — there is no color there to flip, in either mode.
const INPUT_MODE_INDEPENDENT = ['mentionRowIdle.backgroundColor']
check(
  '输入层深色下被钉住的每个取值都翻转了（模式无关项须显式登记）',
  same(inputSurvived, INPUT_MODE_INDEPENDENT),
  `survivors=${inputSurvived.join(', ') || '无'} / registered=${INPUT_MODE_INDEPENDENT.join(', ')}`
)

const inputGeoDiff = diffVector(INPUT_LIGHT, INPUT_DARK, LAYOUT)
check('输入层深色只改颜色：几何与浅色逐项相同', inputGeoDiff.length === 0, inputGeoDiff.length ? inputGeoDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 6.3 non-vacuity, the same control §5.2 runs ──────────────────────────────
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.waitForTimeout(50)
const noVarsInput = await page.evaluate(() => window.__inputVector())
const inputEmptied = ['sender', 'expertChip', 'mentionPopup', 'folderChip', 'turnCard']
  .filter((role) => noVarsInput[role] && (noVarsInput[role].backgroundColor === 'rgba(0, 0, 0, 0)' || noVarsInput[role].backgroundColor === 'transparent'))
check('非空对照：摘掉变量表后输入层迁移面全部失去底色', inputEmptied.length === 5, inputEmptied.join(', ') || '底色还在（变量不是取值的来源）')
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
const inputRestored = await page.evaluate(() => window.__inputVector())
const inputRestoreDiff = diffVector(INPUT_DARK, inputRestored)
check('往返：装回变量表后与 6.2 逐项一致', inputRestoreDiff.length === 0, inputRestoreDiff.length ? inputRestoreDiff.slice(0, 6).join(' | ') : '全部一致')
await page.evaluate(() => window.__setMode('light'))

// ── 7. the ChatView surroundings (M2/T4) ─────────────────────────────────────
// Mounted here rather than at the top: two of these cases render a real
// ChatView, and the chat branch runs a 1s countdown that must still be alive
// when the last read happens (see PM_RETRY).
await page.evaluate(() => window.__mountChrome())
// The wait is deliberately structural — the case is up and the countdown is
// alive — and NOT the vector's own var-name selectors: those are the pin, and a
// surface that stopped naming its variable must fail a check (which the vector
// does, role by role) rather than hang the harness here. The countdown is the
// only `\d+s` span in the case, so this needs no language and no variable.
await page.waitForFunction(() => {
  const live = document.querySelector('[data-case="chat-live"]')
  if (!live) return false
  return [...live.querySelectorAll('span')].some((s) => /^\d+s$/.test(s.textContent || ''))
})
const CHIP_SEL = '[data-case="chip-box"] span'
const RING_SEL = '[data-case="ring-box"] .pm-context-ring'

// ── 7.1 the light column ─────────────────────────────────────────────────────
const CHROME_LIGHT = await page.evaluate(() => window.__chromeVector())
if (dump) console.log('  [dump] chrome light =', JSON.stringify(CHROME_LIGHT, null, 1))
const CHROME_LIGHT_EXPECT = {
  // the two grounds are the same role: --pm-bg
  welcomeGround: { backgroundColor: 'rgb(255, 255, 255)' },
  chatGround: { backgroundColor: 'rgb(255, 255, 255)' },
  // the logo is a pure-black PNG; `none` in light is the pre-migration state
  logo: { filter: 'none' },
  infoCircle: { color: 'rgb(187, 187, 187)' },
  noKeyBox: { backgroundColor: 'rgb(255, 247, 230)', borderTopColor: 'rgb(255, 213, 145)' },
  noKeyInk: { color: 'rgb(212, 107, 8)' },
  // the plan strip: its own outline and its own shadow (both new roles), and
  // the two blue marks inside it
  planStrip: { backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(229, 230, 235)', boxShadow: 'rgba(0, 0, 0, 0.08) 0px 2px 8px 0px', color: 'rgb(85, 85, 85)' },
  planDot: { backgroundColor: 'rgb(22, 119, 255)' },
  planLink: { color: 'rgb(22, 119, 255)' },
  // the retry banner's three rungs of #ff9500, and the countdown's grey
  retryBanner: { backgroundColor: 'rgba(255, 149, 0, 0.08)', borderTopColor: 'rgba(255, 149, 0, 0.25)', color: 'rgb(184, 77, 0)' },
  retrySpinner: { stroke: 'rgb(255, 149, 0)' },
  retryRing: { stroke: 'rgba(255, 149, 0, 0.25)' },
  retryCountdown: { color: 'rgb(153, 153, 153)' },
  errorBox: { backgroundColor: 'rgb(255, 242, 240)', borderTopColor: 'rgb(255, 204, 199)', color: 'rgb(207, 19, 34)' },
  // the two raw buttons: the solid dismiss and the outlined retry
  errorDismiss: { backgroundColor: 'rgb(207, 19, 34)', color: 'rgb(255, 255, 255)' },
  errorRetry: { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(207, 19, 34)', borderTopColor: 'rgb(207, 19, 34)' },
  // the loop-limit prompt's own amber family (antd's gold ramp, not --pm-warn's)
  extendButton: { backgroundColor: 'rgb(212, 136, 6)', borderTopColor: 'rgb(212, 136, 6)', color: 'rgb(255, 255, 255)' },
  extendBox: { backgroundColor: 'rgb(255, 251, 230)', borderTopColor: 'rgb(255, 229, 143)', color: 'rgb(173, 111, 0)' },
  // the paused-execution strip: --pm-fill, with three grey inks on it
  stopBox: { backgroundColor: 'rgb(245, 245, 245)', color: 'rgb(136, 136, 136)' },
  stopResume: { color: 'rgb(102, 102, 102)' },
  stopSep: { color: 'rgb(204, 204, 204)' },
  stopStop: { color: 'rgb(153, 153, 153)' },
  // the starter-prompt pill: its outline is its own role, one unit off the chip
  promptChip: { borderTopColor: 'rgb(229, 229, 231)', color: 'rgb(85, 85, 85)' },
  // the context ring rests transparent — its wash is the :hover rule, read below
  contextRingDisc: { backgroundColor: 'rgba(0, 0, 0, 0)' },
  contextRingTrack: { stroke: 'rgb(217, 217, 217)' },
  contextRingArc: { stroke: 'rgb(102, 102, 102)' },
  // the empty transcript's hint: --pm-text-muted, a role the message layer
  // already owned — pinned here because the surface is this section's
  // (ChatView 周边的空态), not because the role is new
  emptyHint: { color: 'rgb(153, 153, 153)' },
}
// §7's selectors are not all structural: five of them (the plan strip, its dot
// and its link, the retry banner and its countdown) find their element BY the
// variable it names, which is the most precise selector there is but means a
// miss has two possible causes — so the message names both instead of blaming
// the render.
for (const [role, expected] of Object.entries(CHROME_LIGHT_EXPECT)) {
  const got = CHROME_LIGHT[role]
  if (!got) { check(`light chrome ${role} 存在`, false, '选择器未命中：元素没渲染出来，或它已不再内联引用该角色变量'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`light chrome ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}

// ── 7.2 the two hover states, driven by a real mouse ─────────────────────────
// Both are written by code rather than by the sheet alone: the pill's handlers
// assign the variables in place, the ring's disc is a :hover rule. Neither can
// be read off a resting vector, and the pill's restore is the half that a
// handler which only ever *sets* the ink would silently lose.
await page.hover(CHIP_SEL)
const chipHoverLight = await page.evaluate((sel) => ({ got: window.__paintAt(sel), ink: window.__varColor('--pm-ink') }), CHIP_SEL)
check(
  'light prompt chip 悬停：边框与文字都取该模式的 --pm-ink',
  chipHoverLight.got !== null && chipHoverLight.got.color === chipHoverLight.ink && chipHoverLight.got.borderTopColor === chipHoverLight.ink,
  `--pm-ink = ${chipHoverLight.ink} / 实得 ${chipHoverLight.got && chipHoverLight.got.borderTopColor} · ${chipHoverLight.got && chipHoverLight.got.color}`
)
await page.hover(RING_SEL)
const ringHoverLight = await page.evaluate((sel) => ({ got: window.__paintAt(sel), wash: window.__varColor('--pm-hover-faint') }), RING_SEL)
check(
  'light context ring 悬停盘面 = 该模式的 --pm-hover-faint',
  ringHoverLight.got !== null && ringHoverLight.got.backgroundColor === ringHoverLight.wash,
  `--pm-hover-faint = ${ringHoverLight.wash} / 实得 ${ringHoverLight.got && ringHoverLight.got.backgroundColor}`
)
await page.mouse.move(5, 5)
const chipRestLight = await page.evaluate((sel) => ({ got: window.__paintAt(sel), border: window.__varColor('--pm-prompt-pill-border'), body: window.__varColor('--pm-text-body') }), CHIP_SEL)
check(
  'light prompt chip 移开指针后回到静止态（--pm-prompt-pill-border / --pm-text-body）',
  chipRestLight.got !== null && chipRestLight.got.borderTopColor === chipRestLight.border && chipRestLight.got.color === chipRestLight.body,
  `期望 ${chipRestLight.border} · ${chipRestLight.body} / 实得 ${chipRestLight.got && chipRestLight.got.borderTopColor} · ${chipRestLight.got && chipRestLight.got.color}`
)
const ringRestLight = await page.evaluate((sel) => window.__paintAt(sel), RING_SEL)
check('light context ring 移开指针后盘面回到透明', ringRestLight !== null && ringRestLight.backgroundColor === 'rgba(0, 0, 0, 0)', `实得 ${ringRestLight && ringRestLight.backgroundColor}`)

// ── 7.3 the dark counterparts ────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('dark'))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
const CHROME_DARK = await page.evaluate(() => window.__chromeVector())
if (dump) console.log('  [dump] chrome dark =', JSON.stringify(CHROME_DARK, null, 1))
const CHROME_DARK_EXPECT = {
  welcomeGround: { backgroundColor: 'rgb(20, 20, 20)' },
  chatGround: { backgroundColor: 'rgb(20, 20, 20)' },
  // the one migrated value that is not a color: the black mark inverts
  logo: { filter: 'invert(1)' },
  infoCircle: { color: 'rgb(89, 89, 89)' },
  noKeyBox: { backgroundColor: 'rgb(43, 33, 17)', borderTopColor: 'rgb(124, 89, 20)' },
  noKeyInk: { color: 'rgb(216, 150, 20)' },
  planStrip: { backgroundColor: 'rgb(31, 31, 31)', borderTopColor: 'rgb(66, 66, 66)', boxShadow: 'rgba(0, 0, 0, 0.5) 0px 2px 8px 0px', color: 'rgb(194, 194, 194)' },
  planDot: { backgroundColor: 'rgb(64, 150, 255)' },
  planLink: { color: 'rgb(64, 150, 255)' },
  retryBanner: { backgroundColor: 'rgba(255, 149, 0, 0.16)', borderTopColor: 'rgba(255, 149, 0, 0.35)', color: 'rgb(255, 180, 84)' },
  // #ff9500 is the banner's own accent, not a themed surface: it keeps its value
  // in both modes by design (registered as mode-independent below)
  retrySpinner: { stroke: 'rgb(255, 149, 0)' },
  retryRing: { stroke: 'rgba(255, 149, 0, 0.35)' },
  retryCountdown: { color: 'rgb(140, 140, 140)' },
  // antd's dark red ramp: bg = red-1-dark, border = red-2-dark
  errorBox: { backgroundColor: 'rgb(42, 18, 21)', borderTopColor: 'rgb(67, 20, 24)', color: 'rgb(255, 120, 117)' },
  // the ink inverts under the text, exactly as the send circle does
  errorDismiss: { backgroundColor: 'rgb(255, 120, 117)', color: 'rgb(0, 0, 0)' },
  errorRetry: { backgroundColor: 'rgb(31, 31, 31)', color: 'rgb(255, 120, 117)', borderTopColor: 'rgb(255, 120, 117)' },
  // antd's dark gold ramp: the solid lifts a rung, so its own label goes black
  extendButton: { backgroundColor: 'rgb(232, 179, 57)', borderTopColor: 'rgb(232, 179, 57)', color: 'rgb(0, 0, 0)' },
  extendBox: { backgroundColor: 'rgb(43, 33, 17)', borderTopColor: 'rgb(89, 66, 20)', color: 'rgb(243, 204, 98)' },
  stopBox: { backgroundColor: 'rgb(31, 31, 31)', color: 'rgb(153, 153, 153)' },
  stopResume: { color: 'rgb(166, 166, 166)' },
  stopSep: { color: 'rgb(77, 77, 77)' },
  stopStop: { color: 'rgb(140, 140, 140)' },
  promptChip: { borderTopColor: 'rgb(66, 66, 66)', color: 'rgb(194, 194, 194)' },
  contextRingDisc: { backgroundColor: 'rgba(0, 0, 0, 0)' },
  contextRingTrack: { stroke: 'rgb(66, 66, 66)' },
  contextRingArc: { stroke: 'rgb(166, 166, 166)' },
  emptyHint: { color: 'rgb(140, 140, 140)' },
}
for (const [role, expected] of Object.entries(CHROME_DARK_EXPECT)) {
  const got = CHROME_DARK[role]
  if (!got) { check(`dark chrome ${role} 存在`, false, '选择器未命中：元素没渲染出来，或它已不再内联引用该角色变量'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`dark chrome ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}

// ── 7.4 the same two hover states in dark ────────────────────────────────────
// The values differ from light's because the variables do — that is the point
// of comparing each against the sheet rather than against a literal.
await page.hover(CHIP_SEL)
const chipHoverDark = await page.evaluate((sel) => ({ got: window.__paintAt(sel), ink: window.__varColor('--pm-ink') }), CHIP_SEL)
check(
  'dark prompt chip 悬停：边框与文字都取该模式的 --pm-ink',
  chipHoverDark.got !== null && chipHoverDark.got.color === chipHoverDark.ink && chipHoverDark.got.borderTopColor === chipHoverDark.ink && chipHoverDark.ink !== chipHoverLight.ink,
  `--pm-ink = ${chipHoverDark.ink} / 实得 ${chipHoverDark.got && chipHoverDark.got.borderTopColor} · ${chipHoverDark.got && chipHoverDark.got.color}`
)
await page.hover(RING_SEL)
const ringHoverDark = await page.evaluate((sel) => ({ got: window.__paintAt(sel), wash: window.__varColor('--pm-hover-faint') }), RING_SEL)
check(
  'dark context ring 悬停盘面 = 该模式的 --pm-hover-faint（白墨，不是黑的）',
  ringHoverDark.got !== null && ringHoverDark.got.backgroundColor === ringHoverDark.wash && ringHoverDark.wash !== ringHoverLight.wash,
  `--pm-hover-faint = ${ringHoverDark.wash} / 实得 ${ringHoverDark.got && ringHoverDark.got.backgroundColor}`
)
await page.mouse.move(5, 5)
const chipRestDark = await page.evaluate((sel) => ({ got: window.__paintAt(sel), border: window.__varColor('--pm-prompt-pill-border'), body: window.__varColor('--pm-text-body') }), CHIP_SEL)
check(
  'dark prompt chip 移开指针后回到静止态（--pm-prompt-pill-border / --pm-text-body）',
  chipRestDark.got !== null && chipRestDark.got.borderTopColor === chipRestDark.border && chipRestDark.got.color === chipRestDark.body,
  `期望 ${chipRestDark.border} · ${chipRestDark.body} / 实得 ${chipRestDark.got && chipRestDark.got.borderTopColor} · ${chipRestDark.got && chipRestDark.got.color}`
)
const ringRestDark = await page.evaluate((sel) => window.__paintAt(sel), RING_SEL)
check('dark context ring 移开指针后盘面回到透明', ringRestDark !== null && ringRestDark.backgroundColor === 'rgba(0, 0, 0, 0)', `实得 ${ringRestDark && ringRestDark.backgroundColor}`)

const chromeSurvived = []
for (const [role, expected] of Object.entries(CHROME_LIGHT_EXPECT)) {
  const l = CHROME_LIGHT[role]
  const d = CHROME_DARK[role]
  if (!l || !d) continue
  for (const p of Object.keys(expected)) if (l[p] === d[p]) chromeSurvived.push(`${role}.${p}`)
}
// Registered, like §5's and §6's. The spinner's stroke is the banner's accent
// (#ff9500, written inline) and the ring's resting disc is transparent in both
// modes — the wash only exists while hovered, which §7.2/§7.4 read.
const CHROME_MODE_INDEPENDENT = ['contextRingDisc.backgroundColor', 'retrySpinner.stroke']
check(
  'ChatView 周边深色下被钉住的每个取值都翻转了（模式无关项须显式登记）',
  same(chromeSurvived, CHROME_MODE_INDEPENDENT),
  `survivors=${chromeSurvived.join(', ') || '无'} / registered=${CHROME_MODE_INDEPENDENT.join(', ')}`
)

const chromeGeoDiff = diffVector(CHROME_LIGHT, CHROME_DARK, LAYOUT)
check('ChatView 周边深色只改颜色：几何与浅色逐项相同', chromeGeoDiff.length === 0, chromeGeoDiff.length ? chromeGeoDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 7.5 non-vacuity, the control §5.2/§6.3 run ───────────────────────────────
// Derived rather than written out: every role whose dark reading names a fill
// that is not already transparent must lose it with the sheet gone. The three
// buttons are deliberately excluded and asserted the other way — their inline
// `var()` is the winning declaration but not the only source, so a dropped one
// falls back to the UA/antd face instead of to nothing. That distinction is
// measured, not assumed: it is the same shape as §6's `sendEnabled`.
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.waitForTimeout(50)
const noVarsChrome = await page.evaluate(() => window.__chromeVector())
const CHROME_BUTTONS = ['errorDismiss', 'errorRetry', 'extendButton']
const CHROME_FILLED = Object.entries(CHROME_DARK_EXPECT)
  .filter(([, exp]) => exp.backgroundColor && exp.backgroundColor !== 'rgba(0, 0, 0, 0)')
  .map(([role]) => role)
  .filter((role) => CHROME_BUTTONS.indexOf(role) < 0)
const chromeEmptied = CHROME_FILLED.filter((role) => {
  const bg = noVarsChrome[role] && noVarsChrome[role].backgroundColor
  return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent'
})
check(
  '非空对照：摘掉变量表后 ChatView 周边的迁移面全部失去底色',
  chromeEmptied.length === CHROME_FILLED.length,
  chromeEmptied.length === CHROME_FILLED.length ? `${CHROME_FILLED.length} 项` : `仍留着底色：${CHROME_FILLED.filter((r) => chromeEmptied.indexOf(r) < 0).join(', ')}`
)
const chromeButtonsMoved = CHROME_BUTTONS.filter((role) => noVarsChrome[role] && noVarsChrome[role].backgroundColor !== CHROME_DARK[role].backgroundColor)
check(
  '非空对照：三个按钮的底色也随变量表一起变（它们另有 UA/antd 兜底，故只要求「变了」）',
  chromeButtonsMoved.length === CHROME_BUTTONS.length,
  CHROME_BUTTONS.map((r) => `${r}: ${CHROME_DARK[r].backgroundColor} → ${noVarsChrome[r] && noVarsChrome[r].backgroundColor}`).join(' | ')
)
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
const chromeRestored = await page.evaluate(() => window.__chromeVector())
const chromeRestoreDiff = diffVector(CHROME_DARK, chromeRestored)
check('往返：装回变量表后与 7.3 逐项一致', chromeRestoreDiff.length === 0, chromeRestoreDiff.length ? chromeRestoreDiff.slice(0, 6).join(' | ') : '全部一致')
await page.evaluate(() => window.__setMode('light'))

// ── 8. the code highlighter (M2/T5) ──────────────────────────────────────────
// The one migrated surface whose colours do NOT all come from the sheet: Prism's
// theme is a JS object, so the tokens flip by subscription while the card flips
// by variable. One mode read cannot vouch for both halves, so they are read
// separately — and the split itself is measured (§8.4: remove the sheet and
// exactly one half moves), because "the tokens ride the subscription" is a claim
// about a mechanism, not about a colour.
console.log('\n=== 8. 代码高亮双主题 ===')
await page.evaluate(() => window.__mountCode())
// Structural wait, like §7's: the case is up and Prism has tokenised it (both
// tokens carry their text, and the type class is stripped — see the reader).
// A var-name selector here would make a broken migration HANG instead of fail.
await page.waitForFunction(() => {
  const card = document.querySelector('[data-case="code-standalone"] > div')
  if (!card) return false
  const spans = [...card.querySelectorAll('span')]
  const has = (t) => spans.some((s) => s.textContent === t && s.className.indexOf('token') >= 0)
  return has('const') && has('42')
})
const codeVec = () => page.evaluate(() => window.__codeVector())
const prism = await page.evaluate(() => window.__prismValues())
if (dump) console.log('  [dump] prism =', show(prism))

// ── 8.1 the light column ─────────────────────────────────────────────────────
const CODE_LIGHT = await codeVec()
if (dump) console.log('  [dump] code light =', JSON.stringify(CODE_LIGHT, null, 1))
// The card's ink and the tokens' are oneLight's own values; the card's wash is
// `--pm-code-bg`'s literal, which is x-markdown's `--light-bg` — the very rgba
// §2 reads on the chat's own `pre code`, which is why the standalone card and
// the chat's block agree. `cardCode` carries no wash of its own: our explicit
// `codeTagProps` replaces the theme's code-tag default, so the inner <code> is
// unstyled and the card is the only paint (measured, not assumed).
const CODE_LIGHT_EXPECT = {
  card: { backgroundColor: 'rgba(0, 0, 0, 0.04)', color: 'rgb(56, 58, 66)', textShadow: 'none' },
  cardCode: { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(56, 58, 66)', fontSize: '14px', lineHeight: '22.4px' },
  token: { color: 'rgb(166, 38, 164)' },
  tokenNum: { color: 'rgb(183, 107, 1)' },
  plain: { backgroundColor: 'rgba(0, 0, 0, 0.04)', color: 'rgb(51, 51, 51)' },
  // the chat's fence — the same tokens, but inside x-markdown's theme
  chatToken: { color: 'rgb(166, 38, 164)' },
}
for (const [role, expected] of Object.entries(CODE_LIGHT_EXPECT)) {
  const got = CODE_LIGHT[role]
  if (!got) { check(`light ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`light ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
// The card's box is the pre-migration contract (padding 12 / radius 8 / the
// fontSize prop through), asserted apart from the colours because the flip must
// not move it — the same claim §2/§3 make for the markdown vector.
const CODE_GEO = { paddingTop: '12px', paddingLeft: '12px', borderRadius: '8px', fontSize: '14px' }
const codeGeoBad = Object.entries(CODE_GEO).filter(([k, v]) => !CODE_LIGHT.card || CODE_LIGHT.card[k] !== v)
check('light card 的几何 = 迁移前（padding 12 / radius 8 / fontSize 14）', codeGeoBad.length === 0, codeGeoBad.length ? codeGeoBad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${CODE_LIGHT.card && CODE_LIGHT.card[k]}`).join('; ') : Object.values(CODE_GEO).join(' / '))
const plainGeoBad = ['paddingTop', 'borderRadius', 'fontSize', 'lineHeight'].filter((k) => !CODE_LIGHT.plain || CODE_LIGHT.plain[k] !== { paddingTop: '12px', borderRadius: '8px', fontSize: '12px', lineHeight: '19.2px' }[k])
check('light PlainCode 的几何 = 迁移前（padding 12 / radius 8 / fontSize 12）', plainGeoBad.length === 0, plainGeoBad.length ? plainGeoBad.map((k) => `${k}: 实得 ${CODE_LIGHT.plain && CODE_LIGHT.plain[k]}`).join('; ') : '一致')

// ── 8.2 the card names its variable ──────────────────────────────────────────
// The reading above is structural on purpose (§7's note: a var-name selector is
// the pin, so it must fail a check rather than hide a miss). The consequence is
// that a wrong colour and a component that never names the variable look alike
// in the vector — so the naming is asserted separately, on the inline style.
const cardStyle = await page.evaluate(() => window.__cardStyle())
check(
  '浅色 · 卡片的底色来自 --pm-code-bg，而不是写死的字面量',
  !!cardStyle && cardStyle.includes('--pm-code-bg') && !cardStyle.includes('rgba(0, 0, 0, 0.04)'),
  cardStyle || '卡片没渲染出来'
)

// ── 8.3 the dark column ──────────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('dark'))
// The attribute is the wait, as §5.1/§6.2 do — the wrap count is no longer 3 by
// now (the layer harness added its own). The Prism swap is a React commit behind
// that attribute, so a short settle keeps the read off the boundary: waiting for
// the dark colour itself would turn a broken migration into a hang, and the
// checks below are what must report it.
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
await page.waitForTimeout(150)
const CODE_DARK = await codeVec()
if (dump) console.log('  [dump] code dark =', JSON.stringify(CODE_DARK, null, 1))
const CODE_DARK_EXPECT = {
  card: { backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgb(171, 178, 191)', textShadow: 'rgba(0, 0, 0, 0.3) 0px 1px 0px' },
  cardCode: { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(171, 178, 191)' },
  token: { color: 'rgb(198, 120, 221)' },
  tokenNum: { color: 'rgb(209, 154, 102)' },
  plain: { backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgb(236, 236, 236)' },
  chatToken: { color: 'rgb(198, 120, 221)' },
}
for (const [role, expected] of Object.entries(CODE_DARK_EXPECT)) {
  const got = CODE_DARK[role]
  if (!got) { check(`dark ${role} 存在`, false, '元素没有渲染出来'); continue }
  const bad = Object.entries(expected).filter(([k, v]) => got[k] !== v)
  check(`dark ${role} = ${Object.keys(expected).join('/')}`, bad.length === 0, bad.length ? bad.map(([k, v]) => `${k}: 期望 ${v} 实得 ${got[k]}`).join('; ') : Object.values(expected).join(' / '))
}
// The flip is the check that FAILS on the pre-T5 code, where both modes rendered
// oneLight. Split by half: the card flips by variable, the tokens by
// subscription, and either could be left behind alone. `textShadow` rides the
// card (oneDark declares it on `pre[class*="language-"]`, oneLight does not).
const CODE_ROLES = ['card', 'cardCode', 'token', 'tokenNum', 'plain', 'chatToken']
const inkFlipped = CODE_ROLES.filter((r) => CODE_LIGHT[r] && CODE_DARK[r] && CODE_LIGHT[r].color !== CODE_DARK[r].color)
check('翻转：六个角色的文字色都随模式变化（迁移前恒为 oneLight）', inkFlipped.length === 6, `变了 ${inkFlipped.length}/6${inkFlipped.length === 6 ? '' : ` — 未变：${CODE_ROLES.filter((r) => inkFlipped.indexOf(r) < 0).join(', ')}`}`)
const washFlipped = ['card', 'plain'].filter((r) => CODE_LIGHT[r] && CODE_DARK[r] && CODE_LIGHT[r].backgroundColor !== CODE_DARK[r].backgroundColor)
check('翻转：卡片与 PlainCode 的底色也随模式变化', washFlipped.length === 2, washFlipped.length === 2 ? '两个都变了' : `只有 ${washFlipped.join(', ') || '无'}`)
check('翻转：卡片阴影只在深色存在（oneDark 声明，oneLight 没有）', CODE_LIGHT.card && CODE_DARK.card && CODE_LIGHT.card.textShadow === 'none' && CODE_DARK.card.textShadow !== 'none', `light ${CODE_LIGHT.card && CODE_LIGHT.card.textShadow} / dark ${CODE_DARK.card && CODE_DARK.card.textShadow}`)
const codeGeoDiff = diffVector(CODE_LIGHT, CODE_DARK, LAYOUT)
check('深色只改颜色：卡片几何与浅色逐项相同', codeGeoDiff.length === 0, codeGeoDiff.length ? codeGeoDiff.slice(0, 6).join(' | ') : '全部一致')

// The tokens are the THEMES' values, not two arbitrary literals: the right hand
// side is read from the imported oneLight/oneDark objects (the browser
// normalises their hsl declarations into the same computed form), so a theme
// bump that moved a token would fail here instead of passing on a stale literal.
const THEME_ANCHORS = [
  ['light', 'token', 'keyword'], ['light', 'tokenNum', 'number'], ['light', 'card', 'base'], ['light', 'chatToken', 'keyword'],
  ['dark', 'token', 'keyword'], ['dark', 'tokenNum', 'number'], ['dark', 'card', 'base'], ['dark', 'chatToken', 'keyword'],
]
const anchorHits = THEME_ANCHORS.filter(([mode, role, key]) => {
  const measured = (mode === 'light' ? CODE_LIGHT : CODE_DARK)[role]
  return measured && measured.color === prism[mode][key]
})
check('实测色 = Prism 主题对象自己的值（8 项，聊天里的围栏也在内）', anchorHits.length === 8, `对上 ${anchorHits.length}/8`)
check(
  '非空对照：两个主题的 keyword/number/base 本来就不同（上面那条不是恒真）',
  prism.light.keyword !== prism.dark.keyword && prism.light.number !== prism.dark.number && prism.light.base !== prism.dark.base,
  `keyword ${prism.light.keyword} vs ${prism.dark.keyword}；base ${prism.light.base} vs ${prism.dark.base}`
)
check('非空对照：oneDark 的卡片阴影只在深色存在（浅色是 none）', prism.light.shadow === 'none' && prism.dark.shadow !== 'none', `light ${prism.light.shadow} / dark ${prism.dark.shadow}`)

// ── 8.4 the CSS/JS split, measured ───────────────────────────────────────────
// Removing the sheet must move EXACTLY the CSS half. That is the honest
// statement of the design — the tokens ride `useThemeMode`, not the sheet — and
// it doubles as this section's non-vacuity control: a card still painted without
// the sheet would mean the variable is not what paints it.
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.waitForTimeout(50)
const noVarsCode = await codeVec()
const washLost = ['card', 'plain'].filter((r) => noVarsCode[r] && (noVarsCode[r].backgroundColor === 'rgba(0, 0, 0, 0)' || noVarsCode[r].backgroundColor === 'transparent'))
check('非空对照：摘掉变量表后卡片与 PlainCode 的底色失效', washLost.length === 2, washLost.length === 2 ? '两个都失效了' : `仍留着底色：${['card', 'plain'].filter((r) => washLost.indexOf(r) < 0).join(', ')}`)
// Anchored on the theme object, NOT on §8.3's own reading: with the sheet gone,
// "still the dark values" has to mean oneDark's values, or a component stuck on
// oneLight would satisfy it against itself (measured — that is how the first
// draft of this check passed on the reverted code).
const SPLIT_HELD = [['card', 'base'], ['cardCode', 'base'], ['token', 'keyword'], ['tokenNum', 'number'], ['chatToken', 'keyword']]
const tokensHeld = SPLIT_HELD.filter(([role, key]) => noVarsCode[role] && noVarsCode[role].color === prism.dark[key])
check(
  '另一半不动：摘掉变量表后 token 与卡片文字色仍是 oneDark 的值（令牌走订阅，不走表）',
  tokensHeld.length === SPLIT_HELD.length,
  `${tokensHeld.length}/${SPLIT_HELD.length} 保持${tokensHeld.length === SPLIT_HELD.length ? '' : ` — 动了：${SPLIT_HELD.filter(([r]) => tokensHeld.indexOf(r) < 0).map(([r, k]) => `${r}(期望 ${prism.dark[k]}，实得 ${noVarsCode[r] && noVarsCode[r].color})`).join(', ')}`}`
)
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
const codeRestored = await codeVec()
const codeRestoreDiff = diffVector(CODE_DARK, codeRestored)
check('往返：装回变量表后与 8.3 逐项一致', codeRestoreDiff.length === 0, codeRestoreDiff.length ? codeRestoreDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 8.5 the light round trip ─────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('light'))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
await page.waitForTimeout(150)
const codeBack = await codeVec()
const codeRoundDiff = diffVector(CODE_LIGHT, codeBack)
check('往返：回到浅色后与 8.1 逐项一致', codeRoundDiff.length === 0, codeRoundDiff.length ? codeRoundDiff.slice(0, 6).join(' | ') : '全部一致')

// ── 9. 非空对照：暗色段就是开关（M2/T6） ─────────────────────────────────────
// The plan's T6 control — "delete the `[data-theme='dark']` section and the dark
// assertions must fail" — run in-probe rather than as a one-off patch of the
// palette, the way §1.3 brackets the two layer orders instead of trusting them.
// The sheet is replaced by the same `buildThemeCss()` text with that one section
// cut out, the attribute keeps reading dark, and every dark reading the four
// migrated layers pinned must fall back to its LIGHT value. It is §4's
// sheet-removal control narrowed from "the sheet" to "the dark half of it", so
// that "the dark column comes from the dark section" is a measured fact rather
// than a reading of the builder.
//
// One reading is required NOT to move: the Prism token colours are a JS object
// chosen by `useThemeMode`, so no stylesheet — dark or otherwise — can carry
// them (§8.4's split, now from the other side). A token that fell back here would
// mean the dark column had been riding CSS after all.
console.log('\n=== 9. 非空对照：暗色段就是开关（M2/T6） ===')
const allVectors = () => page.evaluate(() => window.__allVectors())
await page.evaluate(() => window.__setMode('light'))
await page.waitForTimeout(50)
const sec9Light = await allVectors()
await page.evaluate(() => window.__setMode('dark'))
await page.waitForTimeout(50)
const sec9Dark = await allVectors()

// (section, role, prop) — one surface per migrated layer, each owned by a
// different variable (ground, ink, tile, warn, the error face, the code paper,
// the strong text), so a dark section that lost a single role would show here
// and not only in the section that owns the role.
const SEC9_PAIRS = [
  ['layer', 'ground', 'backgroundColor'],
  // The caret's ink is its BACKGROUND (StreamingCursor paints var(--pm-ink) as a
  // block); its `color` is inherited page black in both modes — measured here,
  // by 9.2 failing on that reading the first time this section ran.
  ['layer', 'caret', 'backgroundColor'],
  ['input', 'turnCard', 'backgroundColor'],
  ['input', 'approvalAuto', 'color'],
  ['chrome', 'welcomeGround', 'backgroundColor'],
  ['chrome', 'errorBox', 'backgroundColor'],
  ['code', 'card', 'backgroundColor'],
  ['code', 'plain', 'color'],
]
const sec9At = (v, [s, r, p]) => (v[s] && v[s][r] ? v[s][r][p] : undefined)
const sec9Missing = SEC9_PAIRS.filter((pair) => sec9At(sec9Light, pair) === undefined || sec9At(sec9Dark, pair) === undefined)
check(
  '9.1 八个对照面都渲染出来了',
  sec9Missing.length === 0,
  sec9Missing.length ? sec9Missing.map(([s, r]) => `${s}.${r}`).join(', ') : `${SEC9_PAIRS.length} 项`
)
const sec9Unmoved = SEC9_PAIRS.filter((pair) => sec9At(sec9Dark, pair) === sec9At(sec9Light, pair))
check(
  '9.2 暗色确实动了这八项（否则「回落」是空话）',
  sec9Unmoved.length === 0,
  sec9Unmoved.length ? sec9Unmoved.map(([s, r, p]) => `${s}.${r}.${p} = ${sec9At(sec9Dark, [s, r, p])}`).join(' | ') : `八项全部不同：浅 ${sec9At(sec9Light, SEC9_PAIRS[0])} → 暗 ${sec9At(sec9Dark, SEC9_PAIRS[0])} 等`
)

await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVarsNoDark())
await page.waitForTimeout(50)
const sec9Cut = await allVectors()
check(
  '9.3 删掉 dark 段：八个面全部回落到浅色值',
  (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' &&
    (await page.evaluate(() => (document.getElementById('pm-theme-vars').textContent || '').indexOf('data-theme') < 0)) &&
    SEC9_PAIRS.every((pair) => sec9At(sec9Cut, pair) === sec9At(sec9Light, pair)),
  SEC9_PAIRS.filter((pair) => sec9At(sec9Cut, pair) !== sec9At(sec9Light, pair))
    .map(([s, r, p]) => `${s}.${r}.${p}: 浅 ${sec9At(sec9Light, [s, r, p])} / 暗 ${sec9At(sec9Dark, [s, r, p])} / 删段后 ${sec9At(sec9Cut, [s, r, p])}`)
    .join(' | ') || `${SEC9_PAIRS.length} 项全部回落`
)
check(
  '9.4 令牌不受影响：它由 JS 主题对象着色，删掉 CSS 暗色段纹丝不动',
  sec9At(sec9Cut, ['code', 'token', 'color']) === sec9At(sec9Dark, ['code', 'token', 'color']) &&
    sec9At(sec9Dark, ['code', 'token', 'color']) !== sec9At(sec9Light, ['code', 'token', 'color']),
  `浅 ${sec9At(sec9Light, ['code', 'token', 'color'])} / 暗 ${sec9At(sec9Dark, ['code', 'token', 'color'])} / 删段后 ${sec9At(sec9Cut, ['code', 'token', 'color'])}`
)

await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
const sec9Back = await allVectors()
const sec9BackDiff = SEC9_PAIRS.filter((pair) => sec9At(sec9Back, pair) !== sec9At(sec9Dark, pair))
check(
  '9.5 往返：装回完整变量表后八项回到暗色值',
  sec9BackDiff.length === 0,
  sec9BackDiff.length ? sec9BackDiff.map(([s, r, p]) => `${s}.${r}.${p}: ${sec9At(sec9Back, [s, r, p])} ≠ ${sec9At(sec9Dark, [s, r, p])}`).join(' | ') : '全部一致'
)
await page.evaluate(() => window.__setMode('light'))

// ── 10. the shell's own surfaces (M3/T0) ─────────────────────────────────────
// The harness side (fixture, SHELL_FLAT readers, composite samplers) is all
// above; this is the run + assertions. Three kinds of evidence, per the header:
//
//   (a) ROLE rows — the element IS the `--pm-*` role it names, byte-equal in
//       both modes (the expected value is read out of the LIVE sheet through a
//       throwaway box, never copied here), and its ink clears a contrast floor
//       against the ground it really sits on (the measured gradient pixel for
//       the sider's subtree, the nearest opaque background elsewhere).
//   (b) COMPOSITE rows — the nine hover/veil washes fold over the *gradient*,
//       so the visible result is arithmetic over a real screenshot: the patch
//       the harness samples must be uniform (a sampler that drifted onto a
//       child fails loudly), and fold(alpha, role, ground-pixel) must equal the
//       patch's mean. `--pm-row-hover` is the one OPAQUE row here, so its fold
//       degenerates to "the pixel IS the role".
//   (c) TOKEN rows — antd-painted surfaces must move with the algorithm (bound
//       to the live token object) and must NOT follow the sheet when §10.6 cuts
//       its dark section — the half of the boundary §9 cannot see from the four
//       chat fixtures.
//
// The mode is driven three full passes (light, dark, dark-with-cut-sheet): the
// shell remounts per pass (`__mountShell` unmounts, resets the stores, navigates
// back to chat), so no phase's leftovers leak into the next pass.
console.log('\n=== 10. 外壳自己的面（M3/T0） ===')
await page.evaluate(() => window.__mountExtras())

/** key → [phase, { prop: role | '@token.Name' | 'rgba(0, 0, 0, 0)' }]. A role
 *  names a `--pm-*` variable; '@' names an antd token the element must be bound
 *  to; a literal color is a REGISTERED inert (transparent at rest in both
 *  modes) and is asserted equal across the flip instead of flipped. */
const SHELL_ROLE_TABLE = {
  chats: {
    title: { color: '--pm-ink' },
    version: { color: '--pm-text-muted' },
    navIdle: { color: '--pm-ink', backgroundColor: 'rgba(0, 0, 0, 0)' },
    navActive: { color: '--pm-ink', backgroundColor: '--pm-veil-strong' },
    navCaret: { color: '--pm-text-tertiary' },
    iconIdle: { color: '--pm-ink', backgroundColor: 'rgba(0, 0, 0, 0)' },
    track: { backgroundColor: '--pm-hover' },
    tabOn: { color: '--pm-ink-contrast', backgroundColor: '--pm-ink' },
    tabOff: { color: '--pm-text-secondary' },
    action: { color: '--pm-text-disabled' },
    groupHead: { color: '--pm-text-muted' },
    rowPin: { color: '--pm-text-faint' },
    rowTime: { color: '--pm-text-muted' },
    rowIdle: { backgroundColor: 'rgba(0, 0, 0, 0)' },
    rowActive: { backgroundColor: '--pm-hover-strong' },
    rowActiveLabel: { color: '--pm-row-ink' },
    rowEllipsis: { color: '--pm-text-muted' },
    rowRetry: { backgroundColor: '--pm-gold-accent' },
    rowRunning: { backgroundColor: '--pm-link' },
    headerTitle: { color: '--pm-text' },
    paneBtn: { color: '--pm-text-muted' },
    chatGround: { backgroundColor: '--pm-bg' },
    bottomBar: { borderTopColor: '--pm-border-hairline' },
    sider: { backgroundImage: '--pm-sidebar' },
    listScroll: { backgroundColor: 'rgba(0, 0, 0, 0)' },
  },
  hover: { rowHover: { backgroundColor: '--pm-hover' } },
  // One pointer position, one phase: the idle nav button's veil is CSS :hover,
  // so it is driven with the pointer parked on the button itself.
  navHover: { navIdle: { backgroundColor: '--pm-veil' } },
  empty: { chatsEmpty: { color: '--pm-text-muted' } },
  projects: {
    projChevron: { color: '--pm-text-faint' },
    projFolder: { color: '--pm-text-muted' },
    projName: { color: '--pm-row-ink' },
    projEmptyHint: { color: '--pm-text-faint' },
  },
  projectsHover: { projHeader: { backgroundColor: '--pm-hover-weak' } },
  // The pointer sits on the DELETE button here, so the danger row is the one
  // hovered (its :hover ink) and the plain action is read at rest beside it.
  // 2026-09-20: destructive actions went grey — the hover ink is
  // --pm-text-secondary, not the error red.
  projectsDanger: {
    projActionDanger: { color: '--pm-text-secondary' },
    projAction: { color: '--pm-text-muted' },
  },
  palette: {
    paletteRow: { backgroundColor: '--pm-hover' },
    paletteLabel: { color: '--pm-text-title' },
    paletteGroup: { color: '--pm-text-muted' },
    paletteHint: { color: '--pm-text-muted' },
    palettePaper: { backgroundColor: '@token.colorBgElevated' },
  },
  paletteEmpty: { paletteEmpty: { color: '--pm-text-muted' } },
  search: {
    searchRoot: { backgroundColor: '--pm-bg' },
    searchPrefix: { color: '--pm-text-faint' },
    searchHint: { color: '--pm-text-faint' },
    searchInput: { backgroundColor: '@token.colorBgContainer' },
  },
  searchRows: {
    searchGroupHead: { color: '--pm-text-muted' },
    searchGroupCount: { color: '--pm-text-ghost' },
    searchGroupBox: { borderTopColor: '--pm-border-hairline' },
    searchRow: { backgroundColor: 'rgba(0, 0, 0, 0)' },
    searchRowTitle: { color: '--pm-text-title' },
    searchRowIcon: { color: '--pm-text-muted' },
    searchRowMeta: { color: '--pm-text-soft' },
    searchRowBody: { color: '--pm-text-secondary' },
  },
  searchHover: { searchRowHover: { backgroundColor: '--pm-row-hover' } },
  usage: {
    iconActive: { color: '--pm-ink', backgroundColor: '--pm-veil-strong' },
    centeredRoot: { backgroundColor: '--pm-bg' },
  },
  // The idle icon button's wash is CSS :hover — its own sub-phase, one pointer
  // position each.
  iconHover: { iconIdle: { backgroundColor: '--pm-veil' } },
  modal: {
    pmLabel: { color: '@token.colorText' },
    pmInput: { backgroundColor: '@token.colorBgContainer' },
    pmDirError: { color: '--pm-error-status' },
    pmPaper: { backgroundColor: '@token.colorBgElevated' },
  },
  extras: {
    errRoot: { color: '--pm-ink' },
    errPre: { color: '--pm-error-bright', backgroundColor: '--pm-fill' },
    errStack: { color: '--pm-text-secondary', backgroundColor: '--pm-fill' },
    editorHeader: { color: '--pm-text-muted' },
    editorSurface: { backgroundColor: '--pm-fill' },
    editorCard: { backgroundColor: '--pm-card' },
    extrasCenteredRoot: { backgroundColor: '--pm-bg' },
    extrasGround: { backgroundColor: '--pm-bg' },
  },
}

/** The nine composite rows: [SHELL_ALPHA key, the phase whose shot carries it].
 *  Every one is translucent over the gradient EXCEPT searchRowHover, whose role
 *  is an opaque hex — flagged so the fold knows to degenerate. */
const SHELL_COMPOSITES = [
  ['navActive', 'chats', true],
  ['navIdle', 'navHover', true],
  ['track', 'chats', true],
  ['rowActive', 'chats', true],
  ['rowHover', 'hover', true],
  ['projHeader', 'projectsHover', true],
  ['iconIdle', 'iconHover', true],
  ['iconActive', 'usage', true],
  ['searchRowHover', 'searchHover', false],
]
// Phase → the pass key its screenshot was stored under.
const SHELL_SHOT_OF = { chats: 'shotChats', hover: 'shotHover', navHover: 'shotNavHover', projectsHover: 'shotProjects', usage: 'shotUsage', iconHover: 'shotIconHover', searchHover: 'shotSearch' }

/** Contrast floors, split the way the palette itself is: the strong inks must
 *  stay clearly legible (≥3:1), the faint family must merely stay visible
 *  (≥1.25:1 — the light app ships #bbb on #f7f7f8 at 1.85 and that is the
 *  design, so a uniform 3 would fail the app we are porting). */
const SHELL_STRONG = ['--pm-ink', '--pm-ink-contrast', '--pm-text', '--pm-text-secondary', '--pm-text-title', '--pm-row-ink', '--pm-link', '--pm-error', '--pm-error-status', '--pm-error-bright']
const SHELL_FAINT = ['--pm-text-muted', '--pm-text-soft', '--pm-text-faint', '--pm-text-ghost', '--pm-text-disabled', '--pm-text-tertiary', '--pm-gold-accent']

/** One full pass: mount the shell fresh and walk every phase in the CURRENT
 *  mode. Returns { <phase>: vector, shot<Phase>: png-buffer } — the shots ride
 *  alongside so a composite row's vector and its pixels come from one instant. */
async function driveShellPhases() {
  const P = {}
  await page.evaluate(() => window.__mountShell())
  await page.waitForFunction(() => document.querySelector('[data-conv-row="conv-shell-today"]'))
  const shellVec = () => page.evaluate(() => window.__shellVector())

  // 1 · chats tab, full list, pointer parked at the origin.
  await page.mouse.move(0, 0)
  P.chats = await shellVec()
  P.shotChats = await page.screenshot()

  // 2 · hover yesterday's row (React writes its hover wash inline).
  const hr = P.chats.rects.rowHover
  if (hr) {
    await page.mouse.move(hr.x + hr.w / 2, hr.y + hr.h / 2)
    await page.waitForTimeout(80)
    P.hover = await shellVec()
    P.shotHover = await page.screenshot()
  }
  // 2b · hover the idle nav button (CSS :hover veil) in its own sub-phase —
  // one pointer position, one hovered element.
  const nr = P.chats.rects.navIdle
  if (nr) {
    await page.mouse.move(nr.x + nr.w / 2, nr.y + nr.h / 2)
    await page.waitForTimeout(80)
    P.navHover = await shellVec()
    P.shotNavHover = await page.screenshot()
  }
  await page.mouse.move(0, 0)

  // 3 · empty list (the 暂无会话 hint), then restore.
  await page.evaluate(() => window.__setShellConvs([]))
  await page.waitForFunction(() => !document.querySelector('[data-conv-row]'))
  P.empty = await shellVec()
  await page.evaluate(() => window.__resetShellConvs())
  await page.waitForFunction(() => document.querySelector('[data-conv-row="conv-shell-today"]'))

  // 4 · the 项目 tab, via a real click on the off tab.
  await page.click('.sidebar-list-tab:not(.on)')
  await page.waitForFunction(() => document.querySelector('[data-project-header="proj-shell"]'))
  P.projects = await shellVec()
  const ph = P.projects.rects.projHeader
  if (ph) {
    await page.mouse.move(ph.x + ph.w / 2, ph.y + ph.h / 2)
    await page.waitForTimeout(80)
    P.projectsHover = await shellVec()
    P.shotProjects = await page.screenshot()
    const db = P.projectsHover.rects.projActionDanger
    if (db) {
      await page.mouse.move(db.x + db.w / 2, db.y + db.h / 2)
      await page.waitForTimeout(80)
      P.projectsDanger = await shellVec()
    }
    await page.mouse.move(0, 0)
  }

  // 5 · ⌘K palette, then its empty state.
  await page.evaluate(() => window.__pmMenu('command-palette'))
  try {
    await page.waitForFunction(() => document.querySelector('.ant-modal-container [data-idx="0"]'), { timeout: 8000 })
  } catch {
    const diag = await page.evaluate(() => {
      const wrap = document.querySelector('.ant-modal-wrap')
      return {
        modal: !!document.querySelector('.ant-modal-container'),
        wrap: !!wrap,
        wrapHtml: wrap ? wrap.innerHTML.slice(0, 300) : null,
        wrapClass: wrap ? wrap.className : null,
        pmMenu: typeof window.__pmMenu,
        bodyTails: [...document.body.children].map((c) => c.id || c.className || c.tagName).slice(-6),
      }
    })
    throw new Error('palette did not open: ' + JSON.stringify(diag))
  }
  P.palette = await shellVec()
  await page.fill('.ant-modal-container input', 'zzz')
  await page.waitForFunction(() => {
    const m = document.querySelector('.ant-modal-container')
    return m && !m.querySelector('[data-idx]')
  })
  P.paletteEmpty = await shellVec()
  await page.keyboard.press('Escape')
  // antd keeps a Modal's portal in the DOM after its first open (hidden), so
  // "closed" is a VISIBILITY fact, not an absence fact.
  try {
    await page.waitForFunction(() => {
      const w = document.querySelector('.ant-modal-wrap')
      return !w || getComputedStyle(w).display === 'none'
    }, { timeout: 8000 })
  } catch {
    const diag = await page.evaluate(() => {
      const w = document.querySelector('.ant-modal-wrap')
      const m = document.querySelector('.ant-modal')
      return {
        wrapStyle: w ? w.getAttribute('style') : null,
        wrapDisplay: w ? getComputedStyle(w).display : null,
        modalClass: m ? m.className : null,
        containerPresent: !!document.querySelector('.ant-modal-container'),
      }
    })
    throw new Error('palette did not close: ' + JSON.stringify(diag))
  }

  // 6 · search center: rest, then rows (the stub answers 命中), then a hovered row.
  await page.evaluate(() => window.__pmMenu('open-search'))
  await page.waitForFunction(() => document.querySelector('.ant-input-prefix'))
  P.search = await shellVec()
  await page.fill('.ant-input-affix-wrapper input', '命中')
  await page.waitForFunction(() => document.querySelector('.search-row'))
  P.searchRows = await shellVec()
  const sr = P.searchRows.rects.searchRow
  if (sr) {
    await page.mouse.move(sr.x + sr.w / 2, sr.y + sr.h / 2)
    await page.waitForTimeout(120)
    P.searchHover = await shellVec()
    P.shotSearch = await page.screenshot()
    await page.mouse.move(0, 0)
  }

  // 7 · usage center (the in-situ CenteredPage + the active bottom-bar icon).
  await page.evaluate(() => window.__pmMenu('open-usage'))
  await page.waitForFunction(() => document.querySelector('#shell .settings-scroll'))
  await page.waitForTimeout(150)
  P.usage = await shellVec()
  P.shotUsage = await page.screenshot()
  const ir = P.usage.rects.iconIdle
  if (ir) {
    await page.mouse.move(ir.x + ir.w / 2, ir.y + ir.h / 2)
    await page.waitForTimeout(80)
    P.iconHover = await shellVec()
    P.shotIconHover = await page.screenshot()
    await page.mouse.move(0, 0)
  }

  // 8 · the project modal, driven to its dir-probe error.
  await page.evaluate(() => { window.__pmDirResult = { ok: false, error: '探针：目录校验失败' } })
  await page.evaluate(() => window.__pmMenu('new-project'))
  // The palette's hidden portal is still in the DOM (first-open-keeps-it rule),
  // so waits key on the project modal's OWN unique placeholder.
  await page.waitForFunction(() => document.querySelector('input[placeholder="/path/to/workspace"]'))
  // afterOpenChange repopulates the form when the OPEN motion lands (~300ms) —
  // a fill that races it is wiped to '' again, and the dir error never comes.
  await page.waitForTimeout(450)
  await page.fill('input[placeholder="/path/to/workspace"]', '/tmp/pm-fixtures/probe')
  await page.waitForFunction(() => document.querySelector('.ant-modal-container [style*="--pm-error-status"]'))
  P.modal = await shellVec()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => {
    const ws = [...document.querySelectorAll('.ant-modal-wrap')]
    return ws.length === 0 || ws.every((w) => getComputedStyle(w).display === 'none')
  })

  // 9 · the extras fixture (mounted once, behind the fixed shell).
  P.extras = await shellVec()
  return P
}

/** Mean RGB over a patch of a screenshot; null when the patch leaves the frame
 *  (a sampler drifting off-viewport must fail loudly, not read black). Patch
 *  coords are rounded here: the samplers do client-rect arithmetic and hand
 *  back fractional pixels that sharp rejects. */
async function patchMean(shot, p) {
  if (!shot || !p) return null
  const x = Math.round(p.x)
  const y = Math.round(p.y)
  const w = Math.max(1, Math.round(p.w))
  const h = Math.max(1, Math.round(p.h))
  if (x < 0 || y < 0 || x + w > 1100 || y + h > 900) return null
  const { data, info } = await sharp(shot)
    .extract({ left: x, top: y, width: w, height: h })
    .raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const sum = [0, 0, 0]
  let min = [255, 255, 255]
  let max = [0, 0, 0]
  for (let i = 0; i < data.length; i += ch) {
    for (let c = 0; c < 3; c++) {
      sum[c] += data[i + c]
      if (data[i + c] < min[c]) min[c] = data[i + c]
      if (data[i + c] > max[c]) max[c] = data[i + c]
    }
  }
  const n = data.length / ch
  return {
    mean: sum.map((s) => s / n),
    spread: Math.max(...max.map((m, c) => m - min[c])),
  }
}

const parseRgb = (s) => {
  const m = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/.exec(s || '')
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
}

const relLum = ({ r, g, b }) => {
  const lin = (v) => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrastRatio = (fg, bg) => {
  const a = relLum(fg)
  const b = relLum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Expectations for one pass, derived from the LIVE sheet + the LIVE tokens —
 *  nothing here is a copied literal, so a palette/token move fails a check
 *  instead of passing against a stale copy. Every role is resolved through all
 *  three ink properties (a role can be a color on one element and a background
 *  on another), and token specs go through `__normColor` so a token's `#1f1f1f`
 *  and an element's computed `rgb(31, 31, 31)` compare equal. */
async function shellExpectations() {
  const roles = new Set()
  for (const rows of Object.values(SHELL_ROLE_TABLE)) {
    for (const map of Object.values(rows)) {
      for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
    }
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      // backgroundImage is in the set because --pm-sidebar is a gradient: it
      // only ever resolves into a background-image read.
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'backgroundImage']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  const tokens = await page.evaluate(() => window.__tokens || {})
  for (const rows of Object.values(SHELL_ROLE_TABLE)) {
    for (const map of Object.values(rows)) {
      for (const [prop, spec] of Object.entries(map)) {
        if (!spec.startsWith('@token.')) continue
        const tv = tokens[spec.slice(7)]
        normed[`${spec}|${prop}`] = tv == null ? null : await page.evaluate(([v, p]) => window.__normColor(v, p), [tv, prop])
      }
    }
  }
  // 10.5's binding on the Sider's border names a token the role table does not
  // carry — normalise it here too, or the cut check would compare undefined.
  {
    const tv = tokens.colorBorderSecondary
    normed['@token.colorBorderSecondary|borderRightColor'] = tv == null
      ? null
      : await page.evaluate(([v, p]) => window.__normColor(v, p), [tv, 'borderRightColor'])
  }
  const expectOf = (spec, prop) =>
    spec.startsWith('--pm-') || spec.startsWith('@token.') ? normed[`${spec}|${prop}`] ?? null : spec
  return { normed, tokens, expectOf }
}

const SHELL_SPEC_OF = (reading) => {
  const [phase, key, prop] = reading.split('.')
  const rows = SHELL_ROLE_TABLE[phase]
  return rows && rows[key] ? rows[key][prop] ?? null : null
}

// ── 10.6 the Dropdown's own selected row (the 项目 sort popup) ────────────────
// The sort popup's menu is antd's Dropdown, and the Dropdown's stylesheet
// paints its selected row straight from the ALIAS tokens — no Menu component
// token reaches it, so the ink primary used to derive `colorPrimaryBg` #404040
// there and the current mode read as black ink on dark grey (light; hovering
// the row was black on #333, the Hover twin). tokens.ts now pins the alias
// pair; these checks pin the visible result in both modes, and the var-follow
// control proves the rule really reads --ant-control-item-bg-active — so a
// future antd that hardens the value or reroutes the derivation fails here
// instead of silently repainting the popup.
async function driveSortDropdown(label) {
  await page.mouse.move(0, 0)
  // The shell's tab is whatever driveShellPhases left (phase 4 put 项目 on and
  // later phases only navigate the content pane) — but be idempotent rather
  // than trust it: switch only when the sort button is not there.
  const hasSort = await page.locator('button[aria-label="项目排序"]').count()
  if (!hasSort) await page.click('.sidebar-list-tab:not(.on)')
  await page.waitForFunction(() => document.querySelector('button[aria-label="项目排序"]'))
  await page.click('button[aria-label="项目排序"]')
  await page.waitForFunction(() => {
    const dd = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')
    return dd && dd.querySelector('.ant-dropdown-menu-item-selected')
  })
  const readSel = () => page.evaluate(() => {
    const el = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-selected')
    if (!el) return null
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, color: s.color }
  })
  const sel = await readSel()
  check(
    `${label} 排序弹窗：选中行背景（controlItemBgActive 钉值）`,
    !!sel && sel.bg === (label === '浅色' ? 'rgb(245, 245, 245)' : 'rgb(51, 51, 51)'),
    sel && JSON.stringify(sel)
  )
  check(
    `${label} 排序弹窗：选中行墨水可读`,
    !!sel && sel.color === (label === '浅色' ? 'rgb(0, 0, 0)' : 'rgb(199, 199, 199)'),
    sel && sel.color
  )
  // Hover the selected row with a REAL cursor — its :hover is the second token
  // of the pair (controlItemBgActiveHover, the worse half pre-fix in light:
  // black on #333). The item tweens background-color, so wait the tween out.
  const box = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-selected').first().boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(250)
    const hov = await readSel()
    check(
      `${label} 排序弹窗：选中行 hover 背景（controlItemBgActiveHover 钉值）`,
      !!hov && hov.bg === (label === '浅色' ? 'rgb(235, 235, 235)' : 'rgb(64, 64, 64)'),
      hov && JSON.stringify(hov)
    )
  }
  // The var-follow control: set the alias variable on the popup's menu and the
  // selected row must follow — the pin above judges a value, this one judges
  // the BINDING that makes the value reach the screen. Two timing facts shape
  // the code: the pointer leaves FIRST (the hover above left the row on the
  // Hover twin's rule, and the non-hover variable would read as a no-op against
  // it), and the read WAITS for the move — menu items tween background-color,
  // and a synchronous read lands on the interpolated start value (measured: an
  // inline background-color set and read in one tick still reported the old
  // colour).
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    const menu = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')
    menu.style.setProperty('--ant-control-item-bg-active', 'rgb(9, 8, 7)')
  })
  const movedToVar = await page.waitForFunction(() => {
    const el = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-selected')
    return el && getComputedStyle(el).backgroundColor === 'rgb(9, 8, 7)'
  }, null, { timeout: 2000 }).then(() => true).catch(() => false)
  check(`${label} 排序弹窗：选中行跟随 --ant-control-item-bg-active`, movedToVar, movedToVar ? 'rgb(9, 8, 7)' : `仍为 ${(await readSel() || {}).bg}`)
  await page.evaluate(() => {
    const menu = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')
    if (menu) menu.style.removeProperty('--ant-control-item-bg-active')
  })
  // Close: Escape first (antd closes the click-triggered dropdown on it); if a
  // popup is still open, the trigger toggles it shut.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const still = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').count()
  if (still) {
    await page.click('button[aria-label="项目排序"]')
    await page.waitForFunction(() => !document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)'), null, { timeout: 5000 }).catch(() => {})
  }
  await page.mouse.move(0, 0)
}

/** Assert every role row of every phase against one pass's vector. Returns the
 *  readings { 'phase.key.prop': value } so the flip/cut checks can compare.
 *  The cut-sheet pass opts out of two things that are meaningless there: the
 *  token-painted rows (the whole point of 10.5 is that the sheet does NOT
 *  carry them, so they still read dark) and the contrast floors (light ink
 *  over a dark algorithm ground is exactly the broken state the cut creates). */
async function checkShellRoles(P, label, expect, { skipTokenRows = false, skipContrast = false } = {}) {
  const readings = {}
  for (const [phase, rows] of Object.entries(SHELL_ROLE_TABLE)) {
    for (const [key, map] of Object.entries(rows)) {
      const vec = P[phase]
      const row = vec && vec.rows[key]
      if (!row) { check(`${label} ${phase}.${key} 存在`, false, '元素没有渲染出来'); continue }
      for (const [prop, spec] of Object.entries(map)) {
        if (skipTokenRows && spec.startsWith('@token.')) continue
        const want = expect.expectOf(spec, prop)
        const got = row[prop]
        readings[`${phase}.${key}.${prop}`] = got
        if (want == null) { check(`${label} ${phase}.${key}.${prop} 期望可解析`, false, `${spec} 解析为 null`); continue }
        check(`${label} ${phase}.${key}.${prop} = ${spec}`, got === want, `期望 ${want} 实得 ${got}`)
      }
      if (skipContrast) continue
      // Contrast floor for the role-named COLOR props (never for backgrounds).
      for (const [prop, spec] of Object.entries(map)) {
        if (prop !== 'color' || !spec.startsWith('--pm-')) continue
        const fg = parseRgb(row[prop])
        const groundSpec = vec.grounds[key]
        let bg = null
        if (groundSpec === 'gradient') {
          const sr = vec.rects.sider
          const er = vec.rects[key]
          if (sr && er) {
            // The gradient hangs on the Sider box (the sider itself never
            // scrolls), so the pixel at a given y is phase-independent — the
            // chats frame's strip is the bare ground for every phase.
            const gm = await patchMean(P.shotChats, { x: sr.x + 2, y: Math.round(er.y + er.h / 2) - 1, w: 4, h: 2 })
            if (gm) bg = { r: gm.mean[0], g: gm.mean[1], b: gm.mean[2] }
          }
        } else {
          bg = parseRgb(groundSpec)
        }
        if (!fg || !bg) { check(`${label} ${phase}.${key} 对比度可测`, false, `fg=${row[prop]} ground=${groundSpec}`); continue }
        const ratio = contrastRatio(fg, bg)
        const floor = SHELL_STRONG.includes(spec) ? 3.0 : SHELL_FAINT.includes(spec) ? 1.25 : null
        if (floor == null) continue
        check(`${label} ${phase}.${key} 对比度 ≥ ${floor}`, ratio >= floor, `${ratio.toFixed(2)} (${spec} on ${groundSpec})`)
      }
    }
  }
  return readings
}

const shellLight = await driveShellPhases()
const expLight = await shellExpectations()
const lightReadings = await checkShellRoles(shellLight, '浅色', expLight)

// The composite rows, light first. Ground = the measured gradient pixel at the
// element's own centre y (the gradient is vertical, so the colour is constant
// across x at a given y — the 4px strip left of the padded content IS the bare
// ground, which is exactly why every sider row keeps ≥8px of padding).
async function checkShellComposites(P, label) {
  for (const [key, phase, translucent] of SHELL_COMPOSITES) {
    const vec = P[phase]
    const role = vec && vec.alpha && vec.alpha[key]
    const patch = vec && vec.patches && vec.patches[key]
    const rect = vec && vec.rects && vec.rects[key]
    const sr = vec && vec.rects && vec.rects.sider
    if (!role || !patch || !rect || !sr) { check(`${label} 合成 ${key} 就绪`, false, `role=${role} patch=${!!patch} rect=${!!rect}`); continue }
    const shot = P[SHELL_SHOT_OF[phase]]
    const gm = await patchMean(shot, { x: sr.x + 2, y: Math.round(rect.y + rect.h / 2) - 1, w: 4, h: 2 })
    const pm = await patchMean(shot, patch)
    if (!gm || !pm) { check(`${label} 合成 ${key} 像素可读`, false, '截图补丁越界'); continue }
    check(`${label} 合成 ${key} 采样补丁均匀`, pm.spread <= 4, `spread=${pm.spread}`)
    if (!translucent) {
      const want = parseRgb(await page.evaluate((r) => window.__varColor(r), role))
      const ok = pm.mean.every((m, c) => Math.abs(m - [want.r, want.g, want.b][c]) <= 2)
      check(`${label} 合成 ${key}（不透明）像素 = ${role}`, ok, `期望 ${want.r},${want.g},${want.b} 实得 ${pm.mean.map((m) => Math.round(m)).join(',')}`)
      continue
    }
    const alpha = await page.evaluate((r) => window.__varAlpha(r), role)
    check(`${label} 合成 ${role} 的 alpha 确实是半透明`, alpha != null && alpha > 0 && alpha < 1, String(alpha))
    const roleRgb = parseRgb(await page.evaluate((r) => window.__varColor(r), role))
    const expected = [0, 1, 2].map((c) => alpha * [roleRgb.r, roleRgb.g, roleRgb.b][c] + (1 - alpha) * gm.mean[c])
    const err = Math.max(...expected.map((e, c) => Math.abs(e - pm.mean[c])))
    check(`${label} 合成 ${key} = fold(${role}, 地面像素)`, err <= 3, `最大通道误差 ${err.toFixed(2)}（地面 ${gm.mean.map((m) => Math.round(m)).join(',')}，实测 ${pm.mean.map((m) => Math.round(m)).join(',')}）`)
  }
}
await checkShellComposites(shellLight, '浅色')
await driveSortDropdown('浅色')

// ── 10.2 the dark pass ───────────────────────────────────────────────────────
await page.evaluate(() => window.__setMode('dark'))
const shellDark = await driveShellPhases()
const expDark = await shellExpectations()
const darkReadings = await checkShellRoles(shellDark, '深色', expDark)
await checkShellComposites(shellDark, '深色')
await driveSortDropdown('深色')

// The flip: every ROLE-named reading (and every token binding — the algorithm
// changed underneath it) moved; the registered inerts did not. Geometry too —
// a mode flip that reflows the shell is a bug of its own.
const flipFailed = []
const inertHeld = []
for (const [reading, lightVal] of Object.entries(lightReadings)) {
  const spec = SHELL_SPEC_OF(reading)
  const darkVal = darkReadings[reading]
  if (spec && !spec.startsWith('--pm-') && !spec.startsWith('@token.')) {
    // a registered inert (transparent at rest): identical in both modes
    if (darkVal === lightVal) inertHeld.push(reading)
    continue
  }
  if (darkVal === lightVal) flipFailed.push(`${reading}: ${lightVal}`)
}
check(
  '翻转：所有角色读数与 token 绑定都随模式变化',
  flipFailed.length === 0 && Object.keys(lightReadings).length > 0,
  flipFailed.length ? flipFailed.slice(0, 8).join(' | ') : `${Object.keys(lightReadings).length} 项全部不同`
)
check(
  '登记：透明/惰性面两种模式一致',
  inertHeld.length > 0,
  inertHeld.length ? `${inertHeld.length} 项保持（${inertHeld.slice(0, 4).join(', ')}…）` : '没有登记项被读到'
)
const shellRectDiff = []
// The extras fixture mounts ONCE, before the light pass, and reflows as the
// per-pass shell hosts come and go under it — its rectangles are not part of
// the flip's geometry contract, which is about the shell's own layout.
const SHELL_EXTRA_KEYS = ['errRoot', 'errPre', 'errStack', 'editorHeader', 'editorSurface', 'editorCard', 'extrasCenteredRoot', 'extrasCenteredColumn', 'extrasGround']
for (const key of Object.keys(shellLight.chats.rects)) {
  if (SHELL_EXTRA_KEYS.includes(key)) continue
  const a = shellLight.chats.rects[key]
  const b = shellDark.chats.rects[key]
  if (!a || !b) continue
  if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) shellRectDiff.push(key)
}
check('深色只改颜色：chats 相位的元素矩形与浅色逐项相同', shellRectDiff.length === 0, shellRectDiff.slice(0, 6).join(', ') || '全部一致')

// ── 10.3 tokens moved with the algorithm ─────────────────────────────────────
const TOKEN_MOVED = ['colorBorderSecondary', 'colorBgContainer', 'colorBgElevated', 'colorText']
const movedTokens = TOKEN_MOVED.filter((t) => expLight.tokens[t] === expDark.tokens[t])
check('token 行：四个依赖的 antd token 在明暗之间确实不同', movedTokens.length === 0, movedTokens.join(', ') || TOKEN_MOVED.map((t) => `${t}: ${expLight.tokens[t]} → ${expDark.tokens[t]}`).join('; '))

// ── 10.4 the cut-sheet control ───────────────────────────────────────────────
// The sheet minus its dark section, installed while the attribute reads dark:
// every ROLE reading must fall back to its light value, every TOKEN binding
// must stay at the algorithm's dark output (the sheet is not what paints it).
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVarsNoDark())
const shellCut = await driveShellPhases()
const cutReadings = await checkShellRoles(shellCut, '删段', expLight, { skipTokenRows: true, skipContrast: true })
// Only the --pm-* readings are the sheet's to carry; token bindings and the
// registered inerts are excluded (the former MUST stay dark — see 10.5 — the
// latter are transparent in every mode).
const cutBad = Object.keys(lightReadings).filter((r) => {
  const spec = SHELL_SPEC_OF(r)
  return spec && spec.startsWith('--pm-') && cutReadings[r] !== lightReadings[r]
})
check(
  '10.4 删掉 dark 段：角色读数全部回落到浅色值',
  cutBad.length === 0,
  cutBad.length ? cutBad.slice(0, 8).map((r) => `${r}: 浅 ${lightReadings[r]} / 删段后 ${cutReadings[r]}`).join(' | ') : `${Object.keys(lightReadings).length} 项全部回落`
)
// Each token row is read from the phase that actually carries it — the modal
// surfaces exist only while their modal is the open one.
const tokenHeld = [
  ['chats', 'sider', 'borderRightColor', 'colorBorderSecondary'],
  ['chats', 'header', 'backgroundColor', 'colorBgContainer'],
  ['palette', 'palettePaper', 'backgroundColor', 'colorBgElevated'],
]
const tokenHeldBad = tokenHeld.filter(([phase, key, prop, tok]) => {
  const vec = shellCut[phase]
  const darkNorm = expDark.normed[`@token.${tok}|${prop}`]
  return !vec || !vec.rows[key] || vec.rows[key][prop] !== darkNorm
})
check(
  '10.5 删掉 dark 段：token 面纹丝不动（算法着色，不走表）',
  tokenHeldBad.length === 0,
  tokenHeldBad.length ? tokenHeldBad.map(([, k, p, t]) => `${k}.${p}: 期望 ${expDark.normed[`@token.${t}|${p}`]} 实得 ${(shellCut.chats.rows[k] || shellCut.palette.rows[k] || {})[p]}`).join(' | ') : `${tokenHeld.length} 项保持深色`
)

await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVars())
await page.waitForTimeout(50)
await page.evaluate(() => window.__setMode('light'))

// ── 11. the welcome band (M3/T1) ─────────────────────────────────────────────
// The two welcome components read the content stores ON MOUNT, so the fixtures
// ride the stub and the mounts are staggered: the data host loads with lists
// present, then the stub flips to empty + a hung listConversations for the
// empty host (its chat slice stays undefined — the skeleton is the loading
// state, and only a never-resolving promise holds it deterministically). The
// project picker reloads the shared store with its own two projects: one with
// a conversation to quote, one whose row reads 立即开始.
console.log('\n=== 11. 欢迎带（M3/T1） ===')

// key → [prop, role] per element, in three hosts. Light = the literal each
// role replaced (the same freeze the other tables assert).
const WELCOME_TABLE = {
  data: {
    chatCard: { backgroundColor: '--pm-card-soft' },
    chatLabel: { color: '--pm-text-muted' },
    chatHeadline: { color: '--pm-text-strong' },
    chatDetail: { color: '--pm-text-quiet' },
    chatMeta: { color: '--pm-text-soft' },
    chatDot: { backgroundColor: '--pm-link' },
    runCard: { backgroundColor: '--pm-card-soft' },
    runBadge: { color: '--pm-success' },
    runNow: { color: '--pm-text-muted' },
    knowCard: { backgroundColor: '--pm-card-soft' },
  },
  empty: {
    emptyHeadline: { color: '--pm-text-muted' },
    emptyDetail: { color: '--pm-text-haze' },
    skelBar: { backgroundColor: '--pm-skeleton' },
  },
  projects: {
    projHeading: { color: '--pm-text-strong' },
    projPill: { color: '--pm-text-quiet' },
    projCard: { backgroundColor: '--pm-card-soft' },
    projName: { color: '--pm-text-strong' },
    projTime: { color: '--pm-text-faint' },
    projQuote: { color: '--pm-text-quiet' },
    projPlay: { color: '--pm-text-muted' },
    projStart: { color: '--pm-text-muted' },
    createCard: { borderTopColor: '--pm-dash-border', color: '--pm-text-quiet' },
    starterLabel: { color: '--pm-text-muted' },
  },
}
// The hover wash is a JS handler (no CSS :hover), so the pointer drives it and
// the computed background answers directly — no composite needed.
// The hovered element is the project card itself — the reader's projCard key.
const WELCOME_HOVER = { projCard: { backgroundColor: '--pm-card-soft-hover' } }

const welcomeVec = () => page.evaluate(() => window.__welcomeVector())

await page.evaluate(() => window.__mountWelcomeData())
try {
  await page.waitForFunction(() => {
    const host = document.getElementById('welcome-data')
    if (!host) return false
    const band = [...host.querySelectorAll('div')].find((d) => d.style.display === 'flex' && d.style.minHeight === '158px')
    if (!band || band.children.length !== 3) return false
    // the routine card's data state: headline + detail + meta + a run button
    const c = band.children[1]
    return c && c.children.length >= 4 && !!c.querySelector('button')
  }, { timeout: 8000 })
} catch {
  const diag = await page.evaluate(() => {
    const host = document.getElementById('welcome-data')
    const band = host && [...host.querySelectorAll('div')].find((d) => d.style.display === 'flex' && d.style.minHeight === '158px')
    const cards = band ? [...band.children] : []
    return {
      colChildren: band ? band.children.length : -1,
      cardKids: cards.map((c) => c.children.length),
      firstCardText: cards[0] ? cards[0].textContent.slice(0, 80) : null,
      secondCardText: cards[1] ? cards[1].textContent.slice(0, 80) : null,
      lists: typeof window.__pmLists,
    }
  })
  throw new Error('welcome data did not load: ' + JSON.stringify(diag))
}
await page.evaluate(() => window.__mountWelcomeEmpty())
await page.waitForFunction(() => {
  const host = document.getElementById('welcome-empty-host')
  if (!host || !host.firstElementChild) return false
  // the hung chat slice renders its skeleton: five rounded bars
  return !!host.querySelector('div[style*="border-radius: 5px"]')
})
await page.evaluate(() => window.__mountWelcomeProjects())
await page.waitForFunction(() => !!document.querySelector('[data-action="create-project"]'))
// §10's shell is a fixed full-viewport layer at z10; §11's mouse work happens
// underneath it, so the shell leaves the stage once its own section is done.
await page.evaluate(() => { const sh = document.getElementById('shell-host'); if (sh) sh.style.display = 'none' })
await page.mouse.move(0, 0)

async function welcomeExpectations() {
  const roles = new Set()
  for (const rows of [...Object.values(WELCOME_TABLE), WELCOME_HOVER]) {
    for (const map of Object.values(rows)) {
      for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
    }
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  const expectOf = (spec, prop) => (spec.startsWith('--pm-') ? normed[`${spec}|${prop}`] ?? null : spec)
  return { expectOf }
}

async function checkWelcomeRoles(label, expect) {
  const vec = await welcomeVec()
  const readings = {}
  for (const [host, rowsMap] of Object.entries(WELCOME_TABLE)) {
    for (const [key, map] of Object.entries(rowsMap)) {
      const row = vec[key]
      if (!row) { check(`${label} welcome ${key} 存在`, false, `${host} 宿主里没有渲染出来`); continue }
      for (const [prop, spec] of Object.entries(map)) {
        const want = expect.expectOf(spec, prop)
        const got = row[prop]
        readings[`${key}.${prop}`] = got
        check(`${label} welcome ${key}.${prop} = ${spec}`, got === want, `期望 ${want} 实得 ${got}`)
      }
    }
  }
  return readings
}

const expWelcomeLight = await welcomeExpectations()
const welcomeLight = await checkWelcomeRoles('浅色', expWelcomeLight)

// the project card's hover, driven by a real mouse (React writes it inline)
const wv = await welcomeVec()
// rect for the first grid card comes from the DOM the same way the reader walks it
// The three §11 hosts stack vertically and the projects grid lands below the
// fold, so the hover scrolls the card into view first and measures the rect
// AFTER the scroll (a pre-scroll rect would aim the pointer at empty space).
const projCardRect = async () => {
  await page.evaluate(() => {
    const host = document.getElementById('welcome-projects-host')
    const grid = host && [...host.querySelectorAll('div')].find((d) => d.style.display === 'grid')
    if (grid && grid.children[0]) grid.children[0].scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(50)
  return page.evaluate(() => {
    const host = document.getElementById('welcome-projects-host')
    const grid = host && [...host.querySelectorAll('div')].find((d) => d.style.display === 'grid')
    const card = grid && grid.children[0]
    if (!card) return null
    const r = card.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
}
const projCardRectLight = await projCardRect()
let welcomeHoverReadings = {}
if (projCardRectLight) {
  await page.mouse.move(projCardRectLight.x + projCardRectLight.w / 2, projCardRectLight.y + projCardRectLight.h / 2)
  await page.waitForTimeout(60)
  const hv = await welcomeVec()
  for (const [key, map] of Object.entries(WELCOME_HOVER)) {
    const row = hv[key]
    for (const [prop, spec] of Object.entries(map)) {
      const want = expWelcomeLight.expectOf(spec, prop)
      const got = row ? row[prop] : null
      welcomeHoverReadings[`${key}.${prop}`] = got
      check(`浅色 welcome 项目卡悬停.${prop} = ${spec}（真鼠标悬停）`, got === want, `期望 ${want} 实得 ${got}`)
    }
  }
  await page.mouse.move(0, 0)
} else {
  check('浅色 welcome projCardHover 就绪', false, '项目卡没有渲染出来')
}

await page.evaluate(() => window.__setMode('dark'))
const expWelcomeDark = await welcomeExpectations()
const welcomeDark = await checkWelcomeRoles('深色', expWelcomeDark)
let welcomeHoverDark = {}
{
  const want = expWelcomeDark.expectOf('--pm-card-soft-hover', 'backgroundColor')
  const projCardRectDark = await projCardRect()
  if (projCardRectDark) {
    await page.mouse.move(projCardRectDark.x + projCardRectDark.w / 2, projCardRectDark.y + projCardRectDark.h / 2)
    await page.waitForTimeout(60)
    const hv = await welcomeVec()
    welcomeHoverDark.projCard = hv.projCard ? hv.projCard.backgroundColor : null
    check('深色 welcome 项目卡悬停.backgroundColor = --pm-card-soft-hover（真鼠标悬停）', welcomeHoverDark.projCard === want, `期望 ${want} 实得 ${welcomeHoverDark.projCard}`)
    await page.mouse.move(0, 0)
  }
}
await page.evaluate(() => window.__setMode('light'))

const welcomeFlipFailed = []
for (const [reading, lightVal] of Object.entries(welcomeLight)) {
  if (welcomeDark[reading] === lightVal) welcomeFlipFailed.push(`${reading}: ${lightVal}`)
}
check(
  '翻转：欢迎带全部角色读数都随模式变化',
  welcomeFlipFailed.length === 0 && Object.keys(welcomeLight).length > 0,
  welcomeFlipFailed.length ? welcomeFlipFailed.slice(0, 8).join(' | ') : `${Object.keys(welcomeLight).length} 项全部不同`
)
check(
  '翻转：项目卡悬停面也随模式变化',
  welcomeHoverReadings.projCard !== welcomeHoverDark.projCard,
  `浅 ${welcomeHoverReadings.projCard} / 深 ${welcomeHoverDark.projCard}`
)

// ── 12. the workbench + routine surfaces (M3/T2) ─────────────────────────────
console.log('\n=== 12. 计划图 / 例程中心 / 子代理头（M3/T2） ===')
const T2_TABLE = {
  graphCanvas: { backgroundColor: '--pm-graph-canvas' },
  objective: { color: '--pm-text' },
  progressTrack: { backgroundColor: '--pm-border-hairline' },
  progressFill: { backgroundColor: '--pm-text' },
  // The in-flight card's BORDER is --pm-graph-ink-dim by design; the live ink
  // is the card's words, not its outline.
  readyStroke: { stroke: '--pm-graph-ink-dim' },
  nodeFill: { fill: '--pm-elevated' },
  pageBg: { backgroundColor: '--pm-bg' },
  cardBorder: { borderTopColor: '--pm-border-hairline' },
  pill: { backgroundColor: '--pm-fill', color: '--pm-text-secondary' },
  newCard: { borderTopColor: '--pm-dash-border', color: '--pm-text-quiet' },
  headInk: { color: '--pm-text-strong' },
  runsRule: { borderLeftColor: '--pm-border-hairline' },
  subBg: { backgroundColor: '--pm-bg' },
  subBack: { color: '--pm-text-body' },
  subTitle: { color: '--pm-text-strong' },
  subBadge: { backgroundColor: '--pm-fill', color: '--pm-text-muted' },
}

await page.evaluate(() => window.__mountT2())
await page.waitForFunction(() => {
  const g = document.getElementById('t2-graph')
  const r = document.getElementById('t2-routine')
  return !!g && !!g.querySelector('[data-objective]') && !!r && !!r.querySelector('.routine-card')
})
// …then the empty-state routine host, whose dashed 新建任务 card is the only
// create affordance that exists without tasks (see __mountT2Empty above).
await page.evaluate(() => window.__mountT2Empty())
await page.waitForFunction(() => !!document.querySelector('#t2-routine-empty .routine-new-card'))
await page.waitForTimeout(100)

async function t2Expectations() {
  const roles = new Set()
  for (const map of Object.values(T2_TABLE)) {
    for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'fill', 'stroke']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  const expectOf = (spec, prop) => (spec.startsWith('--pm-') ? normed[`${spec}|${prop}`] ?? null : spec)
  return { expectOf }
}

async function checkT2Roles(label, expect) {
  const vec = await page.evaluate(() => window.__t2Vector())
  const readings = {}
  for (const [key, map] of Object.entries(T2_TABLE)) {
    const row = vec[key]
    if (!row) { check(`${label} t2 ${key} 存在`, false, '没有渲染出来'); continue }
    for (const [prop, spec] of Object.entries(map)) {
      const want = expect.expectOf(spec, prop)
      const got = row[prop]
      readings[`${key}.${prop}`] = got
      check(`${label} t2 ${key}.${prop} = ${spec}`, got === want, `期望 ${want} 实得 ${got}`)
    }
  }
  return readings
}

if (dump) {
  const d = await page.evaluate(() => {
    const sub = document.getElementById('t2-sub')
    const root = sub && sub.querySelector('.ant-app > div')
    return {
      subHostExists: !!sub,
      antAppCount: sub ? sub.querySelectorAll('.ant-app').length : 0,
      rootTag: root ? root.tagName : null,
      rootStyle: root ? (root.getAttribute('style') || '').slice(0, 80) : null,
      rootKids: root ? [...root.children].map((c) => c.tagName + ':' + (c.getAttribute('style') || '').slice(0, 50)) : null,
    }
  })
  console.log('  [dump t2-sub]', JSON.stringify(d))
}
const expT2Light = await t2Expectations()
const t2Light = await checkT2Roles('浅色', expT2Light)
await page.evaluate(() => window.__setMode('dark'))
// The dashed 新建任务 card carries `transition: border-color 0.2s, color 0.2s`
// (CENTER_STYLES — the layout probe reads its hover off those computed
// colours), so a read taken inside the 200ms theme flip catches the tween
// rather than either end of it (measured: 期望 rgb(77,77,77) 实得 rgb(191,191,195)
// without the wait — mid-flight toward the dark value, and flaky at that,
// since the flip check only needs the reading to differ from the light one).
await page.waitForTimeout(300)
const expT2Dark = await t2Expectations()
const t2Dark = await checkT2Roles('深色', expT2Dark)
await page.evaluate(() => window.__setMode('light'))
const t2Flip = Object.keys(t2Light).filter((r) => t2Dark[r] === t2Light[r])
check('翻转：计划图与例程面的读数都随模式变化', t2Flip.length === 0 && Object.keys(t2Light).length > 0, t2Flip.slice(0, 6).join(' | ') || `${Object.keys(t2Light).length} 项全部不同`)

// ── 12b. the routine card's prompt hover ─────────────────────────────────────
// The card's description used to carry a native `title`, and THAT tooltip is
// drawn by the OS — always light, in every mode (the user report: 「展示任务
// 提示词时，用的还是浅色模式」). The attribute must be gone (so the native
// layer cannot appear at all), and the layer a hover draws must be antd's —
// a dark surface in BOTH modes: antd's own spotlight ground is dark either
// way, and tokens.ts pins the dark mode's ink at rgb(240,240,240). The
// native tooltip is never in the DOM, so the hover reads below fail against
// the old code on both counts.
const DESC_SEL = '#t2-routine [data-routine-desc]'
console.log('\n=== 12b. 日常卡片提示词悬浮层（antd Tooltip，非常生 title） ===')
check('例程卡：描述渲染出来了（非空性 — 选择器钉得住）',
  await page.evaluate((sel) => !!document.querySelector(sel) && document.querySelector(sel).textContent.length > 0, DESC_SEL))
check('例程卡：描述不再携带原生 title（原生气泡永远是浅色、不受主题管）',
  await page.evaluate((sel) => { const el = document.querySelector(sel); return !!el && !el.hasAttribute('title') }, DESC_SEL))
// Only a VISIBLE container counts — earlier sections' tooltips stay mounted
// but hidden, and this card's own action row (立即运行/编辑/删除) owns three
// more of them. The try/catch is the non-vacuity exit: against the old code
// no antd tooltip exists for this element at all (the native one is never in
// the DOM), so the waits time out and the reads come back null — a clean
// FAIL, not a crash.
async function readPromptTooltip() {
  try {
    await page.hover(DESC_SEL)
    await page.waitForFunction(() => [...document.querySelectorAll('.ant-tooltip-container')]
      .some((el) => el.getBoundingClientRect().height > 0 && /汇总昨日数据并生成简报/.test(el.textContent)), undefined, { timeout: 5000 })
    const out = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.ant-tooltip-container')]
        .find((c) => c.getBoundingClientRect().height > 0)
      const s = getComputedStyle(el)
      const rgb = (s.backgroundColor.match(/\d+(\.\d+)?/g) || []).map(Number)
      return { text: el.textContent.slice(0, 20), bg: s.backgroundColor, ink: s.color, darkGround: rgb.length >= 3 && (rgb[0] + rgb[1] + rgb[2]) < 384 }
    })
    await page.mouse.move(0, 0)
    await page.waitForFunction(() => ![...document.querySelectorAll('.ant-tooltip-container')]
      .some((el) => el.getBoundingClientRect().height > 0), undefined, { timeout: 5000 })
    return out
  } catch {
    return null
  }
}
const tipLight = await readPromptTooltip()
check('例程卡：浅色下悬浮画出的是 antd 气泡，承载提示词全文',
  !!tipLight && /汇总昨日数据并生成简报/.test(tipLight.text ?? ''), JSON.stringify(tipLight))
check('例程卡：浅色下气泡面也是深底浅字（antd 气泡两种模式一个面）',
  tipLight?.darkGround === true && tipLight.ink === 'rgb(255, 255, 255)', JSON.stringify(tipLight))
await page.evaluate(() => window.__setMode('dark'))
const tipDark = await readPromptTooltip()
check('例程卡：深色下悬浮画出的仍是 antd 气泡（不再是系统浅色提示框）',
  !!tipDark && /汇总昨日数据并生成简报/.test(tipDark.text ?? ''), JSON.stringify(tipDark))
check('例程卡：深色下气泡深底，文字是主题钉定的 rgb(240, 240, 240)',
  tipDark?.darkGround === true && tipDark.ink === 'rgb(240, 240, 240)', JSON.stringify(tipDark))
await page.evaluate(() => window.__setMode('light'))

// ── 13. capability / settings / browser chrome (M3/T3–T5) ────────────────────
// One or two roles per surface: the pill wash, the settings sheet, the browser
// tab and address wash. The light values are the frozen literals; the dark
// column is asserted the same way.
console.log('\n=== 13. 能力中心 / 设置页 / 浏览器面板（M3/T3–T5） ===')
const T3_TABLE = {
  capPageBg: { backgroundColor: '--pm-bg' },
  capPillActive: { backgroundColor: '--pm-hover-strong', color: '--pm-ink' },
  settingsSheet: { backgroundColor: '--pm-bg' },
  settingsTab: { backgroundColor: '--pm-border-hairline', color: '--pm-text-strong' },
  browserGround: { backgroundColor: '--pm-bg' },
  browserTabActive: { backgroundColor: '--pm-tile-soft' },
  browserAddress: { backgroundColor: '--pm-wash-cool' },
}

await page.evaluate(() => window.__mountT3())
await page.waitForFunction(() => {
  const cap = document.getElementById('t3-capability')
  const settings = document.getElementById('t3-settings')
  const browser = document.getElementById('t3-browser')
  return !!cap && !!cap.querySelector('.pm-cap-pill-active')
    && !!settings && !!settings.querySelector('[data-settings-menu="environment"]')
    && !!browser && browser.querySelectorAll('div').length > 3
})
await page.waitForTimeout(100)

async function t3Expectations() {
  const roles = new Set()
  for (const map of Object.values(T3_TABLE)) {
    for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      for (const prop of ['color', 'backgroundColor']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  const expectOf = (spec, prop) => (spec.startsWith('--pm-') ? normed[`${spec}|${prop}`] ?? null : spec)
  return { expectOf }
}

async function checkT3Roles(label, expect) {
  const vec = await page.evaluate(() => window.__t3Vector())
  const readings = {}
  for (const [key, map] of Object.entries(T3_TABLE)) {
    const row = vec[key]
    if (!row) { check(`${label} t3 ${key} 存在`, false, '没有渲染出来'); continue }
    for (const [prop, spec] of Object.entries(map)) {
      const want = expect.expectOf(spec, prop)
      const got = row[prop]
      readings[`${key}.${prop}`] = got
      check(`${label} t3 ${key}.${prop} = ${spec}`, got === want, `期望 ${want} 实得 ${got}`)
    }
  }
  return readings
}

const expT3Light = await t3Expectations()
const t3Light = await checkT3Roles('浅色', expT3Light)
await page.evaluate(() => window.__setMode('dark'))
const expT3Dark = await t3Expectations()
const t3Dark = await checkT3Roles('深色', expT3Dark)
await page.evaluate(() => window.__setMode('light'))
const t3Flip = Object.keys(t3Light).filter((r) => t3Dark[r] === t3Light[r])
check('翻转：能力/设置/浏览器面的读数都随模式变化', t3Flip.length === 0 && Object.keys(t3Light).length > 0, t3Flip.slice(0, 6).join(' | ') || `${Object.keys(t3Light).length} 项全部不同`)

// ── 14. the preview pane family (M4/T1–T3) ───────────────────────────────────
// The chrome of every renderer, in both modes, with the paper/data literals
// registered as mode-independent IN the table (spec is a literal there, so the
// expectation is the same string in both passes — a paper that flipped fails
// the light pass, a role that failed to flip fails the dark pass and the flip
// check). The cut control at the end re-uses §9's machine: with the sheet's
// dark section gone, every role reading must fall back to its light value.
console.log('\n=== 14. 预览面（M4/T1–T3） ===')
const T4_TABLE = {
  paneGround: { backgroundColor: '--pm-bg' },
  tabActive: { backgroundColor: '--pm-tile-soft', boxShadow: '--pm-shadow-chip', color: '--pm-text-strong' },
  tabIdle: { color: '--pm-text-quiet' },
  stripBorder: { borderBottomColor: '--pm-separator-faint' },
  toolInk: { color: '--pm-text-secondary' },
  pathInk: { color: '--pm-text-muted' },
  errInk: { color: '--pm-text-muted' },
  // the empty state's decorative icon keeps its literal grey on purpose; the
  // hint line under it was #bbb — the faint rung
  emptyIcon: { color: 'rgb(217, 217, 217)' },
  emptyHint: { color: '--pm-text-faint' },
  sheetHeader: { backgroundColor: '--pm-wash-cool', color: '--pm-text-muted' },
  // the workbook's own fill: file content, not UI
  sheetDataFill: { backgroundColor: 'rgb(68, 114, 196)' },
  // the inherited cell ink, now written down as a role
  sheetPlainInk: { color: '--pm-sheet-ink' },
  // the formula kind tint: a data-kind colour, mode-independent
  sheetFormulaInk: { color: 'rgb(114, 46, 209)' },
  sheetbarBorder: { borderTopColor: '--pm-separator-faint' },
  sheetTabActive: { backgroundColor: '--pm-link-bg-solid', color: '--pm-link' },
  sheetFooter: { borderTopColor: '--pm-border-hairline' },
  zoomLabel: { color: '--pm-text-secondary' },
  pdfDesk: { backgroundColor: '--pm-desk' },
  // the page box is paper: white in both modes, its shadow deepens
  pdfPage: { backgroundColor: 'rgb(255, 255, 255)', boxShadow: '--pm-shadow-page' },
  pdfInput: { color: '--pm-text-strong', borderBottomColor: '--pm-input-border' },
  pdfTotal: { color: '--pm-text-secondary' },
  pdfFooter: { borderTopColor: '--pm-border-hairline' },
  // the docx desk is docx-preview's own grey, registered as mode-independent
  docxDesk: { backgroundColor: 'rgb(128, 128, 128)' },
  docxFooter: { borderTopColor: '--pm-border-hairline' },
  pptxNote: { color: '--pm-warn', backgroundColor: '--pm-warn-bg', borderBottomColor: '--pm-warn-border' },
  pptxDesk: { backgroundColor: 'rgb(128, 128, 128)' },
  pptxSlide: { backgroundColor: 'rgb(255, 255, 255)' },
  pptxFooter: { borderTopColor: '--pm-border-hairline' },
  csvHead: { backgroundColor: '--pm-wash-cool', color: '--pm-text-strong' },
  csvCell: { color: '--pm-text-body', borderBottomColor: '--pm-border-hairline' },
  fallbackName: { color: '--pm-text-strong' },
  fallbackMeta: { color: '--pm-text-muted' },
  fallbackHint: { color: '--pm-text-muted' },
  crumbInk: { color: '--pm-text-strong' },
  crumbChevron: { color: '--pm-text-faint' },
  actionDisabled: { color: '--pm-text-disabled' },
  actionNormal: { color: '--pm-text-secondary' },
  // the danger icon keeps its literal mid-grey; its wash + border are themed
  actionDanger: { backgroundColor: '--pm-danger-wash', borderBottomColor: '--pm-border-soft', color: 'rgb(140, 140, 140)' },
  aiBtn: { backgroundColor: '--pm-btn-disabled', color: '--pm-ink-contrast' },
  aiSparkle: { color: '--pm-text-muted' },
  hintBar: { backgroundColor: '--pm-wash-cool', color: '--pm-text-muted', borderTopColor: '--pm-separator-faint' },
}

await page.evaluate((bin) => { window.__pmBinaries = bin }, {
  '/w/表.xlsx': XLSX_B64,
  '/w/文.pdf': PDF_B64,
  '/w/文.docx': DOCX_B64,
  '/w/片.pptx': PPTX_B64,
})
await page.evaluate(() => window.__mountT4())
await page.waitForFunction(() => {
  return !!document.querySelector('#t4-pane [data-tab-path]')
    && !!document.querySelector('#t4-pane-empty')
    && !!document.querySelector('#t4-xlsx [data-xlsx-grid]')
    && !!document.querySelector('#t4-pdf [data-pdf-page="1"]')
    && !!document.querySelector('#t4-docx .pm-docx-wrapper')
    && !!document.querySelector('#t4-pptx [data-pptx-slide="1"]')
    && !!document.querySelector('#t4-element button')
    && !!document.querySelector('#t4-element-hint div')
}, { timeout: 20000 })
await page.waitForTimeout(150)

async function t4Expectations() {
  const roles = new Set()
  for (const map of Object.values(T4_TABLE)) {
    for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'boxShadow']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  const expectOf = (spec, prop) => (spec.startsWith('--pm-') ? normed[`${spec}|${prop}`] ?? null : spec)
  return { expectOf }
}

async function checkT4Roles(label, expect) {
  const vec = await page.evaluate(() => window.__t4Vector())
  const readings = {}
  for (const [key, map] of Object.entries(T4_TABLE)) {
    const row = vec[key]
    if (!row) { check(`${label} t4 ${key} 存在`, false, '没有渲染出来'); continue }
    for (const [prop, spec] of Object.entries(map)) {
      const want = expect.expectOf(spec, prop)
      const got = row[prop]
      readings[`${key}.${prop}`] = { got, spec }
      check(`${label} t4 ${key}.${prop} = ${spec}`, got === want, `期望 ${want} 实得 ${got}`)
    }
  }
  return readings
}

const expT4Light = await t4Expectations()
const t4Light = await checkT4Roles('浅色', expT4Light)
await page.evaluate(() => window.__setMode('dark'))
const expT4Dark = await t4Expectations()
const t4Dark = await checkT4Roles('深色', expT4Dark)

// The flip discipline, per key: role-borne readings must move with the mode,
// the registered literals must NOT. A reading missing from either pass (an
// element that did not render) counts against the flip checks — the per-role
// checks above already named it.
const t4RoleKeys = [...new Set(Object.entries(T4_TABLE).flatMap(([key, map]) => Object.values(map).some((v) => v.startsWith('--pm-')) ? [key] : []))]
const t4LiteralKeys = Object.keys(T4_TABLE).filter((k) => !t4RoleKeys.includes(k))
const t4Missing = []
const t4BothRead = (key, prop) => {
  const l = t4Light[`${key}.${prop}`]
  const d = t4Dark[`${key}.${prop}`]
  if (!l || !d) { t4Missing.push(`${key}.${prop}`); return null }
  return [l.got, d.got]
}
const t4NotFlipped = t4RoleKeys.filter((key) => {
  const map = T4_TABLE[key]
  // Only the ROLE-borne props must flip — a role key may also carry a
  // registered literal (the danger icon's ink, the page's white paper), and
  // that prop is judged by the mode-independent check below instead.
  return Object.entries(map).some(([prop, spec]) => {
    if (!spec.startsWith('--pm-')) return false
    const pair = t4BothRead(key, prop)
    return pair !== null && pair[0] === pair[1]
  })
})
check('翻转：预览面全部角色读数都随模式变化', t4NotFlipped.length === 0 && t4Missing.length === 0, [...t4NotFlipped, ...t4Missing].join(' | ') || `${t4RoleKeys.length} 个角色的读数全部不同`)
const t4PaperMoved = t4LiteralKeys.filter((key) => {
  const map = T4_TABLE[key]
  return Object.keys(map).some((prop) => {
    const pair = t4BothRead(key, prop)
    return pair !== null && pair[0] !== pair[1]
  })
})
check('纸张/数据面不随模式翻转（登记的模式无关项）', t4PaperMoved.length === 0 && t4Missing.length === 0, [...t4PaperMoved, ...t4Missing].join(' | ') || `${t4LiteralKeys.length} 项在两种模式下逐字节相同`)
await page.evaluate(() => window.__setMode('light'))

// The cut control: with the sheet's dark section gone and the attribute still
// reading dark, every role reading must fall back to its light value.
await page.evaluate(() => window.__setMode('dark'))
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVarsNoDark())
await page.waitForTimeout(50)
{
  const vec = await page.evaluate(() => window.__t4Vector())
  const bad = []
  for (const key of t4RoleKeys) {
    const map = T4_TABLE[key]
    for (const [prop, spec] of Object.entries(map)) {
      const want = expT4Light.expectOf(spec, prop)
      if (vec[key] && vec[key][prop] !== want) bad.push(`${key}.${prop}: ${vec[key][prop]} ≠ 浅色 ${want}`)
    }
  }
  check('删掉 dark 段：预览面角色全部落回浅色值', bad.length === 0, bad.slice(0, 6).join(' | ') || `${t4RoleKeys.length} 个角色全部回落`)
}
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVars())
await page.evaluate(() => window.__setMode('light'))
await page.waitForTimeout(50)
{
  const vec = await page.evaluate(() => window.__t4Vector())
  const want = expT4Light.expectOf(T4_TABLE.paneGround.backgroundColor, 'backgroundColor')
  check('装回真表、回到浅色：取值复原', !!vec.paneGround && vec.paneGround.backgroundColor === want, `期望 ${want} 实得 ${vec.paneGround && vec.paneGround.backgroundColor}`)
}

// ── 15. the workbench shell (the chrome the preview wave's siblings left
// behind — the user report: in dark mode the side window's top tab strip was
// still light). Same discipline as §14: role readings in both passes, the
// flip check, then the sheet cut — with the dark section gone and the
// attribute still dark, every reading must fall back to its light value.
console.log('\n=== 15. 工作台外壳 ===')
const WB_TABLE = {
  paneGround: { backgroundColor: '--pm-bg', borderLeftColor: '--pm-pop-border' },
  stripGround: { backgroundColor: '--pm-bg', borderBottomColor: '--pm-separator-faint' },
  tabActive: { backgroundColor: '--pm-tile-soft', boxShadow: '--pm-shadow-chip', color: '--pm-text-strong' },
  tabIdle: { color: '--pm-text-quiet' },
  badgeCount: { backgroundColor: '--pm-badge-muted' },
  badgePlan: { backgroundColor: '--pm-link' },
  closeInk: { color: '--pm-text-quiet' },
  wsPathBar: { borderBottomColor: '--pm-separator-faint' },
  wsPathText: { color: '--pm-text-secondary' },
  wsBtnInk: { color: '--pm-graph-ink-dim' },
  editorInk: { color: '--pm-text-strong', backgroundColor: '--pm-bg' },
}

await page.evaluate(() => {
  window.__pmListDir = { '/w/工作区': { entries: [{ name: '报.md', path: '/w/工作区/报.md', isDir: false }] } }
  window.__mountWB()
})
await page.waitForFunction(() => {
  const strip = document.querySelector('#wb-shell .ant-app > div')
  const tabs = strip && strip.children[1] && strip.children[1].children[0]
  return !!tabs && tabs.children.length >= 4
    && !!document.querySelector('#wb-tree .pm-ws-btn')
    && !!document.querySelector('#wb-editor textarea')
}, { timeout: 20000 })
await page.waitForTimeout(150)

async function wbExpectations() {
  const roles = new Set()
  for (const map of Object.values(WB_TABLE)) {
    for (const v of Object.values(map)) if (v.startsWith('--pm-')) roles.add(v)
  }
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      for (const prop of ['color', 'backgroundColor', 'borderLeftColor', 'borderBottomColor', 'boxShadow']) {
        const d = document.createElement('div')
        d.style[prop] = `var(${role})`
        document.body.appendChild(d)
        out[`${role}|${prop}`] = getComputedStyle(d)[prop]
        d.remove()
      }
    }
    return out
  }, [...roles])
  return { expectOf: (spec, prop) => (spec.startsWith('--pm-') ? normed[`${spec}|${prop}`] ?? null : spec) }
}

async function checkWB(label, expect) {
  const vec = await page.evaluate(() => window.__wbVector())
  const got = {}
  for (const [key, map] of Object.entries(WB_TABLE)) {
    const row = vec[key]
    if (!row) { check(`${label} wb ${key} 存在`, false, '没有渲染出来'); continue }
    for (const [prop, spec] of Object.entries(map)) {
      const want = expect.expectOf(spec, prop)
      got[`${key}.${prop}`] = row[prop]
      check(`${label} wb ${key}.${prop} = ${spec}`, row[prop] === want, `期望 ${want} 实得 ${row[prop]}`)
    }
  }
  return { vec, got }
}

const expWB = await wbExpectations()
const wbLight = await checkWB('浅色', expWB)
await page.evaluate(() => window.__setMode('dark'))
const expWBDark = await wbExpectations()
const wbDark = await checkWB('深色', expWBDark)

// Flip discipline: every entry in the table is role-borne, so every reading
// must move; a missing element counts against the check by name.
const wbKeys = Object.keys(WB_TABLE)
const wbMissing = []
const wbNotFlipped = wbKeys.filter((key) => {
  const l = wbLight.vec[key]
  const d = wbDark.vec[key]
  if (!l || !d) { wbMissing.push(key); return true }
  return Object.keys(WB_TABLE[key]).every((prop) => l[prop] === d[prop])
})
check('翻转：工作台外壳全部读数都随模式变化', wbNotFlipped.length === 0 && wbMissing.length === 0, [...wbNotFlipped, ...wbMissing].join(' | ') || `${wbKeys.length} 个角色的读数全部不同`)

// The cut control: dark attribute, no dark section — every reading falls back.
await page.evaluate(() => window.__setMode('dark'))
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVarsNoDark())
await page.waitForTimeout(50)
{
  const vec = await page.evaluate(() => window.__wbVector())
  const bad = []
  for (const key of wbKeys) {
    const row = vec[key]
    if (!row) { bad.push(`${key}: 缺失`); continue }
    for (const [prop, spec] of Object.entries(WB_TABLE[key])) {
      const want = expWB.expectOf(spec, prop)
      if (row[prop] !== want) bad.push(`${key}.${prop}: ${row[prop]} ≠ 浅色 ${want}`)
    }
  }
  check('删掉 dark 段：工作台外壳角色全部落回浅色值', bad.length === 0, bad.slice(0, 6).join(' | ') || `${wbKeys.length} 个角色全部回落`)
}
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVars())
await page.evaluate(() => window.__setMode('light'))
await page.waitForTimeout(50)
{
  const vec = await page.evaluate(() => window.__wbVector())
  const want = expWB.expectOf(WB_TABLE.stripGround.backgroundColor, 'backgroundColor')
  check('装回真表、回到浅色：工作台取值复原', !!vec.stripGround && vec.stripGround.backgroundColor === want, `期望 ${want} 实得 ${vec.stripGround && vec.stripGround.backgroundColor}`)
}

// ── §16 — the assistant column's chat card: the bubble must clear its ground ──
// One delta per pair, because "is the fill visible" is a comparison, not a
// value: a role-borne expectation would pass on the bug (the bubble DID paint
// --pm-sunk — it was the ground that happened to be the same colour).
//
// Two floors, because the two pairs are not the same design intent. The bubble
// is a capsule the user must SEE, and light draws it 13 mean |ΔRGB| off its card
// (card #ffffff, bubble #f0f2f4), so dark is held to 10. The tool head is a
// recessed block whose dark rest step is only 7 (--pm-fill #1f1f1f on --pm-card
// #262626) — the weakest step this sheet draws on purpose — so its floor is 6,
// and what that floor really guards is the collision class: a fill painted in its
// ground's exact colour, which is what this report was.
const BUBBLE_FLOOR = 10
const SURFACE_FLOOR = 6

/** How long this section waits before every reading that follows a fill change.
 *  Not politeness: the tool block's header carries `transition: background
 *  0.15s`, so a reading taken in the same frame as the change reports the value
 *  being animated FROM. That cost two green-then-red rounds here — the hover read
 *  the resting fill, and after the mode flip the header still reported light's
 *  --pm-fill (rgb(245, 245, 245)) for a frame. */
const ASSIST_SETTLE = 250

/** Mean |ΔRGB| between two computed colours; null if either is unreadable. */
function delta(a, b) {
  const rgb = (s) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null }
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return null
  return Math.round((Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2])) / 3)
}

await page.evaluate(() => window.__mountAssist())
await page.waitForFunction(() => {
  const b = document.querySelector('#assist-host div[style*="justify-content: flex-end"]')
  return !!b && !!b.firstElementChild && !!document.querySelector('#assist-host [data-segment-head]')
}, { timeout: 20000 })
await page.waitForTimeout(150)
// The tool block's header exists only once its execution segment is open — a
// collapsed segment renders its own header instead (the same fact §5's two-state
// read is built on), so the header's two fills are read with a real click first.
await page.locator('#assist-host [data-segment-head]').first().click()
await page.waitForFunction(() => !!document.querySelector('#assist-host [data-tool-head="as-t1"]'), { timeout: 20000 })
await page.waitForTimeout(150)

/** `--pm-*` roles normalized to computed values, so the table can say which role
 *  each surface is supposed to carry on top of what it measures. */
async function assistExpectations() {
  const roles = ['--pm-card', '--pm-sunk', '--pm-fill']
  const normed = await page.evaluate((roleList) => {
    const out = {}
    for (const role of roleList) {
      const d = document.createElement('div')
      d.style.backgroundColor = `var(${role})`
      document.body.appendChild(d)
      out[role] = getComputedStyle(d).backgroundColor
      d.remove()
    }
    return out
  }, roles)
  return normed
}

const ASSIST_TABLE = {
  ground: { backgroundColor: '--pm-card' },
  bubble: { backgroundColor: '--pm-sunk' },
  toolHead: { backgroundColor: '--pm-fill' },
}

async function assistReading(label, expect) {
  const vec = await page.evaluate(() => window.__assistVector())
  for (const [key, map] of Object.entries(ASSIST_TABLE)) {
    const row = vec[key]
    if (!row) { check(`${label} assist ${key} 存在`, false, '没有渲染出来'); continue }
    for (const [prop, spec] of Object.entries(map)) {
      check(`${label} assist ${key}.${prop} = ${spec}`, row[prop] === expect[spec], `期望 ${expect[spec]} 实得 ${row[prop]}`)
    }
  }
  // The two composite readings. Direction is asserted per mode on purpose: the
  // bubble is a recessed capsule in BOTH columns, so it is darker than its card
  // in light and lighter in dark — a fix that made dark's bubble darker than the
  // card would be a different design, not this one.
  const wantDir = label === '深色' ? 1 : -1
  check(
    `${label} assist 气泡底色与助手卡底色不同（Δ≥${BUBBLE_FLOOR}）`,
    vec.bubbleVsGround !== null && vec.bubbleVsGround >= BUBBLE_FLOOR,
    `Δ = ${vec.bubbleVsGround}（气泡 ${vec.bubble && vec.bubble.backgroundColor} on 卡 ${vec.ground && vec.ground.backgroundColor}）`
  )
  check(
    `${label} assist 气泡比卡底${wantDir === 1 ? '亮' : '暗'}`,
    vec.bubbleIsLighter === wantDir,
    `方向 ${vec.bubbleIsLighter}（期望 ${wantDir}）`
  )
  check(
    `${label} assist 工具卡头部底色与卡底不同（Δ≥${SURFACE_FLOOR}）`,
    vec.headVsGround !== null && vec.headVsGround >= SURFACE_FLOOR,
    `Δ = ${vec.headVsGround}（头部 ${vec.toolHead && vec.toolHead.backgroundColor} on 卡 ${vec.ground && vec.ground.backgroundColor}）`
  )
  // The hover fill, with a real cursor and read after the tween: the header's own
  // rest fill is one rung off the card's ground in dark (7 units), and its hover
  // rung is the one that could collapse onto it.
  await page.locator('#assist-host [data-tool-head="as-t1"]').hover()
  await page.waitForTimeout(ASSIST_SETTLE)
  const hover = await page.evaluate(() => window.__assistHead())
  const hoverDelta = await delta(hover && hover.backgroundColor, vec.ground && vec.ground.backgroundColor)
  check(
    `${label} assist 工具卡头部 hover 底色与卡底不同（Δ≥${SURFACE_FLOOR}）`,
    hover && hover.backgroundColor !== vec.toolHead.backgroundColor && hoverDelta !== null && hoverDelta >= SURFACE_FLOOR,
    `hover Δ = ${hoverDelta}（hover ${hover && hover.backgroundColor}，静止 ${vec.toolHead && vec.toolHead.backgroundColor}）`
  )
  // Hand the resting fill back before the flip: the inline style survives the
  // mode change, so a hover left on would make the next mode's rest reading a
  // reading of the hover.
  await page.mouse.move(5, 5)
  await page.waitForTimeout(ASSIST_SETTLE)
  return { vec, hover }
}

const expAssist = await assistExpectations()
const assistLight = await assistReading('浅色', expAssist)
await page.evaluate(() => window.__setMode('dark'))
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
// Every mode change in this section settles first, and not only for symmetry with
// the hover: the header animates its fill, so it is still painting the OLD mode's
// colour in the frame the attribute lands — measured, the dark run read
// rgb(245, 245, 245) (light's --pm-fill) until this wait was added, i.e. a reading
// of the flip's first frame rather than of dark.
await page.waitForTimeout(ASSIST_SETTLE)
// Re-normalized, not reused: the §15 rule — a role's computed value is a fact
// about the mode, so the dark run gets the dark column's own values.
const expAssistDark = await assistExpectations()
const assistDark = await assistReading('深色', expAssistDark)

// Flip discipline (the §15 rule): every reading here is role-borne, so every one
// of them must move across the flip — a hardcoded colour is exactly what made the
// bubble invisible in one mode only.
{
  const moved = []
  for (const key of Object.keys(ASSIST_TABLE)) {
    const l = assistLight.vec[key]
    const d = assistDark.vec[key]
    if (!l || !d) { moved.push(`${key}: 缺失`); continue }
    if (l.backgroundColor === d.backgroundColor) moved.push(`${key}.backgroundColor`)
  }
  if (assistLight.hover && assistDark.hover && assistLight.hover.backgroundColor === assistDark.hover.backgroundColor) moved.push('toolHeadHover.backgroundColor')
  check('翻转：助手列的全部读数都随模式变化', moved.length === 0, moved.join(' | ') || '5 个读数全部不同')
}

// The cut control: dark attribute, no dark section — every reading falls back to
// the light column, bubble included (the sheet is what fixes this, not a
// component-local override).
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVarsNoDark())
await page.waitForTimeout(ASSIST_SETTLE)
{
  const vec = await page.evaluate(() => window.__assistVector())
  const bad = []
  for (const key of Object.keys(ASSIST_TABLE)) {
    const row = vec[key]
    if (!row) { bad.push(`${key}: 缺失`); continue }
    for (const [prop, spec] of Object.entries(ASSIST_TABLE[key])) {
      if (row[prop] !== expAssist[spec]) bad.push(`${key}.${prop}: ${row[prop]} ≠ 浅色 ${expAssist[spec]}`)
    }
  }
  if (vec.bubbleVsGround !== null && vec.bubbleVsGround < BUBBLE_FLOOR) bad.push(`气泡 Δ = ${vec.bubbleVsGround}`)
  check('删掉 dark 段：助手列角色落回浅色值且气泡仍可辨', bad.length === 0, bad.slice(0, 6).join(' | ') || '全部回落')
}
await page.evaluate(() => window.__removeSheet('pm-theme-vars'))
await page.evaluate(() => window.__installVars())
await page.evaluate(() => window.__setMode('light'))
await page.waitForTimeout(ASSIST_SETTLE)
{
  const vec = await page.evaluate(() => window.__assistVector())
  check(
    '装回真表、回到浅色：助手列取值复原',
    !!vec.bubble && vec.bubble.backgroundColor === expAssist['--pm-sunk'],
    `期望 ${expAssist['--pm-sunk']} 实得 ${vec.bubble && vec.bubble.backgroundColor}`
  )
}

// ── §17 — the knowledge table's selection paints ──
// Two of antd's selection paints derive from colorPrimary, and the ink primary
// breaks both (KnowledgePanel owns the app's only rowSelection; the user saw
// both halves): the Table's selected row paints controlItemBgActive — #404040
// in light, a charcoal stripe under dark text — and the checkbox's tick is
// colorWhite over the near-white dark primary, a white tick on a white box.
// buildAntdTheme scopes both: Table.rowSelectedBg/rowSelectedHoverBg take the
// app's selected-row wash (--pm-hover-strong) per mode, and Checkbox takes a
// scoped colorWhite = ink in dark. The batch bar that the selection summons is
// role-borne (--pm-wash) and rides along. Exact values, no cut control: these
// paints come from the antd tokens, not the sheet — the pre-fix code fails
// every value here (rgb(64,64,64) rows, white ticks), which is the non-vacuity.
const KB_FILES = [
  { id: 'kb-t1', title: '入职手册', filePath: 'bases/default/raw/入职手册.md', sourceType: 'file', status: 'compiled', createdAt: new Date(Date.now() - 600 * 1000).toISOString(), baseId: 'default', wikiOutputs: null, sourceUrl: null, sourcePath: null, convId: null, contentHash: null, compiledAt: null },
  { id: 'kb-t2', title: '面试题库', filePath: 'bases/default/raw/面试题库.md', sourceType: 'file', status: 'raw', createdAt: new Date(Date.now() - 1200 * 1000).toISOString(), baseId: 'default', wikiOutputs: null, sourceUrl: null, sourcePath: null, convId: null, contentHash: null, compiledAt: null },
]
/** Normalize a --pm-* role to the computed colour it holds in the live mode. */
const kbNormVar = (role) => page.evaluate((r) => {
  const d = document.createElement('div')
  d.style.backgroundColor = `var(${r})`
  document.body.appendChild(d)
  const v = getComputedStyle(d).backgroundColor
  d.remove()
  return v
}, role)

await page.evaluate((files) => { window.__pmKnowledgeFiles = files; window.__mountKnowledge() }, KB_FILES)
await page.waitForFunction(() => {
  const host = document.getElementById('knowledge-host')
  return !!host && host.querySelectorAll('.ant-table-tbody tr').length >= 2
}, { timeout: 20000 })
// A real click, then off the table: the selection must exist in the component's
// state before any of the paints below exist to read.
await page.click('#knowledge-host .ant-table-tbody .ant-checkbox-input')
await page.mouse.move(2, 2)
// The checked box tweens its background (antd's motion pair, ~0.3s with the
// ease-out-back delay) — a fixed 200ms read landed mid-flight at rgb(13-19),
// so wait for the settled ink instead of guessing the tween's length.
await page.waitForFunction(() => {
  const box = document.querySelector('#knowledge-host .ant-table-tbody .ant-checkbox-checked')
  return !!box && getComputedStyle(box).backgroundColor === 'rgb(0, 0, 0)'
}, null, { timeout: 3000 }).catch(() => {})

const KB_TICK_SETTLE = 350
{
  const washLight = await kbNormVar('--pm-wash')
  const kb = await page.evaluate(() => window.__knowledgeVector())
  check('浅色 知识表格：真点击后行进入选中态', kb.rowSelected === true)
  check('浅色 知识表格：选中行底色 = --pm-hover-strong 洗色（修复前是派生的 #404040 炭条）', kb.selRowBg === 'rgba(0, 0, 0, 0.08)', `实得 ${kb.selRowBg}`)
  check('浅色 知识表格：勾选框盒底 = 墨色', kb.boxBg === 'rgb(0, 0, 0)', `实得 ${kb.boxBg}`)
  check('浅色 知识表格：对勾两条可见边都是白色（墨盒白勾）', kb.tick === 'rgb(255, 255, 255)' && kb.tickBottom === 'rgb(255, 255, 255)', `实得 ${kb.tick} / ${kb.tickBottom}`)
  check('浅色 知识表格：批量条出现且地面 = --pm-wash', kb.batchBarBg === washLight, `实得 ${kb.batchBarBg} 期望 ${washLight}`)
  // Hover a non-checkbox cell of the selected row: the hover-on-selected paint
  // is the second token (rowSelectedHoverBg), one step past the rest wash.
  await page.hover('#knowledge-host .ant-table-tbody tr.ant-table-row-selected td:last-child')
  await page.waitForTimeout(KB_TICK_SETTLE)
  const kbHover = await page.evaluate(() => window.__knowledgeVector())
  check('浅色 知识表格：选中行悬停底色 = 亮一档洗色（修复前是更深的 #333）', kbHover.hoverTdBg === 'rgba(0, 0, 0, 0.12)', `实得 ${kbHover.hoverTdBg}`)
}

await page.evaluate(() => window.__setMode('dark'))
// Off the row first: the light hover step parked the cursor on the last cell,
// and every td of the row carries the hover class — the resting read below
// would report the hover-on-selected paint instead of the rest wash (measured:
// rgba(255,255,255,0.16) — exactly the hover value — for the rest check).
await page.mouse.move(2, 2)
await page.waitForTimeout(KB_TICK_SETTLE)
{
  const washDark = await kbNormVar('--pm-wash')
  const kb = await page.evaluate(() => window.__knowledgeVector())
  check('深色 知识表格：选中行底色 = 深色洗色（修复前是派生的 #535353）', kb.selRowBg === 'rgba(255, 255, 255, 0.12)', `实得 ${kb.selRowBg}`)
  check('深色 知识表格：对勾翻成墨色（修复前是 colorWhite 白勾没入近白盒）', kb.tick === 'rgb(0, 0, 0)' && kb.tickBottom === 'rgb(0, 0, 0)', `实得 ${kb.tick} / ${kb.tickBottom}`)
  check('深色 知识表格：对勾与盒底可辨', kb.tick !== kb.boxBg && kb.boxBg !== 'rgba(0, 0, 0, 0)', `tick=${kb.tick} box=${kb.boxBg}`)
  check('深色 知识表格：批量条地面 = 深色 --pm-wash', kb.batchBarBg === washDark, `实得 ${kb.batchBarBg} 期望 ${washDark}`)
  // And back onto the row for the dark hover-on-selected paint.
  await page.hover('#knowledge-host .ant-table-tbody tr.ant-table-row-selected td:last-child')
  await page.waitForTimeout(KB_TICK_SETTLE)
  const kbHover = await page.evaluate(() => window.__knowledgeVector())
  check('深色 知识表格：选中行悬停底色 = 深色亮一档', kbHover.hoverTdBg === 'rgba(255, 255, 255, 0.16)', `实得 ${kbHover.hoverTdBg}`)
  check(
    '翻转：知识表格的选中面读数全部随模式变化',
    kb.selRowBg !== 'rgba(0, 0, 0, 0.08)' && kb.tick !== 'rgb(255, 255, 255)' && kb.batchBarBg !== 'rgb(250, 250, 250)',
    `row=${kb.selRowBg} tick=${kb.tick} bar=${kb.batchBarBg}`
  )
}
await page.evaluate(() => window.__setMode('light'))

// ── §17b — the Radio dot rides the same scoped flip as the Checkbox tick ──
// (review0924 M8: the dark primary is the near-white #e6e6e6 and the checked
// dot painted colorWhite — invisible on its own disc. The token is scoped to
// the radio sheet, so light's white-on-ink dot stays untouched.)
await page.evaluate(() => window.__mountRadio())
await page.waitForSelector('#radio-host .ant-radio-checked', { timeout: 10000 })
{
  const lightRadio = await page.evaluate(() => window.__radioVector())
  check('浅色 Radio：选中点白色画在墨色盘上（翻墨前的正确形状）', lightRadio.discBg === 'rgb(0, 0, 0)' && lightRadio.dotBg === 'rgb(255, 255, 255)', `disc=${lightRadio.discBg} dot=${lightRadio.dotBg}`)
  await page.evaluate(() => window.__setMode('dark'))
  // The mode flip tweens the antd token repaint (a fixed 300ms read landed
  // mid-flight at disc rgb(199,199,199) / dot rgb(6,6,6)) — wait for the
  // settled ink dot instead of guessing the tween's length, §17's recipe.
  await page.waitForFunction(() => {
    const disc = document.querySelector('#radio-host .ant-radio-checked')
    return !!disc && getComputedStyle(disc, '::after').backgroundColor === 'rgb(0, 0, 0)'
  }, null, { timeout: 5000 }).catch(() => {})
  // The disc's own tween lands behind the dot's; give it the same beat.
  await page.waitForTimeout(300)
  const darkRadio = await page.evaluate(() => window.__radioVector())
  // rgb(199,199,199) is the app's settled dark checked-disc (antd derives it
  // from the near-white primary — §17's checkbox box reads the same value);
  // the pre-fix dot was colorWhite white-on-199 — the flip is the fix.
  check('深色 Radio：选中盘 = 深色选中底，选中点翻成墨色（修复前 colorWhite 没入选中盘）', darkRadio.discBg === 'rgb(199, 199, 199)' && darkRadio.dotBg === 'rgb(0, 0, 0)', `disc=${darkRadio.discBg} dot=${darkRadio.dotBg}`)
  check('深色 Radio：点与盘可辨', darkRadio.dotBg !== darkRadio.discBg && darkRadio.dotBg !== 'rgb(255, 255, 255)', `dot=${darkRadio.dotBg}`)
  await page.evaluate(() => window.__setMode('light'))
}

/** Flat compare of two vectors; `keys` limits it to a subset of properties. */
function diffVector(a, b, keys) {
  const out = []
  for (const role of Object.keys(a)) {
    if (!b[role]) { out.push(`${role}: 缺失`); continue }
    for (const prop of keys ?? Object.keys(a[role])) {
      const av = a[role][prop]
      const bv = b[role][prop]
      if (av !== bv) out.push(`${role}.${prop}: ${av} → ${bv}`)
    }
  }
  return out
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:', failed.map((r) => r.name).join(' | '))
  process.exit(1)
}
