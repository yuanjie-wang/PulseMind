import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeMemoryContent, memoryContentHash, sha256Hex } from '../src/shared/memory/content-hash'

const ENGINE = 'src/renderer/src/agent/engine/memory-extraction.ts'
const AGENT_ENGINE = 'src/renderer/src/agent/AgentEngine.ts'
const EXEC_FLOW = 'src/renderer/src/agent/engine/execution-flow.ts'
const STREAM_RUNNER = 'src/renderer/src/agent/engine/stream-runner.ts'
const CONTROLLER = 'src/renderer/src/hooks/useChatController.ts'
const APP = 'src/renderer/src/App.tsx'
const SESSION_MANAGER = 'src/main/agent/session-manager.ts'
const MEMORY_DB = 'src/main/storage/memory.db.ts'
const read = (p: string): string => readFileSync(p, 'utf-8')

describe('content hash (P0 #4)', () => {
  it('whitespace folds, case is preserved', () => {
    expect(normalizeMemoryContent('  用户偏好   深色\n主题  ')).toBe('用户偏好 深色 主题')
    expect(memoryContentHash('A')).not.toBe(memoryContentHash('a'))
  })

  it('SHA-256 matches published vectors (a broken implementation must not pass silently)', () => {
    // NIST/RFC vectors
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // identical normalized content → identical hash
    expect(memoryContentHash('  相同   内容\n')).toBe(memoryContentHash('相同 内容'))
  })
})

describe('the loop no longer spends LLM calls on memory (P0 #1)', () => {
  it('prepareLoopRequest carries no extraction call and scheduleMemoryExtraction is gone', () => {
    expect(read(AGENT_ENGINE)).not.toContain('scheduleMemoryExtraction')
    expect(read(ENGINE)).not.toContain('MEM_EXTRACTION_COOLDOWN')
    expect(read('src/renderer/src/agent/engine/engine-constants.ts')).not.toContain('MEM_EXTRACTION_COOLDOWN')
  })

  it('the turn-end salvage is wired at all three afterSession points and gated', () => {
    for (const file of [EXEC_FLOW, STREAM_RUNNER, AGENT_ENGINE]) {
      expect(read(file)).toContain('runTurnEndMemoryExtraction(')
    }
    const src = read(ENGINE)
    // gate order: in-progress, sub-agent, conversation, pref, per-session cap, pressure
    expect(src).toContain('if (engine._memExtractionInProgress) return')
    expect(src).toContain('if (engine.spawnSystemPrompt) return')
    expect(src).toContain('if (engine._memSalvageCount >= MEM_SALVAGE_MAX_PER_SESSION) return')
    expect(src).toContain('MEM_SALVAGE_CONTEXT_RATIO')
  })

  it('extracted pairs are marked and marked pairs are skipped — never via autoSummary', () => {
    const src = read(ENGINE)
    expect(src).toContain('memExtracted')
    expect(src).not.toContain('autoSummary || next.autoSummary) continue\n      }\n      if (i') // regression guard only
  })
})

