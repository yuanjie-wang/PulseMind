// 上下文压缩管线压力测试（2026-09-29，conv_20060927170026 复盘的形状回放）。
// 驱动真实 ContextCompactor 按 prepareLoopRequest 的顺序（nano → light → hard →
// injectHistorySummary）连跑 60 轮请求，转写每轮增长两个工具循环（3-19K 中文
// 工具结果 + 400 字思考），assistant 消息按实测密度（0.972 × 启发式 + 固定开销）
// 盖真实 inputTokens 报告——锚定分支全程生效。钉住四个性质：
//   1. 放行前拟合：每一轮最终副本（含摘要/重放）+ 固定开销 ≤ 窗口，真实报告同理；
//   2. 窗口利用率：转写越过窗口后副本 ≥ 40% 窗口——清仓时代是 11-18%；
//   3. 摘要有界且覆盖跟进：LLM 摘要调用 ≤ 12 次（累积门槛摊销），且丢弃区的
//      覆盖跟随前沿推进（不是只有最早一段）；
//   4. 无增长轮次幂等：副本不再收缩，摘要缓存零额外调用。
// 旧代码在 1/4 上靠"清仓"侥幸及格，在 2/3 上全红（0 次摘要 + 副本塌到热区）。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const WINDOW = 200_000
const OVERHEAD = 15_000 // system prompt + tool schemas + state block（实测 ≈15K）
const PASSES = 60
// DeepSeek 实测密度（回归斜率 0.972，conv_20260927170026 的 39 个请求样本）
const DENSITY = 0.972

const AT = '2026-09-29T00:00:00.000Z'
let seq = 0

function makeRound(i: number, prevReport: number | null): AgentMessage[] {
  const resultChars = 3000 + (i % 9) * 2000 // 3K-19K，确定性
  const assistant: AgentMessage = {
    id: `a${++seq}`, role: 'assistant', createdAt: AT,
    ...(prevReport != null ? { inputTokens: prevReport } : {}),
    contentBlocks: [
      { type: 'thinking', thinking: `第${i}轮推理。`.padEnd(3000, '思') },
      { type: 'tool_use', id: `tu${i}`, name: 'read', input: { file_path: `f-${i}.txt` } },
    ] as ContentBlock[],
  }
  return [assistant, {
    id: `u${++seq}`, role: 'user', createdAt: AT,
    contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: `result-${i}-` + '果'.repeat(resultChars) }] as ContentBlock[],
  }]
}

describe('compaction pipeline stress: a marathon-shaped session stays fitted, utilized and covered', () => {
  it('60 request passes over an ever-growing transcript', async () => {
    const messages: AgentMessage[] = [
      { id: 'u-intent', role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '初始任务：打开在线文档并取数。' }] },
    ]
    const runHistorySummary = vi.fn(async (region: string) => `摘要(${region.length}字)`)
    const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })

    let pendingReport: number | null = null
    let lastFinal: AgentMessage[] = []
    const wireHistories: number[] = []

    for (let pass = 0; pass < PASSES; pass++) {
      if (pass % 15 === 0) {
        // 独立的用户文本轮（真实形态）：light 从不丢弃非循环消息，它会一直在副本里
        messages.push({
          id: `u-text-${pass}`, role: 'user', createdAt: AT,
          contentBlocks: [{ type: 'text', text: `用户新指令-${pass}：继续推进。` }],
        })
      }
      messages.push(...makeRound(pass * 2, pendingReport))
      messages.push(...makeRound(pass * 2 + 1, null))

      // prepareLoopRequest 的管线顺序，overhead 语义一致
      const nano = compactor.nanoCompact(messages)
      const light = compactor.lightCompact(nano, WINDOW, OVERHEAD)
      const truncated = compactor.hardTruncate(light, WINDOW, OVERHEAD)
      const final = await compactor.injectHistorySummary(messages, truncated)

      // 1. 放行前拟合——启发式与真实报告两个单位都要在窗口内
      const wireH = estimateMessagesTokens(final) + OVERHEAD
      expect(wireH, `pass ${pass}: wire heuristic ${wireH} exceeds the window`).toBeLessThanOrEqual(WINDOW)
      const report = Math.round(DENSITY * wireH)
      expect(report, `pass ${pass}: real request ${report} exceeds the window`).toBeLessThanOrEqual(WINDOW)
      wireHistories.push(wireH)
      pendingReport = report
      lastFinal = final
    }

    // 2. 窗口利用率：转写远超窗口后，副本不再是热区塌缩
    const transcriptH = estimateMessagesTokens(messages)
    expect(transcriptH).toBeGreaterThan(WINDOW * 2) // 确实是马拉松形状
    const keptH = estimateMessagesTokens(lastFinal)
    expect(keptH, `kept copy collapsed to ${keptH} (the old wipe lands ~30-50K)`).toBeGreaterThanOrEqual(WINDOW * 0.4)

    // 3. 摘要有界且覆盖跟进
    const calls = runHistorySummary.mock.calls.map((c) => c[0] as string)
    expect(calls.length, 'summary LLM calls must happen (old code: 0 — the light-dropped region was never summarized)').toBeGreaterThanOrEqual(2)
    expect(calls.length, `summary LLM calls must stay bounded (got ${calls.length})`).toBeLessThanOrEqual(12)
    const allInput = calls.join('\n')
    expect(allInput).toContain('result-0-') // 最早丢弃区被覆盖
    expect(allInput).toMatch(/result-[3-9]\d-/) // 覆盖跟随前沿推进到后期丢弃区

    // 4. 无增长轮次：副本仍拟合、不会向回膨胀，摘要缓存零新增调用。
    // （副本允许小幅收缩：nano 的压缩标记是累积的——无增长轮里全部块已标记、
    // nano 零压缩、旧块按既有设计重新膨胀，light 按拟合目标多丢几个循环补回。
    // 这个震荡是 marks 机制的既有形状，fit 目标把它钉在有界幅度内。）
    const callsBefore = runHistorySummary.mock.calls.length
    const nano2 = compactor.nanoCompact(messages)
    const light2 = compactor.lightCompact(nano2, WINDOW, OVERHEAD)
    const truncated2 = compactor.hardTruncate(light2, WINDOW, OVERHEAD)
    const final2 = await compactor.injectHistorySummary(messages, truncated2)
    const wireH2 = estimateMessagesTokens(final2) + OVERHEAD
    expect(wireH2).toBeLessThanOrEqual(WINDOW)
    expect(final2.length).toBeLessThanOrEqual(lastFinal.length)
    expect(final2.length).toBeGreaterThanOrEqual(lastFinal.length - 16)
    expect(runHistorySummary.mock.calls.length).toBe(callsBefore)

    // 最近的工作逐字保留；跨丢弃区的用户意图以重放形式在场
    const tailResults = lastFinal.flatMap((m) => m.contentBlocks)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    expect(tailResults.some((b) => b.content.startsWith(`result-${PASSES * 2 - 1}-`))).toBe(true)
    expect(lastFinal.some((m) =>
      m.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('初始任务')))).toBe(true)
    expect(lastFinal.some((m) =>
      m.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('用户新指令-45')))).toBe(true)
  })
})
