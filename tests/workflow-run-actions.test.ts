// 运行视图的三个动作（2026-11-18）：停止 / 重跑本次·从失败节点续跑 / 产物点开。
// 这三件事的正确性都不在「按钮画出来了」上，而在三处判断力：
//   1. 产物路径归一——相对路径要挂到工作区根下，绝对路径原样透传；错了不会崩，
//      只会让「点开产物」打开一个不存在的路径。
//   2. 停止的双臂——在飞实例走 stop 钩子，排队实例没有钩子、必须撤销队列并结算
//      run 行，否则点停止只静默无反应、行还挂在 running 上转圈。
//   3. 续跑的三道门——运行中不许、回滚过基线不许（前序产物已不在盘上）、没有
//      已完成的前序阶段不许（那与重跑没区别）；引擎侧的播种语义见
//      workflow-engine.test.ts 的 resume 组。
//
// 引擎/主进程的判断力用行为测，UI 与 IPC 的接线只有源码扫描能抓。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { artifactAbsPath } from '../src/renderer/src/components/routine/run-artifact'

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

describe('artifactAbsPath', () => {
  it('工作区相对路径挂到根下', () => {
    expect(artifactAbsPath('/Users/x/ws', 'out/report.md')).toBe('/Users/x/ws/out/report.md')
    expect(artifactAbsPath('/Users/x/ws', 'a/b/c.png')).toBe('/Users/x/ws/a/b/c.png')
  })

  it('开头的 ./ 被剥掉（模型常这么写）', () => {
    expect(artifactAbsPath('/ws', './out/a.md')).toBe('/ws/out/a.md')
    // 只剥一层：`././x` 不是合法产物路径，保持诚实
    expect(artifactAbsPath('/ws', '././a.md')).toBe('/ws/./a.md')
  })

  it('工作区根的尾斜杠（含多根）不叠出双斜杠', () => {
    expect(artifactAbsPath('/ws/', 'a.md')).toBe('/ws/a.md')
    expect(artifactAbsPath('/ws///', 'a.md')).toBe('/ws/a.md')
    expect(artifactAbsPath('C:\\ws\\', 'a.md')).toBe('C:\\ws/a.md')
  })

  it('POSIX 绝对路径原样透传', () => {
    expect(artifactAbsPath('/ws', '/tmp/x.md')).toBe('/tmp/x.md')
  })

  it('Windows 盘符绝对路径（两种分隔符）原样透传', () => {
    expect(artifactAbsPath('C:\\ws', 'D:\\tmp\\x.md')).toBe('D:\\tmp\\x.md')
    expect(artifactAbsPath('C:\\ws', 'D:/tmp/x.md')).toBe('D:/tmp/x.md')
  })

  it('前后空白被修剪（落库字符串偶尔带空格）', () => {
    expect(artifactAbsPath('/ws', '  a.md  ')).toBe('/ws/a.md')
    expect(artifactAbsPath('/ws', '  /tmp/x.md ')).toBe('/tmp/x.md')
  })

  it('工作区根本身带尾斜杠 + 相对路径带 ./ 同时发生', () => {
    expect(artifactAbsPath('/ws/', './out/a.md')).toBe('/ws/out/a.md')
  })
})

