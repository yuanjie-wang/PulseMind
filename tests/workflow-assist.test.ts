// 工作流助手（2026-11-09）：它的「表单」就是 WorkflowDefinition 本身——
// 画布是这份 JSON 的纯投影，所以补丁也直接说这份 JSON（nodes upsert / edges
// 整表 / removeNodes），不再走那条有损的线性阶段链。这个文件钉清洗、合并、
// 落位、快照与 spec 口径；会话机制在 useFormAssistSession（routine 侧共用的
// 那一半），不在本文件的射程内。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKFLOW_ASSIST_ALLOWED_TOOLS,
  WORKFLOW_ASSIST_SPEC,
  WORKFLOW_ASSISTANT_PROFILE,
  applyWorkflowAssistantPatch,
  sanitizeWorkflowPatch,
  workflowFormSnapshot,
} from '../src/renderer/src/components/routine/workflow-assist'
import { placeNewNodes } from '../src/shared/workflow/layout'
import { normalizeSimpleWorkflow } from '../src/shared/workflow/simplify'
import { missingVerdictDefs, validateWorkflow } from '../src/shared/workflow/validate'
import type { WorkflowDefinition } from '../src/shared/workflow/types'

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

/** 有分支潜力的最小图：两节点、各带一个状态定义、各自已落位（80/240）。 */
const baseDef = (partial: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id: 'wf-1',
  name: '原任务',
  description: '原描述',
  objective: '原目标',
  entry: 'a',
  nodes: [
    { id: 'a', title: 'A', prompt: '做 A', verdicts: ['pass'], verdictDefs: { pass: 'A 完成' }, layout: { x: 80, y: 80 } },
    { id: 'b', title: 'B', prompt: '做 B', verdicts: ['pass'], verdictDefs: { pass: 'B 完成' }, layout: { x: 80, y: 240 } },
  ],
  edges: [
    { from: 'a', when: 'pass', to: 'b' },
    { from: 'b', when: 'pass', to: 'DONE' },
  ],
  ...partial,
})

