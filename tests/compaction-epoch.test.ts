// 压缩总控：单决策点 + 冻结 epoch（PLAN-compaction-epoch，2026-11-21）。
//
// 取证：conv_20261117170141 的回放里，现行四门（strip/nano/light/hard 各自
// 带比例门）命中率 62.7%，冻结 epoch 形态 82.1%——差别不在「切得多狠」，而在
// 「切的次数」与「切完副本多小」。本套钉子钉的就是这两条杠杆的实现面：
//
//   1. T/Δ 两条线：T = b − max(1.5·p75(增量), 0.08b)、Δ = clamp(1.5·p75, 0.15b, 0.30b)，
//      冷启动 <4 样本回落 0.85b / 0.70b，样本帽 8；
//   2. 冻结：base 是物化数组，同一 epoch 内 assembleCopy 返回同一个数组（引用恒等），
//      追加只动尾部、前缀逐字节不变；转录位移（rewind）由 id 锚点抓住并重铸；
//   3. 切割落点：price > T 才切，切完 price ≤ target（= T − Δ）；
//   4. 每 epoch 至多一次摘要：nano-only 的切割不调摘要，第二次浅切复用 base 里的摘要；
//   5. 从副本切不回填：上一 epoch 的占位符在下一刀里仍是占位符；切片不足 12K 的
//      丢弃进 carrier，由下一次越过线的摘要一并吸收（D6 跨刀记账），no-op 不记账；
//   6. 四类强制源：manual 0.60b / post-turn T−Δ / tool 只到 light 深度（hard 关）；
//   7. provider-400 重铸 base 后下一请求按引用发货（不再二次切）；
//   8. 重启：clearEpoch 回到全价与冷启动线；
//   9. 增量样本按请求记账、帽 8、切割清空。
//
// 另附接线扫描（AgentEngine.ts）：读数器唯一、日志行、重置点、退役符号负扫。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ContextCompactor,
  EPOCH_MANUAL_TARGET_RATIO,
  epochLines,
  type DirectCutResult,
} from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-11-21T00:00:00.000Z'
const WINDOW = 100_000
const ARCHIVED_PREFIX = '⟨archived: '
/** NANO_PLACEHOLDER_COST — the archived block's own price. */
const ARCHIVED_COST = 45

let seq = 0

interface Harness {
  live: AgentMessage[]
  calls: string[]
  compactor: ContextCompactor
}

function harness(initial: AgentMessage[]): Harness {
  const live = [...initial]
  const calls: string[] = []
  const compactor = new ContextCompactor({
    runHistorySummary: async (text: string) => { calls.push(text); return '摘要' },
    getMessages: () => live,
  })
  return { live, calls, compactor }
}

/** One tool round: assistant tool_use + the user message carrying its result.
 *  `'果'.repeat(n)` prices at exactly n tokens (CJK ≈ 1 token/char) and the
 *  tool_use prices at ceil('{}read'.length / 4) = 2, so a round weighs n + 2. */
function round(chars: number): AgentMessage[] {
  const n = ++seq
  const id = `tu${n}`
  return [
    {
      id: `a${n}`, role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'tool_use', id, name: 'read', input: {} }] as ContentBlock[],
    },
    {
      id: `u${n}`, role: 'user', createdAt: AT,
      contentBlocks: [{ type: 'tool_result', tool_use_id: id, content: '果'.repeat(chars) }] as ContentBlock[],
    },
  ]
}

function rounds(count: number, chars: number): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < count; i++) out.push(...round(chars))
  return out
}

/** One text turn: user text (n tokens) + a 10-token assistant reply. Weighs
 *  n + 10, carries no tool block — the shape that exercises hard truncation
 *  and the replay arm. */
