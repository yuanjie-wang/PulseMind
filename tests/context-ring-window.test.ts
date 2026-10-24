// composer 上下文圆环的分母必须跟「会话实际在用的模型」走，而不是全局默认
// 模型。2026-10-18 用户报告：正在用模型 A，改了默认模型 B 的上下文长度，A
// 会话的刻度当场跳变 —— 旧实现直接拿 activeProfile（默认模型）的
// contextLength 画圆环，且默认模型没设该字段时回落到 profiles[0]（又一个
// 不相干模型的窗口）。解析链镜像主进程 resolveProfile；末级回落 128_000 与
// 引擎一致（AgentEngine 的 `contextLength || 128_000`）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveContextWindow } from '../src/renderer/src/utils/context-window'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const profiles = [
  { id: 'a', contextLength: 128_000 },
  { id: 'b', contextLength: 32_000 },
  { id: 'c' }, // 没设 contextLength —— 引擎按 128_000 跑
]

describe('resolveContextWindow', () => {
  it('钉了模型 A 的会话用 A 的窗口，默认模型 B 的值不参与', () => {
    expect(resolveContextWindow(profiles, 'a', 'b')).toBe(128_000)
  })

  it('跟随默认的会话用默认模型的窗口', () => {
    expect(resolveContextWindow(profiles, undefined, 'b')).toBe(32_000)
    expect(resolveContextWindow(profiles, 'b', 'b')).toBe(32_000)
  })

  it('会话的模型已被删除时回落到默认模型（镜像 resolveProfile 的链）', () => {
    expect(resolveContextWindow(profiles, 'deleted', 'b')).toBe(32_000)
  })

  it('默认也不在时回落第一个条目（resolveProfile 的最后一级）', () => {
    expect(resolveContextWindow(profiles, 'x', 'y')).toBe(128_000)
  })

  it('命中的模型没设 contextLength 时回落 128_000，绝不拿别的模型顶数', () => {
    expect(resolveContextWindow(profiles, 'c', 'b')).toBe(128_000)
  })

  it('空 profiles 回落 128_000', () => {
    expect(resolveContextWindow([], undefined, undefined)).toBe(128_000)
  })
})

// 接线钉：App 必须把按会话解析的窗口值传给 ChatView（welcome 与会话内两个
// composer 共用这个 prop）。回退成裸 contextLength（默认模型的值）即回归。
describe('context ring wiring', () => {
  const app = read('src', 'renderer', 'src', 'App.tsx')

  it('ChatView 的 contextLength prop 来自 displayContextLength', () => {
    expect(app).toContain('contextLength={displayContextLength}')
    // 2026-10-24 harness review B8: the profile-derived value is the BASE — the
    // session-reported overflow re-aim (provider-named window riding the
    // retrying status) clamps it down via Math.min before it reaches the ring.
    expect(app).toMatch(/profileContextLength = resolveContextWindow\(/)
    expect(app).toMatch(/Math\.min\(profileContextLength, pinnedSessionWindow\.window\)/)
  })
})

// 圆环分子的 nano 折算（2026-10-24）：尾段的旧工具结果在下一请求会变成
// [tool_result_id:] 占位符，按原文计价恒高估恰好这份额——工具密集批把圆环
// 钉在 79–96% 而 wire 实载 ~60%（conv_20261021155951）。estimateAfterNanoTokens
// 镜像 nanoCompact 的决策（保护窗 + 层配额 + 占位符计价），尾段局部计算：
// 幼尾（配额不满）按原文计价 = 旧行为，只有马拉松尾才折算。
import { estimateAfterNanoTokens } from '../src/renderer/src/agent/engine/context-compactor'
import { estimateContextUsed, projectContextUsed } from '../src/renderer/src/components/chat/ContextRing'
import type { AgentMessage } from '../src/renderer/src/types/agent'
import type { CompactionEvent } from '../src/shared/agent-protocol'

const T0 = 1_792_000_000_000

function cycleMsgs(rounds: number, resultText: string): AgentMessage[] {
  const msgs: AgentMessage[] = []
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      id: `a${i}`, role: 'assistant', createdAt: new Date(T0 + i * 1000).toISOString(),
      contentBlocks: [{ type: 'tool_use', id: `tu${i}`, name: 'exec', input: { command: 'ls' }, status: 'completed' }],
    })
    msgs.push({
      id: `c${i}`, role: 'user', createdAt: new Date(T0 + i * 1000 + 1).toISOString(),
      contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: resultText, is_error: false }],
    })
  }
  return msgs
}

