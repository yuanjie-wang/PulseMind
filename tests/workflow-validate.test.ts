// PLAN-workflow-engine shared 纯逻辑：validate.ts（校验门）+ render.ts
// （占位符渲染 + objective 解析序 + 双帽）+ contract.ts（全文扫描契约行）。

import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../src/shared/workflow/validate'
import { renderNodePrompt, resolveObjective, PLAN_CONTENT_CAP, ARTIFACT_CONTENT_CAP } from '../src/shared/workflow/render'
import { parsePipelineResult, formatPipelineResult, artifactPathError } from '../src/shared/workflow/contract'
import type { WorkflowDefinition } from '../src/shared/workflow/types'

const baseWorkflow: WorkflowDefinition = {
  id: 'coding-pipeline',
  name: '编码流水线',
  objective: '高质量落地',
  entry: 'code',
  nodes: [
    { id: 'code', title: '编码', prompt: '目标：{{objective}}\n{{planContent}}', verdicts: ['pass', 'fail'] },
    { id: 'test', title: '测试', prompt: 'prev={{prevVerdict}}/{{prevSummary}}/{{visit}}', verdicts: ['pass', 'fail'] },
    { id: 'fix', title: '修复', prompt: 'artifacts:\n{{prevArtifacts}}', verdicts: ['pass', 'fail'] },
  ],
  edges: [
    { from: 'code', when: 'pass', to: 'test' },
    { from: 'test', when: 'pass', to: 'DONE' },
    { from: 'test', when: 'fail', to: 'fix' },
    { from: 'fix', when: 'pass', to: 'test' },
    { from: 'fix', when: 'fail', to: 'test' },
  ],
}

describe('validateWorkflow', () => {
  it('合法工作流全绿（含 DONE/RETRY 边、不可达无）', () => {
    const v = validateWorkflow(baseWorkflow)
    expect(v.ok).toBe(true)
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
  })

  it('坏边：from/to 不是已声明节点、when 越出 verdicts、重复边', () => {
    const v = validateWorkflow({
      ...baseWorkflow,
      edges: [
        { from: 'ghost', when: 'pass', to: 'test' },
        { from: 'code', when: 'pass', to: 'ghost' },
        { from: 'code', when: 'SKIP', to: 'test' },
        { from: 'code', when: 'pass', to: 'test' },
        { from: 'code', when: 'pass', to: 'test' },
      ],
    })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('ghost') && e.includes('from'))).toBe(true)
    expect(v.errors.some((e) => e.includes('to') && e.includes('ghost'))).toBe(true)
    expect(v.errors.some((e) => e.includes('SKIP') && e.includes('verdicts'))).toBe(true)
    expect(v.errors.filter((e) => e.includes('重复边'))).toHaveLength(1)
  })

  it('保留字冲突：节点 id 叫 DONE/FAILED/RETRY 拒绝', () => {
    const v = validateWorkflow({
      ...baseWorkflow,
      nodes: [...baseWorkflow.nodes, { id: 'DONE', title: 'x', prompt: 'p', verdicts: ['pass'] }],
    })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('保留字'))).toBe(true)
  })

  it('不可达节点是 warning 不是 error', () => {
    const v = validateWorkflow({
      ...baseWorkflow,
      nodes: [...baseWorkflow.nodes, { id: 'orphan', title: '孤立', prompt: 'p', verdicts: ['pass'] }],
    })
    expect(v.ok).toBe(true)
    expect(v.warnings.some((w) => w.includes('orphan'))).toBe(true)
  })

  it('verdicts 空、entry 缺失、nodes 空、entry 指向不存在节点都是 error', () => {
    expect(validateWorkflow({ ...baseWorkflow, nodes: baseWorkflow.nodes.map((n) => ({ ...n, verdicts: [] })) }).ok).toBe(false)
    expect(validateWorkflow({ ...baseWorkflow, entry: '' }).ok).toBe(false)
    expect(validateWorkflow({ ...baseWorkflow, nodes: [] }).ok).toBe(false)
    expect(validateWorkflow({ ...baseWorkflow, entry: 'ghost' }).ok).toBe(false)
  })

  it('非对象/缺骨架直接拒绝并短路', () => {
    expect(validateWorkflow(null).ok).toBe(false)
    expect(validateWorkflow('x').ok).toBe(false)
    expect(validateWorkflow({ id: 'x' }).errors.length).toBeGreaterThan(0)
  })

  it('params 形态：非正数/非布尔拒绝', () => {
    expect(validateWorkflow({ ...baseWorkflow, params: { stageTimeoutMinutes: 0 } }).ok).toBe(false)
    expect(validateWorkflow({ ...baseWorkflow, params: { gitCheckpoint: 'yes' } as never }).ok).toBe(false)
    expect(validateWorkflow({ ...baseWorkflow, params: { stageTimeoutMinutes: 30, maxStageContinues: 2 } }).ok).toBe(true)
  })

  it('artifactPathError：绝对路径/../反斜杠/空拒，相对路径放行', () => {
    expect(artifactPathError('pipeline/test-failures.md')).toBeNull()
    expect(artifactPathError('/etc/passwd')).toContain('相对路径')
    expect(artifactPathError('a/../../b')).toContain('..')
    expect(artifactPathError('a\\b')).toContain('/')
    expect(artifactPathError('')).toContain('为空')
  })
})

