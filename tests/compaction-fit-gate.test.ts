// 合并拟合门（PLAN-nano-light-trigger-merge W1，2026-11-09）。
// 旧形态：nano 按纯计数配额无条件跑（tier 满 2 批就压到剩 1 批），与窗口占用无关；
// 长工具循环里它在副本远未逼近上限时就一遍遍重开归档，每次都在「最老的未归档结果」
// 处断掉提供商的前缀缓存，而 light 随后从 messages[0] 丢头——`conv_20261109101329`
// 137 轮里 45 轮命中 <50%，约 70% 的未命中来自这里。
// 新形态：一个 token 计量的门——用量 < 60% 窗口什么都不动；越过门一次咬到 50%；
// 可回收量不足 4K 不动手（断缓存不值这点 token）。tier 配额降为「每 pass 至多
// count − size 条」的**上限**，即旧的「保住最新一批」承诺，不再是驱动者。
// 钉的性质：
//   1. 门关闭 ⇒ 逐字节相等（短会话零行为变化，这是不回归的唯一证据）；
//   2. 门开启 ⇒ 归档量 ≥ 拟合缺口、落点 ≤ 目标线，且保护窗 / tier3 / 已占位符一条不碰；
//   3. 滞回 ⇒ 一次归档后下一 pass 不再改字节（防「每轮断一次缓存」）；
//   4. 可回收不足下限 ⇒ 不动；上限（count − size）仍然保住最新一批；
//   5. 无窗口 ⇒ 与合并前配额走法逐字节一致（调用点忘了传窗口 = 旧行为，不是静默不压）；
//   6. 环投影 ≡ 真请求：estimateAfterNanoTokens 与 nanoCompact 出征的副本同价。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContextCompactor,
  FIT_ARCHIVE_TARGET_RATIO,
  FIT_GATE_USED_RATIO,
  NANO_MIN_RECLAIM_TOKENS,
  estimateAfterNanoTokens,
} from '../src/renderer/src/agent/engine/context-compactor'
import { estimateTextTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

/** The placeholder prefix nano mints (a legacy family also counts, but every
 *  fixture here is minted fresh). */
const ARCHIVED_PREFIX = '⟨archived: '

const WINDOW = 100_000
const AT = '2026-11-09T00:00:00.000Z'
let seq = 0

function newCompactor(): ContextCompactor {
  return new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => [] })
}

/** One tool round: assistant tool_use + the user message carrying its result.
 *  '果'.repeat(n) prices at exactly n tokens (CJK ≈ 1 token/char), so every
 *  fixture below is arithmetic rather than a guess. */
function round(toolName: string, chars: number): AgentMessage[] {
  const n = ++seq
  const id = `tu${n}`
  return [
    {
      id: `a${n}`, role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'tool_use', id, name: toolName, input: {} }] as ContentBlock[],
    },
    {
      id: `u${n}`, role: 'user', createdAt: AT,
      contentBlocks: [{ type: 'tool_result', tool_use_id: id, content: '果'.repeat(chars) }] as ContentBlock[],
    },
  ]
}

function rounds(count: number, toolName: string, chars: number): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < count; i++) out.push(...round(toolName, chars))
  return out
}

/** What the copy weighs block by block, with archived results at the
 *  placeholder's documented price — the arithmetic estimateAfterNanoTokens
 *  promises (and the direction nanoCompact actually ships). */
function wirePrice(messages: AgentMessage[], placeholderCost = 45): number {
  let total = 0
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') {
        const content = block.content || ''
        total += content.startsWith(ARCHIVED_PREFIX) ? placeholderCost : estimateTextTokens(content)
      } else if (block.type === 'text') total += estimateTextTokens(block.text)
      else if (block.type === 'tool_use') total += estimateTextTokens(JSON.stringify(block.input) + block.name)
      else if (block.type === 'thinking') total += estimateTextTokens((block as { thinking: string }).thinking)
    }
  }
  return total
}