describe('estimateAfterNanoTokens（nano 决策的确定性镜像）', () => {
  it('马拉松尾：配额内的旧结果折算成占位符价——远低于原文计价', () => {
    const big = '核查通过。条款索引与原文一致。'.repeat(200) // ~2.8K tokens/条
    const msgs = cycleMsgs(50, big) // tier1(exec)=50 → fullTiers=5 → 压 40 条
    const after = estimateAfterNanoTokens(msgs)
    // 原文计价 ≈ 50×2.8K ≈ 140K；折算 ≈ 40×45 + 10×2.8K ≈ 30K。比值断言
    // 钉语义：折算价必须远小于原文价（这正是圆环高估的份额）。
    expect(after).toBeLessThan(35_000)
    expect(after).toBeGreaterThan(25_000) // 留存的整价份额在场，不是清仓
  })

  it('幼尾：配额不满 → 一律原文计价（昨天的行为，绝不低读）', () => {
    const big = '核查通过。'.repeat(200)
    const msgs = cycleMsgs(10, big) // tier1=10 < 2×10 → 无配额
    const perResult = 200 * 5 // '核查通过。'=5 字 ×200
    expect(estimateAfterNanoTokens(msgs)).toBeGreaterThan(10 * perResult * 0.8)
    expect(estimateAfterNanoTokens(msgs)).toBeLessThan(10 * perResult * 1.2)
  })
})

describe('estimateContextUsed / projectContextUsed 尾段折算', () => {
  it('锚点后的马拉松尾按折算计价：圆环不再把批内工具结果当全文', () => {
    const anchor: AgentMessage = {
      id: 'anchor', role: 'assistant', createdAt: new Date(T0).toISOString(),
      inputTokens: 60_000, outputTokens: 100,
      contentBlocks: [{ type: 'text', text: 'ok' }],
    }
    const big = '核查通过。条款索引与原文一致。'.repeat(200)
    const tail = cycleMsgs(50, big).map((m, i) => ({ ...m, createdAt: new Date(T0 + 10_000 + i * 1000).toISOString() }))
    const used = estimateContextUsed([anchor, ...tail])
    // 60K 锚点 + 折算尾(~30K) ≈ 90K；旧口径的原文尾会是 60K + ~140K = 200K。
    expect(used).toBeGreaterThan(85_000)
    expect(used).toBeLessThan(100_000)
  })

  it('压缩事件投影同样折算尾段，且不高于 raw 读数', () => {
    const anchor: AgentMessage = {
      id: 'anchor', role: 'assistant', createdAt: new Date(T0).toISOString(),
      inputTokens: 60_000, outputTokens: 100,
      contentBlocks: [{ type: 'text', text: 'ok' }],
    }
    const big = '核查通过。条款索引与原文一致。'.repeat(200)
    const tail = cycleMsgs(50, big).map((m, i) => ({ ...m, createdAt: new Date(T0 + 10_000 + i * 1000).toISOString() }))
    const messages = [anchor, ...tail]
    const event: CompactionEvent = {
      ts: T0 + 5_000, source: 'request', strategies: ['nano', 'light'],
      droppedMessages: 10, replayedUserMessages: 0,
      tokensBefore: 130_000, tokensAfter: 50_000,
    }
    const projected = projectContextUsed(messages, event)
    const raw = estimateContextUsed(messages)
    expect(projected).toBeLessThanOrEqual(raw)
    // tokensAfter(50K) + 折算尾(~30K) ≈ 80K。
    expect(projected).toBeGreaterThan(75_000)
    expect(projected).toBeLessThan(90_000)
  })
})
