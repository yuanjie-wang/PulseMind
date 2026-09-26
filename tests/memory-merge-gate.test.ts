import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { MemoryManager } from '../src/renderer/src/memory/MemoryManager'
import type { MemoryEntry } from '../src/renderer/src/memory/types'

/**
 * 记忆合并空转修复（2026-09-26）。
 *
 * 实测：同一份 Consolidate 负载 2 分钟内逐字节相同地打了 4 遍。根因链 =
 * watermark 只在合并成功时推进 → 失败/空结果后 lastRunAt 仍是 0 → 间隔门
 * （24h）永远不生效、且「新增」按全量池计算永远 ≥5 → 每个触发点
 * （afterSession / 启动延迟 sweep）都重新发起同一次 LLM 调用。
 *
 * 修复 = 水位带上 lastAttemptAt：尝试即盖章，成功走 24h 时钟，失败/空走
 * 2h 重试时钟。本文件用真实的 MemoryManager + 假 host + 桩 compressionAgent
 * 把三层行为钉死。
 */

const RETRY_MS = (MemoryManager as unknown as { MERGE_RETRY_MS: number }).MERGE_RETRY_MS
const MIN_INTERVAL_MS = (MemoryManager as unknown as { MERGE_MIN_INTERVAL_MS: number }).MERGE_MIN_INTERVAL_MS

function makeHost(memories: MemoryEntry[], saved: string[], deleted: string[]): PulseHost {
  return {
    listMemories: async () => memories,
    countMemories: async () => memories.length,
    saveMemory: async (input: { content: string }) => {
      saved.push(input.content)
      return { id: 'mem_x', content: input.content, type: 'auto', category: 'general', createdAt: new Date().toISOString() } as MemoryEntry
    },
    deleteMemory: async (id: string) => {
      deleted.push(id)
    },
  } as unknown as PulseHost
}

function entry(content: string, n: number): MemoryEntry {
  return { id: `mem_${n}`, content, type: 'auto', category: 'code', createdAt: new Date().toISOString() } as MemoryEntry
}

function makeManager(host: PulseHost): { mm: MemoryManager; execute: ReturnType<typeof vi.fn> } {
  const mm = new MemoryManager()
  setHost(host)
  mm.setConfig('key', 'https://example.invalid', {} as never, 'test-model')
  const execute = vi.fn(async () => [] as Array<{ content: string; type: string; category: string }>)
  ;(mm as unknown as { compressionAgent: { execute: typeof execute } }).compressionAgent = { execute }
  return { mm, execute }
}

describe('the merge attempt gate (idle-spin fix)', () => {
  it('an empty merge result does not spin: the immediate second call issues zero LLM calls', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    const { mm, execute } = makeManager(makeHost([1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n)), saved, deleted))

    await mm.ensureMemoryMerged()
    expect(execute).toHaveBeenCalledTimes(1) // 尝试发生了
    expect(mm.getMergeWatermark().lastAttemptAt).not.toBe(0) // 尝试被盖章

    await mm.ensureMemoryMerged()
    await mm.ensureMemoryMerged()
    expect(execute).toHaveBeenCalledTimes(1) // 修复点：空结果后立刻重触发不再打 LLM
  })

  it('a failed attempt retries on the short clock (RETRY_MS), not the 24h clock', async () => {
    const { mm, execute } = makeManager(makeHost([1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n)), [], []))
    await mm.ensureMemoryMerged()
    expect(execute).toHaveBeenCalledTimes(1)

    // 回拨到重试窗口之外 → 允许再试
    mm.setMergeWatermark({ lastRunAt: 0, lastCount: 0, lastAttemptAt: Date.now() - RETRY_MS - 1 })
    await mm.ensureMemoryMerged()
    expect(execute).toHaveBeenCalledTimes(2)

    // 成功过一次（lastRunAt 领先）→ 24h 时钟持有
    mm.setMergeWatermark({ lastRunAt: Date.now() - MIN_INTERVAL_MS + 60_000, lastCount: 6, lastAttemptAt: 0 })
    execute.mockClear()
    await mm.ensureMemoryMerged()
    expect(execute).not.toHaveBeenCalled()
  })

  it('a successful merge advances lastRunAt and the immediate next call is a no-op', async () => {
    const saved: string[] = []
    const { mm, execute } = makeManager(makeHost([1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n)), saved, []))
    execute.mockResolvedValue([{ content: '合并后的一条足够长的记忆内容', type: 'fact', category: 'code' }])

    const ran = await mm.ensureMemoryMerged()
    expect(ran).toBe(true)
    expect(saved).toEqual(['合并后的一条足够长的记忆内容'])
    const wm = mm.getMergeWatermark()
    expect(wm.lastRunAt).not.toBe(0)
    expect(wm.lastAttemptAt).not.toBe(0)

    execute.mockClear()
    await mm.ensureMemoryMerged()
    expect(execute).not.toHaveBeenCalled()
  })

  it('below the due threshold nothing is attempted at all', async () => {
    const { mm, execute } = makeManager(makeHost([1, 2].map((n) => entry(`短池 ${n}`, n)), [], []))
    await mm.ensureMemoryMerged()
    expect(execute).not.toHaveBeenCalled()
    expect(mm.getMergeWatermark().lastAttemptAt).toBe(0)
  })
})

describe('the watermark round-trips through settings.json with the attempt clock', () => {
  const STORE = 'src/main/storage/settings-store.ts'
  const SESSION_MANAGER = 'src/main/agent/session-manager.ts'

  it('the persist shape carries lastAttemptAt and the sweep persists bare attempts', () => {
    const sm = readFileSync(SESSION_MANAGER, 'utf-8')
    expect(sm).toContain('lastAttemptAt: new Date(w.lastAttemptAt).toISOString()')
    expect(sm).toContain('w.lastRunAt === 0 && !w.lastAttemptAt') // 空 attempts 不写盘，失败过的必须写
    expect(sm).toContain('lastAttemptAt: w?.lastAttemptAt ? new Date(w.lastAttemptAt).getTime() : 0') // 启动播种
  })

  it('the settings-store reader parses lastAttemptAt', () => {
    const src = readFileSync(STORE, 'utf-8')
    expect(src).toContain("typeof w.lastAttemptAt === 'string' && w.lastAttemptAt")
  })

  it('the settings type carries the attempt field', () => {
    const src = readFileSync('src/shared/types/settings.ts', 'utf-8')
    expect(src).toContain('memoryMergeWatermark?: { lastRunAt?: string; lastCount?: number; lastAttemptAt?: string }')
  })
})
