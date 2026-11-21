// 单位一致性（2026-09-30 sub_1790690362913 模块11 回放钉死，2026-11-21 随 epoch
// 重写）：触发读的是**副本价**（`copyTokens`，块价直计），执行器落点也用同一
// 单位度量 —— 一个 completion_tokens 不含 reasoning 的网关不能把副本偷过目标线。
//
// 历史形状（四门时代）是「light 的触发用锚点单位、fits() 用启发式单位」，于是
// 连续多个触发轮零丢弃、真实 wire 一路爬到 161K。epoch 下触发与执行是同一个
// 读数器，本文件钉的就是这件事在真实管线上成立：
//   1. 块价不被 outputTokens 顶替（126 vs ~2K/轮）——副本价必须等于真块价；
//   2. 无死区：副本价越过目标线的当轮，`directCut` 必须真的切（`cut: true`）；
//   3. 放行拟合：切完的副本按真块价 + 固定开销 ≤ 目标线（摘要落在承诺线之上，
//      留 7K 宽容）；利用率不塌（不许过度修正成清仓）。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateTextTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const WINDOW = 200_000
const TARGET = WINDOW - Math.max(WINDOW * 0.3, 30_000) // 140K
const OVERHEAD = 26_000 // 子代理真实固定开销（spawn 提示词 + 精简工具集 + state block）
const PASSES = 45 // 45 轮 ≈ 226K 真实内容，确保转写本身越过 200K 窗口
// 网关排除 reasoning 时的汇报形状（模块11 实测：output=126）
const REPORTED_OUTPUT_TOKENS = 126

const AT = '2026-09-30T00:00:00.000Z'
let seq = 0

/** 真实块价：每块直接计价，绝不用 outputTokens 顶替 —— 这才是线上 wire 的单位。 */
function trueTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text') total += estimateTextTokens(block.text)
      else if (block.type === 'tool_use') total += estimateTextTokens(JSON.stringify(block.input) + block.name)
      else if (block.type === 'tool_result') total += estimateTextTokens((block as { content: string }).content)
      else if (block.type === 'thinking') total += estimateTextTokens((block as { thinking: string }).thinking)
    }
  }
  return total
}

function makeRound(): AgentMessage[] {
  const assistant: AgentMessage = {
    id: `a${++seq}`, role: 'assistant', createdAt: AT,
    // 注意：outputTokens 只报 126，块里实际扛着 ~2K 思考
    outputTokens: REPORTED_OUTPUT_TOKENS,
    contentBlocks: [
      { type: 'thinking', thinking: `第${seq}轮推理。`.padEnd(2000, '思') },
      { type: 'tool_use', id: `tu${seq}`, name: 'probe_tool', input: { path: `f-${seq}.txt` } },
    ] as ContentBlock[],
  }
  return [assistant, {
    id: `u${++seq}`, role: 'user', createdAt: AT,
    contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${seq}`, content: `result-${seq}-` + '果'.repeat(3000) }] as ContentBlock[],
  }]
}

describe('单位一致性：触发与执行共用一个读数器', () => {
  it('a reasoning-excluded gateway cannot smuggle the copy past the fit target', async () => {
    const runHistorySummary = vi.fn(async (region: string) => `摘要(${region.length}字)`)
    const messages: AgentMessage[] = [
      { id: 'u-intent', role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '初始任务：全量审查 shared 目录。' }] },
    ]
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })

    let crossed = false
    let cutPasses = 0
    let frozen = 0

    for (let pass = 0; pass < PASSES; pass++) {
      messages.push(...makeRound())

      // 触发读副本价（生产：prepareLoopRequest 的 assembleCopy → priceCopy）。
      const copy = compactor.assembleCopy()
      const price = compactor.copyTokens(copy, OVERHEAD)
      // 生产的两条线也一起用：触发线 T、切割目标 T − Δ。
      const lines = compactor.epochLines(WINDOW)

      if (price <= lines.trigger) {
        // 未越线：引擎不调用切割，请求原样发货 —— 头段字节与上一请求相同。
        // （`directCut` 自身在 target ≥ price 时也是恒等，见 compaction-wire-gate。）
        frozen++
        continue
      }
      crossed = true

      const result = await compactor.directCut(lines.target, { overhead: OVERHEAD })
      // 性质 1 —— 无死区：越线的当轮必须真的切。
      expect(result.cut, `pass ${pass}: price ${price} is over T=${lines.trigger} but nothing was cut`).toBe(true)
      cutPasses++

      // 性质 2 —— 执行器与触发同单位：切完的副本价落到 T − Δ。
      const after = compactor.copyTokens(result.messages, OVERHEAD)
      expect(after, `pass ${pass}: copy still ${after} after the cut`).toBeLessThanOrEqual(lines.target + 1_000)
      expect(result.priceAfter).toBe(after)

      // 性质 3 —— 真块价（不理 outputTokens 顶替）+ 固定开销同样在目标内。
      const realWire = trueTokens(result.messages) + OVERHEAD
      expect(realWire, `pass ${pass}: real wire ${realWire} leaked past the fit target`).toBeLessThanOrEqual(lines.target + 7_000)
      // 利用率不塌：拟合不得退化成清仓。
      expect(realWire, `pass ${pass}: copy collapsed to ${realWire}`).toBeGreaterThanOrEqual(WINDOW * 0.5)

      // 下一轮锚点 = 本轮请求的真实报告（网关形态不变）。
      const tail = messages[messages.length - 1]
      ;(tail as AgentMessage & { inputTokens?: number }).inputTokens = Math.round(trueTokens(result.messages) + OVERHEAD)
    }

    // 压力是真的：转写远超目标线，切真的发生过，摘要真的跑过。
    expect(trueTokens(messages)).toBeGreaterThan(WINDOW)
    expect(crossed, 'the run must actually cross the trigger line').toBe(true)
    expect(cutPasses).toBeGreaterThanOrEqual(1)
    // 冻结真的发生过：切割不是每轮都开火（两次切割之间必有未越线的请求）。
    expect(frozen).toBeGreaterThan(0)
    expect(runHistorySummary.mock.calls.length, 'dropped regions must be summarized').toBeGreaterThanOrEqual(1)
  })

  it('the copy price never defers to an under-reported completion count', () => {
    // 顶替只在「块估算 ≤ 报告 × 1.5」时生效（REPORT_UNDERPRICE_FACTOR）——
    // 每轮 ~2K 块价 vs 126 报告，副本价必须等于真块价，否则触发线永远读不到。
    const messages: AgentMessage[] = []
    for (let i = 0; i < 10; i++) messages.push(...makeRound())
    const compactor = new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => messages })

    expect(compactor.copyTokens(messages, 0)).toBe(trueTokens(messages))
    expect(compactor.copyTokens(messages, 0)).toBeGreaterThan(REPORTED_OUTPUT_TOKENS * 10)
  })
})
