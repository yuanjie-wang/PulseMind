import { describe, expect, it, vi } from 'vitest'
import { ContextCompactor } from '../src/renderer/src/agent/engine/context-compactor'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'
import type { CompactionEvent } from '../src/shared/agent-protocol'

// ── Fixtures ──────────────────────────────────────────────────────────

let seq = 0
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const turn = (t: string): AgentMessage[] => [
  { id: `u${++seq}`, role: 'user', contentBlocks: [text(t)], createdAt: '2026-09-23T10:00:00.000Z' },
  { id: `a${++seq}`, role: 'assistant', contentBlocks: [text(`回复：${t}`)], createdAt: '2026-09-23T10:00:01.000Z' },
]

/** A conversation long enough that BOTH hard shapes drop a real region against
 *  a 500-token window: the prewarm's forced simulation (0.6× = 300) and the
 *  request path's passive trigger (0.9× = 450). 50 messages × ~11.5 ≈ 575
 *  tokens — the old 15-turn fixture sat below 450, where the fixed walk now
 *  (correctly) keeps everything, and the request-path half of these contracts
 *  had nothing real to pin. */
function makeConversation(): AgentMessage[] {
  return Array.from({ length: 25 }, (_, i) => turn(`第${i + 1}轮的完整需求描述`).flat()).flat() as AgentMessage[]
}

function makeCompactor(messages: AgentMessage[], summary = '摘要内容') {
  const runHistorySummary = vi.fn(async (_regionText: string, _instruction?: string) => summary)
  const compactor = new ContextCompactor({
    runHistorySummary,
    getMessages: () => messages,
  })
  return { compactor, runHistorySummary }
}

/**
 * 差距分析 P0-1（2026-09-23）：压缩里贵的不是丢弃，是摘要那次 LLM 调用——它在
 * 请求路径上同步阻塞下一回合。prewarm 把这次调用挪到回合末的空闲窗口，这里钉住
 * 它的四个契约：摘要落进缓存（下次请求零 LLM）、事件数字真实、nano 压缩标记
 * 还原（预热的副本是丢弃的）、小会话直接 no-op。
 */
