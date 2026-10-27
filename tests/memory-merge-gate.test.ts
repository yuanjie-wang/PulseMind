import { describe, expect, it, vi } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { MemoryManager } from '../src/renderer/src/memory/MemoryManager'
import type { MemoryPageRecord } from '../src/shared/memory-pages'

/**
 * 页面编译层的门（PLAN-memory-wiki M6，2026-10-25；分区整理 2026-10-27）——
 * 语义自旧合并空转修复（2026-09-26）原样移植：watermark 带 lastAttemptAt，
 * 尝试即盖章；成功走 24h 钟，异常/全废产出走 2h 重试钟；「增长」按活页数差
 * ≥8 判定（lastCount=0 的首编译在 ≥8 页时即到期——迁移兜底臂的 per-row 页
 * 等着第一轮归并）。满目视图下的空产出就是「池子干净」= 成功（维护钟臂的
 * 停转前提：否则干净的大池子每 2h 空转一轮）。
 * 分区整理（2026-10-27）：选页按 createdAt 升序从 lastCursorAt 起装预算，
 * 取代「超预算全体降级 titles-only 禁 merge」；游标是位置不是成绩，异常也
 * 推进；到末端回落全量从头再轮。超预算池子另有 7 天维护钟（无增长也整理）。
 * 附加纪律：编译永不硬删（并页走 supersede 留谱系；过时页走 retire 留理由）。
 */

const RETRY_MS = (MemoryManager as unknown as { COMPILE_RETRY_MS: number }).COMPILE_RETRY_MS
const MIN_INTERVAL_MS = (MemoryManager as unknown as { COMPILE_MIN_INTERVAL_MS: number }).COMPILE_MIN_INTERVAL_MS
const MIN_NEW = (MemoryManager as unknown as { COMPILE_MIN_NEW: number }).COMPILE_MIN_NEW
const MAINTENANCE_MS = (MemoryManager as unknown as { COMPILE_MAINTENANCE_MS: number }).COMPILE_MAINTENANCE_MS

const page = (id: string, title: string): MemoryPageRecord => ({
  id, title, type: 'fact', body: `${title} 正文`, aliases: [], links: [], supersededBy: null,
  sourceConversationId: null, files: null, useCount: 0, lastUsedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
})

/** 大页工厂：body ~4K、createdAt 逐秒递增（分区排序的稳定序）、双位标题（免前缀歧义）。 */
const bigPage = (i: number): MemoryPageRecord => ({
  ...page(`p${i}`, `页${String(i).padStart(2, '0')}`),
  body: 'x'.repeat(4000),
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
})
const big = (n: number) => Array.from({ length: n }, (_, i) => bigPage(i))

function makeHost(pages: MemoryPageRecord[]) {
  const calls = { llm: 0, appliedOps: [] as unknown[] }
  const host = {
    listMemoryPages: async () => pages,
    applyMemoryPageOps: async (ops: unknown[]) => {
      calls.appliedOps.push(...ops)
      return ops.map((op, i) => ({ op, ok: true, pageId: `page_new_${i}` }))
    },
  }
  setHost(host as unknown as PulseHost)
  return { calls }
}

