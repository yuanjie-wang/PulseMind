// wire-anchored 触发链（PLAN-cache-wire-gates，2026-11-20）。
// strip/nano/light 三门的触发输入从 contextTokensOf（max-guard 全转录启发式）
// 换到 requestTokensOf（wire 锚点 + 尾部估算），配两处防回弹（nano 归档账本、
// strip 闩锁）与 light 的比例校准。取证基线：conv_20261117170141 的 live 启发式
// 估算跑出 wire 的 2.0-2.65×（90-97K vs 35-42K），旧读数让三门从窗口三分之一处
// 起常年全开，压缩事件每 2-5 请求一次，会话命中率塌到 63%（ZCode ~90%）。
// 钉的性质：
//   1. 启发式膨胀单独不开门（nano/strip/light 三负钉——旧读数下这三条全红）；
//   2. wire 真实过线即开（锚点 >= 门线）；
//   3. nano 账本：门咬过一次后，诚实的下一请求（锚点已回落到 50% 目标）必须
//      逐字节复现占位符副本（W2 反弹的反向钉），且 fresh 计数为 0（携带 ≠ 新断）；
//   4. strip 闩锁：过线一次后永久生效；未闩上的短会话零剥；
//   5. light：scale 校准让 walk 按 wire 单位收敛（过读启发式不再按 2× 过丢）；
//   6. hard/emergency 保留保守读数（膨胀仍触发 backstop——那是它的正确方向）；
//   7. clearGateState 归零账本与闩锁（会话重置语义）。
import { describe, expect, it } from 'vitest'
import {
  ContextCompactor,
  FIT_ARCHIVE_TARGET_RATIO,
  FIT_GATE_USED_RATIO,
  THINKING_STRIP_USED_RATIO,
  type NanoArchiveStats,
} from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens, estimateTextTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const WINDOW = 100_000
const GATE = WINDOW * FIT_GATE_USED_RATIO
const TARGET = WINDOW * FIT_ARCHIVE_TARGET_RATIO
const STRIP_LINE = WINDOW * THINKING_STRIP_USED_RATIO
const AT = '2026-11-20T00:00:00.000Z'
let seq = 0

function newCompactor(messages: AgentMessage[]): ContextCompactor {
  return new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => messages })
}

/** One tool round: assistant tool_use + the user message carrying its result.
 *  '果'.repeat(n) prices at exactly n tokens (CJK ≈ 1 token/char). */
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

/** Stamp the honest wire report onto the LAST assistant message — where the
 *  real engine persists it (that round's own prompt size). */
function anchored(messages: AgentMessage[], tokens: number): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { messages[i].inputTokens = tokens; return messages }
  }
  return messages
}

const ARCHIVED_PREFIX = '⟨archived: '

function wirePrice(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') {
        const content = block.content || ''
        total += content.startsWith(ARCHIVED_PREFIX) ? 45 : estimateTextTokens(content)
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
      if (block.type === 'tool_result' && (block.content || '').startsWith(ARCHIVED_PREFIX)) ids.push(block.tool_use_id)
    }
  }
  return ids
}

// ── 思考块 fixtures（strip 用）──
const think = (chars: number): ContentBlock => ({ type: 'thinking', thinking: '思'.repeat(chars) })
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const sUser = (t: string): AgentMessage => ({ id: `su${++seq}`, role: 'user', createdAt: AT, contentBlocks: [text(t)] })
const sAssistant = (blocks: ContentBlock[], tokens?: number): AgentMessage => ({
  id: `sa${++seq}`, role: 'assistant', createdAt: AT, contentBlocks: blocks, ...(tokens != null ? { inputTokens: tokens } : {}),
})

describe('nano 的门读 wire：启发式膨胀单独不开门（负钉）', () => {
  it('a 90K-heuristic copy with a 31K wire anchor stays shut — the old max-guard reader opened it', () => {
    // 60×1.5K ≈ 90K 启发式内容；诚实 wire 只有 31.5K（锚点 30K + 尾部 1.5K）。
    // 旧读数 max(31.5K, 90K+overhead) → 门开；新读数 31.5K < 60K → 门关。
    const messages = rounds(60, 1_500)
    anchored(messages, 30_000)
    const compactor = newCompactor(messages)

    const out = compactor.nanoCompact(messages, WINDOW, 0)
    expect(out).toBe(messages)
    expect(archivedIds(out)).toEqual([])
    expect(compactor.lastNanoArchive!.gate).toBe('closed')
    expect(compactor.lastNanoArchive!.used).toBeLessThan(GATE)
  })

  it('an honest wire crossing opens the gate and bites to the target', () => {
    const messages = rounds(40, 1_500) // 60K heuristic ≈ the wire it reports
    anchored(messages, 62_000)
    const compactor = newCompactor(messages)

    const out = compactor.nanoCompact(messages, WINDOW, 0)
    expect(compactor.lastNanoArchive!.gate).toBe('open')
    expect(archivedIds(out).length).toBeGreaterThan(0)
    const candidateOrder = messages
      .filter(m => m.role === 'user')
      .map(m => (m.contentBlocks[0] as { tool_use_id: string }).tool_use_id)
    // Oldest-first prefix; the newest four tool_result messages stay whole.
    expect(candidateOrder.slice(0, archivedIds(out).length)).toEqual(archivedIds(out))
    for (const id of candidateOrder.slice(-4)) expect(archivedIds(out)).not.toContain(id)
  })

  it('the archive ledger holds the bite: a post-bite wire re-derives the SAME bytes with archived=0', () => {
    const messages = rounds(40, 1_500)
    anchored(messages, 62_000)
    const compactor = newCompactor(messages)
    const first = compactor.nanoCompact(messages, WINDOW, 0)
    expect(archivedIds(first).length).toBeGreaterThan(0)

    // 下一请求的诚实报告：wire 已落到 50% 目标附近（占位符已发货）——门关。
    // 账本必须让占位符逐字节复现；旧形态（无账本）此处会回填全文。
    anchored(messages, Math.round(wirePrice(first)))
    const second = compactor.nanoCompact(messages, WINDOW, 0)
    expect(compactor.lastNanoArchive!.gate).toBe('closed')
    expect(compactor.lastNanoArchive!.archived).toBe(0) // 携带 ≠ 新断
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(archivedIds(second)).toEqual(archivedIds(first))

    // 把占位符副本喂回去（第三请求形态）→ 引用恒等，零重铸。
    expect(compactor.nanoCompact(second, WINDOW, 0)).toBe(second)
  })

  it('clearGateState empties the ledger: the gate re-derives from scratch', () => {
    const messages = rounds(40, 1_500)
    anchored(messages, 62_000)
    const compactor = newCompactor(messages)
    const first = compactor.nanoCompact(messages, WINDOW, 0)
    expect(archivedIds(first).length).toBeGreaterThan(0)

    compactor.clearGateState()
    anchored(messages, Math.round(wirePrice(first)))
    const second = compactor.nanoCompact(messages, WINDOW, 0)
    // 账本清空 + 门关 → 计划为空 → 占位符消失（回填全文）。会话重置语义：
    // 旧历史的账本不能命名新历史。
    expect(archivedIds(second)).toEqual([])
    expect(wirePrice(second)).toBe(wirePrice(messages))
  })
})