describe('sanitizeWorkflowPatch', () => {
  it('只认已知字段：标量裁剪、nodes/edges/removeNodes 逐项重建，旧 stages 词汇丢弃', () => {
    const res = sanitizeWorkflowPatch({
      name: ' 新任务 ',
      objective: '目标',
      cron: ' 0 9 * * * ',
      entry: ' draft ',
      unknown: 'ignored',
      // 旧词汇：留在这里只会让模型见到两种描述图的方式，必须当未知字段丢掉。
      stages: [{ id: 'legacy', title: '旧格式', prompt: 'p' }],
      inputs: [{ key: 'repo', label: '仓库' }, { key: '', label: '没有键' }, { label: '缺 key' }, 'not-an-object'],
      nodes: [
        { id: ' draft ', title: '起草', prompt: '写初稿', verdicts: ['pass', ' pass ', ' '], verdictDefs: { pass: '初稿写完', '  ': 'x', fail: '  ' } },
        { id: 'only-id' },
        null,
        'nope',
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'draft' },
        { from: 'a', when: '', to: 'b' },
      ],
      removeNodes: ['old', ' old ', ''],
    })
    expect(res).toEqual({
      name: '新任务',
      objective: '目标',
      cron: '0 9 * * *',
      entry: 'draft',
      inputs: [{ key: 'repo', label: '仓库' }],
      nodes: [{ id: 'draft', title: '起草', prompt: '写初稿', verdicts: ['pass'], verdictDefs: { pass: '初稿写完' } }],
      edges: [{ from: 'a', when: 'pass', to: 'draft' }],
      removeNodes: ['old'],
    })
    expect(res).not.toHaveProperty('stages')
    expect(res).not.toHaveProperty('unknown')
  })

  it('布尔/缺省字段只在形态对时保留（default 允许空串，仍是显式预填）', () => {
    const res = sanitizeWorkflowPatch({
      inputs: [{ key: 'k', label: 'K', required: true, default: '', multiline: 'yes' }],
    })
    expect(res?.inputs).toEqual([{ key: 'k', label: 'K', required: true, default: '' }])
  })

  it('edges 的两种空：[] 是显式清空，一条都不成形的非空表当缺席（别静默删用户的线）', () => {
    expect(sanitizeWorkflowPatch({ edges: [] })?.edges).toEqual([])
    const malformed = sanitizeWorkflowPatch({ name: '改个名', edges: [{}, 'x', { from: 'a' }, { from: 'a', when: 'pass' }] })
    expect(malformed).toEqual({ name: '改个名' })
    expect(malformed).not.toHaveProperty('edges')
  })

  it('verdictDefs 写成数组也收：带键对象 / 前缀文本 / 无键纯文本都归到 verdictDefsList', () => {
    // user 2026-11-09 实锤：模型把 verdictDefs 当数组交（[{verdict,text}] 或
    // ["pass: 全部通过"]），旧 sanitize 整块静默丢掉——同批的 prompt/title 照旧
    // 应用，于是用户看到「它啥也没补，只改了别的」。
    const res = sanitizeWorkflowPatch({
      nodes: [
        { id: 'a', verdictDefs: [{ verdict: 'pass', text: '全部通过' }] },
        { id: 'b', verdictDefs: [{ state: 'fail', definition: '存在必须修改的问题' }] },
        { id: 'c', verdictDefs: ['pass: 说清楚就算过'] },
        { id: 'd', verdictDefs: ['一行没写状态名的定义'] },
      ],
    })
    expect(res?.nodes).toEqual([
      { id: 'a', verdictDefsList: [{ verdict: 'pass', text: '全部通过' }] },
      { id: 'b', verdictDefsList: [{ verdict: 'fail', text: '存在必须修改的问题' }] },
      { id: 'c', verdictDefsList: [{ verdict: 'pass', text: '说清楚就算过' }] },
      { id: 'd', verdictDefsList: [{ text: '一行没写状态名的定义' }] },
    ])
    // 对象映射的值本身写成对象也认（取 text/def/definition 这类键）
    expect(sanitizeWorkflowPatch({ nodes: [{ id: 'a', verdictDefs: { pass: { definition: '过' } } }] })?.nodes).toEqual([
      { id: 'a', verdictDefs: { pass: '过' } },
    ])
  })

  it('没有任何可用内容 → null；非对象/数组同样 null', () => {
    expect(sanitizeWorkflowPatch({})).toBeNull()
    expect(sanitizeWorkflowPatch({ name: '', inputs: [], nodes: [{ id: 'only-id' }], removeNodes: ['  '] })).toBeNull()
    expect(sanitizeWorkflowPatch(null)).toBeNull()
    expect(sanitizeWorkflowPatch([] as unknown as Record<string, unknown>)).toBeNull()
  })
})

describe('applyWorkflowAssistantPatch：标量面', () => {
  it('字段级合并：提案缺席的字段原样保留，空 name 不把名字清空', () => {
    const next = applyWorkflowAssistantPatch({ name: '  ', objective: '新目标' }, baseDef())
    expect(next.name).toBe('原任务')
    expect(next.objective).toBe('新目标')
    expect(next.description).toBe('原描述')
    expect(next.nodes).toHaveLength(2)
  })

  it('cron 合并保留既有的 catchUp 与其它调度字段；没有 schedule 时补上且缺省 skip', () => {
    const kept = applyWorkflowAssistantPatch({ cron: '0 9 * * *' }, baseDef({ schedule: { cron: '0 1 * * *', catchUp: 'once', timezone: 'Asia/Shanghai' } }))
    expect(kept.schedule).toEqual({ cron: '0 9 * * *', catchUp: 'once', timezone: 'Asia/Shanghai' })
    expect(applyWorkflowAssistantPatch({ cron: '0 9 * * *' }, baseDef()).schedule).toEqual({ cron: '0 9 * * *', catchUp: 'skip' })
  })

  it('inputs 整体替换，label 空则回落到 key', () => {
    const next = applyWorkflowAssistantPatch(
      {
        inputs: [
          { key: 'repo', label: '', required: true },
          { key: 'to', label: '收件人', default: 'x', multiline: true },
        ],
      },
      baseDef(),
    )
    expect(next.inputs).toEqual([
      { key: 'repo', label: 'repo', required: true },
      { key: 'to', label: '收件人', default: 'x', multiline: true },
    ])
  })

  it('只有标量的提案让画布逐字不动（含终态芯片布局）', () => {
    const before = baseDef({ terminalLayout: { columns: 2 } })
    const next = applyWorkflowAssistantPatch({ description: '改描述' }, before)
    expect(next.nodes).toEqual(before.nodes)
    expect(next.edges).toEqual(before.edges)
    expect(next.entry).toBe(before.entry)
    expect(next.terminalLayout).toEqual({ columns: 2 })
  })
})

