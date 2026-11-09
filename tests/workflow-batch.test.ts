// P2 任务共享内核：workflow 批量数据 + 内置变量打通。
// 钉：render builtins 合并序（builtin < 用户输入 < 已知键）、validate 拒 row
// 键、CSV→inputs 映射（required 缺列整批拒/多余列忽略/行变量 trim）、feeder
// （逐行 launch + row/batchId + 空格 required 行落 failed 不入队）、stop
// （cancel 队列 + stop 在飞）、IPC 四面、batch_id 三面（DDL/迁移/映射）、
// UI 两处（画布批量段 + 卡片批量钮 + WorkflowBatchModal）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderNodePrompt } from '../src/shared/workflow/render'
import { validateWorkflow } from '../src/shared/workflow/validate'
import { analyzeWorkflowCsvBatch, workflowRowVars } from '../src/shared/workflow/batch'
import type { WorkflowDefinition } from '../src/shared/workflow/types'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('render: builtins merge order', () => {
  it('builtins 注入 {{date}}/{{row}}（批量行号）', () => {
    const out = renderNodePrompt('今天 {{date}}，第 {{row}} 行', { builtins: { date: '2026-11-08', row: '3' } })
    expect(out).toBe('今天 2026-11-08，第 3 行')
  })

  it('合并序：builtin < 用户输入 < 已知键', () => {
    const out = renderNodePrompt('{{date}} {{workspace}}', {
      builtins: { date: 'builtin', workspace: 'builtin-ws' },
      vars: { date: 'user' },
      workspace: '/known/ws',
    })
    // 用户输入赢 builtin；已知键 workspace 赢 builtin 的同名键。
    expect(out).toBe('user /known/ws')
  })

  it('row 未注入时 token 保持可见（单次运行诚实缺位）', () => {
    expect(renderNodePrompt('第 {{row}} 行', {})).toContain('{{row}}')
  })

  it('validate 拒声明 row 输入（系统注入面，不可被占用）', () => {
    const v = validateWorkflow({
      id: 't',
      name: 't',
      entry: 'a',
      nodes: [{ id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] }],
      edges: [],
      inputs: [{ key: 'row', label: 'x' }],
    })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('保留占位符')
  })
})

describe('CSV → inputs mapping', () => {
  const headers = ['target_lang', 'extra_col', 'doc_path']
  const rows = [
    [' 日语 ', 'x1', 'docs/a.md'],
    ['', 'x2', 'docs/b.md'],
  ]

  it('analyze：required 缺列整批拒、多余列忽略、首现列赢', () => {
    const ok = analyzeWorkflowCsvBatch(headers, rows, [
      { key: 'target_lang', label: '目标语言', required: true },
      { key: 'doc_path', label: '源文档' },
    ])
    expect(ok.matchedParams).toEqual(['target_lang', 'doc_path'])
    expect(ok.unmatchedHeaders).toEqual(['extra_col'])
    expect(ok.missingRequiredHeaders).toEqual([])

    const bad = analyzeWorkflowCsvBatch(headers, rows, [{ key: 'glossary', label: '术语表', required: true }])
    expect(bad.missingRequiredHeaders).toEqual(['glossary'])
  })

  it('行变量：trim + 只产出映射列', () => {
    const inputs = [
      { key: 'target_lang', label: '目标语言', required: true },
      { key: 'doc_path', label: '源文档' },
    ]
    expect(workflowRowVars(headers, rows, inputs, 0)).toEqual({ target_lang: '日语', doc_path: 'docs/a.md' })
    expect(workflowRowVars(headers, rows, inputs, 1)).toEqual({ target_lang: '', doc_path: 'docs/b.md' })
  })
})

describe('batch feeder & engine wiring', () => {
  const feeder = read('src/main/pipeline/batch-feeder.ts')
  const engine = read('src/main/pipeline/pipeline-engine.ts')
  const launch = read('src/main/pipeline/launch.ts')

  it('feeder：loadTableSource 共用读面 + 逐行 launch + row/batchId 透传', () => {
    expect(feeder).toContain('loadTableSource')
    expect(feeder).toContain('workflowRowVars')
    expect(feeder).toMatch(/row: rowNo,/)
    expect(feeder).toMatch(/batchId,/)
    expect(launch).toMatch(/batchId: opts\.batchId/)
    expect(launch).toMatch(/row: opts\.row/)
  })

  it('feeder 行级预检：空格 required 行落 failed 行、不入队（失败不挡后续）', () => {
    expect(feeder).toMatch(/input\.required && !vars\[input\.key\]/)
    expect(feeder).toMatch(/failedRows \+= 1/)
    expect(feeder).toContain('第 ${rowNo} 行缺少必填输入')
  })

  it('串行裁定注释在场 + 无并发参数（gitCheckpoint 撞仓理由）', () => {
    expect(feeder).toContain('gitCheckpoint')
    expect(feeder).not.toMatch(/concurrency/i)
  })

  it('stop：cancel 撤队列（行记失败）+ stop 停在飞 + 内存注册表', () => {
    expect(engine).toMatch(/cancel\(runId: string\): boolean/)
    expect(engine).toMatch(/批量已停止/)
    expect(feeder).toMatch(/pipelineEngine\.cancel\(runId\)/)
    expect(feeder).toMatch(/pipelineEngine\.stop\(runId\)/)
    expect(feeder).toMatch(/const batches = new Map</)
  })

  it('引擎渲染：builtins 来自 builtinRoutineVars（workspace + row）', () => {
    expect(engine).toContain('builtinRoutineVars')
    expect(engine).toMatch(/builtins: builtinRoutineVars\(\{ workspaceDir: opts\.workspaceDir, row: opts\.row \}\)/)
    expect(engine).toMatch(/row: opts\.row,\n\s+runObjective,/)
  })
})

