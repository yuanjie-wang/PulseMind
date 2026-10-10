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
  const execute = vi.fn(async () => ({ memories: [], dropped: [] }))
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
    execute.mockResolvedValue({ memories: [{ content: '合并后的一条足够长的记忆内容', type: 'fact', category: 'code' }], dropped: [1, 2, 3, 4, 5, 6] })

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

// 播种互斥（review 2026-10-10 中5）：共享 MemoryManager 单例，每个会话结束的
// afterSession sweep 带各自的 profile、启动 sweep 带活动档，都是 fire-and-forget
// ——进行中的播种会把正在跑的合并换到别的模型下。setConfig 在 _compressing
// 期间必须拒收；合并落定后恢复收种。
describe('setConfig refuses to swap the config mid-merge', () => {
  it('a seed landing while a merge runs is dropped; after it settles, seeding works again', async () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n))
    const { mm, execute } = makeManager(makeHost(pool, [], []))
    let release: (v: unknown) => void = () => {}
    execute.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const fields = mm as unknown as { apiKey: string; model: string; _compressing: boolean }

    const running = mm.ensureMemoryMerged()
    await vi.waitFor(() => expect(fields._compressing).toBe(true)) // 尝试已盖章、合并已升旗

    mm.setConfig('key-b', 'https://b.invalid', {} as never, 'model-b')
    expect(fields.apiKey).toBe('key') // 运行中的合并保住自己的 config
    expect(fields.model).toBe('test-model')

    release([])
    await running // 空产物 → 尝试盖章、_compressing 落旗

    mm.setConfig('key-b', 'https://b.invalid', {} as never, 'model-b')
    expect(fields.apiKey).toBe('key-b')
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
// 14935 字符的合法 JSON（finish_reason=stop），enforceMaxOutputTokens
// 按 4000 估算 token 二分砍到 5434 字符（「Unterminated string at position
// 5434」）→ extractJson 失败 → 0 条落账 → 白烧一次 11.5K in / 27.6K out 的
// 调用，还盖上 2h 重试锁。合并的输出是 JSON 对象（memories+dropped 回执），
// 场景帽对它是纯伤害（截断=必然解析失败）——本 describe 用真实
// MemoryCompressionAgent（不 stub compressionAgent，走真的 OneShotAgent.execute
// → enforce → parse 链）钉住：一次等尺度的合法合并产物必须整体落账。
describe('the merge output must survive to the parser (no scenario cap)', () => {
  it('a full-size consolidation (~15K chars, 20 entries) lands intact and advances the watermark', async () => {
    const { estimateTextTokens } = await import('../src/renderer/src/agent/engine/context-estimate')
    const entries = Array.from({ length: 20 }, (_, i) => ({
      content: `合并后的记忆 ${i} 号：三源交叉时天气现象/气温量级/风向常能对上，降水是最容易分歧的一项，交付口径须逐源列明。`.repeat(6),
      type: 'fact',
      category: 'code',
    }))
    const bigJson = JSON.stringify({ memories: entries, dropped: Array.from({ length: 95 }, (_, i) => i + 1) }, null, 2)
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
    expect(deleted).toHaveLength(95) // 回执点名全部弃掉 → 旧池清掉
    expect(mm.getMergeWatermark().lastRunAt).not.toBe(0) // 成功推进水位
  })
})

// 消费回执制（2026-10-10）：旧删除谓词是「内容 hash 不在产物里就删」——模型
// 整理时漏掉一条 = 永久丢失，保存侧 hash 门只防重复不防丢失。现在删除需要
// 回执：hash 精确复现（逐字搬运）或 dropped 点名。没被点名的行存活，等下一
// 次合并重试（每次都带全量池）。
describe('the consumption receipt — deletion needs proof of consumption', () => {
  it('a row the model forgot (neither merged nor dropped) survives; receipted rows go', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    // 6 行输入；模型合并成 1 条并只点了 5 行的弃单——漏了第 3 行
    const { mm, execute } = makeManager(makeHost([1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n)), saved, deleted))
    execute.mockResolvedValue({
      memories: [{ content: '合并后的一条足够长的记忆内容', type: 'fact', category: 'code' }],
      dropped: [1, 2, 4, 5, 6],
    })

    const ran = await mm.ensureMemoryMerged()
    expect(ran).toBe(true)
    expect(deleted).toEqual(['mem_1', 'mem_2', 'mem_4', 'mem_5', 'mem_6']) // 回执内的行删
    expect(deleted).not.toContain('mem_3') // 遗忘的行存活（修复前必删）
    expect(saved).toEqual(['合并后的一条足够长的记忆内容'])
  })

  it('a verbatim carry-over deletes by hash even without a receipt; USER-EDITED rows survive both ways', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    const carried = entry('用户偏好深色主题，截图一律走浅色', 1)
    const edited = entry('用户对部署节奏有强意见', 2)
    edited.updatedAt = new Date(Date.now() + 5000).toISOString() // USER-EDITED
    // 池子要过 MERGE_MIN_NEW=5 的触发线（水位为 0 时按全量计）
    const { mm, execute } = makeManager(makeHost([carried, edited, ...[3, 4, 5, 6].map((n) => entry(`填充记忆 ${n} 号`, n))], saved, deleted))
    execute.mockResolvedValue({
      memories: [
        { content: '用户偏好深色主题，截图一律走浅色', type: 'preference', category: 'user_pref' }, // 逐字复现
        { content: '完全无关的一条合并记忆，长到足以过长度门', type: 'fact', category: 'general' },
      ],
      dropped: [], // 什么回执都没给
    })

    await mm.ensureMemoryMerged()
    expect(deleted).toEqual(['mem_1']) // hash 命中照删（新池里有同一内容）
    expect(deleted).not.toContain('mem_2') // USER-EDITED 双保险存活
  })

  it('an output with NO receipts deletes nothing beyond hash matches', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    const { mm, execute } = makeManager(makeHost([1, 2, 3, 4, 5, 6].map((n) => entry(`记忆内容 ${n} 号`, n)), saved, deleted))
    // 合并产物不与任何旧行同内容，dropped 为空（旧形状裸数组经 parseResponse
    // 归一化后就是这种形状）→ 无回执即不动行，旧池整体存活等下次合并
    execute.mockResolvedValue({ memories: [{ content: '一条新的合并记忆，内容完全不同', type: 'fact', category: 'code' }], dropped: [] })

    await mm.ensureMemoryMerged()
    expect(deleted).toEqual([]) // 无回执不动行
    expect(saved).toEqual(['一条新的合并记忆，内容完全不同'])
  })

  it('the parser normalizes the object contract: numbers sanitized, legacy array tolerated', async () => {
    const { MemoryCompressionAgent } = await import('../src/renderer/src/agent/one-shot-agent')
    const agent = new MemoryCompressionAgent()
    const parse = (raw: string) => (agent as unknown as { parseResponse: (r: string) => unknown }).parseResponse(raw)

    const obj = parse('{"memories":[{"content":"一条足够长的合并记忆","type":"fact","category":"code"}],"dropped":[3,1,3,-2,2.5,"9"]}') as { memories: unknown[]; dropped: number[] }
    expect(obj.memories).toHaveLength(1)
    expect(obj.dropped).toEqual([3, 1]) // 去重、剔负数/非整数/非数字

    const legacy = parse('[{"content":"旧形状裸数组产物","type":"fact","category":"code"}]') as { memories: unknown[]; dropped: number[] }
    expect(legacy.memories).toHaveLength(1)
    expect(legacy.dropped).toEqual([]) // 裸数组=无回执
  })
})