describe('applyWorkflowAssistantPatch：节点 upsert', () => {
  it('已有 id 只覆盖提案携带的字段——标题/词表/状态定义/坐标全部保留', () => {
    const before = baseDef()
    const next = applyWorkflowAssistantPatch({ nodes: [{ id: 'b', prompt: '做 B2' }] }, before)
    expect(next.nodes[1].prompt).toBe('做 B2')
    expect(next.nodes[1].title).toBe('B')
    expect(next.nodes[1].verdicts).toEqual(['pass'])
    expect(next.nodes[1].verdictDefs).toEqual({ pass: 'B 完成' })
    expect(next.nodes[1].layout).toEqual({ x: 80, y: 240 })
    expect(next.nodes[0]).toBe(before.nodes[0])
    expect(next.edges).toEqual(before.edges)
  })

  it('verdictDefs 是合并不是替换；词表收窄时孤儿定义被裁（与 simplify 同一口径）', () => {
    const wider = applyWorkflowAssistantPatch({ nodes: [{ id: 'b', verdicts: ['pass', 'fail'], verdictDefs: { fail: 'B 有问题' } }] }, baseDef())
    expect(wider.nodes[1].verdicts).toEqual(['pass', 'fail'])
    expect(wider.nodes[1].verdictDefs).toEqual({ pass: 'B 完成', fail: 'B 有问题' })
    const shrunk = applyWorkflowAssistantPatch({ nodes: [{ id: 'b', verdicts: ['pass'] }] }, wider)
    expect(shrunk.nodes[1].verdictDefs).toEqual({ pass: 'B 完成' })
  })

  it('数组式定义没写状态名时按位置对齐活节点词表（补齐模式不该要求模型重复 verdicts）', () => {
    const before = baseDef({
      nodes: [{ id: 'a', title: 'A', prompt: '做 A', verdicts: ['pass', 'fail'], verdictDefs: { pass: '旧口径' } }],
      edges: [],
    })
    const patch = sanitizeWorkflowPatch({ nodes: [{ id: 'a', verdictDefs: ['全部通过', '存在必须修改的问题'] }] })!
    const next = applyWorkflowAssistantPatch(patch, before)
    expect(next.nodes[0].verdictDefs).toEqual({ pass: '全部通过', fail: '存在必须修改的问题' })
    // 补齐模式就该只补定义：词表、提示词、标题一个字都没被碰。
    expect(next.nodes[0].verdicts).toEqual(['pass', 'fail'])
    expect(next.nodes[0].prompt).toBe('做 A')
    expect(next.nodes[0].title).toBe('A')
  })

  it('词表外的显式状态名按位置兜底（"Fail: …" 对不上小写词表时也不能丢），纯文本不被前缀解析吃掉', () => {
    const before = baseDef({
      nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass', 'fail'], verdictDefs: {} }],
      edges: [],
    })
    const patch = sanitizeWorkflowPatch({
      nodes: [{ id: 'a', verdictDefs: ['Pass condition: all tests green', 'Fail: anything red'] }],
    })!
    // 第一项不含「短前缀 + 冒号」形态，原样当纯文本；第二项的前缀被解析成 'Fail'，
    // 但活词表是小写 'fail'——照用会撞进 nodeVerdictDefs 的孤儿键裁剪而整条丢掉。
    expect(patch.nodes?.[0].verdictDefsList).toEqual([{ text: 'Pass condition: all tests green' }, { verdict: 'Fail', text: 'anything red' }])
    const next = applyWorkflowAssistantPatch(patch, before)
    expect(next.nodes[0].verdictDefs).toEqual({ pass: 'Pass condition: all tests green', fail: 'anything red' })
  })

  it('串联门：助手产物经「清洗→合并→归一」后必须过保存写门（requireVerdictDefs）', () => {
    // 这项不是清洗细节，是整条链的接缝：助手说对了图、落地也落了，只要少了
    // 定义，用户一按保存就被拦——「补了定义还是存不下」。三种形态都要走通：
    // ① 从空白建分支图；② verdictDefs 是数组（上一轮真事故形态）；③ 只补定义。
    const blank: WorkflowDefinition = {
      id: 'flow-1',
      name: '内容生产',
      entry: 'step1',
      nodes: [{ id: 'step1', title: '新环节', prompt: '做事', verdicts: ['pass'] }],
      edges: [],
    }
    const chain = (raw: unknown, from: WorkflowDefinition): WorkflowDefinition =>
      normalizeSimpleWorkflow(applyWorkflowAssistantPatch(sanitizeWorkflowPatch(raw)!, from))

    const built = chain(
      {
        entry: 'draft',
        nodes: [
          { id: 'draft', title: '起草', prompt: '写初稿', verdicts: ['pass', 'fail'], verdictDefs: { pass: '初稿写完', fail: '缺章节' } },
          { id: 'review', title: '评审', prompt: '评审初稿', verdicts: ['pass', 'fail'], verdictDefs: { pass: '无必修项', fail: '有必修项' } },
        ],
        removeNodes: ['step1'],
        edges: [
          { from: 'draft', when: 'pass', to: 'review' },
          { from: 'draft', when: 'fail', to: 'draft' },
          { from: 'review', when: 'pass', to: 'DONE' },
          { from: 'review', when: 'fail', to: 'draft' },
        ],
      },
      blank,
    )
    const arrayForm = chain(
      {
        entry: 'a',
        nodes: [
          {
            id: 'a',
            title: '起草',
            prompt: 'p',
            verdicts: ['pass', 'fail'],
            verdictDefs: [
              { verdict: 'pass', text: '初稿完成' },
              { verdict: 'fail', text: '初稿缺失' },
            ],
          },
        ],
        removeNodes: ['step1'],
        edges: [
          { from: 'a', when: 'pass', to: 'DONE' },
          { from: 'a', when: 'fail', to: 'a' },
        ],
      },
      blank,
    )
    const patched = chain(
      {
        nodes: [
          { id: 'draft', verdictDefs: { pass: '写完', fail: '没写完' } },
          { id: 'review', verdictDefs: { pass: '过', fail: '不过' } },
        ],
      },
      normalizeSimpleWorkflow({
        ...blank,
        nodes: [
          { id: 'draft', title: '起草', prompt: 'p', verdicts: ['pass', 'fail'] },
          { id: 'review', title: '评审', prompt: 'p', verdicts: ['pass', 'fail'] },
        ],
        edges: [{ from: 'draft', when: 'pass', to: 'review' }, { from: 'draft', when: 'fail', to: 'draft' }, { from: 'review', when: 'pass', to: 'DONE' }],
      }),
    )
    for (const [name, def] of [
      ['建图', built],
      ['数组形态', arrayForm],
      ['只补定义', patched],
    ] as const) {
      const gate = validateWorkflow(def, { requireVerdictDefs: true })
      expect(gate.ok, `${name}：${JSON.stringify(gate.errors)}`).toBe(true)
      expect(missingVerdictDefs(def), name).toEqual([])
      // 快照随之不再带缺口清单：模型下一轮不会再被要求补同一批定义。
      expect(workflowFormSnapshot(def)).not.toHaveProperty('missingDefinitions')
    }
  })

  it('新节点：无 id 铸 step<k>，entry 不变，产物恒过校验门', () => {
    const next = applyWorkflowAssistantPatch(
      {
        nodes: [{ title: '新节点', prompt: '做新' }],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'b', when: 'pass', to: 'step3' },
          { from: 'step3', when: 'pass', to: 'DONE' },
        ],
      },
      baseDef(),
    )
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'b', 'step3'])
    expect(next.nodes[2].title).toBe('新节点')
    expect(next.nodes[2].verdicts).toEqual(['pass'])
    expect(next.entry).toBe('a')
    expect(validateWorkflow(next).ok).toBe(true)
  })

  it('铸号避开已占用 id 与保留字；回传的非法 id 丢弃改铸（别让一次坏回传废掉整份草稿）', () => {
    const busy = baseDef({
      nodes: [...baseDef().nodes, { id: 'step3', title: 'S3', prompt: 'p', verdicts: ['pass'] }],
    })
    const next = applyWorkflowAssistantPatch({ nodes: [{ title: '新' }, { id: '1bad', title: '坏 id' }] }, busy)
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'b', 'step3', 'step4', 'step5'])
  })

  it('同一份提案里重复写同一个 id = 依次叠加（后一条基于前一条的结果）', () => {
    const next = applyWorkflowAssistantPatch(
      {
        nodes: [
          { id: 'b', prompt: '一' },
          { id: 'b', title: 'B2' },
        ],
      },
      baseDef(),
    )
    expect(next.nodes).toHaveLength(2)
    expect(next.nodes[1]).toEqual({ ...baseDef().nodes[1], prompt: '一', title: 'B2' })
  })
})

