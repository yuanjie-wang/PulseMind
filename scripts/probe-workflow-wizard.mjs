/**
 * Workflow wizard probe (real Chromium) — the two halves of the 2026-11-08
 * ruling that the routine wizard alone cannot prove:
 *
 *   (2) 「任务助手的UI要从编辑面板中独立出来，因为它是可以贯穿整个编辑和配置
 *       流程的」 — the assistant column must be a PAGE-LEVEL PEER of the step
 *       card, and it must stay mounted (same DOM node) through all four steps.
 *       Source cannot settle either claim: the same <FormAssistColumn> reads
 *       identically whether it sits inside EDITOR_SURFACE or beside it, and a
 *       remount per step looks the same on screen until you lose the thread.
 *       So this probe measures geometry + node identity, not source.
 *
 *   (3) 「两种模式的在【触发与批量】面板中能力不一致，以任务式对话为准」 —
 *       the workflow arm must render the same three sections as the routine
 *       arm (ScheduleSection / BatchSection / TriggersSection, same anchors,
 *       same labels), differing ONLY in the concurrency row: a workflow runs
 *       its instances serially (gitCheckpoint commits the workspace per stage),
 *       so that row is visible-but-locked with a truthful caption — the same
 *       「显示但禁用」 posture as the no-API-key browser URL panel.
 *
 *   (3 bis) §5 pins the 2026-11-09 canvas ruling geometrically: the left toolbox
 *       column is gone (the flow pane starts and ends at its container's edges),
 *       and 添加/整理 live in an absolutely-positioned vertical icon dock hugging
 *       the canvas's left edge, vertically centred, WITH CLICKS (a z-index below
 *       react-flow's pane would look right in source and lose every click).
 *       The old add button inside the zoom <Controls> must be gone, and the
 *       workflow-level 「全局目标（可空）」 field above the canvas is gone too
 *       (label scan + input scan — a removed label with a surviving input
 *       would still steal focus and write `def.objective`).
 *
 *   (3 ter) §6 pins the 2026-11-09 「结束图标连线连不上」 fix with a real mouse
 *       drag: 结束's target Handle had isConnectable={false}, which reads like
 *       belt-and-braces next to type="target" but is what killed the only drop
 *       target — React Flow silently discards the connection. A source scan
 *       cannot tell a working drop target from a dead one, so the probe drags
 *       a stage's outflow handle onto the DONE chip and requires the new edge
 *       to appear while the replaced (single-exit) edge disappears.
 *
 *   (4) §9 pins the 2026-11-09 助手栏 rulings: the shell wraps the assistant column
 *       and can collapse rightwards, and (same day, later) 「不要浅灰色背景，
 *       就像沉浸模式那样的无底色圆角矩形包裹」 — so both wizard columns now
 *       carry the immersive recipe (page bg, 1px separator-faint, 8px radius)
 *       instead of the gray --pm-fill surface. The load-bearing parts are the
 *       ones a source scan can only claim: 「收起不是拆装」 (the card node stays
 *       mounted at display:none with the drafted-but-unsent text intact) and the
 *       draggable divider (real mouse: travel widens the column it visually
 *       should widen, and the clamp stops it at the assistant's floor).
 *
 * (5) §8/§11 pin the 2026-11-09 连线交互三裁定: clicking a connector must NOT
 *       open the property modal (it only selects — React Flow's EdgeWrapper
 *       calls addSelectedEdges before the user's onClick, so the highlight
 *       needs no state of ours), a selected edge is blue (--pm-link bound to
 *       --xy-edge-stroke-selected on the canvas root, arrowhead follows via
 *       context-stroke), and Delete removes the selected edge or node. The
 *       key path is destructive, so §11 mounts a fresh fixture at the very end
 *       and presses a real Delete — once on an edge, once on a card, once with
 *       the modal open (must NOT delete).
 *
 * The webhook URL is deliberately NOT asserted: it sits behind
 * ROUTINE_WEBHOOK_UI (src/renderer/src/feature-flags.ts = false), so its
 * absence is a flag fact, not a workflow fact — the route itself is pinned
 * main-side by tests/routine-triggers.test.ts.
 *
 * What it mounts is the production TaskWizardPage behind a stubbed
 * window.electronAPI — never a copy of the component. No Electron, no LLM.
 *
 * Usage: node scripts/probe-workflow-wizard.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-workflow-wizard-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-workflow-wizard-shots')

// route.ts 的 ARROW_GAP：画出来的 d 比 points 短这么多，好让回流箭头的尖**恰好
// 贴住**端口圆点的边缘（user 2026-11-09 先「连接端点会把连接线的箭头端点遮住」、
// 再「端点和箭头之间有间隙，期望恰好接住」）。它的值 = 圆点外半径 = 6，而圆点
// 外径 12px 是 WorkflowCanvas 里 .wf-handle-* 的契约（border-box）。探针不能
// import 那份源码（它跑的是渲染结果），所以这里按同一数值判「尖贴住边缘」。
const ARROW_GAP = 6

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import TaskWizardPage from './src/renderer/src/components/routine/TaskWizardPage'
// The wizard is on the theme sheet: without the variable table a var() border
// resolves to nothing and any geometry drawn from it is the UA's.
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

// ── fixtures ──
// A stored workflow that exercises every 触发与批量 section at once: a cron
// (must round-trip INTO the friendly scheduler — the workflow used to have a
// bare cron text input), a batch file (the concurrency row only renders once a
// batch exists), and a file trigger.
const CSV = '/tmp/pm-probe-wf/batch.csv'

// The 绕行 fixture (§14). Hand-placed coordinates — every node carries a layout
// field, so autoWorkflowLayout is a no-op and these survive. Derived by
// brute-forcing the real router over card heights 90..160: the c→d PRIMARY
// entry is in-left, and that approach runs straight through the a→b vertical
// drop (1 crossing); the escalated in-right approach swings under and around
// d's right edge for 0 crossings at ~+390px. If the flip ever stops happening
// this fixture goes back to a single crossing — that is exactly what §14 checks.
const ALTERNATE = {
  id: 'wf_alt',
  name: '绕行验证流程',
  description: '一条线被另一条挡住，只能从右侧绕行',
  entry: 'a',
  nodes: [
    { id: 'a', title: '取数', prompt: '取数', verdicts: ['done'], layout: { x: 80, y: 80 } },
    { id: 'b', title: '落地', prompt: '落地', verdicts: ['done'], layout: { x: 420, y: 440 } },
    { id: 'c', title: '汇总', prompt: '汇总', verdicts: ['done'], layout: { x: 80, y: 400 } },
    { id: 'd', title: '出报告', prompt: '出报告', verdicts: ['done'], layout: { x: 720, y: 360 } },
  ],
  edges: [
    { from: 'a', when: 'done', to: 'b' },
    { from: 'c', when: 'done', to: 'd' },
    { from: 'b', when: 'done', to: 'DONE' },
    { from: 'd', when: 'done', to: 'DONE' },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
}

const WORKFLOWS = [{
  id: 'wf_demo',
  name: '需求交付流程',
  description: '读需求 → 出方案 → 改代码',
  objective: '把需求做成可交付的改动',
  inputs: [{ key: 'docPath', label: '需求文档', required: true, default: '' }],
  entry: 'plan',
  nodes: [
    { id: 'plan', title: '出方案', prompt: '根据 {{docPath}} 出技术方案', verdicts: ['done'], layout: { x: 0, y: 0 } },
    { id: 'code', title: '改代码', prompt: '按方案改代码', verdicts: ['done'], layout: { x: 260, y: 0 } },
  ],
  edges: [{ from: 'plan', when: 'done', to: 'code' }, { from: 'code', when: 'done', to: 'DONE' }],
  schedule: { cron: '0 9 * * *', catchUp: 'skip' },
  batch: { csvPath: CSV, timeoutMinutes: 15 },
  triggers: [{ type: 'file', paths: ['/tmp/pm-probe-wf/watch'] }],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
}, ALTERNATE]

// The routine arm's fixture is the CONTROL: same three sections must appear,
// same anchors, same labels — only the concurrency row differs (unlocked, and
// at the default 3 rather than the locked 1).
const ROUTINES = [{
  id: 'r_demo',
  name: '每日巡检',
  description: '每天跑一次',
  prompt: '做巡检',
  enabled: true,
  schedule: { cron: '0 9 * * *' },
  params: [],
  batch: { csvPath: CSV, timeoutMinutes: 15 },
  triggers: [{ type: 'file', paths: ['/tmp/pm-probe-wf/watch'] }],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
}]

const EMPTY_LISTS = ['expertList', 'projectList', 'listConversations', 'knowledgeListFiles',
  'knowledgeListBases', 'toolList', 'skillList', 'recallMemories']
const CSV_PREVIEW = { ok: true, preview: { headers: ['name', 'date'], previewRows: [['a', '2026-11-08']], totalRows: 2 } }

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    // Subscribe-style APIs answer with a cleanup function, not a Promise.
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'pipelineWorkflows') {
      const [op, id] = args
      if (op === 'get') return Promise.resolve(WORKFLOWS.find((w) => w.id === id) ?? null)
      if (op === 'list') return Promise.resolve(WORKFLOWS)
      if (op === 'save') return Promise.resolve()
      return Promise.resolve(undefined)
    }
    if (key === 'routineGet') return Promise.resolve(ROUTINES.find((r) => r.id === args[0]) ?? null)
    if (key === 'routineList') return Promise.resolve(ROUTINES)
    if (key === 'routineRuns') return Promise.resolve([])
    if (key === 'routineCsvPreview') return Promise.resolve(CSV_PREVIEW)
    if (key === 'routineTriggersInfo') return Promise.resolve({ port: 0 })
    if (EMPTY_LISTS.includes(String(key))) return Promise.resolve([])
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: window.__locale ?? 'zh' })
    }
    // The assistant column mounts useFormAssistSession → useHostedAgentSession.
    // A snapshot of null is the cold state; nothing here needs a live engine.
    if (key === 'agentSessionSnapshot') return Promise.resolve(null)
    if (key === 'agentSessionCreate') return Promise.resolve({ sessionId: '', agentId: '' })
    if (key === 'hydrateConversation') return Promise.resolve({ messages: [] })
    return Promise.resolve(undefined)
  },
})

let root = null
/** kind picks the wing; the workflow wing loads its definition through the
 *  real prefill effect (pipelineWorkflows 'get'), the routine wing through
 *  routineGet. */
window.__mount = ({ kind = 'workflow', workflowId = 'wf_demo', routineId = null, locale = 'zh' } = {}) => {
  window.__locale = locale
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale={locale}>
            <div id="view" style={{ height: '100vh' }}>
              <TaskWizardPage kind={kind} workflowId={workflowId} routineId={routineId} />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}

/** Geometry + node identity of the two cards. The whole point of §1 lives
 *  here: a descendant, a sibling, a peer are three different DOM facts that
 *  read the same in source. */
window.__cards = () => {
  const editor = document.querySelector('[data-pm-wizard-editor]')
  const assist = document.querySelector('[data-pm-form-assist]')
  const out = {
    editor: !!editor,
    assist: !!assist,
    // The decisive anti-nesting measurement: a descendant would answer non-null.
    nestedInEditor: editor ? !!editor.querySelector('[data-pm-form-assist]') : null,
    sameParent: !!(editor && assist && editor.parentElement === assist.parentElement),
    parentDisplay: assist ? getComputedStyle(assist.parentElement).display : null,
    parentDirection: assist ? getComputedStyle(assist.parentElement).flexDirection : null,
    title: assist ? (assist.querySelector('span')?.textContent ?? '').trim() : null,
    stamped: assist ? assist.__probeStamp === 1 : null,
  }
  if (editor && assist) {
    const e = editor.getBoundingClientRect()
    const a = assist.getBoundingClientRect()
    out.editorBox = { left: e.left, right: e.right, top: e.top, bottom: e.bottom, width: e.width, height: e.height }
    out.assistBox = { left: a.left, right: a.right, top: a.top, bottom: a.bottom, width: a.width, height: a.height }
    // Positive gap = the assistant starts strictly right of the step card.
    out.hGap = a.left - e.right
    out.vGap = a.top - e.top
    out.visible = a.width > 0 && a.height > 0 && getComputedStyle(assist).visibility !== 'hidden'
  }
  return out
}

/** 基本信息步的「任务类型」行（§12）：标签常驻，控件**永远是同一个单选组**——
 *  编辑态靠 disabled 只读（user 2026-11-09「期望就是用单选框」），所以读数里
 *  必须有 disabled 一列；只读 chip 那一版已被推翻，别再加回 chip 专属字段。 */
window.__kindRow = () => {
  const labels = [...document.querySelectorAll('#view div')].filter(
    (d) => d.children.length === 0 && (d.textContent || '').trim() === '任务类型',
  )
  const block = document.querySelector('[data-pm-task-kind]')
  const inputs = [...document.querySelectorAll('.ant-radio-group input[type=radio]')]
  const wrappers = [...document.querySelectorAll('.ant-radio-group .ant-radio-wrapper')]
  const checkedIdx = inputs.findIndex((i) => i.checked)
  return {
    labelCount: labels.length,
    labelShown: labels.length === 1 && labels[0].getBoundingClientRect().height > 0,
    anchor: !!block,
    groups: document.querySelectorAll('.ant-radio-group').length,
    radios: inputs.length,
    disabled: inputs.map((i) => i.disabled),
    checked: inputs.map((i) => i.checked),
    checkedLabel: checkedIdx >= 0 ? (wrappers[checkedIdx]?.textContent || '').trim() : null,
    radioLabels: wrappers.map((w) => (w.textContent || '').trim()),
    text: block ? (block.textContent || '').trim() : null,
  }
}

/** Stamp the assistant card so a later read can prove the SAME node survived a
 *  step switch (a remount would drop the expando). */
window.__stamp = () => {
  const assist = document.querySelector('[data-pm-form-assist]')
  if (!assist) return false
  assist.__probeStamp = 1
  return true
}

/** 助手栏卡片壳 + 收起态 + 分隔条的一次读数。收起是布局变化而不是拆装，所以
 *  这里同时读「壳」的几何与「卡」的存续（display + 探针 expando），两者缺一
 *  都证明不了那件事。卡片配方是**视觉**事实（无底色 / 1px 描边 / 8 圆角），
 *  分隔条是可拖动的**兄弟**节点——它在不在、骑在哪，只有几何说得清。 */
window.__assistShell = () => {
  const shell = document.querySelector('[data-pm-form-assist]')
  const editor = document.querySelector('[data-pm-wizard-editor]')
  const card = document.querySelector('[data-form-assist-card]')
  const rail = document.querySelector('[data-form-assist-rail]')
  if (!shell || !editor) return { present: false }
  const cs = getComputedStyle(shell)
  const ecs = getComputedStyle(editor)
  const s = shell.getBoundingClientRect()
  const e = editor.getBoundingClientRect()
  const h = document.querySelector('[data-pm-wizard-drag-handle]')
  const hb = h ? h.getBoundingClientRect() : null
  const out = {
    present: true,
    collapsed: shell.getAttribute('data-form-assist-collapsed'),
    shellBg: cs.backgroundColor,
    shellRadius: cs.borderRadius,
    // NB: string concat, not a nested template — this whole block is a template
    // literal the probe interpolates into the harness, so a dollar-brace here
    // would be eaten by Node.
    shellBorder: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    shellBox: { left: s.left, right: s.right, top: s.top, bottom: s.bottom, width: s.width, height: s.height },
    editorBg: ecs.backgroundColor,
    editorRadius: ecs.borderRadius,
    editorBorder: ecs.borderTopWidth + ' ' + ecs.borderTopStyle + ' ' + ecs.borderTopColor,
    editorBox: { left: e.left, right: e.right, top: e.top, bottom: e.bottom, width: e.width, height: e.height },
    gap: s.left - e.right,
    handle: hb
      ? {
          left: hb.left,
          right: hb.right,
          top: hb.top,
          bottom: hb.bottom,
          width: hb.width,
          height: hb.height,
          cursor: getComputedStyle(h).cursor,
        }
      : null,
    rail: rail !== null,
    card: card !== null,
    cardDisplay: card ? getComputedStyle(card).display : null,
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
    // Same node as the one stamped before the toggle?
    cardStamped: card ? card.__probeCardStamp === 1 : null,
    railTitle: rail ? (rail.querySelector('[data-form-assist-rail-title]')?.textContent ?? '').trim() : null,
    railWriting: rail ? getComputedStyle(rail.querySelector('[data-form-assist-rail-title]')).writingMode : null,
    collapseBtn: document.querySelector('[data-form-assist-collapse]')?.getAttribute('aria-label') ?? null,
    expandBtn: document.querySelector('[data-form-assist-expand]')?.getAttribute('aria-label') ?? null,
    draft: card?.querySelector('textarea')?.value ?? null,
    pageScrollW: document.documentElement.scrollWidth,
    viewportW: window.innerWidth,
  }
  return out
}

/** Stamp the CARD (the node that must survive a collapse). */
window.__stampCard = () => {
  const card = document.querySelector('[data-form-assist-card]')
  if (!card) return false
  card.__probeCardStamp = 1
  return true
}

/** Leaf text of a section, so a caption can be compared without the heading
 *  labels surrounding it. */
window.__leafTexts = (selector) => {
  const root = document.querySelector(selector)
  if (!root) return []
  return [...root.querySelectorAll('*')]
    .filter((el) => el.children.length === 0)
    .map((el) => (el.textContent ?? '').trim())
    .filter(Boolean)
}

/** The concurrency row is the one place the two arms must differ. */
window.__concurrency = () => {
  const batch = document.querySelector('[data-routine-field="batch"]')
  if (!batch) return null
  const select = batch.querySelector('.ant-select')
  // antd v6 renders the selected value as .ant-select-content (with a title
  // attribute); .ant-select-selection-item is the v5 node and matches nothing.
  const item = batch.querySelector('.ant-select-content')
  const caption = window.__leafTexts('[data-routine-field="batch"]')
    .find((t) => t.includes('一次只跑一行') || t.includes('每一行都是独立会话'))
  return {
    present: !!select,
    disabled: select ? select.classList.contains('ant-select-disabled') : null,
    ariaDisabled: select ? select.getAttribute('aria-disabled') : null,
    value: item ? (item.getAttribute('title') ?? item.textContent ?? '').trim() : null,
    caption: caption ?? null,
  }
}

