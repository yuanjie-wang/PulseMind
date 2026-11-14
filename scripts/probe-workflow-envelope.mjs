/**
 * Workflow envelope probe (real Chromium) — PLAN-workflow-context 的三个探针断言：
 *
 *   ① 预览面板渲染出的就是实际注入的那份：面板 <pre> 的文本与同 ctx 调
 *      composeStagePrompt（真模块，esbuild 打进 harness）的输出逐字符相等——
 *      「预览与实际运行出自同一份代码」在 UI 层的可观测面。
 *   ② 「本阶段任务」「完成方式」两段在任何预算下都在：夹具把
 *      params.envelopeCapChars 压到 60，前四个信封块全被裁掉、marker 行在场，
 *      任务与完成方式照常在。
 *   ③ 顶部那段分工声明存在（你在工作流里的位置 + 不要代做）——承重墙。
 *
 * 顺带钉：上下文折叠区默认收起、三开关默认全开（context 字段缺席 = 全开）、
 * 开关 e2e（关掉全局目标块 → 预览即时失去该块）、入口节点无上游块、上游块
 * 只给路径不注入上游 summary 正文。
 *
 * What it mounts is the production TaskWizardPage behind a stubbed
 * window.electronAPI — never a copy of the component. No Electron, no LLM.
 *
 * Usage: node scripts/probe-workflow-envelope.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-workflow-envelope-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-workflow-envelope-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import TaskWizardPage from './src/renderer/src/components/routine/TaskWizardPage'
import { composeStagePrompt } from './src/shared/workflow/envelope'
import { resolveWorkflowHandoff } from './src/shared/workflow/handoff'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

// 预览与面板共用同一份合成规则（WorkflowCanvas.previewPrompt 的镜像）：真实
// 连线合成示例上游、输入取声明 default。这里若漂移，① 的等值断言会红。
window.__composePreview = (workflowId, nodeId) => {
  const def = WORKFLOWS.find((w) => w.id === workflowId)
  if (!def) return null
  const node = def.nodes.find((n) => n.id === nodeId)
  if (!node) return null
  const handoff = resolveWorkflowHandoff('（工作区）', 'run_preview')
  const idx = Math.max(0, def.nodes.findIndex((n) => n.id === nodeId))
  const upstreams = []
  const seenSrc = {}
  for (const e of def.edges) {
    if (e.to !== nodeId || seenSrc[e.from]) continue
    const src = def.nodes.find((n) => n.id === e.from)
    if (!src) continue
    seenSrc[e.from] = true
    upstreams.push({ title: src.title || e.from, verdict: e.when, verdictDef: src.verdictDefs ? src.verdictDefs[e.when] : undefined, handoffRel: handoff.relative(e.from) })
  }
  const vars = {
    workflowObjective: def.objective,
    visit: 1,
    workspace: '（工作区）',
    vars: Object.fromEntries((def.inputs || []).map((i) => [i.key, i.default || ''])),
  }
  return composeStagePrompt(node, vars, {
    workflowName: def.name || '（未命名工作流）',
    stageIndex: idx + 1,
    stageTotal: def.nodes.length,
    inputs: def.inputs,
    upstreams: upstreams.length > 0 ? upstreams : undefined,
    handoff,
    envelopeCapChars: def.params ? def.params.envelopeCapChars : undefined,
  })
}

// ── fixtures ──
// wf_demo：常规信封（目标 / 输入 / 上游交接都在）；wf_tiny：预算压到 60，
// 前四个信封块全裁、marker 在场——② 的载体。
const WORKFLOWS = [
  {
    id: 'wf_demo',
    name: '需求交付流程',
    description: '读需求 → 出方案 → 改代码',
    objective: '把需求做成可交付的改动',
    inputs: [{ key: 'docPath', label: '需求文档', required: true, default: '' }],
    entry: 'plan',
    params: {},
    nodes: [
      { id: 'plan', title: '出方案', prompt: '根据 {{docPath}} 出技术方案', verdicts: ['done'], layout: { x: 0, y: 0 } },
      { id: 'code', title: '改代码', prompt: '按方案改代码', verdicts: ['done'], layout: { x: 300, y: 0 } },
    ],
    edges: [{ from: 'plan', when: 'done', to: 'code' }, { from: 'code', when: 'done', to: 'DONE' }],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: 'wf_tiny',
    name: '竞品监控流水线',
    description: '预算裁剪的载体',
    objective: '每周汇总三家竞品的官网价格',
    entry: 'fetch',
    params: { envelopeCapChars: 60 },
    nodes: [
      { id: 'fetch', title: '列出竞品清单', prompt: '抓取清单写入 list.md。', verdicts: ['pass'], layout: { x: 0, y: 0 } },
      { id: 'prices', title: '抓取竞品价格', prompt: '抓取三家价格页写入 prices.csv。', verdicts: ['pass'], layout: { x: 300, y: 0 } },
    ],
    edges: [{ from: 'fetch', when: 'pass', to: 'prices' }, { from: 'prices', when: 'pass', to: 'DONE' }],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  },
]

const EMPTY_LISTS = ['expertList', 'projectList', 'listConversations', 'knowledgeListFiles',
  'knowledgeListBases', 'toolList', 'skillList', 'recallMemories']

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'pipelineWorkflows') {
      const [op, id] = args
      if (op === 'get') return Promise.resolve(WORKFLOWS.find((w) => w.id === id) ?? null)
      if (op === 'list') return Promise.resolve(WORKFLOWS)
      if (op === 'save') return Promise.resolve()
      return Promise.resolve(undefined)
    }
    if (EMPTY_LISTS.includes(String(key))) return Promise.resolve([])
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: window.__locale ?? 'zh' })
    }
    if (key === 'agentSessionSnapshot') return Promise.resolve(null)
    if (key === 'agentSessionCreate') return Promise.resolve({ sessionId: '', agentId: '' })
    if (key === 'hydrateConversation') return Promise.resolve({ messages: [] })
    return Promise.resolve(undefined)
  },
})

let root = null
window.__mount = ({ workflowId = 'wf_demo', locale = 'zh' } = {}) => {
  window.__locale = locale
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <TaskWizardPage kind="workflow" workflowId={workflowId} routineId={null} />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}
window.__ready = true
`

const forceWorkflowUi = {
  name: 'force-workflow-ui',
  setup(b) {
    b.onResolve({ filter: /(^|\/)shared\/feature-flags$/ }, () => ({ path: 'pm-flags', namespace: 'pm-flags' }))
    b.onLoad({ filter: /.*/, namespace: 'pm-flags' }, () => ({ contents: 'export const WORKFLOW_TASKS_UI = true', loader: 'ts' }))
  },
}

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
  plugins: [forceWorkflowUi],
})

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