describe('applyWorkflowAssistantPatch：连线与删除', () => {
  it('edges 是整表：给了就替换（[] 清空），节点一个不动', () => {
    const replaced = applyWorkflowAssistantPatch({ edges: [{ from: 'a', when: 'pass', to: 'DONE' }] }, baseDef())
    expect(replaced.edges).toEqual([{ from: 'a', when: 'pass', to: 'DONE' }])
    const cleared = applyWorkflowAssistantPatch({ edges: [] }, baseDef())
    expect(cleared.edges).toEqual([])
    expect(cleared.nodes).toEqual(baseDef().nodes)
  })

  it('removeNodes 级联掉两端连线；删掉入口则回落首个节点', () => {
    const dropLeaf = applyWorkflowAssistantPatch({ removeNodes: ['b'] }, baseDef())
    expect(dropLeaf.nodes.map((n) => n.id)).toEqual(['a'])
    expect(dropLeaf.edges).toEqual([])
    expect(dropLeaf.entry).toBe('a')

    const dropEntry = applyWorkflowAssistantPatch({ removeNodes: ['a'] }, baseDef())
    expect(dropEntry.nodes.map((n) => n.id)).toEqual(['b'])
    expect(dropEntry.entry).toBe('b')
    // 只级联掉与被删节点相连的那条，b→DONE 原样留着。
    expect(dropEntry.edges).toEqual([{ from: 'b', when: 'pass', to: 'DONE' }])
  })

  it('removeNodes 同时给了 edges：以提案的整表为准，不再二次级联', () => {
    const next = applyWorkflowAssistantPatch({ removeNodes: ['b'], edges: [{ from: 'a', when: 'pass', to: 'DONE' }] }, baseDef())
    expect(next.nodes.map((n) => n.id)).toEqual(['a'])
    expect(next.edges).toEqual([{ from: 'a', when: 'pass', to: 'DONE' }])
  })

  it('图被动过就清掉终态布局（列数可能已变）；entry 提案只在目标还活着时采纳', () => {
    const next = applyWorkflowAssistantPatch({ edges: [] }, baseDef({ terminalLayout: { columns: 2 } }))
    expect('terminalLayout' in next).toBe(false)
    expect(applyWorkflowAssistantPatch({ entry: 'b' }, baseDef()).entry).toBe('b')
    expect(applyWorkflowAssistantPatch({ entry: 'ghost' }, baseDef()).entry).toBe('a')
  })
})