/** The schedule switch is checked only when the stored cron parsed back into
 *  the friendly scheduler — the capability the workflow arm just gained. */
window.__schedule = () => {
  const sec = document.querySelector('[data-routine-field="schedule"]')
  if (!sec) return null
  const sw = sec.querySelector('.ant-switch')
  const texts = window.__leafTexts('[data-routine-field="schedule"]')
  // 下次运行 lives in a wrapper whose own text node has element children, so it
  // is read off innerText rather than the leaf list (the leaf walk drops any
  // element carrying children, hint included).
  const hint = (sec.innerText ?? '').match(/下次运行[：:].*/)?.[0]?.trim() ?? null
  return {
    checked: sw ? sw.getAttribute('aria-checked') : null,
    texts,
    // 五档的最后一档标签是「Cron」（不是「自定义」）；裸 cron 输入框的形态是
    // 一个 textarea，档位 segmented 不在，所以档位名同时是形态的证据。
    hasFriendlyKinds: texts.includes('每天') && texts.includes('Cron'),
    hint,
  }
}

/** The file-trigger switch state (the only trigger surface the flag leaves
 *  on; the webhook arm is gated by ROUTINE_WEBHOOK_UI). */
window.__triggers = () => {
  const sec = document.querySelector('[data-routine-field="triggers"]')
  if (!sec) return null
  const row = [...sec.querySelectorAll('div')].find((el) =>
    el.children.length === 2 && (el.children[1].textContent ?? '').trim() === '文件变化时运行')
  const sw = sec.querySelector('.ant-switch')
  const texts = window.__leafTexts('[data-routine-field="triggers"]')
  return {
    hasFileRow: !!row,
    fileSwitchChecked: sw ? sw.getAttribute('aria-checked') : null,
    // Only the path inputs — the row also carries a 防抖 number input, whose
    // value ('5') would otherwise read back as a second path.
    paths: [...sec.querySelectorAll('input')]
      .filter((i) => !i.className.includes('ant-input-number'))
      .map((i) => i.value)
      .filter(Boolean),
    hasWebhookUrl: texts.some((t) => t.includes('127.0.0.1')),
  }
}

/** Which step is showing — read from the step card's own content, not from the
 *  segmented control, so a stale control cannot fake a passing switch. */
window.__stepContent = () => {
  const editor = document.querySelector('[data-pm-wizard-editor]')
  if (!editor) return null
  const text = editor.innerText
  return {
    basics: text.includes('任务名称'),
    content: text.includes('任务目标') || text.includes('需求文档'),
    runctx: text.includes('授权') || text.includes('工作区'),
    trigger: text.includes('定时执行') || text.includes('事件触发'),
    batch: !!editor.querySelector('[data-routine-field="batch"]'),
  }
}

window.__ready = true
`

/** 0.5.1 的展示门（src/shared/feature-flags.ts 的 WORKFLOW_TASKS_UI=false）把工作流
 *  的界面面收起来了，但画布/面板/向导本体必须原样完好——探针在 bundle 期把该常量
 *  钉成 true，测的是「翻转开关后一切照旧」。隐藏面本身（卡片/类型选项/编辑路由/
 *  时间线/分享预览）由 tests/workflow-hidden.test.ts 钉。 */
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
const near = (a, b) => Math.abs(a - b) <= 1.5
/** 关掉节点属性模态框（脚注最后一颗钮 = 关闭；第一颗是删除）。添加新节点会
 *  自动选中它、模态框随之浮出——画布的后续动作（整理 / 拖线）必须先把遮罩撤掉，
 *  这正是模态框与旧的常驻栏在交互上的差别。 */
const closeNodePanel = async () => {
  if ((await page.locator('[data-workflow-node-panel]').count()) === 0) return
  await page.locator('.ant-modal-footer button').last().click()
  await page.waitForFunction(() => document.querySelector('[data-workflow-node-panel]') === null)
  await page.waitForTimeout(250)
}
/** 开节点属性面板的唯一正道（user 2026-11-09）：悬停节点卡 → 点卡片内部右上角
 *  的编辑钮。点节点本体只选中、不再开面板——探针里任何「开面板」都得走这颗钮，
 *  直接 click 节点会让后面的 waitForSelector 超时。 */
const openNodePanel = async (nodeId) => {
  const card = `.react-flow__node[data-id="${nodeId}"]`
  await page.locator(card).hover()
  await page.locator(`${card} [data-workflow-node-edit]`).click()
  await page.waitForSelector('.ant-modal [data-workflow-node-panel] [data-workflow-field="prompt"] textarea')
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
// The harness bundles the CSS imports as TEXT (`loader: {'.css':'text'}`), so a
// bare `import '@xyflow/react/dist/style.css'` in WorkflowCanvas reaches the
// page as nothing. Without that sheet the nodes are static block divs, handles
// have no size and the controls sit under the background svg — §6 drags a real
// handle, so the sheet has to be there (and §5's zoom-strip click too).
await page.addStyleTag({ path: join(process.cwd(), 'node_modules/@xyflow/react/dist/style.css') })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

const cards = () => page.evaluate(() => window.__cards())
/** Step switches go through the real segmented control; the four labels are
 *  unique to the step bar (the kind picker is a radio pair, the schedule kinds
 *  are 每天/每周/…), so the text alone is unambiguous. */
const gotoStep = async (label) => {
  await page.locator('.ant-segmented-item', { hasText: label }).first().click()
  await page.waitForFunction(() => document.querySelector('[data-pm-form-assist]') !== null)
}
/** The routine arm has no synchronous fixture: routineGet lands asynchronously
 *  and only then does the draft (cron + batch + trigger prefill) reach the
 *  sections. Predicate wait on the stored cron having round-tripped — never a
 *  fixed sleep, which is what made the switch read stale here. */
const mountRoutine = async () => {
  await page.evaluate(() => window.__mount({ kind: 'routine', routineId: 'r_demo', workflowId: null }))
  await page.waitForSelector('[data-pm-form-assist]')
  await gotoStep('触发与批量')
  await page.waitForFunction(() => document.querySelector('[data-routine-field="schedule"] .ant-switch')?.getAttribute('aria-checked') === 'true')
}
/** Same story for the workflow wing: the prefill awaits pipelineWorkflows('get')
 *  — wait for the fixture's name to have reached the basics input, so a §4
 *  click cannot land on a not-yet-rendered select. */
const mountWorkflow = async () => {
  await page.evaluate(() => window.__mount({ kind: 'workflow' }))
  await page.waitForSelector('[data-pm-form-assist]')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '需求交付流程'))
}

// ══════════════════════════════════════════════════════════════════════════
// §1 · 助手卡是页面级兄弟，且贯穿四步（workflow 臂）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§1 · 助手卡独立于编辑面板，四步常驻（workflow）')
await mountWorkflow()
// The step card's geometry only settles once the prefill lands.
await page.waitForFunction(() => document.querySelector('[data-pm-wizard-editor]') !== null)

let c = await cards()
check('助手卡与步骤卡都在', c.assist && c.editor)
check('助手卡不是步骤卡的后代（独立出来）', c.nestedInEditor === false)
check('两卡同父（页面级并列）', c.sameParent === true && c.parentDirection === 'row')
check('助手卡在步骤卡右侧（横向不重叠）', c.hGap >= 0, `hGap=${c.hGap?.toFixed(1)}`)
check(
  '两卡同一行、同高（不是上下叠）',
  near(c.vGap, 0) && near(c.assistBox.height, c.editorBox.height),
  `vGap=${c.vGap?.toFixed(1)} assistH=${c.assistBox?.height.toFixed(1)} editorH=${c.editorBox?.height.toFixed(1)}`,
)
check('助手卡可见且有宽度', c.visible && c.assistBox.width > 200, `w=${c.assistBox?.width.toFixed(1)}`)
check('助手卡标题取 workflow 文案（任务助手）', c.title?.includes('任务助手'), c.title)

// The thread must survive the WIZARD, not just the first paint: stamp the node
// and re-read after every step switch. A per-step remount loses the expando —
// and with it the conversation the column exists to keep.
await page.evaluate(() => window.__stamp())
const steps = ['任务内容', '运行设置', '触发与批量', '基本信息']
for (const label of steps) {
  await gotoStep(label)
  const after = await cards()
  check(`切到「${label}」后助手卡仍是同一个 DOM 节点`, after.stamped === true)
  check(`切到「${label}」后仍是并列、仍可见`, after.nestedInEditor === false && after.visible === true)
}

// And the switch really changed the step card — otherwise the four checks
// above would pass on a dead control.
await gotoStep('触发与批量')
const triggerContent = await page.evaluate(() => window.__stepContent())
check('步骤卡确实换到「触发与批量」（控件不是死的）', triggerContent?.trigger === true && triggerContent?.basics === false)
check('助手卡在批量步仍在（贯穿编辑与配置全流程）', (await cards()).assist === true)

await page.screenshot({ path: join(SHOTS, 'workflow-trigger-step.png') })

// ══════════════════════════════════════════════════════════════════════════
// §2 · workflow 的「触发与批量」＝ routine 的那一套（并发行可见但锁定）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§2 · workflow 触发与批量：同一套三块 + 并发锁定')
const sched = await page.evaluate(() => window.__schedule())
check('定时执行块在（ScheduleSection 同一组件）', sched !== null)
check('存的 cron 回填进友好调度器（开关为开）', sched?.checked === 'true', `aria-checked=${sched?.checked}`)
check('友好调度器的时间档位在（每天/每周/…/Cron，不是裸 cron 输入）', sched?.hasFriendlyKinds === true, (sched?.texts ?? []).join(' | ').slice(0, 120))
check('下次运行提示由真实 cron 算出', !!sched?.hint, sched?.hint ?? '(none)')

const batchTexts = await page.evaluate(() => window.__leafTexts('[data-routine-field="batch"]'))
check('批量数据块在（BatchSection 同一组件）', batchTexts.length > 0 && batchTexts.some((t) => t.includes('批量数据')))
check(
  '批量文件取自 def.batch（不再是待填的裸路径）',
  batchTexts.some((t) => t.includes('batch.csv')),
  batchTexts.join(' | ').slice(0, 140),
)
check('表头识别结果在（CSV 预览已读）', (await page.evaluate(() => !!document.querySelector('[data-routine-batch-preview]'))) === true)

const conc = await page.evaluate(() => window.__concurrency())
check('并发行存在（不因为锁而退场）', conc?.present === true)
check('并发行禁用', conc?.disabled === true, `class-disabled=${conc?.disabled} aria=${conc?.ariaDisabled}`)
check('并发值锁定为「同时执行 1 行」', conc?.value === '同时执行 1 行', conc?.value ?? '(none)')
check(
  '锁的原因如实说明（串行 FIFO / 每阶段提交工作区）',
  !!conc?.caption && conc.caption.includes('一次只跑一行') && conc.caption.includes('工作区'),
  conc?.caption ?? '(none)',
)

const trig = await page.evaluate(() => window.__triggers())
check('事件触发块在（TriggersSection 同一组件）', trig !== null)
check('文件变化行在（两种模式同一个本机事件源）', trig?.hasFileRow === true)
check(
  '已存的文件触发回填（开关为开 + 路径在）',
  trig?.fileSwitchChecked === 'true' && (trig?.paths ?? []).some((p) => p.includes('watch')),
  `checked=${trig?.fileSwitchChecked} paths=${(trig?.paths ?? []).join(',')}`,
)
check('webhook 面在 flag 关闭时不渲染（ROUTINE_WEBHOOK_UI=false）', trig?.hasWebhookUrl === false)

// ══════════════════════════════════════════════════════════════════════════
// §3 · routine 臂是控制组：同样三块，只有并发行不同
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§3 · routine 臂（控制组，以它为准）')
await mountRoutine()

const rCards = await cards()
check('routine：助手卡同样是页面级并列（规矩属于向导，不属于某一种 kind）', rCards.nestedInEditor === false && rCards.sameParent === true && rCards.hGap >= 0)
check('routine：助手卡标题取对话式任务文案（任务助手）', rCards.title?.includes('任务助手'), rCards.title)

const rSched = await page.evaluate(() => window.__schedule())
check('routine：定时执行块在，开关为开', rSched?.checked === 'true' && rSched?.hasFriendlyKinds === true)
const rBatch = await page.evaluate(() => window.__leafTexts('[data-routine-field="batch"]'))
check(
  'routine：批量数据块在',
  rBatch.some((t) => t.includes('批量数据')),
)
const rConc = await page.evaluate(() => window.__concurrency())
check('routine：并发行可用（未禁用）', rConc?.present === true && rConc?.disabled === false, `disabled=${rConc?.disabled}`)
check('routine：并发值走缺省 3', rConc?.value === '同时执行 3 行', rConc?.value ?? '(none)')
check(
  'routine：说明文案是并发的常规解释（与 workflow 的锁因不同）',
  !!rConc?.caption && rConc.caption.includes('每一行都是独立会话'),
  rConc?.caption ?? '(none)',
)
const rTrig = await page.evaluate(() => window.__triggers())
check('routine：事件触发块在，文件行在', rTrig?.hasFileRow === true)

// Parity is the ruling's word: the SAME anchors, not three look-alikes.
const anchors = await page.evaluate(() => ({
  schedule: !!document.querySelector('[data-routine-field="schedule"]'),
  batch: !!document.querySelector('[data-routine-field="batch"]'),
  triggers: !!document.querySelector('[data-routine-field="triggers"]'),
}))
check('两模式同一份锚点（schedule / batch / triggers 三块齐）', anchors.schedule && anchors.batch && anchors.triggers, JSON.stringify(anchors))

await page.screenshot({ path: join(SHOTS, 'routine-trigger-step.png') })

// ══════════════════════════════════════════════════════════════════════════
// §4 · 锁不是摆设：workflow 的并发下拉真的点不开，routine 的能开
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§4 · 锁的真实交互（真点击）')
await mountWorkflow()
await gotoStep('触发与批量')
const wfSelect = page.locator('[data-routine-field="batch"] .ant-select').first()
await wfSelect.click({ force: true })
await page.waitForTimeout(250)
const wfOptions = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').count()
check('workflow：点并发下拉不弹选项', wfOptions === 0, `dropdowns=${wfOptions}`)

await mountRoutine()
await page.locator('[data-routine-field="batch"] .ant-select').first().click()
await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
const rLabels = await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').allInnerTexts()
check('routine：点并发下拉弹出 5 档选项', rLabels.length === 5 && rLabels[0].includes('同时执行 1 行'), rLabels.join(' | '))
await page.keyboard.press('Escape')

// ══════════════════════════════════════════════════════════════════════════
// §5 · 画布吃满宽度：左侧工具箱撤掉，添加/整理改成左缘竖排图标悬浮窗
// ══════════════════════════════════════════════════════════════════════════
// user 2026-11-09：「去掉左侧的工作箱面板，把添加按钮和整理按钮做成小的悬浮窗，
// 放到画布左侧上下居中的位置，仅icon图标，垂直排列；去掉放大缩小按钮浮窗里的
// 添加按钮」。三条都是几何/可见性事实：箱子撤掉后画布左缘必须贴住容器左缘
// （列宽归零），悬浮窗必须真的压在画布上（z-index 低于 pane 就点不到），
// 缩放条里的旧添加钮必须消失。源码扫描只能证明标记删了，证明不了宽度和层级。
console.log('\n§5 · workflow 画布：工具箱已撤，左缘竖排图标悬浮窗')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node')
await page.waitForSelector('[data-canvas-dock="workflow"]')
const dockGeom = await page.evaluate(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }
  const dock = document.querySelector('[data-canvas-dock="workflow"]')
  const flow = document.querySelector('.react-flow')
  const wrap = flow?.parentElement
  const btns = [...(dock?.querySelectorAll('[data-dock-action]') ?? [])]
  const controls = document.querySelector('.react-flow__controls')
  return {
    dock: box(dock),
    flow: box(flow),
    wrap: box(wrap),
    dockCount: document.querySelectorAll('[data-canvas-dock="workflow"]').length,
    toolboxLeft: document.querySelectorAll('[data-toolbox], .wf-toolbox').length,
    dockPosition: dock ? getComputedStyle(dock).position : null,
    dockDirection: dock ? getComputedStyle(dock).flexDirection : null,
    btns: btns.map((b) => ({
      action: b.getAttribute('data-dock-action'),
      box: box(b),
      text: b.innerText.trim(),
      label: b.getAttribute('aria-label') || b.getAttribute('title') || '',
    })),
    controlsBtns: controls ? controls.querySelectorAll('button').length : -1,
    controlsAddBtns: controls ? controls.querySelectorAll('[data-dock-action], .wf-add-node-btn').length : -1,
    nodes: document.querySelectorAll('.react-flow__node').length,
    // user 2026-11-09：「去掉【全局目标（可空）】栏位」——画布上方那块整块退场。
    objectiveLabel: document.body.innerText.includes('全局目标（可空）'),
    objectiveInputs: [...document.querySelectorAll('input')].filter((i) => i.placeholder.includes('全局目标')).length,
  }
})
check('左侧工具箱整块撤掉（无 [data-toolbox] 残留）', dockGeom.toolboxLeft === 0, `leftovers=${dockGeom.toolboxLeft}`)
check(
  '画布左缘贴住容器左缘（不再被一列箱子挤开）',
  dockGeom.flow && dockGeom.wrap && near(dockGeom.flow.left, dockGeom.wrap.left),
  `flow=${dockGeom.flow?.left?.toFixed(1)} wrap=${dockGeom.wrap?.left?.toFixed(1)}`,
)
check(
  '画布宽度 = 容器宽度（箱子那 190px 收回来了）',
  dockGeom.flow && dockGeom.wrap && near(dockGeom.flow.width, dockGeom.wrap.width),
  `flow=${dockGeom.flow?.width?.toFixed(1)} wrap=${dockGeom.wrap?.width?.toFixed(1)}`,
)
check(
  '悬浮窗只有一个，绝对定位压在画布上',
  dockGeom.dockCount === 1 && dockGeom.dockPosition === 'absolute',
  `count=${dockGeom.dockCount} pos=${dockGeom.dockPosition}`,
)
check(
  '悬浮窗贴画布左缘（left: 12px）',
  dockGeom.dock && near(dockGeom.dock.left - dockGeom.flow.left, 12),
  `offset=${(dockGeom.dock.left - dockGeom.flow.left).toFixed(1)}`,
)
check(
  '悬浮窗垂直居中（中心 y = 画布中心 y）',
  dockGeom.dock && near(dockGeom.dock.cy, dockGeom.flow.cy),
  `dock=${dockGeom.dock?.cy.toFixed(1)} flow=${dockGeom.flow?.cy.toFixed(1)}`,
)
check(
  '两个动作钮竖排（同 x，后一个更靠下）',
  (() => {
    const [a, b] = dockGeom.btns
    return !!a && !!b && near(a.box.cx, b.box.cx) && b.box.top > a.box.top
  })(),
  dockGeom.btns.map((b) => `${b.action}@${b.box.cx.toFixed(0)},${b.box.top.toFixed(0)}`).join(' | '),
)
check(
  '钮上只有图标（innerText 为空，文案退到 title/aria-label）',
  dockGeom.btns.length === 2 && dockGeom.btns.every((b) => b.text === '' && b.label.length > 0),
  dockGeom.btns.map((b) => `"${b.text}"/"${b.label}"`).join(' | '),
)
check('动作齐全且顺序为 添加 → 整理', dockGeom.btns.map((b) => b.action).join(',') === 'add,tidy', dockGeom.btns.map((b) => b.action).join(','))
check(
  '缩放条里不再挂添加钮（只剩 +/-/适应 三颗）',
  dockGeom.controlsBtns === 3 && dockGeom.controlsAddBtns === 0,
  `btns=${dockGeom.controlsBtns} add=${dockGeom.controlsAddBtns} icon=${dockGeom.dockDirection}`,
)
// 全局目标栏位（user 2026-11-09）：标签与输入框都不得在画布上方出现——
// 文字扫描抓标签，input 扫描抓「标签没了但输入框留着」的半截活。
check(
  '画布上方没有「全局目标（可空）」栏位',
  dockGeom.objectiveLabel === false && dockGeom.objectiveInputs === 0,
  `label=${dockGeom.objectiveLabel} inputs=${dockGeom.objectiveInputs}`,
)

// 真点击：悬浮窗压在画布上仍收得到点击（z-index 低于 react-flow pane 就会点空）。
await page.locator('[data-dock-action="add"]').click()
await page.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length > n, dockGeom.nodes)
check(
  '点悬浮窗的「添加」真的加了一个节点',
  (await page.locator('.react-flow__node').count()) === dockGeom.nodes + 1,
  `${dockGeom.nodes} → ${await page.locator('.react-flow__node').count()}`,
)
// 添加会选中新节点 → 属性模态框浮出盖住画布；整理是画布动作，先关面板。
check('添加后属性模态框浮出（同一次点击的落点）', (await page.locator('[data-workflow-node-panel]').count()) === 1)
await closeNodePanel()
const afterAdd = await page.locator('.react-flow__node').count()
await page.locator('[data-dock-action="tidy"]').click()
await page.waitForTimeout(200)
check('点「整理」不增删节点（只重排坐标）', (await page.locator('.react-flow__node').count()) === afterAdd)
await page.screenshot({ path: join(SHOTS, 'workflow-canvas-dock.png') })

// ══════════════════════════════════════════════════════════════════════════
// §6 · 结束芯片是合法落点：从任务卡的流出口拖过去，真的连得上
// ══════════════════════════════════════════════════════════════════════════
// user 2026-11-09：「结束图标连线连不上」。根因是 DONE 的 target Handle 挂了
// isConnectable={false}——`type="target"` 本来就挡住了「从芯片起拖」，那一条只
// 把唯一的落点判死：任务卡的流出口拖过来被 React Flow 当非法连接静默丢弃（没有
// 任何报错、连线预览也正常消失），源码扫描只能证明属性删了，证明不了拖拽能落地，
// 所以这里用真鼠标拖一次，并且成对钉住「新边在 + 旧边也在」——画布自 2026-11-09
// 多出口裁定起是**追加**语义（拖到结束不再顶掉 plan 原有的出口），这条与 §7 互补：
// 这里证明终态芯片仍是合法落点，§7 证明第二条出边真的能留住。故意用带旧出口的
// plan 而不是叶子 code——那才能区分「连上了」和「本来就连着」。
console.log('\n§6 · 结束芯片可连：从任务卡流出口拖到结束')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="terminal:DONE"]')
// fitView 的缩放是首帧量完节点后才落定的异步动作；用缩放条里的「适应」把它钉住，
// 否则 boundingBox 读到的是过渡中的坐标。
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)

const edgeIds = () => page.evaluate(() => [...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('data-id')))
const edgesBefore = await edgeIds()
const dragHandleTo = async (fromNode, toNode) => {
  const from = await page.locator(`.react-flow__node[data-id="${fromNode}"] .react-flow__handle.source`).boundingBox()
  const to = await page.locator(`.react-flow__node[data-id="${toNode}"] .react-flow__handle.target`).boundingBox()
  if (!from || !to) return { from, to }
  const fx = from.x + from.width / 2
  const fy = from.y + from.height / 2
  const tx = to.x + to.width / 2
  const ty = to.y + to.height / 2
  await page.mouse.move(fx, fy)
  await page.mouse.down()
  // 分步移动：连线拖拽靠 pointermove 序列推进，一步跳到终点会被当成一次点击。
  await page.mouse.move(fx + 14, fy + 14, { steps: 5 })
  await page.mouse.move(tx, ty, { steps: 15 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  return { from, to }
}
const doneHandle = await page.locator('.react-flow__node[data-id="terminal:DONE"] .react-flow__handle.target').boundingBox()
const dragged = await dragHandleTo('node:plan', 'terminal:DONE')
const edgesAfter = await edgeIds()
check(
  '结束芯片的落点线头在画面上可见（不是零尺寸）',
  !!doneHandle && doneHandle.width > 0 && doneHandle.height > 0,
  `w=${doneHandle?.width?.toFixed(1)} h=${doneHandle?.height?.toFixed(1)}`,
)
check('任务卡流出口与结束落点都量到了坐标', !!dragged.from && !!dragged.to, `from=${!!dragged.from} to=${!!dragged.to}`)
check('拖到「结束」真的产出 plan → DONE 这条边', edgesAfter.includes('edge:plan|done|DONE'), edgesAfter.join(' | '))
check(
  '多出口语义：plan→DONE 追加在旧出口旁边，plan→code 不被顶掉',
  edgesBefore.includes('edge:plan|done|code') && edgesAfter.includes('edge:plan|done|code'),
  `before=${edgesBefore.join(' | ')} after=${edgesAfter.join(' | ')}`,
)
await page.screenshot({ path: join(SHOTS, 'workflow-canvas-connect-done.png') })

// ══════════════════════════════════════════════════════════════════════════
// §7 · 多出口 + 三入线头（user 2026-11-09：普通节点可连多个下游；入线头在上/左/右）
// ══════════════════════════════════════════════════════════════════════════
// 四件事源码扫描证明不了：① 每张任务卡真的多出三个 target 线头且各自有尺寸
// （属性挂了但盒模型为零，鼠标永远落不上去）；② 同一个底部流出口连第二条线时
// 旧边必须还在（追加语义，§6 的镜像面）；③ React Flow 的落点是 targetHandle 派
// 的——只有读**渲染路径**的终点（getPointAtLength + getScreenCTM）才能证明它真的
// 钻进了那个线头，边对象里看不见落点；④ 侧向入边（目标在右 → in-left）与顶入
// （in-top）各一例。路径坐标是 world 空间，必须过 CTM 才是屏幕像素，直接比会永远
// 差一个视口变换。
console.log('\n§7 · 多出口与三入线头：真拖拽追加，路径终点落进指定线头')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="node:plan"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)

const centerOf = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }
  }, sel)
const handleSel = (nodeId, handleId) => `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${handleId}"]`
/** handle inventory：id / 方向 / 尺寸 / 中心点（尺寸为零 = 点不到，属性在也没用）。 */
const handlesOf = (nodeId) =>
  page.evaluate((id) => {
    const root = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    // 画布缩放（viewport 的 CSS transform）：线头 bbox 是屏幕像素，要换回世界
    // 单位才能跟 12px 的外径契约比。
    let scale = 1
    try {
      const vp = document.querySelector('.react-flow__viewport')
      const m = vp ? new DOMMatrixReadOnly(getComputedStyle(vp).transform) : null
      if (m && (m.a || m.b)) scale = Math.hypot(m.a, m.b) || 1
    } catch {
      scale = 1
    }
    return [...(root?.querySelectorAll('.react-flow__handle') ?? [])].map((h) => {
      const r = h.getBoundingClientRect()
      return {
        id: h.getAttribute('data-handleid'),
        pos: h.getAttribute('data-handlepos'),
        type: h.classList.contains('source') ? 'source' : 'target',
        w: r.width,
        h: r.height,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        scale,
      }
    })
  }, nodeId)
