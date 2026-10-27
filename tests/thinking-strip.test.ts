// 旧回合 thinking 剥离（2026-10-25，conv_20261025172138「飞行棋」88% 复盘钉死）。
// OpenAIAdapter 把历史里所有 thinking 块无条件映射回 reasoning_content，网关按
// input 计费：一个 18.6K-token 的推理回合在下一次请求里原样变成 +19.7K prompt，
// 并且从此每个请求都随行。两家 provider 的契约都只需要当前回合的推理（DeepSeek
// 思考模式工具循环内回传；Anthropic 活循环里带 signature 的块），所以规则是：
//   锚点 = 最后一条带正文的用户消息；锚点之前的 assistant 消息剥掉 thinking，
//   之后的一根手指不碰。
// 两层落点：块级剥离在压缩器（stripStaleThinking，与 nano 同阶段，prewarm 可见，
// 50% 用量门控）；thinking-only 整轮移除在 apiMessages 派生层
// （dropStaleThinkingOnlyTurns，与 elideTodoWritePairs 并列，无条件，不进丢弃区算术）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ContextCompactor,
  THINKING_STRIP_USED_RATIO,
  dropStaleThinkingOnlyTurns,
  lastTextUserMessageIndex,
} from '../src/renderer/src/agent/engine/context-compactor'
import { estimateMessagesTokens, estimateTextTokens } from '../src/renderer/src/agent/engine/context-estimate'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-10-25T12:00:00.000Z'
const WINDOW = 100_000
let seq = 0

