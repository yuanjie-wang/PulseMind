import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import { MemoryManager } from '../src/renderer/src/memory/MemoryManager'
import { buildSystemPrompt } from '../src/renderer/src/agent/system-prompt-builder'
import type { MemoryEntry } from '../src/renderer/src/memory/types'

/**
 * 记忆注入的反向钉（PLAN-memory-wiki M4，2026-10-25）——取代 2026-09-26 的
 * 双 3h TTL 裁定：提取产物（记忆页/经验/近期会话）不再进 system prompt，
 * 唯一曝光面是 memory_search 等检索工具；核心因此永久字节稳定——
 * 记忆数据任意变化，core 逐字节不变。残余的动态节只有 MEMORY.md
 * （用户手写 = 永远在场），字节仅在用户编辑时变化。
 */

const read = (p: string) => readFileSync(p, 'utf-8')

function makeHost(memoryMd: string, memories: MemoryEntry[]) {
  const host = {
    getMemoryMd: async () => memoryMd,
    listMemories: async () => [...memories],
    listConversationsForMemory: async () => [],
  }
  setHost(host as unknown as PulseHost)
  return { memories }
}

function entry(content: string, n: number): MemoryEntry {
  return { id: `mem_${n}`, content, type: 'auto', category: 'code', createdAt: new Date().toISOString() } as MemoryEntry
}

const baseOpts = {
  locale: 'zh' as const,
  platformInfo: { platform: 'darwin' },
}

describe('getManualMemoryContext（残余动态节 = MEMORY.md 直读）', () => {
  it('MEMORY.md 内容以 # Manual Memories 包裹注入', async () => {
    makeHost('用户偏好简洁回答。', [])
    const mm = new MemoryManager()
    expect(await mm.getManualMemoryContext()).toBe('# Manual Memories\n\n用户偏好简洁回答。')
  })

  it('空文件 / 空白文件 → 空串（不产出空节）', async () => {
    makeHost('   \n  ', [])
    expect(await new MemoryManager().getManualMemoryContext()).toBe('')
  })

  it('master switch off 立即空串（不读文件）', async () => {
    const host = { getMemoryMd: async () => { throw new Error('must not be read') } }
    setHost(host as unknown as PulseHost)
    const mm = new MemoryManager()
    mm.setPreferences({ autoInjectEnabled: false })
    expect(await mm.getManualMemoryContext()).toBe('')
  })
})

describe('core 永久字节稳定（记忆变化零影响）——JIT 化的收益验收', () => {
  const buildCore = async (memoryMd: string, memories: MemoryEntry[]) => {
    makeHost(memoryMd, memories)
    const mm = new MemoryManager()
    const result = await buildSystemPrompt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts: { ...baseOpts, memoryManager: mm } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [] as any,
    })
    return result.systemPrompt
  }

  it('记忆/经验数据任意变化，core 逐字节相同（动态注入三件套不复存在）', async () => {
    const a = await buildCore('固定的手动记忆。', [entry('旧记忆A', 1)])
    const b = await buildCore('固定的手动记忆。', [entry('完全不同的记忆B', 2), entry('再多一条', 3)])
    expect(a).toBe(b)
    for (const banned of ['# Memory Context', '## Extracted Memories', '## Recent Conversations', '## Experience Index', 'Available past experiences']) {
      expect(a).not.toContain(banned)
    }
    expect(a).toContain('## Local Knowledge & Memory')
    expect(a).toContain('# Manual Memories')
  })

  it('MEMORY.md 变化只改手动节，其余字节不动（用户编辑的合法影响面）', async () => {
    const a = await buildCore('旧的手动记忆。', [entry('记忆A', 1)])
    const b = await buildCore('新的手动记忆。', [entry('记忆A', 1)])
    expect(a).not.toBe(b)
    const stripManual = (s: string) => s.replace(/# Manual Memories\n\n[\s\S]*?(?=\n#{1,2} )/, '# Manual Memories\n\n<STRIPPED>')
    expect(stripManual(a)).toBe(stripManual(b))
  })
})

describe('接线退役扫描（双钟 TTL / 驻留视图 / 经验索引全部下线）', () => {
  it('MemoryManager：TTL 常量、快照/pin 字段、驻留渲染三方法已删', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    for (const banned of [
      'MEMORY_CONTEXT_GLOBAL_TTL_MS', 'memoryContextSnapshot', 'memoryContextPins',
      'getStableMemoryContext', 'buildMemoryContext', 'getExtractedMemoriesContent', 'getRecentSessionContext',
    ]) {
      expect(src).not.toContain(banned)
    }
  })

  it('builder：不消费经验索引/双钟快照；matchExperiences v2 已回归（E6）但 core 仍零动态节', () => {
    const src = read('src/renderer/src/agent/system-prompt-builder.ts')
    expect(src).not.toContain('buildNameIndex')
    expect(src).not.toContain('getStableMemoryContext')
    expect(src).toContain('matchExperiences')  // E6：经验 hint 回归 state block（v2）
    // core 的注入面只允许：静态协议节 + MEMORY.md（hint 骑 state block 不进 core）
    const coreManual = src.slice(src.indexOf('if (opts.memoryManager) {'), src.indexOf('const toolAppendix'))
    expect(coreManual).toContain('getManualMemoryContext')
    expect(coreManual).not.toContain('matchExperiences')
    expect(src).toContain('LOCAL_KNOWLEDGE_MEMORY_SECTION')
    const section = src.slice(src.indexOf('const LOCAL_KNOWLEDGE_MEMORY_SECTION'), src.indexOf('concluding the store has nothing'))
    expect(section).not.toContain('${')
  })
})