describe('新节点的落位（placeNewNodes）', () => {
  it('贴在已定位上游的正下方一层；两个同上游的新节点不叠在一起', () => {
    const next = applyWorkflowAssistantPatch(
      {
        nodes: [
          { id: 'x', title: 'X', prompt: 'p' },
          { id: 'y', title: 'Y', prompt: 'p' },
        ],
        edges: [
          { from: 'a', when: 'pass', to: 'b' },
          { from: 'b', when: 'pass', to: 'x' },
          { from: 'b', when: 'pass', to: 'y' },
        ],
      },
      baseDef(),
    )
    const [, b, x, y] = next.nodes
    expect(x.layout?.x).toBe(b.layout!.x)
    expect(x.layout!.y).toBeGreaterThan(b.layout!.y)
    expect(y.layout!.y).toBe(x.layout!.y)
    expect(y.layout!.x).not.toBe(x.layout!.x)
    // 用户摆好的卡一律不动。
    expect(b.layout).toEqual({ x: 80, y: 240 })
  })

  it('没有已定位上游就落在既有构图的下方一行', () => {
    const next = applyWorkflowAssistantPatch({ nodes: [{ id: '孤岛', title: '孤岛', prompt: 'p' }] }, baseDef())
    const orphan = next.nodes.find((n) => n.title === '孤岛')!
    // 非法 id 也被改铸了，用 title 找。
    expect(orphan.layout!.y).toBeGreaterThan(240)
    expect(orphan.layout!.x).toBe(80)
  })

  it('一个已定位节点都没有（空图/全新生成）时原样返回，交给 autoWorkflowLayout', () => {
    const bare: WorkflowDefinition = {
      id: 'wf-2',
      name: '空',
      entry: 'a',
      nodes: [
        { id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] },
        { id: 'b', title: 'B', prompt: 'p', verdicts: ['pass'] },
      ],
      edges: [{ from: 'a', when: 'pass', to: 'b' }],
    }
    expect(placeNewNodes(bare)).toBe(bare)
  })
})