describe('the extraction idempotence machine (mock engine, real extraction module)', () => {
  // A mock engine shaped like EngineCore, with a COUNTING adapter: the whole
  // point is that the second run issues ZERO LLM calls after the first run
  // marked its pairs.
  function makeEngine(overrides: Partial<Record<string, unknown>> = {}) {
    const llmCalls = 0
    const pair = (i: number): { assistant: any; user: any } => ({
      assistant: { id: `a${i}`, role: 'assistant', contentBlocks: [{ type: 'text', text: `reasoning ${i}` }, { type: 'tool_use', name: 'read', id: `t${i}` }] },
      user: { id: `u${i}`, role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `result ${i}` }] },
    })
    const messages: any[] = []
    for (let i = 0; i < (overrides.messagePairCount ?? 8); i++) {
      const p = pair(i)
      messages.push(p.assistant, p.user)
    }
    const engine = {
      messages,
      spawnSystemPrompt: null,
      opts: {
        conversationId: 'conv_test',
        contextLength: 128000,
        apiKey: 'k',
        baseURL: 'https://x',
        model: 'm',
        memoryManager: { getPreferences: () => ({ autoCaptureEnabled: true }) },
      },
      compactor: { contextTokens: () => 200000 }, // ≥90% of 128k
      _memExtractionInProgress: false,
      _memSalvageCount: 0,
      callCount: () => llmCalls,
      ...overrides,
    }
    return engine
  }

  it('a fully-marked batch costs zero LLM calls on re-run; the window ADVANCES past marked pairs', async () => {
    vi.resetModules()
    const hostMod = await import('../src/renderer/src/agent/host')
    hostMod.setHost({
      saveMemory: async () => ({}),
    } as never)
    const { extractMemoriesFromOldToolPairs } = await import('../src/renderer/src/agent/engine/memory-extraction')
    let calls = 0
    const countingAdapter = {
      callNonStreaming: async () => {
        calls++
        return JSON.stringify([{ content: '用户偏好把测试放在共享层', type: 'preference', category: 'user_pref' }])
      },
    }

    // Exactly MAX pairs: the first pass mines and marks ALL of them, so a
    // second pass over the same material has nothing left — zero calls.
    // (载荷事实 1 of the plan: marking prevents re-mining the SAME pairs;
    // the in-loop trigger was deleted precisely because the window would
    // otherwise advance to fresh pairs every 30s.)
    const capped = makeEngine({ messagePairCount: 5 }) // 5 pairs → exactly 3 pass the tail guard
    ;(capped.opts as any).adapter = countingAdapter
    await extractMemoriesFromOldToolPairs(capped as never)
    expect(calls).toBe(1)
    expect(capped.messages.filter((m) => m.memExtracted).length).toBe(6) // 3 pairs × 2
    await extractMemoriesFromOldToolPairs(capped as never)
    expect(calls).toBe(1)

    // More pairs than the cap: the window ADVANCES — the next pass mines the
    // NEXT batch, never the old ones again.
    const advancing = makeEngine({ messagePairCount: 9 })
    ;(advancing.opts as any).adapter = countingAdapter
    await extractMemoriesFromOldToolPairs(advancing as never)
    const firstBatchIds = new Set(advancing.messages.filter((m) => m.memExtracted).map((m) => m.id))
    await extractMemoriesFromOldToolPairs(advancing as never)
    const secondBatchIds = advancing.messages.filter((m) => m.memExtracted).map((m) => m.id)
    expect(secondBatchIds.some((id) => !firstBatchIds.has(id))).toBe(true)
  })

  it('the per-session salvage cap (3) holds and the pressure gate blocks low-context runs', async () => {
    vi.resetModules()
    const { runTurnEndMemoryExtraction } = await import('../src/renderer/src/agent/engine/memory-extraction')
    const engine = makeEngine({ messagePairCount: 30 })
    ;(engine.opts as any).adapter = { callNonStreaming: async () => '[]' }
    const flush = () => new Promise((r) => setTimeout(r, 0))
    // Salvage is fire-and-forget and holds the in-progress flag while its LLM
    // call runs — the drain between calls is what a real turn end provides.
    for (let i = 0; i < 5; i++) {
      runTurnEndMemoryExtraction(engine as never)
      await flush()
    }
    expect(engine._memSalvageCount).toBe(3)

    const relaxed = makeEngine({ compactor: { contextTokens: () => 1000 } })
    runTurnEndMemoryExtraction(relaxed as never)
    expect(relaxed._memSalvageCount).toBe(0)
  })
})

