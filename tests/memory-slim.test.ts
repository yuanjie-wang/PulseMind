import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { MemoryManager } from '../src/renderer/src/memory/MemoryManager'
import type { MemoryEntry } from '../src/renderer/src/memory/types'
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_RESIDENT_CAP } from '../src/shared/memory/limits'
import { escapeLikePattern } from '../src/shared/memory/like-pattern'

/**
 * 常驻记忆区瘦身（user 2026-10-10 三条裁定：单条 ≤100 字、内容用短句、
 * memory_search 作取回通道）。
 *
 * 背景（llm-requests api_1791639104031 实测）：26 条记忆全量注入 system
 * prompt ≈11.8K token，占单请求 36%。改造后：
 *   写端 —— 三条路径的提示词都要短句 + 100 字帽，主提取与打捞有结构兜底
 *   （超限不入库；合并产物例外——它的删除账按产物哈希记，跳过会丢内容）；
 *   读端 —— 常驻区只渲染 ≤100 字的最新 20 条 + 省略指针行，长文留在库里
 *   由 memory_search 取回（该工具同日放开 gated、检索改 LIKE 全表扫——
 *   memories_fts 的 unicode61 分词对中文子串查询几乎必然 miss）。
 */

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

function makeHost(memories: MemoryEntry[], saved: string[] = []): PulseHost {
  return {
    getMemoryMd: async () => '',
    listMemories: async () => memories,
    listConversationsForMemory: async () => [],
    saveMemory: async (input: { content: string }) => {
      saved.push(input.content)
      return { id: 'mem_x', content: input.content, type: 'auto', category: 'general', createdAt: new Date().toISOString() } as MemoryEntry
    },
  } as unknown as PulseHost
}

function entry(content: string, n: number, type = 'auto'): MemoryEntry {
  return { id: `mem_${n}`, content, type, category: 'code', createdAt: new Date().toISOString() } as MemoryEntry
}

describe('常驻区渲染：≤100 字过滤 + 20 条帽 + 省略指针', () => {
  it('超长条目不进常驻区，短条目照常渲染', async () => {
    const long = '长'.repeat(MEMORY_ENTRY_MAX_CHARS + 1)
    const mm = new MemoryManager()
    setHost(makeHost([entry('短条目甲', 1), entry(long, 2), entry('短条目乙', 3)]))
    const ctx = await (mm as unknown as { buildMemoryContext(): Promise<string> }).buildMemoryContext()
    expect(ctx).toContain('- 短条目甲')
    expect(ctx).toContain('- 短条目乙')
    expect(ctx).not.toContain(long)
  })

  it('恰好 100 字的条目在界内（≤ 而非 <）', async () => {
    const exact = '界'.repeat(MEMORY_ENTRY_MAX_CHARS)
    const mm = new MemoryManager()
    setHost(makeHost([entry(exact, 1)]))
    const ctx = await (mm as unknown as { buildMemoryContext(): Promise<string> }).buildMemoryContext()
    expect(ctx).toContain(exact)
  })

  it('超过 20 条时只渲染最新 20 条（listMemories 已 newest-first），指针行报省略数', async () => {
    const memories = Array.from({ length: MEMORY_RESIDENT_CAP + 3 }, (_, i) => entry(`第${i}条短记忆`, i))
    const mm = new MemoryManager()
    setHost(makeHost(memories))
    const ctx = await (mm as unknown as { buildMemoryContext(): Promise<string> }).buildMemoryContext()
    expect(ctx).toContain('- 第0条短记忆')
    expect(ctx).toContain(`- 第${MEMORY_RESIDENT_CAP - 1}条短记忆`)
    expect(ctx).not.toContain(`- 第${MEMORY_RESIDENT_CAP}条短记忆`)
    expect(ctx).toContain('(+3 older or longer memories not shown — search them with the memory_search tool.)')
  })

  it('全部超长时只剩指针行——档案的存在必须让模型知道', async () => {
    const long = '长'.repeat(MEMORY_ENTRY_MAX_CHARS + 5)
    const mm = new MemoryManager()
    setHost(makeHost([entry(long, 1, 'fact'), entry(long + '乙', 2, 'fact')]))
    const ctx = await (mm as unknown as { buildMemoryContext(): Promise<string> }).buildMemoryContext()
    expect(ctx).toContain('## Extracted Memories')
    expect(ctx).toContain('(+2 older or longer memories not shown — search them with the memory_search tool.)')
    expect(ctx).not.toContain('- ' + long)
  })

  it('manual 类型不进 Extracted 节；指针只数 extracted 型', async () => {
    const mm = new MemoryManager()
    setHost(makeHost([entry('用户手动的一条', 1, 'manual'), entry('自动提取的一条', 2)]))
    const ctx = await (mm as unknown as { buildMemoryContext(): Promise<string> }).buildMemoryContext()
    expect(ctx).toContain('- 自动提取的一条')
    expect(ctx).not.toContain('not shown') // 全渲染，无省略
  })
})