function textPair(chars: number): AgentMessage[] {
  const n = ++seq
  return [
    { id: `pu${n}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '文'.repeat(chars) }] },
    { id: `pa${n}`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: '好'.repeat(10) }] },
  ]
}

function textPairs(count: number, chars: number): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < count; i++) out.push(...textPair(chars))
  return out
}

function archivedIds(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && (block.content || '').startsWith(ARCHIVED_PREFIX)) {
        ids.push(block.tool_use_id)
      }
    }
  }
  return ids
}

/** What a tool_result still holds: its placeholder id, or null when the full
 *  text is still there. */
function resultContentById(messages: AgentMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') out.set(block.tool_use_id, block.content || '')
    }
  }
  return out
}

function cutPrice(messages: AgentMessage[]): number {
  // The compactor's own units (heuristic + calibration 1.0 here).
  return estimateMessagesTokens(messages)
}

// ── 1. T/Δ 推导 ────────────────────────────────────────────────────────
describe('epochLines：T 由实测增量定位，Δ 决定切深', () => {
  it('cold start (<4 samples) is the wide pair: 0.85b trigger / 0.70b floor', () => {
    const lines = epochLines(WINDOW, [])
    expect(lines).toEqual({ growth: 10_000, trigger: 85_000, depth: 15_000, target: 70_000 })
  })

  it('a slow curve keeps the 0.08b pad and the 0.15b depth floor', () => {
    // 4×5K → 1.5g = 7.5K < 8K pad; depth floors at 0.15b.
    const lines = epochLines(WINDOW, [5_000, 5_000, 5_000, 5_000])
    expect(lines.growth).toBe(5_000)
    expect(lines.trigger).toBe(92_000)
    expect(lines.depth).toBe(15_000)
    expect(lines.target).toBe(77_000)
  })

  it('a fast curve lifts the trigger and maxes the depth', () => {
    const lines = epochLines(WINDOW, [40_000, 40_000, 40_000, 40_000])
    expect(lines.growth).toBe(40_000)
    expect(lines.trigger).toBe(40_000) // 1.5·g = 60K > 0.08b
    expect(lines.depth).toBe(30_000) // 0.30b ceiling
    expect(lines.target).toBe(10_000)
  })

  it('three samples is still a cold start — the p75 needs four', () => {
    const lines = epochLines(WINDOW, [40_000, 40_000, 40_000])
    expect(lines.growth).toBe(10_000)
    expect(lines.trigger).toBe(85_000)
  })

  it('p75 is nearest-rank, not the max: [1,2,3,4,100] → 4', () => {
    expect(epochLines(WINDOW, [1, 2, 3, 4, 100]).growth).toBe(4)
  })

  it('an outlier-dominated tail still reads the bulk (the 8-sample cap shape)', () => {
    const lines = epochLines(WINDOW, [1_002, 1_002, 1_002, 1_002, 1_002, 1_002, 50_002, 50_002])
    expect(lines.growth).toBe(1_002)
    expect(lines.trigger).toBe(92_000)
  })

  it('the instance reader uses the samples the request path booked', () => {
    const { live, compactor } = harness(rounds(10, 1_000))
    expect(compactor.epochLines(WINDOW).trigger).toBe(85_000)
    // Five 1K rounds: the first pricing only sets the baseline (`lastCopyPrice`
    // starts at 0), so four deltas are booked — the p75's minimum sample count.
    for (let i = 0; i < 5; i++) {
      live.push(...round(1_000))
      compactor.priceRequest(compactor.assembleCopy(), 0)
    }
    const lines = compactor.epochLines(WINDOW)
    expect(lines.growth).toBe(1_002)
    expect(lines.trigger).toBe(92_000) // 1.5·1,002 < the 0.08b pad
  })
})

// ── 2. 冻结：base 是物化数组 ───────────────────────────────────────────
describe('assembleCopy：同一 epoch 内前缀逐字节不变', () => {
  it('is identity when nothing was appended — the same array, not a copy', () => {
    const { compactor } = harness(textPairs(5, 100))
    const first = compactor.assembleCopy()
    expect(compactor.assembleCopy()).toBe(first)
  })

  it('an append only moves the tail: the head objects survive by reference', () => {
    const { live, compactor } = harness(textPairs(5, 100))
    const first = compactor.assembleCopy()
    live.push(...textPair(100))
    const second = compactor.assembleCopy()
    expect(second).not.toBe(first)
    expect(second.length).toBe(first.length + 2)
    expect(second[0]).toBe(first[0])
    expect(second.slice(0, first.length - 1).map(m => m.id))
      .toEqual(first.slice(0, -1).map(m => m.id))
  })

  it('a shifted transcript breaks the id anchor and rebuilds from the live list', () => {
    const { live, compactor } = harness(textPairs(5, 100))
    const first = compactor.assembleCopy()
    const droppedId = live[0].id
    // Same LENGTH after the shift — only the id anchor can notice.
    live.shift()
    live.push(...textPair(100))
    const rebuilt = compactor.assembleCopy()
    expect(rebuilt.length).toBe(live.length)
    expect(rebuilt[0].id).toBe(live[0].id)
    expect(rebuilt[0].id).not.toBe(droppedId)
    expect(rebuilt).not.toBe(first)
  })
})

// ── 3. 切割落点 ≤ target ──────────────────────────────────────────────
describe('directCut：price > T 才切，切完落到 target 之下', () => {
  it('a cold 90K tool copy cuts once to ≤ 70K and freezes the result', async () => {
    // 60×1.5K rounds = 90,120; cold lines are 85K / 70K.
    const { live, calls, compactor } = harness(rounds(60, 1_500))
    expect(cutPrice(live)).toBe(90_120)
    const lines = compactor.epochLines(WINDOW)
    expect(lines.trigger).toBe(85_000)

    const result = await compactor.directCut(lines.target)
    expect(result.cut).toBe(true)
    expect(result.strategies).toEqual(['nano', 'epoch'])
    expect(result.priceBefore).toBe(90_120)
    expect(result.priceAfter).toBeLessThanOrEqual(lines.target)
    // nano took one candidate past the budget line (directed walk), 14 in all.
    expect(archivedIds(result.messages).length).toBe(14)
    // nano-only cut drops no messages → no summary call at all.
    expect(calls.length).toBe(0)
    expect(result.droppedMessages).toBe(0)
    // The base IS the product: the next assembly is the same array.
    expect(compactor.assembleCopy()).toBe(result.messages)
    // A cut resets the growth curve — the next T is the cold line again.
    expect(compactor.epochLines(WINDOW).trigger).toBe(85_000)
  })

  it('a copy already under the target is not cut', async () => {
    const { compactor } = harness(rounds(40, 1_500)) // 60,080
    const result = await compactor.directCut(70_000)
    expect(result.cut).toBe(false)
    expect(result.strategies).toEqual([])
    expect(result.priceAfter).toBe(result.priceBefore)
  })

  it('steps that free nothing do not report a cut (the no-op gate)', async () => {
    // 90K of pure text with hard OFF: nano/thinking/light all no-op.
    const { calls, compactor } = harness(textPairs(30, 3_000))
    const result = await compactor.directCut(70_000, { allowHard: false })
    expect(result.cut).toBe(false)
    expect(result.strategies).toEqual([])
    expect(calls.length).toBe(0)
    // Nothing was frozen: a later copy is still assembled from the transcript.
    expect(result.messages.length).toBe(60)
  })
})

// ── 4. 每 epoch ≤ 1 次摘要 ────────────────────────────────────────────
describe('摘要预算：每 epoch 至多一次，且烘进 base', () => {
  it('a text-heavy cut runs exactly one summary and bakes the block', async () => {
    // 30×(1K+10) = 30,300; cut at 20K. Replay reserve = 10K (capped), so the
    // steps aim at 10K: hard keeps 19 messages (9,100), replays take 10×1K,
    // the summary rides on top → ~19.1K ≤ 20K.
    const { calls, compactor } = harness(textPairs(30, 1_000))
    const result = await compactor.directCut(20_000)

    expect(result.cut).toBe(true)
    expect(result.strategies).toContain('hard')
    expect(result.strategies).toContain('summary')
    expect(result.strategies[result.strategies.length - 1]).toBe('epoch')
    expect(calls.length).toBe(1)
    expect(compactor.lastInjectReplayCount).toBe(10)
    expect(result.priceAfter).toBeLessThanOrEqual(20_000)
    expect(result.priceAfter).toBeLessThan(result.priceBefore)
    // The compensation block (replays + summary + kept tail) is the new base.
    expect(compactor.assembleCopy()).toBe(result.messages)
    expect(result.messages.length).toBe(10 + 1 + 19)
  })

  it('a second nano-only cut on that base reuses the summary — no second call', async () => {
    const { live, calls, compactor } = harness(textPairs(30, 1_000))
    const first = await compactor.directCut(20_000)
    expect(calls.length).toBe(1)

    // 50 tool rounds land on the tail: 19,135 + 50×1,002 ≈ 69.2K.
    for (let i = 0; i < 50; i++) live.push(...round(1_000))
    const before = compactor.copyTokens(compactor.assembleCopy(), 0)
    expect(before).toBeGreaterThan(60_000)

    const second = await compactor.directCut(before - 18_000)
    expect(second.cut).toBe(true)
    expect(second.strategies).toEqual(['nano', 'epoch'])
    // The old summary rode back as the SAME object (Fix A) — the base carries
    // its own compensation block, so nothing was re-summarized.
    expect(calls.length).toBe(1)
    const bakedSummary = first.messages.find(m => m.id.startsWith('summary_'))
    expect(bakedSummary).toBeDefined()
    expect(second.messages.find(m => m.id.startsWith('summary_'))).toBe(bakedSummary)
    // Nothing of the transcript left the copy (nano archives in place), so the
    // base + the 100 appended messages come back whole — modulo the seam: the
    // wedge regroups the boundary assistant text with the first tool round into
    // one carrier, which is why the count is 129 and not 130.
    expect(second.messages.length).toBe(129)
  })
})

// ── 5. 从副本切：已归档不回填 ─────────────────────────────────────────
describe('从副本切不回填（D5）', () => {
  it('placeholders from the first cut survive the second one', async () => {
    const { live, compactor } = harness(rounds(60, 1_500))
    const first = await compactor.directCut(70_000)
    const firstArchived = archivedIds(first.messages)
    expect(firstArchived.length).toBe(14)

    for (let i = 0; i < 20; i++) live.push(...round(1_500)) // +20×1,502
    const before = compactor.copyTokens(compactor.assembleCopy(), 0)
    expect(before).toBe(first.priceAfter + 20 * 1_502)

    const second = await compactor.directCut(70_000)
    expect(second.cut).toBe(true)
    const contents = resultContentById(second.messages)
    for (const id of firstArchived) {
      expect(contents.get(id)?.startsWith(ARCHIVED_PREFIX)).toBe(true)
    }
    expect(archivedIds(second.messages).length).toBeGreaterThan(firstArchived.length)
    expect(second.priceAfter).toBeLessThanOrEqual(70_000)
  })
})

// ── 5b. 跨刀记账（D6） ────────────────────────────────────────────────
describe('跨刀记账（D6）：吸收不掉的丢弃进下一刀的区域', () => {
  /** A text turn whose assistant reply ends with its own id. The region text a
   *  summarizer sees (`buildDroppedRegionText`) carries no ids, so baking one
   *  into the text is the only way to prove a LATER summary absorbed THIS
   *  message — a substring search over the shipped prompt. */
  function tracePair(marker: string, chars: number): AgentMessage[] {
    const n = ++seq
    const id = `ta${n}`
    return [
      { id: `tu${n}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: marker.repeat(chars) }] },
      { id, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: `好`.repeat(9) + id }] },
    ]
  }

  function tracePairs(marker: string, count: number, chars: number): AgentMessage[] {
    const out: AgentMessage[] = []
    for (let i = 0; i < count; i++) out.push(...tracePair(marker, chars))
    return out
  }

  const carrierOf = (c: ContextCompactor): AgentMessage[] =>
    (c as unknown as { droppedSinceSummary: AgentMessage[] }).droppedSinceSummary

  const textOf = (m: AgentMessage): string =>
    m.contentBlocks.map(b => ('text' in b ? b.text : '')).join('')

  it('a slice below the extension line accrues; the next crossing cut absorbs it', async () => {
    const { live, calls, compactor } = harness([
      ...tracePairs('文', 20, 1_000), // 20,200
      ...tracePairs('庚', 10, 1_000), // 10,100
    ])

    // C1 (30.3K → 20K): the whole region is big enough for one summary, and
    // every drop is covered by it — nothing left over.
    const first = await compactor.directCut(20_000)
    expect(first.strategies).toContain('summary')
    expect(calls.length).toBe(1)
    expect(carrierOf(compactor)).toEqual([])

    // C2: the seam moves again, but the three new pairs' slice is far below the
    // 12K extension line — the summary is NOT re-run, and the drops stay in the
    // carrier instead of being lost between cuts.
    live.push(...tracePairs('甲', 3, 1_000))
    const second = await compactor.directCut(20_000)
    expect(second.cut).toBe(true)
    expect(second.strategies).toEqual(['hard', 'epoch'])
    expect(calls.length).toBe(1)
    const accrued = carrierOf(compactor)
    expect(accrued.length).toBeGreaterThan(0)
    // Dropped, yet never summarized: the only summary call shipped without them.
    const accruedTexts = accrued.map(textOf)
    expect(accruedTexts.length).toBe(accrued.length) // every one is searchable
    for (const t of accruedTexts) expect(calls[0].includes(t)).toBe(false)

    // A cut that frees nothing must not touch the carrier — `directCut` returns
    // before the commit arm, so an over-target no-op is not an accrual event.
    const frozen = carrierOf(compactor).map(m => m.id)
    const noop = await compactor.directCut(20_000, { allowHard: false })
    expect(noop.cut).toBe(false)
    expect(noop.strategies).toEqual([])
    expect(carrierOf(compactor).map(m => m.id)).toEqual(frozen)
    expect(calls.length).toBe(1)

    // Walk on: each cut drops its own small slice (still under 12K, still no
    // second call) and the carrier keeps every one of them.
    let absorbing: DirectCutResult | null = null
    const markers = '乙丙丁戊己庚辛'
    for (let i = 0; i < 6; i++) {
      const before = carrierOf(compactor).length
      live.push(...tracePairs(markers[i], 3, 1_000))
      const cut = await compactor.directCut(20_000)
      expect(cut.cut).toBe(true)
      if (calls.length === 2) { absorbing = cut; break }
      expect(calls.length).toBe(1)
      expect(carrierOf(compactor).length).toBeGreaterThan(before)
    }
    expect(absorbing, 'the region must cross SUMMARY_EXTEND_MIN_CHARS within a few cuts').not.toBeNull()
    expect(absorbing!.strategies).toContain('summary')

    // The extension shipped the carrier's texts — the hole "dropped here,
    // never summarized" is closed at the next crossing.
    for (const t of accruedTexts) expect(calls[1].includes(t)).toBe(true)
    expect(carrierOf(compactor)).toEqual([])
  })

  it('seedHistorySummary adopts the new frontier and drops the carrier', async () => {
    const { live, compactor } = harness([...tracePairs('文', 20, 1_000), ...tracePairs('庚', 10, 1_000)])
    await compactor.directCut(20_000)
    live.push(...tracePairs('甲', 3, 1_000))
    await compactor.directCut(20_000)
    expect(carrierOf(compactor).length).toBeGreaterThan(0)

    // A fresh summary (restart / persisted-history adoption) already speaks for
    // everything before its frontier — replaying the carrier would duplicate it.
    compactor.seedHistorySummary('种子', 'x1')
    expect(carrierOf(compactor)).toEqual([])
    expect(compactor.getHistorySummary()?.text).toBe('种子')
  })
})

