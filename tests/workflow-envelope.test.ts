// PLAN-workflow-context：阶段信封单测（纯函数）。钉：块渲染、去重表 4 行逐条
// （plan §3.3）、预算裁剪（§3.6）、边界语义（§3.7）、stageContractNote 迁入后
// 的行为不变，以及 wiring 扫描（引擎与预览共用同一份 composeStagePrompt）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildEnvelope,
  composeStagePrompt,
  DEFAULT_ENVELOPE_CAP_CHARS,
  DONE_HEADING,
  stageContractNote,
  TASK_HEADING,
  type EnvelopeBlock,
  type EnvelopeBlockId,
  type EnvelopeContext,
} from '../src/shared/workflow/envelope'
import { resolveWorkflowHandoff } from '../src/shared/workflow/handoff'
import { PREFIX } from '../src/shared/workflow/contract'
import type { WorkflowNode } from '../src/shared/workflow/types'

const handoff = resolveWorkflowHandoff('/ws', 'run_x7f2')

function makeNode(patch: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: 'n2', title: '抓取竞品价格', prompt: '抓取三家价格页，写入 prices.csv。', verdicts: ['pass'], ...patch }
}

function makeCtx(patch: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return {
    workflowName: '竞品监控流水线',
    stageIndex: 2,
    stageTotal: 5,
    handoff,
    ...patch,
  }
}

const baseVars = {
  runObjective: '每周汇总三家竞品的官网价格',
  visit: 1,
  workspace: '/ws',
}

function blockOf(blocks: EnvelopeBlock[], id: EnvelopeBlockId): EnvelopeBlock | undefined {
  return blocks.find((b) => b.id === id)
}

describe('buildEnvelope：块渲染', () => {
  it('位置块 = 承重墙：阶段序号 + 分工声明', () => {
    const { blocks } = buildEnvelope(makeNode(), baseVars, makeCtx())
    const pos = blockOf(blocks, 'position')!
    expect(pos.heading).toBe('── 你在这个工作流里的位置 ──')
    expect(pos.body).toContain('第 2/5 阶段「抓取竞品价格」')
    expect(pos.body).toContain('不要代做')
  })

  it('单阶段工作流：不说「其余阶段由其他会话负责」这种谎', () => {
    const { blocks } = buildEnvelope(makeNode(), baseVars, makeCtx({ stageIndex: 1, stageTotal: 1 }))
    expect(blockOf(blocks, 'position')!.body).toContain('单阶段「抓取竞品价格」')
    expect(blockOf(blocks, 'position')!.body).not.toContain('其余阶段由其他会话负责')
  })

  it('全局目标块：运行级 > 工作流级；都没有 = 「（未提供全局目标）」空态标注（与 renderNodePrompt 同哲学）', () => {
    const { blocks } = buildEnvelope(makeNode(), { workflowObjective: '工作流级' }, makeCtx())
    expect(blockOf(blocks, 'objective')!.body).toBe('工作流级')
    const empty = buildEnvelope(makeNode(), {}, makeCtx())
    expect(blockOf(empty.blocks, 'objective')!.body).toBe('（未提供全局目标）')
  })

  it('输入块：label：value 一行一项；没填标「（未填）」；没声明输入 = 整块缺席', () => {
    const inputs = [
      { key: 'siteA', label: '竞品A官网', default: '' },
      { key: 'siteB', label: '竞品B官网' },
    ]
    const withInputs = buildEnvelope(makeNode(), { ...baseVars, vars: { siteA: 'https://a.com' } }, makeCtx({ inputs }))
    expect(blockOf(withInputs.blocks, 'inputs')!.body).toBe('竞品A官网：https://a.com\n竞品B官网：（未填）')
    const none = buildEnvelope(makeNode(), baseVars, makeCtx())
    expect(blockOf(none.blocks, 'inputs')).toBeUndefined()
  })

  it('上游块（单上游）：来自「标题」+ verdict 释义（来自上游 verdictDefs）+ 相对路径 + 提示语', () => {
    const upstreams = [{ title: '列出竞品清单', verdict: 'pass', verdictDef: '清单已确认且三项都找到', handoffRel: '.pulsemind/workflows/run_x7f2/n1-handoff.md' }]
    const { blocks } = buildEnvelope(makeNode(), baseVars, makeCtx({ upstreams }))
    const up = blockOf(blocks, 'upstream')!
    expect(up.heading).toBe('── 上游交接 · 来自「列出竞品清单」 ──')
    expect(up.body).toContain('verdict：pass（按上游定义：清单已确认且三项都找到）')
    expect(up.body).toContain('交接文件：.pulsemind/workflows/run_x7f2/n1-handoff.md')
    expect(up.body).toContain('下游须知')
  })

  it('上游块（多上游 AND-join）：每上游一行路径 + 汇合块头', () => {
    const upstreams = [
      { title: 'A', verdict: 'pass', handoffRel: '.pulsemind/workflows/run_x7f2/a-handoff.md' },
      { title: 'B', verdict: 'fail', verdictDef: '有失败项', handoffRel: '.pulsemind/workflows/run_x7f2/b-handoff.md' },
    ]
    const { blocks } = buildEnvelope(makeNode(), baseVars, makeCtx({ upstreams }))
    const up = blockOf(blocks, 'upstream')!
    expect(up.heading).toBe('── 上游交接（2 个上游已汇合） ──')
    expect(up.body).toContain('· 来自「A」 verdict：pass')
    expect(up.body).toContain('· 来自「B」 verdict：fail（有失败项）')
    expect(up.body).toContain('a-handoff.md')
  })

  it('RETRY 自环：块头标「本节点第 N 次运行 · 上次交接」', () => {
    const upstreams = [{ title: '抓取竞品价格', verdict: 'fail', handoffRel: '.pulsemind/workflows/run_x7f2/n2-handoff.md', self: true }]
    const { blocks } = buildEnvelope(makeNode(), { ...baseVars, visit: 2 }, makeCtx({ upstreams }))
    const up = blockOf(blocks, 'upstream')!
    expect(up.heading).toBe('── 上游交接 · 本节点第 2 次运行 · 上次交接 ──')
  })

  it('入口节点：上游块整体不渲染（而不是渲染「（无）」）', () => {
    const { blocks } = buildEnvelope(makeNode(), baseVars, makeCtx({ upstreams: [] }))
    expect(blockOf(blocks, 'upstream')).toBeUndefined()
  })
})

