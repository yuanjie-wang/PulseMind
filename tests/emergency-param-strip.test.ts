// ── review_20261028 中4：emergencyTruncate 阶段 2c——tool_use 巨型字符串参数摘除 ──
// TOOL_PARAM_LIMITS 允许 write.content 单次 500K 字符进历史；一旦这样的块落进
// 保护窗，nano（只压 tool_result）/ light（只删整周期）/ emergency 阶段 2（只压
// tool_result）/ 2b（只删 thinking）全都碰不到它——之后每个请求必然 400，会话
// 卡死在该轮。阶段 2c 把超长 STRING 值截短：键与小值保住可读性、tool_use_id
// 保住配对、字符串截短不破坏 JSON 结构。真 API 副本契约：this.messages 永不动。
import { describe, expect, it } from 'vitest'

const { ContextCompactor } = await import('../src/renderer/src/agent/engine/context-compactor')
import type { AgentMessage, ToolUseBlock } from '../src/renderer/src/types/agent'

const NOW = '2026-10-29T10:00:00.000Z'

function writeCall(id: string, filePath: string, content: string): ToolUseBlock {
  return { type: 'tool_use', id, name: 'write', input: { file_path: filePath, append: false, content }, status: 'completed' }
}

function makeCompactor() {
  return new ContextCompactor({ runHistorySummary: async () => '', getMessages: () => [] })
}

describe('emergencyTruncate phase 2c: giant tool_use string params', () => {
  it('elides an oversized string param — keys, small values and pairing survive', () => {
    const compactor = makeCompactor()
    const big = 'x'.repeat(100_000)
    const call = writeCall('tu_1', '/big.txt', big)
    const messages: AgentMessage[] = [
      { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [call] },
      { id: 'u1', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'done' }] },
    ]
    // ~25K estimated tokens vs a 10K provider window (target 6K): no
    // tool_results for phase 2, no thinking for 2b — 2c is the only layer.
    const out = compactor.emergencyTruncate(messages, 10_000, 0)
    const outCall = out[0].contentBlocks[0] as ToolUseBlock
    expect(outCall.id).toBe('tu_1')
    expect(outCall.name).toBe('write')
    expect(outCall.input.file_path).toBe('/big.txt')
    expect(outCall.input.append).toBe(false)
    const elided = outCall.input.content as string
    expect(elided.length).toBeLessThan(big.length)
    expect(elided.startsWith('x'.repeat(100))).toBe(true)
    expect(elided).toContain('上下文超限')
    // API-copy contract: the live message is untouched.
    expect((messages[0].contentBlocks[0] as ToolUseBlock).input.content).toBe(big)
  })

  it('strips until the estimate fits — every candidate goes when the window demands it', () => {
    const compactor = makeCompactor()
    const messages: AgentMessage[] = [
      { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [writeCall('tu_1', '/a.txt', 'a'.repeat(100_000))] },
      { id: 'u1', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'ok' }] },
      { id: 'a2', role: 'assistant', createdAt: NOW, contentBlocks: [writeCall('tu_2', '/b.txt', 'b'.repeat(100_000))] },
      { id: 'u2', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'done' }] },
    ]
    const out = compactor.emergencyTruncate(messages, 10_000, 0)
    // Two giant params ≈ 50K tokens cannot fit a 6K target with one elision.
    for (const [i, id] of [['tu_1'], ['tu_2']].entries()) {
      const call = out[i * 2].contentBlocks[0] as ToolUseBlock
      expect(call.id).toBe(id[0])
      expect((call.input.content as string).length).toBeLessThan(5_000)
    }
    expect(out.every(m => m.contentBlocks.length > 0)).toBe(true)
  })

  it('a param under the threshold is never touched, even when over target', () => {
    const compactor = makeCompactor()
    // ~19.9K chars ≈ 5K tokens: over a 6K-token target alongside the rest,
    // but under OVERFLOW_TOOL_PARAM_CHARS — not the elision candidate shape,
    // and nothing else can strip it, so the verbatim param comes back.
    const big = 'y'.repeat(19_900)
    const call = writeCall('tu_1', '/mid.txt', big)
    const messages: AgentMessage[] = [
      { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [call] },
      { id: 'u1', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'ok '.repeat(3_000) }] },
    ]
    const out = compactor.emergencyTruncate(messages, 10_000, 0)
    expect((out[0].contentBlocks[0] as ToolUseBlock).input.content).toBe(big)
  })

  it('no emergency, no touch — the early return keeps the array identity', () => {
    const compactor = makeCompactor()
    const call = writeCall('tu_1', '/big.txt', 'z'.repeat(100_000))
    const messages: AgentMessage[] = [
      { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [call] },
      { id: 'u1', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'done' }] },
    ]
    expect(compactor.emergencyTruncate(messages, 1_000_000, 0)).toBe(messages)
  })

  it('non-string params (arrays/objects/numbers) are structurally out of scope', () => {
    const compactor = makeCompactor()
    const ops = [{ op: 'replace_text', find: 'a'.repeat(50_000) }]
    const call: ToolUseBlock = { type: 'tool_use', id: 'tu_1', name: 'office_edit', input: { file_path: '/f.docx', ops }, status: 'completed' }
    const messages: AgentMessage[] = [
      { id: 'a1', role: 'assistant', createdAt: NOW, contentBlocks: [call] },
      { id: 'u1', role: 'user', createdAt: NOW, contentBlocks: [{ type: 'text', text: 'done' }] },
    ]
    const out = compactor.emergencyTruncate(messages, 10_000, 0)
    const outCall = out[0].contentBlocks[0] as ToolUseBlock
    // The ops ARRAY is untouched: phase 2c trims string VALUES only — a
    // stringified-array elision would break the executor's shape contract.
    expect(outCall.input.ops).toBe(ops)
  })
})