// ── 6. 四类强制源 ──────────────────────────────────────────────────────
describe('强制源：manual / post-turn / tool', () => {
  it('/compact lands at 0.60b and does not book a growth sample', async () => {
    const { compactor } = harness(rounds(60, 1_500))
    const event = await compactor.prewarm({ contextLength: WINDOW, source: 'manual' })
    expect(event).not.toBeNull()
    expect(event!.source).toBe('manual')
    expect(event!.tokensBefore).toBe(90_120)
    expect(event!.tokensAfter).toBeLessThanOrEqual(WINDOW * EPOCH_MANUAL_TARGET_RATIO)
    expect(event!.strategies).toEqual(['nano', 'epoch'])
    // record=false: the curve belongs to the request path.
    expect(compactor.epochLines(WINDOW).trigger).toBe(85_000)
  })

  it('post-turn stays silent below T−Δ and fires above it', async () => {
    const small = harness(rounds(40, 1_500)) // 60,080 < 70K
    expect(await small.compactor.prewarm({ contextLength: WINDOW, source: 'post-turn' })).toBeNull()

    const big = harness(rounds(60, 1_500)) // 90,120 > 70K
    const event = await big.compactor.prewarm({ contextLength: WINDOW, source: 'post-turn' })
    expect(event).not.toBeNull()
    expect(event!.tokensAfter).toBeLessThanOrEqual(70_000)
  })

  it('context_compact gets light depth only: a text-only copy cannot be cut', async () => {
    const { calls, compactor } = harness(textPairs(30, 3_000)) // 90,300
    const event = await compactor.prewarm({ contextLength: WINDOW, source: 'tool' })
    // hard is off, nano/strip/light no-op on text → nothing to freeze.
    expect(event).toBeNull()
    expect(calls.length).toBe(0)
  })
})