describe('buildEnvelope：去重表 4 行逐条（plan §3.3）', () => {
  const inputs = [{ key: 'siteA', label: '竞品A官网' }, { key: 'siteB', label: '竞品B官网' }]
  const upstreams = [{ title: 'A', verdict: 'pass', handoffRel: '.pulsemind/workflows/run_x7f2/a-handoff.md' }]

  it('{{objective}} ⇒ 省略「全局目标」块（显式替换语义不变）', () => {
    const { blocks } = buildEnvelope(makeNode({ prompt: '目标见 {{objective}}' }), baseVars, makeCtx())
    expect(blockOf(blocks, 'objective')).toBeUndefined()
  })

  it('{{prevVerdict}} / {{prevSummary}} / {{prevArtifacts}} 任一 ⇒ 省略整个「上游交接」块', () => {
    for (const key of ['prevVerdict', 'prevSummary', 'prevArtifacts']) {
      const { blocks } = buildEnvelope(makeNode({ prompt: `x {{${key}}}` }), baseVars, makeCtx({ upstreams }))
      expect(blockOf(blocks, 'upstream'), key).toBeUndefined()
    }
  })

  it('{{某变量}} ⇒ 按变量粒度省略该项，未引用的其它输入照常列出；全部被引用 ⇒ 整块省略', () => {
    const partial = buildEnvelope(makeNode({ prompt: '抓 {{siteA}}' }), baseVars, makeCtx({ inputs, upstreams }))
    expect(blockOf(partial.blocks, 'inputs')!.body).not.toContain('竞品A官网')
    expect(blockOf(partial.blocks, 'inputs')!.body).toContain('竞品B官网：（未填）')
    const all = buildEnvelope(makeNode({ prompt: '抓 {{siteA}} {{siteB}}' }), baseVars, makeCtx({ inputs, upstreams }))
    expect(blockOf(all.blocks, 'inputs')).toBeUndefined()
  })

  it('{{visit}} / {{workspace}} / builtins ⇒ 不影响信封', () => {
    const { blocks } = buildEnvelope(makeNode({ prompt: '第 {{visit}} 次，工作区 {{workspace}}，日期 {{date}}' }), baseVars, makeCtx({ upstreams, inputs }))
    expect(blockOf(blocks, 'objective')).toBeDefined()
    expect(blockOf(blocks, 'upstream')).toBeDefined()
    expect(blockOf(blocks, 'inputs')).toBeDefined()
  })
})

