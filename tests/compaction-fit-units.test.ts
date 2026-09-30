// 拟合单位回归（2026-09-30，sub_1790690362913 模块11 回放钉死）：lightCompact 的
// 触发输入是锚点单位（真实 inputTokens 报告），而 fits() 曾用启发式内容 + 传入的
// fixedOverhead —— 当网关的 completion_tokens 不含 reasoning 时，每条 assistant
// 消息被 outputTokens 顶替成 ~126 tokens（实际 thinking+tool_use ~2K），启发式
// 累计少算 ~26K，触发之后 fits() 仍判「已达标」：连续多个请求一个循环都不丢，
// 真实 wire 越过 140K 目标一路爬到 161K（窗口 81%），UI 零压缩事件。
// 修复 = hardTruncate/emergencyTruncate 已有的规则统一过来：overhead 从锚点差值
// 反推（estimatedTokens − totalH），未锚定时差值恰为 fixedOverhead，诚实汇报的
// 会话字节级不变。钉两个性质：
//   1. 无死区：锚点估算越过 0.7× 窗口的当轮，light 必须真的丢循环；
//   2. 放行拟合：每一轮最终副本的真实块价（不理会 outputTokens 顶替）+ 固定开销
//      ≤ 目标线 + 一轮的体量；利用率不塌（不许过度修正成清仓）。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateTextTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const WINDOW = 200_000
const TARGET = WINDOW - Math.max(WINDOW * 0.3, 30_000) // light 的被动拟合目标 = 140K
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
    // 注意：不设 outputTokens 顶替以外的块价 —— 网关只报 126，块里实际扛着 ~2K 思考
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

describe('compaction fit units: the enforcement speaks the same units the trigger fired in', () => {
  it('a reasoning-excluded gateway cannot smuggle the copy past the fit target', async () => {
    const runHistorySummary = vi.fn(async (region: string) => `摘要(${region.length}字)`)
    const messages: AgentMessage[] = [
      { id: 'u-intent', role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '初始任务：全量审查 shared 目录。' }] },
    ]
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })

    let pendingReport: number | null = null
    let crossed = false
    let firstDropPass = -1

    for (let pass = 0; pass < PASSES; pass++) {
      messages.push(...makeRound())
      const history = messages.slice()

      const nano = compactor.nanoCompact(history)
      const light = compactor.lightCompact(nano, WINDOW, OVERHEAD)
      const truncated = compactor.hardTruncate(light, WINDOW, OVERHEAD)
      const final = await compactor.injectHistorySummary(history, light, truncated)

      // 触发输入（与 lightCompact 内部同款）：锚点单位
      const est = compactor.contextTokens(nano, OVERHEAD)
      const dropped = light.length < nano.length
      if (dropped && firstDropPass < 0) firstDropPass = pass

      if (est > TARGET) {
        crossed = true
        // 性质 1 —— 无死区：触发当轮必须真的丢（旧代码：fits() 用启发式单位，
        // 连续多个触发轮零丢弃）
        expect(dropped, `pass ${pass}: estimate ${est} is over the ${TARGET} line but light dropped nothing`).toBe(true)
      }

      // 性质 2 —— 放行拟合（真实单位）：块价直计 + 固定开销，宽容一轮体量
      const realWire = trueTokens(final) + OVERHEAD
      expect(realWire, `pass ${pass}: real wire ${realWire} leaked past the fit target`).toBeLessThanOrEqual(TARGET + 7_000)
      // 利用率不塌：拟合不得退化成清仓
      if (crossed) expect(realWire, `pass ${pass}: copy collapsed to ${realWire}`).toBeGreaterThanOrEqual(WINDOW * 0.5)

      // 下一轮的锚点 = 本轮请求的真实报告
      pendingReport = Math.round(trueTokens(final) + OVERHEAD)
      void pendingReport
      const tail = messages[messages.length - 1]
      ;(tail as AgentMessage & { inputTokens?: number }).inputTokens = pendingReport
    }

    // 压力是真的：转写远超目标线
    expect(trueTokens(messages)).toBeGreaterThan(WINDOW)
    expect(crossed, 'the run must actually cross the trigger line').toBe(true)
    expect(firstDropPass).toBeGreaterThanOrEqual(0)
    expect(runHistorySummary.mock.calls.length, 'dropped regions must be summarized').toBeGreaterThanOrEqual(1)
  })
})
