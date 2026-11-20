/**
 * Run view probe (real Chromium) — PLAN-workflow-run-view 的可视化验收：
 * 同一张正交路由画布，runView 在场 = 运行查看态——
 *   ① 节点一律灰边（2026-11-20 二刀：状态色退役），右上角 = 执行次数徽标，
 *      未到达弱化（--run-idle）、选中蓝边框（--run-focus，三刀去掉阴影扩散）；
 *   ② 走过的边亮（wf-edge-taken）、没走的弱化（wf-edge-idle）；
 *   ③ 开始/结束芯片同灰（三刀：实例终态色退役），选中芯片与任务卡同款蓝边；
 *      聚焦效果 = 纯蓝边框、无阴影扩散；
 *   ④ 编辑面全体退场：悬停编辑/删除钮、dock 都不在 DOM；
 *   ⑤ 对照：不给 runView 的定义视图，编辑钮照常在（默认行为逐字节不变）；
 *   ⑥ §1e 执行链导航（user 2026-11-20）：右栏前进/后退逐步走链、落到正确
 *      节点与运行次数、画布聚焦定位、两端禁用不回绕、画布点选同步链位。
 * Usage: node scripts/probe-workflow-run-view.mjs [--headed]
 */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(mkdtempSync(join(tmpdir(), 'pm-run-view-')), 'harness.js')
const SHOTS = join(tmpdir(), 'pm-run-view-shots')

