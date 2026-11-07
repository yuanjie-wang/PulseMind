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
    for (const name of ['PIPELINE_WORKFLOWS', 'PIPELINE_RUN', 'PIPELINE_STOP', 'PIPELINE_RUNS', 'PIPELINE_ASSIST']) {
      expect(ipcChannels).toContain(`${name}:`)
    }
    for (const fn of ['pipelineWorkflows', 'pipelineRun', 'pipelineStop', 'pipelineRuns', 'pipelineAssist']) {
      expect(preload).toContain(fn)
      expect(bridge).toContain(fn)
    }
    expect(handler).toContain('PIPELINE_WORKFLOWS')
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

  it('RoutineCenter 挂工作流区 + 三处同一校验门（save/启动/助手）', () => {
    const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
    expect(center).toContain('WorkflowSection')
    expect(read('src/main/storage/workflow-store.ts')).toMatch(/validateWorkflow\(def\)/)
    expect(read('src/main/pipeline/workflow-assistant.ts')).toMatch(/validateWorkflow\(parsed\)/)
    expect(handler).toMatch(/validateWorkflow\(def\)/)
  })

  it('运行记录 3s 轮询 + 停止按钮 wiring（WorkflowSection）', () => {
    const section = read('src/renderer/src/components/routine/WorkflowSection.tsx')
    expect(section).toContain('RUNS_POLL_MS = 3_000')
    expect(section).toContain('pipelineStop')
    expect(section).toContain('CodeMirrorEditor')
    expect(section).toContain('pipelineAssist')
  })
})