describe('extraction backoff + minDelta (P0 #5 / P1 #6)', () => {
  it('the backoff state machine: failure sets, 1h refuses, success clears, 3 retires', async () => {
    vi.resetModules()
    const { MemoryManager } = await import('../src/renderer/src/memory/MemoryManager')
    const mm = new MemoryManager()
    // private field access via any — the state machine is the contract
    const backoff = (mm as any).extractionBackoff as Map<string, { failedAt: number; attempts: number }>
    backoff.set('c1', { failedAt: Date.now(), attempts: 1 })
    expect(mm.isInBackoff('c1')).toBe(true)
    backoff.set('c1', { failedAt: Date.now() - 2 * 60 * 60 * 1000, attempts: 1 })
    expect(mm.isInBackoff('c1')).toBe(false) // window expired
    backoff.set('c2', { failedAt: Date.now(), attempts: 3 })
    expect(mm.isInBackoff('c2')).toBe(true) // retired for the process run
  })

  it('wiring: both afterSession hosts pass minDelta=4, the backfill passes 1', () => {
    expect(read(APP)).toContain('{ minDelta: 4 }')
    expect(read(SESSION_MANAGER)).toContain('{ minDelta: 4 }')
    expect(read(CONTROLLER)).toContain('{ minDelta: 1 }')
  })

  it('wiring: the backfill runs extractAndSaveAll with memory off, and extractAndSaveExperiences is gone', () => {
    expect(read(CONTROLLER)).toContain('{ memory: false, experience: true }')
    expect(read('src/renderer/src/memory/MemoryManager.ts')).not.toContain('extractAndSaveExperiences(')
    expect(read('src/renderer/src/memory/MemoryManager.ts')).not.toContain('new ExperienceAgent()')
  })
})

describe('the DB-layer dedup gate (P0 #4 wiring)', () => {
  it('saveMemory hashes before insert and skips on a hit', () => {
    const src = read(MEMORY_DB)
    expect(src).toContain('memoryContentHash(content)')
    expect(src).toContain("SELECT id FROM memories WHERE content_hash = ? LIMIT 1")
  })
  it('database.ts backfills the hash for existing rows', () => {
    const src = read('src/main/storage/database.ts')
    expect(src).toContain("ALTER TABLE memories ADD COLUMN content_hash TEXT")
    expect(src).toContain('idx_memories_content_hash')
    expect(src).toContain('memoryContentHash(row.content)')
  })
})

describe('the incremental merge layer (P2)', () => {
  it('the >50 delete-all rewrite is gone; the watermark gates the merge', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    expect(src).not.toContain('ensureMemoryCompressed')
    expect(src).toContain('ensureMemoryMerged')
    expect(src).toContain('MERGE_MIN_NEW')
    expect(src).toContain('MERGE_MIN_INTERVAL_MS')
    // user-edited rows survive unconditionally
    expect(src).toContain('userEdited')
  })
  it('the watermark rides settings.json and main persists it', () => {
    expect(read('src/shared/types/settings.ts')).toContain('memoryMergeWatermark')
    expect(read(SESSION_MANAGER)).toContain('runMemoryMergeSweep')
    // 2026-09-26 空转修复：持久化形状带上 lastAttemptAt（失败/空尝试的时钟），
    // 且裸尝试也要落盘——否则每次重启都会把「从未尝试」当成「从未合并」重打一遍。
    const sm = read(SESSION_MANAGER)
    expect(sm).toContain('lastRunAt: new Date(w.lastRunAt).toISOString()')
    expect(sm).toContain('lastAttemptAt: new Date(w.lastAttemptAt).toISOString()')
    expect(sm).toContain('lastAttemptAt: w?.lastAttemptAt ? new Date(w.lastAttemptAt).getTime() : 0')
  })
  it('every caller uses the new name — a stale call crashes the app, not the test', () => {
    // App.tsx's startup compression effect kept calling the deleted
    // ensureMemoryCompressed() after the rename: with no API key the effect
    // returned early, so the TypeError only surfaced once a key resolved —
    // as a white screen on boot. Scan ALL of src/, not just the class file.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name)
        if (e.isDirectory()) return walk(p)
        return /\.tsx?$/.test(p) ? [p] : []
      })
    const stale = walk('src').filter((f) => read(f).includes('ensureMemoryCompressed'))
    expect(stale).toEqual([])
    expect(read(APP)).toContain('memoryManager.ensureMemoryMerged()')
  })
})
