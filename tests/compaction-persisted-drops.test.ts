// 持久丢弃前沿（2026-11-02，conv_20261102222133 的 20K↔120K 振荡复盘）。
// lightCompact 每次请求都从全量转写重新推导，而它产出的副本是丢弃的——
// `this.messages` 永远是全量。于是一拍重压缩（wire ~19.5K）→ 下一拍锚点读到
// 压缩后的真实报告、max-guard 回落全量启发式 → 只丢几个 cycle → 上一拍的
// 上百个洞全部回填（wire ~120K）→ 再丢上百个……振荡整场不停，已丢弃的
// 前缀被反复重新计费，摘要前沿也永远推不动。
//
// 修法：丢弃决策按消息 id 持久化（单调，id 永不离开集合），并在请求/预热的
// 管线入口重放（applyPersistedDrops）。这里钉住五个契约：
//   1. 丢掉的 cycle 在下一拍副本里仍然缺席（不是重新推导一次又回来）；
//   2. 集合为空时返回同一个数组引用（未压缩过的会话请求字节不变）；
//   3. strip 臂只去 tool_result、保留用户自己的文字，且下一拍幂等；
//   4. clearLightDrops() 后重新推导（会话重置/换会话时前沿归零一次）；
//   5. 预热模拟走同一条剪枝路径，已丢的 cycle 不再算作「本拍新丢弃」。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens } from '../src/renderer/src/agent/engine/context-estimate'
import { regroupToolResults } from '../src/renderer/src/llm/regroup-tool-results'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-11-02T00:00:00.000Z'
const WINDOW = 100_000
const OVERHEAD = 0

let seq = 0

/** One tool cycle: assistant tool_use → user tool_result. 8K CJK chars per
 *  result, so a dozen cycles comfortably outgrow the window and light has real
 *  cycles to shed. `userText` makes it the mixed arm (text + tool_result). */
function cycle(i: number, userText?: string): AgentMessage[] {
  const assistant: AgentMessage = {
    id: `a${++seq}`, role: 'assistant', createdAt: AT,
    contentBlocks: [{ type: 'tool_use', id: `tu${i}`, name: 'read', input: { file_path: `f-${i}.txt` } }],
  }
  const blocks: ContentBlock[] = []
  if (userText) blocks.push({ type: 'text', text: userText })
  blocks.push({ type: 'tool_result', tool_use_id: `tu${i}`, content: `result-${i}-` + '果'.repeat(8000) })
  return [assistant, { id: `u${++seq}`, role: 'user', createdAt: AT, contentBlocks: blocks }]
}

/** 12 droppable cycles + a protected tail instruction. */
function makeTranscript(mixedUserText?: string): AgentMessage[] {
  const messages: AgentMessage[] = [
    { id: `u${++seq}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '初始任务：取数。' }] },
  ]
  for (let i = 0; i < 12; i++) messages.push(...cycle(i, i === 0 ? mixedUserText : undefined))
  // 尾部用户文本轮：既是保护项（最后一个 text 用户消息），也保证 mixed 那一臂
  // 不是整条历史的最后一个 text 用户消息（否则它会被 Protection 1 豁免）。
  messages.push({ id: `u${++seq}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '最后指令：收尾。' }] })
  return messages
}

function makeCompactor(messages: AgentMessage[]) {
  const runHistorySummary = vi.fn(async () => '摘要内容')
  const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })
  return { compactor, runHistorySummary }
}

function ids(ms: AgentMessage[]): string[] {
  return ms.map((m) => m.id)
}