/** 真鼠标拖一段：分步移动，一步跳终点会被当成点击（同 §6）。 */
const dragBetween = async (from, to) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 15 })
  await page.mouse.up()
  await page.waitForTimeout(320)
}
/** 边的渲染路径终点与目标线头的关系（world → screen 过 CTM）。
 *  user 2026-11-09「连接端点会把连接线的箭头端点遮住」之后，画出来的 d **提前
 *  ARROW_GAP 收手**；同日复审「端点和箭头之间有间隙，期望恰好接住」把它调成了
 *  圆点外半径。于是判据是**贴边**：终点到圆心的距离 ≈ 圆点外半径（既没埋进
 *  圆点，也没悬空留缝），且沿末段方向的横向偏移 ≈ 0（没有歪在一边）。
 *  量到的都是屏幕像素，半径也从实测 bbox 取，所以缩放与 DPR 都不影响判定。
 *  末段方向用 total 与 total-2 两点差分求得。 */
const endpointOf = (edgeId, nodeId, handleId) =>
  page.evaluate(
    ([eid, nid, hid, gap]) => {
      const path = document.querySelector(`.react-flow__edge[data-id="${eid}"] .react-flow__edge-path`)
      const handle = document.querySelector(`.react-flow__node[data-id="${nid}"] .react-flow__handle[data-handleid="${hid}"]`)
      if (!path || !handle) return null
      const total = path.getTotalLength()
      const m = path.getScreenCTM()
      const end = path.getPointAtLength(total).matrixTransform(m)
      const back = path.getPointAtLength(Math.max(0, total - 2)).matrixTransform(m)
      const r = handle.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const len = Math.hypot(end.x - back.x, end.y - back.y) || 1
      const dirX = (end.x - back.x) / len
      const dirY = (end.y - back.y) / len
      const toPortX = cx - end.x
      const toPortY = cy - end.y
      return {
        x: end.x,
        y: end.y,
        cx,
        cy,
        dist: Math.hypot(toPortX, toPortY),
        // 圆点外半径（屏幕像素）——「恰好接住」的参照面。
        radius: r.width / 2,
        inside: end.x >= r.left - 2 && end.x <= r.right + 2 && end.y >= r.top - 2 && end.y <= r.bottom + 2,
        // 端口在前进方向上的投影（应 ≈ gap × scale）与横向偏离（应 ≈ 0）。
        advance: toPortX * dirX + toPortY * dirY,
        lateral: Math.abs(toPortX * dirY - toPortY * dirX),
        // 画布是缩放过的：ARROW_GAP 是**世界坐标**里的 6px，探针读的是屏幕像素，
        // 判据必须按当前缩放换算（fitview 后 zoom≠1 时直接比 6 会假红）。
        scale: Math.hypot(m.a, m.b) || 1,
        gap,
      }
    },
    [edgeId, nodeId, handleId, ARROW_GAP],
  )
/** 箭头尖是否**恰好落在端口圆点的边缘**：终点到圆心的距离 ≈ 圆点外半径，容差
 *  0.75 世界像素——刚好让「圆心系统性差 1px」这类回归变红（旧的 1.5 容差放过了
 *  它，而那 1px 在屏幕上就是一条明显的缝，user 2026-11-09「期望恰好接住」）。
 *  埋进圆点（dist < r − 容差）是「被遮住」，悬空留缝（dist > r + 容差）是「有间
 *  隙」——两头都判红。量的是屏幕像素，再按画布缩放折回世界 px，于是与 DPR 无关。 */
const stopsAtPortRim = (e) => !!e && Math.abs(e.dist - e.radius) <= 0.75 * e.scale && e.lateral <= 3 * e.scale

/** 在本边的渲染路径上找一个**真属于它**的点击点：逐点问 elementFromPoint
 *  「这一像素归哪条边」，只用命中本边的采样点去点（15%~85%——端点附近恒被
 *  线头/卡片压着）。连线靠 20px 的命中带选中，纵向布局把主线排成一条竖线
 *  之后，相邻两条边会贴着走，几何中点未必落在本边上。 */
const edgeClickPoint = (edgeId) =>
  page.evaluate((eid) => {
    const path = document.querySelector(`.react-flow__edge[data-id="${eid}"] .react-flow__edge-path`)
    if (!path) return { point: null, owners: [], reason: '渲染路径不在 DOM 里' }
    const total = path.getTotalLength()
    const m = path.getScreenCTM()
    const owners = []
    for (let i = 1; i <= 21; i += 1) {
      const at = total * (0.15 + (0.7 * i) / 22)
      const screen = path.getPointAtLength(at).matrixTransform(m)
      const hit = document.elementFromPoint(screen.x, screen.y)
      const owner = hit?.closest?.('.react-flow__edge')?.getAttribute('data-id') ?? null
      owners.push(owner ?? (hit ? String(hit.getAttribute('class') ?? hit.tagName).slice(0, 22) : 'none'))
      if (owner === eid) return { point: { x: screen.x, y: screen.y }, owners, reason: `at ${(at / total).toFixed(2)}` }
    }
    return { point: null, owners, reason: '沿路径没有一个像素归本边' }
  }, edgeId)

const nodesAtStart = await page.locator('.react-flow__node').count()
check('§7 起点是干净的夹具（2 任务卡 + 2 芯片，§5/§6 的改动没漏进来）', nodesAtStart === 4, `nodes=${nodesAtStart}`)

const planHandles = await handlesOf('node:plan')
const planTargets = planHandles.filter((h) => h.type === 'target')
check(
  '任务卡暴露三个入线头（in-top / in-left / in-right）',
  planTargets
    .map((h) => h.id)
    .sort()
    .join(',') === 'in-left,in-right,in-top',
  planTargets.map((h) => `${h.id}@${h.pos}`).join(' '),
)
check(
  '三个入线头都有可点尺寸',
  planTargets.length === 3 && planTargets.every((h) => h.w > 0 && h.h > 0),
  planTargets.map((h) => `${h.id}:${h.w.toFixed(0)}x${h.h.toFixed(0)}`).join(' '),
)
// 箭头「恰好接住」的几何基础：圆点外径必须等于 2 × ARROW_GAP（12px 契约，
// border-box）。改了 CSS 忘了改 route.ts 的 ARROW_GAP，这里当场红。
check(
  '入线头外径 = 2 × ARROW_GAP（12px 契约，不随 DPR 取整漂移）',
  planTargets.every((h) => Math.abs(h.w / h.scale - ARROW_GAP * 2) <= 1) && planTargets.every((h) => Math.abs(h.h / h.scale - ARROW_GAP * 2) <= 1),
  planTargets.map((h) => `${h.id}:${(h.w / h.scale).toFixed(1)}x${(h.h / h.scale).toFixed(1)}`).join(' '),
)
const planSources = planHandles.filter((h) => h.type === 'source')
check(
  '单状态节点只有一根出口线头，id = out:<verdict>（自定义状态 done 原样上线头）',
  planSources.length === 1 && planSources[0].id === 'out:done' && planSources[0].pos === 'bottom',
  planSources.map((h) => `${h.id}@${h.pos}`).join(','),
)

// ── 顶入例：加一张卡拖到 plan 正下方，从 plan 的底出连到它的 in-top ──
await page.locator('[data-dock-action="add"]').click()
await page.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length > n, nodesAtStart)
await page.waitForTimeout(250)
await closeNodePanel()
const step3Card = await centerOf('.react-flow__node[data-id="node:step3"]')
check('悬浮窗「添加」产出的节点 id 是 step3（夹具避让 plan/code）', !!step3Card, `box=${step3Card ? 'ok' : 'null'}`)
const planCard = await centerOf('.react-flow__node[data-id="node:plan"]')
if (step3Card && planCard) await dragBetween({ x: step3Card.x, y: step3Card.y }, { x: planCard.x, y: planCard.bottom + 170 })

const edgesBefore7 = await edgeIds()
const planSrc7 = await centerOf(handleSel('node:plan', 'out:done'))
const step3Top = await centerOf(handleSel('node:step3', 'in-top'))
if (planSrc7 && step3Top) await dragBetween(planSrc7, step3Top)
const edgesAfterTop = await edgeIds()
check('从 plan 底出再连一条（→step3）：新边出现', edgesAfterTop.includes('edge:plan|done|step3'), edgesAfterTop.join(' | '))
check('多出口：plan 原有的 plan→code 仍在（不是顶掉）', edgesAfterTop.includes('edge:plan|done|code'), edgesAfterTop.join(' | '))
check('这一拖只多一条边（边数 +1）', edgesAfterTop.length === edgesBefore7.length + 1, `${edgesBefore7.length} → ${edgesAfterTop.length}`)
const topEnd = await endpointOf('edge:plan|done|step3', 'node:step3', 'in-top')
check(
  '顶入：箭头尖恰好落在 in-top 圆点边缘（不埋进圆点、也不留缝）',
  stopsAtPortRim(topEnd),
  topEnd
    ? `end=(${topEnd.x.toFixed(1)},${topEnd.y.toFixed(1)}) handle=(${topEnd.cx.toFixed(1)},${topEnd.cy.toFixed(1)}) dist=${topEnd.dist.toFixed(1)} r=${topEnd.radius.toFixed(1)} advance=${topEnd.advance.toFixed(1)} lateral=${topEnd.lateral.toFixed(1)} scale=${topEnd.scale.toFixed(2)}`
    : 'null',
)