describe('workflowFormSnapshot', () => {
  it('快照就是这张图：带 verdicts/verdictDefs/edges/entry，不带坐标与运行设置', () => {
    const snap = workflowFormSnapshot(baseDef({ schedule: { cron: '0 9 * * *' }, inputs: [{ key: 'k', label: 'K' }], terminalLayout: { columns: 2 } }))
    expect(snap).toEqual({
      name: '原任务',
      description: '原描述',
      objective: '原目标',
      cron: '0 9 * * *',
      inputs: [{ key: 'k', label: 'K' }],
      entry: 'a',
      nodes: [
        { id: 'a', title: 'A', prompt: '做 A', verdicts: ['pass'], verdictDefs: { pass: 'A 完成' } },
        { id: 'b', title: 'B', prompt: '做 B', verdicts: ['pass'], verdictDefs: { pass: 'B 完成' } },
      ],
      edges: [
        { from: 'a', when: 'pass', to: 'b' },
        { from: 'b', when: 'pass', to: 'DONE' },
      ],
    })
    // 坐标是用户的构图、params/batch/triggers 是运行设置——都不进「表单」。
    const text = JSON.stringify(snap)
    expect(text).not.toContain('"layout"')
    expect(text).not.toContain('"terminalLayout"')
    expect(text).not.toContain('"params"')
    expect(text).not.toContain('"triggers"')
  })

  it('多状态节点连词表与定义一起上送（模型要能看见分支才改得动分支）', () => {
    const snap = workflowFormSnapshot(
      baseDef({
        nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['通过', '需修订'], verdictDefs: { 通过: '没问题', 需修订: '要改' } }],
      }),
    )
    expect((snap.nodes as Array<Record<string, unknown>>)[0]).toEqual({
      id: 'a',
      title: 'A',
      prompt: 'p',
      verdicts: ['通过', '需修订'],
      verdictDefs: { 通过: '没问题', 需修订: '要改' },
    })
  })

  it('缺定义的格子逐个列进 missingDefinitions（补齐是机械任务，不是重新设计）', () => {
    // user 2026-11-09 实锤：「让它补完成定义，然后它就啥了，开始改流程」——
    // 模型只看得见「这张图缺东西」，看不见缺哪一格。清单来自写门的同一份判定。
    const def = baseDef({
      nodes: [
        { id: 'a', title: 'A', prompt: 'p', verdicts: ['pass', 'fail'], verdictDefs: { pass: '没问题' } },
        { id: 'b', title: 'B', prompt: 'q', verdicts: ['pass'], verdictDefs: { pass: '完成' } },
      ],
    })
    expect(workflowFormSnapshot(def).missingDefinitions).toEqual([{ node: 'a', verdict: 'fail' }])
    // 一条都不缺时该键缺席：空数组会把注意力从真正该做的事上引开。
    expect(workflowFormSnapshot(baseDef())).not.toHaveProperty('missingDefinitions')
  })
})