const HARNESS = `
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { TranslationProvider } from './src/renderer/src/i18n/useTranslation'
import { SettingsProvider } from './src/renderer/src/hooks/SettingsContext'
import WorkflowRunViewPage from './src/renderer/src/components/routine/WorkflowRunViewPage'
import { WorkflowCanvas } from './src/renderer/src/components/routine/WorkflowCanvas'
import RoutineCenter from './src/renderer/src/components/routine/RoutineCenter'
import { useNavigationStore } from './src/renderer/src/stores/navigationStore'
import { installThemeVars, applyThemeAttr } from './src/renderer/src/theme/dom'

installThemeVars()
applyThemeAttr('light')

const DEF = {
  id: 'wf_run',
  name: '编码流水线',
  objective: '把计划落地',
  entry: 'code',
  // verdictKinds 是**显式语义**（user 2026-11-17「你是不是写死了把 pass 作为
  // 成功态」）：语义辨读只活在右栏详情。2026-11-20 二刀后卡面不吃状态色，
  // 这张夹具的 verdictKinds 只用于右栏面板的 verdict 文字配色；卡面断言一律
  // 「灰边 + 次数徽标」。
  nodes: [
    { id: 'code', title: '编码', prompt: '把计划落地为代码', verdicts: ['pass', 'fail'], verdictKinds: { pass: 'success', fail: 'failure' }, layout: { x: 0, y: 0 } },
    { id: 'test', title: '测试', prompt: '跑测试', verdicts: ['pass', 'fail'], verdictKinds: { pass: 'success', fail: 'failure' }, layout: { x: 320, y: 0 } },
    { id: 'review', title: '评审', prompt: '评审改动', verdicts: ['pass'], layout: { x: 640, y: 0 } },
  ],
  edges: [
    { from: 'code', when: 'pass', to: 'test' },
    { from: 'test', when: 'pass', to: 'review' },
    { from: 'test', when: 'fail', to: 'DONE' },
  ],
}

const STAGES = [
  { id: 'st0', runId: 'prun_v', nodeId: 'code', continues: 0, startedAt: '2026-11-15T09:50:00.000Z', finishedAt: '2026-11-15T09:55:00.000Z', verdict: 'fail', summary: '首轮编码未通过自检', conversationId: 'pipe_20261115_code00' },
  { id: 'st1', runId: 'prun_v', nodeId: 'code', continues: 0, startedAt: '2026-11-15T10:00:00.000Z', finishedAt: '2026-11-15T10:03:00.000Z', verdict: 'pass', summary: '编码完成：3 个文件改动，自检通过', artifacts: ['src/a.ts', 'src/b.ts'], conversationId: 'pipe_20261115_code01' },
  { id: 'st2', runId: 'prun_v', nodeId: 'test', continues: 1, startedAt: '2026-11-15T10:03:10.000Z', finishedAt: '2026-11-15T10:05:00.000Z', verdict: 'fail', summary: '测试跑了一半：12/20 通过', error: '2 个用例失败', conversationId: 'pipe_20261115_test01' },
  { id: 'st3', runId: 'prun_v', nodeId: 'test', continues: 0, startedAt: '2026-11-15T10:06:00.000Z' },
]

// 执行推进（user 2026-11-17「在执行过程中，连接线没了」）：真实运行里每 3s 轮询
// 带回的 stage 行会变——某个节点从「没跑到」变成「运行中」，再变成结算。节点卡
// 因此长/短一行徽标，高度变化。夹具要能把这条变化演出来，才测得到「执行中连线
// 会不会消失」。
const STAGES_ADV1 = [
  ...STAGES.slice(0, 3),
  { ...STAGES[3], finishedAt: '2026-11-15T10:08:00.000Z', verdict: 'pass', summary: '测试全绿' },
  { id: 'st4', runId: 'prun_v', nodeId: 'review', continues: 0, startedAt: '2026-11-15T10:08:10.000Z', conversationId: 'pipe_20261115_review01' },
]
const STAGES_ADV2 = [
  ...STAGES_ADV1.slice(0, 4),
  { ...STAGES_ADV1[4], finishedAt: '2026-11-15T10:12:00.000Z', verdict: 'pass', summary: '评审通过' },
]
// 相位 3 = 刚点开运行图、还没落任何 stage 行（运行刚开始的那几秒）。这是
// 「在执行过程中，连接线没了」最纯粹的形态：**每一条边都还没走过**，整张图
// 全是 idle 边——idle 的着色如果淡到看不见，这一帧就是「连线没了」。
const STAGES_START = []
const PHASES = [STAGES, STAGES_ADV1, STAGES_ADV2, STAGES_START]
let stagePhase = 0
window.__setStagePhase = (n) => {
  stagePhase = n
}
window.__stagePhase = () => stagePhase
// 运行视图吃的是**盘上原样定义**：换一份定义要能换，才测得到「定义没写
// layout」时画布自己补布局（§1b2）。
let servedDef = DEF
window.__serveDef = (d) => {
  servedDef = d
}
window.__serveDefaultDef = () => {
  servedDef = DEF
}

const RUN = { id: 'prun_v', workflowId: 'wf_run', workflowName: '编码流水线', objective: '把计划落地', status: 'running', startedAt: '2026-11-15T10:00:00.000Z', conclusion: '报告已生成：reports/weekly.md', inputs: { topic: '远程办公的利与弊' }, workspaceDir: '/tmp/pm-probe-ws' }
// 运行态可变（2026-11-18 头部动作）：停止钮只在 running 出现，重跑/续跑只在
// failed 出现，续跑还按「回滚过基线 / 无已完成前序阶段」置灰——三档都要能演。
let runOverride = {}
window.__serveRun = (patch) => {
  runOverride = patch ?? {}
}
// 头部动作与产物点开的调用流水：判据是**真点到了哪条 IPC、参数是什么**，
// 不是按钮画出来了。
const actionLog = []
window.__actionLog = () => actionLog
window.__clearActionLog = () => {
  actionLog.length = 0
}

window.electronAPI = new Proxy({}, {
  get: (_t, key) => (...args) => {
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {}
    if (key === 'pipelineWorkflows') {
      const [op] = args
      return Promise.resolve(op === 'get' ? servedDef : [servedDef])
    }
    // 头部动作 + 产物点开（2026-11-18）：记账后给成功面。
    if (key === 'pipelineStop' || key === 'pipelineRerun' || key === 'openFolder') {
      actionLog.push({ fn: key, args })
      if (key === 'pipelineStop') return Promise.resolve(true)
      if (key === 'pipelineRerun') return Promise.resolve({ runId: 'prun_next' })
      return Promise.resolve()
    }
    // 侧边栏的真实数据面（3s 轮询）：一条 workflow 运行 + 它的 stage 行。
    if (key === 'pipelineRuns') {
      // 带 runId = 运行页的自取数（单 run + 它的 stage 行）；不带 = 近期运行列表。
      const [rid] = args
      const stages = PHASES[stagePhase] ?? STAGES
      const run = { ...RUN, ...runOverride }
      return Promise.resolve(rid ? { run, stages } : { runs: [run], stages })
    }
    if (key === 'routineList' || key === 'routineRuns') return Promise.resolve([])
    // 阶段转写：落库的 pipe_ 会话（含 tool_result 的水合形态）。tool_use 按
    // 真实落库形状给——status 缺席（运行时字段不落库）、exitCode 在、配对
    // 的 tool_result 在；渲染端必须经 storedMessagesToAgentMessages 回填
    // completed，否则全屏「执行状态未知」（2026-11-17 用户实报）。
    if (key === 'hydrateConversation') {
      // 足够长，让转写真的溢出滚动容器（2026-11-17「点击节点后定位到会话尾部」
      // 只有在可滚动时才可测——三行 fixture 量不出任何 scrollTop）。
      const convId = args[0]
      const messages = [{ id: 'm0', role: 'user', contentBlocks: [{ type: 'text', text: '阶段提示词：把计划落地为代码' }] }]
      for (let i = 1; i <= 8; i += 1) {
        messages.push({ id: 'ma' + i, role: 'assistant', contentBlocks: [
          { type: 'text', text: '第 ' + i + ' 轮：' + '读取并修改源码的说明段落，'.repeat(14) },
          { type: 'tool_use', id: 'tu' + i, name: 'exec', input: { command: 'npm test -- --run ' + i }, exitCode: 0, output: 'ok' },
        ] })
        messages.push({ id: 'mu' + i, role: 'user', contentBlocks: [
          { type: 'tool_result', tool_use_id: 'tu' + i, tool_result_id: 'tr' + i, content: 'ok', is_error: false },
        ] })
      }
      messages.push({ id: 'mz', role: 'assistant', contentBlocks: [{ type: 'text', text: '阶段结论（会话 ' + convId + '）：自检通过' }] })
      return Promise.resolve({ id: convId, title: '阶段', messages, createdAt: '', updatedAt: '' })
    }
    if (key === 'getSettings') {
      return Promise.resolve({ activeProfileId: '', profiles: [], theme: 'light', myName: '', soul: '',
        yourName: '', workspaceDir: '', autoCleanup: false, locale: 'zh' })
    }
    return Promise.resolve(undefined)
  },
})

let root = null
window.__mountRunView = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div id="view" style={{ height: '100vh' }}>
              <WorkflowRunViewPage runId="prun_v" />
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}
window.__mountDefinition = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div id="view" style={{ height: '100vh', padding: 24 }}>
              <div style={{ height: 700 }}>
                <WorkflowCanvas def={DEF} mutate={() => undefined} />
              </div>
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}
// §1c：把任意定义 + 任意 stage 行直接挂到运行态画布上——用来验证「卡面与
// 结果状态解耦」对**任意词表**成立（不必再绕 WorkflowRunViewPage 的定义加载）。
window.__mountCanvasRun = (def, stages) => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div id="view" style={{ height: '100vh', padding: 24 }}>
              <div style={{ height: 700 }}>
                <WorkflowCanvas def={def} mutate={() => undefined} runView={{ status: 'running', stages }} />
              </div>
            </div>
          </TranslationProvider>
        </SettingsProvider>
      </AntdApp>
    </ConfigProvider>
  )
  return true
}
// §2：驱动**真实侧边栏路径**——RoutineCenter → 点 workflow 运行行展开 →
// 点「查看运行图」→ 导航 store 切到整页运行视图。宿主镜像 ViewHost 的
// routines 分支（列表 ↔ workflowRunViewId 页），导航才真的换页面。
window.__mountCenter = () => {
  if (root) root.unmount()
  root = createRoot(document.getElementById('root'))
  const Host = () => {
    const view = useNavigationStore((s) => s.view)
    return view.workflowRunViewId
      ? <WorkflowRunViewPage runId={view.workflowRunViewId} />
      : <RoutineCenter />
  }
  root.render(
    <ConfigProvider>
      <AntdApp>
        <SettingsProvider>
          <TranslationProvider initialLocale="zh">
            <div id="view" style={{ height: '100vh' }}>
              <Host />
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
let pageErrors = 0
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } })
page.on('pageerror', (err) => {
  pageErrors += 1
  console.log('  [page error]', err.message)
})
const PAGE_HTML = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
await page.route('http://pm-probe.local/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }))
await page.goto('http://pm-probe.local/')
await page.addStyleTag({ path: join(process.cwd(), 'node_modules/@xyflow/react/dist/style.css') })
await page.addScriptTag({ path: OUT })
await page.waitForFunction(() => window.__ready)

// ── 运行视图 ──
await page.evaluate(() => window.__mountRunView())
await page.waitForSelector('.react-flow__node')
await page.waitForTimeout(500)

// ── §1b 首屏取景（user 2026-11-17「进入页面后流程图未居中，另外可适当缩小」）──
// 面板宽度是 mount 后才按 60% 落位的，RF 挂载时那次 fitView 量到的是旧尺寸，
// 图于是偏在一角；且默认 fitView 无放大上限，少节点图会被放大到 1.3 倍。补齐后
// 断言两件事：scale ≤ 1（只缩小不放大）、节点包围盒中心 ≈ 画布中心。
await page.waitForTimeout(400)
/** 首屏取景的度量：画布容器 vs 全部节点包围盒 + viewport 的 scale。 */
const measureFraming = () =>
  page.evaluate(() => {
    const wrap = document.querySelector('[data-workflow-canvas]')
    const tf = document.querySelector('.react-flow__viewport')?.style.transform ?? ''
    const m = /scale\(([\d.]+)\)/.exec(tf)
    const wr = wrap.getBoundingClientRect()
    const rects = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect())
    const left = Math.min(...rects.map((r) => r.left))
    const right = Math.max(...rects.map((r) => r.right))
    const top = Math.min(...rects.map((r) => r.top))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    return {
      scale: m ? Number(m[1]) : 0,
      dx: (left + right) / 2 - (wr.left + wr.width / 2),
      dy: (top + bottom) / 2 - (wr.top + wr.height / 2),
      inside: left >= wr.left - 1 && right <= wr.right + 1 && top >= wr.top - 1 && bottom <= wr.bottom + 1,
    }
  })
const framing = await measureFraming()
check('首屏取景不放大（scale ≤ 1）', framing.scale > 0 && framing.scale <= 1.001, `scale=${framing.scale}`)
check(
  '首屏流程图居中（包围盒中心 ≈ 画布中心，≤16px）',
  Math.abs(framing.dx) <= 16 && Math.abs(framing.dy) <= 16,
  `dx=${framing.dx.toFixed(1)} dy=${framing.dy.toFixed(1)}`,
)
check('首屏全图都在画布内', framing.inside)
// 边要等节点测量 + 路由（首帧 routes 为空时那次 effect 会跳过），负载高时比节点
// 晚一两帧——显式等它，别让计数断言在忙机器上偶发落空。
await page.waitForSelector('.wf-edge-taken', { timeout: 5000 })

// user 2026-11-20 二刀：卡面一律灰边（run-pass/fail/running/settled 状态色
// 全部退役），右上角 = 执行次数徽标（running 的那次也计数）。
const badgeTextAt = async (id) =>
  ((await page.locator(`.react-flow__node[data-id="node:${id}"] .wf-run-badge`).innerText()) || '').trim()
check('卡面一律灰边（状态着色类全部退场）',
  (await page.locator('.wf-stage-card--run-pass,.wf-stage-card--run-fail,.wf-stage-card--run-running,.wf-stage-card--run-settled').count()) === 0)
check('未到达节点弱化（--run-idle）', (await page.locator('.wf-stage-card--run-idle').count()) === 1)
check('次数徽标：code=2 次、test=2 次（running 那次也计数）',
  (await badgeTextAt('code')) === '2 次' && (await badgeTextAt('test')) === '2 次',
  `code=${await badgeTextAt('code')} test=${await badgeTextAt('test')}`)
check('没跑过的节点不给徽标（review）', (await page.locator('.react-flow__node[data-id="node:review"] .wf-run-badge').count()) === 0)
check('走过的高亮 + 没走的弱化（边类都在）', (await page.locator('.wf-edge-taken').count()) >= 1 && (await page.locator('.wf-edge-idle').count()) >= 1)
// user 2026-11-20 三刀：开始/结束芯片也进灰边族——实例终态色（--run-*）与编辑态
// 身份色（开始蓝/结束绿）在运行视图一并让位，与任务卡同一 hairline 灰；蓝边只
// 属于「选中」（§3.5 断）。
check('开始/结束芯片的实例终态色退役（--run-success/failed/running 全无）',
  (await page.locator('.wf-terminal--run-running,.wf-terminal--run-success,.wf-terminal--run-failed').count()) === 0)
const chipBorders = await page.evaluate(() => {
  const border = (el) => (el ? getComputedStyle(el).borderTopColor : null)
  return {
    card: border(document.querySelector('.wf-stage-card')),
    start: border(document.querySelector('.react-flow__node[data-id="terminal:START"] .wf-terminal')),
    done: border(document.querySelector('.react-flow__node[data-id="terminal:DONE"] .wf-terminal')),
  }
})
check('开始/结束芯片与任务卡同一灰边',
  !!chipBorders.card && chipBorders.start === chipBorders.card && chipBorders.done === chipBorders.card,
  `card=${chipBorders.card} start=${chipBorders.start} done=${chipBorders.done}`)
check('编辑/删除钮全体退场', (await page.locator('[data-workflow-node-edit]').count()) === 0 && (await page.locator('[data-workflow-node-delete]').count()) === 0)
check('端口圆点不可见（opacity 0，不是 display 抽掉）', await page.evaluate(() => {
  const h = document.querySelector('.wf-handle-source, .wf-handle-target')
  return h !== null && getComputedStyle(h).opacity === '0'
}))
check('边的状态词标签已撤（无 textwrapper）', (await page.locator('.react-flow__edge .react-flow__edge-textwrapper').count()) === 0)
check('添加/整理 dock 退场', (await page.locator('[data-dock-action]').count()) === 0)
check('属性面板不存在', (await page.locator('[data-workflow-node-panel]').count()) === 0)
await page.screenshot({ path: join(SHOTS, 'run-view.png') })

// ── 对照：定义视图默认行为不变 ──
await page.evaluate(() => window.__mountDefinition())
await page.waitForSelector('.react-flow__node')
await page.waitForTimeout(500)
check('定义视图：编辑钮照常在（默认行为不变）', (await page.locator('[data-workflow-node-edit]').count()) === 3)
check('定义视图：无 run 状态类', (await page.locator('[class*="wf-stage-card--run-"]').count()) === 0)
await page.screenshot({ path: join(SHOTS, 'definition-view.png') })

// ── §1b2 定义没写 layout / 没写 verdicts：运行视图必须自己补齐（user
// 2026-11-17「连接线又没了」）──
// 盘上的定义可以来自手写/模板/旧版：节点 `layout` 缺席时 buildFlowNodes 把它们
// 全摆在 (0,0)——三张卡叠成一摞，连线被压在卡下面，看上去就是「连线没了」
// （实锤 doc-translate-pipeline：三个节点 layout 全 null）；`verdicts` 缺席还会
// 让画布与节点卡裸解引用抛错。归一 + 自动布局必须在运行视图的定义加载处补齐。
const NO_LAYOUT = {
  id: 'wf_run',
  name: '无布局定义',
  entry: 'a',
  nodes: [
    { id: 'a', title: '甲', prompt: '甲' },
    { id: 'b', title: '乙', prompt: '乙', verdicts: ['pass', 'fail'] },
    { id: 'c', title: '丙', prompt: '丙', verdicts: ['pass'] },
  ],
  edges: [
    { from: 'a', when: 'pass', to: 'b' },
    { from: 'b', when: 'pass', to: 'c' },
    { from: 'c', when: 'pass', to: 'DONE' },
  ],
}
await page.evaluate((d) => window.__serveDef(d), NO_LAYOUT)
await page.evaluate(() => window.__mountRunView())
await page.waitForSelector('.react-flow__node')
await page.waitForSelector('.react-flow__edge', { timeout: 5000 })
await page.waitForTimeout(600)
const noLayoutPos = await page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')]
    .filter((n) => n.getAttribute('data-id')?.startsWith('node:'))
    .map((n) => ({ id: n.getAttribute('data-id'), t: n.style.transform })),
)
check(
  '无 layout 的定义：三张卡各自落位（不再叠在 (0,0)）',
  new Set(noLayoutPos.map((n) => n.t)).size === 3,
  noLayoutPos.map((n) => `${n.id}@${n.t}`).join(' | '),
)
const noLayoutYs = noLayoutPos.map((n) => Number(/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(n.t)?.[2] ?? NaN))
check('无 layout 的定义：自动布局纵向分层（y 随声明序递增）', noLayoutYs.every((y, i) => i === 0 || y > noLayoutYs[i - 1]), noLayoutYs.join(','))
check('无 layout 的定义：连线全在（3 条 + start-entry）', (await page.locator('.react-flow__edge').count()) === 4)
check(
  '缺 verdicts 的节点不抛错（补齐 pass，出口线头在）',
  (await page.locator('.react-flow__node[data-id="node:a"] .react-flow__handle.source').count()) === 1,
)
await page.screenshot({ path: join(SHOTS, 'run-view-no-layout.png') })
await page.evaluate(() => window.__serveDefaultDef())

// ── §1c 结果状态与卡面解耦（user 2026-11-17「你是不是写死了把 pass 作为成功态」
// → 2026-11-20 二刀「所有节点都是灰色边框…不用在节点右上角展示节点执行状态」）──
// 结果状态是用户自定义词表（成功/失败/需修订…）；2026-11-20 二刀后卡面不再吃
// 任何状态色/状态词——无论 verdict 是什么词、声明了什么语义，运行态卡一律
// 灰边 + 次数徽标（多次执行每次结果可能不同，单值状态是误导），成功/失败的
// 辨读只剩右栏详情。三臂各自独立挂一张运行态画布，验证「无论结算成什么，
// 卡面都一样」+ 出边强度维（taken/idle）仍跟结算的 verdict 走：
//   A. 中文词表 + 显式 verdictKinds：成功 / 需修订（中性）；
//   B. 同一张定义，结算成「失败」；
//   C. 旧定义（无 verdictKinds）：按出边推。
const cnStage = (nodeId, verdict, i) => ({
  id: `cn${i}`,
  runId: 'prun_cn',
  nodeId,
  continues: 0,
  startedAt: `2026-11-17T10:0${i}:00.000Z`,
  finishedAt: `2026-11-17T10:0${i + 1}:00.000Z`,
  verdict,
})
const mountCanvasRun = (def, stages) =>
  page.evaluate(([d, s]) => window.__mountCanvasRun(d, s), [def, stages])

const CN_EXPLICIT = {
  id: 'wf_cn',
  name: '中文词表',
  entry: 'a',
  nodes: [
    { id: 'a', title: '甲', prompt: '甲', verdicts: ['成功', '失败'], verdictKinds: { 成功: 'success', 失败: 'failure' }, layout: { x: 0, y: 0 } },
    { id: 'b', title: '乙', prompt: '乙', verdicts: ['通过', '需修订'], verdictKinds: { 通过: 'success', 需修订: 'neutral' }, layout: { x: 320, y: 0 } },
  ],
  edges: [
    { from: 'a', when: '成功', to: 'b' },
    { from: 'a', when: '失败', to: 'DONE' },
    { from: 'b', when: '通过', to: 'DONE' },
    { from: 'b', when: '需修订', to: 'DONE' },
  ],
}
// 出边的颜色维度归状态类（wf-edge-verdict-N，2026-11-18 七色配色），运行维度
// 只控强度（走过全亮、没走弱化）。
const edgeHasClass = (id, cls) =>
  page.evaluate(([eid, c]) => !!document.querySelector(`[data-id="${eid}"]`)?.classList.contains(c), [id, cls])
const cnBadge = async (id) =>
  ((await page.locator(`.react-flow__node[data-id="node:${id}"] .wf-run-badge`).innerText()) || '').trim()
const noStatusClasses = async () =>
  (await page.locator('.wf-stage-card--run-pass,.wf-stage-card--run-fail,.wf-stage-card--run-running,.wf-stage-card--run-settled').count()) === 0

await mountCanvasRun(CN_EXPLICIT, [cnStage('a', '成功', 0), cnStage('b', '需修订', 1)])
await page.waitForSelector('.wf-edge-taken', { timeout: 5000 })
check('A 显式词表：卡面无状态着色类（灰边）', await noStatusClasses())
check('A 显式词表：次数徽标与状态词无关（各 1 次）',
  (await cnBadge('a')) === '1 次' && (await cnBadge('b')) === '1 次',
  `a=${await cnBadge('a')} b=${await cnBadge('b')}`)
check('A：出边强度跟着结算的 verdict 走',
  (await edgeHasClass('edge:a|成功|b', 'wf-edge-taken')) &&
    (await edgeHasClass('edge:a|失败|DONE', 'wf-edge-idle')) &&
    (await edgeHasClass('edge:b|需修订|DONE', 'wf-edge-taken')) &&
    (await edgeHasClass('edge:b|通过|DONE', 'wf-edge-idle')))
await page.screenshot({ path: join(SHOTS, 'run-view-verdict-cn-success.png') })

// B：同一张定义结算成「失败」——卡面与 A 逐字节一样（灰边 + 次数），只有边
// 的强度换了。
await mountCanvasRun(CN_EXPLICIT, [cnStage('a', '失败', 0)])
await page.waitForSelector('.wf-edge-taken', { timeout: 5000 })
check('B 结算成失败：卡面同样无状态着色类（与 A 一样灰）', await noStatusClasses())
check('B：次数徽标照旧（a 1 次），失败词不上卡',
  (await cnBadge('a')) === '1 次' && (await page.locator('.wf-run-badge').count()) === 1)
check('B：失败出边亮起（强度维度）',
  (await edgeHasClass('edge:a|失败|DONE', 'wf-edge-taken')) && (await edgeHasClass('edge:a|成功|b', 'wf-edge-idle')))

// C：旧定义零迁移——没有任何 verdictKinds，语义按拓扑推；卡面同样不受影响。
const CN_INFERRED = {
  id: 'wf_cn2',
  name: '推导向',
  entry: 'a',
  nodes: [
    { id: 'a', title: '甲', prompt: '甲', verdicts: ['好的', '糟了'], layout: { x: 0, y: 0 } },
    { id: 'b', title: '乙', prompt: '乙', verdicts: ['嗯'], layout: { x: 320, y: 0 } },
  ],
  edges: [
    { from: 'a', when: '好的', to: 'DONE' },
    { from: 'a', when: '糟了', to: 'b' },
  ],
}
await mountCanvasRun(CN_INFERRED, [cnStage('a', '好的', 0), cnStage('b', '嗯', 1)])
await page.waitForSelector('.wf-edge-taken', { timeout: 5000 })
check('C 推导向：卡面无状态着色类（灰边）', await noStatusClasses())
check('C：次数徽标各 1 次', (await cnBadge('a')) === '1 次' && (await cnBadge('b')) === '1 次')
check('C：→DONE 的边亮起、没走过的边弱化',
  (await edgeHasClass('edge:a|好的|DONE', 'wf-edge-taken')) && (await edgeHasClass('edge:a|糟了|b', 'wf-edge-idle')))
await page.screenshot({ path: join(SHOTS, 'run-view-verdict-inferred.png') })

// ── §1d 次数徽标落位（user 2026-11-20 二刀「可以在节点右上角展示执行次数」，
// 顶掉 2026-11-17 的执行状态徽标）──
// 三臂：a 完全没声明 verdicts（normalize 补 ['pass']）、b 声明了两个状态（自
// 定义词表）、c 只声明 ['pass']（= 缺省单状态）。无论词表怎么声明，徽标一律
// 只读次数（各 1 次）；位置钉在卡右上角 6px（按 zoom 折回 CSS px）。
const BADGE_DEF = {
  id: 'wf_badge',
  name: '徽标',
  entry: 'a',
  nodes: [
    { id: 'a', title: '甲', prompt: '甲', layout: { x: 0, y: 0 } },
    { id: 'b', title: '乙', prompt: '乙', verdicts: ['pass', 'fail'], layout: { x: 320, y: 0 } },
    { id: 'c', title: '丙', prompt: '丙', verdicts: ['pass'], layout: { x: 640, y: 0 } },
  ],
  edges: [
    { from: 'a', when: 'pass', to: 'b' },
    { from: 'b', when: 'pass', to: 'c' },
    { from: 'c', when: 'pass', to: 'DONE' },
  ],
}
await mountCanvasRun(BADGE_DEF, [cnStage('a', 'pass', 0), cnStage('b', 'pass', 1), cnStage('c', 'pass', 2)])
await page.waitForSelector('.wf-run-badge', { timeout: 5000 })
const badgeText = async (id) =>
  ((await page.locator(`.react-flow__node[data-id="node:${id}"] .wf-run-badge`).innerText()) || '').trim()
check('次数徽标与结果状态声明无关（无 verdicts → 1 次）', (await badgeText('a')) === '1 次', await badgeText('a'))
check('自定义双状态词表同样只读次数', (await badgeText('b')) === '1 次', await badgeText('b'))
check('只声明单状态 pass 同样只读次数', (await badgeText('c')) === '1 次', await badgeText('c'))
const badgeGeom = await page.evaluate(() => {
  const card = document.querySelector('.react-flow__node[data-id="node:a"] .wf-stage-card')
  const badge = document.querySelector('.react-flow__node[data-id="node:a"] .wf-run-badge')
  if (!card || !badge) return null
  const c = card.getBoundingClientRect()
  const b = badge.getBoundingClientRect()
  const zoom = card.offsetWidth ? c.width / card.offsetWidth : 1
  return {
    top: (b.top - c.top) / zoom,
    right: (c.right - b.right) / zoom,
    zoom,
    titlePad: getComputedStyle(card.querySelector('.wf-stage-title')).paddingRight,
  }
})
check(
  '徽标钉在卡右上角（top/right 各 6px，按 zoom 折回 CSS px）',
  !!badgeGeom && Math.abs(badgeGeom.top - 6) <= 1.5 && Math.abs(badgeGeom.right - 6) <= 1.5,
  JSON.stringify(badgeGeom),
)
check('运行态标题给徽标让位（padding-right 72px）', badgeGeom?.titlePad === '72px', String(badgeGeom?.titlePad))
await page.screenshot({ path: join(SHOTS, 'run-view-badge-corner.png') })

// ── §1e 执行链导航（user 2026-11-20「右栏前进/后退顺着执行链路走」）──
// 相位 0 的链 = code#1 → code#2 → test#1 → test#2（RETRY/重跑的多次执行各占
// 一步）。判据不是「按钮画出来了」：每步要落到**正确的节点 + 正确的第几次**
// （选择条的高亮跟着走），画布把聚焦描边挂在对应节点上并把视口对过去，两端
// 禁用不回绕；画布点节点要把链位同步过去、没跑过的节点不动链位。
// 重新挂一次页面拿干净状态：默认选中落链尾（链位只随导航走，前面几段的
// 点选已经把它挪过位置了）。
const navPos = () => page.locator('[data-run-nav-pos]').innerText()
const navNodeText = () => page.locator('[data-run-nav-node]').innerText()
const navBtnState = (attr) =>
  page.evaluate((a) => {
    const b = document.querySelector(`[data-run-nav-${a}]`)
    return b ? { disabled: !!b.disabled } : null
  }, attr)
const navStep = (dir) => page.locator(`[data-run-nav-${dir}]`).click()
/** 选择条当前高亮的那个 #i（primary 型按钮里的文本）。 */
const activePick = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-workflow-run-panel] button')]
      .filter((b) => /^#\d/.test((b.textContent || '').trim()) && b.className.includes('ant-btn-primary'))
      .map((b) => (b.textContent || '').trim())
      .join(','),
  )
const focusNodeIds = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.wf-stage-card--run-focus')]
      .map((el) => el.closest('.react-flow__node')?.getAttribute('data-id'))
      .join(','),
  )
await page.evaluate(() => window.__mountRunView())
await page.waitForSelector('[data-workflow-run-nav]', { timeout: 8000 })
await page.waitForTimeout(700)

check('导航条常驻面板顶部（两颗钮 + 步数标签 + 节点名）',
  (await page.locator('[data-workflow-run-nav]').count()) === 1 &&
    (await navBtnState('prev')) !== null && (await navBtnState('next')) !== null &&
    (await page.locator('[data-run-nav-pos]').count()) === 1)
check('默认落链尾：第 4 / 4 步、next 禁用（两端不回绕）',
  /第 4 \/ 4 步/.test(await navPos()) && (await navBtnState('next')).disabled === true,
  `${await navPos()} next=${JSON.stringify(await navBtnState('next'))}`)
await navStep('prev')
await page.waitForTimeout(550) // fitView 有 300ms 动画
check('后退一步 → 第 3 步 = 测试 #1（节点名 + 运行次数都在导航条上）',
  /第 3 \/ 4 步/.test(await navPos()) && (await navNodeText()).includes('测试') && (await navNodeText()).includes('#1'),
  `${await navPos()} · ${await navNodeText()}`)
check('第 3 步：选择条高亮 #1（该节点第 1 次）', (await activePick()) === '#1 fail', await activePick())
check('第 3 步：聚焦描边只挂在 test 上', (await focusNodeIds()) === 'node:test', await focusNodeIds())
// 三刀（user 2026-11-20「选中节点效果只需要设为蓝色边框，不需要阴影扩散效果」）：
// 描边 = 只换边框色到 --pm-link，**选中不新增任何 box-shadow**（双环/外晕退役；
// 卡本身的基底投影不算——判据是与未选中卡同值，不是 none）；未选中的卡仍是
// hairline 灰（灰底规则没有被聚焦规则误伤）。
const focusStyle = await page.evaluate(() => {
  const focused = document.querySelector('.wf-stage-card--run-focus')
  const plain = [...document.querySelectorAll('.wf-stage-card--runview')].find((el) => el !== focused)
  if (!focused || !plain) return null
  const probe = document.createElement('span')
  probe.style.color = 'var(--pm-link)'
  document.body.appendChild(probe)
  const link = getComputedStyle(probe).color
  probe.remove()
  const fs = getComputedStyle(focused)
  const ps = getComputedStyle(plain)
  return { border: fs.borderTopColor, shadow: fs.boxShadow, plainBorder: ps.borderTopColor, plainShadow: ps.boxShadow, link }
})
check('聚焦 = 纯蓝边框（选中不新增阴影，未选中仍是灰边）',
  focusStyle !== null && focusStyle.border === focusStyle.link && focusStyle.shadow === focusStyle.plainShadow && focusStyle.plainBorder !== focusStyle.link,
  JSON.stringify(focusStyle))
await navStep('prev')
await page.waitForTimeout(550)
check('再退 → 第 2 步 = 编码 #2（RETRY 的第二次）',
  /第 2 \/ 4 步/.test(await navPos()) && (await navNodeText()).includes('编码') && (await navNodeText()).includes('#2') && (await activePick()) === '#2 pass',
  `${await navPos()} · ${await navNodeText()} · ${await activePick()}`)
await navStep('prev')
await page.waitForTimeout(550)
check('退到链头：第 1 / 4 步、prev 禁用',
  /第 1 \/ 4 步/.test(await navPos()) && (await navNodeText()).includes('编码') && (await navNodeText()).includes('#1') && (await navBtnState('prev')).disabled === true,
  `${await navPos()} prev=${JSON.stringify(await navBtnState('prev'))}`)
check('链头：选择条高亮 #1、聚焦描边在 code', (await activePick()) === '#1 fail' && (await focusNodeIds()) === 'node:code')
await navStep('next')
await page.waitForTimeout(400)
check('链头前进恢复可用 → 回到第 2 步', /第 2 \/ 4 步/.test(await navPos()))
// 画布点节点 → 链位同步到该节点**最后一次**执行（与「换节点回到最近一次」一致）
await page.locator('.react-flow__node[data-id="node:code"]').click()
await page.waitForTimeout(400)
check('画布点 code → 链位同步到编码最后一次（第 2 / 4 步、#2）',
  /第 2 \/ 4 步/.test(await navPos()) && (await navNodeText()).includes('#2'),
  `${await navPos()} · ${await navNodeText()}`)
// 没跑过的节点（相位 0 没有 review 行）不动链位——否则导航条被打成禁用的「—」
await page.locator('.react-flow__node[data-id="node:review"]').click()
await page.waitForTimeout(400)
check('画布点未执行节点 → 链位保持（导航条仍指向编码 #2）',
  /第 2 \/ 4 步/.test(await navPos()) && (await navNodeText()).includes('编码'),
  `${await navPos()} · ${await navNodeText()}`)
// 聚焦要把视口对过去：聚焦节点中心 ≈ 画布中心（容差 25% 画布宽高）
await navStep('prev')
await page.waitForTimeout(600)
const focusCenter = await page.evaluate(() => {
  const canvas = document.querySelector('[data-workflow-canvas]')
  const node = document.querySelector('.wf-stage-card--run-focus')
  if (!canvas || !node) return null
  const c = canvas.getBoundingClientRect()
  const n = (node.closest('.react-flow__node') ?? node).getBoundingClientRect()
  return { dx: Math.abs(n.left + n.width / 2 - (c.left + c.width / 2)), dy: Math.abs(n.top + n.height / 2 - (c.top + c.height / 2)), w: c.width, h: c.height }
})
check('后退触发画布定位：聚焦节点居中于视口（容差 25%）',
  focusCenter !== null && focusCenter.dx < focusCenter.w * 0.25 && focusCenter.dy < focusCenter.h * 0.25,
  JSON.stringify(focusCenter))

// ── §2：真实侧边栏路径（RoutineCenter → 点行直达详情页）──
// 前缀键 bug（runViewKey 存了 `workflow:` 行键、查找用裸 id）就是这条路径上
// 的——探针必须走用户走的路，不能只挂 Modal。2026-11-17 裁定：行点击直达
// 详情页，行内展开面退场，不再有「查看运行图」中间入口。
await page.evaluate(() => window.__mountCenter())
await page.waitForSelector('.routine-run-row')
await page.waitForTimeout(400)
const runRow = page.locator('.routine-run-row', { hasText: '编码流水线' }).first()
await runRow.click()
await page.waitForSelector('.react-flow__node', { timeout: 8000 })
check('真实路径：行点击直达（无展开面、无「查看运行图」中间钮）', (await page.locator('button', { hasText: '查看运行图' }).count()) === 0)
check('真实路径：运行页打开且画布在', (await page.locator('[data-workflow-run-panel]').count()) === 1)
// 首屏取景在真实入口上同样成立（面板宽度 60% 落位 + 防抖重取景之后）。
await page.waitForTimeout(500)
const framingReal = await measureFraming()
check(
  '真实路径：首屏居中且不放大',
  framingReal.scale > 0 &&
    framingReal.scale <= 1.001 &&
    Math.abs(framingReal.dx) <= 16 &&
    Math.abs(framingReal.dy) <= 16 &&
    framingReal.inside,
  `scale=${framingReal.scale} dx=${framingReal.dx.toFixed(1)} dy=${framingReal.dy.toFixed(1)}`,
)
check('真实路径：次数徽标在（test 2 次，running 那次也计数）',
  ((await page.locator('.react-flow__node[data-id="node:test"] .wf-run-badge').innerText()) || '').trim() === '2 次')
check('真实路径：标题带状态', ((await page.evaluate(() => document.body.innerText)) || '').includes('运行中'))
check('节点详情面板在（真实路径）', (await page.locator('[data-workflow-run-panel]').count()) === 1)
// 默认选中 = 最后一个有执行记录的节点（夹具里是 test，执行了 2 次）——
// 面板顶部有执行次数选择条，内容默认最近一次（运行中）。
check('默认选中最后有记录的节点：执行次数选择条在', ((await page.locator('[data-workflow-run-panel]').innerText()) || '').includes('该节点执行了 2 次'))
check('默认选中内容 = 最近一次（运行中提示）', ((await page.locator('[data-workflow-run-panel]').innerText()) || '').includes('该阶段仍在执行'))
check('截图前运行页仍在场', (await page.locator('[data-workflow-run-panel]').count()) === 1)
await page.waitForTimeout(3200)
check('一次 3s 轮询后运行页仍在（轮询不顶飞运行图）', (await page.locator('[data-workflow-run-panel]').count()) === 1)

// ── §4 视口持久性（user 2026-11-15「只刷新内容，不要改变位置和比例」）──
// 平移 + 滚轮缩放，跨一次 3s 轮询后 viewport 的 transform 必须逐字符一致——
// 内容（节点状态/边高亮）照常刷，视口一动不动。
const viewportTransform = () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '')
const paneBox = await page.locator('.react-flow__pane').boundingBox()
await page.mouse.move(paneBox.x + paneBox.width - 60, paneBox.y + paneBox.height - 60)
await page.mouse.down()
await page.mouse.move(paneBox.x + paneBox.width - 220, paneBox.y + paneBox.height - 160, { steps: 6 })
await page.mouse.up()
await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
await page.mouse.wheel(0, -240)
await page.waitForTimeout(300)
const tfBefore = await viewportTransform()
check('平移+缩放确实发生了（transform 非初始）', tfBefore !== '' && !tfBefore.includes('translate(0px, 0px)'))
await page.waitForTimeout(3400)
const tfAfter = await viewportTransform()
check('跨轮询视口不变（transform 逐字符一致）', tfBefore === tfAfter, `before=${tfBefore} after=${tfAfter}`)

// §4b 分隔条：向左拖 80px，面板变宽（user 2026-11-16「允许调整宽度」）
const divider = await page.locator('[data-workflow-run-divider]').boundingBox()
const widthBefore = await page.evaluate(() => document.querySelector('[data-workflow-run-panel]')?.getBoundingClientRect().width ?? 0)
await page.mouse.move(divider.x + divider.width / 2, divider.y + 300)
await page.mouse.down()
await page.mouse.move(divider.x + divider.width / 2 - 80, divider.y + 300, { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(200)
const widthAfter = await page.evaluate(() => document.querySelector('[data-workflow-run-panel]')?.getBoundingClientRect().width ?? 0)
check('拖分隔条面板变宽（≈80px）', widthAfter - widthBefore > 60 && widthAfter - widthBefore < 100, `before=${widthBefore.toFixed(0)} after=${widthAfter.toFixed(0)}`)
await page.screenshot({ path: join(SHOTS, 'run-view-from-sidebar.png') })

// ── §3.5 点谁看谁：多次执行选择条 → 画布点节点 → START/DONE ──
// 拖宽面板后画布变窄、节点随旧 transform 出了视口——先 fitView 复位再点。
await page.locator('.react-flow__controls-fitview').click()
await page.waitForTimeout(400)
// 默认选中 test（2 次），选 #1（fail，有落库会话）→ 错误块 + 转写。
await page.locator('[data-workflow-run-panel] button', { hasText: '#1' }).first().click()
await page.waitForTimeout(400)
const pickText = await page.locator('[data-workflow-run-panel]').innerText()
check('多次执行：选 #1 显示错误块', pickText.includes('2 个用例失败'))
check('多次执行：#1 是落库转写（只读）', pickText.includes('阶段结论'))
// 点画布上的 code 节点 → 它的转写（user 2026-11-17「点谁看谁」）
await page.locator('.react-flow__node[data-id="node:code"]').click()
await page.waitForTimeout(400)
check('画布点节点 → 该节点转写', ((await page.locator('[data-workflow-run-panel]').innerText()) || '').includes('阶段结论'))
// ── §3.6 转写落点（user 2026-11-17「点击节点后，定位到会话的尾部」）──
// 滚动容器是面板里 StageTranscript 的外层 div（TranscriptView 根节点在块流里
// 高度自适应，永远不滚）——所以 tail-follow 在这条宿主上是空转，落点完全由
// scrollTop 决定。换节点/换执行 = 同一个 DOM 节点换内容，浏览器会保留期望偏移：
// 落点必须是**会话尾部**（最新一条输出），不是开头。
const transcriptScroll = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-workflow-run-panel]')
    const all = []
    const visit = (el) => {
      if (el.clientHeight > 50 && el.scrollHeight > el.clientHeight + 1) all.push(el)
      for (const c of el.children) visit(c)
    }
    if (panel) visit(panel)
    if (all.length === 0) return null
    const el = all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    return { st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, n: all.length, tag: el.tagName }
  })
const scrollTranscriptTo = (where) =>
  page.evaluate((w) => {
    const panel = document.querySelector('[data-workflow-run-panel]')
    const all = []
    const visit = (el) => {
      if (el.clientHeight > 50 && el.scrollHeight > el.clientHeight + 1) all.push(el)
      for (const c of el.children) visit(c)
    }
    if (panel) visit(panel)
    if (all.length === 0) return null
    const el = all.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    el.scrollTop = w === 'bottom' ? el.scrollHeight : 0
    return Math.round(el.scrollTop)
  }, where)
const scrolledToBottom = await scrollTranscriptTo('bottom')
check('转写可滚动（fixture 足够长，落点才有意义）', scrolledToBottom !== null && scrolledToBottom > 200, `st=${scrolledToBottom}`)
// 先把上一段手动拉回开头：否则「换完仍在底部」什么都证明不了（这里本来就在
// 底部，而旧行为是顶部——不拉回去的话，即使实现退化成「什么都不做」也会绿）。
const scrolledToTop = await scrollTranscriptTo('top')
check('测试前置：上一段被手动拉回开头', scrolledToTop !== null && scrolledToTop <= 2, `st=${scrolledToTop}`)
// 换执行 = 换 convId（与点另一个节点同一条路径：同一个 StageTranscript 实例换内容）。
await page.locator('[data-workflow-run-panel] button', { hasText: '#1' }).first().click()
// 等新转写真的铺满（中间那一帧 restoring 是空壳，量它没有意义）。
await page.waitForFunction(() => {
  const panel = document.querySelector('[data-workflow-run-panel]')
  const visit = (el) => {
    if (el.clientHeight > 50 && el.scrollHeight > el.clientHeight + 100) return true
    for (const c of el.children) if (visit(c)) return true
    return false
  }
  return panel ? visit(panel) : false
}, { timeout: 5000 })
await page.waitForTimeout(300)
const landed = await transcriptScroll()
check(
  '换节点/换执行后转写落在会话尾部（scrollTop + 视口 ≈ scrollHeight）',
  landed !== null && landed.st + landed.ch >= landed.sh - 4,
  JSON.stringify(landed),
)
// 工具块的结算态（user 2026-11-17「很多 tool use 执行状态未知」）：落库行没有
// status，只有配对的 tool_result——转写必须回填 completed（勾），不得停在
// 「执行状态未知」（灰色下箭头 + 文案）。
const panelTextAfterNode = (await page.locator('[data-workflow-run-panel]').innerText()) || ''
check('阶段转写无「执行状态未知」', !panelTextAfterNode.includes('执行状态未知'))
check(
  '落库工具块回填为已结算（勾形，不是未知箭头）',
  (await page.locator('[data-workflow-run-panel] .anticon-check').count()) >= 1 &&
    (await page.locator('[data-workflow-run-panel] .anticon-arrow-down').count()) === 0,
)
// 点开始芯片 → 任务初始要求（objective + inputs）
await page.locator('.react-flow__node[data-id="terminal:START"]').click()
await page.waitForTimeout(300)
const startText = await page.locator('[data-workflow-run-panel]').innerText()
check('点开始芯片 → 任务初始要求（目标）', startText.includes('任务初始要求') && startText.includes('把计划落地'))
check('点开始芯片 → 运行变量', startText.includes('topic'))
// 三刀：选中芯片同款蓝边（与任务卡同一语义），且只挂被选中的那一个。
const chipFocus = async (kind) =>
  page.locator(`.react-flow__node[data-id="terminal:${kind}"] .wf-terminal--run-focus`).count()
check('点开始芯片 → START 亮选中蓝边（DONE 没有）',
  (await chipFocus('START')) === 1 && (await chipFocus('DONE')) === 0,
  `start=${await chipFocus('START')} done=${await chipFocus('DONE')}`)
// 点结束芯片 → 最终结果（run 级结论优先）
await page.locator('.react-flow__node[data-id="terminal:DONE"]').click()
await page.waitForTimeout(300)
check('点结束芯片 → 最终结果（run 级结论优先）', ((await page.locator('[data-workflow-run-panel]').innerText()) || '').includes('报告已生成：reports/weekly.md'))
check('点结束芯片 → 蓝边换到 DONE（START 的已摘）',
  (await chipFocus('DONE')) === 1 && (await chipFocus('START')) === 0,
  `start=${await chipFocus('START')} done=${await chipFocus('DONE')}`)

// ── §3.6 头部动作与产物点开（2026-11-18）──
// 判据不是「按钮画出来了」，而是**真点到了哪条 IPC、参数是什么**：停止要打到
// 这个 runId，续跑/重跑要带对 mode（主进程按 mode 决定是否铸 resume），产物要
// 带着工作区根拼出的绝对路径去 openFolder。续跑还有三档状态：可用 / 回滚过
// 基线（置灰）/ 无已完成前序（置灰）——后两档只靠 run 对象区分，所以三种运行态
// 都要演一遍。
const actionLog = () => page.evaluate(() => window.__actionLog())
const clearActions = () => page.evaluate(() => window.__clearActionLog())
const headerBtn = (text) =>
  page.evaluate((label) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === label)
    return b ? { disabled: !!b.disabled } : null
  }, text)
const clickHeader = (text) => page.locator('button', { hasText: text }).first().click()

// ① 运行中：只有停止
check('运行中：头部有停止钮', (await headerBtn('停止运行')) !== null)
check(
  '运行中：不给重跑/续跑（先停止再说）',
  (await headerBtn('重跑本次')) === null && (await headerBtn('从失败节点续跑')) === null,
)
await clearActions()
await clickHeader('停止运行')
await page.waitForTimeout(250)
const stopLog = await actionLog()
check(
  '点停止 → pipelineStop(本 runId)',
  JSON.stringify(stopLog) === JSON.stringify([{ fn: 'pipelineStop', args: ['prun_v'] }]),
  JSON.stringify(stopLog),
)

// ② 产物 chip：相对路径挂到工作区根下再交给 openFolder
await page.locator('.react-flow__node[data-id="node:code"]').click()
await page.waitForTimeout(400)
check(
  'code 节点面板列出本次执行的交付物',
  (await page.locator('[data-workflow-artifact="src/a.ts"]').count()) === 1 &&
    (await page.locator('[data-workflow-artifact="src/b.ts"]').count()) === 1,
)
await clearActions()
await page.locator('[data-workflow-artifact="src/a.ts"]').first().click()
await page.waitForTimeout(250)
const artLog = await actionLog()
check(
  '点产物 → openFolder(工作区绝对路径)',
  JSON.stringify(artLog) === JSON.stringify([{ fn: 'openFolder', args: ['/tmp/pm-probe-ws/src/a.ts'] }]),
  JSON.stringify(artLog),
)

// ③ 失败态（有已完成前序）：续跑可用，真点带 resume
await page.evaluate(() => window.__serveRun({ status: 'failed', currentNode: 'test', error: '2 个用例失败' }))
await page.waitForTimeout(3400)
check('失败态：停止钮退场', (await headerBtn('停止运行')) === null)
const resumeBtn = await headerBtn('从失败节点续跑')
check('失败态：续跑与重跑都在', resumeBtn !== null && (await headerBtn('重跑本次')) !== null)
check('失败态（有已完成前序）：续跑可用', resumeBtn !== null && resumeBtn.disabled === false)
await clearActions()
await clickHeader('从失败节点续跑')
await page.waitForTimeout(300)
const resumeLog = await actionLog()
check(
  '点续跑 → pipelineRerun(runId, resume)',
  JSON.stringify(resumeLog) === JSON.stringify([{ fn: 'pipelineRerun', args: ['prun_v', 'resume'] }]),
  JSON.stringify(resumeLog),
)
check('续跑成功提示在', ((await page.locator('body').innerText()) || '').includes('已从失败节点续跑'))

// ④ 回滚过基线：续跑置灰，强点也不发 IPC（前序产物已不在盘上）
await page.evaluate(() =>
  window.__serveRun({ status: 'failed', currentNode: 'test', baselineCommit: 'abc1234' }),
)
await page.waitForTimeout(3400)
const rollbackBtn = await headerBtn('从失败节点续跑')
check('回滚过基线：续跑置灰', rollbackBtn !== null && rollbackBtn.disabled === true)
await clearActions()
await page.locator('button', { hasText: '从失败节点续跑' }).first().click({ force: true })
await page.waitForTimeout(250)
check('置灰的续跑强点不发 IPC', (await actionLog()).length === 0)

// ⑤ 停在第一个节点（无已完成前序）：同样置灰——那与重跑没有区别
await page.evaluate(() => window.__serveRun({ status: 'failed', currentNode: 'code' }))
await page.waitForTimeout(3400)
const noPriorBtn = await headerBtn('从失败节点续跑')
check('无已完成前序：续跑同样置灰', noPriorBtn !== null && noPriorBtn.disabled === true)

// ⑥ 重跑本次：任何失败态都可用，真点带 fresh
await clearActions()
await clickHeader('重跑本次')
await page.waitForTimeout(300)
const freshLog = await actionLog()
check(
  '点重跑本次 → pipelineRerun(runId, fresh)',
  JSON.stringify(freshLog) === JSON.stringify([{ fn: 'pipelineRerun', args: ['prun_v', 'fresh'] }]),
  JSON.stringify(freshLog),
)
// 回到运行中，后续 §4c 的执行推进按原状继续
await page.evaluate(() => window.__serveRun({}))
await page.waitForTimeout(3400)

// ── §4c 执行中连线不消失（user 2026-11-17「在执行过程中，连接线没了」）──
// 真实运行每 3s 轮询换一批 stage 行：节点从「没跑到」→「运行中」→「结算」，
// 卡片高度随之变化、RF 要重测线头。这条链上任何一环丢了几何，路由就跳过那条边
// （routeEdges 的「端点矩形缺席 → 这条边这一帧不画」），表现就是整张图的连线
// 消失。所以判据必须是「每帧都还在」而不是「最终还在」。
//
// 第二个承重点：**在不在** ≠ **看不看得见**。边一直在 DOM 里但 idle 着色淡到
// 接近白底时，用户看到的就是「连线没了」——这正是本 bug 的真因（#cccccc@0.7
// 合成 ~#dbdbdb）。所以每帧还要量「合成后相对白底的亮度差」：faint = 差 < 70
// 的边数（#adadad 差 82 可见、#dbdbdb 差 36 不可见）。判据要求 faint === 0。
const edgeStats = () =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll('.react-flow__edge')]
    const drawn = groups.filter((g) => {
      const p = g.querySelector('path.react-flow__edge-path')
      return !!p && (p.getAttribute('d') ?? '').length > 20
    })
    // 合成色 = 线色按 <g> 的 opacity 压到白底上（画布底是浅色，取最坏的白）。
    const contrast = (g) => {
      const p = g.querySelector('path.react-flow__edge-path')
      if (!p) return 0
      const m = (getComputedStyle(p).stroke || '').match(/\d+(\.\d+)?/g)
      if (!m || m.length < 3) return 0
      const op = Number(getComputedStyle(g).opacity)
      const [r, gg, b] = m.slice(0, 3).map(Number)
      const lum = 0.2126 * (r * op + 255 * (1 - op)) + 0.7152 * (gg * op + 255 * (1 - op)) + 0.0722 * (b * op + 255 * (1 - op))
      return Math.round(255 - lum)
    }
    const faint = groups.filter((g) => contrast(g) < 70)
    return {
      n: groups.length,
      drawn: drawn.length,
      idle: groups.filter((g) => g.classList.contains('wf-edge-idle')).length,
      faint: faint.length,
      faintIds: faint.map((g) => g.getAttribute('data-id')),
    }
  })
const edgesBefore = await edgeStats()
check('执行推进前：四条连线全部在画布上', edgesBefore.n === 4 && edgesBefore.drawn === 4, JSON.stringify(edgesBefore))
check('执行推进前：每条连线都看得见（不淡到白底）', edgesBefore.faint === 0, JSON.stringify(edgesBefore))
// 同一帧里 idle 与 taken 必须可区分（「还没走过」这个信息不能被可见性修掉）。
// 这一帧（相位 0）同时有走着的边与没走的边，是唯一两色并存的形态。
const strokeOf = (cls) =>
  page.evaluate((c) => {
    const g = document.querySelector('.react-flow__edge.' + c)
    const p = g?.querySelector('path.react-flow__edge-path')
    return p ? getComputedStyle(p).stroke : ''
  }, cls)
const idleStroke = await strokeOf('wf-edge-idle')
const takenStroke = await strokeOf('wf-edge-taken')
check('同一帧 idle 与 taken 颜色仍可区分', !!idleStroke && !!takenStroke && idleStroke !== takenStroke, `idle=${idleStroke} taken=${takenStroke}`)
// 刚点开运行图、一行 stage 都还没落：全部边都是 idle——这是 bug 最纯的形态。
await page.evaluate(() => window.__setStagePhase(3))
await page.waitForTimeout(3600)
const edgesStart = await edgeStats()
check('刚开跑（零 stage 行，全部 idle）：四条连线全部在', edgesStart.n === 4 && edgesStart.drawn === 4, JSON.stringify(edgesStart))
check('刚开跑（全部 idle）：四条连线全部看得见', edgesStart.idle === 4 && edgesStart.faint === 0, JSON.stringify(edgesStart))
// 推进一档：test 结算 + review 进入运行中（节点卡多出一行徽标，高度变化）。
await page.evaluate(() => window.__setStagePhase(1))
await page.waitForTimeout(3600) // 跨一次 3s 轮询
const edgesAdv1 = await edgeStats()
check('执行推进（新节点进入运行中）后连线仍在', edgesAdv1.n === 4 && edgesAdv1.drawn === 4, JSON.stringify(edgesAdv1))
check('执行推进后每条连线都看得见', edgesAdv1.faint === 0, JSON.stringify(edgesAdv1))
check('执行推进后新节点亮出次数徽标（review 1 次）', ((await page.locator('.react-flow__node[data-id="node:review"] .wf-run-badge').innerText()) || '').trim() === '1 次')
// 推进二档：全部结算（次数徽标保持、无状态色回潮）。
await page.evaluate(() => window.__setStagePhase(2))
await page.waitForTimeout(3600)
const edgesAdv2 = await edgeStats()
check('执行结束（全部结算）后连线仍在', edgesAdv2.n === 4 && edgesAdv2.drawn === 4, JSON.stringify(edgesAdv2))
check('执行结束（全部结算）后每条连线都看得见', edgesAdv2.faint === 0, JSON.stringify(edgesAdv2))
check('全部结算后次数徽标保持（review 仍 1 次），且无状态色回潮',
  ((await page.locator('.react-flow__node[data-id="node:review"] .wf-run-badge').innerText()) || '').trim() === '1 次' &&
    (await page.locator('.wf-stage-card--run-pass,.wf-stage-card--run-fail,.wf-stage-card--run-running,.wf-stage-card--run-settled').count()) === 0)
await page.evaluate(() => window.__setStagePhase(0))

// ── §3：关闭路径——destroyOnHidden 的收尾动画仍在渲染子组件，run 置空后
// `run!.status` 一类的非空断言会在这几帧炸 TypeError（实测踩过）。
await page.locator('button', { hasText: '返回任务列表' }).first().click()
await page.waitForTimeout(600)
check('返回任务列表后页面退场', (await page.evaluate(() => document.querySelector('[data-workflow-run-panel]') === null)) === true)
const errorsBefore = pageErrors
// 返回列表 = RoutineCenter 重新挂载——行点击直达详情页。
await page.locator('.routine-run-row', { hasText: '编码流水线' }).first().click()
await page.waitForSelector('[data-workflow-run-panel]', { timeout: 8000 })
await page.locator('button', { hasText: '返回任务列表' }).first().click()
await page.waitForTimeout(600)
const errorsAfter = pageErrors
check('开关一轮零页面错误（关闭动画不炸 run 空窗）', errorsAfter === errorsBefore)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exitCode = 1
}
console.log(`screenshots: ${SHOTS}`)
