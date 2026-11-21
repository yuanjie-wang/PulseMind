// 上下文压缩管线压力测试（2026-09-29 形状回放；2026-11-21 随 epoch 重写）。
// 驱动真实 ContextCompactor 按 prepareLoopRequest 现在的三步（assembleCopy →
// priceRequest → 越线才 directCut）连跑 60 轮请求，转写每轮增长两个工具循环
// （3-19K 中文工具结果 + 3K 思考）。旧形状的 applyPersistedDrops → nano →
// light → hard → injectHistorySummary 五段式随账本/四门一起退役：今天只有
// 「冻结 epoch + 一个谓词 + 一次定向切割」。钉住四个性质：
//   1. 放行前拟合：每一轮发货副本（含摘要/重放/固定开销）≤ 窗口；
//   2. 窗口利用率：转写越过窗口后副本 ≥ 40% 窗口——清仓时代是 11-18%；
//   3. 摘要一次切割至多一次（epoch 契约），且丢弃区的覆盖跟随前沿推进；
//   4. 冻结性：切割刚落盘的副本就是下一次组装的那份（同一数组对象），未切轮
//      的基段逐条复用基对象；无增长时谓词不再开门、摘要零新增调用。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const WINDOW = 200_000
const OVERHEAD = 15_000 // system prompt + tool schemas + state block（实测 ≈15K）
const PASSES = 60
// DeepSeek 实测密度（回归斜率 0.972，conv_20260927170026 的 39 个请求样本）。
// epoch 下它只维持 fixture 的线上形状（真实请求会把 usage 落回 assistant 行）；
// 触发链读副本价、不看这个锚点——wire-gate 单独钉着「锚点零投票」。
const DENSITY = 0.972

const AT = '2026-09-29T00:00:00.000Z'
let seq = 0

function makeRound(i: number): AgentMessage[] {
  const resultChars = 3000 + (i % 9) * 2000 // 3K-19K，确定性
  const assistant: AgentMessage = {
    id: `a${++seq}`, role: 'assistant', createdAt: AT,
    contentBlocks: [
      { type: 'thinking', thinking: `第${i}轮推理。`.padEnd(3000, '思') },
      { type: 'tool_use', id: `tu${i}`, name: 'read', input: { file_path: `f-${i}.txt` } },
    ] as ContentBlock[],
  }
  return [assistant, {
    id: `u${++seq}`, role: 'user', createdAt: AT,
    contentBlocks: [{
      type: 'tool_result',
      tool_use_id: `tu${i}`,
      // DB 往返带来的稳定 id：nano 的占位符复用它，因此「同一源同一目标 ⇒
      // 同一字节」在这个 fixture 里成立（不靠 uuid 的偶然性）。
      tool_result_id: `tr${i}`,
      content: `result-${i}-` + '果'.repeat(resultChars),
    }] as ContentBlock[],
  }]
}

