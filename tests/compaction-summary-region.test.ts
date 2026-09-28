// 压缩摘要覆盖回归（2026-09-29，conv_20260927170026 复盘）：三个叠在一起的缺陷
// 让长工具会话的摘要机制整体失效——
//   A. injectHistorySummaryInto 的丢区只数 hardTruncate 砍掉的消息
//      (lightCompacted.length - truncated.length)，lightCompact 才是长会话的
//      主力（实测 618/806），于是摘要和用户消息重放被整段跳过：模型每请求静默
//      丢掉数百条历史、零补偿。
//   B. lightCompact 触发后无目标清仓（砍到 8K 热区为止），模型长时只拿到窗口
//      的 11-18%。
//   C. prewarm 的 droppedCount 同病：light-only 丢弃时返回 null，摘要预热失灵。
//   D. 摘要增量扩展（branch 3）每个前沿推进都发一次 LLM 调用。
import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-09-29T00:00:00.000Z'
let seq = 0

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

/** 一轮完整工具循环：assistant(thinking + tool_use) → user(tool_result)。
 *  用 tier-2 的 read（nano 每 20 个才压一档）：马拉松里 light 之所以是主力
 *  丢弃层，靠的正是 tier-2 工具 + 思考块只增不减，nano 压不完。 */
function cycle(i: number, resultChars: number): AgentMessage[] {
  return [
    {
      id: `a${++seq}`, role: 'assistant', createdAt: AT,
      contentBlocks: [
        { type: 'thinking', thinking: `第${i}轮推理。`.padEnd(3000, '思') },
        { type: 'tool_use', id: `tu${i}`, name: 'read', input: { file_path: `f-${i}.txt` } },
      ] as ContentBlock[],
    },
    {
      id: `u${++seq}`, role: 'user', createdAt: AT,
      contentBlocks: [
        { type: 'tool_result', tool_use_id: `tu${i}`, content: `result-${i}-` + '果'.repeat(resultChars) },
      ] as ContentBlock[],
    },
  ]
}

function makeCompactor(messages: AgentMessage[], summary = '摘要内容') {
  const runHistorySummary = vi.fn(async (_regionText: string, _instruction?: string) => summary)
  const compactor = new ContextCompactor({ runHistorySummary, getMessages: () => messages })
  return { compactor, runHistorySummary }
}

/** 80 轮 × 5K 中文结果 ≈ 40 万 token 的转写：200K 窗口下 light 是唯一实际
 *  丢弃层（hard 的 0.9 线在 light 收完后永远够不到）——马拉松的稳定形态。 */
function makeCycles(n: number, resultChars: number): AgentMessage[] {
  const msgs: AgentMessage[] = [{ id: `u0`, role: 'user', createdAt: AT, contentBlocks: [text('初始任务')] }]
  for (let i = 0; i < n; i++) msgs.push(...cycle(i, resultChars))
  return msgs
}

// ── A：light-only 丢弃必须有摘要 + 用户重放 ───────────────────────────

describe('injectHistorySummaryInto: the dropped region spans light AND hard', () => {
  it('summarizes the light-dropped cycles when hard dropped nothing (the marathon shape)', async () => {
    const msgs = makeCycles(80, 5000) // 400K tokens vs a 200K window
    const { compactor, runHistorySummary } = makeCompactor(msgs)

    const nano = compactor.nanoCompact(msgs)
    const light = compactor.lightCompact(nano, 200_000, 0)
    const truncated = compactor.hardTruncate(light, 200_000, 0)
    expect(nano.length - light.length).toBeGreaterThan(0) // light is the dropper
    expect(light.length - truncated.length).toBe(0) // hard dropped NOTHING

    const final = await compactor.injectHistorySummary(msgs, light, truncated)

    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    // The summarizer saw the region's REAL tool results — the oldest, a middle
    // light-dropped cycle — not just hard's (empty) share.
    const region = runHistorySummary.mock.calls[0][0] as string
    expect(region).toContain('result-0-')
    expect(region).toContain('result-45-')
    expect(region).not.toContain('result-79-') // the kept tail is not "dropped"
    // Frontier = the newest DROPPED message (hole-shape key), never the kept
    // tail's start — that pinning is what froze the old cache.
    const keptIds = new Set(truncated.map((m) => m.id))
    const frontier = msgs.filter((m) => !keptIds.has(m.id)).at(-1)!.id
    expect(compactor.getHistorySummary()?.firstKeptId).toBe(frontier)
    expect(frontier).not.toBe(truncated[0].id)
    // Copy shape: [replays…, summary, …kept tail untouched].
    const summaryIdx = final.findIndex((m) =>
      (m.contentBlocks[0] as { text?: string }).text?.includes('【历史对话摘要】'))
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(final.slice(final.length - truncated.length)).toEqual(truncated)
  })

  it('replays the dropped region\'s user words verbatim (they ride the same region)', async () => {
    const msgs: AgentMessage[] = [
      { id: 'u-intent', role: 'user', createdAt: AT, contentBlocks: [text('记住：交付物必须是 xlsx 而不是 csv')] },
      ...makeCycles(80, 5000),
    ]
    const { compactor } = makeCompactor(msgs)
    const nano = compactor.nanoCompact(msgs)
    const light = compactor.lightCompact(nano, 200_000, 0)
    const truncated = compactor.hardTruncate(light, 200_000, 0)
    const final = await compactor.injectHistorySummary(msgs, light, truncated)
    const replayed = final.find((m) =>
      m.id === 'u-intent' &&
      (m.contentBlocks[0] as { text?: string }).text?.includes('xlsx 而不是 csv'))
    expect(replayed).toBeDefined()
  })
})