describe('spec / 内部专家包', () => {
  it('会话前缀与 clientId 与 routine 侧不撞', () => {
    expect(WORKFLOW_ASSIST_SPEC.conversationPrefix).toBe('workflow')
    expect(WORKFLOW_ASSIST_SPEC.clientId).toBe('workflow-assist')
  })

  it('字段表就是图的一半：nodes/edges/removeNodes/entry 都在，stages 已撤', () => {
    expect(WORKFLOW_ASSIST_SPEC.fields.map((f) => f.key)).toEqual([
      'name',
      'description',
      'objective',
      'nodes',
      'edges',
      'removeNodes',
      'entry',
      'inputs',
      'cron',
    ])
    expect(WORKFLOW_ASSIST_SPEC.fields.map((f) => f.key)).not.toContain('stages')
  })

  it('口径讲清了增量、整表连线、状态定义必填与 ask_user', () => {
    const rules = WORKFLOW_ASSIST_SPEC.rules.join('\n')
    for (const needle of ['增量', '整张', 'verdictDefs', 'DONE', 'removeNodes', 'ask_user', '{{key}}']) {
      expect(rules, `口径缺少「${needle}」`).toContain(needle)
    }
    const rulesEn = WORKFLOW_ASSIST_SPEC.rulesEn.join('\n')
    expect(rulesEn).toContain('INCREMENTAL')
    expect(rulesEn).toContain('COMPLETE transition table')
    expect(rulesEn).toContain('verdictDefs')
  })

  it('口径给出外科模式与「缺哪几格」的指路（补定义不是重新设计）', () => {
    const rules = WORKFLOW_ASSIST_SPEC.rules.join('\n')
    // 只补定义 = 合法且完整的提案；不借机增删节点/重写连线。
    expect(rules).toContain('只改用户点到的那一处')
    expect(rules).toContain('不要借机改别的')
    expect(rules).toContain('missingDefinitions')
    // verdictDefs 的形状（对象映射 vs 数组）必须写明，否则模型只能猜。
    expect(rules).toContain('不是数组')

    const rulesEn = WORKFLOW_ASSIST_SPEC.rulesEn.join('\n')
    expect(rulesEn).toContain('Change only what was asked')
    expect(rulesEn).toContain('missingDefinitions')
    expect(rulesEn).toContain('never an array')
  })

  it('nodes 的字段说明直接给出含 verdictDefs 的真样例（schema 不再靠猜）', () => {
    const nodesField = WORKFLOW_ASSIST_SPEC.fields.find((f) => f.key === 'nodes')!
    expect(nodesField.label).toContain('"verdictDefs":{"pass"')
    expect(nodesField.labelEn).toContain('"verdictDefs":{"pass"')
  })

  it('工具白名单是显式单元素数组（内部包不得"缺省 = 不限制"）', () => {
    expect(WORKFLOW_ASSIST_ALLOWED_TOOLS).toEqual(['ask_user'])
    expect(WORKFLOW_ASSISTANT_PROFILE.id).toBe('internal-workflow-assistant')
    expect(WORKFLOW_ASSISTANT_PROFILE.skillNames).toEqual([])
    expect(WORKFLOW_ASSISTANT_PROFILE.mcpServerIds).toEqual([])
    // 专家人设也说同一件事：设计一张节点图，而不是一条阶段链。
    expect(WORKFLOW_ASSISTANT_PROFILE.basePrompt).toContain('节点图')
    expect(WORKFLOW_ASSISTANT_PROFILE.basePrompt).not.toContain('阶段链')
  })

  it('源码里不再有阶段链词汇（旧的第二套图描述已整条拆除）', () => {
    const source = read('src/renderer/src/components/routine/workflow-assist.ts')
    expect(source).not.toContain('workflowStagesToGraph')
    expect(source).not.toMatch(/\bstages\b/)
    const wizard = read('src/renderer/src/components/routine/TaskWizardPage.tsx')
    expect(wizard).not.toContain('workflowStagesToGraph')
    // 快照是现取的（每轮都带上最新图），不是初始化时算一次。
    expect(wizard).toMatch(/assist\.send\(text, kind === 'routine' \? formSnapshot\(\) : workflowFormSnapshot\(def\)\)/)
  })
})
