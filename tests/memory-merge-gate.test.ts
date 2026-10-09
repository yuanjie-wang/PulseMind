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

// 配置播种修复的第二刀（2026-10-09）：场景帽截断合并产物。
// 实测（llm-requests 转储 ns_1791559537057）：模型把 95 条正确合并成 20 条 /
// 14935 字符的合法 JSON 数组（finish_reason=stop），enforceMaxOutputTokens
// 按 4000 估算 token 二分砍到 5434 字符（「Unterminated string at position
// 5434」）→ extractJson 失败 → 0 条落账 → 白烧一次 11.5K in / 27.6K out 的
// 调用，还盖上 2h 重试锁。合并的输出是 JSON 数组，场景帽对它是纯伤害
// （截断=必然解析失败）——本 describe 用真实 MemoryCompressionAgent（不
// stub compressionAgent，走真的 OneShotAgent.execute → enforce → parse 链）
// 钉住：一次等尺度的合法合并产物必须整体落账。
describe('the merge output must survive to the parser (no scenario cap)', () => {
  it('a full-size consolidation (~15K chars, 20 entries) lands intact and advances the watermark', async () => {
    const { estimateTextTokens } = await import('../src/renderer/src/agent/engine/context-estimate')
    const entries = Array.from({ length: 20 }, (_, i) => ({
      content: `合并后的记忆 ${i} 号：三源交叉时天气现象/气温量级/风向常能对上，降水是最容易分歧的一项，交付口径须逐源列明。`.repeat(6),
      type: 'fact',
      category: 'code',
    }))
    const bigJson = JSON.stringify(entries, null, 2)
    // 自检：这个形状必须真的超旧帽——否则帽值回readline时本测试悄悄失去牙齿
    expect(estimateTextTokens(bigJson)).toBeGreaterThan(4000)

    const saved: string[] = []
    const deleted: string[] = []
    const pool = Array.from({ length: 95 }, (_, n) => entry(`记忆内容 ${n} 号`, n))
    const mm = new MemoryManager()
    setHost(makeHost(pool, saved, deleted))
    // 真 compressionAgent + 假 adapter：enforceMaxOutputTokens 与 extractJson 都是真的
    mm.setConfig('key', 'https://example.invalid', { callNonStreaming: async () => bigJson } as never, 'test-model')

    const ok = await mm.ensureMemoryMerged()

    expect(ok).toBe(true) // 修复前：0 条 → false
    expect(saved).toHaveLength(20) // 20 条合并产物整体落账
    expect(deleted).toHaveLength(95) // 旧池（内容不在产物里）全部清掉
    expect(mm.getMergeWatermark().lastRunAt).not.toBe(0) // 成功推进水位
  })
})