describe('buildEnvelope：context 开关 + 预算（plan §3.6）', () => {
  const upstreams = [{ title: 'A', verdict: 'pass', handoffRel: '.pulsemind/workflows/run_x7f2/a-handoff.md' }]
  const inputs = [{ key: 'siteA', label: '竞品A官网' }]

  it('context.objective / upstream / inputs 显式 false ⇒ 对应块不渲染', () => {
    expect(blockOf(buildEnvelope(makeNode({ context: { objective: false } }), baseVars, makeCtx({ upstreams, inputs })).blocks, 'objective')).toBeUndefined()
    expect(blockOf(buildEnvelope(makeNode({ context: { upstream: false } }), baseVars, makeCtx({ upstreams, inputs })).blocks, 'upstream')).toBeUndefined()
    expect(blockOf(buildEnvelope(makeNode({ context: { inputs: false } }), baseVars, makeCtx({ upstreams, inputs })).blocks, 'inputs')).toBeUndefined()
  })

  it('裁剪优先级（先裁 → 后裁）：全局目标 → 运行输入 → 上游路径；裁掉就明说', () => {
    // 超长目标把总开销顶过预算：第一刀只裁目标块
    const longVars = { ...baseVars, runObjective: '长'.repeat(500) }
    const r1 = buildEnvelope(makeNode(), longVars, makeCtx({ envelopeCapChars: 700, upstreams, inputs }))
    expect(blockOf(r1.blocks, 'objective')).toBeUndefined()
    expect(r1.dropped[0]).toContain('全局目标超出信封预算')
    expect(blockOf(r1.blocks, 'inputs')).toBeDefined()
    expect(blockOf(r1.blocks, 'upstream')).toBeDefined()
    // 预算再收紧：输入块第二刀、上游块第三刀（dropped 顺序即优先级）
    const r2 = buildEnvelope(makeNode(), longVars, makeCtx({ envelopeCapChars: 200, upstreams, inputs }))
    expect(blockOf(r2.blocks, 'objective')).toBeUndefined()
    expect(blockOf(r2.blocks, 'inputs')).toBeUndefined()
    expect(blockOf(r2.blocks, 'upstream')).toBeUndefined()
    expect(r2.dropped[1]).toContain('运行输入超出信封预算')
    expect(r2.dropped[2]).toContain('已省略 1 个交接文件路径')
    expect(r2.dropped[2]).toContain('.pulsemind/workflows/run_x7f2')
  })

  it('缺省预算 32k：正常内容一个都不裁', () => {
    const { dropped } = buildEnvelope(makeNode(), baseVars, makeCtx({ upstreams, inputs }))
    expect(dropped).toEqual([])
    expect(DEFAULT_ENVELOPE_CAP_CHARS).toBe(32_000)
  })
})

