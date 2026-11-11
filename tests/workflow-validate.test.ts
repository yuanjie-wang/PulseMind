// PLAN-workflow-engine shared 纯逻辑：validate.ts（校验门）+ render.ts
// （占位符渲染 + objective 解析序 + 双帽）+ contract.ts（全文扫描契约行）。

import { describe, expect, it } from 'vitest'
import { validateWorkflow, missingVerdictDefs } from '../src/shared/workflow/validate'
import { renderNodePrompt, resolveObjective, PLAN_CONTENT_CAP, ARTIFACT_CONTENT_CAP } from '../src/shared/workflow/render'
import { parsePipelineResult, formatPipelineResult, artifactPathError } from '../src/shared/workflow/contract'
import { STAGE_FINISH_TOOL, validateStageFinishArgs, buildStageFinishTool } from '../src/shared/workflow/finish-tool'
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

  it('同一起点同出口连多个不同目标 = 合法（多出口，user 2026-11-09）', () => {
    // 去重键是 (from, when, to) 三元组：只有完全同形的连线才算重复。
    const v = validateWorkflow({
      ...baseWorkflow,
      edges: [
        { from: 'code', when: 'pass', to: 'test' },
        { from: 'code', when: 'pass', to: 'DONE' },
        { from: 'test', when: 'pass', to: 'DONE' },
      ],
    })
    expect(v.ok).toBe(true)
    expect(v.errors.filter((e) => e.includes('重复边'))).toHaveLength(0)
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

  it('结果状态名是调度键：字符集/长度越界的拒绝（user 2026-11-09）', () => {
    // 它会同时变成 DOM 的 data-handleid（`out:<v>`）、边 id 的中段
    // （`edge:from|when|to`）和 prompt 契约里的 JSON 字符串值——竖线会让边 id
    // 解析错位，空白/引号会让运行时的 verdict 匹配静默失败。
    const withVerdict = (bad: string): WorkflowDefinition => ({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) => (n.id === 'code' ? { ...n, verdicts: ['pass', bad] } : n)),
    })
    for (const bad of ['has space', 'a|b', 'qu"ote', 'back`tick', 'br{ace}', 'co:lon', '', 'x'.repeat(25)]) {
      const v = validateWorkflow(withVerdict(bad))
      expect(v.ok, `应拒绝「${bad}」`).toBe(false)
      expect(v.errors.some((e) => e.includes('结果状态非法'))).toBe(true)
    }
    // 中文状态名是主用例（「成功/失败/需修订」），必须放行。
    expect(validateWorkflow(withVerdict('需修订')).ok).toBe(true)
    // 重名：画布上会画两根线头、运行时分不清走哪条。
    const dup = validateWorkflow({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) => (n.id === 'code' ? { ...n, verdicts: ['pass', 'pass'] } : n)),
    })
    expect(dup.ok).toBe(false)
    expect(dup.errors.some((e) => e.includes('结果状态重复'))).toBe(true)
  })

  it('状态定义必填只在写门生效（user 2026-11-09「状态定义是必填的」）', () => {
    // 口径开关：写入（编辑器保存 / 助手落地）带 requireVerdictDefs；读取
    // （workflow-store.readWorkflow 对不过门的工作流整只丢弃）、启动
    // （pipeline-engine 的 enqueue）与分享预览刻意不带——挂到读/跑面上等于让
    // 存量工作流从列表消失或停跑。
    const noDefs = validateWorkflow(baseWorkflow, { requireVerdictDefs: true })
    expect(noDefs.ok).toBe(false)
    // 每个状态各报一条，点名节点 id 与状态名：用户要能直接找到那一行。
    for (const [node, verdict] of [
      ['code', 'pass'],
      ['code', 'fail'],
      ['test', 'pass'],
      ['test', 'fail'],
      ['fix', 'pass'],
      ['fix', 'fail'],
    ]) {
      expect(
        noDefs.errors.some((e) => e.includes(`节点 ${node}`) && e.includes(`「${verdict}」`) && e.includes('缺少定义')),
        `${node}/${verdict} 应报缺少定义`,
      ).toBe(true)
    }
    // 同一份定义在裸调用（读/启/分享面）下照旧全绿。
    expect(validateWorkflow(baseWorkflow).ok).toBe(true)

    const withDefs = (defs: (n: string) => Record<string, string>): WorkflowDefinition => ({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n) => ({ ...n, verdictDefs: defs(n.id) })),
    })
    const allPass = (n: string): Record<string, string> => ({ pass: `${n} 通过`, fail: `${n} 未通过` })
    expect(validateWorkflow(withDefs(allPass), { requireVerdictDefs: true }).ok).toBe(true)

    // 空白定义 = 没填（trim 后为空），不能靠几个空格过门。
    const blank = withDefs((n) => ({ pass: '   ', fail: `${n} 未通过` }))
    const blankV = validateWorkflow(blank, { requireVerdictDefs: true })
    expect(blankV.ok).toBe(false)
    expect(blankV.errors.filter((e) => e.includes('缺少定义'))).toHaveLength(3)

    // 孤儿键（定义了别的状态）不顶替缺失项。
    const orphan = withDefs(() => ({ pass: '通过', fail: '未通过', 幽灵: '不该算数' }))
    expect(validateWorkflow(orphan, { requireVerdictDefs: true }).ok).toBe(true) // 多余键由 simplify 裁，不在这里报错
    const orphanOnly = withDefs(() => ({ 幽灵: '不该算数' }))
    expect(validateWorkflow(orphanOnly, { requireVerdictDefs: true }).ok).toBe(false)
  })

  it('missingVerdictDefs 与写门报错逐项等价（助手快照的清单不能与保存门分叉）', () => {
    // 快照里的 missingDefinitions 与保存门必须说同一件事：模型照着清单补完就
    // 一定能过门。两处口径一分叉，用户就会「补了一轮还是存不下」。
    const gateGaps = (def: WorkflowDefinition): string[] =>
      validateWorkflow(def, { requireVerdictDefs: true })
        .errors.filter((e) => e.includes('缺少定义'))
        .map((e) => {
          const m = /节点 (\S+) 的结果状态「([^」]+)」/.exec(e)
          return m ? `${m[1]}/${m[2]}` : e
        })
        .sort()
    const withDefs = (one: Record<string, string>, rest: Record<string, string>): WorkflowDefinition => ({
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((n, i) => ({ ...n, verdictDefs: i === 0 ? one : rest })),
    })
    const cases: WorkflowDefinition[] = [
      baseWorkflow,
      withDefs({ pass: '过', fail: '不过' }, { pass: '过', fail: '不过' }),
      withDefs({ pass: '  ', fail: '不过' }, { pass: '过', fail: '不过' }), // 空白 = 没填
      withDefs({ 幽灵: '不该算数' }, { pass: '过', fail: '不过' }), // 孤儿键不顶替
    ]
    for (const def of cases) {
      expect(
        missingVerdictDefs(def)
          .map((g) => `${g.node}/${g.verdict}`)
          .sort(),
      ).toEqual(gateGaps(def))
    }
    // 状态名非法的项不进清单：那边已有自己的错误，把它列成「待补的缺口」等于
    // 让模型去补一个根本无法存在定义的状态。
    const badName: WorkflowDefinition = { ...baseWorkflow, nodes: baseWorkflow.nodes.map((n) => ({ ...n, verdicts: [...n.verdicts, '有 空格'] })) }
    expect(missingVerdictDefs(badName).some((g) => g.verdict.includes(' '))).toBe(false)
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

describe('finish_stage 阶段完成协议（shared）', () => {
  const config = { verdicts: ['成功', '需修订'] }

  it('合法调用 → 契约（verdict/summary trim、artifacts 缺省为 []）', () => {
    expect(validateStageFinishArgs({ verdict: ' 成功 ', summary: ' 做完了 ', artifacts: [' pipeline/a.md '] }, config)).toEqual({
      ok: true,
      contract: { verdict: '成功', summary: '做完了', artifacts: ['pipeline/a.md'] },
    })
    expect(validateStageFinishArgs({ verdict: '需修订', summary: '还差一点' }, config)).toEqual({
      ok: true,
      contract: { verdict: '需修订', summary: '还差一点', artifacts: [] },
    })
  })

  it('verdict 越表/为空/非字符串一律拒收（词汇表逐字匹配）', () => {
    for (const verdict of ['通过', '', '   ', 42, null, undefined]) {
      const r = validateStageFinishArgs({ verdict, summary: 'x' }, config)
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
    }
    const out = validateStageFinishArgs({ verdict: 'pass', summary: 'x' }, config)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('成功 / 需修订')
  })

  it('空词汇表回落 [pass]（与 validateWorkflow 的默认单出口一致）', () => {
    expect(validateStageFinishArgs({ verdict: 'pass', summary: 'ok' }, { verdicts: [] })).toEqual({
      ok: true,
      contract: { verdict: 'pass', summary: 'ok', artifacts: [] },
    })
    expect(validateStageFinishArgs({ verdict: 'fail', summary: 'ok' }, { verdicts: [] }).ok).toBe(false)
  })

  it('summary 必填；artifacts 必须是字符串数组且每项过路径门', () => {
    expect(validateStageFinishArgs({ verdict: '成功' }, config).error).toContain('summary')
    expect(validateStageFinishArgs({ verdict: '成功', summary: '  ' }, config).ok).toBe(false)
    expect(validateStageFinishArgs({ verdict: '成功', summary: 'x', artifacts: 'a.md' }, config).error).toContain('数组')
    expect(validateStageFinishArgs({ verdict: '成功', summary: 'x', artifacts: [1] }, config).error).toContain('第 1 项')
    for (const bad of ['/abs/a.md', '../escape.md', 'a\\b.md']) {
      expect(validateStageFinishArgs({ verdict: '成功', summary: 'x', artifacts: [bad] }, config).ok).toBe(false)
    }
    expect(validateStageFinishArgs({ verdict: '成功', summary: 'x', artifacts: [''] }, config).ok).toBe(false)
  })

  it('工具定义：schema 的 enum/required 与配置同源，instructions 带状态定义', () => {
    const tool = buildStageFinishTool({ verdicts: ['成功', '需修订'], verdictDefs: { 成功: '可以交付', 需修订: '要改一处' } })
    expect(tool.name).toBe(STAGE_FINISH_TOOL)
    expect(tool.category).toBe('workflow')
    expect(tool.builtIn).toBe(true)
    expect(tool.input_schema.properties.verdict.enum).toEqual(['成功', '需修订'])
    expect(tool.input_schema.required).toEqual(['verdict', 'summary'])
    expect(tool.instructions).toContain('- 成功：可以交付')
    expect(tool.instructions).toContain('- 需修订：要改一处')
    expect(tool.description).toContain('成功 / 需修订')
    // 没有定义时仍逐字列出状态名，不吐空冒号。
    const plain = buildStageFinishTool({ verdicts: ['pass'] })
    expect(plain.instructions).toContain('- pass')
    expect(plain.instructions).not.toContain('- pass：')
  })
})
