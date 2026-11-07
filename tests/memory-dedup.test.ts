import { existsSync, readFileSync } from 'node:fs'
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

  it('wiring: 定时清扫是唯一提取调用点，minDelta 走 SWEEP_MIN_DELTA（PLAN-memory-wiki M2c）', () => {
    // afterSession（App.tsx）与启动回填（useChatController）均已退役
    expect(read(APP)).not.toContain('extractAndSaveAll')
    expect(read(CONTROLLER)).not.toContain('extractAndSaveAll')
    expect(read(SESSION_MANAGER)).toContain('SWEEP_MIN_DELTA }')
  })

  it('wiring: 记忆/经验开关经清扫的 featureFlags 下传，独立提取路径已不存在', () => {
    expect(read(SESSION_MANAGER)).toContain('{ memory: memoryOn, experience: experienceOn }')
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

describe('the page compile layer (M6, 取代 P2 合并层)', () => {
  it('watermark gates the compile; 旧机器全库无引用', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    expect(src).toContain('ensurePagesCompiled')
    expect(src).toContain('COMPILE_MIN_NEW')
    expect(src).toContain('COMPILE_MIN_INTERVAL_MS')
    for (const stale of ['ensureMemoryCompressed', 'ensureMemoryMerged', 'MERGE_MIN_NEW']) {
      expect(src).not.toContain(stale)
      expect(read(SESSION_MANAGER)).not.toContain(stale)
    }
    expect(existsSync(join(__dirname, '..', 'src/renderer/src/agent/one-shot-agent/MemoryCompressionAgent.ts'))).toBe(false)
  })
  it('the watermark rides settings.json and main persists it (空转修复语义移植)', () => {
    expect(read('src/shared/types/settings.ts')).toContain('memoryCompileWatermark')
    expect(read(SESSION_MANAGER)).toContain('runMemoryCompileSweep')
    // 裸尝试也落盘——否则每次重启把「从未尝试」当「从未编译」重打一遍
    const sm = read(SESSION_MANAGER)
    expect(sm).toContain('lastRunAt: new Date(w.lastRunAt).toISOString()')
    expect(sm).toContain('lastAttemptAt')
    // 渲染侧无触发（单 owner）；编译调用只在主进程 sweep
    expect(read(APP)).not.toContain('ensurePagesCompiled')
    expect(sm).toContain('memoryManager.ensurePagesCompiled()')
  })
})
