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

  it('引擎纪律：runRowId 前缀守卫（STOP）+ 每阶段独立 pipe_ 会话 + gitCheckpoint 缺省 true', () => {
    expect(read('src/main/ipc/pipeline.handler.ts')).toContain("startsWith('prun_')")
    expect(engine).toContain('mintStageConvId')
    expect(engine).toContain('params?.gitCheckpoint ?? true')
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
    // JSON UI 已退出（user 2026-11-08）：CodeMirror/助手不回任何列表面。
    expect(sidebar).not.toContain('CodeMirrorEditor')
    // 助手入口随向导走，且是共享的会话栏（不是 workflow 专属的一发式面板）。
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).toContain('FormAssistColumn')
    expect(wizard).not.toContain('pipelineAssist')
  })
})