// ── 7. provider-400 重铸 ───────────────────────────────────────────────
describe('provider-400：首次重铸 base，下一请求按引用发货', () => {
  it('a recast under the named limit ships without a second cut', async () => {
    const { compactor } = harness(rounds(60, 1_500))
    const recast = await compactor.directCut(50_000)
    expect(recast.cut).toBe(true)
    expect(recast.priceAfter).toBeLessThanOrEqual(50_000)

    const copy = compactor.assembleCopy()
    expect(copy).toBe(recast.messages)
    const price = compactor.priceRequest(copy, 0)
    expect(price).toBe(recast.priceAfter)
    // Well under the cold trigger: the next request does not cut again.
    expect(price).toBeLessThan(compactor.epochLines(WINDOW).trigger)
  })

  it('a limit above the current price is a no-op', async () => {
    const { compactor } = harness(rounds(60, 1_500))
    const result = await compactor.directCut(200_000)
    expect(result.cut).toBe(false)
    expect(result.priceBefore).toBe(90_120)
  })
})

// ── 8. 重启：clearEpoch ───────────────────────────────────────────────
describe('clearEpoch：重启后首个请求从全价起步', () => {
  it('drops the base, the placeholders and the growth curve', async () => {
    const { live, compactor } = harness(rounds(60, 1_500))
    const cut = await compactor.directCut(70_000)
    expect(archivedIds(cut.messages).length).toBeGreaterThan(0)

    compactor.clearEpoch()
    const copy = compactor.assembleCopy()
    expect(archivedIds(copy)).toEqual([])
    expect(copy.length).toBe(live.length)
    expect(compactor.copyTokens(copy, 0)).toBe(90_120)
    expect(compactor.epochLines(WINDOW)).toEqual({
      growth: 10_000, trigger: 85_000, depth: 15_000, target: 70_000,
    })
  })
})