describe('compaction epoch stress: a marathon-shaped session stays fitted, utilized and covered', () => {
  it('60 request passes over an ever-growing transcript', async () => {
    const messages: AgentMessage[] = [
      { id: 'u-intent', role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '初始任务：打开在线文档并取数。' }] },
    ]
    const runHistorySummary = vi.fn(async (region: string) => `摘要(${region.length}字)`)
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })

    let cuts = 0
    let frozenPasses = 0
    let lastShipped: AgentMessage[] = []
    // 当前 epoch 的基（切割落盘的副本）与它的长度：未切轮要证明基段没被重建。
    let epochBase: AgentMessage[] = []

    for (let pass = 0; pass < PASSES; pass++) {
      if (pass % 15 === 0) {
        // 独立的用户文本轮（真实形态）：切割不丢用户原话（重放臂兜住）。
        messages.push({
          id: `u-text-${pass}`, role: 'user', createdAt: AT,
          contentBlocks: [{ type: 'text', text: `用户新指令-${pass}：继续推进。` }],
        })
      }
      messages.push(...makeRound(pass * 2))
      messages.push(...makeRound(pass * 2 + 1))

      // prepareLoopRequest 的三步：两条线 → 组副本 → 定价（每个请求都记账，
      // 曲线才是 T/Δ 的依据）→ 越线才切到 T − Δ。
      const lines = compactor.epochLines(WINDOW)
      const copy = compactor.assembleCopy()
      const price = compactor.priceRequest(copy, OVERHEAD)

      let shipped = copy
      if (price > lines.trigger) {
        const cut = await compactor.directCut(lines.target, { overhead: OVERHEAD, copy })
        expect(cut.cut, `pass ${pass}: price ${price} is over T=${lines.trigger} but nothing was cut`).toBe(true)
        // 落点承诺：摘要/提醒块骑在承诺线之上，但不得回头越过触发线。
        expect(cut.priceAfter, `pass ${pass}: landed at ${cut.priceAfter}, target ${lines.target}`)
          .toBeLessThanOrEqual(lines.target + 5_000)
        shipped = cut.messages
        cuts++
        // 冻结：切割刚落盘，下一次组装必须逐字节就是这份（同一数组对象）。
        expect(compactor.assembleCopy()).toBe(shipped)
        epochBase = shipped
      } else {
        frozenPasses++
        // 未切轮的头不动：副本的基段逐条复用基对象（基没有被从全量转写重建）。
        for (let i = 0; i < epochBase.length - 1; i++) {
          if (copy[i] !== epochBase[i]) {
            throw new Error(`pass ${pass}: base element ${i} (${epochBase[i]?.id}) was rebuilt inside a frozen epoch`)
          }
        }
      }

      // 1. 放行前拟合——副本价（含固定开销）在窗口内。未切轮它就是 price。
      const shippedPrice = compactor.copyTokens(shipped, OVERHEAD)
      expect(shippedPrice, `pass ${pass}: shipped copy ${shippedPrice} exceeds the window`).toBeLessThanOrEqual(WINDOW)
      if (shipped === copy) expect(shippedPrice).toBe(price)

      // 真实请求的 usage 落回最新 assistant 行（DB 往返形态）。
      const newest = [...messages].reverse().find((m) => m.role === 'assistant')
      if (newest) newest.inputTokens = Math.round(DENSITY * shippedPrice)

      lastShipped = shipped
    }

    // 2. 窗口利用率：转写远超窗口后，副本不再是热区塌缩
    const transcriptH = estimateMessagesTokens(messages)
    expect(transcriptH).toBeGreaterThan(WINDOW * 2) // 确实是马拉松形状
    const keptH = estimateMessagesTokens(lastShipped)
    expect(keptH, `kept copy collapsed to ${keptH} (the old wipe lands ~30-50K)`).toBeGreaterThanOrEqual(WINDOW * 0.4)
    // epoch 真的摊薄了头移动：大多数请求原样发货，且确实切过。
    expect(cuts).toBeGreaterThanOrEqual(2)
    expect(frozenPasses, 'every request cut its head — the epoch amortization is gone').toBeGreaterThan(5)

    // 3. 摘要一次切割至多一次，且覆盖跟随前沿推进
    const calls = runHistorySummary.mock.calls.map((c) => c[0] as string)
    expect(calls.length, 'summary LLM calls must happen (old code: 0 — the light-dropped region was never summarized)').toBeGreaterThanOrEqual(2)
    expect(calls.length, `summary calls (${calls.length}) must not exceed the ${cuts} cuts — one per epoch`).toBeLessThanOrEqual(cuts)
    const allInput = calls.join('\n')
    expect(allInput).toContain('result-0-') // 最早丢弃区被覆盖
    expect(allInput).toMatch(/result-[3-9]\d-/) // 覆盖跟随前沿推进到后期丢弃区

    // 4. 无增长轮次：头不再移动。先把最后一个副本落成冻结态（末轮若未切则补一刀），
    // 再证明「价格恰在目标线上 ⇒ 谓词关门、字节不变、摘要零新增调用」。
    const settled = compactor.assembleCopy()
    if (compactor.copyTokens(settled, OVERHEAD) > compactor.epochLines(WINDOW).target) {
      const forced = await compactor.directCut(compactor.epochLines(WINDOW).target, { overhead: OVERHEAD })
      expect(forced.cut).toBe(true)
    }
    const frozen = compactor.assembleCopy()
    expect(compactor.assembleCopy()).toBe(frozen) // 两次组装是同一数组
    const frozenPrice = compactor.copyTokens(frozen, OVERHEAD)
    const callsBefore = runHistorySummary.mock.calls.length
    const again = await compactor.directCut(frozenPrice, { overhead: OVERHEAD })
    expect(again.cut).toBe(false)
    expect(again.messages).toBe(frozen)
    expect(again.priceAfter).toBe(again.priceBefore)
    expect(again.droppedMessages).toBe(0)
    expect(runHistorySummary.mock.calls.length).toBe(callsBefore)

    // 最近的工作逐字保留；跨丢弃区的用户意图以重放形式在场
    const tailResults = lastShipped.flatMap((m) => m.contentBlocks)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    expect(tailResults.some((b) => b.content.startsWith(`result-${PASSES * 2 - 1}-`))).toBe(true)
    expect(lastShipped.some((m) =>
      m.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('初始任务')))).toBe(true)
    expect(lastShipped.some((m) =>
      m.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('用户新指令-45')))).toBe(true)
  })
})