describe('renderNodePrompt', () => {
  it('objective 解析序：运行级 > 工作流级 > 空', () => {
    expect(resolveObjective({ runObjective: ' R ', workflowObjective: 'W' })).toBe('R')
    expect(resolveObjective({ workflowObjective: 'W' })).toBe('W')
    expect(resolveObjective({})).toBe('')
  })

  it('全部占位符替换；入口阶段的 prev* 是明确空态标注', () => {
    const out = renderNodePrompt(baseWorkflow.nodes[1].prompt, {
      runObjective: '落地',
      workflowObjective: 'W',
      prevVerdict: 'pass',
      prevSummary: '还行',
      visit: 2,
    })
    expect(out).toBe('prev=pass/还行/2')
    const entry = renderNodePrompt(baseWorkflow.nodes[1].prompt, {})
    expect(entry).toContain('（无——本阶段是入口）')
    expect(entry).toContain('1')
  })

  it('{{prevArtifacts}} 列出交付物；缺席是明确标注；单文件 20k 帽截断且显式标注', () => {
    const small = renderNodePrompt(baseWorkflow.nodes[2].prompt, { prevArtifacts: [{ path: 'a.md', content: '内容' }] })
    expect(small).toContain('--- a.md ---')
    const absent = renderNodePrompt(baseWorkflow.nodes[2].prompt, {})
    expect(absent).toContain('未声明或未产出')
    const big = 'x'.repeat(ARTIFACT_CONTENT_CAP + 100)
    const capped = renderNodePrompt(baseWorkflow.nodes[2].prompt, { prevArtifacts: [{ path: 'a.md', content: big }] })
    expect(capped.length).toBeLessThan(big.length)
    expect(capped).toContain('20_000'.replace('_', '')).toContain('字符帽')
  })

  it('{{planContent}} 120k 帽；未知占位符原样保留', () => {
    const big = renderNodePrompt('{{planContent}} {{unknown}}', { planContent: 'y'.repeat(PLAN_CONTENT_CAP + 1) })
    expect(big.length).toBeLessThan(PLAN_CONTENT_CAP + 200)
    expect(big).toContain('字符帽')
    expect(big).toContain('{{unknown}}')
    expect(renderNodePrompt('{{planContent}}', {})).toContain('未提供 plan 内容')
  })
})

describe('parsePipelineResult', () => {
  it('全文扫描取最后一个合法契约行（严格末行假阳性的放宽面）', () => {
    const text = [
      '开头正文',
      `PIPELINE_RESULT: {"verdict":"fail","summary":"早先的"}`,
      '更多正文……',
      `尾部说明 ${formatPipelineResult({ verdict: 'pass', summary: '最终', artifacts: ['pipeline/review-findings.md'] })}`,
    ].join('\n')
    expect(parsePipelineResult(text)).toEqual({ verdict: 'pass', summary: '最终', artifacts: ['pipeline/review-findings.md'] })
  })

  it('畸形行跳过：非 JSON、无 verdict、纯前缀都不拦路', () => {
    const text = ['PIPELINE_RESULT: not-json', 'PIPELINE_RESULT: {"summary":"no verdict"}', 'PIPELINE_RESULT: {"verdict":"pass"}'].join('\n')
    expect(parsePipelineResult(text)).toEqual({ verdict: 'pass', summary: '', artifacts: [] })
  })

  it('没有契约行 → null（早停激发臂的判据）', () => {
    expect(parsePipelineResult('没有任何契约')).toBeNull()
    expect(parsePipelineResult('')).toBeNull()
  })
})