function makeManager() {
  const mm = new MemoryManager()
  mm.setConfig('key', 'https://example.invalid', {} as never, 'test-model')
  const execute = vi.fn(async () => ({ pages: [] }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(mm as unknown as { compileAgent: { execute: typeof execute } }).compileAgent = { execute }
  return { mm, execute }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => page(`p${i}`, `页${i}`))

describe('the compile attempt gate（空转帽移植）', () => {
  it('空产出 = 成功（24h 钟）：紧接的第二次调用零 LLM 调用，lastRunAt 落章', async () => {
    makeHost(many(MIN_NEW))
    const { mm, execute } = makeManager()
    await mm.ensurePagesCompiled()
    expect(execute).toHaveBeenCalledTimes(1)
    // 满目视图下空产出就是「池子干净」——成功钟而非重试钟（维护钟臂的停转前提）
    expect(mm.getCompileWatermark().lastRunAt).not.toBe(0)
    await mm.ensurePagesCompiled()
    expect(execute).toHaveBeenCalledTimes(1) // 24h 钟内不再开火
  })

  it('成功走 24h 钟：产出应用后整日不再跑', async () => {
    makeHost(many(MIN_NEW))
    const { mm, execute } = makeManager()
    execute.mockResolvedValueOnce({ pages: [{ action: 'alias', target: '页0', aliases: ['别名'] }] })
    expect(await mm.ensurePagesCompiled()).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    await mm.ensurePagesCompiled()
    expect(execute).toHaveBeenCalledTimes(1) // 24h 钟内不再开火
  })

  it('异常走 2h 重试钟：到点放行（advanceTimers）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(many(MIN_NEW))
      const { mm, execute } = makeManager()
      execute.mockRejectedValueOnce(new Error('boom'))
      expect(await mm.ensurePagesCompiled()).toBe(false)
      vi.setSystemTime(Date.now() + RETRY_MS + 1000)
      await mm.ensurePagesCompiled()
      expect(execute).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('due 判定（活页数差 ≥8；bootstrap）', () => {
  it('页数不足（<2 或 <MIN_NEW 且无基线）不跑', async () => {
    makeHost(many(MIN_NEW - 1))
    const { mm, execute } = makeManager()
    expect(await mm.ensurePagesCompiled()).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    makeHost(many(1))
    expect(await mm.ensurePagesCompiled()).toBe(false)
  })

  it('基线后增长 <8 不跑；≥8 到期', async () => {
    let pages = many(MIN_NEW)
    makeHost(pages)
    const { mm, execute } = makeManager()
    execute.mockResolvedValueOnce({ pages: [{ action: 'alias', target: '页0', aliases: ['x'] }] })
    await mm.ensurePagesCompiled() // 基线 = MIN_NEW
    // 时间推进越过 24h：增长 1 页（<8）→ 不跑
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + MIN_INTERVAL_MS + 1000)
    try {
      pages = [...pages, page('extra', '额外页')]
      makeHost(pages)
      const before = execute.mock.calls.length
      await mm.ensurePagesCompiled()
      expect(execute.mock.calls.length).toBe(before)
      // 再长 7 页（总增长 8）→ 到期
      pages = [...pages, ...many(7).map((p, i) => ({ ...p, id: `g${i}`, title: `增${i}` }))]
      makeHost(pages)
      await mm.ensurePagesCompiled()
      expect(execute.mock.calls.length).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('编译语义：不删不建', () => {
  it('op 应用经 applyMemoryPageOps；host 无 delete 调用面（编译层永不删除）', async () => {
    const { calls } = makeHost(many(MIN_NEW))
    const { mm, execute } = makeManager()
    execute.mockResolvedValueOnce({ pages: [{ action: 'supersede', target: '页0', title: '规范页', type: 'fact', content: '合并正文' }] })
    await mm.ensurePagesCompiled()
    expect(calls.appliedOps.length).toBe(1)
    expect(calls.appliedOps[0]).toMatchObject({ action: 'supersede' })
  })

  it('retire op 直达 applyMemoryPageOps（理由随 op 落审计面）', async () => {
    const { calls } = makeHost(many(MIN_NEW))
    const { mm, execute } = makeManager()
    execute.mockResolvedValueOnce({ pages: [{ action: 'retire', target: '页0', reason: '内容已过时' }] })
    expect(await mm.ensurePagesCompiled()).toBe(true)
    expect(calls.appliedOps[0]).toMatchObject({ action: 'retire', target: '页0', reason: '内容已过时' })
  })

  it('无 LLM 配置（renderer 形态）直接 false，不触 host', async () => {
    makeHost(many(MIN_NEW))
    const mm = new MemoryManager() // 无 setConfig
    expect(await mm.ensurePagesCompiled()).toBe(false)
  })
})

describe('分区整理（2026-10-27）：游标轮转装预算', () => {
  it('大池子分片：单轮装预算为止，超出的页不进本轮输入', async () => {
    makeHost(big(20)) // 20 × ~4K ≈ 80K，单轮只装得下 ~7 页
    const { mm, execute } = makeManager()
    await mm.ensurePagesCompiled()
    expect(execute).toHaveBeenCalledTimes(1)
    const input = execute.mock.calls[0][0] as { pagesText: string; mode: string }
    expect(input.mode).toBe('full')
    expect(input.pagesText).toContain('页00')
    expect(input.pagesText).toContain('页06')
    expect(input.pagesText).not.toContain('页07')
    expect(input.pagesText).not.toContain('页19')
  })

  it('游标推进：下一片从上轮末页之后起转（createdAt 升序轮转）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(big(20))
      const { mm, execute } = makeManager()
      await mm.ensurePagesCompiled()
      const cursor = mm.getCompileWatermark().lastCursorAt
      expect(cursor).toBeGreaterThan(0)
      vi.setSystemTime(Date.now() + MAINTENANCE_MS + 1000) // 无增长，靠维护钟开下一轮
      await mm.ensurePagesCompiled()
      const input = execute.mock.calls[1][0] as { pagesText: string }
      expect(input.pagesText).toContain('页07')
      expect(input.pagesText).not.toContain('页00')
      // 游标 = 上轮末页（页06）的 createdAt
      expect(cursor).toBe(Date.UTC(2026, 9, 1, 0, 0, 6))
    } finally {
      vi.useRealTimers()
    }
  })

  it('游标到末端（无更新的页）回落全量从头再轮', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(big(8)) // 首轮装 7 页（页00..页06），剩页07
      const { mm, execute } = makeManager()
      await mm.ensurePagesCompiled()
      vi.setSystemTime(Date.now() + MAINTENANCE_MS + 1000)
      await mm.ensurePagesCompiled() // 第二片 = [页07]
      expect(execute.mock.calls[1][0]).toMatchObject({ pagesText: expect.stringContaining('页07') })
      vi.setSystemTime(Date.now() + MAINTENANCE_MS + 2000)
      await mm.ensurePagesCompiled() // 游标已到末端 → 回落全量，从页00 再轮
      const input = execute.mock.calls[2][0] as { pagesText: string }
      expect(input.pagesText).toContain('页00')
      expect(input.pagesText).not.toContain('页07\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('游标是位置不是成绩：异常也推进，重试不吃同一切片', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(big(20))
      const { mm, execute } = makeManager()
      execute.mockRejectedValueOnce(new Error('boom'))
      expect(await mm.ensurePagesCompiled()).toBe(false)
      expect(mm.getCompileWatermark().lastCursorAt).toBe(Date.UTC(2026, 9, 1, 0, 0, 6))
      vi.setSystemTime(Date.now() + RETRY_MS + 1000)
      let secondSlice = ''
      execute.mockImplementationOnce(async (input) => { secondSlice = (input as { pagesText: string }).pagesText; return { pages: [] } })
      await mm.ensurePagesCompiled()
      expect(secondSlice).toContain('页07')
      expect(secondSlice).not.toContain('页00')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('维护钟（超预算池子的无增长整理）', () => {
  it('超预算 + 无增长：24h 不放行、7 天放行', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(big(20))
      const { mm, execute } = makeManager()
      await mm.ensurePagesCompiled() // bootstrap 增长触发
      expect(execute).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + MIN_INTERVAL_MS + 1000) // 24h 后，仍 < 7d
      await mm.ensurePagesCompiled()
      expect(execute).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + MAINTENANCE_MS + 2000) // > 7d
      await mm.ensurePagesCompiled()
      expect(execute).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('预算内的小池子无增长：7 天后也不放行（维护钟只在分区生效时接管）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    try {
      makeHost(many(MIN_NEW))
      const { mm, execute } = makeManager()
      await mm.ensurePagesCompiled()
      vi.setSystemTime(Date.now() + MAINTENANCE_MS + 1000)
      await mm.ensurePagesCompiled()
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('编译输入排除面', () => {
  it('SOP 页与退役页不进输入（园丁不修电器；退役页已出池）', async () => {
    const pages = [
      ...many(MIN_NEW),
      { ...page('sop1', '脚本页甲'), maturity: 'sop' as const, files: [{ path: 's.mjs', content: 'x' }] },
      { ...page('ret1', '退役页乙'), retiredAt: '2026-10-27T00:00:00.000Z', retireReason: '过时' },
    ]
    makeHost(pages)
    const { mm, execute } = makeManager()
    await mm.ensurePagesCompiled()
    const input = execute.mock.calls[0][0] as { pagesText: string }
    expect(input.pagesText).not.toContain('脚本页甲')
    expect(input.pagesText).not.toContain('退役页乙')
    expect(input.pagesText).toContain('页0')
  })
})