// ── 侧入例：再加一张卡拖到 code 右侧，从 plan 底出连到它的 in-left ──
await page.locator('[data-dock-action="add"]').click()
await page.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length > n, nodesAtStart + 1)
await page.waitForTimeout(250)
await closeNodePanel()
const step4Card = await centerOf('.react-flow__node[data-id="node:step4"]')
const codeCard = await centerOf('.react-flow__node[data-id="node:code"]')
check('第二张卡 id 是 step4', !!step4Card, `box=${step4Card ? 'ok' : 'null'}`)
if (step4Card && codeCard) await dragBetween({ x: step4Card.x, y: step4Card.y }, { x: codeCard.right + 150, y: codeCard.y })

const edgesBeforeLeft = await edgeIds()
const planSrc8 = await centerOf(handleSel('node:plan', 'out:done'))
const step4Left = await centerOf(handleSel('node:step4', 'in-left'))
if (planSrc8 && step4Left) await dragBetween(planSrc8, step4Left)
const edgesAfterLeft = await edgeIds()
check('侧入：plan → step4 这条边出现', edgesAfterLeft.includes('edge:plan|done|step4'), edgesAfterLeft.join(' | '))
check(
  '同一个出口现在挂着三条出边（code / step3 / step4）',
  ['edge:plan|done|code', 'edge:plan|done|step3', 'edge:plan|done|step4'].every((id) => edgesAfterLeft.includes(id)),
  edgesAfterLeft.filter((id) => id.startsWith('edge:plan|')).join(' | '),
)
check('这一拖同样只多一条边（追加而不是替换）', edgesAfterLeft.length === edgesBeforeLeft.length + 1, `${edgesBeforeLeft.length} → ${edgesAfterLeft.length}`)
const leftEnd = await endpointOf('edge:plan|done|step4', 'node:step4', 'in-left')
check(
  '侧入：箭头尖恰好落在 in-left 圆点边缘',
  stopsAtPortRim(leftEnd),
  leftEnd
    ? `end=(${leftEnd.x.toFixed(1)},${leftEnd.y.toFixed(1)}) handle=(${leftEnd.cx.toFixed(1)},${leftEnd.cy.toFixed(1)}) dist=${leftEnd.dist.toFixed(1)} r=${leftEnd.radius.toFixed(1)} advance=${leftEnd.advance.toFixed(1)} lateral=${leftEnd.lateral.toFixed(1)} scale=${leftEnd.scale.toFixed(2)}`
    : 'null',
)
await page.screenshot({ path: join(SHOTS, 'workflow-canvas-multi-out.png') })

// ══════════════════════════════════════════════════════════════════════════
// §7b · 入口徽标已撤 + 编辑钮悬停才露（user 2026-11-09 两裁定）
//       「去掉节点的【入口】标记」「当鼠标悬停在节点上，节点内部右上角出现编辑
//       按钮，点击该按钮才出现编辑悬浮框」。三条都是 DOM/几何事实：徽标是文本，
//       按钮是 opacity + pointer-events 的两态，面板是模态框的有无——源码扫描
//       只能证明属性写了，证明不了静止态真的点不到、悬停态真的点得到。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§7b · 入口徽标已撤 + 悬停编辑钮（点本体不开面板）')
await page.mouse.move(4, 4) // 清掉 §7 拖拽留下的悬停态
await page.waitForTimeout(200)
const badge = await page.evaluate(() => {
  const root = document.querySelector('.react-flow__node[data-id="node:plan"]')
  const startCard = document.querySelector('.react-flow__node[data-id="terminal:START"]')
  return {
    text: root?.textContent ?? '',
    badges: document.querySelectorAll('.wf-entry-badge, [data-workflow-entry-badge]').length,
    startText: startCard?.textContent ?? '',
  }
})
check(
  '任务卡上没有【入口】徽标（文案、类名、data 钩子三处都撤了）',
  !badge.text.includes('入口') && badge.badges === 0,
  `badges=${badge.badges} text=${badge.text.replace(/\s+/g, ' ').slice(0, 40)}`,
)
check('入口的指示改由开始芯片承担（它本来就指向入口节点）', badge.startText.length > 0, badge.startText)

const editBtn = () =>
  page.evaluate(() => {
    const card = document.querySelector('.react-flow__node[data-id="node:plan"]')
    const btn = card?.querySelector('[data-workflow-node-edit]')
    if (!card || !btn) return null
    const cs = getComputedStyle(btn)
    const r = btn.getBoundingClientRect()
    const cr = card.getBoundingClientRect()
    // React Flow 把节点画在带 transform: scale(zoom) 的 pane 里，屏幕像素与 CSS
    // 像素不等值（fitView 下 zoom ≈ 1.53）。offsetWidth 是**布局**宽，rect 是缩放
    // 后的宽，两者之比就是这一层的 zoom——用它把距离换回 CSS 像素再判阈值。
    const scale = btn.offsetWidth > 0 ? r.width / btn.offsetWidth : 1
    return {
      opacity: cs.opacity,
      pe: cs.pointerEvents,
      w: r.width,
      h: r.height,
      inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.top >= cr.top - 0.5 && r.bottom <= cr.bottom + 0.5,
      fromRight: (cr.right - r.right) / scale,
      fromTop: (r.top - cr.top) / scale,
      scale,
      label: btn.getAttribute('aria-label') ?? btn.getAttribute('title') ?? '',
    }
  })
const restBtn = await editBtn()
check('编辑钮在卡片内部（不是浮在卡外）', !!restBtn && restBtn.inside && restBtn.w > 0, JSON.stringify(restBtn))
check(
  '静止态编辑钮不可见也不可点（opacity 0 + pointer-events none）',
  restBtn?.opacity === '0' && restBtn?.pe === 'none',
  `opacity=${restBtn?.opacity} pe=${restBtn?.pe}`,
)
check(
  '编辑钮贴在卡片内部的右上角（CSS 像素下右、上各 ≤8px：6px 偏移 + 1px 描边）',
  !!restBtn && restBtn.fromRight <= 8 && restBtn.fromTop <= 8,
  `right=${restBtn?.fromRight?.toFixed(1)} top=${restBtn?.fromTop?.toFixed(1)} @zoom=${restBtn?.scale?.toFixed(2)}`,
)
check('图标钮有可读名字（aria-label 不能空）', (restBtn?.label ?? '').length > 0, restBtn?.label)

await page.locator('.react-flow__node[data-id="node:plan"]').hover()
await page.waitForTimeout(250) // 0.15s 的 opacity 过渡 + 一帧余量
const hoverBtn = await editBtn()
check(
  '悬停节点卡 → 编辑钮露出且可点（opacity 1 / pointer-events auto）',
  hoverBtn?.opacity === '1' && hoverBtn?.pe === 'auto',
  `opacity=${hoverBtn?.opacity} pe=${hoverBtn?.pe}`,
)
await page.screenshot({ path: join(SHOTS, 'workflow-node-edit-hover.png') })

// 点节点本体 → 只选中，不开面板（用户原话「点击该按钮才出现编辑悬浮框」）。
await page.locator('.react-flow__node[data-id="node:plan"]').click()
await page.waitForTimeout(300)
check('点节点本体不开属性面板（只有编辑钮能开）', (await page.locator('[data-workflow-node-panel]').count()) === 0)
await openNodePanel('node:plan')
check('点编辑钮才唤出属性面板', (await page.locator('.ant-modal [data-workflow-node-panel]').count()) === 1)
await closeNodePanel()

// ── 悬停区第二颗钮：编辑旁还有删除（user 2026-11-09「在悬停出现的编辑旁，再增加
//    删除按钮」）。这条链有三个源码读不出的事实：静止态真的点不到、两颗钮真的
//    同排且不叠在一起、点下去不会立刻删（连带删光该节点的连线、entry 被删还会
//    改入口，必须先弹确认）。
// 先清掉选中态：前面点过节点本体，`.react-flow__node.selected` 本身也会把两颗
// 钮显形——这里要的是「既没悬停、也没选中」的静止态。
await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } })
await page.mouse.move(4, 4)
await page.waitForTimeout(250)
const nodeButtons = () =>
  page.evaluate(() => {
    const card = document.querySelector('.react-flow__node[data-id="node:plan"]')
    if (!card) return null
    const cr = card.getBoundingClientRect()
    const read = (sel) => {
      const btn = card.querySelector(sel)
      if (!btn) return null
      const cs = getComputedStyle(btn)
      const r = btn.getBoundingClientRect()
      // 与 §7b 的编辑钮同款：pane 带 transform: scale(zoom)，距离要折回 CSS 像素。
      const scale = btn.offsetWidth > 0 ? r.width / btn.offsetWidth : 1
      return {
        opacity: cs.opacity,
        pe: cs.pointerEvents,
        left: r.left,
        right: r.right,
        top: r.top,
        scale,
        label: btn.getAttribute('aria-label') ?? btn.getAttribute('title') ?? '',
        inside: r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5 && r.top >= cr.top - 0.5 && r.bottom <= cr.bottom + 0.5,
      }
    }
    return { del: read('[data-workflow-node-delete]'), edit: read('[data-workflow-node-edit]') }
  })
const restBtns = await nodeButtons()
check(
  '删除钮也在卡片内部、与编辑钮同排（同一行右上角）',
  !!restBtns?.del?.inside && !!restBtns?.edit?.inside && Math.abs(restBtns.del.top - restBtns.edit.top) < 0.5,
  `delInside=${restBtns?.del?.inside} topΔ=${restBtns?.del && restBtns?.edit ? (restBtns.del.top - restBtns.edit.top).toFixed(1) : '?'}`,
)
check(
  '静止态删除钮与编辑钮一样不可见不可点（opacity 0 + pointer-events none）',
  restBtns?.del?.opacity === '0' && restBtns?.del?.pe === 'none',
  `opacity=${restBtns?.del?.opacity} pe=${restBtns?.del?.pe}`,
)
check(
  '删除钮紧挨编辑钮左侧 4 CSS px（22px 钮 + 4px 间距，含缩放折回）',
  !!restBtns?.del && !!restBtns?.edit && Math.abs((restBtns.edit.left - restBtns.del.right) / restBtns.del.scale - 4) <= 1.5,
  restBtns?.del && restBtns?.edit
    ? `gap=${((restBtns.edit.left - restBtns.del.right) / restBtns.del.scale).toFixed(1)}px @zoom=${restBtns.del.scale.toFixed(2)}`
    : 'null',
)
check('删除钮有可读名字（aria-label 不能空）', (restBtns?.del?.label ?? '').length > 0, restBtns?.del?.label)

await page.locator('.react-flow__node[data-id="node:plan"]').hover()
await page.waitForTimeout(250)
const hoverBtns = await nodeButtons()
check(
  '悬停后两颗钮同时露出（共用一组显形规则，不会只露一颗）',
  hoverBtns?.del?.opacity === '1' && hoverBtns?.del?.pe === 'auto' && hoverBtns?.edit?.opacity === '1' && hoverBtns?.edit?.pe === 'auto',
  `delete=${hoverBtns?.del?.opacity}/${hoverBtns?.del?.pe} edit=${hoverBtns?.edit?.opacity}/${hoverBtns?.edit?.pe}`,
)
await page.screenshot({ path: join(SHOTS, 'workflow-node-actions-hover.png') })

const planEdgesBefore = (await edgeIds()).filter((id) => id.startsWith('edge:plan|'))
await page.locator('.react-flow__node[data-id="node:plan"] [data-workflow-node-delete]').click()
await page.waitForSelector('.ant-modal-confirm')
const delConfirmText = (await page.locator('.ant-modal-confirm').innerText()).replace(/\s+/g, ' ')
check(
  '点删除先弹确认、节点仍在（未确认不删：连带删连线 + 可能改入口）',
  (await page.locator('.react-flow__node[data-id="node:plan"]').count()) === 1 && /一并删除/.test(delConfirmText),
  delConfirmText.slice(0, 120),
)
await page.locator('.ant-modal-confirm-btns .ant-btn-primary').click()
await page.waitForTimeout(400)
const planEdgesAfter = (await edgeIds()).filter((id) => id.startsWith('edge:plan|'))
check(
  '确认后卡片消失，它的三条出边一并消失（别的边不受影响）',
  (await page.locator('.react-flow__node[data-id="node:plan"]').count()) === 0 && planEdgesBefore.length === 3 && planEdgesAfter.length === 0,
  `before=${planEdgesBefore.length} after=${planEdgesAfter.join(' | ') || 'none'}`,
)

// ══════════════════════════════════════════════════════════════════════════
// §8 · 节点属性面板 = 模态框（user 2026-11-09：不固定占用工作区面积）
//      原来的 320px 常驻 aside 永久从画布上切掉一条，现在点节点才浮出来；编辑
//      仍是即时的（直接写 def），所以「关闭」不是撤销。面板里的「插入变量」与
//      任务式对话同一套：真点真插、落在 caret 上（同日前一条裁定：不要用静态
//      提示行罗列占位符）。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§8 · 节点属性面板：模态框不占画布 + 插入变量真点真插')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="node:plan"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)

// 画布几何：模态框是浮层，开与不开都不该改变画布宽度——「开的时候也一致」正是
// 常驻 aside 那次的镜像面（那时画布恒少 320px）。
// 父容器里还有一张 <style>（CANVAS_STYLES），所以不能数子元素个数——量的直接是
// 「画布宽度 == 父容器内容宽」（padding 要不要紧不该由这条断言裁决）与「没有 aside」。
const canvasBox = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-workflow-canvas]')
    if (!el) return null
    const parent = el.parentElement
    const cs = getComputedStyle(parent)
    const contentW = parent.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')
    return {
      w: Math.round(el.getBoundingClientRect().width),
      contentW: Math.round(contentW),
      asides: parent.querySelectorAll('aside').length,
    }
  })
const boxBefore = await canvasBox()
check('无选中时没有属性面板（不是常驻栏）', await page.evaluate(() => document.querySelector('[data-workflow-node-panel]') === null), JSON.stringify(boxBefore))
check(
  '画布独自吃满整行（宽度 == 容器内容宽，且容器里没有 aside）',
  !!boxBefore && near(boxBefore.w, boxBefore.contentW) && boxBefore.asides === 0,
  JSON.stringify(boxBefore),
)

await openNodePanel('node:plan')
const boxOpen = await canvasBox()
check('属性面板是模态框（面板体挂在 .ant-modal 里）', (await page.locator('.ant-modal [data-workflow-node-panel]').count()) === 1)
check(
  '模态框不占画布面积（开面板前后画布宽度逐像素一致、仍无 aside）',
  !!boxOpen && boxOpen.w === boxBefore.w && boxOpen.asides === 0,
  `before=${JSON.stringify(boxBefore)} open=${JSON.stringify(boxOpen)}`,
)
check(
  '模态框是浮层（.ant-modal-wrap position:fixed）',
  (await page.evaluate(() => getComputedStyle(document.querySelector('.ant-modal-wrap')).position)) === 'fixed',
)

// antd 的 autoSize TextArea 还渲染一个测量用的隐藏 textarea，其 textContent 就是
// 指令正文——扫「提示行已撤」必须把 textarea/input 摘掉，否则正文自己被当成提示。
const panelText = await page.evaluate(() => {
  const box = document.querySelector('[data-workflow-node-panel]')
  if (!box) return null
  const clone = box.cloneNode(true)
  clone.querySelectorAll('textarea, input').forEach((el) => el.remove())
  return clone.textContent ?? ''
})
check('模态框里是环节指令编辑态（标题 + 指令）', (panelText ?? '').includes('环节指令'), (panelText ?? '').slice(0, 60))
check(
  '静态提示行已撤：面板上不再罗列 {{token}}',
  panelText !== null && !panelText.includes('{{'),
  (panelText ?? '(no panel)').replace(/\s+/g, ' ').slice(0, 160),
)
check('旧的「可用占位符」文案也一并撤掉（不是换措辞）', !(panelText ?? '').includes('可用占位符'))
check('删除环节落在模态框脚注（不是面板外的裸按钮）', (await page.locator('.ant-modal-footer button').first().innerText()).includes('删除环节'))
check('「插入变量」控件挂在指令标题行上', (await page.locator('[data-workflow-var-insert] .ant-select').count()) === 1)

const promptText = () => page.locator('[data-workflow-field="prompt"] textarea').inputValue()
const openVarMenu = async () => {
  await page.locator('[data-workflow-var-insert] .ant-select').click()
  await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
}
const pickVar = async (label) => {
  const option = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: label }).first()
  await option.waitFor()
  await option.click()
  await page.waitForTimeout(160)
}
const closePanel = closeNodePanel

