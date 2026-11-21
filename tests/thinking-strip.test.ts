// 旧回合 thinking 剥离（2026-10-25，conv_20261025172138「飞行棋」88% 复盘钉死；
// 2026-11-21 随 epoch 重写：用量门与「新剥账本」退役，剥离成为切割的第 3 步）。
// OpenAIAdapter 把历史里所有 thinking 块无条件映射回 reasoning_content，网关按
// input 计费：一个 18.6K-token 的推理回合在下一次请求里原样变成 +19.7K prompt，
// 并且从此每个请求都随行。两家 provider 的契约都只需要当前回合的推理（DeepSeek
// 思考模式工具循环内回传；Anthropic 活循环里带 signature 的块），所以规则是：
//   锚点 = 最后一条带正文的用户消息；锚点之前的 assistant 消息剥掉 thinking，
//   之后的一根手指不碰。
// 两层落点：块级剥离在压缩器（stripStaleThinking，directCut 的第 3 步，与
// nano/light 同一次头移动，因此无条件、无闩锁、无账本）；thinking-only 整轮移除
// 在 apiMessages 派生层（dropStaleThinkingOnlyTurns，与 elideTodoWritePairs
// 并列，由 assembleCopy 的结构楔子每次组装时重推导）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ContextCompactor,
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

/** 一个报告锚点：inputTokens 就是那个请求的 prompt 读数。 */
function report(tokens: number): Partial<AgentMessage> {
  return { inputTokens: tokens }
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

describe('stripStaleThinking: block-level strip, step 3 of a cut', () => {
  function scenario() {
    const oldMixed = assistant([think(1000), text('上一回合的回答')], { outputTokens: 1800 })
    const oldTool = assistant([redacted(), think(300), toolUse('t1')], { outputTokens: 400 })
    const live = assistant([think(2000), toolUse('t2')], { outputTokens: 2500, ...report(80_000) })
    const msgs = [user('一'), oldMixed, user('二'), oldTool, collector('t1'), user('三'), live, collector('t2')]
    return { msgs, oldMixed, oldTool, live }
  }

  it('strips thinking + redacted_thinking behind the anchor, keeps text/tool_use, clears outputTokens', () => {
    const { msgs, oldMixed, oldTool, live } = scenario()
    const out = makeCompactor(msgs).stripStaleThinking(msgs)
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

  it('needs no usage reading: a transcript with zero reports still strips', () => {
    // 门退役的直接证据——旧形态在「没有 inputTokens 报告」时读不到用量，
    // 短会话一律恒等；切割既然已经决定动手，剥离就无条件执行。
    const old = assistant([think(1_000), text('旧回答')])
    const msgs = [user('一'), old, user('二'), assistant([text('新回答')])]
    const out = makeCompactor(msgs).stripStaleThinking(msgs)
    expect(out).not.toBe(msgs)
    expect(out[1].contentBlocks).toEqual([text('旧回答')])
  })

  it('is arity 1 and stateless — no window, no ledger, no latch', () => {
    const { msgs } = scenario()
    const c = makeCompactor(msgs)
    expect(c.stripStaleThinking.length).toBe(1)
    const first = c.stripStaleThinking(msgs)
    const second = makeCompactor(msgs).stripStaleThinking(msgs)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // 无账本可清：同一份输入再剥一次得到同一份输出，而不是「已剥过就恒等」
    expect(JSON.stringify(c.stripStaleThinking(msgs))).toBe(JSON.stringify(first))
  })

  it('no anchor: identity', () => {
    const noAnchor = [assistant([think(1000)], report(90_000)), collector('t1')]
    expect(makeCompactor(noAnchor).stripStaleThinking(noAnchor)).toBe(noAnchor)
  })

  it('is idempotent: a second pass over the stripped copy is identity', () => {
    const { msgs } = scenario()
    const c = makeCompactor(msgs)
    const once = c.stripStaleThinking(msgs)
    expect(c.stripStaleThinking(once)).toBe(once)
  })

  it('corrects the report anchor by the weight of thinking stripped BEFORE it, not at/after it', () => {
    // 报告在 a1 上（上一回合的最后一次请求），其 prompt 含 a0 的 thinking；a1 自己的
    // thinking 是它的输出，不在那个 prompt 里，不扣。
    const a0 = assistant([think(1000), text('x')])
    const a1 = assistant([think(500, '想'), text('y')], report(80_000))
    const msgs = [user('一'), a0, user('二'), a1, user('三')]
    const out = makeCompactor(msgs).stripStaleThinking(msgs)
    expect(out[3].inputTokens).toBe(80_000 - estimateTextTokens('思'.repeat(1000)))
    expect(out[1].contentBlocks).toEqual([text('x')])
    expect(out[3].contentBlocks).toEqual([text('y')])
  })

  it('floors the corrected anchor at 1 instead of letting it go negative', () => {
    // 报告读数小于被剥的启发式重量：修正落地时钳到 1 而不是负数。
    const a0 = assistant([think(WINDOW / 2 + 1_000), text('x')])
    const a1 = assistant([text('y')], report(WINDOW / 2))
    const msgs = [user('一'), a0, user('二'), a1, user('三')]
    const out = makeCompactor(msgs).stripStaleThinking(msgs)
    expect(out[3].inputTokens).toBe(1)
  })

  it('the stripped copy prices lower in the shared estimator (what light/hard then fit on)', () => {
    const { msgs } = scenario()
    const out = makeCompactor(msgs).stripStaleThinking(msgs)
    // 原副本：剥前消息按 outputTokens 报告独占计价（1800 + 400）；剥后报告已清，
    // 按剩余块直计 —— 差值必须体现 thinking 真的从拟合单位里消失了。
    expect(estimateMessagesTokens(out)).toBeLessThan(estimateMessagesTokens(msgs) - 1000)
  })
})

describe('wiring: the strip rides inside directCut and nowhere else', () => {
  const engine = readFileSync(resolve(__dirname, '../src/renderer/src/agent/AgentEngine.ts'), 'utf8')
  const compactor = readFileSync(resolve(__dirname, '../src/renderer/src/agent/engine/context-compactor.ts'), 'utf8')

  it('directCut runs it between nano and light, and only when still over the step target', () => {
    expect(compactor).toMatch(/if \(this\.copyTokens\(working, overhead\) > stepTarget\) \{\n\s+const stripped = this\.stripStaleThinking\(working\)/)
    expect(compactor).toMatch(/if \(stripped !== working\) strategies\.push\('thinking'\)/)
  })

  it('the engine never strips on its own — one cut, one head move', () => {
    expect(engine).not.toContain('stripStaleThinking(')
  })

  it('apiMessages is the assembled copy, whose wedge elides stale thinking-only turns', () => {
    expect(engine).toContain('const apiMessages = this.compactor.assembleCopy()')
    expect(compactor).toMatch(/elideTodoWritePairs\(dropStaleThinkingOnlyTurns\(/)
  })

  it('the retired usage gate and the stripped-id ledger are gone', () => {
    for (const src of [engine, compactor]) {
      expect(src).not.toContain('THINKING_STRIP_USED_RATIO')
      expect(src).not.toContain('clearStrippedThinkingIds')
      expect(src).not.toContain('lastThinkingStripNew')
      expect(src).not.toContain('thinkingStripLatched')
    }
  })
})