// ── B：lightCompact 按目标拟合，不再清仓 ─────────────────────────────

describe('lightCompact: proportional to the window, not a wipe', () => {
  it('drops only the oldest cycles needed to fit the trigger line, keeping the rest verbatim', () => {
    const msgs = makeCycles(80, 5000) // 400K vs 200K → target 140K
    const { compactor } = makeCompactor(msgs)
    const compacted = compactor.lightCompact(msgs, 200_000, 0)

    const keptH = estimateMessagesTokens(compacted)
    expect(keptH).toBeLessThanOrEqual(140_000) // the fit is met…
    expect(keptH).toBeGreaterThanOrEqual(130_000) // …with minimal loss (one-cycle granularity)
    // The recent work survives whole — under the old wipe the copy collapsed to
    // the 8K hot zone (~30K tokens) and the model ran on 11-18% of the window.
    for (let i = 65; i < 80; i++) {
      const result = compacted.flatMap((m) => m.contentBlocks)
        .find((b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
          b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === `tu${i}`)
      expect(result?.content).toContain(`result-${i}-`)
      expect(result!.content.length).toBeGreaterThan(5000)
    }
    // The oldest cycles are gone from the copy.
    const dropped = compacted.flatMap((m) => m.contentBlocks)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id)
    expect(dropped).not.toContain('tu0')
    expect(dropped).not.toContain('tu40')
  })

  it('is a no-op when the transcript already fits (the anchor-hot case must not wipe)', () => {
    const msgs = makeCycles(10, 5000) // 50K on a 200K window
    const { compactor } = makeCompactor(msgs)
    expect(compactor.lightCompact(msgs, 200_000, 0)).toBe(msgs)
  })
})

// ── C：prewarm 在 light-only 丢弃时也要预热摘要 ──────────────────────

describe('prewarm: light-only drops seed the summary too', () => {
  it('returns an event (and seeds the cache) when light dropped and hard hit its MIN_KEEP floor', async () => {
    // 8 cycles × 25K = 200K transcript; light drops 3 cycles (kept 10 messages
    // = MIN_KEEP) and forced hardTruncate can drop nothing further.
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 8; i++) msgs.push(...cycle(i, 25_000))
    const { compactor, runHistorySummary } = makeCompactor(msgs)

    const event = await compactor.prewarm({ contextLength: 200_000, source: 'post-turn' })
    expect(event).not.toBeNull() // the old droppedCount (light − truncated) read 0 → null
    expect(event!.strategies).toContain('light')
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    expect(compactor.getHistorySummary()?.text).toBe('摘要内容')
  })
})

// ── D：前沿推进的摘要增量按累积门槛摊销 ─────────────────────────────

describe('history-summary cache: frontier accrual bounds the LLM call rate', () => {
  function textPair(i: number): AgentMessage[] {
    return [
      { id: `tu${i}`, role: 'user', createdAt: AT, contentBlocks: [text(`用户指令 MARKER-${i}。` + '言'.repeat(2400))] },
      { id: `ta${i}`, role: 'assistant', createdAt: AT, contentBlocks: [text(`回复 MARKER-${i}。` + '述'.repeat(2400))] },
    ]
  }
  const build = (n: number): AgentMessage[] => Array.from({ length: n }, (_, i) => textPair(i)).flat()

  it('a small frontier advance reuses the cache without an LLM call; the accrual closes with one', async () => {
    const msgs = build(20)
    const { compactor, runHistorySummary } = makeCompactor(msgs)

    // 1st inject: no cache → full-region summarize (branch 4). The frontier is
    // the NEWEST DROPPED message (msgs[9]) — the hole-shape key — not the kept
    // tail's start (msgs[10]), which is what pinned the old cache forever.
    await compactor.injectHistorySummary(msgs, msgs, msgs.slice(10))
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    const frontier0 = compactor.getHistorySummary()!.firstKeptId
    expect(frontier0).toBe(msgs[9].id)
    expect(frontier0).not.toBe(msgs[10].id)

    // 2nd: frontier advanced by 2 small messages — below the accrual line →
    // reused verbatim, NO call, frontier deliberately NOT re-keyed.
    const second = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(12))
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    expect(compactor.getHistorySummary()!.firstKeptId).toBe(frontier0)
    expect(second.some((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('【历史对话摘要】'))).toBe(true)

    // 3rd: advance by 5 more (still below the line alone) — still no call.
    await compactor.injectHistorySummary(msgs, msgs, msgs.slice(15))
    expect(runHistorySummary).toHaveBeenCalledTimes(1)

    // 4th: the accrued slice (msgs 10-17 = pairs 5-8, ~16K chars of region
    // text) crosses the line → exactly ONE call covering the whole accrual,
    // frontier re-keyed.
    const fourth = await compactor.injectHistorySummary(msgs, msgs, msgs.slice(18))
    expect(runHistorySummary).toHaveBeenCalledTimes(2)
    const accrued = runHistorySummary.mock.calls[1][0] as string
    expect(accrued).toContain('MARKER-5')
    expect(accrued).toContain('MARKER-8')
    expect(accrued).not.toContain('MARKER-9') // pair 9 is still kept
    expect(compactor.getHistorySummary()!.firstKeptId).toBe(msgs[17].id)
    expect(fourth.some((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('摘要内容')))
    void fourth
  })
})