// caret 放在「根据 ▸」之后（index 3），插入必须落在这里而不是串尾。
await page.evaluate(() => {
  const area = document.querySelector('[data-workflow-field="prompt"] textarea')
  area.focus()
  area.setSelectionRange(3, 3)
})
await openVarMenu()
const menuGroups = await page.evaluate(() =>
  [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-group')].map((g) => g.textContent),
)
check(
  '菜单分组齐全（阶段变量 / 运行上下文 / 内置变量 / 任务变量）',
  ['阶段变量', '运行上下文', '内置变量', '任务变量'].every((g) => menuGroups.includes(g)),
  menuGroups.join(' | '),
)
const menuStage = await page.evaluate(() =>
  [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].map((o) => o.textContent),
)
check(
  '阶段变量带 token 标注（上一阶段摘要 {{prevSummary}}）',
  menuStage.some((s) => s === '上一阶段摘要 {{prevSummary}}'),
  menuStage.slice(0, 4).join(' | '),
)
check(
  '运行上下文组在（运行目标 {{objective}}）',
  menuStage.some((s) => s === '运行目标 {{objective}}'),
)
await page.screenshot({ path: join(SHOTS, 'workflow-node-var-menu.png') })

await page.keyboard.press('Escape')
await page.waitForTimeout(150)

// 重新把 caret 放回 3 并真点一项 → 插在 caret 处、插入后光标紧跟 token、焦点回到 textarea。
const placeCaret = () =>
  page.evaluate(() => {
    const area = document.querySelector('[data-workflow-field="prompt"] textarea')
    area.focus()
    area.setSelectionRange(3, 3)
  })
await placeCaret()
await openVarMenu()
await pickVar('上一阶段摘要 {{prevSummary}}')
const afterPick = await promptText()
check('插入落在 caret 上（不是串尾追加）', afterPick === '根据 {{prevSummary}}{{docPath}} 出技术方案', afterPick)
const caretState = await page.evaluate(() => {
  const area = document.querySelector('[data-workflow-field="prompt"] textarea')
  return { start: area.selectionStart, end: area.selectionEnd, focused: document.activeElement === area, len: area.value.length }
})
check(
  '插入后光标紧跟新 token（继续打字接在变量后面）',
  caretState.start === 3 + '{{prevSummary}}'.length && caretState.end === caretState.start,
  `caret=${caretState.start} len=${caretState.len}`,
)
check('插入后焦点回到指令框（Selection 先于 focus，视图不乱跳）', caretState.focused === true)

// 改动落在工作流数据里（不是只动了 textarea 的 DOM）：关面板 → 点别的节点 →
// 再点回来。模态框遮着画布，换节点必须先关（这正是模态框与常驻栏的行为差）。
// 换节点也得走编辑钮：点卡片本体只选中、不开面板。
await closePanel()
await openNodePanel('node:code')
const codePrompt = await promptText()
await closePanel()
await openNodePanel('node:plan')
check('改动落在工作流数据里（切走再切回仍在）', codePrompt !== afterPick && (await promptText()) === afterPick, `code=${codePrompt}`)

// 任务变量组在列表底部（虚拟滚动），滚到底再收一遍——菜单是唯一入口，漏项=用户插不进。
await openVarMenu()
await page.evaluate(() => {
  const holder = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder')
  if (holder) holder.scrollTop = holder.scrollHeight
})
await page.waitForTimeout(300)
const menuTail = await page.evaluate(() =>
  [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].map((o) => o.textContent),
)
check(
  '任务变量组吃 def.inputs（需求文档 {{docPath}}）',
  menuTail.some((s) => s === '需求文档 {{docPath}}'),
  menuTail.slice(-3).join(' | '),
)

// 菜单项是动作不是状态：选完再打开，控件上不残留上次的取值（Escape 只收下拉，
// 面板本身还在——它靠选中态活着）。
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
const selectState = await page.evaluate(() => {
  const el = document.querySelector('[data-workflow-node-panel] [data-workflow-var-insert]')
  return el ? (el.textContent ?? '') : null
})
check(
  '插入变量是动作（不把上次选项留成控件值）',
  selectState !== null && !selectState.includes('prevSummary') && selectState.includes('插入变量'),
  JSON.stringify(selectState),
)
check('收起变量菜单不影响面板（Escape 只关下拉）', await page.evaluate(() => document.querySelector('[data-workflow-node-panel]') !== null))

// 关闭 = 关闭：即时编辑早已落地，关掉不丢改动；画布仍是整行。
await closePanel()
check('点「关闭」后面板体从 DOM 退场', await page.evaluate(() => document.querySelector('[data-workflow-node-panel]') === null))
const boxClosed = await canvasBox()
check('关闭后画布仍是整行（没留下空栏）', !!boxClosed && near(boxClosed.w, boxClosed.contentW) && boxClosed.asides === 0, JSON.stringify(boxClosed))
await page.screenshot({ path: join(SHOTS, 'workflow-node-panel-closed.png') })
await openNodePanel('node:plan')
check('关闭不丢改动（再打开仍是插入后的指令）', (await promptText()) === afterPick, await promptText())

// 连线**不开**面板（user 2026-11-09「点击连接线不要弹模态框」）：选中一条线只是
// 选中，删它走 Delete 键（§11 用真按键钉）。三个观测点缺一不可——
// ① 没有面板体、也没有可见遮罩浮出；② 线自己拿到 .selected（高亮的前提，RF 的
//    EdgeWrapper 在用户 onClick 之前就 addSelectedEdges）；③ 计算出来的 stroke
//    就是 --pm-link（颜色焊在 --xy-edge-stroke-selected 上，且内联 strokeWidth
//    必须已撤，否则样式表永远赢不了它）。
await closePanel()
const linkColor = await page.evaluate(() => {
  const probe = document.createElement('span')
  probe.style.color = 'var(--pm-link)'
  document.body.appendChild(probe)
  const c = getComputedStyle(probe).color
  probe.remove()
  return c
})
const edgeHit = await edgeClickPoint('edge:plan|done|code')
if (edgeHit.point) {
  await page.mouse.click(edgeHit.point.x, edgeHit.point.y)
  await page.waitForTimeout(300)
}
const edgeAfterClick = await page.evaluate(() => {
  const wrap = document.querySelector('.react-flow__edge[data-id="edge:plan|done|code"]')
  const path = wrap?.querySelector('.react-flow__edge-path')
  return {
    panel: document.querySelector('[data-workflow-node-panel]') !== null,
    visibleModal: [...document.querySelectorAll('.ant-modal-wrap')].some((w) => getComputedStyle(w).display !== 'none'),
    selected: !!wrap && wrap.classList.contains('selected'),
    stroke: path ? getComputedStyle(path).stroke : null,
    width: path ? getComputedStyle(path).strokeWidth : null,
  }
})
check(
  '点连线不开属性面板（也没有遮罩浮出）',
  edgeHit.point !== null && !edgeAfterClick.panel && !edgeAfterClick.visibleModal,
  edgeHit.point === null ? `${edgeHit.reason}：${edgeHit.owners.slice(0, 8).join(' | ')}` : JSON.stringify(edgeAfterClick),
)
check('点中的连线拿到 selected 状态', edgeAfterClick.selected, JSON.stringify(edgeAfterClick))
check(
  '选中的连线是蓝色高亮（stroke = --pm-link）',
  edgeAfterClick.stroke === linkColor && edgeAfterClick.stroke !== 'none',
  `stroke=${edgeAfterClick.stroke} link=${linkColor}`,
)
check('选中态线宽 2px（内联 strokeWidth 已撤，样式表才赢）', edgeAfterClick.width === '2px', edgeAfterClick.width)
await page.screenshot({ path: join(SHOTS, 'workflow-edge-selected.png') })

// ══════════════════════════════════════════════════════════════════════════
// §8b · 结果状态可自定义，而它就是调度键（user 2026-11-09：「让用户自定义成功、
//       失败等结果状态，因为这会涉及到流程调度」）
//       三层必须同拍：面板里能改名/添加/删除；卡片上的出口线头与状态名跟着走；
//       改名**级联到出边**——只改节点自己的词汇表的话，线还指着旧状态，运行时
//       永远走不到那条分支（画布看着对、机器静默不触发，是最坏的一种绿）。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§8b · 结果状态自定义：改名级联连线 / 每状态一个出口 / 增删')
await closePanel()
await page.waitForTimeout(200)
await openNodePanel('node:plan')

// 每行有**两个** Input（状态名 + 状态定义，user 2026-11-09「定义结果状态时还需要
// 明确状态定义」），所以取值与填值都必须按锚点走：裸 `input` 会一次匹配到两个，
// fill 直接撞 Playwright 的 strict mode。
const verdictRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-workflow-node-panel] [data-workflow-verdict-row] [data-workflow-verdict-name]')].map((el) => el.value),
  )
const verdictDefRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-workflow-node-panel] [data-workflow-verdict-row] [data-workflow-verdict-def]')].map((el) => el.value),
  )
const verdictRowLabel = (i) => page.locator('[data-workflow-node-panel] [data-workflow-verdict-row]').nth(i)
const cardVerdictLabels = () =>
  page.evaluate(() => [...document.querySelectorAll('.react-flow__node[data-id="node:plan"] .wf-stage-verdict')].map((el) => el.textContent))

const rowsInit = await verdictRows()
check('面板里有结果状态编辑器（行 = 节点当前状态）', JSON.stringify(rowsInit) === JSON.stringify(['done']), JSON.stringify(rowsInit))
const defsInit = await verdictDefRows()
check('每行还有一个「状态定义」输入（默认空）', JSON.stringify(defsInit) === JSON.stringify(['']), JSON.stringify(defsInit))

// 单行几何 + 必填的可见面（user 2026-11-09「状态类型本身应该是简短的，状态定义是
// 必填的，表单放到同一行中」）：一状态一行 = 窄名字段 + 占满剩余宽度的定义 +
// 删除钮，三者同一条水平线。几何只有真渲染读得出来——源码里写 flex 也能被别的
// 样式挤成两行（旧的 `flexDirection: column` 就是这样，源码看着还挺整齐）。
const verdictGeom = await page.evaluate(() => {
  const row = document.querySelector('[data-workflow-node-panel] [data-workflow-verdict-row]')
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, right: r.right, w: r.width, cy: r.y + r.height / 2 }
  }
  const nameEl = row.querySelector('[data-workflow-verdict-name]')
  const defEl = row.querySelector('[data-workflow-verdict-def]')
  const delEl = row.querySelector('button[aria-label="删除状态"]')
  return {
    name: box(nameEl),
    def: box(defEl),
    del: box(delEl),
    placeholder: defEl.getAttribute('placeholder') ?? '',
    ariaRequired: defEl.getAttribute('aria-required'),
  }
})
const centers = [verdictGeom.name.cy, verdictGeom.def.cy, verdictGeom.del.cy]
check('三件控件在同一行（垂直中心差 ≤ 4px）', Math.max(...centers) - Math.min(...centers) <= 4, `centers=${centers.map((c) => c.toFixed(1)).join('/')}`)
check(
  '状态名是窄字段（≈104px），定义占满剩余宽度（> 名字两倍）',
  Math.abs(verdictGeom.name.w - 104) <= 2 && verdictGeom.def.w > verdictGeom.name.w * 2,
  `name=${verdictGeom.name.w.toFixed(1)} def=${verdictGeom.def.w.toFixed(1)}`,
)
check(
  '三者不重叠、删除钮在最右（名字 → 定义 → 删除）',
  verdictGeom.name.right <= verdictGeom.def.x + 0.5 && verdictGeom.def.right <= verdictGeom.del.x + 1 && verdictGeom.del.w > 8,
  `name.right=${verdictGeom.name.right.toFixed(1)} def=[${verdictGeom.def.x.toFixed(1)},${verdictGeom.def.right.toFixed(1)}] del.x=${verdictGeom.del.x.toFixed(1)}`,
)
check('定义占位文案写明必填、不再出现「可空」', verdictGeom.placeholder.includes('必填') && !verdictGeom.placeholder.includes('可空'), verdictGeom.placeholder)
check(
  '空定义当场红框 + aria-required（不必等到点保存才发现）',
  (await page.locator('[data-workflow-node-panel] [data-workflow-verdict-row] .ant-input-status-error').count()) === 1 && verdictGeom.ariaRequired === 'true',
  `errorInputs=${await page.locator('[data-workflow-node-panel] [data-workflow-verdict-row] .ant-input-status-error').count()} aria-required=${verdictGeom.ariaRequired}`,
)

// 先写定义、再改名：定义的键必须跟着状态名一起搬家（moveVerdictDef），
// 否则改名之后这条状态在环节指令里就丢了「什么时候该报它」。
await verdictRowLabel(0).locator('[data-workflow-verdict-def]').fill('全部产物齐备且校验通过')
await page.waitForTimeout(200)
check(
  '填了定义红框消失（同一个字段的必填态是实时的）',
  (await page.locator('[data-workflow-node-panel] [data-workflow-verdict-row] .ant-input-status-error').count()) === 0,
  `errorInputs=${await page.locator('[data-workflow-node-panel] [data-workflow-verdict-row] .ant-input-status-error').count()}`,
)

// 改名（一次 fill = 一次 onChange 的终值；逐键输入会中途触发多次级联，探针不必走那条）。
await verdictRowLabel(0).locator('[data-workflow-verdict-name]').fill('成功')
await page.waitForTimeout(250)
const rowsRenamed = await verdictRows()
check('改名落在行上', JSON.stringify(rowsRenamed) === JSON.stringify(['成功']), JSON.stringify(rowsRenamed))
check(
  '改名不丢定义（状态定义跟着键搬到新状态名下）',
  JSON.stringify(await verdictDefRows()) === JSON.stringify(['全部产物齐备且校验通过']),
  JSON.stringify(await verdictDefRows()),
)
const edgeIdsAfterRename = await page.evaluate(() => [...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('data-id')))
const planEdgeIds = edgeIdsAfterRename.filter((id) => (id ?? '').startsWith('edge:plan|'))
check(
  '改名级联到连线（plan 的出边变 edge:plan|成功|code，旧的 edge:plan|done|code 不再存在）',
  planEdgeIds.includes('edge:plan|成功|code') && !planEdgeIds.includes('edge:plan|done|code'),
  edgeIdsAfterRename.join(' , '),
)
check('单状态时卡片不画状态名（不需要标签行）', (await cardVerdictLabels()).length === 0)

await page.locator('[data-workflow-verdict-add]').click()
await page.waitForTimeout(250)
const rowsAdded = await verdictRows()
check('「添加状态」长出一行（默认 state<n>）', JSON.stringify(rowsAdded) === JSON.stringify(['成功', 'state2']), JSON.stringify(rowsAdded))
const srcsTwo = (await handlesOf('node:plan')).filter((h) => h.type === 'source')
check(
  '每个状态一根出口线头（out:成功 / out:state2，都在下缘并排且不重叠）',
  srcsTwo.length === 2 &&
    srcsTwo.some((h) => h.id === 'out:成功') &&
    srcsTwo.some((h) => h.id === 'out:state2') &&
    srcsTwo.every((h) => h.pos === 'bottom') &&
    Math.abs(srcsTwo[0].x - srcsTwo[1].x) > 20,
  srcsTwo.map((h) => `${h.id}@${h.pos} x=${h.x.toFixed(1)}`).join(' , '),
)
check(
  '卡片上的状态名与面板同源（成功 / state2）',
  JSON.stringify(await cardVerdictLabels()) === JSON.stringify(['成功', 'state2']),
  JSON.stringify(await cardVerdictLabels()),
)
// 卡面只有状态名，定义挂在悬停文案上（「什么时候报这个状态」是长文本，塞不进卡片）。
const planVerdictTitles = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node[data-id="node:plan"] .wf-stage-verdict')].map((el) => el.getAttribute('title')),
)
check(
  '卡面悬停文案带定义（有定义 → 「状态：定义」，没定义 → 只有状态名）',
  JSON.stringify(planVerdictTitles) === JSON.stringify(['成功：全部产物齐备且校验通过', 'state2']),
  JSON.stringify(planVerdictTitles),
)
// 定义存在节点 def 里（不是面板本地态）：关掉面板再打开必须还在。
await closePanel()
await openNodePanel('node:plan')
check(
  '关掉面板再打开，状态定义仍在',
  JSON.stringify(await verdictDefRows()) === JSON.stringify(['全部产物齐备且校验通过', '']),
  JSON.stringify(await verdictDefRows()),
)
await page.screenshot({ path: join(SHOTS, 'workflow-node-verdicts.png') })

// 删一个**没连线**的状态：不需要确认（确认弹窗只保护会连带删边的删除）。
await verdictRowLabel(1).locator('button[aria-label="删除状态"]').click()
await page.waitForTimeout(250)
check('删没连线的状态不用二次确认，直接落地', JSON.stringify(await verdictRows()) === JSON.stringify(['成功']), JSON.stringify(await verdictRows()))
check('确认弹窗没有浮出（无连线的状态删除是无损操作）', (await page.locator('.ant-modal-confirm').count()) === 0)
check('只剩一个状态时删除钮禁用（没有状态 = 没有出口）', await verdictRowLabel(0).locator('button[aria-label="删除状态"]').isDisabled())

// 删**有连线**的状态必须二次确认：验证的是「确认了才连带删边」这条不可逆语义。
// 换 node:code 走一遍——它的 done 状态上连着 code→DONE，且加一行之后删除钮可用
// （只剩一个状态时那颗钮是禁用的，画布不允许把出口删空）。
await closePanel()
await openNodePanel('node:code')
await page.locator('[data-workflow-verdict-add]').click()
await page.waitForTimeout(250)
check(
  'code 节点加一行后是两行（done / state2）',
  JSON.stringify(await verdictRows()) === JSON.stringify(['done', 'state2']),
  JSON.stringify(await verdictRows()),
)
await verdictRowLabel(0).locator('button[aria-label="删除状态"]').click()
await page.waitForSelector('.ant-modal-confirm')
const confirmText = (await page.locator('.ant-modal-confirm').innerText()).replace(/\s+/g, ' ')
check('删有连线的状态要先确认（文案点名状态与连线数）', confirmText.includes('done') && /1\s*条连线/.test(confirmText), confirmText.slice(0, 120))
await page.locator('.ant-modal-confirm-btns button').first().click()
await page.waitForTimeout(300)
check(
  '取消确认后状态与连线都还在（确认门真的拦住了）',
  JSON.stringify(await verdictRows()) === JSON.stringify(['done', 'state2']) &&
    (await page.locator('.react-flow__edge[data-id="edge:code|done|DONE"]').count()) === 1,
)
await closePanel()