describe('storage & IPC wiring', () => {
  it('batch_id 三面：DDL / ALTER 迁移 / 行映射', () => {
    const db = read('src/main/storage/database.ts')
    expect(db).toContain('batch_id        TEXT')
    expect(db).toContain('ALTER TABLE pipeline_runs ADD COLUMN batch_id TEXT')
    const store = read('src/main/storage/pipeline-run-store.ts')
    expect(store).toMatch(/batch_id/)
    expect(read('src/shared/workflow/types.ts')).toMatch(/batchId\?: string/)
  })

  it('PIPELINE_BATCH_RUN/STOP 四面同在', () => {
    for (const name of ['PIPELINE_BATCH_RUN', 'PIPELINE_BATCH_STOP']) {
      expect(read('src/shared/ipc-channels.ts')).toContain(`${name}:`)
    }
    for (const fn of ['pipelineBatchRun', 'pipelineBatchStop']) {
      expect(read('src/preload/index.ts')).toContain(fn)
      expect(read('src/shared/types/electron-bridge.ts')).toContain(fn)
    }
    const handler = read('src/main/ipc/pipeline.handler.ts')
    expect(handler).toContain('startWorkflowBatch(')
    expect(handler).toContain('stopWorkflowBatch(')
  })

  it('WorkflowDefinition.batch 字段 + validate 宽容', () => {
    // 字段复用 routine 的批量形态（2026-11-08 两模式能力对齐：并发/超时/
    // 应用到定时全套），不是 workflow 自己的裸 csvPath。
    expect(read('src/shared/workflow/types.ts')).toMatch(/batch\?: RoutineBatchConfig/)
    expect(read('src/shared/workflow/types.ts')).toContain('RoutineBatchConfig')
    expect(read('src/shared/workflow/validate.ts')).not.toContain('batch')
  })
})

describe('UI wiring', () => {
  it('向导触发与批量步复用 BatchSection + TriggersSection（以对话式任务为准）', () => {
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    // 同一个批量段 + 同一个事件触发段（批量的表头识别、超时、应用到定时、
    // 文件变化/webhook 触发全由共享组件提供）。
    expect(wizard).toContain('<BatchSection')
    expect(wizard).toContain('<TriggersSection')
    expect(wizard).toContain("webhook={{ kind: 'workflow', id: def.id }}")
    // 并发行照常渲染但锁定——工作流实例是串行 FIFO，退场会让这个事实不可见。
    expect(wizard).toMatch(/concurrency=\{\{\s*locked: true/)
    // 裸 CSV 路径入口已随旧形态退场。
    expect(wizard).not.toContain("t('workflow.batchCsv')")
  })

  it('混排列表：挂 CSV 的工作流卡片有批量钮 + WorkflowBatchModal 挂载', () => {
    const center = read('src/renderer/src/components/routine/RoutineCenter.tsx')
    expect(center).toContain('<WorkflowBatchModal')
    expect(center).toMatch(/wf\.batch\?\.csvPath \? \(\) => setBatchWorkflow\(wf\)/)
    const modal = read('src/renderer/src/components/routine/WorkflowBatchModal.tsx')
    expect(modal).toContain('routineCsvPreview')
    expect(modal).toContain('pipelineBatchRun')
    expect(modal).not.toContain('concurrency')
  })

  it('i18n：批量键中英同批存在', () => {
    for (const key of ['batchCsv:', 'batchRun:', 'batchRows:']) {
      expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain(key)
      expect(read('src/renderer/src/i18n/locales/en.ts')).toContain(key)
    }
  })
})

// feeder 的类型面（workflow 定义样例，防止 analyze 形状漂移）
describe('feeder type surface', () => {
  it('WorkflowInputDef 可直接喂 analyze（结构兼容 RoutineParam 最小形状）', () => {
    const inputs: WorkflowDefinition['inputs'] = [{ key: 'a', label: 'A', required: true }]
    const out = analyzeWorkflowCsvBatch(['a', 'b'], [['1', '2']], inputs)
    expect(out.matchedParams).toEqual(['a'])
    expect(out.totalRows).toBe(1)
  })
})