describe('strip 的门读 wire 且闩锁', () => {
  it('below the line a short conversation is never stripped', () => {
    const messages = [sUser('一'), sAssistant([think(1_000), text('x')], 10_000), sUser('二')]
    const compactor = newCompactor(messages)
    expect(compactor.stripStaleThinking(messages, WINDOW)).toBe(messages)
    expect(compactor.lastThinkingStripNew).toBe(0)
  })

  it('an honest crossing strips and LATCHES: below-the-line copies keep stripping afterwards', () => {
    const messages = [sUser('一'), sAssistant([think(1_000), text('x')], STRIP_LINE), sUser('二')]
    const compactor = newCompactor(messages)
    const out = compactor.stripStaleThinking(messages, WINDOW)
    expect(out[1].contentBlocks).toEqual([text('x')])

    // 闩上之后，一条低于门线的新副本（压缩后的会话形态）也照剥——
    // 不闩锁的门在这里会关上、让 thinking 回填、下一轮再剥（每请求翻一次前缀）。
    const small: AgentMessage[] = [sUser('三'), sAssistant([think(2_000), text('y')], 5_000), sUser('四')]
    const out2 = compactor.stripStaleThinking(small, WINDOW)
    expect(out2[1].contentBlocks).toEqual([text('y')])
  })

  it('a fresh compactor with the same below-line copy stays shut (the latch is per-conversation)', () => {
    const small: AgentMessage[] = [sUser('三'), sAssistant([think(2_000), text('y')], 5_000), sUser('四')]
    expect(newCompactor(small).stripStaleThinking(small, WINDOW)).toBe(small)
  })
})

describe('light 的门读 wire 且 walk 按 scale 收敛', () => {
  it('a 90K-heuristic copy with a 31K wire anchor does not drop — the old reader dropped it', () => {
    const messages = rounds(60, 1_500)
    anchored(messages, 30_000)
    const compactor = newCompactor(messages)
    expect(compactor.lightCompact(messages, WINDOW, 0)).toBe(messages)
  })

  it('an honest crossing drops in WIRE units: an over-reading heuristic must not over-drop', () => {
    // 启发式 ~90.6K，诚实 wire 75K（过线 70K），scale ≈ 0.83。
    // fits 用 (totalH − droppedH) × scale ≤ 58K 收敛 → 保留 ~69-71K 启发式；
    // 未校准形态会一路丢到 58K 启发式——这里用 >65K 钉住校准生效。
    const messages = rounds(60, 1_500)
    anchored(messages, 75_000)
    const compactor = newCompactor(messages)
    const out = compactor.lightCompact(messages, WINDOW, 0)
    expect(out.length).toBeLessThan(messages.length)
    const keptH = estimateMessagesTokens(out)
    // light 的目标（区别于 nano 的 TARGET 常数）：100K − 30K(headroom) − 12K(margin) = 58K。
    // 未校准形态会把启发式 kept 一路丢到 ~59.5K；校准后收敛在 ~67-70K。
    expect(keptH).toBeGreaterThan(65_000)
    expect(keptH).toBeLessThanOrEqual(71_000)
  })
})

describe('hard 保留保守读数（backstop 的膨胀是正确方向）', () => {
  it('the same inflated copy the honest gates ignore still arms hardTruncate', () => {
    const messages = rounds(60, 1_500)
    anchored(messages, 30_000)
    const compactor = newCompactor(messages)
    const out = compactor.hardTruncate(messages, WINDOW, 0)
    expect(out.length).toBeLessThan(messages.length)
  })
})

describe('stats 与工具带的接线', () => {
  it('NanoArchiveStats.used reads the wire, and carried passes report fresh=0', () => {
    const messages = rounds(40, 1_500)
    anchored(messages, 62_000)
    const compactor = newCompactor(messages)
    compactor.nanoCompact(messages, WINDOW, 0)
    const first: NanoArchiveStats = compactor.lastNanoArchive!
    expect(first.used).toBeGreaterThanOrEqual(GATE)

    anchored(messages, Math.round(TARGET))
    compactor.nanoCompact(messages, WINDOW, 0)
    expect(compactor.lastNanoArchive!.archived).toBe(0)
    expect(compactor.lastNanoArchive!.reclaimed).toBe(0)
  })
})
