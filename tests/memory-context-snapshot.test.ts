import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { MemoryManager } from '../src/renderer/src/memory/MemoryManager'
import type { MemoryEntry } from '../src/renderer/src/memory/types'

/**
 * 记忆快照的双 3h TTL（2026-09-26 用户裁定）。
 *
 * `# Memory Context`（Extracted Memories + Recent Conversations）从每轮重付的
 * 状态块移进了 system 提示词，靠两层时钟保字节稳定：
 *   全局快照 —— 进程一份，TTL 内所有会话共享同一字节（互相暖前缀）；
 *   会话级 pin —— 会话首次请求时钉住全局串，自己的 TTL 内字节永不变；
 *   pin 过期后重新取全局 —— 若记忆没变，字节相同，重钉免费（线上零重付）。
 */

const SESSION_TTL = MemoryManager.MEMORY_CONTEXT_SESSION_TTL_MS
const GLOBAL_TTL = MemoryManager.MEMORY_CONTEXT_GLOBAL_TTL_MS

function makeHost(memories: MemoryEntry[]) {
  const calls = { listMemories: 0, recentQueries: 0, memoryMd: 0 }
  const host = {
    getMemoryMd: async () => {
      calls.memoryMd++
      return ''
    },
    listMemories: async () => {
      calls.listMemories++
      return [...memories]
    },
    listConversationsForMemory: async () => {
      calls.recentQueries++
      return []
    },
  }
  setHost(host as unknown as PulseHost)
  return { calls, memories }
}

function entry(content: string, n: number): MemoryEntry {
  return { id: `mem_${n}`, content, type: 'auto', category: 'code', createdAt: new Date().toISOString() } as MemoryEntry
}

function makeManager(): MemoryManager {
  return new MemoryManager()
}

afterEach(() => vi.useRealTimers())

describe('the memory context snapshot (double 3h TTL)', () => {
  it('a conversation pin holds its bytes — and its DB reads — for the session TTL', async () => {
    const { calls } = makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()

    const first = await mm.getStableMemoryContext('conv_A')
    const second = await mm.getStableMemoryContext('conv_A')

    expect(first).toContain('记忆 1')
    expect(second).toBe(first)
    expect(calls.listMemories).toBe(1) // 第二发来自 pin，不打 DB
  })

  it('a second conversation inside the window shares the same global snapshot bytes', async () => {
    const { calls } = makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()

    const a = await mm.getStableMemoryContext('conv_A')
    const b = await mm.getStableMemoryContext('conv_B')

    expect(b).toBe(a) // 跨会话逐字节相同 —— 跨会话暖启动的物理基础
    expect(calls.listMemories).toBe(1) // conv_B 直接取全局，无新读
  })

  it('on expiry the conversation re-pins from the global; changed memories land once the global rebuilt too', async () => {
    const { calls, memories } = makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()
    const before = await mm.getStableMemoryContext('conv_A')

    // 两层同时过期（过了全局 3h）；期间记忆池新增了一条
    memories.push(entry('过期后新增的一条足够长的记忆', 99))
    vi.setSystemTime(new Date(Date.now() + GLOBAL_TTL + 1_000))
    const after = await mm.getStableMemoryContext('conv_A')

    expect(after).not.toBe(before)
    expect(after).toContain('过期后新增')
    expect(calls.listMemories).toBe(2) // 全局重建 + 重新钉住
  })

  it('session expiry while the global is still fresh re-pins identical bytes without a DB read', async () => {
    const { calls } = makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()
    const before = await mm.getStableMemoryContext('conv_A')

    // 过了会话 1h，但全局 3h 未到：重钉取的还是那份全局串
    vi.setSystemTime(new Date(Date.now() + SESSION_TTL + 1_000))
    const after = await mm.getStableMemoryContext('conv_A')

    expect(after).toBe(before)
    expect(calls.listMemories).toBe(1) // 全局未重建 —— 重钉免费
  })

  it('an unchanged memory set makes the re-pin byte-identical — a free refresh', async () => {
    makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()
    const before = await mm.getStableMemoryContext('conv_A')

    vi.setSystemTime(new Date(Date.now() + SESSION_TTL + 1_000))
    const after = await mm.getStableMemoryContext('conv_A')

    expect(after).toBe(before) // 字节相同 → 线上前缀不变 → 零重付
  })

  it('the master switch off returns empty immediately and touches no cache', async () => {
    const { calls } = makeHost([1, 2, 3].map((n) => entry(`记忆 ${n}`, n)))
    const mm = makeManager()
    mm.setPreferences({ autoInjectEnabled: false })

    expect(await mm.getStableMemoryContext('conv_A')).toBe('')
    expect(calls.listMemories).toBe(0)

    mm.setPreferences({ autoInjectEnabled: true })
    const text = await mm.getStableMemoryContext('conv_A')
    expect(text).toContain('记忆 1')
    expect(calls.listMemories).toBe(1)
  })
})