// ── 9. 增量样本记账 ───────────────────────────────────────────────────
describe('growth 样本：按请求记账、帽 8、切割清空', () => {
  it('books the positive delta and caps at 8 (oldest evicted)', () => {
    const { live, compactor } = harness(rounds(10, 1_000))
    compactor.priceRequest(compactor.assembleCopy(), 0) // baseline, no sample
    expect(compactor.epochLines(WINDOW).growth).toBe(10_000) // cold

    for (let i = 0; i < 8; i++) {
      live.push(...round(1_000))
      compactor.priceRequest(compactor.assembleCopy(), 0)
    }
    expect(compactor.epochLines(WINDOW).growth).toBe(1_002)

    // Two 50K landings: with the cap, the p75 still reads the bulk (1,002);
    // an uncapped ten-sample p75 would read 50,002 and pin T near 25K.
    for (let i = 0; i < 2; i++) {
      live.push(...round(50_000))
      compactor.priceRequest(compactor.assembleCopy(), 0)
    }
    const lines = compactor.epochLines(WINDOW)
    expect(lines.growth).toBe(1_002)
    expect(lines.trigger).toBe(92_000)
  })
})

// ── 10. 接线扫描 ──────────────────────────────────────────────────────
describe('接线：读数器唯一、重置点两处、退役符号不长回来', () => {
  const engine = readFileSync('src/renderer/src/agent/AgentEngine.ts', 'utf8')
  const compactor = readFileSync('src/renderer/src/agent/engine/context-compactor.ts', 'utf8')

  it('waits out a running prewarm BEFORE assembling the copy', () => {
    const wait = engine.indexOf('await this.compactor.awaitPrewarm()')
    const assemble = engine.indexOf('const apiMessages = this.compactor.assembleCopy()')
    expect(wait).toBeGreaterThan(0)
    expect(assemble).toBeGreaterThan(wait)
  })

  it('logs the epoch line and routes the manual force through the 0.60b ratio', () => {
    expect(engine).toContain('[AgentEngine] epoch price=')
    expect(engine).toContain('inputBudget * EPOCH_MANUAL_TARGET_RATIO')
  })

  it('feeds the refill breaker the "new base materialized" signal', () => {
    expect(engine).toContain('cut?.cut === true')
  })

  it('clears the epoch at exactly the two conversation reset points', () => {
    expect(engine.match(/this\.compactor\.clearEpoch\(\)/g)?.length).toBe(2)
  })

  it('no retired gate/ledger/latch symbol survives in either file', () => {
    const retired = [
      'FIT_GATE_USED_RATIO', 'FIT_ARCHIVE_TARGET_RATIO', 'THINKING_STRIP_USED_RATIO',
      'POST_TURN_COMPACT_USED_RATIO', 'clearGateState', 'gateArchivedIds',
      'thinkingStripLatched', 'lastLightDropRounds', 'lightDroppedIds',
      'lightStrippedIds', 'applyPersistedDrops', 'compensationMemo',
      'LIGHT_RECLAIM_MARGIN_RATIO', 'LIGHT_MIN_RECLAIM_RATIO', 'LIGHT_REMAIN_HEADROOM_RATIO',
      'LIGHT_COMPACT_MIN_REMAINING',
    ]
    // Code only: the doc comments deliberately name their retired mechanisms
    // to explain why there is no latch/ledger to restore — prose is the guard
    // against a return, not a return. Strip block comments and whole-line `//`
    // comments (leading-whitespace form only, so `http://` in strings survives).
    const stripProse = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const engineCode = stripProse(engine)
    const compactorCode = stripProse(compactor)
    for (const symbol of retired) {
      expect(engineCode).not.toContain(symbol)
      expect(compactorCode).not.toContain(symbol)
    }
  })

  it('the trigger chain no longer reads requestTokensOf', () => {
    expect(engine).not.toContain('requestTokensOf')
  })

  it('the cut materializes the epoch, and the event vocabulary keeps `epoch` a strategy', () => {
    expect(compactor).toContain("strategies.push('epoch')")
    // CompactionEvent.source vocabulary is unchanged (StateStrip's landed
    // logic and the ring's pending tiers key on it).
    expect(compactor).not.toContain("source: 'epoch'")
  })
})

// A typed alias so an unused-import lint never fires on DirectCutResult.
export type EpochCut = DirectCutResult