function archivedIds(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type !== 'tool_result') continue
      if ((block.content || '').startsWith(ARCHIVED_PREFIX)) ids.push(block.tool_use_id)
    }
  }
  return ids
}

describe('the merged fit gate: one token-metered decision for nano and light', () => {
  it('below the gate nothing is archived — byte-identical, same array', () => {
    // 12 tier-2 results ≈ 12K tokens; overhead parks usage just under the
    // 60K line (used = results + overhead, the compactor's own units).
    const messages = rounds(12, 'read', 1_000)
    const overhead = WINDOW * FIT_GATE_USED_RATIO - 14_000
    const compactor = newCompactor()

    const shut = compactor.nanoCompact(messages, WINDOW, overhead)
    expect(usedOf(compactor, messages, overhead)).toBeLessThan(WINDOW * FIT_GATE_USED_RATIO)
    expect(shut).toBe(messages)
    expect(archivedIds(shut)).toEqual([])
    // The projection agrees: no gate, no discount.
    expect(estimateAfterNanoTokens(messages, WINDOW, overhead))
      .toBe(estimateAfterNanoTokens(messages))
  })

  it('crossing the gate bites down to the target and stops there', () => {
    // 40 tier-2 results × 1.5K = 60K of results; overhead puts usage over the
    // gate. The gap to the 50% target is the only budget the pass may spend.
    const messages = rounds(40, 'read', 1_500)
    const overhead = 5_000
    const compactor = newCompactor()
    const used = usedOf(compactor, messages, overhead)
    expect(used).toBeGreaterThanOrEqual(WINDOW * FIT_GATE_USED_RATIO)

    const out = compactor.nanoCompact(messages, WINDOW, overhead)
    const ids = archivedIds(out)
    expect(ids.length).toBeGreaterThan(0)

    const gap = used - WINDOW * FIT_ARCHIVE_TARGET_RATIO
    // The copy after the pass, in the units `used` was measured in.
    const after = wirePrice(out) + overhead
    expect(after).toBeLessThanOrEqual(WINDOW * FIT_ARCHIVE_TARGET_RATIO)
    // One bite, not a purge: the gap must be spent, and not by a whole batch
    // more than it (each take is ≤ ~1.5K).
    expect(used - after).toBeGreaterThanOrEqual(gap)
    expect(used - after).toBeLessThan(gap + 1_600)

    // Oldest-first: the archived set is a prefix of the candidates, so the
    // cache break lands as deep as the frontier allows.
    const candidateOrder = messages
      .filter(m => m.role === 'user')
      .map(m => (m.contentBlocks[0] as { tool_use_id: string }).tool_use_id)
    expect(ids).toEqual(candidateOrder.slice(0, ids.length))

    // The protection window (newest 4 tool_result messages) survives whole.
    const newestFour = candidateOrder.slice(-4)
    for (const id of newestFour) expect(ids).not.toContain(id)
  })

  it('hysteresis: the pass after a bite changes nothing', () => {
    const messages = rounds(40, 'read', 1_500)
    const overhead = 5_000
    const compactor = newCompactor()
    const first = compactor.nanoCompact(messages, WINDOW, overhead)
    expect(archivedIds(first).length).toBeGreaterThan(0)
    expect(wirePrice(first)).toBeLessThan(WINDOW * FIT_GATE_USED_RATIO)

    // Next request over the SAME full-text source — the production shape: the
    // live history is never mutated, so the archive lives only in the wire
    // copy and the gate re-measures the source still over 60%. The pass must
    // re-derive the SAME plan and emit byte-identical placeholders; a drift
    // here is a prefix-cache break on every request above the gate (the
    // retired one-shot marks did exactly that — W2,
    // PLAN-nano-light-trigger-merge).
    const second = compactor.nanoCompact(messages, WINDOW, overhead)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(archivedIds(second)).toEqual(archivedIds(first))

    // And the wire shape itself (placeholder already in) sits at the target,
    // below the gate — feeding it back no-ops wholesale.
    const third = compactor.nanoCompact(first, WINDOW, overhead)
    expect(third).toBe(first)
  })

  it('a pass that would reclaim less than the floor is not worth a cache break', () => {
    // 21 tier-2 results ⇒ the cap leaves ONE takeable (the oldest), and that
    // one is small — available reclaim lands under NANO_MIN_RECLAIM_TOKENS.
    const messages = rounds(21, 'read', 100)
    const oldest = messages[1].contentBlocks[0] as { content: string }
    oldest.content = '果'.repeat(1_000)
    const overhead = WINDOW * FIT_GATE_USED_RATIO + 5_000
    const compactor = newCompactor()
    expect(usedOf(compactor, messages, overhead)).toBeGreaterThan(WINDOW * FIT_GATE_USED_RATIO)

    const saving = 1_000 - 45
    expect(saving).toBeLessThan(NANO_MIN_RECLAIM_TOKENS)
    expect(compactor.nanoCompact(messages, WINDOW, overhead)).toBe(messages)
  })

  it('the tier quota survives as a cap: one pass never eats the newest batch', () => {
    // Absurdly over-full copy (budget far beyond the copy): only the quota
    // stands between the pass and archiving everything.
    const messages = rounds(40, 'read', 1_500)
    const overhead = WINDOW * 2
    const compactor = newCompactor()
    const ids = archivedIds(compactor.nanoCompact(messages, WINDOW, overhead))
    // tier2 size 20, count 40 ⇒ at most count − size = 20 in one pass.
    expect(ids.length).toBe(20)
    // …and they are the OLDEST 20 of the candidates (36 candidates: 40 minus
    // the 4 protected), so the newest batch stays readable.
    const candidateOrder = messages
      .filter(m => m.role === 'user')
      .map(m => (m.contentBlocks[0] as { tool_use_id: string }).tool_use_id)
      .slice(0, -4)
    expect(ids).toEqual(candidateOrder.slice(0, 20))
  })

  it('tier3 results and existing placeholders are never touched, gate or no gate', () => {
    const messages: AgentMessage[] = [
      ...rounds(12, 'read', 1_500),
      ...rounds(3, 'ask_user', 1_500),
    ]
    // Plant an already-archived result in the middle of the eligible region.
    const plantAt = messages.findIndex(m => m.role === 'user')
    ;(messages[plantAt].contentBlocks[0] as { content: string }).content = '⟨archived: old-id⟩'
    const compactor = newCompactor()
    const planted = messages[plantAt].contentBlocks[0] as { content: string; tool_use_id: string }
    const out = compactor.nanoCompact(messages, WINDOW, WINDOW * 2)
    // The planted placeholder is already archived, so it must survive verbatim:
    // the plan skips placeholders rather than re-minting their ids. (Reading
    // archivedIds(out) cannot express this — the planted block IS a
    // placeholder, so it is in the set by construction; byte equality is the
    // evidence that the pass left it alone.)
    expect(planted.content).toBe(`${ARCHIVED_PREFIX}old-id⟩`)
    const ids = archivedIds(out)
    // ask_user is tier3: its ids never enter a plan.
    const tier3Ids = messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => m.contentBlocks)
      .filter((b): b is { type: 'tool_use'; id: string; name: string } => b.type === 'tool_use' && b.name === 'ask_user')
      .map(b => b.id)
    expect(tier3Ids.length).toBe(3)
    for (const id of tier3Ids) expect(ids).not.toContain(id)
  })

  it('no window known ⇒ the pre-merge quota walk, byte for byte', () => {
    const messages = rounds(20, 'exec', 1_500)
    const compactor = newCompactor()
    // tier1 size 10, 20 results ⇒ two full batches ⇒ archive down to one = 10.
    const ids = archivedIds(compactor.nanoCompact(messages))
    expect(ids.length).toBe(10)
    const candidateOrder = messages
      .filter(m => m.role === 'user')
      .map(m => (m.contentBlocks[0] as { tool_use_id: string }).tool_use_id)
      .slice(0, -4)
    expect(ids).toEqual(candidateOrder.slice(0, 10))
  })

  it('a pure-text copy has nothing to archive, so light keeps owning that case', () => {
    const messages: AgentMessage[] = []
    for (let i = 0; i < 30; i++) {
      messages.push({ id: `t${i}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text: '果'.repeat(2_000) }] })
      messages.push({ id: `s${i}`, role: 'assistant', createdAt: AT, contentBlocks: [{ type: 'text', text: '果'.repeat(1_000) }] })
    }
    const compactor = newCompactor()
    expect(compactor.nanoCompact(messages, WINDOW, WINDOW * 2)).toBe(messages)
  })

  it('the ring projection prices exactly the copy nanoCompact ships', () => {
    const messages = rounds(40, 'read', 1_500)
    const compactor = newCompactor()
    const shipped = compactor.nanoCompact(messages, WINDOW, 5_000)
    expect(wirePrice(shipped)).toBeLessThan(wirePrice(messages))
    // The projection runs without the live engine's mandates, so on a first
    // pass it must reach the same decision — a drift here silently misprices
    // every ring.
    // The baseline must be the same one the live pass gated on (`overhead`):
    // the gate judges whole-copy usage, so a 0 baseline would shrink the
    // budget and archive less than the request does.
    expect(estimateAfterNanoTokens(messages, WINDOW, 5_000)).toBe(wirePrice(shipped))
    // And the raw price is what it returns when the gate is shut.
    expect(estimateAfterNanoTokens(messages, WINDOW * 10)).toBe(wirePrice(messages))
  })

  it('both production call sites pass the window and the fixed overhead', () => {
    const root = join(__dirname, '..')
    const engine = readFileSync(join(root, 'src/renderer/src/agent/AgentEngine.ts'), 'utf8')
    const compactor = readFileSync(join(root, 'src/renderer/src/agent/engine/context-compactor.ts'), 'utf8')
    const ring = readFileSync(join(root, 'src/renderer/src/components/chat/ContextRing.tsx'), 'utf8')
    // The live pass: same units as the light/hard walks below it (W1).
    expect(engine).toContain('nanoCompact(pipelineMessages, opts.contextLength || 128000, fixedOverhead)')
    // The prewarm simulation: a 0-overhead / windowless run would archive
    // later and less than the request does, which is exactly what
    // compaction-prewarm exists to catch.
    expect(compactor).toContain('this.nanoCompact(pipeline, contextLength, overhead)')
    // The ring needs the window too, else archived results price whole.
    expect(ring).toContain('estimateAfterNanoTokens(messages.slice(i + 1), contextLength, t)')
    expect(ring).toContain('estimateAfterNanoTokens(tailMsgs, contextLength, compaction.tokensAfter)')
  })
})

// ── W3 observability ────────────────────────────────────────────────────────
// The gate's own verdict is what the per-request `[AgentEngine] fit-gate` line
// reports, and a stale record would describe the previous request (or the
// prewarm simulation) as this one's cut. These pin the four states the line
// has to distinguish, plus the engine reading it on the same tick.
describe('the last nano decision is reportable', () => {
  it('gate closed ⇒ reports closed with the usage it judged and no archive', () => {
    const messages = rounds(12, 'read', 1_000)
    const overhead = WINDOW * FIT_GATE_USED_RATIO - 14_000
    const compactor = newCompactor()
    compactor.nanoCompact(messages, WINDOW, overhead)

    const stats = compactor.lastNanoArchive!
    expect(stats.gate).toBe('closed')
    expect(stats.used).toBe(usedOf(compactor, messages, overhead))
    expect(stats.archived).toBe(0)
    expect(stats.reclaimed).toBe(0)
    expect(stats.target).toBe(WINDOW * FIT_ARCHIVE_TARGET_RATIO)
  })

  it('gate open ⇒ the reported count and reclaim are the pass it just ran', () => {
    const messages = rounds(40, 'read', 1_500)
    const compactor = newCompactor()
    const out = compactor.nanoCompact(messages, WINDOW, 5_000)

    const stats = compactor.lastNanoArchive!
    expect(stats.gate).toBe('open')
    expect(stats.archived).toBe(archivedIds(out).length)
    // The reclaim is the priced difference (each archived block costs the
    // placeholder's 45 tokens in the shipped copy).
    expect(stats.reclaimed).toBe(wirePrice(messages) - wirePrice(out))
    expect(out.length).toBe(messages.length)
  })

  it('open but deferred under the floor ⇒ gate reads open with archived 0', () => {
    // The distinction the log must keep: "the gate opened and chose not to
    // pay a break" is not the same signal as "the gate never opened".
    const messages = rounds(21, 'read', 100)
    ;(messages[1].contentBlocks[0] as { content: string }).content = '果'.repeat(1_000)
    const compactor = newCompactor()
    compactor.nanoCompact(messages, WINDOW, WINDOW * FIT_GATE_USED_RATIO + 5_000)

    const stats = compactor.lastNanoArchive!
    expect(stats.gate).toBe('open')
    expect(stats.archived).toBe(0)
  })

  it('no window ⇒ legacy, not "closed" (the quota walk has no gate at all)', () => {
    const messages = rounds(20, 'exec', 1_500)
    const compactor = newCompactor()
    compactor.nanoCompact(messages)

    const stats = compactor.lastNanoArchive!
    expect(stats.gate).toBe('legacy')
    expect(stats.used).toBe(0)
    expect(stats.target).toBe(0)
    expect(stats.archived).toBeGreaterThan(0)
  })

  it('the record follows the pass: a shut gate after an open one reports the shut one', () => {
    // Same compactor, two copies — this is also what the prewarm simulation
    // does to the field between requests.
    const compactor = newCompactor()
    compactor.nanoCompact(rounds(40, 'read', 1_500), WINDOW, 5_000)
    expect(compactor.lastNanoArchive!.gate).toBe('open')

    const small = rounds(3, 'read', 100)
    compactor.nanoCompact(small, WINDOW, 1_000)
    expect(compactor.lastNanoArchive!.gate).toBe('closed')
    expect(compactor.lastNanoArchive!.archived).toBe(0)
  })

  it('the engine snapshots the stats on the same tick and logs one line', () => {
    const root = join(__dirname, '..')
    const engine = readFileSync(join(root, 'src/renderer/src/agent/AgentEngine.ts'), 'utf8')
    // Read immediately after the pass, before light/hard/emergency can run any
    // further nanoCompact (prewarm's simulation writes the same field).
    expect(engine).toContain('const nanoArchive = this.compactor.lastNanoArchive')
    expect(engine.indexOf('const nanoArchive = this.compactor.lastNanoArchive'))
      .toBeLessThan(engine.indexOf('lightCompact(thinkingStripped'))
    // The line carries the gate's inputs and verdict plus this request's cuts.
    expect(engine).toContain('[AgentEngine] fit-gate used=')
    for (const field of ['gate=', 'archived=', 'target=', 'light=', 'hard=', '→ ~']) {
      expect(engine).toContain(field)
    }
    // light's counter is reset per pass, so a no-op request cannot report the
    // previous one's cut.
    const compactor = readFileSync(join(root, 'src/renderer/src/agent/engine/context-compactor.ts'), 'utf8')
    expect(compactor).toContain('this.lastLightDropRounds = 0')
  })
})

/** Wire-anchored usage the gate reads, in the compactor's own units. */
function usedOf(compactor: ContextCompactor, messages: AgentMessage[], overhead: number): number {
  return compactor.contextTokens(messages, overhead)
}