describe('persistent light-drop frontier: shed cycles never ride back into the copy', () => {
  it('returns the SAME array reference while nothing has been dropped yet', () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)
    // 未压缩过的会话：请求字节必须与从前完全一致（引用相等，连 shallow copy 都不做）
    expect(compactor.applyPersistedDrops(messages)).toBe(messages)
  })

  it('keeps dropped cycles out of the NEXT pass (the 20K ↔ 120K ping-pong)', () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)

    const shed = compactor.lightCompact(messages, WINDOW, OVERHEAD)
    expect(shed.length).toBeLessThan(messages.length)
    const shedIds = new Set(ids(shed))

    // 「下一拍」：入口剪枝 + 重新走 light。已丢的消息必须仍然缺席——旧代码
    // 这一行走的是全量 messages，上一拍的洞全部回填。
    const pruned = compactor.applyPersistedDrops(messages)
    expect(pruned.length).toBe(shed.length)
    for (const id of ids(pruned)) expect(shedIds.has(id)).toBe(true)

    const again = compactor.lightCompact(pruned, WINDOW, OVERHEAD)
    // 剪枝后的副本已拟合，light 不再有新丢弃（不报假的压缩事件）
    expect(again.length).toBe(pruned.length)
    for (const id of ids(again)) expect(shedIds.has(id)).toBe(true)

    // 相对全量转写，副本显著收缩——这正是被反复重新计费的那段前缀
    expect(estimateMessagesTokens(pruned)).toBeLessThan(estimateMessagesTokens(messages) * 0.85)
  })

  it('hard truncation feeds the same frontier, and record=false leaves it untouched', () => {
    const messages = makeTranscript()

    const withRecord = makeCompactor(messages).compactor
    const hard = withRecord.hardTruncate(messages, WINDOW, OVERHEAD, true) // 强制切（/compact 语义）
    expect(hard.length).toBeLessThan(messages.length)
    // 真实转录里最大的一次回填就是 hard 丢掉的巨型 tool_result（18K ↔ 121K）
    expect(withRecord.applyPersistedDrops(messages).length).toBe(hard.length)

    const noRecord = makeCompactor(messages).compactor
    noRecord.hardTruncate(messages, WINDOW, OVERHEAD, true, false)
    expect(noRecord.applyPersistedDrops(messages)).toBe(messages)
  })

  it('strip arm keeps the user words, drops only the tool_results, and is idempotent', () => {
    const mixed = '这是我自己写的说明，请保留。'
    const messages = makeTranscript(mixed)
    const { compactor } = makeCompactor(messages)

    compactor.lightCompact(messages, WINDOW, OVERHEAD)
    const pruned = compactor.applyPersistedDrops(messages)

    const userMsg = pruned.find((m) => m.contentBlocks.some((b) => b.type === 'text' && b.text === mixed))
    expect(userMsg, 'the mixed user message must survive as text').toBeDefined()
    expect(userMsg!.contentBlocks.every((b) => b.type === 'text')).toBe(true)

    // 幂等：已经只剩文本的消息不再被重建，整表引用不变（缓存契约）
    expect(compactor.applyPersistedDrops(pruned)).toBe(pruned)
  })

  it('clearLightDrops() drops the frontier so the next pass re-derives it', () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)

    compactor.lightCompact(messages, WINDOW, OVERHEAD)
    expect(compactor.applyPersistedDrops(messages).length).toBeLessThan(messages.length)

    compactor.clearLightDrops()
    // 前沿归零 = 回到全量起点（换会话/历史整体替换时的一次性重新推导）
    expect(compactor.applyPersistedDrops(messages)).toBe(messages)
    expect(compactor.lightCompact(messages, WINDOW, OVERHEAD).length).toBeLessThan(messages.length)
  })

  it('prewarm reads the frontier but never extends it (its forced cut is discarded)', async () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)

    // 预热的模拟带强制位、切得比后续真实请求更深；若它也写前沿，每个回合都会
    // 把副本永久削深一层（与 nano 标记还原同一条理由）。
    await compactor.prewarm({ contextLength: WINDOW, source: 'post-turn' })
    expect(compactor.applyPersistedDrops(messages)).toBe(messages)
    expect(compactor.lightCompact(messages, WINDOW, OVERHEAD).length).toBeLessThan(messages.length)
  })

  it('prewarm simulates over the pruned copy: a second prewarm sees nothing new to drop', async () => {
    const messages = makeTranscript()
    const { compactor, runHistorySummary } = makeCompactor(messages)

    // 先让请求路径丢一轮，落定持久前沿
    const shed = compactor.lightCompact(messages, WINDOW, OVERHEAD)
    expect(shed.length).toBeLessThan(messages.length)

    const spy = vi.spyOn(compactor, 'applyPersistedDrops')
    // hardForce=false：模拟与下一次真实请求完全一致（只有 light 丢了东西）
    const first = await compactor.prewarm({ contextLength: WINDOW, source: 'post-turn', hardForce: false })
    expect(spy).toHaveBeenCalled()
    // 剪枝后的副本已拟合 → 本拍没有新丢弃 → 预热无事可做（旧代码会把已丢的
    // cycle 再丢一遍，永远报一个假的 dropped 事件）
    expect(first).toBeNull()
    expect(runHistorySummary).not.toHaveBeenCalled()
  })
})

// ── review_20261103 高1：前沿按消息 id 记账，而 regroup 在历史 wire 合法性
// 翻转时会整表重建——结果载体换 `regroup_<assistantId>`、原 user 消息消失。
// N 拍合法时记下 {a4, u4}，N+1 拍一翻转，副本里是 {a4, regroup_a4}：按 id 只
// 命中 a4，regroup_a4 携带的 tool_result 失去前置 tool_use（Anthropic 400 且
// 每次重试同样 400；light 只认 (assistant,user) 相邻对，孤儿永远清不掉）。
// 修法 = applyPersistedDrops 的配对收口：被丢 assistant 的 tool_use 与被丢
// 载体的 tool_result 在块级互斥剥除，剥空的整条丢。