function user(text: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return { id: `u${++seq}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'text', text }], ...extra }
}
function collector(toolUseId: string, content = 'result'): AgentMessage {
  return { id: `c${++seq}`, role: 'user', createdAt: AT, contentBlocks: [{ type: 'tool_result', tool_use_id: toolUseId, content }] as ContentBlock[] }
}
function assistant(blocks: ContentBlock[], extra: Partial<AgentMessage> = {}): AgentMessage {
  return { id: `a${++seq}`, role: 'assistant', createdAt: AT, contentBlocks: blocks, ...extra }
}
const think = (n: number, ch = '思'): ContentBlock => ({ type: 'thinking', thinking: ch.repeat(n) })
const redacted = (): ContentBlock => ({ type: 'redacted_thinking', data: 'abc123' } as ContentBlock)
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read', input: { path: 'x' } })

function makeCompactor(messages: AgentMessage[]): ContextCompactor {
  return new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => messages })
}

/** 锚定在 WINDOW × ratio 的 inputTokens 报告，让门控按需开合。 */
function anchored(ratio: number): Partial<AgentMessage> {
  return { inputTokens: Math.round(WINDOW * ratio) }
}

describe('lastTextUserMessageIndex: the turn anchor', () => {
  it('is the newest user message carrying text; tool-result collectors do not count', () => {
    const msgs = [user('一'), assistant([text('答')]), user('二'), assistant([toolUse('t1')]), collector('t1')]
    expect(lastTextUserMessageIndex(msgs)).toBe(2)
  })
  it('is -1 when the history holds no text user message', () => {
    expect(lastTextUserMessageIndex([assistant([toolUse('t1')]), collector('t1')])).toBe(-1)
    expect(lastTextUserMessageIndex([])).toBe(-1)
  })
})

describe('dropStaleThinkingOnlyTurns: apiMessages-layer elision', () => {
  it('removes thinking-only assistant turns behind the anchor and nothing else', () => {
    const truncated = assistant([think(3000)], { outputTokens: 49_152 })
    const mixed = assistant([think(500), text('答案')])
    const toolTurn = assistant([think(200), toolUse('t1')])
    const msgs = [user('一'), truncated, mixed, toolTurn, collector('t1'), user('二'), assistant([text('ok')])]
    const out = dropStaleThinkingOnlyTurns(msgs)
    expect(out.map((m) => m.id)).toEqual(msgs.filter((m) => m !== truncated).map((m) => m.id))
    // 幸存消息保持身份
    expect(out[1]).toBe(mixed)
  })
  it('keeps the current turn\'s thinking-only message (the thinking-only retry shape)', () => {
    const live = assistant([think(3000)])
    const msgs = [user('一'), assistant([text('答')]), user('二'), live]
    expect(dropStaleThinkingOnlyTurns(msgs)).toBe(msgs)
  })
  it('is identity without an anchor and when nothing qualifies', () => {
    const noAnchor = [assistant([think(100)]), assistant([toolUse('t1')]), collector('t1')]
    expect(dropStaleThinkingOnlyTurns(noAnchor)).toBe(noAnchor)
    const clean = [user('一'), assistant([text('答')]), user('二')]
    expect(dropStaleThinkingOnlyTurns(clean)).toBe(clean)
  })
  it('leaves an assistant message with zero blocks alone (not its business)', () => {
    const empty = assistant([])
    const msgs = [user('一'), empty, user('二')]
    expect(dropStaleThinkingOnlyTurns(msgs)).toBe(msgs)
  })
})

describe('stripStaleThinking: block-level strip beside nano', () => {
  function scenario(ratio: number) {
    const oldMixed = assistant([think(1000), text('上一回合的回答')], { outputTokens: 1800 })
    const oldTool = assistant([redacted(), think(300), toolUse('t1')], { outputTokens: 400 })
    const live = assistant([think(2000), toolUse('t2')], { outputTokens: 2500, ...anchored(ratio) })
    const msgs = [user('一'), oldMixed, user('二'), oldTool, collector('t1'), user('三'), live, collector('t2')]
    return { msgs, oldMixed, oldTool, live }
  }

  it('above the gate: strips thinking + redacted_thinking behind the anchor, keeps text/tool_use, clears outputTokens', () => {
    const { msgs, oldMixed, oldTool, live } = scenario(0.8)
    const out = makeCompactor(msgs).stripStaleThinking(msgs, WINDOW)
    expect(out).not.toBe(msgs)
    expect(out.length).toBe(msgs.length)
    const m1 = out[1], m3 = out[3]
    expect(m1.contentBlocks).toEqual([text('上一回合的回答')])
    expect(m1.outputTokens).toBeUndefined()
    expect(m3.contentBlocks).toEqual([toolUse('t1')])
    expect(m3.outputTokens).toBeUndefined()
    // 原对象不被改写（API 副本契约）
    expect(oldMixed.contentBlocks.length).toBe(2)
    expect(oldTool.outputTokens).toBe(400)
    // 活循环（锚点之后）的块一字不动；它同时是报告锚点，inputTokens 扣掉其 prompt
    // 里曾含有的、现已剥除的 thinking 重量（见下面的锚点修正用例）
    expect(out[6].contentBlocks).toBe(live.contentBlocks)
    expect(out[6].outputTokens).toBe(2500)
    const strippedWeight = estimateTextTokens('思'.repeat(1000)) + estimateTextTokens('abc123') + estimateTextTokens('思'.repeat(300))
    expect(out[6].inputTokens).toBe(80_000 - strippedWeight)
    // 用户消息与收集消息保持身份
    expect(out[0]).toBe(msgs[0])
    expect(out[4]).toBe(msgs[4])
    expect(out[7]).toBe(msgs[7])
  })

  it('below the gate: identity (a short conversation never pays the turn-boundary re-bill)', () => {
    const { msgs } = scenario(THINKING_STRIP_USED_RATIO - 0.05)
    expect(makeCompactor(msgs).stripStaleThinking(msgs, WINDOW)).toBe(msgs)
  })

  it('exactly at the gate strips (>= is the line)', () => {
    const { msgs } = scenario(THINKING_STRIP_USED_RATIO)
    expect(makeCompactor(msgs).stripStaleThinking(msgs, WINDOW)).not.toBe(msgs)
  })

  it('no anchor / no contextLength: identity', () => {
    const noAnchor = [assistant([think(1000)], anchored(0.9)), collector('t1')]
    expect(makeCompactor(noAnchor).stripStaleThinking(noAnchor, WINDOW)).toBe(noAnchor)
    const { msgs } = scenario(0.9)
    expect(makeCompactor(msgs).stripStaleThinking(msgs, 0)).toBe(msgs)
  })

  it('is idempotent: a second pass over the stripped copy is identity', () => {
    const { msgs } = scenario(0.8)
    const c = makeCompactor(msgs)
    const once = c.stripStaleThinking(msgs, WINDOW)
    const twice = c.stripStaleThinking(once, WINDOW)
    expect(twice).toBe(once)
  })

  it('corrects the report anchor by the weight of thinking stripped BEFORE it, not at/after it', () => {
    // 报告在 a1 上（上一回合的最后一次请求），其 prompt 含 a0 的 thinking；a1 自己的
    // thinking 是它的输出，不在那个 prompt 里，不扣。
    const a0 = assistant([think(1000), text('x')])
    const a1 = assistant([think(500, '想'), text('y')], { inputTokens: 80_000 })
    const msgs = [user('一'), a0, user('二'), a1, user('三')]
    const out = makeCompactor(msgs).stripStaleThinking(msgs, WINDOW)
    expect(out[3].inputTokens).toBe(80_000 - estimateTextTokens('思'.repeat(1000)))
    expect(out[1].contentBlocks).toEqual([text('x')])
    expect(out[3].contentBlocks).toEqual([text('y')])
  })

  it('floors the corrected anchor at 1 so the full-heuristic guard takes over instead of a stale earlier report', () => {
    // 报告 3K < 被剥的 5K 启发式重量；门控靠 fixedOverhead 把 max-guard 抬过线
    const a0 = assistant([think(5000), text('x')])
    const a1 = assistant([text('y')], { inputTokens: 3_000 })
    const msgs = [user('一'), a0, user('二'), a1, user('三')]
    const out = makeCompactor(msgs).stripStaleThinking(msgs, WINDOW, 60_000)
    expect(out[3].inputTokens).toBe(1)
  })

  it('reports newly stripped turns once (the compaction event signal), and the prewarm pass does not consume it', () => {
    const { msgs } = scenario(0.8)
    const c = makeCompactor(msgs)
    c.stripStaleThinking(msgs, WINDOW, 0, false) // prewarm 模拟
    expect(c.lastThinkingStripNew).toBe(0)
    c.stripStaleThinking(msgs, WINDOW)
    expect(c.lastThinkingStripNew).toBe(2)
    c.stripStaleThinking(msgs, WINDOW)
    expect(c.lastThinkingStripNew).toBe(0)
    // 新一回合关闭：锚点后移，原活循环消息成为可剥 → 再报一次
    const next = [...msgs, user('四')]
    c.stripStaleThinking(next, WINDOW)
    expect(c.lastThinkingStripNew).toBe(1)
    c.clearStrippedThinkingIds()
    c.stripStaleThinking(next, WINDOW)
    expect(c.lastThinkingStripNew).toBe(3)
  })

  it('the stripped copy prices lower in the shared estimator (what light/hard then fit on)', () => {
    const { msgs } = scenario(0.8)
    const out = makeCompactor(msgs).stripStaleThinking(msgs, WINDOW)
    // 原副本：剥前消息按 outputTokens 报告独占计价（1800 + 400）；剥后报告已清，
    // 按剩余块直计 —— 差值必须体现 thinking 真的从拟合单位里消失了。
    expect(estimateMessagesTokens(out)).toBeLessThan(estimateMessagesTokens(msgs) - 1000)
  })
})

describe('wiring: both pipeline sites and the apiMessages layer carry the strip', () => {
  const engine = readFileSync(resolve(__dirname, '../src/renderer/src/agent/AgentEngine.ts'), 'utf8')
  const compactor = readFileSync(resolve(__dirname, '../src/renderer/src/agent/engine/context-compactor.ts'), 'utf8')

  it('prepareLoopRequest: apiMessages chain elides stale thinking-only turns before the copy is fixed', () => {
    expect(engine).toMatch(/const apiMessages = regroupToolResults\(elideTodoWritePairs\(dropStaleThinkingOnlyTurns\(/)
  })
  it('prepareLoopRequest: nano → stripStaleThinking → light, and light consumes the stripped copy', () => {
    expect(engine).toMatch(/const thinkingStripped = this\.compactor\.stripStaleThinking\(nanoCompacted,/)
    expect(engine).toMatch(/this\.compactor\.lightCompact\(thinkingStripped,/)
    expect(engine).toMatch(/lastThinkingStripNew > 0\) compactStrategies\.push\('thinking'\)/)
    expect(engine).toMatch(/lightCompacted\.length !== thinkingStripped\.length\) compactStrategies\.push\('light'\)/)
  })
  it('prewarmBody runs the same strip (record=false) so the simulation prices the real copy', () => {
    expect(compactor).toMatch(/const stripped = this\.stripStaleThinking\(nano, contextLength, overhead, false\)/)
    expect(compactor).toMatch(/const light = this\.lightCompact\(stripped,/)
    expect(compactor).toMatch(/const droppedCount = stripped\.length - truncated\.length/)
  })
  it('conversation reset clears the newly-stripped ledger', () => {
    expect(engine).toMatch(/this\.compactor\.clearStrippedThinkingIds\(\)/)
  })
})
