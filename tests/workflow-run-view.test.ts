// PLAN-workflow-run-view：运行视图纯推导的单测。钉：最近一次 stage 赢（RETRY/
// 回边的多次访问）、running/settled/failed 的判定、走过的边按「源节点结算出的
// when」匹配（fan-out 同状态多目标一起亮）、键格式与画布 edgeIdOf 同源。

import { describe, expect, it } from 'vitest'
import { runExecutionChain, runNodeStates, runVisitCounts, runTakenEdges, runEdgeKey, verdictKindOf } from '../src/shared/workflow/run-view'
import type { PipelineStageRun, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../src/shared/workflow/types'

const stage = (patch: Partial<PipelineStageRun> & { id: string; nodeId: string }): PipelineStageRun => ({
  runId: 'prun_x',
  continues: 0,
  startedAt: '2026-11-15T10:00:00.000Z',
  ...patch,
})

const edge = (from: string, when: string, to: string): WorkflowEdge => ({ from, when, to })

describe('runNodeStates', () => {
  it('最近一次 stage 赢（RETRY/回边的多次访问）', () => {
    const states = runNodeStates([
      stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z', verdict: 'fail' }),
      stage({ id: 's2', nodeId: 'a', startedAt: '2026-11-15T10:05:00.000Z', verdict: 'pass' }),
    ])
    expect(states.get('a')).toMatchObject({ status: 'settled', verdict: 'pass' })
  })

  it('startedAt 同刻的后写者赢（同一毫秒的重入不会卡在旧行）', () => {
    const states = runNodeStates([
      stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z', verdict: 'fail' }),
      stage({ id: 's2', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z', verdict: 'pass' }),
    ])
    expect(states.get('a')?.verdict).toBe('pass')
  })

  it('running：有开始、没结束、没 verdict；settled：verdict 在场', () => {
    const states = runNodeStates([
      stage({ id: 's1', nodeId: 'a' }),
      stage({ id: 's2', nodeId: 'b', verdict: 'pass' }),
    ])
    expect(states.get('a')).toEqual({ status: 'running' })
    expect(states.get('b')).toEqual({ status: 'settled', verdict: 'pass' })
  })

  it('failed：error 优先于 verdict（激发耗尽的行两个都可能挂）', () => {
    const states = runNodeStates([stage({ id: 's1', nodeId: 'a', verdict: 'fail', error: '阶段超时' })])
    expect(states.get('a')).toEqual({ status: 'failed', error: '阶段超时' })
  })

  it('没跑到的节点不进表（画布据此画 idle 弱化）', () => {
    expect(runNodeStates([stage({ id: 's1', nodeId: 'a', verdict: 'pass' })]).has('b')).toBe(false)
  })
})

// 执行链（user 2026-11-20「右栏前进/后退顺着执行链路走」）：stage 行按开始
// 时间正序 = 执行序，逐行编「该节点第几次」。导航条拿它定位节点与运行次数。
describe('runExecutionChain', () => {
  it('按 startedAt 正序编排，visit 从 1 起', () => {
    const chain = runExecutionChain([
      stage({ id: 's2', nodeId: 'b', startedAt: '2026-11-15T10:05:00.000Z' }),
      stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z' }),
    ])
    expect(chain).toEqual([
      { stageId: 's1', nodeId: 'a', visit: 1 },
      { stageId: 's2', nodeId: 'b', visit: 1 },
    ])
  })

  it('同节点多次执行各占一步、visit 递增（RETRY/回边）', () => {
    const chain = runExecutionChain([
      stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z' }),
      stage({ id: 's2', nodeId: 'b', startedAt: '2026-11-15T10:01:00.000Z' }),
      stage({ id: 's3', nodeId: 'a', startedAt: '2026-11-15T10:02:00.000Z' }),
      stage({ id: 's4', nodeId: 'a', startedAt: '2026-11-15T10:03:00.000Z' }),
    ])
    expect(chain.map((s) => `${s.nodeId}#${s.visit}`)).toEqual(['a#1', 'b#1', 'a#2', 'a#3'])
  })

  it('startedAt 同刻按数组序（stable sort，落库顺序兜底）', () => {
    const chain = runExecutionChain([
      stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z' }),
      stage({ id: 's2', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z' }),
    ])
    expect(chain.map((s) => s.stageId)).toEqual(['s1', 's2'])
    expect(chain.map((s) => s.visit)).toEqual([1, 2])
  })

  it('空输入 → 空链；入参数组不被改动（纯函数）', () => {
    const input = [stage({ id: 's2', nodeId: 'b', startedAt: '2026-11-15T10:05:00.000Z' }), stage({ id: 's1', nodeId: 'a', startedAt: '2026-11-15T10:00:00.000Z' })]
    expect(runExecutionChain([])).toEqual([])
    runExecutionChain(input)
    expect(input.map((s) => s.id)).toEqual(['s2', 's1'])
  })
})

// 次数徽标的数据面（user 2026-11-20 二刀「右上角展示执行次数」）：stage 行数
// = 该节点跑过的次数（含正在跑的那次），没跑过不进表（卡上不给徽标）。
describe('runVisitCounts', () => {
  it('按行数累加，重入节点多计；没跑过不进表', () => {
    const counts = runVisitCounts([
      stage({ id: 's1', nodeId: 'a' }),
      stage({ id: 's2', nodeId: 'b' }),
      stage({ id: 's3', nodeId: 'a' }),
    ])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
    expect(counts.has('c')).toBe(false)
  })

  it('空输入 → 空表', () => {
    expect(runVisitCounts([]).size).toBe(0)
  })
})

describe('runTakenEdges', () => {
  it('源节点结算出的 when 匹配 ⇒ 边亮；键格式 = edge:from|when|to', () => {
    const taken = runTakenEdges([edge('a', 'pass', 'b'), edge('a', 'fail', 'c')], [
      stage({ id: 's1', nodeId: 'a', verdict: 'fail' }),
    ])
    expect(taken.has(runEdgeKey('a', 'fail', 'c'))).toBe(true)
    expect(taken.has(runEdgeKey('a', 'pass', 'b'))).toBe(false)
  })

  it('fan-out 同状态多目标一起亮（结算面没有目标信息，按状态亮是诚实的近似）', () => {
    const taken = runTakenEdges([edge('a', 'pass', 'b'), edge('a', 'pass', 'c')], [
      stage({ id: 's1', nodeId: 'a', verdict: 'pass' }),
    ])
    expect(taken.size).toBe(2)
  })

  it('多节点多 verdict 各自匹配；重入节点两个 verdict 都算走过', () => {
    const taken = runTakenEdges(
      [edge('a', 'pass', 'b'), edge('b', 'fail', 'a'), edge('a', 'fail', 'FAILED' as never)],
      [
        stage({ id: 's1', nodeId: 'a', verdict: 'pass' }),
        stage({ id: 's2', nodeId: 'b', verdict: 'fail' }),
        stage({ id: 's3', nodeId: 'a', verdict: 'fail' }),
      ],
    )
    expect(taken.size).toBe(3)
  })

  it('running（没 verdict）不算走过', () => {
    const taken = runTakenEdges([edge('a', 'pass', 'b')], [stage({ id: 's1', nodeId: 'a' })])
    expect(taken.size).toBe(0)
  })
})

// 结果状态的**语义**（user 2026-11-17「你是不是写死了把 pass 作为成功态，failed
// 为失败态？」）：配色不认词面，只认声明或拓扑。词表是用户自定义的（成功/失败/
// 需修订…），所以「pass 绿 / fail 红」这种字面判断必须彻底消失。
const node = (id: string, patch: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  title: id,
  prompt: id,
  verdicts: ['pass'],
  ...patch,
})
const def = (nodes: WorkflowNode[], edges: WorkflowEdge[]): Pick<WorkflowDefinition, 'nodes' | 'edges'> => ({ nodes, edges })

describe('verdictKindOf', () => {
  it('显式声明赢（哪怕与词面/拓扑相反）', () => {
    const d = def(
      [node('a', { verdicts: ['成功', '失败'], verdictKinds: { 成功: 'failure', 失败: 'success' } })],
      [edge('a', '成功', 'DONE'), edge('a', '失败', 'FAILED')],
    )
    expect(verdictKindOf(d, 'a', '成功')).toBe('failure')
    expect(verdictKindOf(d, 'a', '失败')).toBe('success')
  })

  it('未声明：出边指向 DONE ⇒ success（中文词表同一条路径）', () => {
    const d = def([node('a', { verdicts: ['好的'] })], [edge('a', '好的', 'DONE')])
    expect(verdictKindOf(d, 'a', '好的')).toBe('success')
  })

  it('未声明：出边指向 FAILED ⇒ failure', () => {
    const d = def([node('a')], [edge('a', 'pass', 'FAILED')])
    expect(verdictKindOf(d, 'a', 'pass')).toBe('failure')
  })

  it('未声明且一条出边都没有 ⇒ failure（引擎 fail-safe：匹配不到出边 = 实例失败）', () => {
    const d = def([node('a', { verdicts: ['嗯'] })], [])
    expect(verdictKindOf(d, 'a', '嗯')).toBe('failure')
  })

  it('未声明、只连到中间节点 ⇒ neutral（在流程里只是「往哪走」）', () => {
    const d = def([node('a'), node('b')], [edge('a', 'pass', 'b')])
    expect(verdictKindOf(d, 'a', 'pass')).toBe('neutral')
  })

  it('同一状态名同时连 DONE 与 FAILED ⇒ DONE 优先（扇出到两个终态的退化形态）', () => {
    const d = def([node('a')], [edge('a', 'pass', 'FAILED'), edge('a', 'pass', 'DONE')])
    expect(verdictKindOf(d, 'a', 'pass')).toBe('success')
  })

  it('声明按节点隔离：a 把 pass 标成 neutral 不影响 b 的推导向', () => {
    const d = def(
      [node('a', { verdictKinds: { pass: 'neutral' } }), node('b')],
      [edge('a', 'pass', 'DONE'), edge('b', 'pass', 'DONE')],
    )
    expect(verdictKindOf(d, 'a', 'pass')).toBe('neutral')
    expect(verdictKindOf(d, 'b', 'pass')).toBe('success')
  })

  it('同一个词在不同节点可以有不同语义（「完成」在评审节点是中性、在发布节点是成功）', () => {
    const d = def(
      [node('review', { verdictKinds: { 完成: 'neutral' } }), node('publish', { verdictKinds: { 完成: 'success' } })],
      [edge('review', '完成', 'publish'), edge('publish', '完成', 'DONE')],
    )
    expect(verdictKindOf(d, 'review', '完成')).toBe('neutral')
    expect(verdictKindOf(d, 'publish', '完成')).toBe('success')
  })
})