describe('compactor.prewarm: the summary moves off the request path', () => {
  it('seeds the cache so the next injectHistorySummary is a zero-LLM cache hit', async () => {
    const messages = makeConversation()
    const { compactor, runHistorySummary } = makeCompactor(messages)

    const event = await compactor.prewarm({ contextLength: 500, source: 'post-turn' })
    expect(event).not.toBeNull()
    expect(event!.source).toBe('post-turn')
    expect(runHistorySummary).toHaveBeenCalledTimes(1)
    expect(compactor.getHistorySummary()?.text).toBe('摘要内容')

    // The request path later: same frontier → cache hit, no second LLM call.
    // The copy reads chronologically: the dropped region's user replays first,
    // then the summary, then the kept tail.
    const light = compactor.lightCompact(messages, 500, 0)
    const truncated = compactor.hardTruncate(light, 500, 0)
    const final = await compactor.injectHistorySummary(messages, truncated)
    expect(runHistorySummary).toHaveBeenCalledTimes(1) // still once
    const summaryIdx = final.findIndex((m) =>
      (m.contentBlocks[0] as { text: string }).text.includes('【历史对话摘要】'))
    expect(summaryIdx).toBeGreaterThan(0) // replays precede it
    expect(final.length).toBe(truncated.length + 1 + summaryIdx)
    expect(final.slice(final.length - truncated.length)).toEqual(truncated) // tail untouched
  })

  it('reports real numbers and rides the summary only when it changed', async () => {
    const messages = makeConversation()
    const { compactor } = makeCompactor(messages)
    const event = (await compactor.prewarm({ contextLength: 500, source: 'post-turn' }))!
    expect(event.strategies).toContain('hard')
    expect(event.strategies).toContain('summary')
    expect(event.droppedMessages).toBeGreaterThan(0)
    expect(event.replayedUserMessages).toBeGreaterThan(0)
    expect(event.tokensBefore).toBeGreaterThan(event.tokensAfter)
    expect(event.summary?.text).toBe('摘要内容')

    // A second prewarm at the same frontier: the cache is warm, the summary
    // did NOT change → the event must not re-ship the text.
    const second = await compactor.prewarm({ contextLength: 500, source: 'post-turn' })
    expect(second?.summary).toBeUndefined()
  })

  it('carries the /compact instruction into the summary call', async () => {
    const messages = makeConversation()
    const { compactor, runHistorySummary } = makeCompactor(messages)
    await compactor.prewarm({ contextLength: 500, source: 'manual', instruction: '重点保留所有决策与理由' })
    expect(runHistorySummary).toHaveBeenCalledWith(expect.any(String), '重点保留所有决策与理由', 'region')
  })

  it('restores nanoCompact marks: the prewarmed copy is discarded', async () => {
    const messages = makeConversation()
    const { compactor } = makeCompactor(messages)
    const marks = (compactor as unknown as { _compressedToolUseIds: Set<string> })._compressedToolUseIds
    marks.add('sentinel-id')
    await compactor.prewarm({ contextLength: 500, source: 'post-turn' })
    // If prewarm's virtual nano pass leaked its marks, the real request's nano
    // would skip exactly those blocks and the copy would silently re-inflate.
    expect((compactor as unknown as { _compressedToolUseIds: Set<string> })._compressedToolUseIds.has('sentinel-id')).toBe(true)
    expect((compactor as unknown as { _compressedToolUseIds: Set<string> })._compressedToolUseIds.size).toBe(1)
  })

  it('no-ops on a small conversation and serializes concurrent prewarms', async () => {
    const small = turn('只有一轮').flat() as AgentMessage[]
    const { compactor } = makeCompactor(small)
    expect(await compactor.prewarm({ contextLength: 500, source: 'post-turn' })).toBeNull()

    const { compactor: busy } = makeCompactor(makeConversation())
    let release: (v: string) => void = () => {}
    const gate = new Promise<string>((r) => { release = r })
    const slow = vi.fn(async () => { await gate; return '慢摘要' })
    const gated = new ContextCompactor({ runHistorySummary: slow, getMessages: () => makeConversation() })
    const first = gated.prewarm({ contextLength: 500, source: 'post-turn' })
    const second = await gated.prewarm({ contextLength: 500, source: 'manual' })
    expect(second).toBeNull() // in-flight guard
    release('慢摘要')
    expect((await first)?.source).toBe('post-turn')
    expect(slow).toHaveBeenCalledTimes(1)
    void busy
  })

  // review0924 M2, first half: the user's next message lands INSIDE the
  // prewarm's LLM window (that's why the prewarm exists), and the request
  // path's injectHistorySummary must wait out the in-flight summary instead
  // of racing a second concurrent one-shot call.
  it('a request-path injectHistorySummary waits out an in-flight prewarm — one LLM summary, not two', async () => {
    const messages = makeConversation()
    let release: (v: string) => void = () => {}
    const gate = new Promise<string>((r) => { release = r })
    const slow = vi.fn(async () => { await gate; return '慢摘要' })
    const compactor = new ContextCompactor({ runHistorySummary: slow, getMessages: () => messages })

    const prewarmRun = compactor.prewarm({ contextLength: 500, source: 'post-turn' })
    const light = compactor.lightCompact(messages, 500, 0)
    const truncated = compactor.hardTruncate(light, 500, 0)
    const requestPath = compactor.injectHistorySummary(messages, truncated)
    await new Promise((r) => setTimeout(r, 10))
    expect(slow).toHaveBeenCalledTimes(1) // only the prewarm's call so far
    release('慢摘要')
    const [event, final] = await Promise.all([prewarmRun, requestPath])
    expect(event).not.toBeNull()
    expect(slow).toHaveBeenCalledTimes(1) // the request reused it — still once
    expect(compactor.getHistorySummary()?.text).toBe('慢摘要')
    expect(final.some((m) => (m.contentBlocks[0] as { text?: string }).text?.includes('【历史对话摘要】'))).toBe(true)
  })

  // review0924 M2, second half: the finally restores the pre-warm marks but
  // MERGES in what a request wrote while the prewarm was suspended — a whole
  // restore erased the interleaved request's nano marks (benign only through
  // placeholder re-derivation + the double tool_result_id).
  it('keeps marks a request wrote while the prewarm was suspended, still discards the prewarm\'s own', async () => {
    const messages = makeConversation()
    let release: (v: string) => void = () => {}
    const gate = new Promise<string>((r) => { release = r })
    const slow = vi.fn(async () => { await gate; return '慢摘要' })
    const compactor = new ContextCompactor({ runHistorySummary: slow, getMessages: () => messages })
    const marks = (compactor as unknown as { _compressedToolUseIds: Set<string> })._compressedToolUseIds

    const prewarmRun = compactor.prewarm({ contextLength: 500, source: 'post-turn' })
    marks.add('interleaved-request-mark') // a request interleaving during the await
    release('慢摘要')
    await prewarmRun
    expect(marks.has('interleaved-request-mark')).toBe(true) // survives the merge
    expect(marks.size).toBe(1) // and nothing of the prewarm's leaked out
  })
})