describe('停止：在飞走 stop、排队撤销队列（源码扫描）', () => {
  const handler = read('src/main/ipc/pipeline.handler.ts')

  it('runId 前缀守卫 + stop 命中即真、否则 cancel 结算 run 行', () => {
    expect(handler).toMatch(/if \(!String\(runId \?\? ''\)\.startsWith\('prun_'\)\) return false/)
    expect(handler).toMatch(/if \(pipelineEngine\.stop\(id\)\) return true/)
    // 排队实例没有停止钩子：撤销 + 落失败行，否则行永远挂着 running
    expect(handler).toMatch(/return pipelineEngine\.cancel\(id, '已停止（未启动）'\)/)
  })

  it('运行视图：停止钮只在 running 时出现，false 回落如实提示', () => {
    const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')
    expect(page).toContain('window.electronAPI.pipelineStop(run.id)')
    expect(page).toMatch(/\{run\?\.status === 'running' && \(/)
    expect(page).toContain("t('workflow.runViewStopNoop')")
  })
})

describe('重跑 / 续跑：三道门与 resume 透传（源码扫描）', () => {
  const handler = read('src/main/ipc/pipeline.handler.ts')
  const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')

  it('主进程门：运行中 / 回滚过基线 / 无已完成前序阶段', () => {
    expect(handler).toMatch(/if \(prev\.status === 'running'\) throw new Error\('该运行还在进行中，先停止再重跑'\)/)
    expect(handler).toMatch(/if \(prev\.baselineCommit\) \{/)
    expect(handler).toMatch(/if \(!settledBefore\) throw new Error\('没有可复用的已完成阶段，续跑与重跑没有区别'\)/)
    // 前序阶段 = 不是起点、有 verdict、没有 error
    expect(handler).toMatch(/s\.nodeId !== nodeId && !!s\.verdict && !s\.error/)
  })

  it('resume 只在续跑臂铸出并透传给 launch（fresh 不带）', () => {
    expect(handler).toMatch(/resume = \{ fromRunId: id, nodeId \}/)
    expect(handler).toMatch(/\.\.\.\(resume \? \{ resume \} : \{\}\)/)
    expect(handler).toMatch(/pipelineRunStore\.getRun\(id\)/)
    expect(handler).toMatch(/workflowStore\.get\(prev\.workflowId\)/)
  })

  it('渲染端：续跑常驻但按 resumeBlocked 置灰，Tooltip 说明原因', () => {
    // 回滚优先于「无前序」——回滚过的运行里前序阶段行是有的，只是产物没了
    expect(page).toMatch(/if \(!run \|\| run\.status !== 'failed'\) return 'noPrior'/)
    expect(page).toMatch(/if \(run\.baselineCommit\) return 'rollback'/)
    expect(page).toMatch(/if \(!run\.currentNode\) return 'noPrior'/)
    expect(page).toMatch(/const hasPrior = stages\.some\(\(s\) => s\.nodeId !== run\.currentNode && !!s\.verdict && !s\.error\)/)
    expect(page).toContain('disabled={resumeBlocked !== null')
    expect(page).toContain("t('workflow.runViewResumeBlockedRollback')")
    expect(page).toContain("t('workflow.runViewResumeBlockedNoPrior')")
    // 置灰的 antd Button 不派发鼠标事件，Tooltip 必须挂外层 span
    expect(page).toMatch(/<span>[\s\S]{0,500}runViewResume'\)[\s\S]{0,80}<\/span>/)
  })

  it('渲染端：重跑本次/续跑都打同一个 pipelineRerun，模式区分', () => {
    expect(page).toContain('window.electronAPI.pipelineRerun(run.id, mode)')
    expect(page).toContain("onClick={() => void onRerun('resume')}")
    expect(page).toContain("onClick={() => void onRerun('fresh')}")
    // 新实例 → 跳到新 runId（用户要看的是这次新跑的过程）
    expect(page).toMatch(/navigate\(\{ kind: 'routines', workflowRunViewId: res\.runId \}\)/)
  })
})

describe('产物点开（源码扫描）', () => {
  const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')

  it('纯函数已提出组件（可单测），页面只 import 不再本地定义', () => {
    expect(page).toContain("import { artifactAbsPath } from './run-artifact'")
    expect(page).not.toMatch(/function artifactAbsPath/)
  })

  it('产物 chip 走 openFolder（系统默认程序打开，不是 Finder 里选中）', () => {
    expect(page).toContain('data-workflow-artifact={a}')
    expect(page).toContain('window.electronAPI.openFolder(artifactAbsPath(workspaceDir, rel))')
    // 主进程的失败（缺失路径/可执行黑名单）要显示出来，不吞
    expect(page).toMatch(/message\.error\(err instanceof Error \? err\.message : String\(err\)\)/)
  })
})

describe('IPC 四面 + i18n 两 locale', () => {
  it('channels / preload / bridge 三面同在', () => {
    const channels = read('src/shared/ipc-channels.ts')
    expect(channels).toContain("PIPELINE_STOP: 'pipeline:stop'")
    expect(channels).toContain("PIPELINE_RERUN: 'pipeline:rerun'")
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('pipelineStop: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_STOP, runId)')
    expect(preload).toContain("pipelineRerun: (runId: string, mode: 'fresh' | 'resume') => ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RERUN, runId, mode)")
    const bridge = read('src/shared/types/electron-bridge.ts')
    expect(bridge).toContain('pipelineStop: (runId: string) => Promise<boolean>')
    expect(bridge).toContain("pipelineRerun: (runId: string, mode: 'fresh' | 'resume') => Promise<{ runId: string }>")
  })

  it('文案键中英同批存在（含两种续跑阻断的原因）', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const key of [
      'runViewArtifactOpen',
      'runViewStop',
      'runViewStopNoop',
      'runViewRerun',
      'runViewRerunStarted',
      'runViewResume',
      'runViewResumeStarted',
      'runViewResumeBlockedRollback',
      'runViewResumeBlockedNoPrior',
    ]) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
  })
})

// ── 执行链导航（user 2026-11-20「右栏前进/后退顺着执行链路走」）──
// 纯推导在 workflow-run-view.test.ts 有行为单测；UI 与画布的接线只有源码扫描
// 能抓：链位状态、落到正确运行次数、画布定位 prop 与聚焦描边、i18n 键。
describe('执行链导航：右栏前进/后退 + 画布定位（源码扫描）', () => {
  const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')
  const canvas = read('src/renderer/src/components/routine/WorkflowCanvas.tsx')
  const card = read('src/renderer/src/components/routine/WorkflowNodeCard.tsx')

  it('页面：链推导来自 run-view 纯函数，链位/聚焦两条状态在', () => {
    expect(page).toContain("import { runExecutionChain, verdictKindOf } from '../../../../shared/workflow/run-view'")
    expect(page).toContain('const chain = useMemo(() => runExecutionChain(stages), [stages])')
    expect(page).toContain('const [chainIndex, setChainIndex] = useState<number | null>(null)')
    expect(page).toContain('const [runFocus, setRunFocus] = useState<{ nodeId: string; nonce: number } | null>(null)')
    // 重跑/续跑换 runId 时随既有 reset 块清干净，不把旧运行的链位带给新实例
    expect(page).toMatch(/setExecPick\(null\)[\s\S]{0,120}setChainIndex\(null\)[\s\S]{0,60}setRunFocus\(null\)/)
  })

  it('页面：导航落到该次运行 + 画布定位（goToStep 三件套）', () => {
    // visit 是 1 起，execPick 是 0 起——差一就是错运行
    expect(page).toMatch(/setSel\(\{ kind: 'node', nodeId: step\.nodeId \}\)[\s\S]{0,120}setExecPick\(step\.visit - 1\)/)
    expect(page).toMatch(/setRunFocus\(\{ nodeId: step\.nodeId, nonce: focusNonce\.current \}\)/)
    expect(page).toContain('runFocus={runFocus ?? undefined}')
    // 默认选中落链尾；点节点回落该节点最后一次执行（与「换节点回到最近一次」
    // 同语义），还没跑过的节点不动链位（否则导航条被打成一坨禁用的「—」）
    expect(page).toContain('setChainIndex(orderedStages.length - 1)')
    expect(page).toMatch(/setExecPick\(null\) \/\/ 换节点回到最近一次[\s\S]{0,260}if \(idx !== null\) setChainIndex\(idx\)/)
  })

  it('页面：两端钳制不回绕，prev/next 的 onClick 各走各向', () => {
    expect(page).toMatch(/disabled=\{!currentStep \|\| \(chainIndex \?\? 0\) <= 0\}/)
    expect(page).toMatch(/disabled=\{!currentStep \|\| \(chainIndex \?\? 0\) >= chain\.length - 1\}/)
    expect(page).toContain('onClick={() => goToStep((chainIndex ?? 1) - 1)}')
    expect(page).toContain('onClick={() => goToStep((chainIndex ?? -1) + 1)}')
    // 手选 #i 选择条时链位同步（导航条与面板同源）
    expect(page).toMatch(/const idx = chainIndexFor\(sel\.nodeId, i\)/)
  })

  it('画布：runFocus prop 在，定位走 fitView(nodes) 并接管视口', () => {
    expect(canvas).toContain('runFocus?: { nodeId: string; nonce: number }')
    // 定位的 id 必须是 RF 节点 id（stageNodeId 前缀），不是 def 节点 id
    expect(canvas).toMatch(/const id = stageNodeId\(runFocusNodeId\)/)
    expect(canvas).toMatch(/rfFitView\(\{ nodes: \[\{ id \}\], duration: 300, padding: 0\.2, maxZoom: 1 \}\)/)
    // nonce 记账：同一次导航只拍一次，轮询重建 nodes 不得把视口反复拽回
    expect(canvas).toMatch(/appliedFocusNonce\.current = runFocusNonce/)
    // 聚焦是显式用户动作：落定后接管视口，resize 的全图 fitView 不再拽回
    expect(canvas).toMatch(/appliedFocusNonce[\s\S]{0,200}userMovedViewport\.current = true/)
  })

  it('选中蓝边（user 2026-11-20 二刀）：runSelectedNodeId 与定位分离，导航步与画布点选都亮', () => {
    // 两个 prop 各管一件事：runFocus 管视口移动，runSelectedNodeId 管蓝边
    expect(canvas).toContain('runSelectedNodeId?: string')
    // 页面把「面板选中的节点」直接下发——点选与导航步都落在这里
    expect(page).toContain('runSelectedNodeId={sel?.kind === \'node\' ? sel.nodeId : undefined}')
    // 节点重建跟着选中走（描边换人的那一拍就要生效）
    expect(canvas).toMatch(/buildFlowNodes\(def, t, openNode, requestDeleteNode, runView, runSelectedNodeId, runSelectedTerminal\)/)
    expect(canvas).toMatch(/\[def, setNodes, openNode, requestDeleteNode, runView, runSelectedNodeId, runSelectedTerminal\]/)
  })

  it('三刀：开始/结束芯片同灰、聚焦只剩蓝边框、选中芯片也亮蓝边', () => {
    // 芯片同灰（user 2026-11-20 三刀「开始和结束节点也设为灰色」）：运行态的
    // 实例终态色（绿/红/蓝）退役，灰边基底在 .wf-terminal（四刀后定义/运行
    // 两视图同源，见下一条用例）
    expect(canvas).not.toContain('.wf-terminal--run-success')
    expect(canvas).not.toContain('.wf-terminal--run-failed')
    expect(canvas).not.toContain('.wf-terminal--run-running')
    // 卡片侧不再产出实例状态类，改产出选中类
    expect(card).not.toMatch(/wf-terminal--run-(running|success|failed)/)
    expect(card).not.toContain('runStatus')
    expect(card).toContain("data.focused ? ' wf-terminal--run-focus' : ''")
    // 选中的开始/结束芯片与任务卡同语义亮蓝边（sel 的 start/done 两臂）
    expect(canvas).toContain("runSelectedTerminal?: 'start' | 'done'")
    expect(page).toContain("runSelectedTerminal={sel?.kind === 'start' ? 'start' : sel?.kind === 'done' ? 'done' : undefined}")
    expect(canvas).toContain('.wf-runmode .wf-terminal.wf-terminal--run-focus { border-color: var(--pm-link); }')
    // 聚焦 = 纯蓝边框（user 2026-11-20 三刀「不需要阴影扩散效果」）：双环/外晕退役
    expect(canvas).toContain('.wf-stage-card--run-focus { border-color: var(--pm-link); }')
    expect(canvas).not.toMatch(/\.wf-stage-card--run-focus \{[^}]*box-shadow/)
    expect(canvas).not.toContain('color-mix(in srgb, var(--pm-link) 22%')
    // 悬停不再变蓝（蓝 = 选中语义，hover 换色会与选中混淆）
    expect(canvas).not.toContain('.wf-runmode .wf-terminal:hover')
  })

  it('四刀：定义视图的开始/结束芯片也走同一灰边基底（身份色退役）', () => {
    // user 2026-11-20 四刀「在编辑状态下，这两个节点也设为灰色」：灰边不再是
    // 运行态覆盖，而是 .wf-terminal 的基底——两视图同一套 hairline 灰 + 次级灰字
    // （按整段声明钉：规则体里的 ${TERMINAL_CHIP_W} 插值带 `}`，[^}] 正则过不去）
    expect(canvas).toContain('padding: 9px 18px; border-radius: 12px; border: 1px solid var(--pm-border-hairline);')
    expect(canvas).toContain('background: var(--pm-elevated); box-shadow: var(--pm-shadow-soft); cursor: default;\n    color: var(--pm-text-secondary);')
    // 开始蓝/结束绿的身份色整体退役，也不再留运行态灰边覆盖
    expect(canvas).not.toContain('.wf-terminal.done')
    expect(canvas).not.toContain('.wf-terminal.start')
    expect(canvas).not.toMatch(/\.wf-terminal[^{]*\{[^}]*pm-success/)
    expect(canvas).not.toContain('.wf-runmode .wf-terminal { border-color')
    // 类名仍是语义锚点（start/done 只挂类、不带配色）
    expect(card).toContain("START: 'wf-terminal start'")
    expect(card).toContain("DONE: 'wf-terminal done'")
  })

  it('卡面灰边制 + 次数徽标（user 2026-11-20 二刀）：状态色/状态徽标退役', () => {
    // 一律灰边（基底即灰），唯一状态类只剩 idle 弱化与选中的蓝描边
    expect(canvas).not.toContain('wf-stage-card--run-pass')
    expect(canvas).not.toContain('wf-stage-card--run-fail')
    expect(canvas).not.toContain('wf-stage-card--run-running')
    expect(canvas).not.toContain('wf-stage-card--run-settled')
    expect(card).toContain("wf-stage-card--runview${(runCount ?? 0) === 0 ? ' wf-stage-card--run-idle' : ''}")
    expect(card).toContain("focused ? ' wf-stage-card--run-focus' : ''")
    expect(canvas).toContain('focused: n.id === highlightNodeId')
    // 徽标 = 次数（runCountLabel 由画布 i18n 下发），没跑过不给
    expect(card).toContain('runCount?: number')
    expect(canvas).toContain("t('workflow.runBadgeCount', { count: visitCounts.get(n.id) ?? 0 })")
    expect(canvas).toContain('runVisitCounts(runView.stages)')
  })

  it('文案键中英同批存在', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const key of ['runPanelNavPrev', 'runPanelNavNext', 'runPanelNavPos']) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
  })
})