mkdirSync(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (err) => console.log('  [page error]', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300))
})
const PAGE_HTML = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
await page.goto('http://pm-probe.local/')
await page.addStyleTag({ path: join(process.cwd(), 'node_modules/@xyflow/react/dist/style.css') })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const mountWorkflow = async (workflowId) => {
  await page.evaluate((id) => window.__mount({ workflowId: id }), workflowId)
  await page.waitForSelector('[data-pm-form-assist]')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '需求交付流程' || i.value === '竞品监控流水线'))
  // 画布住在「任务内容」步——向导的默认步不是它，先切过去。
  await page.locator('.ant-segmented-item', { hasText: '任务内容' }).first().click()
  await page.waitForSelector('[data-workflow-canvas]')
}
const openNodePanel = async (nodeId) => {
  const card = `.react-flow__node[data-id="node:${nodeId}"]`
  await page.locator(card).hover()
  await page.locator(`${card} [data-workflow-node-edit]`).click()
  await page.waitForSelector('.ant-modal [data-workflow-node-panel] [data-workflow-field="prompt"] textarea')
}
const closeNodePanel = async () => {
  if ((await page.locator('[data-workflow-node-panel]').count()) === 0) return
  await page.locator('.ant-modal-footer button').last().click()
  await page.waitForFunction(() => document.querySelector('[data-workflow-node-panel]') === null)
  await page.waitForTimeout(250)
}
const expandCtx = async () => {
  await page.locator('[data-workflow-context-section] .ant-collapse-header').click()
  await page.waitForSelector('[data-workflow-context-section] [data-workflow-var-insert]')
}
const previewText = async () => page.evaluate(() => document.querySelector('[data-workflow-preview]')?.textContent ?? null)
const openPreview = async () => {
  await page.locator('[data-workflow-preview-toggle]').click()
  await page.waitForSelector('[data-workflow-preview]')
}

// ══════════════════════════════════════════════════════════════════════════
// §1 · 折叠区形态：默认收起、三开关默认全开（context 缺席 = 全开）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§1 · 上下文折叠区：默认收起 + 三开关全开')
await mountWorkflow('wf_demo')
await page.waitForSelector('.react-flow__node[data-id="node:code"]')
await openNodePanel('code')
check('折叠区在面板里', (await page.locator('.ant-modal [data-workflow-context-section]').count()) === 1)
check('默认收起（插变量等控制项未挂载）', (await page.locator('[data-workflow-context-section] [data-workflow-var-insert]').count()) === 0)
await expandCtx()
const toggles = await page.evaluate(() =>
  ['objective', 'upstream', 'inputs'].map((k) => ({
    k,
    on: document.querySelector(`[data-workflow-context-toggle="${k}"] .ant-switch`)?.getAttribute('aria-checked') === 'true',
  })),
)
check('三个开关都在且默认开（信封全开）', toggles.length === 3 && toggles.every((t) => t.on), JSON.stringify(toggles))
check('输入框标题 = 本阶段任务（PLAN-workflow-context 改题）', (await page.locator('[data-workflow-field="prompt"] > span').first().innerText()) === '本阶段任务')

