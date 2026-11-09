// 工作流自定义输入变量（user 2026-11-08 二期：plan 去预设化，工作流的用户
// 输入自己声明）。钉：render 的 vars 合并与保留占位符优先、validate 的
// inputs 形态门、IPC 的 required 门与 plans 可空、preload/bridge 签名同步、
// 运行输入落库（inputs_json）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderNodePrompt, RESERVED_PLACEHOLDER_KEYS } from '../src/shared/workflow/render'
import { validateWorkflow } from '../src/shared/workflow/validate'
import type { WorkflowDefinition } from '../src/shared/workflow/types'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

const baseDef = (partial: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  id: 't',
  name: 't',
  entry: 'a',
  nodes: [{ id: 'a', title: 'a', prompt: 'p', verdicts: ['pass'] }],
  edges: [],
  ...partial,
})

describe('render: user vars', () => {
  it('自定义变量 {{key}} 渲染为传入值', () => {
    const out = renderNodePrompt('译成 {{target_lang}}', { vars: { target_lang: '日语' } })
    expect(out).toContain('译成 日语')
  })

  it('保留占位符不可被 user vars 覆盖（已知键赢）', () => {
    const out = renderNodePrompt('{{objective}} {{visit}}', { vars: { objective: '劫持', visit: '999' }, visit: 2 })
    expect(out).not.toContain('劫持')
    expect(out).toContain('2')
  })

  it('未提供值且无 vars：声明过的占位符保持原样（诚实缺位）', () => {
    const out = renderNodePrompt('目标：{{target_lang}}', {})
    expect(out).toContain('{{target_lang}}')
  })

  it('RESERVED_PLACEHOLDER_KEYS 与 render 的替换表同源', () => {
    for (const key of RESERVED_PLACEHOLDER_KEYS) {
      const out = renderNodePrompt(`{{${key}}}`, {})
      // row 是批量注入面：缺席时 token 保持可见（P2），其余保留键必有空态标注。
      if (key === 'row') continue
      expect(out).not.toContain(`{{${key}}}`)
    }
  })
})

describe('validate: inputs gate', () => {
  it('合法 inputs 通过', () => {
    const v = validateWorkflow(baseDef({ inputs: [{ key: 'target_lang', label: '目标语言', required: true, multiline: false }] }))
    expect(v.ok).toBe(true)
  })

  it('保留占位符名被拒', () => {
    for (const key of RESERVED_PLACEHOLDER_KEYS) {
      const v = validateWorkflow(baseDef({ inputs: [{ key, label: 'x' }] }))
      expect(v.ok).toBe(false)
      expect(v.errors.join()).toContain('保留占位符')
    }
  })

  it('重复 key 与空 label 被拒；非法 key（含连字符以外的怪字符）被拒', () => {
    const dup = validateWorkflow(
      baseDef({
        inputs: [
          { key: 'a', label: 'x' },
          { key: 'a', label: 'y' },
        ],
      }),
    )
    expect(dup.errors.join()).toContain('重复')
    const noLabel = validateWorkflow(baseDef({ inputs: [{ key: 'a', label: '' }] }))
    expect(noLabel.errors.join()).toContain('label')
    const badKey = validateWorkflow(baseDef({ inputs: [{ key: 'a-b', label: 'x' }] }))
    expect(badKey.errors.join()).toContain('非法')
  })

  it('inputs 缺省（既有工作流）不受影响', () => {
    expect(validateWorkflow(baseDef({})).ok).toBe(true)
  })
})

describe('run path wiring', () => {
  const handler = read('src/main/ipc/pipeline.handler.ts')
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')

  it('plans 可空（空 = 单实例无 plan），plan 不再是硬性前置', () => {
    expect(handler).not.toContain('至少提供一个 plan 文件路径')
    // 启动路径已抽到 pipeline/launch.ts（P1 任务共享内核），单实例门随迁。
    const launch = read('src/main/pipeline/launch.ts')
    expect(launch).toMatch(/plans\.length > 0 \? plans\.map/)
    expect(handler).toContain('launchWorkflowRun(')
  })

  it('required 输入门：主进程侧兜底校验（launch.ts）', () => {
    const launch = read('src/main/pipeline/launch.ts')
    expect(launch).toMatch(/input\.required/)
    expect(launch).toContain('必填')
    // 无人可问的触发（定时/文件/webhook，与 routine 同一词汇表三档）：缺失
    // 必填如实落 failed run 行（不抛错吞掉）。门是集合成员判定，不是单档等值。
    expect(launch).toMatch(/UNATTENDED_TRIGGERS\.has\(trigger\)/)
    expect(launch).toContain("new Set(['schedule', 'file', 'webhook']")
  })

  it('vars 透传链：handler → engine enqueue；preload/bridge 签名含 vars', () => {
    expect(handler).toContain('vars,')
    expect(preload).toContain('vars?: Record<string, string>')
    expect(bridge).toContain('vars?: Record<string, string>')
  })

  it('运行输入落库：inputs_json 列 + createRun 写入 + 行读回', () => {
    expect(read('src/main/storage/database.ts')).toContain('ALTER TABLE pipeline_runs ADD COLUMN inputs_json TEXT')
    const store = read('src/main/storage/pipeline-run-store.ts')
    expect(store).toContain('inputs_json')
    expect(store).toMatch(/run\.inputs && Object\.keys\(run\.inputs\)\.length > 0/)
  })

  it('助手 schema 声明 inputs + 阶段提示词不依赖上下文的硬规范（渲染端 spec）', () => {
    // 一次性管道助手已撤（2026-11-08）：口径搬到渲染端 workflow-assist.ts，
    // 与 routine 共用 form-assist 协议。inputs 变量表与「提示词脱离当前对话
    // 也能跑」仍是对助手的硬要求（旧的 plan 非默认假设随管道形态一起退场）。
    const assist = read('src/renderer/src/components/routine/workflow-assist.ts')
    expect(assist).toContain("key: 'inputs'")
    expect(assist).toContain('{{key}}')
    expect(assist).toContain('独立可执行的指令')
  })
})

describe('run form wiring (WorkflowRunModal, P3 自 WorkflowSection 抽出)', () => {
  const section = read('src/renderer/src/components/routine/WorkflowRunModal.tsx')

  it('动态输入字段 + required 前端门 + plans 可空文案', () => {
    expect(section).toMatch(/runWorkflow\?\.inputs/)
    expect(section).toMatch(/i\.required && !\(runVars\[i\.key\]/)
    expect(section).toContain('runInputRequired')
  })

  it('启动调用携带 vars + 授权/模型覆盖', () => {
    expect(section).toMatch(/pipelineRun\(\{[^}]*vars: runVars/s)
    expect(section).toMatch(/approvalMode: runApproval/)
  })
})
