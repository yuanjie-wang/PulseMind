import { describe, expect, it, beforeEach } from 'vitest'

const { execSpawnAgent } = await import('../src/renderer/src/agent/executors/spawn-tool')
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'
import {
  MAX_PARALLEL_SUBAGENTS,
  acquireSubAgentSlot,
  activeSubAgentCount,
  queuedSubAgentCount,
  resetSubAgentLimiter,
} from '../src/renderer/src/agent/engine/subagent-limiter'

/**
 * 嵌套派生的槽位纪律（死锁修复 2026-09-29，用户报告：另一台电脑上一个 plan
 * 的 5 节点波次 + 节点内再派生把全会话锁死）。机制：槽位跨 waitForCompletion
 * 持有 + 嵌套共享同一预算键 → 「持槽者等子代理完成、子代理等嵌套槽位」成环。
 * 修复 = 嵌套派生走 tryAcquireSubAgentSlot（永不排队），满员即把工作交还调用方。
 * 这里驱动真实的 execSpawnAgent（假 context），钉三件事：
 *  1. 嵌套 + 满员 → 立即以「槽位已满」工具错误收场，不启动引擎、不进队列、不占槽；
 *  2. 嵌套 + 有空位 → 照常派生（限制的只是「等待」，不是嵌套本身）；
 *  3. 顶层（无嵌套标记）+ 满员 → 仍然排队等槽（FIFO 语义原样保留）。
 * limiter 层的不变量在 tests/subagent-limiter.test.ts 的 deadlock describe 里。
 */

const subMessages = (text: string) => [
  { id: 'a1', role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-09-29T12:00:00.000Z' },
]

interface Captured { content: string; isError: boolean }

function makeContext(opts: {
  conversationId: string
  isSpawnedSubAgent?: () => boolean
}): { ex: ToolExecContext; tool: ToolUseBlock; getCaptured: () => Captured | null; spawnCalls: () => number } {
  let captured: Captured | null = null
  let spawnCount = 0
  const ex = {
    opts: { conversationId: opts.conversationId, maxTokens: 1024 },
    notify: () => {},
    addToolResult: (_id: string, content: string, isError: boolean) => { captured = { content, isError } },
    spawnSubAgent: () => {
      spawnCount += 1
      return {
        id: 'h1',
        subConvId: `sub_${spawnCount}`,
        messages: [],
        agentStatus: { status: 'completed' },
        abort: () => {},
        waitForCompletion: async () => ({ status: 'completed', messages: subMessages('嵌套子代理的产出') }),
      }
    },
    formatExecResult: () => '',
    ...(opts.isSpawnedSubAgent ? { isSpawnedSubAgent: opts.isSpawnedSubAgent } : {}),
  } as unknown as ToolExecContext
  const tool = { id: 't1', type: 'tool_use', name: 'spawn_agent', input: { task: '嵌套委派的任务' }, status: 'pending' } as ToolUseBlock
  return { ex, tool, getCaptured: () => captured, spawnCalls: () => spawnCount }
}

/** 占满某会话键的全部槽位，返回释放函数。 */
async function fillCap(key: string): Promise<Array<() => void>> {
  const slots = await Promise.all(Array.from({ length: MAX_PARALLEL_SUBAGENTS }, () => acquireSubAgentSlot(key)))
  return slots.filter((s): s is Exclude<typeof s, null> => typeof s === 'function')
}

beforeEach(() => {
  resetSubAgentLimiter()
})

describe('nested spawn_agent never queues for a slot', () => {
  it('nested at cap: fails fast with a do-it-yourself error, no engine started, no slot taken, no queue entry', async () => {
    const key = 'conv_nested_cap'
    const held = await fillCap(key)
    const { ex, tool, getCaptured, spawnCalls } = makeContext({ conversationId: key, isSpawnedSubAgent: () => true })

    await execSpawnAgent(ex, tool)

    expect(spawnCalls()).toBe(0)
    expect(activeSubAgentCount(key)).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(queuedSubAgentCount(key)).toBe(0)
    const result = getCaptured()!
    expect(result.isError).toBe(true)
    expect(result.content).toContain('并行槽位已满')
    expect(result.content).toContain('不要继续派生子代理')
    expect(result.content).toContain('直接用你自己的工具完成')
    expect(tool.exitCode).toBe(-1)
    for (const r of held) r()
  })

  it('nested with a free slot: still delegated, and the slot is released in the finally', async () => {
    const key = 'conv_nested_free'
    const held = await fillCap(key)
    held.pop()!() // 留一个空位
    const { ex, tool, getCaptured, spawnCalls } = makeContext({ conversationId: key, isSpawnedSubAgent: () => true })

    await execSpawnAgent(ex, tool)

    expect(spawnCalls()).toBe(1)
    const result = getCaptured()!
    expect(result.isError).toBe(false)
    expect(result.content).toContain('嵌套子代理的产出')
    expect(activeSubAgentCount(key)).toBe(MAX_PARALLEL_SUBAGENTS - 1)
    for (const r of held) r()
    expect(activeSubAgentCount(key)).toBe(0)
  })

  it('top-level at cap: still QUEUES for a slot (FIFO semantics untouched)', async () => {
    const key = 'conv_top_queue'
    const held = await fillCap(key)
    const { ex, tool, getCaptured, spawnCalls } = makeContext({ conversationId: key })

    const running = execSpawnAgent(ex, tool)
    await new Promise((r) => setTimeout(r, 20))
    // 满员且顶层：不启动、不失败——挂在队列里等空位（修复前嵌套也走这条，是死锁的成环边）。
    expect(spawnCalls()).toBe(0)
    expect(getCaptured()).toBeNull()
    expect(queuedSubAgentCount(key)).toBe(1)

    held[0]() // 一个专家收工 → 槽位转交 → 派发继续
    await running
    expect(spawnCalls()).toBe(1)
    expect(getCaptured()!.isError).toBe(false)
    // await 返回时执行器已在 finally 释放它经转交拿到的那个槽位：剩下的占用
    // 就是我还没释放的 4 个 held。
    expect(activeSubAgentCount(key)).toBe(MAX_PARALLEL_SUBAGENTS - 1)
    for (let i = 1; i < held.length; i++) held[i]()
  })
})