// ══════════════════════════════════════════════════════════════════════════
// §2 · 预览 = 真模块输出（断言①）+ 结构（断言③）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§2 · 预览完整提示词：与 composeStagePrompt 逐字符相等')
await openPreview()
const domText = await previewText()
const moduleText = await page.evaluate(() => window.__composePreview('wf_demo', 'code'))
check('预览文本 === 同 ctx 的 composeStagePrompt 输出（断言①）', domText !== null && domText === moduleText, `dom=${domText?.length} module=${moduleText?.length}`)
check('分工声明在（断言③：位置 + 不要代做）', (domText ?? '').includes('── 你在这个工作流里的位置 ──') && (domText ?? '').includes('不要代做'))
check('阶段序号与标题在', (domText ?? '').includes('第 2/2 阶段「改代码」'))
check('全局目标块在（运行级/工作流级目标）', (domText ?? '').includes('── 全局目标 ──\n把需求做成可交付的改动'))
check('输入块在：未填标「（未填）」', (domText ?? '').includes('需求文档：（未填）'))
check('本阶段任务段在（承重墙标题）', (domText ?? '').includes('── 本阶段任务（你只负责这一部分） ──\n按方案改代码'))
check('完成方式段在', (domText ?? '').includes('── 完成方式 ──'))
check('交接契约在：绝对路径 + 骨架 + 顺序承诺', (domText ?? '').includes('（工作区）/.pulsemind/workflows/run_preview/code-handoff.md') && (domText ?? '').includes('# 改代码 交接') && (domText ?? '').includes('finish_stage` 之前'))
check('上游块只给路径 + verdict（不注入上游 summary/正文）', (domText ?? '').includes('── 上游交接 · 来自「出方案」 ──') && (domText ?? '').includes('verdict：done') && (domText ?? '').includes('plan-handoff.md'))
await page.screenshot({ path: join(SHOTS, 'envelope-preview.png') })

// 入口节点：上游块整体不渲染
await closeNodePanel()
await openNodePanel('plan')
await expandCtx()
await openPreview()
const entryText = await previewText()
check('入口节点没有上游块（而不是「（无）」）', entryText !== null && !entryText.includes('── 上游交接') && !entryText.includes('（无）'))
check('入口节点阶段序号 = 1/2「出方案」', (entryText ?? '').includes('第 1/2 阶段「出方案」'))

// ══════════════════════════════════════════════════════════════════════════
// §3 · 预算：cap=60 时前四块全裁、marker 在场、任务与完成方式照常在（断言②）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§3 · 预算裁剪：本阶段任务与完成方式永不裁剪（断言②）')
await closeNodePanel()
await mountWorkflow('wf_tiny')
await page.waitForSelector('.react-flow__node[data-id="node:prices"]')
await openNodePanel('prices')
await expandCtx()
await openPreview()
const tinyText = await previewText()
check('上游块被裁 + marker 点名目录', (tinyText ?? '').includes('[上游交接超出预算：已省略 1 个交接文件路径，见 .pulsemind/workflows/run_preview]'))
check('全局目标被裁 + marker', (tinyText ?? '').includes('[全局目标超出信封预算'))
check('「本阶段任务」在（断言②a）', (tinyText ?? '').includes('── 本阶段任务（你只负责这一部分） ──\n抓取三家价格页写入 prices.csv。'))
check('「完成方式」在（断言②b）', (tinyText ?? '').includes('── 完成方式 ──'))
check('交接契约不裁（完成方式的一部分）', (tinyText ?? '').includes('prices-handoff.md'))
await page.screenshot({ path: join(SHOTS, 'envelope-budget.png') })

// ══════════════════════════════════════════════════════════════════════════
// §4 · 开关 e2e：关掉全局目标块 → 预览即时失去该块；开回来 → 恢复
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§4 · context 开关 e2e')
await closeNodePanel()
await mountWorkflow('wf_demo')
await page.waitForSelector('.react-flow__node[data-id="node:code"]')
await openNodePanel('code')
await expandCtx()
await openPreview()
await page.locator('[data-workflow-context-toggle="objective"] .ant-switch').click()
await page.waitForTimeout(200)
const offText = await previewText()
check('关掉全局目标块：预览即时失去该块', offText !== null && !offText.includes('── 全局目标 ──'))
await page.locator('[data-workflow-context-toggle="objective"] .ant-switch').click()
await page.waitForTimeout(200)
check('开回来：全局目标块恢复', (await previewText())?.includes('── 全局目标 ──'))
await closeNodePanel()
await page.screenshot({ path: join(SHOTS, 'envelope-after-toggle.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exitCode = 1
}
console.log(`screenshots: ${SHOTS}`)