describe('合并门：总数帽 20（曾为 50，全量注入时代的遗产）', () => {
  it('MERGE_TOTAL_CAP = MEMORY_RESIDENT_CAP = 20', () => {
    expect(MemoryManager.MERGE_TOTAL_CAP).toBe(20)
    expect(MEMORY_RESIDENT_CAP).toBe(20)
  })

  it('水位新鲜（无新增）但总数超 20 → 仍触发归并', async () => {
    const saved: string[] = []
    const deleted: string[] = []
    // 30 天前的旧条目：相对 25h 前的 lastRunAt，added = 0 < 5——
    // 唯一能开门的就是总数帽（旧值 50 会让这次合并静默缺席）。
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const pool: MemoryEntry[] = Array.from({ length: MEMORY_RESIDENT_CAP + 1 }, (_, n) => ({
      id: `mem_${n}`, content: `记忆内容 ${n} 号`, type: 'auto', category: 'code', createdAt: old,
    } as MemoryEntry))
    const host = {
      listMemories: async () => pool,
      countMemories: async () => pool.length,
      saveMemory: async (input: { content: string }) => {
        saved.push(input.content)
        return { id: 'mem_x', content: input.content, type: 'auto', category: 'general', createdAt: new Date().toISOString() } as MemoryEntry
      },
      deleteMemory: async (id: string) => { deleted.push(id) },
    } as unknown as PulseHost
    const mm = new MemoryManager()
    setHost(host)
    mm.setConfig('key', 'https://example.invalid', {} as never, 'test-model')
    mm.setMergeWatermark({ lastRunAt: Date.now() - 25 * 60 * 60 * 1000, lastCount: 21 })
    const execute = vi.fn(async () => [] as Array<{ content: string; type: string; category: string }>)
    ;(mm as unknown as { compressionAgent: { execute: typeof execute } }).compressionAgent = { execute }

    await mm.ensureMemoryMerged()
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('主提取路径的结构兜底：超限条目不入库', () => {
  it('150 字的产出被丢，100 字内的产出照存（prompt 失守时的保证）', async () => {
    const saved: string[] = []
    const mm = new MemoryManager()
    setHost(makeHost([entry('既有记忆', 1)], saved))
    const execute = vi.fn(async () => ({
      memories: [
        { content: '短'.repeat(100), type: 'fact', category: 'general' },
        { content: '长'.repeat(MEMORY_ENTRY_MAX_CHARS + 50), type: 'fact', category: 'general' },
        { content: ' AB', type: 'fact', category: 'general' }, // <10 字，旧的长度下限
      ],
      summary: undefined,
      keywords: undefined,
      experience: null,
    }))
    ;(mm as unknown as { sessionReviewAgent: { execute: typeof execute } }).sessionReviewAgent = { execute }

    const result = await mm.extractAndSaveAll(
      [{ id: 'm1', role: 'user', contentBlocks: [{ type: 'text', text: '帮我把这个偏好记下来' }] }] as never,
      'key', 'https://example.invalid', {} as never, 'test-model',
    )

    expect(result.memories).toBe(1)
    expect(saved).toEqual(['短'.repeat(100)])
  })
})

describe('wiring 扫描：三条写路径的短句规则 + 检索通道', () => {
  it('SessionReviewAgent 的提取规则带 100 字帽与短句要求', () => {
    const src = read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')
    expect(src).toContain('at most 100 characters')
    expect(src).toContain('ONE short sentence')
    expect(src).toContain('experience record, not here')
  })

  it('MemoryCompressionAgent 的合并规则带同一顶帽', () => {
    const src = read('src/renderer/src/agent/one-shot-agent/MemoryCompressionAgent.ts')
    expect(src).toContain('at most 100 characters')
    expect(src).toContain('ONE short sentence')
    // 既有取向不回退：USER-EDITED 仍是第一条规则
    const rules = src.slice(src.indexOf('buildSystemPrompt'))
    expect(rules.indexOf('USER-EDITED memories are authoritative')).toBeGreaterThan(0)
  })

  it('打捞路径：prompt 带短句规则，保存循环带结构兜底（不再 slice(0, 2000)）', () => {
    const src = read('src/renderer/src/agent/engine/memory-extraction.ts')
    expect(src).toContain('at most 100 characters')
    expect(src).toContain('MEMORY_ENTRY_MAX_CHARS')
    expect(src).not.toContain('slice(0, 2000)')
    // 取向钉子不回退（memory-extraction-orientation.test.ts 的同款断言）
    expect(src).toContain('ONLY durable ENVIRONMENT and TOOL facts')
  })

  it('searchMemories 走 LIKE 全表扫，FTS MATCH 通路已摘除', () => {
    const src = read('src/main/storage/memory.db.ts')
    expect(src).toContain("LIKE ? ESCAPE '\\\\'") // 文件字节即 `ESCAPE '\\'`（模板字面量产出单反斜杠的 SQL 串）
    expect(src).toContain('escapeLikePattern')
    expect(src).not.toContain('memories_fts MATCH')
    expect(src).not.toContain('sanitizeFtsQuery')
  })

  it('merge 产物不受长度兜底——跳过会让其输入行被误删（丢内容）', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    const mergeBody = src.slice(src.indexOf('async ensureMemoryMerged'), src.indexOf('// Experience compression removed'))
    expect(mergeBody).not.toContain('MEMORY_ENTRY_MAX_CHARS')
  })
})

describe('escapeLikePattern（LIKE 通配符转义）', () => {
  it('普通中文原样通过', () => {
    expect(escapeLikePattern('字体')).toBe('字体')
    expect(escapeLikePattern('PPT 字体')).toBe('PPT 字体')
  })

  it('% _ \\ 三个 LIKE 活字被转义', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\')
  })
})
