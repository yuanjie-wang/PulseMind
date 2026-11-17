// PLAN-workflow-engine：wiring 扫描——pipe_ 前缀隐藏名单、IPC 通道、preload
// 面、bootstrap（registerPipelineHandlers）、RoutineCenter 工作流区挂载、
// 助手入口无密钥置灰服务端兜底、轮询与停止 wiring。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('pipeline wiring', () => {
  const conversationDb = read('src/main/storage/conversation.db.ts')
  const ipcIndex = read('src/main/ipc/index.ts')
  const ipcChannels = read('src/shared/ipc-channels.ts')
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')
  const handler = read('src/main/ipc/pipeline.handler.ts')
  const engine = read('src/main/pipeline/pipeline-engine.ts')

  it('pipe_ 会话前缀进 conversation type 派生隐藏名单（routine_ 同款）', () => {
    expect(conversationDb).toMatch(/\('pipe_'\)\) return 'routine'/)
  })

  it('五个 PIPELINE 通道：channels / preload / bridge / handler 四面同在', () => {
    for (const name of ['PIPELINE_WORKFLOWS', 'PIPELINE_RUN', 'PIPELINE_STOP', 'PIPELINE_RUNS', 'PIPELINE_BATCH_RUN']) {
      expect(ipcChannels).toContain(`${name}:`)
    }
    for (const fn of ['pipelineWorkflows', 'pipelineRun', 'pipelineStop', 'pipelineRuns', 'pipelineBatchRun']) {
      expect(preload).toContain(fn)
      expect(bridge).toContain(fn)
    }
    expect(handler).toContain('PIPELINE_WORKFLOWS')
    // 助手不再是独立通道（2026-11-08）：向导助手栏与 routine 共用
    // FormAssistColumn 的会话形态，提案走 ```form-patch，没有第二个入口。
    expect(ipcChannels).not.toContain('PIPELINE_ASSIST')
    expect(preload).not.toContain('pipelineAssist')
    expect(bridge).not.toContain('pipelineAssist')
  })

  it('bootstrap：registerPipelineHandlers 挂进 ipc/index 且 handler 里播种模板', () => {
    expect(ipcIndex).toContain('registerPipelineHandlers()')
    expect(handler).toContain('seedWorkflowTemplates()')
  })

  it('引擎纪律：runRowId 前缀守卫（STOP）+ 每阶段独立 pipe_ 会话 + gitCheckpoint 自动降级（有 git 就用）', () => {
    expect(read('src/main/ipc/pipeline.handler.ts')).toContain("startsWith('prun_')")
    expect(engine).toContain('mintStageConvId')
    // git 从门槛降级为增强（user 2026-11-15）：缺省自动探测，显式 false 才硬关。
    expect(engine).toContain('workflow.params?.gitCheckpoint !== false')
    // stageTimeoutMinutes: 0 = 永不超时（user 2026-11-17）：计时器不武装，
    // finish 的 clearTimeout 对 undefined 是无害 no-op。
    expect(engine).toContain('const timeout = timeoutMs > 0')
  })

  it('任务中心混排两类卡片 + 三处同一校验门（save/启动/助手应用）', () => {
    const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
    // P3：混排卡片挂两类数据源与双编辑路由（routineEditing/workflowEditing）。
    expect(center).toContain('pipelineWorkflows')
    expect(center).toContain('workflowEditing: true')
    expect(center).toContain('routineEditing: true')
    expect(read('src/main/storage/workflow-store.ts')).toMatch(/validateWorkflow\(def\)/)
    // 助手提案落地前过同一道门（2026-11-08：一次性管道助手退场，改由向导在
    // 应用补丁时校验——不合法标记错误、退回内容步、不推 undo 帧）。
    expect(read('src/renderer/src/components/routine/TaskWizardPage.tsx')).toMatch(/validateWorkflow\(normalized\)/)
    expect(handler).toMatch(/validateWorkflow\(def\)/)
  })

  it('运行记录 3s 轮询 + 停止按钮 wiring（UnifiedRunsSidebar / WorkflowRunModal）', () => {
    const sidebar = read('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')
    expect(sidebar).toContain('RUNS_POLL_MS = 3_000')
    expect(sidebar).toContain('pipelineStop')
    expect(sidebar).toContain('stopRoutineRun')
    // 行悬停 = pane-row 同款惯例（user 2026-11-15「近期运行悬停样式需要修改」）：
    // 可点行 hover 背景 + pointer，停止钮 hover 显形——className 不能只是挂名。
    expect(sidebar).toContain('.routine-run-row:hover { background: var(--pm-hover-faint); }')
    expect(sidebar).toContain('.routine-run-row:hover .routine-run-stop')
    // JSON UI 已退出（user 2026-11-08）：CodeMirror/助手不回任何列表面。
    expect(sidebar).not.toContain('CodeMirrorEditor')
    // 助手入口随向导走，且是共享的会话栏（不是 workflow 专属的一发式面板）。
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).toContain('FormAssistColumn')
    expect(wizard).not.toContain('pipelineAssist')
  })

  it('运行视图 wiring：workflow 行点击直达详情页，行内展开面退场（user 2026-11-15/17）', () => {
    const sidebar = read('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')
    // 行点击即导航（整页运行视图，user 2026-11-16；2026-11-17 裁定不再两步展开）
    expect(sidebar).toContain("navigate({ kind: 'routines', workflowRunViewId: row.id })")
    // 行内展开面整块退场：无展开态、无 stage 行、无「查看运行图」中间入口。
    expect(sidebar).not.toContain('setExpanded')
    expect(sidebar).not.toContain('stagesOf')
    expect(sidebar).not.toContain('runViewOpen')
    expect(sidebar).not.toContain('noStages')
    // 详情页按 runId 自取数：run id 只来自 row.id（裸 id，不带 `workflow:` 行键前缀）。
    expect(sidebar).toContain('workflowRunViewId: row.id')
    // 入口把 run 的裸 id（row.id，不带行键的 `workflow:` 前缀）直接交给导航
    // ——页面按 runId 自取数，前缀一挂就是永远找不到（前缀键 bug 的教训）。
    // 画布侧：runView 在场 = 运行查看态（编辑面退场 + 状态叠加）。
    const canvas = read('src/renderer/src/components/routine/WorkflowCanvas.tsx')
    expect(canvas).toContain('runView?')
    expect(canvas).toContain('nodesDraggable={!runMode}')
    expect(canvas).toContain('runNodeStates')
    expect(canvas).toContain('runTakenEdges')
    // 节点卡：运行态编辑/删除钮退场。
    const card = read('src/renderer/src/components/routine/WorkflowNodeCard.tsx')
    expect(card).toContain('!runMode &&')
  })

  it('启动恢复 + git 看门狗 + FIFO 异常兜底（user 2026-11-15 孤儿 running 实测）', () => {
    // ① 启动恢复：上一进程遗留的 running 行在启动时落为 failed（FIFO/停止钩子
    //    已随进程消失，没人结算它们）。
    const store = read('src/main/storage/pipeline-run-store.ts')
    expect(store).toContain("failStaleRunning(reason: string)")
    expect(store).toContain("WHERE status = 'running'")
    const handler = read('src/main/ipc/pipeline.handler.ts')
    expect(handler).toContain("failStaleRunning('应用重启，运行中断')")
    // ② git 看门狗：门/基线的 git 挂死不该永久卡住 FIFO。
    const git = read('src/main/pipeline/git-checkpoint.ts')
    expect(git).toContain('GIT_TIMEOUT_MS')
    expect(git).toContain('child.kill()')
    // ③ FIFO 异常兜底：单实例的意外 throw 落 failed 并 continue。
    const engine = read('src/main/pipeline/pipeline-engine.ts')
    expect(engine).toContain('引擎异常：')
    // 诊断落盘（review_20261117 中2）：打包 GUI 无终端，console.* 不可见——
    // 三条事后归因诊断（启动恢复/降级留痕/FIFO crash）走 logMain 进 main.log，
    // 别退回 console.*（[Hooks] 2026-11-05 教训）。
    expect(handler).toContain("logMain('WARN', 'pipeline'")
    expect(engine).toContain("logMain('WARN', 'pipeline'")
    expect(engine).toContain("logMain('ERROR', 'pipeline'")
    // ④ 阶段摘要落库（运行视图「节点做了什么/最终结果」的数据面）。
    expect(store).toContain('summary = COALESCE(?, summary)')
    expect(engine).toContain('o.kind === \'settled\' && o.summary ? { summary: o.summary }')
    // 整页运行视图（user 2026-11-16「模态框太小改成页面」）：ViewHost 路由
    // workflowRunViewId → 页面（左图 + 右面板），入口走导航而不是 Modal。
    const modal = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')
    expect(modal).toContain('runViewFinalResult')
    expect(modal).toContain('data-workflow-run-panel')
    expect(modal).toContain("navigate({ kind: 'routines' })")
    // 点谁看谁（user 2026-11-17）：右栏 = 选中节点详情 + 多次执行选择条 +
    // START/DONE 专属面板；默认选中最后有记录的节点。
    expect(modal).toContain('onRunNodeClick')
    expect(modal).toContain('runPanelExecPick')
    expect(modal).toContain('runPanelStartTitle')
    expect(modal).toContain('defaultedRef.current === runId')
    // 阶段转写必须过落库转换（user 2026-11-17「很多 tool use 执行状态未知」）：
    // tool_use.status 是运行时字段不落库，原始行直接渲染会让每个工具块停在
    // status undefined；`storedMessagesToAgentMessages` 按 tool_result 配对回填
    // completed。全仓仅这一条加载路径曾经漏掉，别再退回裸 cast。
    expect(modal).toContain('storedMessagesToAgentMessages(conv?.messages ?? [])')
    expect(modal).not.toContain('as unknown as AgentMessage[]')
    // 转写落点（user 2026-11-17「点击节点后，定位到会话的尾部」）：滚动容器是
    // StageTranscript 自己那层 div（TranscriptView 的根节点在块流里高度自适应、
    // 从不自己滚，tail-follow 在这条宿主上只是空转）；换节点/换执行时 React
    // 复用同一个 DOM 节点，浏览器保留期望偏移。落点 = 会话尾部（最新一条输出），
    // 所以内容落地后连钉两帧 scrollTop = scrollHeight（第二帧吃 markdown/代码块
    // 的二次布局），之后不再追高。
    expect(modal).toContain('ref={scrollRef}')
    expect(modal).toContain('landAtTail()')
    expect(modal).toContain('el.scrollTop = el.scrollHeight')
    expect(modal).toContain('requestAnimationFrame')
    const host = read('src/renderer/src/components/layout/ViewHost.tsx')
    expect(host).toContain('workflowRunViewId')
    expect(read('src/renderer/src/components/routine/UnifiedRunsSidebar.tsx')).toContain('workflowRunViewId: row.id')
  })
})
