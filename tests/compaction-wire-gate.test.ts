// 执行器只吃「步长」，不再有门（PLAN-compaction-epoch，2026-11-21）。
//
// 2026-11-20 的四门（strip/nano/light/hard 各自的比例门，配 nano 归档账本与
// strip 闩锁）随「单决策点 + 冻结 epoch」一起退役：`directCut` 已经决定「要
// 切」，执行器只负责「切到哪个目标」。于是本文件钉的性质整个换向：
//   1. 唯一谓词是调用方给的 target —— `inputTokens` wire 锚点零投票（两副本
//      只在锚点上不同，结果逐字节相同；锚点既不能开门也不能关门）；
//   2. `NanoArchiveStats` 不再有 `gate` 字段（used/archived/reclaimed/target）；
//   3. `stripStaleThinking` 无窗口参数、无闩锁、无状态 —— 短会话照剥，fresh
//      compactor 给同一结果，活回合的 thinking 保留；
//   4. light 按副本单位（copyTokens）收敛，不再按 2× 膨胀的启发式过丢；
//   5. `contextTokensOf` 只服务 backstop：provider-400 的膨胀读数仍能武装
//      emergencyTruncate，而触发链里没有它（也没有 requestTokensOf）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContextCompactor, type NanoArchiveStats } from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const AT = '2026-11-21T00:00:00.000Z'
let seq = 0

function newCompactor(messages: AgentMessage[]): ContextCompactor {
  return new ContextCompactor({ runHistorySummary: async () => '摘要', getMessages: () => messages })
}

/** One tool round: assistant tool_use + the user message carrying its result.
 *  '果'.repeat(n) prices at exactly n tokens (CJK ≈ 1 token/char).
 *  `tool_result_id` is pre-stamped the way the DB roundtrip delivers it: the
 *  placeholder glyph reuses that id instead of minting a fresh uuid, so two
 *  independent materializations of the same copy are byte-identical. */
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
      contentBlocks: [
        { type: 'tool_result', tool_use_id: id, tool_result_id: `tr${n}`, content: '果'.repeat(chars) },
      ] as ContentBlock[],
    },
  ]
}

function rounds(count: number, chars: number): AgentMessage[] {
  const out: AgentMessage[] = []
  for (let i = 0; i < count; i++) out.push(...round(chars))
  return out
}

/** Stamp a wire report onto the last assistant message — where the real engine
 *  persists it. Under the epoch contract this must have NO effect on any
 *  executor's decision (only `contextTokensOf`'s backstop reads it). */
function anchored(messages: AgentMessage[], tokens: number): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { messages[i].inputTokens = tokens; return messages }
  }
  return messages
}

const ARCHIVED_PREFIX = '⟨archived: '

function archivedIds(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && (block.content || '').startsWith(ARCHIVED_PREFIX)) ids.push(block.tool_use_id)
    }
  }
  return ids
}