describe('composeStagePrompt：完整拼装', () => {
  it('顺序 = 位置 → 全局目标 → 输入 → 上游 → 本阶段任务 → 完成方式；任务与完成方式永不裁剪', () => {
    const upstreams = [{ title: 'A', verdict: 'pass', handoffRel: '.pulsemind/workflows/run_x7f2/a-handoff.md' }]
    const vars = { ...baseVars, vars: { siteA: 'https://a.com' } }
    const ctx = makeCtx({ upstreams, inputs: [{ key: 'siteA', label: '竞品A官网' }], envelopeCapChars: 60 })
    const out = composeStagePrompt(makeNode({ prompt: '抓 {{siteA}}' }), vars, ctx)
    const at = (needle: string): number => out.indexOf(needle)
    expect(at('── 你在这个工作流里的位置 ──')).toBe(0)
    expect(at(TASK_HEADING)).toBeGreaterThan(at('── 全局目标 ──'))
    expect(at(DONE_HEADING)).toBeGreaterThan(at(TASK_HEADING))
    // 预算把前四个块都裁了，任务与完成方式照常在
    expect(out).toContain('抓 https://a.com')
    expect(out).toContain('finish_stage` 之前')
    expect(out).toContain('# 抓取竞品价格 交接')
  })

  it('显式 {{prevSummary}}：全文注入（20k 帽语义在 render 层）；信封上游块缺席', () => {
    const out = composeStagePrompt(makeNode({ prompt: '上游说 {{prevSummary}}' }), { ...baseVars, prevSummary: '摘要正文' }, makeCtx())
    expect(out).toContain('上游说 摘要正文')
    expect(out).not.toContain('── 上游交接')
  })

  it('默认单出口：无词汇表注记，但 handoff 契约在；自定义词汇表：stageContractNote 逐字节同旧版', () => {
    const def = composeStagePrompt(makeNode(), baseVars, makeCtx())
    expect(def).toContain(DONE_HEADING)
    expect(def).not.toContain('结果状态只能取')
    expect(def).not.toContain(PREFIX)
    const custom = composeStagePrompt(makeNode({ verdicts: ['pass', 'fail'], verdictDefs: { pass: '通过', fail: '失败' } }), baseVars, makeCtx())
    expect(custom).toContain('本阶段的结果状态只能取下面这些，按定义判断该报哪一个：')
    expect(custom).toContain('- fail：失败')
    expect(custom).toContain(`${PREFIX} {"verdict":"pass"`)
  })

  it('handoff 缺席：「完成方式」段只有契约注记（P0 形态兼容）', () => {
    const out = composeStagePrompt(makeNode(), baseVars, makeCtx({ handoff: undefined }))
    expect(out).toContain(DONE_HEADING)
    expect(out).not.toContain('交接文件')
  })
})

describe('stageContractNote（迁入 shared 后行为不变）', () => {
  it('默认单出口 = 空串（默认单出口的工作流一个字节都不加）', () => {
    expect(stageContractNote(makeNode())).toBe('')
    expect(stageContractNote(makeNode({ verdicts: [] }))).toBe('')
  })

  it('自定义词汇表无定义：只列名字；有定义：名字 + 定义', () => {
    const bare = stageContractNote(makeNode({ verdicts: ['pass', 'fail'] }))
    expect(bare).toContain('本阶段的结果状态只能取：pass / fail。')
    expect(bare).toContain('完成本阶段时调用 `finish_stage`')
    const defined = stageContractNote(makeNode({ verdicts: ['pass', 'fail'], verdictDefs: { pass: '通过' } }))
    expect(defined).toContain('- pass：通过')
    expect(defined).toContain('- fail\n')
  })
})

describe('wiring：引擎与预览共用同一份 composeStagePrompt（源码扫描）', () => {
  const read = (p: string): string => readFileSync(p, 'utf-8')

  it('pipeline-engine 走 composeStagePrompt + resolveWorkflowHandoff + 兜底回填；旧内联 stageContractNote 已撤', () => {
    const engine = read('src/main/pipeline/pipeline-engine.ts')
    expect(engine).toContain("from '../../shared/workflow/envelope'")
    expect(engine).toContain('composeStagePrompt(')
    expect(engine).toContain("from '../../shared/workflow/handoff'")
    expect(engine).toContain('backfillHandoff')
    expect(engine).not.toContain('function stageContractNote')
    expect(engine).not.toContain('renderStagePrompt(')
  })

  it('git-checkpoint 三条 pathspec 同批（add / clean / status 门）', () => {
    const git = read('src/main/pipeline/git-checkpoint.ts')
    expect(git).toContain("['add', '-A', '--', '.', ':!.pulsemind']")
    expect(git).toContain("['clean', '-fd', '-e', '.pulsemind']")
    expect(git).toContain("['status', '--porcelain', '--', '.', ':!.pulsemind']")
  })

  it('渲染端预览与引擎同函数（WorkflowCanvas import composeStagePrompt，不许手搓第二份）', () => {
    const canvas = read('src/renderer/src/components/routine/WorkflowCanvas.tsx')
    expect(canvas).toContain('composeStagePrompt')
    expect(canvas).toContain('resolveWorkflowHandoff')
  })
})