// ── Engine wiring: post-turn trigger + /compact ───────────────────────

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { setHost } = await import('../src/renderer/src/agent/host')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

function makeEngine(contextLength: number, onCompaction?: (e: CompactionEvent) => void): InstanceType<typeof AgentEngine> {
  return new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    contextLength,
    myName: 'tester', soul: '', yourName: 'user',
    adapter: {} as never,
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    conversationId: 'conv_compaction_preheat',
  } as unknown as AgentEngineOptions, { onCompaction })
}

function stubCompactor(engine: InstanceType<typeof AgentEngine>, usage: number, event: CompactionEvent | null) {
  const prewarm = vi.fn(async () => event)
  ;(engine as unknown as { compactor: unknown }).compactor = {
    contextTokens: () => usage,
    prewarm,
  }
  return prewarm
}

const compactionEvent = (): CompactionEvent => ({
  ts: Date.now(), source: 'post-turn', strategies: ['hard', 'summary'],
  droppedMessages: 12, replayedUserMessages: 5, tokensBefore: 80_000, tokensAfter: 30_000,
  summary: { firstKeptId: 'u1', text: '摘要' },
})

describe('engine: post-turn prewarm trigger', () => {
  it('prewarms and emits when usage crosses the post-turn ratio', async () => {
    const seen: CompactionEvent[] = []
    const engine = makeEngine(1000, (e) => seen.push(e))
    const prewarm = stubCompactor(engine, 800, compactionEvent()) // 800 ≥ 750
    engine.schedulePostTurnCompaction()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(prewarm).toHaveBeenCalledWith({ contextLength: 1000, source: 'post-turn', instruction: undefined })
    expect(seen[0].droppedMessages).toBe(12)
  })

  it('stays idle below the ratio, for spawned sub-agents, and while manual is armed', async () => {
    const engine = makeEngine(1000)
    const below = stubCompactor(engine, 700, compactionEvent()) // 700 < 750
    engine.schedulePostTurnCompaction()
    await new Promise((r) => setTimeout(r, 0))
    expect(below).not.toHaveBeenCalled()

    const spawned = makeEngine(1000)
    ;(spawned as unknown as { isSpawnedSubAgent: boolean }).isSpawnedSubAgent = true
    const spawnedPrewarm = stubCompactor(spawned, 900, compactionEvent())
    spawned.schedulePostTurnCompaction()
    await new Promise((r) => setTimeout(r, 0))
    expect(spawnedPrewarm).not.toHaveBeenCalled()

    const manual = makeEngine(1000)
    ;(manual as unknown as { manualCompactActive: boolean }).manualCompactActive = true
    const manualPrewarm = stubCompactor(manual, 900, compactionEvent())
    manual.schedulePostTurnCompaction()
    await new Promise((r) => setTimeout(r, 0))
    expect(manualPrewarm).not.toHaveBeenCalled()
  })

  it('fires from handleEndTurnResponse — the clean boundary', () => {
    const engine = makeEngine(1000)
    const prewarm = stubCompactor(engine, 900, compactionEvent())
    engine.messages = [
      { id: 'u1', role: 'user', contentBlocks: [text('任务')], createdAt: '2026-09-23T10:00:00.000Z' },
      { id: 'a1', role: 'assistant', contentBlocks: [text('完成')], createdAt: '2026-09-23T10:00:05.000Z' },
    ]
    engine.handleEndTurnResponse('end_turn')
    expect(prewarm).toHaveBeenCalledTimes(1)
  })

  it('/compact arms the sticky force, prewarms with the instruction, and refuses mid-turn', async () => {
    const engine = makeEngine(1000, () => {})
    const manualEvent = { ...compactionEvent(), source: 'manual' } as CompactionEvent
    const prewarm = stubCompactor(engine, 500, manualEvent)
    const event = await engine.compactNow('保留所有决策')
    expect(event?.source).toBe('manual')
    expect(prewarm).toHaveBeenCalledWith({ contextLength: 1000, source: 'manual', instruction: '保留所有决策' })
    // The force must survive across requests — the triggers are stateless and
    // re-read the full live history each time, so a one-shot force would
    // re-inflate the very next copy.
    expect((engine as unknown as { manualCompactActive: boolean }).manualCompactActive).toBe(true)

    engine.agentStatus = { status: 'streaming' }
    const busyPrewarm = stubCompactor(engine, 500, null)
    await expect(engine.compactNow()).resolves.toBeNull()
    expect(busyPrewarm).not.toHaveBeenCalled()
  })
})