function toolResultIds(messages: AgentMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result') ids.push(block.tool_use_id)
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

describe('执行器没有门：唯一谓词是调用方给的目标', () => {
  it('a target above the copy price is a no-op — identity, nothing archived', () => {
    const messages = rounds(20, 1_000) // ≈ 20,040 副本价
    const compactor = newCompactor(messages)

    expect(compactor.nanoCompact(messages, 100_000, 0)).toBe(messages)
    expect(archivedIds(messages)).toEqual([])
    expect(compactor.lastNanoArchive!.archived).toBe(0)
    expect(compactor.lastNanoArchive!.target).toBe(100_000)
  })

  it('the wire anchor has no vote: same content, wildly different inputTokens → byte-identical cut', () => {
    // 旧门的读数器会把 30K 锚点读成「门关」而把 62K 读成「门开」；epoch 下
    // 两者都只看副本价（≈90K），因此必须逐字节相同。锚点既不能开门也不能关门。
    const low = anchored(rounds(60, 1_500), 30_000)
    const high = anchored(structuredClone(low), 62_000)
    const cLow = newCompactor(low)
    const cHigh = newCompactor(high)

    const outLow = cLow.nanoCompact(low, 60_000, 0)
    const outHigh = cHigh.nanoCompact(high, 60_000, 0)

    expect(archivedIds(outLow).length).toBeGreaterThan(0)
    // 锚点本身当然还挂在消息上（它是转录事实），决策与内容必须一模一样。
    const norm = (ms: AgentMessage[]): string =>
      JSON.stringify(ms.map((m) => ({ ...m, inputTokens: undefined })))
    expect(norm(outLow)).toBe(norm(outHigh))
    expect(archivedIds(outLow)).toEqual(archivedIds(outHigh))
    expect(cLow.lastNanoArchive).toEqual(cHigh.lastNanoArchive)
  })

  it('a target below the price archives oldest-first and protects the newest rounds', () => {
    const messages = rounds(40, 1_500)
    const compactor = newCompactor(messages)

    const out = compactor.nanoCompact(messages, 60_000, 0)
    const order = toolResultIds(messages)
    const archived = archivedIds(out)
    expect(archived.length).toBeGreaterThan(0)
    expect(order.slice(0, archived.length)).toEqual(archived)
    // 最近四个 tool_result 整段保留（NANO_PROTECTION_WINDOW）。
    for (const id of order.slice(-4)) expect(archived).not.toContain(id)
  })

  it('NanoArchiveStats carries no gate field — the decision moved out of the executor', () => {
    const messages = rounds(40, 1_500)
    const compactor = newCompactor(messages)
    compactor.nanoCompact(messages, 60_000, 0)
    const stats: NanoArchiveStats = compactor.lastNanoArchive!
    expect(Object.keys(stats).sort()).toEqual(['archived', 'reclaimed', 'target', 'used'])
    expect('gate' in stats).toBe(false)
  })
})

describe('stripStaleThinking 无条件且无状态', () => {
  it('takes no window: a short below-any-line conversation still strips', () => {
    const messages = [sUser('一'), sAssistant([think(1_000), text('x')], 10_000), sUser('二')]
    const compactor = newCompactor(messages)
    // 无窗口参数是契约本身：切割已经决定要切，剥多少由调用方给的范围定。
    expect(compactor.stripStaleThinking.length).toBe(1)

    const out = compactor.stripStaleThinking(messages)
    expect(out[1].contentBlocks).toEqual([text('x')])
  })

  it('is stateless: a fresh compactor produces the same output, and a second pass is identity', () => {
    const messages = [sUser('一'), sAssistant([think(1_000), text('x')], 10_000), sUser('二')]
    const first = newCompactor(messages).stripStaleThinking(messages)
    const second = newCompactor(messages).stripStaleThinking(messages)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // 无闩锁可振荡：已剥过的副本再剥一次是引用恒等，而不是「回填再剥」。
    expect(newCompactor(messages).stripStaleThinking(first)).toBe(first)
  })

  it('leaves the live turn alone: thinking after the turn anchor survives', () => {
    const messages = [sUser('一'), sAssistant([think(1_000), text('x')])]
    expect(newCompactor(messages).stripStaleThinking(messages)).toBe(messages)
  })
})

describe('light 按副本单位收敛', () => {
  it('a copy already under the target is identity', () => {
    const messages = rounds(20, 1_000)
    expect(newCompactor(messages).lightCompact(messages, 100_000, 0)).toBe(messages)
  })

  it('drops whole old cycles until the copy fits, and stops there', () => {
    const messages = rounds(60, 1_500) // 副本价 90,120
    const compactor = newCompactor(messages)
    const out = compactor.lightCompact(messages, 60_000, 0)

    expect(out.length).toBeLessThan(messages.length)
    const price = compactor.copyTokens(out, 0)
    expect(price).toBeLessThanOrEqual(60_000)
    // 整周期粒度（1,502/轮）：落在目标下方一轮之内，不按膨胀启发式过丢。
    expect(price).toBeGreaterThan(57_000)
  })
})

describe('hard 与 emergency 的分工', () => {
  it('hardTruncate is a step, not a gate: identity when the copy fits', () => {
    const messages = rounds(20, 1_000)
    expect(newCompactor(messages).hardTruncate(messages, 100_000, 0)).toBe(messages)
  })

  it('hardTruncate drops the oldest prefix toward a named target', () => {
    const messages = rounds(60, 1_500)
    const compactor = newCompactor(messages)
    const out = compactor.hardTruncate(messages, 60_000, 0)
    expect(out.length).toBeLessThan(messages.length)
    expect(compactor.copyTokens(out, 0)).toBeLessThanOrEqual(60_000)
  })

  it('the conservative reader survives only as the provider-400 backstop', () => {
    // 一副本价只有 ~10K 的小转录，被一条 200K 的 wire 锚点武装：
    // 触发链（copyTokens）看不见任何压力，backstop（contextTokensOf 的
    // max-guard）必须照样动手——这就是 provider-400 之后那道保险的形状。
    const messages = anchored(rounds(10, 1_000), 200_000)
    const compactor = newCompactor(messages)
    expect(compactor.copyTokens(messages, 0)).toBeLessThan(30_000)

    const out = compactor.emergencyTruncate(messages, 50_000, 0)
    expect(out).not.toBe(messages)
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(messages).length)
  })
})

describe('接线：触发链里没有保守读数', () => {
  const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')
  const engine = read('src/renderer/src/agent/AgentEngine.ts')
  const compactor = read('src/renderer/src/agent/engine/context-compactor.ts')

  it('the engine prices the copy and never the transcript-pressure reader', () => {
    expect(engine).toContain('copyTokens(')
    expect(engine).not.toContain('requestTokensOf')
    expect(engine).not.toMatch(/contextTokens\s*\(/)
  })

  it('the compactor reads contextTokens only inside the emergency backstop', () => {
    // 两个调用点（初次估算 + phase 2 的循环读数）都在 emergencyTruncate 体内。
    const calls = compactor.match(/this\.contextTokens\(/g) ?? []
    expect(calls.length).toBe(2)
    const body = compactor.slice(compactor.indexOf('emergencyTruncate('))
    expect(body).toContain('this.contextTokens(')
    expect(compactor.slice(0, compactor.indexOf('emergencyTruncate('))).not.toContain('this.contextTokens(')
  })
})