// ══════════════════════════════════════════════════════════════════════════
// §9 · 无底色卡片 + 收起/展开 + 可拖动的分隔条（user 2026-11-09）
// ══════════════════════════════════════════════════════════════════════════
// 卡片配方是**视觉**事实（底色 / 描边 / 圆角），收起与拖动是**布局**事实
// （两栏宽度互换、夹取生效、几何不溢出），而「收起不拆装」是三者里最容易在
// 源码里看起来成立的：把卡节点卸掉也读不出区别，只有草稿文本与同一个 DOM
// 节点（expando）能说清。分隔条同理——它在不在、骑在哪、拖起来往哪边涨，
// 只有真鼠标与几何说得清。
console.log('\n§9 · 无底色卡片 / 收起展开 / 拖动分隔条')
await closePanel()
await page.waitForTimeout(250)

// Resolve a themed token to its computed colour so the assertions compare like
// with like (the border shorthand resolves through the same colour parser).
const readVar = (name) =>
  page.evaluate((n) => {
    const probe = document.createElement('div')
    probe.style.color = `var(${n})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, name)

const BG = await readVar('--pm-bg')
// --pm-fill stays only as a NEGATIVE control: the ruling was to stop painting
// the editor's columns with it, so its presence would be the regression.
const FILL = await readVar('--pm-fill')
const SEP = await readVar('--pm-separator-faint')

const shell0 = await page.evaluate(() => window.__assistShell())
check(
  '步骤卡与助手栏都是无底色的圆角矩形（不再是浅灰色面）',
  shell0.present && shell0.shellBg === BG && shell0.editorBg === BG && shell0.shellBg !== FILL,
  `assist=${shell0.shellBg} config=${shell0.editorBg} bg=${BG} fill=${FILL}`,
)
check('两栏圆角都是沉浸卡片的 8px', shell0.shellRadius === '8px' && shell0.editorRadius === '8px', `assist=${shell0.shellRadius} config=${shell0.editorRadius}`)
check(
  '两栏都只有 1px separator-faint 描边（无底色块的边界来源）',
  shell0.shellBorder === `1px solid ${SEP}` && shell0.editorBorder === `1px solid ${SEP}`,
  `assist=${shell0.shellBorder} config=${shell0.editorBorder} sep=${SEP}`,
)
check(
  '壳就是卡片本身：内容卡让出底色（没有变成双层白卡）',
  shell0.card === true && shell0.cardBg === 'rgba(0, 0, 0, 0)' && shell0.cardDisplay !== 'none',
  `bg=${shell0.cardBg} display=${shell0.cardDisplay}`,
)
check('展开态：窄条与展开钮都不在', shell0.rail === false && shell0.expandBtn === null && shell0.collapsed === 'false')
check('展开态：收起钮在（aria-label 指向收起）', (shell0.collapseBtn ?? '').includes('收起'), shell0.collapseBtn)
check('两栏间距仍是 12（卡片化没有挤开页面主行）', near(shell0.gap, 12), `gap=${shell0.gap?.toFixed(1)}`)
check(
  '两栏同高（并排一行，不是上下叠）',
  near(shell0.shellBox.height, shell0.editorBox.height),
  `h=${shell0.shellBox.height.toFixed(1)} vs ${shell0.editorBox.height.toFixed(1)}`,
)
check('页面没有横向溢出', shell0.pageScrollW <= shell0.viewportW, `scrollW=${shell0.pageScrollW} vw=${shell0.viewportW}`)

// ── 分隔条：位置与外观 ──
check('两栏之间有分隔条（展开态才在）', shell0.handle !== null, shell0.handle ? 'present' : 'MISSING')
check(
  '分隔条的命中面是 6px 的 col-resize 竖条',
  near(shell0.handle.width, 6) && shell0.handle.cursor === 'col-resize',
  `w=${shell0.handle.width?.toFixed(1)} cursor=${shell0.handle.cursor}`,
)
check(
  '分隔条骑在两栏间距的正中（卡片各自 overflow:hidden，它必须是兄弟）',
  near((shell0.handle.left + shell0.handle.right) / 2, shell0.editorBox.right + shell0.gap / 2),
  `handle@${((shell0.handle.left + shell0.handle.right) / 2).toFixed(1)} vs gap-centre ${(shell0.editorBox.right + shell0.gap / 2).toFixed(1)}`,
)
check(
  '分隔条纵贯两栏（上下与卡片齐平）',
  near(shell0.handle.top, shell0.shellBox.top) && near(shell0.handle.bottom, shell0.shellBox.bottom),
  `h ${shell0.handle.top.toFixed(1)}–${shell0.handle.bottom.toFixed(1)} vs card ${shell0.shellBox.top.toFixed(1)}–${shell0.shellBox.bottom.toFixed(1)}`,
)

// A draft typed but not sent is the thing a remount would silently swallow —
// so type one, collapse, and read it back after expanding.
await page.locator('[data-form-assist-card] textarea').first().fill('探针草稿·不要丢')
await page.evaluate(() => window.__stampCard())
const editorW0 = shell0.editorBox.width
const shellW0 = shell0.shellBox.width

await page.locator('[data-form-assist-collapse]').click()
await page.waitForFunction(() => document.querySelector('[data-form-assist-rail]') !== null)
await page.waitForTimeout(400) // 160ms 的 flex-basis 过渡 + 一帧余量

const shell1 = await page.evaluate(() => window.__assistShell())
check('收起后整栏缩成窄条（宽 44）', near(shell1.shellBox.width, 44), `w=${shell1.shellBox.width?.toFixed(1)}`)
check(
  '收起后步骤卡吃下腾出的宽度',
  near(shell1.editorBox.width - editorW0, shellW0 - shell1.shellBox.width),
  `${editorW0.toFixed(1)} → ${shell1.editorBox.width.toFixed(1)}（助手 ${shellW0.toFixed(1)} → ${shell1.shellBox.width.toFixed(1)}）`,
)
check('收起后仍是同一个根节点（壳没被换掉）', shell1.collapsed === 'true' && shell1.rail === true)
check(
  '收起后窄条也是同一套卡片配方（页面底色 + 1px 描边 + 8 圆角）',
  shell1.shellBg === BG && shell1.shellRadius === '8px' && shell1.shellBorder === `1px solid ${SEP}`,
  `bg=${shell1.shellBg} r=${shell1.shellRadius} b=${shell1.shellBorder}`,
)
check('收起后分隔条退场（窄条没有可拖的宽度）', shell1.handle === null, shell1.handle ? 'STILL THERE' : 'null')
check('窄条里有展开钮（aria-label 指向展开）', (shell1.expandBtn ?? '').includes('展开'), shell1.expandBtn)
check('窄条标题竖排且是当前栏名', shell1.railTitle === '任务助手' && shell1.railWriting === 'vertical-rl', `${shell1.railTitle} / ${shell1.railWriting}`)
check(
  '收起后内容卡只是隐藏、没有卸载（同一节点仍在）',
  shell1.card === true && shell1.cardDisplay === 'none' && shell1.cardStamped === true,
  `display=${shell1.cardDisplay} stamped=${shell1.cardStamped}`,
)
check('收起后草稿原样留在输入框里（布局变化不是拆装）', shell1.draft === '探针草稿·不要丢', shell1.draft)
check('收起后间距与溢出都还成立', near(shell1.gap, 12) && shell1.pageScrollW <= shell1.viewportW, `gap=${shell1.gap?.toFixed(1)}`)
await page.screenshot({ path: join(SHOTS, 'workflow-assist-collapsed.png') })

await page.locator('[data-form-assist-expand]').click()
await page.waitForFunction(() => document.querySelector('[data-form-assist-rail]') === null)
await page.waitForTimeout(400)

const shell2 = await page.evaluate(() => window.__assistShell())
check('展开后宽度回到收起前', near(shell2.shellBox.width, shellW0), `${shell2.shellBox.width?.toFixed(1)} vs ${shellW0.toFixed(1)}`)
check('展开后窄条退场、卡片复原（同一节点）', shell2.rail === false && shell2.cardDisplay !== 'none' && shell2.cardStamped === true)
check('展开后步骤卡宽度回到收起前', near(shell2.editorBox.width, editorW0), `${shell2.editorBox.width.toFixed(1)} vs ${editorW0.toFixed(1)}`)
check('展开后分隔条回来', shell2.handle !== null)
check('展开后草稿还在，且输入框可再次编辑', shell2.draft === '探针草稿·不要丢' && shell2.expandBtn === null, shell2.draft)
// Clear the draft so nothing downstream sees a stray typing state.
await page.locator('[data-form-assist-card] textarea').first().fill('')
await page.screenshot({ path: join(SHOTS, 'workflow-assist-expanded.png') })

// ── 拖动：真鼠标在分隔条上拖，界面必须跟着手的朝向涨缩 ──
// 助手栏右贴边，所以往**左**拖才该变宽（direction:-1，与侧边栏/树两个左对齐
// 列相反）——这一条源码里看只是一个减号，写反了界面反着涨。
const dragBy = async (from, dx) => {
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  await page.mouse.move(from.cx + dx, from.cy, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(120) // 松手后一帧（拖动期间过渡是关掉的）
  return page.evaluate(() => window.__assistShell())
}
const handleCentre = (shell) => ({ cx: (shell.handle.left + shell.handle.right) / 2, cy: (shell.handle.top + shell.handle.bottom) / 2 })

const GROW = 120
const drag1 = await dragBy(handleCentre(shell2), -GROW)
check(
  '往左拖 120px：助手栏变宽 120',
  near(drag1.shellBox.width - shell2.shellBox.width, GROW),
  `${shell2.shellBox.width.toFixed(1)} → ${drag1.shellBox.width.toFixed(1)}`,
)
check(
  '同时步骤卡收窄同样的 120（总宽守恒，不是两栏一起长）',
  near(shell2.editorBox.width - drag1.editorBox.width, GROW),
  `${shell2.editorBox.width.toFixed(1)} → ${drag1.editorBox.width.toFixed(1)}`,
)
check('拖动后间距与溢出都还成立', near(drag1.gap, 12) && drag1.pageScrollW <= drag1.viewportW, `gap=${drag1.gap?.toFixed(1)}`)
check(
  '拖动后分隔条跟到新的间距正中',
  near((drag1.handle.left + drag1.handle.right) / 2, drag1.editorBox.right + drag1.gap / 2),
  `handle@${((drag1.handle.left + drag1.handle.right) / 2).toFixed(1)} vs ${(drag1.editorBox.right + drag1.gap / 2).toFixed(1)}`,
)

// Now shove it far right: the clamp must stop at the assistant's floor (300)
// rather than letting the step card swallow the column whole.
const drag2 = await dragBy(handleCentre(drag1), 900)
check('往右猛拖：助手栏夹在下限 300', near(drag2.shellBox.width, 300), `w=${drag2.shellBox.width?.toFixed(1)}`)
check(
  '夹住之后步骤卡拿到剩下的全部宽度（助手栏没继续塌）',
  drag2.editorBox.width > drag1.editorBox.width && drag2.pageScrollW <= drag2.viewportW,
  `config ${drag1.editorBox.width.toFixed(1)} → ${drag2.editorBox.width.toFixed(1)}`,
)
await page.screenshot({ path: join(SHOTS, 'workflow-assist-dragged.png') })

// ══════════════════════════════════════════════════════════════════════════
// §10 · 连线路径是算出来的正交折线（user 2026-11-09）
// ══════════════════════════════════════════════════════════════════════════
// 单测证明的是 route.ts 这个纯函数；这里证明**画布上真正画出来的那段 d**：
// ① 每条 L 段都轴对齐（横平竖直），拐角是 Q 圆角且两端各落一轴；
// ② 路径采样点不落进任何一张卡的矩形（内缩 2px——端口本来就画在边界上）；
// ③ 对齐之后最短路径就是一条直线（长度 = 两端曼哈顿距离，拐点 0）；
// ④ 中间塞一张卡，路径必须改道（拐点 ≥ 4）且仍然不穿任何卡。
// d 是 world 空间坐标，采样点必须过 getScreenCTM 才是屏幕像素——直接和
// getBoundingClientRect 比会永远差一个视口变换（§7 已经踩过）。
console.log('\n§10 · 连线路径：横平竖直 / 不穿卡 / 拐点最少 / 真跟手')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="node:plan"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(500)

/** 每条渲染路径的几何体检。`d` 解析成 M/L/Q 序列逐段验，再沿路径每 3px 采样
 *  一次问「这一像素在哪张卡里面」。 */
const edgeGeometry = () =>
  page.evaluate(() => {
    const cards = [...document.querySelectorAll('.react-flow__node')].map((n) => {
      const r = n.getBoundingClientRect()
      return { id: n.getAttribute('data-id'), left: r.left + 2, top: r.top + 2, right: r.right - 2, bottom: r.bottom - 2 }
    })
    const AXIS = 0.51
    return [...document.querySelectorAll('.react-flow__edge')].map((edge) => {
      const id = edge.getAttribute('data-id')
      const path = edge.querySelector('.react-flow__edge-path')
      if (!path) return { id, missing: true, cards: cards.length }
      const d = path.getAttribute('d') ?? ''
      const tokens = d
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
      let cursor = null
      let first = null
      let axisOk = true
      let cornerOk = true
      let bends = 0
      let parse = true
      // 贝塞尔（C/S）出现 = 还在走 RF 的 smoothstep/bezier 生成器，路由根本没接上。
      const cubic = /[CS]/.test(d)
      for (let i = 0; i < tokens.length && parse && !cubic;) {
        const cmd = tokens[i]
        if (cmd === 'M' || cmd === 'L') {
          const p = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) }
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) axisOk = false
          else if (cursor && cmd === 'L' && Math.abs(p.x - cursor.x) > AXIS && Math.abs(p.y - cursor.y) > AXIS) axisOk = false
          if (cmd === 'M') first = p
          cursor = p
          i += 3
        } else if (cmd === 'Q') {
          const c = { x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) }
          const p = { x: Number(tokens[i + 3]), y: Number(tokens[i + 4]) }
          bends += 1
          if (cursor) {
            // 圆角：控制点与入点同轴、出点与控制点在**另一轴**上。
            const inX = Math.abs(c.x - cursor.x) <= AXIS
            const inY = Math.abs(c.y - cursor.y) <= AXIS
            const outX = Math.abs(p.x - c.x) <= AXIS
            const outY = Math.abs(p.y - c.y) <= AXIS
            if (!((inX && outY) || (inY && outX))) cornerOk = false
          }
          cursor = p
          i += 5
        } else {
          parse = false
        }
      }
      const total = path.getTotalLength()
      const m = path.getScreenCTM()
      const hits = []
      const xs = []
      const ys = []
      if (m && total > 0) {
        for (let at = 0; at <= total; at += 3) {
          const s = path.getPointAtLength(at).matrixTransform(m)
          xs.push(s.x)
          ys.push(s.y)
          for (const c of cards) {
            if (s.x > c.left && s.x < c.right && s.y > c.top && s.y < c.bottom) hits.push(`${c.id}@${((at / total) * 100).toFixed(0)}%`)
          }
        }
      }
      // 曼哈顿距离必须和 getTotalLength() **同一空间**（world）。屏幕像素里量出来
      // 的那份要乘视口缩放，画布 fitView 后缩放不是 1（实测 0.65），两个数直接比
      // 会得出「长度比曼哈顿距离还短」这种几何上不可能的结果。
      const manhattan = first && cursor ? Math.abs(cursor.x - first.x) + Math.abs(cursor.y - first.y) : 0
      return {
        id,
        d,
        bends,
        axisOk,
        cornerOk,
        cubic,
        parse,
        hits: hits.slice(0, 4),
        hitCount: hits.length,
        length: total,
        manhattan,
        ends: first && cursor ? { a: first, b: cursor } : null,
        bounds: xs.length ? { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) } : null,
        cards: cards.length,
      }
    })
  })

const geo0 = await edgeGeometry()
check(
  '§10 三条边都画出了渲染路径（派生 start-entry + plan→code + code→DONE）',
  geo0.length === 3 && geo0.every((g) => !g.missing && g.d.length > 0),
  geo0.map((g) => `${g.id}${g.missing ? '(missing)' : ''}`).join(' | '),
)
check(
  '§10 障碍集是完整的四张卡（2 任务卡 + 2 芯片）',
  geo0.every((g) => g.cards === 4),
  `cards=${geo0[0]?.cards}`,
)
check(
  '没有任何一条边还在用贝塞尔（d 里没有 C/S 指令）',
  geo0.every((g) => g.cubic === false),
  geo0
    .filter((g) => g.cubic)
    .map((g) => g.id)
    .join(',') || 'none',
)
check(
  '所有 L 段都是横平竖直（矩形指令只有 M/L/Q）',
  geo0.every((g) => g.parse && g.axisOk),
  geo0
    .filter((g) => !g.parse || !g.axisOk)
    .map((g) => `${g.id}:${g.d.slice(0, 80)}`)
    .join(' | ') || 'all aligned',
)
check(
  '每个拐角都是圆角 Q，且两端各落一轴（不是随手糊的曲线）',
  geo0.every((g) => g.cornerOk),
  geo0
    .filter((g) => !g.cornerOk)
    .map((g) => g.id)
    .join(',') || 'ok',
)
check(
  '没有任何一条边穿过卡片（沿路径每 3px 采样，零命中）',
  geo0.every((g) => g.hitCount === 0),
  geo0
    .filter((g) => g.hitCount > 0)
    .map((g) => `${g.id}→${g.hits.join(',')}`)
    .join(' | ') || 'clean',
)
const sideEntry = geo0.find((g) => g.id === 'edge:plan|done|code')
check(
  '侧入边（底出 → 左边进）至少两个直角（几何上不可能是直线）',
  !!sideEntry && sideEntry.bends >= 2,
  sideEntry ? `bends=${sideEntry.bends} len=${sideEntry.length.toFixed(1)}` : 'null',
)

// ── 拖到 plan 正下方：竖着够近时最短路径就是一条竖线（长度 = 曼哈顿距离）──
// 鼠标落点只能到「几像素内」：一次大位移会带起视口自动平移（落点靠近画布下缘），
// 松手后残留 2~3px 的偏心；再接一次小位移的微调反而更糟——小位移会被判成点击、
// 而自动平移继续把卡往下推（实测 5 轮微调把 code 推到 y=845、x 一格没动）。
// 所以这里不追像素级对齐：真正的判据写在 **flow 坐标** 与路径本身里——偏心只有
// 几像素时，最短的正交走法就是「两拐点的 Z」（长度仍等于曼哈顿距离），真对齐
// （零拐点）的那一档由 `tests/workflow-routing` 的「同列上下对齐」钉住。
const planBox10 = await centerOf('.react-flow__node[data-id="node:plan"]')
const codeBox10 = await centerOf('.react-flow__node[data-id="node:code"]')
check('§10 拖动前两张卡都在', !!planBox10 && !!codeBox10)
if (planBox10 && codeBox10) await dragBetween({ x: codeBox10.x, y: codeBox10.y }, { x: planBox10.x, y: planBox10.bottom + 300 })
await page.waitForTimeout(350)

const flowBox = () =>
  page.evaluate(() => {
    const read = (id) => {
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el?.style.transform ?? '')
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null
    }
    return { plan: read('node:plan'), code: read('node:code') }
  })
const flow = await flowBox()
const planFinal = await centerOf('.react-flow__node[data-id="node:plan"]')
const codeAligned = await centerOf('.react-flow__node[data-id="node:code"]')
const flowDx = flow.plan && flow.code ? flow.code.x - flow.plan.x : NaN
check(
  '§10 落位成功：code 落到 plan 正下方（同列，卡间留出塞卡净空）',
  Math.abs(flowDx) <= 4 && !!codeAligned && !!planFinal && codeAligned.top - planFinal.bottom > 140,
  `flowDx=${flowDx} gap=${codeAligned && planFinal ? (codeAligned.top - planFinal.bottom).toFixed(1) : '?'}`,
)

const straight = (await edgeGeometry()).find((g) => g.id === 'edge:plan|done|code')
check(
  '小偏心下仍是最短：拐点 ≤ 2，长度 = 两端曼哈顿距离（没有任何绕路）',
  !!straight && straight.axisOk && straight.bends <= 2 && Math.abs(straight.length - straight.manhattan) <= 4,
  straight ? `bends=${straight.bends} len=${straight.length.toFixed(1)} manhattan=${straight.manhattan.toFixed(1)}` : 'null',
)
const axisX = planFinal ? planFinal.x : 0
check(
  '这条线真的走在两卡中轴上（没有绕出一条细长回廊）',
  !!straight && !!straight.bounds && Math.abs(straight.bounds.xMin - axisX) <= 30 && Math.abs(straight.bounds.xMax - axisX) <= 30,
  straight?.bounds ? `x∈[${straight.bounds.xMin.toFixed(1)},${straight.bounds.xMax.toFixed(1)}] 轴=${axisX.toFixed(1)}` : 'null',
)

// ── 中间塞一张卡：必须改道，且仍然不穿任何一张卡 ──
await page.locator('[data-dock-action="add"]').click()
await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length > 4)
await page.waitForTimeout(250)
await closeNodePanel()
const blockerCard = await centerOf('.react-flow__node[data-id="node:step3"]')
const gapMid = codeAligned && planFinal ? (planFinal.bottom + codeAligned.top) / 2 : 0
check('§10 悬浮窗「添加」产出了 step3（用作路障）', !!blockerCard && gapMid > 0, `gapMid=${gapMid.toFixed(1)}`)
if (blockerCard && codeAligned && planFinal) await dragBetween({ x: blockerCard.x, y: blockerCard.y }, { x: planFinal.x, y: gapMid })
await page.waitForTimeout(350)

const geoBlocked = await edgeGeometry()
const detour = geoBlocked.find((g) => g.id === 'edge:plan|done|code')
check(
  '正中间被卡片挡住：连线改道绕过（拐点 ≥ 4，不再是那条直线）',
  !!detour && detour.bends >= 4,
  detour ? `bends=${detour.bends} len=${detour.length.toFixed(1)}` : 'null',
)
check(
  '改道之后仍然不穿任何一张卡（含新塞的这张）',
  geoBlocked.every((g) => g.hitCount === 0),
  geoBlocked
    .filter((g) => g.hitCount > 0)
    .map((g) => `${g.id}→${g.hits.join(',')}`)
    .join(' | ') || 'clean',
)
check(
  '改道之后每条边仍是横平竖直的圆角折线',
  geoBlocked.every((g) => !g.missing && g.parse && g.axisOk && g.cornerOk && !g.cubic),
  geoBlocked
    .filter((g) => !g.parse || !g.axisOk || !g.cornerOk || g.cubic)
    .map((g) => g.id)
    .join(',') || 'all ortho',
)
await page.screenshot({ path: join(SHOTS, 'workflow-edge-routing.png') })

// ══════════════════════════════════════════════════════════════════════════
// §11 · Delete 键删选中的线/节点（user 2026-11-09：「选中线和节点，都可以通过
//       delete键删除」）
//       必须是真按键：键删走 document 级 keydown + 选中快照 + def 的写回调，
//       三样都不在渲染结果里，只有真按一次才看得见。放在最后是因为它会真的删
//       东西（§10 还在数边和卡）。
// ══════════════════════════════════════════════════════════════════════════
console.log('\n§11 · Delete 键：选中即删（线 / 节点），面板开着时不误删')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="node:plan"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(500)

const nodes11 = await page.locator('.react-flow__node').count()
const edges11 = await edgeIds()
check(
  '§11 起点是干净的夹具（4 节点，含 plan→code→DONE 两条主线）',
  nodes11 === 4 && edges11.includes('edge:plan|done|code'),
  `nodes=${nodes11} edges=${edges11.join(',')}`,
)

// ── 线：点中 → selected → Delete → 这条边从 DOM 退场，卡一张不少 ──
const delHit = await edgeClickPoint('edge:plan|done|code')
if (delHit.point) {
  await page.mouse.click(delHit.point.x, delHit.point.y)
  await page.waitForTimeout(250)
}
const beforeDel = await page.evaluate(() => ({
  selected: !!document.querySelector('.react-flow__edge[data-id="edge:plan|done|code"].selected'),
  panel: document.querySelector('[data-workflow-node-panel]') !== null,
}))
check(
  '删前：这条线已被选中且没开面板',
  delHit.point !== null && beforeDel.selected && !beforeDel.panel,
  delHit.point === null ? delHit.reason : JSON.stringify(beforeDel),
)
// 焦点必须在非输入元素上：点画布空白会顺手清掉选中，所以只让 body 拿焦点
// （点线之后 focus 本来就不在 input 上，这里显式兜一道，别让上一步的面板残留）。
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const afterDel = await page.evaluate(() => ({
  edges: [...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('data-id')),
  nodes: document.querySelectorAll('.react-flow__node').length,
}))
check(
  'Delete 删掉了选中的线（边退场，卡一张没少）',
  !afterDel.edges.includes('edge:plan|done|code') && afterDel.nodes === nodes11,
  `edges=${afterDel.edges.join(',')} nodes=${afterDel.nodes}`,
)
check(
  '连带删掉的只有这一条（其余边仍在：start-entry + code→DONE）',
  afterDel.edges.length === edges11.length - 1 && afterDel.edges.includes('edge:code|done|DONE'),
  afterDel.edges.join(','),
)
await page.screenshot({ path: join(SHOTS, 'workflow-edge-deleted.png') })

// ── 节点：点卡本体 → selected → Delete → 卡与它的出边一起退场 ──
// 点卡本体不开面板（编辑钮才开），所以这里点中心不会先浮出模态框。
const codeCard11 = await centerOf('.react-flow__node[data-id="node:code"]')
check('§11 第二段起点：code 卡还在（上一段只删了线）', !!codeCard11, `box=${codeCard11 ? 'ok' : 'null'}`)
if (codeCard11) {
  await page.mouse.click(codeCard11.x, codeCard11.y)
  await page.waitForTimeout(250)
}
const beforeNodeDel = await page.evaluate(() => ({
  selected: !!document.querySelector('.react-flow__node[data-id="node:code"].selected'),
  panel: document.querySelector('[data-workflow-node-panel]') !== null,
}))
check('点卡本体只选中、不开面板', beforeNodeDel.selected && !beforeNodeDel.panel, JSON.stringify(beforeNodeDel))
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const afterNodeDel = await page.evaluate(() => ({
  nodes: [...document.querySelectorAll('.react-flow__node')].map((n) => n.getAttribute('data-id')),
  edges: [...document.querySelectorAll('.react-flow__edge')].map((e) => e.getAttribute('data-id')),
}))
check('Delete 删掉了选中的节点', !afterNodeDel.nodes.includes('node:code') && afterNodeDel.nodes.length === nodes11 - 1, afterNodeDel.nodes.join(','))
check(
  '删节点连带删它的边（code→DONE 跟着走，plan 侧不动）',
  !afterNodeDel.edges.some((e) => e.includes('|code|') || e.startsWith('edge:code')),
  afterNodeDel.edges.join(','),
)

// ── 面板开着时 Delete 不能动画布（在属性面板里敲删除是撤字，不是拆图） ──
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await openNodePanel('node:plan')
await page.waitForTimeout(300)
const nodesBeforeGuard = await page.locator('.react-flow__node').count()
await page.keyboard.press('Delete')
await page.waitForTimeout(300)
const afterGuard = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.react-flow__node').length,
  panel: document.querySelector('[data-workflow-node-panel]') !== null,
}))
check(
  '属性面板开着时 Delete 不删东西（面板在、节点数不变）',
  afterGuard.panel && afterGuard.nodes === nodesBeforeGuard,
  `nodes=${afterGuard.nodes}/${nodesBeforeGuard} panel=${afterGuard.panel}`,
)
await closeNodePanel()

// ══════════════════════════════════════════════════════════════════════════
// §12 · 基本信息步的任务类型：编辑态置灰可见、新建态可选（同一个单选组）
// ══════════════════════════════════════════════════════════════════════════
// 报告：「如果对存量任务进行编辑，在【基本信息】页签中现在看不到任务类型」；
// 随后裁定「期望就是用单选框」——编辑态也是单选框，只是 disabled（看得到、点不动）。
// 旧门 `!updateId && !wfUpdateId` 让整块消失；中间那版只读 chip 已被推翻。
console.log('\n§12 · 基本信息步：存量任务的类型可见但不可改')
const kindRow = () => page.evaluate(() => window.__kindRow())

// ── routine 编辑态 ──
await page.evaluate(() => window.__mount({ kind: 'routine', routineId: 'r_demo', workflowId: null }))
await page.waitForSelector('[data-pm-form-assist]')
await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '每日巡检'))
let kr = await kindRow()
check('routine 编辑态：任务类型标签在且唯一', kr.labelCount === 1 && kr.labelShown, `labels=${kr.labelCount} shown=${kr.labelShown}`)
check(
  'routine 编辑态：就是两项单选、预选「对话式任务」',
  kr.anchor && kr.groups === 1 && kr.radios === 2 && kr.checked[0] === true && kr.checkedLabel === '对话式任务',
  `anchor=${kr.anchor} groups=${kr.groups} radios=${kr.radios} checked=${JSON.stringify(kr.checked)} label=${JSON.stringify(kr.checkedLabel)}`,
)
check(
  'routine 编辑态：两个选项都 disabled（看得到、点不动）',
  kr.disabled.length === 2 && kr.disabled.every(Boolean),
  `disabled=${JSON.stringify(kr.disabled)}`,
)
check('routine 编辑态：没有残留的只读 chip 文案', typeof kr.text === 'string' && !kr.text.includes('创建后不可修改'), `text=${JSON.stringify(kr.text)}`)
// 真点击第二个选项（工作流）：disabled 的单选框选了也白选——值不变
const wfOptionBox = await page.locator('.ant-radio-group .ant-radio-wrapper').nth(1).boundingBox()
await page.mouse.click(wfOptionBox.x + wfOptionBox.width / 2, wfOptionBox.y + wfOptionBox.height / 2)
await page.waitForTimeout(200)
const krClick = await kindRow()
check(
  'routine 编辑态：真点另一项不换类型（仍在对话式任务、两项仍 disabled）',
  krClick.checked[0] === true && krClick.checkedLabel === '对话式任务' && krClick.disabled.every(Boolean),
  `checked=${JSON.stringify(krClick.checked)} label=${JSON.stringify(krClick.checkedLabel)}`,
)
await page.screenshot({ path: join(SHOTS, '12-routine-edit-kind.png') })

// ── workflow 编辑态：同一组控件的另一半（值必须跟着这条任务走）──
await mountWorkflow()
kr = await kindRow()
check(
  'workflow 编辑态：预选「工作流」，不是对话式任务',
  kr.checked[1] === true && kr.checkedLabel === '工作流',
  `checked=${JSON.stringify(kr.checked)} label=${JSON.stringify(kr.checkedLabel)}`,
)
check(
  'workflow 编辑态：同样是两项单选、都 disabled、标签唯一',
  kr.labelCount === 1 && kr.groups === 1 && kr.radios === 2 && kr.disabled.every(Boolean),
  `labels=${kr.labelCount} groups=${kr.groups} radios=${kr.radios} disabled=${JSON.stringify(kr.disabled)}`,
)
await page.screenshot({ path: join(SHOTS, '12-workflow-edit-kind.png') })

// ── 新建态对照：同一组控件，可点 ──
await page.evaluate(() => window.__mount({ kind: 'workflow', workflowId: null }))
await page.waitForSelector('.ant-radio-group input[type=radio]')
kr = await kindRow()
check(
  '新建态：同一份单选中 workflow 预选、且两项都可操作',
  kr.groups === 1 && kr.radios === 2 && kr.checked[1] === true && kr.disabled.every((d) => d === false),
  `groups=${kr.groups} radios=${kr.radios} checked=${JSON.stringify(kr.checked)} disabled=${JSON.stringify(kr.disabled)}`,
)
check('新建态：两个选项文案齐全', kr.radioLabels.join('|') === '对话式任务|工作流', `labels=${JSON.stringify(kr.radioLabels)}`)
// 真点击第一项 → 真的切了（对照编辑态那条「白选」）
await page.locator('.ant-radio-group .ant-radio-wrapper').nth(0).click()
await page.waitForTimeout(200)
const krSwitched = await kindRow()
check(
  '新建态：真点第一项就换成「对话式任务」（可切是新建态的本质）',
  krSwitched.checked[0] === true && krSwitched.checkedLabel === '对话式任务',
  `checked=${JSON.stringify(krSwitched.checked)} label=${JSON.stringify(krSwitched.checkedLabel)}`,
)

await page.evaluate(() => window.__mount({ kind: 'routine', workflowId: null, routineId: null }))
await page.waitForSelector('[data-pm-form-assist]')
await page.waitForSelector('.ant-radio-group input[type=radio]')
kr = await kindRow()
check(
  '新建态 routine 臂：同一份单选预选第一项、可操作',
  kr.radios === 2 && kr.checked[0] === true && kr.disabled.every((d) => d === false),
  `radios=${kr.radios} checked=${JSON.stringify(kr.checked)} disabled=${JSON.stringify(kr.disabled)}`,
)

// ══════════════════════════════════════════════════════════════════════════
// §13 · 读图语言：终态配色 / 聚焦淡化 / 结果状态标签悬停才显
// ══════════════════════════════════════════════════════════════════════════
// 报告的原始痛点「连接线会有很多交叉」。重心排序（shared/workflow/layout.ts 的
// orderLayer）把交叉数压下去只是前半刀——真挤在一起的图还得靠**读图语言**：
// ① 通往 DONE 的边是成功绿（结果状态是用户自定义字符串，只有保留目标有语义）；
// ② 选中谁就只看谁（选中节点留它的邻边、选中连线只留那一条，其余降到 15%）；
// ③ 多状态节点的状态词静止时藏起来，悬停/选中才现形。
//
// 三条全在渲染面上，源码扫描（tests/workflow-canvas）只能证明规则写进了样式表
// ——opacity / stroke / 悬停显形只有真渲染读 computed style 才算数，而 CSS 的
// 层叠（RF 自己的 .selected 规则 vs 我们的变量覆盖）恰恰是这类改动最容易翻车的
// 地方（多打一个 !important 就把选中蓝顶掉了，单测看不见）。
console.log('\n§13 · 读图语言：终态配色 / 聚焦淡化 / 标签悬停才显')
await mountWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="terminal:DONE"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)

/** 一条边的三件读数：<g> 自身透明度（聚焦淡化落在它身上）、描边色（上色
 *  落在 <path> 上，颜色经 --xy-edge-stroke 变量传下去）、标签包裹层透明度
 *  （RF 的 EdgeText 用它做静止隐藏）。没有标签时 label=null——那正是「单状态
 *  节点的出边不挂状态词」的样子。 */
const edgeStyle = (id) =>
  page.evaluate((eid) => {
    const g = document.querySelector(`.react-flow__edge[data-id="${eid}"]`)
    if (!g) return null
    const path = g.querySelector('.react-flow__edge-path')
    const wrap = g.querySelector('.react-flow__edge-textwrapper')
    return {
      gOpacity: getComputedStyle(g).opacity,
      stroke: path ? getComputedStyle(path).stroke : null,
      label: wrap ? getComputedStyle(wrap).opacity : null,
      labelText: wrap ? (wrap.textContent ?? '').trim() : null,
      selected: g.classList.contains('selected'),
    }
  }, id)
/** 所有节点的渲染透明度（选连线时无关节点压到一半，选节点时不压）。 */
const nodeOpacities = () =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('.react-flow__node')].map((n) => [n.getAttribute('data-id'), getComputedStyle(n).opacity])),
  )
/** 画布上一块**真空地**：逐个候选点问 elementFromPoint，只认最上层确实落在
 *  .react-flow__pane 上的那种（四角会撞上缩放条/小地图，左缘中段有添加浮窗）。
 *  点空白 = RF 清掉全部选中，这是「回到静止态」的唯一无副作用手段。 */
const emptyPanePoint = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')
    if (!pane) return null
    const r = pane.getBoundingClientRect()
    const cands = [
      [r.left + 200, r.top + 24],
      [r.right - 200, r.top + 24],
      [r.left + 200, r.bottom - 24],
      [r.right - 200, r.bottom - 24],
      [r.left + r.width / 2, r.top + 24],
    ]
    for (const [x, y] of cands) {
      const hit = document.elementFromPoint(x, y)
      if (!hit?.closest?.('.react-flow__pane')) continue
      if (hit.closest('.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, [data-dock-action]')) continue
      return { x, y }
    }
    return null
  })

const EDGE_START13 = 'start-entry'
const EDGE_MID13 = 'edge:plan|done|code'
const EDGE_DONE13 = 'edge:code|done|DONE'
const ids13 = await edgeIds()
check(
  '§13 起点：夹具的三条边都在（开始→plan / plan→code / code→DONE）',
  [EDGE_START13, EDGE_MID13, EDGE_DONE13].every((id) => ids13.includes(id)),
  ids13.join(' | '),
)

// ── ① 静止态：不淡化、终态上色、无标签 ──
const rest13 = { mid: await edgeStyle(EDGE_MID13), done: await edgeStyle(EDGE_DONE13), start: await edgeStyle(EDGE_START13) }
check(
  '静止：没有选中态就一条都不淡化（三条边 <g> opacity 全是 1）',
  [rest13.mid, rest13.done, rest13.start].every((s) => s && s.gOpacity === '1'),
  JSON.stringify(rest13),
)
const SUCCESS13 = await readVar('--pm-success')
const ERROR13 = await readVar('--pm-error')
check('终态配色：通往 DONE 的边是成功色（stroke = --pm-success）', rest13.done?.stroke === SUCCESS13, `stroke=${rest13.done?.stroke} success=${SUCCESS13}`)
check(
  '终态配色只给终态：任务→任务的边仍是默认灰（既不是成功色也不是错误色）',
  !!rest13.mid && rest13.mid.stroke !== SUCCESS13 && rest13.mid.stroke !== ERROR13,
  `stroke=${rest13.mid?.stroke} success=${SUCCESS13} error=${ERROR13}`,
)
check(
  '单状态节点的出边不挂状态词（没有 EdgeText 包裹层）',
  rest13.mid?.label === null && rest13.done?.label === null,
  `mid=${String(rest13.mid?.label)} done=${String(rest13.done?.label)}`,
)

// ── ② 给 plan 加第二个状态：多状态节点的每条出边都带状态词，但静止时隐藏 ──
// 状态词是「糊成一片」的主因，而卡内的 .wf-stage-verdicts 行已经把状态名与出口
// 线头逐列对齐了——静止隐藏不是丢信息，是把信息交给悬停。
await openNodePanel('node:plan')
await page.locator('[data-workflow-verdict-add]').click()
await page.waitForTimeout(250)
await closeNodePanel()
const panePoint13 = await emptyPanePoint()
if (panePoint13) await page.mouse.click(panePoint13.x, panePoint13.y)
await page.waitForTimeout(400)
const labelled13 = await edgeStyle(EDGE_MID13)
check(
  '多状态节点的出边带上状态词，静止时隐藏（textwrapper opacity = 0）',
  labelled13?.labelText === 'done' && labelled13?.label === '0',
  JSON.stringify(labelled13),
)
// 卡上的状态名（user 2026-11-09 复审把对象点名了：「我指的是节点上的文字」——
// 就是卡片底部那行 .wf-stage-verdict，不是连线标签）。它必须**逐个落在自己那根
// 出口线头的正上方且紧贴圆点**：旧版是均分内容盒的 grid，扣掉卡片左右 padding
// 与列 gap 后横向偏几像素；纵向文字底边离卡缘 6(margin)+14(padding)=20px，圆点
// 就在卡缘上，读起来文字飘在端口上方一大截。
const cardLabels13 = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node[data-id="node:plan"]')
  if (!node) return null
  let scale = 1
  try {
    const vp = document.querySelector('.react-flow__viewport')
    const m = vp ? new DOMMatrixReadOnly(getComputedStyle(vp).transform) : null
    if (m && (m.a || m.b)) scale = Math.hypot(m.a, m.b) || 1
  } catch {
    scale = 1
  }
  return {
    scale,
    labels: [...node.querySelectorAll('.wf-stage-verdict')].map((el) => {
      const text = (el.textContent ?? '').trim()
      const h = node.querySelector(`.react-flow__handle[data-handleid="out:${CSS.escape(text)}"]`)
      if (!h) return { text, dx: null, gap: null }
      const a = el.getBoundingClientRect()
      const b = h.getBoundingClientRect()
      return {
        text,
        // 横向：两个盒子的水平中心之差（每一条都该在 1 屏幕 px 内对上自己那根线头）
        dx: a.left + a.width / 2 - (b.left + b.width / 2),
        // 纵向：文字底边到圆点**上缘**的净空，折回世界 px（负数 = 文字压住圆点）
        gap: (b.top - a.bottom) / scale,
      }
    }),
  }
})
check(
  '卡上状态名逐根对齐出口线头且紧贴圆点（|dx| ≤ 1.5px、净空 0~5 世界px）',
  !!cardLabels13 && cardLabels13.labels.length === 2 && cardLabels13.labels.every((l) => l.dx !== null && Math.abs(l.dx) <= 1.5 && l.gap >= 0 && l.gap <= 5),
  cardLabels13 ? cardLabels13.labels.map((l) => `${l.text}:dx=${l.dx?.toFixed(2)} gap=${l.gap?.toFixed(2)}`).join(' ') : '节点缺失',
)
// 状态词的位置（user 2026-11-09「自定义的输出结果状态文字，距离连接端点太远了」）：
// 标签锚点是**出口端口外一小段**，不是最长段的中点——多分支图上最长段往往在画布
// 另一头，文字会离它描述的那个出口上百像素。这里量屏幕距离，判据放宽到 40px。
const labelNear13 = await page.evaluate((id) => {
  const wrap = document.querySelector(`.react-flow__edge[data-id="${id}"] .react-flow__edge-textwrapper`)
  const handle = document.querySelector('.react-flow__node[data-id="node:plan"] .react-flow__handle[data-handleid="out:done"]')
  if (!wrap || !handle) return null
  const a = wrap.getBoundingClientRect()
  const b = handle.getBoundingClientRect()
  const dx = a.left + a.width / 2 - (b.left + b.width / 2)
  const dy = a.top + a.height / 2 - (b.top + b.height / 2)
  return { dx, dy, dist: Math.hypot(dx, dy) }
}, EDGE_MID13)
check(
  '状态词贴在出口端口旁（≤ 40px），不再挂到画布中间',
  !!labelNear13 && labelNear13.dist <= 40,
  labelNear13 ? `dist=${labelNear13.dist.toFixed(1)} dx=${labelNear13.dx.toFixed(1)} dy=${labelNear13.dy.toFixed(1)}` : '标签或线头缺失',
)

// ── ③ 悬停才现形（真鼠标停在渲染路径的像素上，不是 locator.hover 的 bbox 中心）──
const hoverHit13 = await edgeClickPoint(EDGE_MID13)
if (hoverHit13.point) await page.mouse.move(hoverHit13.point.x, hoverHit13.point.y)
await page.waitForTimeout(350)
const hovered13 = await edgeStyle(EDGE_MID13)
check(
  '悬停这条边：状态词现形（opacity = 1）',
  hoverHit13.point !== null && hovered13?.label === '1',
  hoverHit13.point === null ? hoverHit13.reason : `label=${hovered13?.label}`,
)
await page.mouse.move(6, 6)
await page.waitForTimeout(350)
const away13 = await edgeStyle(EDGE_MID13)
check('鼠标移开：状态词重新藏回去（0，悬停不是粘住）', away13?.label === '0', `label=${away13?.label}`)

// ── ④ 选中节点：只看与它相连的线，其它线降到 15%；节点一个都不压 ──
const planCard13 = await centerOf('.react-flow__node[data-id="node:plan"]')
if (planCard13) await page.mouse.click(planCard13.x, planCard13.y)
await page.waitForTimeout(400)
const selNode13 = { mid: await edgeStyle(EDGE_MID13), done: await edgeStyle(EDGE_DONE13), start: await edgeStyle(EDGE_START13) }
check('选中节点：无关的线（code→DONE）降到 15%', selNode13.done?.gOpacity === '0.15', `done=${selNode13.done?.gOpacity}`)
check(
  '选中节点：与它相连的两条线保持满亮度（开始→plan、plan→code）',
  selNode13.mid?.gOpacity === '1' && selNode13.start?.gOpacity === '1',
  `mid=${selNode13.mid?.gOpacity} start=${selNode13.start?.gOpacity}`,
)
const nodesWithSel13 = await nodeOpacities()
check(
  '选中节点时不压暗别的节点（它们正是这条线的上下文）',
  Object.values(nodesWithSel13).every((o) => o === '1'),
  JSON.stringify(nodesWithSel13),
)

// ── ⑤ 选中连线：只留那一条 + 两个端点，其余线与节点一起退后 ──
const doneHit13 = await edgeClickPoint(EDGE_DONE13)
if (doneHit13.point) await page.mouse.click(doneHit13.point.x, doneHit13.point.y)
await page.waitForTimeout(400)
const selEdge13 = { mid: await edgeStyle(EDGE_MID13), done: await edgeStyle(EDGE_DONE13), start: await edgeStyle(EDGE_START13) }
check(
  '选中连线：这条线拿到 selected 且保持满亮度',
  doneHit13.point !== null && selEdge13.done?.selected === true && selEdge13.done?.gOpacity === '1',
  doneHit13.point === null ? doneHit13.reason : JSON.stringify(selEdge13.done),
)
check(
  '选中连线：其余两条线降到 15%',
  selEdge13.mid?.gOpacity === '0.15' && selEdge13.start?.gOpacity === '0.15',
  `mid=${selEdge13.mid?.gOpacity} start=${selEdge13.start?.gOpacity}`,
)
check('选中连线不开属性面板（聚焦淡化不该顺手弹模态框）', await page.evaluate(() => document.querySelector('[data-workflow-node-panel]') === null))
const nodesWithEdge13 = await nodeOpacities()
check(
  '选中连线：两个端点保持、无关节点压到一半',
  nodesWithEdge13['node:code'] === '1' &&
    nodesWithEdge13['terminal:DONE'] === '1' &&
    nodesWithEdge13['node:plan'] === '0.5' &&
    nodesWithEdge13['terminal:START'] === '0.5',
  JSON.stringify(nodesWithEdge13),
)
await page.screenshot({ path: join(SHOTS, '13-read-language.png') })

// ── ⑥ 点空白回到静止态：透明度全复原，DONE 的边重新是成功绿（选中蓝没把变量
//      覆盖吃掉——反过来验 --xy-edge-stroke 是「临时让位」而不是永久覆盖）──
if (panePoint13) await page.mouse.click(panePoint13.x, panePoint13.y)
await page.waitForTimeout(400)
const back13 = { mid: await edgeStyle(EDGE_MID13), done: await edgeStyle(EDGE_DONE13), start: await edgeStyle(EDGE_START13) }
const backNodes13 = await nodeOpacities()
check(
  '点空白清选中：三条线与四个节点的透明度全部复原',
  [back13.mid, back13.done, back13.start].every((s) => s && s.gOpacity === '1') && Object.values(backNodes13).every((o) => o === '1'),
  `edges=${[back13.mid, back13.done, back13.start].map((s) => s?.gOpacity).join('/')} nodes=${JSON.stringify(backNodes13)}`,
)
check(
  '取消选中后 DONE 的边回到成功色（选中蓝只是临时让位，不是覆盖）',
  back13.done?.stroke === SUCCESS13 && back13.done?.selected === false,
  `stroke=${back13.done?.stroke} success=${SUCCESS13}`,
)
check('回到静止后状态词重新隐藏（不残留上一次悬停/选中的显形）', back13.mid?.label === '0', `label=${back13.mid?.label}`)
await page.screenshot({ path: join(SHOTS, '13-read-language-rest.png') })

// ══════════════════════════════════════════════════════════════════════════
// §14 · 冲突触发换侧：左进会压住另一条线，就改从右侧绕（user 2026-11-09）
// ══════════════════════════════════════════════════════════════════════════
// 这一段证明的是**算法在真画布上真的换了侧**，不是「换侧代码存在」：
// ① 目标卡在源的右侧 → 几何主侧必然是 in-left；② 主侧那条横线正好穿过 a→b 的
// 竖向落线（1 个交叉）；③ 实际渲染路径的终点落在 in-right 线头盒里、in-left 一个
// 像素都没碰；④ 路径的最大 x 超过了目标卡右缘（真的绕过去了，不是硬穿）；⑤ 两条
// 线在屏幕上零交叉。坐标写在 ALTERNATE 夹具里（四个节点都带 layout，自动布局是
// no-op），夹具是靠真路由暴力搜出来的、卡片高度 90..160 全稳。
const mountAltWorkflow = async () => {
  await page.evaluate(() => window.__mount({ kind: 'workflow', workflowId: 'wf_alt' }))
  await page.waitForSelector('[data-pm-form-assist]')
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === '绕行验证流程'))
}
/** 渲染路径按屏幕像素密采样（world → screen 过 CTM，路径坐标是 world 空间）。 */
const polylineOf = (edgeId, step = 2) =>
  page.evaluate(
    ([eid, st]) => {
      const path = document.querySelector(`.react-flow__edge[data-id="${eid}"] .react-flow__edge-path`)
      if (!path) return null
      const total = path.getTotalLength()
      const m = path.getScreenCTM()
      const n = Math.max(2, Math.ceil(total / st))
      const pts = []
      for (let i = 0; i <= n; i += 1) {
        const p = path.getPointAtLength((total * i) / n).matrixTransform(m)
        pts.push({ x: p.x, y: p.y })
      }
      return pts
    },
    [edgeId, step],
  )
/** 屏幕空间正交交叉计数：圆角倒角是 6px 斜段，采样里两个方向都变 → 直接跳掉。 */
const crossingsOf = (a, b) => {
  const segs = (pts) => {
    const out = []
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i - 1]
      const q = pts[i]
      const dx = Math.abs(q.x - p.x)
      const dy = Math.abs(q.y - p.y)
      if (dy <= 0.6 && dx > 0.6) out.push({ vert: false, at: (p.y + q.y) / 2, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) })
      else if (dx <= 0.6 && dy > 0.6) out.push({ vert: true, at: (p.x + q.x) / 2, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) })
    }
    return out
  }
  let n = 0
  for (const s of segs(a))
    for (const t of segs(b)) {
      if (s.vert === t.vert) continue
      const v = s.vert ? s : t
      const h = s.vert ? t : s
      if (v.at > h.lo + 1 && v.at < h.hi - 1 && h.at > v.lo + 1 && h.at < v.hi - 1) n += 1
    }
  return n
}

console.log('\n§14 · 冲突触发换侧：左进会交叉，就从右侧绕行')
await mountAltWorkflow()
await gotoStep('任务内容')
await page.waitForSelector('.react-flow__node[data-id="node:d"]')
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)

const altEdges = await edgeIds()
const blockerId = 'edge:a|done|b'
const turningId = 'edge:c|done|d'
check('绕行夹具的两条主线都渲染出来了', altEdges.includes(blockerId) && altEdges.includes(turningId), altEdges.join(' | '))

const dHandles = await handlesOf('node:d')
const targetsD = dHandles.filter((h) => h.type === 'target')
check(
  '目标卡 d 的三个入线头都在且有尺寸（换侧才有得换）',
  ['in-top', 'in-left', 'in-right'].every((id) => targetsD.some((h) => h.id === id && h.w > 0 && h.h > 0)),
  targetsD.map((h) => `${h.id}:${h.w.toFixed(0)}x${h.h.toFixed(0)}`).join(' '),
)
const cardC = await centerOf('.react-flow__node[data-id="node:c"]')
const cardD = await centerOf('.react-flow__node[data-id="node:d"]')
check(
  '几何主侧是「左进」：d 完全在 c 的右侧（没有任何纵向重叠可走顶部）',
  !!cardC && !!cardD && cardD.left > cardC.right,
  `c.right=${cardC?.right?.toFixed(1)} d.left=${cardD?.left?.toFixed(1)}`,
)

const endRight = await endpointOf(turningId, 'node:d', 'in-right')
const endLeft = await endpointOf(turningId, 'node:d', 'in-left')
check(
  '实际落点是右侧线头 in-right（尖恰好贴在圆点边缘，指向端口）',
  stopsAtPortRim(endRight),
  endRight
    ? `advance=${endRight.advance.toFixed(1)} lateral=${endRight.lateral.toFixed(1)} dist=${endRight.dist.toFixed(1)} r=${endRight.radius.toFixed(1)}`
    : '路径或线头缺失',
)
check(
  '左侧线头没有被碰：主侧让位给「零交叉」的兜底路径',
  !!endLeft && !endLeft.inside,
  endLeft ? `inside=${endLeft.inside} dist=${endLeft.dist.toFixed(1)}` : 'in-left 线头缺失',
)

const turningPts = await polylineOf(turningId)
const blockerPts = await polylineOf(blockerId)
const maxX = turningPts ? Math.max(...turningPts.map((p) => p.x)) : null
check(
  '路径真的从目标卡右缘之外绕过去（最大 x 超过 d 的右缘）',
  !!cardD && maxX !== null && maxX > cardD.right + 2,
  maxX === null ? '路径缺失' : `maxX=${maxX.toFixed(1)} d.right=${cardD.right.toFixed(1)}`,
)
check(
  '换侧之后两条主线在屏幕上零交叉（主侧那样走会压出 1 个交叉）',
  !!turningPts && !!blockerPts && crossingsOf(blockerPts, turningPts) === 0,
  turningPts && blockerPts ? `crossings=${crossingsOf(blockerPts, turningPts)}` : '路径缺失',
)
await page.screenshot({ path: join(SHOTS, '14-routing-alt-side.png') })

await browser.close()

// ── summary ──
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exitCode = 1
}
console.log(`screenshots: ${SHOTS}`)