/** Every tool_result whose tool_use is absent earlier in the copy. */
function orphanResults(ms: AgentMessage[]): string[] {
  const declared = new Set<string>()
  const orphans: string[] = []
  for (const m of ms) {
    if (m.role === 'assistant') {
      for (const b of m.contentBlocks) if (b.type === 'tool_use') declared.add((b as { id: string }).id)
    } else {
      for (const b of m.contentBlocks) if (b.type === 'tool_result' && !declared.has(b.tool_use_id)) orphans.push(b.tool_use_id)
    }
  }
  return orphans
}

describe('pairing closure: a wire-legality flip cannot strand orphan tool_results', () => {
  it('N 拍合法记前沿 → N+1 拍相邻 assistant 触发 regroup 重建 → 副本零孤儿', () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)

    // N 拍：合法历史，light 记下前几个 cycle 的 {assistant, user} 对
    const shed = compactor.lightCompact(messages, WINDOW, OVERHEAD)
    expect(shed.length).toBeLessThan(messages.length)

    // N+1 拍：链式派发在尾部追加 [assistant(text), assistant(tool_use)] 相邻对
    // → 整段历史不再 wire-legal → regroup 把所有结果载体换成 regroup_<a>，
    //   原 user 消息只剩文字（前沿记的 user id 全部消失）。
    const dispatchPair: AgentMessage[] = [
      { id: 'a_disp_text', role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: '继续派发下一波。' }] },
      { id: 'a_disp_tools', role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'tool_use', id: 'tu_disp', name: 'read', input: { file_path: 'next.txt' } }] },
    ]
    const flipped = regroupToolResults([...messages, ...dispatchPair, { id: 'u_disp', role: 'user', createdAt: AT, contentBlocks: [{ type: 'tool_result', tool_use_id: 'tu_disp', content: 'ok' }] }])
    // 夹具自检：重建真的发生了（旧 user 载体 id 已不在表上）
    expect(flipped.some((m) => m.id.startsWith('regroup_'))).toBe(true)

    const pruned = compactor.applyPersistedDrops(flipped)
    // 核心断言：零孤儿。旧实现这里留下 4 个无前置 tool_use 的 tool_result。
    expect(orphanResults(pruned)).toEqual([])
    // 前沿丢掉的消息（全量减 shed）在翻转后的副本里仍然缺席——id 命中的
    // 那一半照常工作，收口只补另一半。
    const shedIds = new Set(ids(shed))
    const prunedIds = new Set(ids(pruned))
    const droppedAssistantIds = ids(messages).filter((id) => !shedIds.has(id) && id.startsWith('a'))
    expect(droppedAssistantIds.length).toBeGreaterThan(0)
    for (const id of droppedAssistantIds) expect(prunedIds.has(id)).toBe(false)
    // 副本显著收缩（丢弃没有因翻转而失灵）
    expect(estimateMessagesTokens(pruned)).toBeLessThan(estimateMessagesTokens(flipped) * 0.85)
  })

  it('反向翻转（regroup 形态记前沿 → 历史回到合法原 id）同样零孤儿', () => {
    // N 拍在 regroup 形态上丢（前沿记 {a, regroup_a}），N+1 拍历史翻回合法
    // 形态（原 user id 回来了）：regroup_a 不在表上，但 user 载体携带的
    // tool_result 的调用方已被丢——收口必须把它们剥掉。
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)
    // 历史先变非法（真实来源：thinking-only 重试留下的相邻 assistant），在
    // 重建形态上记前沿
    const illegal = [
      ...messages,
      { id: 'a_extra', role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'tool_use', id: 'tu_x', name: 'read', input: {} }] },
    ] as AgentMessage[]
    const regrouped = regroupToolResults(illegal)
    const shed = compactor.lightCompact(regrouped, WINDOW, OVERHEAD)
    expect(shed.length).toBeLessThan(regrouped.length)

    // N+1 拍：历史翻回合法（extra pair 被摘除，与非法化对称）
    const pruned = compactor.applyPersistedDrops(messages)
    expect(orphanResults(pruned)).toEqual([])
  })

  it('配对收口不碰活调用：result 未到达的在飞 tool_use 原样保留', () => {
    const messages = makeTranscript()
    const { compactor } = makeCompactor(messages)
    compactor.lightCompact(messages, WINDOW, OVERHEAD)
    // 尾部追加一个结果未到达的在飞调用（链式派发常态）
    const inFlight: AgentMessage = {
      id: 'a_live', role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'tool_use', id: 'tu_live', name: 'exec', input: { command: 'sleep 1' } }],
    }
    const withLive = [...messages, inFlight]
    const pruned = compactor.applyPersistedDrops(withLive)
    const live = pruned.find((m) => m.id === 'a_live')
    expect(live).toBeDefined()
    expect(live!.contentBlocks.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'tu_live')).toBe(true)
  })
})
