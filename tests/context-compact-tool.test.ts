// context_compact — the model-initiated compaction tool (PLAN-context-compact-tool,
// user rulings 2026-10-01 ×2). Two-power split: the model drives nano (free_results
// mandated picks) and light (main action = prewarm with instruction/notes); hard +
// emergency stay agent-side. The pins below are the ones the plan calls out by name:
//   - guard matrix ①streaming ②once-per-turn ③<55% (with the just-above-line pass)
//     ④nothing-to-drop — and free_results-only exempt from ②③
//   - success: event source='tool', the one-shot force bypasses ONLY light
//     (lightCompact sees force=true, hardTruncate force=false, consumed exactly once),
//     notes verbatim in the summary message AND the cache text, notes survive a
//     failed summarizer (notesKept)
//   - mandated ≠ marks, both directions: a mandated id stays a placeholder across
//     requests while a quota-compressed (marked) id re-inflates; TIER3 / protection
//     window / unknown ids are skipped and reported; idempotent
//   - simulation == materialization: the prewarm's droppedCount pairs with the next
//     request build's actual drop
//   - live history untouched (the compaction only ever sees API copies)
//   - reset / prepareTurn clear the per-turn bit and the mandated ids
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Same HOME sandbox as auto-mode-phantom-approval.test.ts — the engine import
// chain touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-context-compact-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { AgentEngineOptions, AgentEngineCallbacks } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ContentBlock, ToolResultBlock, ToolUseBlock } from '../src/renderer/src/types/agent'
import type { CompactionEvent } from '../src/shared/agent-protocol/payloads'

/** Construction-time cache warming pokes the host; nothing here needs it. */
const { setHost } = await import('../src/renderer/src/agent/host')
setHost(new Proxy({}, { get: () => () => Promise.resolve([] as unknown[]) }) as never)

const NOW = '2026-10-01T10:00:00.000Z'
const RESULT_CHARS = 1500

function userText(id: string, text: string): AgentMessage {
  return { id, role: 'user', contentBlocks: [{ type: 'text', text } as ContentBlock], createdAt: NOW }
}

/** One read cycle: assistant tool_use → user tool_result. Tier 2 in nanoCompact's
 *  map (read), so TIER_SIZES[2]=20 and the quota fires at 40+ uses. */
function toolCycle(i: number, resultChars = RESULT_CHARS): [AgentMessage, AgentMessage] {
  const tu: ToolUseBlock = { type: 'tool_use', id: `tu_${i}`, name: 'read', input: { file_path: `f${i}.txt` }, status: 'completed' }
  const tr: ToolResultBlock = { type: 'tool_result', tool_use_id: `tu_${i}`, content: 'x'.repeat(resultChars), tool_result_id: `tr_${i}`, is_error: false }
  return [
    { id: `a_${i}`, role: 'assistant', contentBlocks: [tu], createdAt: NOW },
    { id: `u_${i}`, role: 'user', contentBlocks: [tr], createdAt: NOW },
  ]
}

interface MakeEngineOpts {
  contextLength?: number
  cycles?: number
  spawnedToolset?: boolean
  onCompaction?: (e: CompactionEvent) => void
}

function makeEngine(o: MakeEngineOpts = {}): InstanceType<typeof AgentEngine> {
  const messages: AgentMessage[] = [userText('u_start', '跑一个长任务')]
  for (let i = 0; i < (o.cycles ?? 45); i++) {
    const [a, u] = toolCycle(i)
    messages.push(a, u)
  }
  const callbacks: AgentEngineCallbacks = {}
  if (o.onCompaction) callbacks.onCompaction = o.onCompaction
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    contextLength: o.contextLength ?? 100_000,
    myName: 'tester', soul: '', yourName: 'user',
    // buildRequest captures the built copy; nothing streams (continueLoop stubbed).
    adapter: {
      buildRequest: (_base: string, _key: string, req: { messages: AgentMessage[] }) => {
        ;(engineBodies as AgentMessage[][]).push(req.messages)
        return { url: 'https://example.invalid/v1/chat/completions', headers: {}, body: { messages: req.messages } }
      },
      reconcileMessages: () => {},
    } as never,
    toolManager: new ToolManager() as never, skillManager: new SkillManager() as never,
    spawnedToolset: o.spawnedToolset,
  } as unknown as AgentEngineOptions, callbacks)
  engine.messages = messages
  engine.continueLoop = async (): Promise<void> => {}
  // Deterministic summarizer: the pipeline's one LLM call lands instantly.
  ;(engine as unknown as { runHistorySummary: unknown }).runHistorySummary = async () => '【摘要】测试摘要文本'
  return engine
}

/** Built request copies, newest last (the fake adapter appends). */
const engineBodies: AgentMessage[][] = []

function resultContentOf(copy: AgentMessage[], tuId: string): string | undefined {
  return copy.flatMap(m => m.contentBlocks).find((b): b is ToolResultBlock => b.type === 'tool_result' && b.tool_use_id === tuId)?.content
}

beforeEach(() => { engineBodies.length = 0 })

describe('guards ①—④ (main action only; free_results exempt from ②③)', () => {
  it('① streaming refuses with request_in_flight', async () => {
    const engine = makeEngine({ cycles: 3, contextLength: 1000 })
    engine.agentStatus = { status: 'streaming' }
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'request_in_flight' })
    engine.agentStatus = { status: 'retrying' }
    expect((await engine.compactForTool({})).reason).toBe('request_in_flight')
    // executing (tool execution, no request in flight) is the sanctioned moment;
    // the 7-message history passes ③ but nothing is droppable below MIN_KEEP.
    engine.agentStatus = { status: 'executing' }
    expect((await engine.compactForTool({})).reason).toBe('nothing_to_drop')
  })

  it('② already used this turn refuses', async () => {
    const engine = makeEngine()
    engine.toolCompactUsedThisTurn = true
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'already_this_turn' })
  })

  it('③ below 55% refuses with readings; exactly at the line passes the guard', async () => {
    const engine = makeEngine({ cycles: 2 })
    const spy = vi.spyOn(engine.compactor, 'contextTokens').mockReturnValue(549)
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'not_worthwhile', tokens: 549, window: 100_000 })
    // Just above the line — note 100_000 * 0.55 is 55000.000…007 in floats, so
    // "exactly at the line" needs one token over: the guard passes and the
    // failure below is a DIFFERENT guard (nothing to drop on a tiny history).
    spy.mockReturnValue(55_001)
    const out2 = await engine.compactForTool({})
    expect(out2.reason).toBe('nothing_to_drop')
    spy.mockRestore()
  })

  it('④ nothing to drop: prewarm null lands as nothing_to_drop', async () => {
    // 7 messages pass ③ (fat results vs a 1000-token window) but sit below the
    // prewarm's MIN_KEEP floor — the pipeline never runs, nothing drops.
    const engine = makeEngine({ cycles: 3, contextLength: 1000 })
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'nothing_to_drop' })
  })

  it('free_results-only is exempt from ②③: low context + used-this-turn still mandates', async () => {
    const engine = makeEngine({ cycles: 8 })
    engine.toolCompactUsedThisTurn = true
    const out = await engine.compactForTool({ freeResults: ['tu_0'] })
    expect(out).toMatchObject({ ok: true, freedResults: ['tu_0'], skippedIds: [] })
    // The next request's nano pass materializes the placeholder (quota never
    // fires at 8 uses — only the mandated channel could have compressed it).
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    expect(resultContentOf(engineBodies[0], 'tu_0')).toMatch(/^\[tool_result_id: tr_0\]$/)
  })
})

describe('success path: event, one-shot light-only force, notes', () => {
  it('prewarm runs with source tool, arms the force, and the next build consumes it on light only', async () => {
    const events: CompactionEvent[] = []
    const engine = makeEngine({ contextLength: 6000, onCompaction: (e) => events.push(e) })
    const lightSpy = vi.spyOn(engine.compactor, 'lightCompact')
    const hardSpy = vi.spyOn(engine.compactor, 'hardTruncate')
    const before = engine.messages

    const out = await engine.compactForTool({ notes: '当前进度：探索完成；下一步：写报告' })
    expect(out.ok).toBe(true)
    expect(out.summaryLanded).toBe(true)
    expect(out.notesKept).toBe(true)
    expect(out.droppedMessages ?? 0).toBeGreaterThan(0)
    expect(events.some(e => e.source === 'tool')).toBe(true)
    expect(engine.pendingToolCompactForce).toBe(true)
    expect(engine.toolCompactUsedThisTurn).toBe(true)
    // The notes ride the cache text verbatim (20K roll applies to the merge).
    expect(engine.getHistorySummary()?.text).toContain('【交接笔记】\n当前进度：探索完成；下一步：写报告')

    // The next request build: light forced (0.6× target), hard NOT (the
    // model's force bypasses ONLY light — D3 two-powers split), consumed once.
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    expect(lightSpy).toHaveBeenLastCalledWith(expect.anything(), 6000, expect.anything(), true)
    expect(hardSpy).toHaveBeenLastCalledWith(expect.anything(), 6000, expect.anything(), false)
    expect(engine.pendingToolCompactForce).toBe(false)
    // Second build: the one-shot force is gone — light back to passive.
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    expect(lightSpy).toHaveBeenLastCalledWith(expect.anything(), 6000, expect.anything(), false)

    // The built copy carries the summary message with the notes section.
    const summaryMsg = engineBodies[1].find(m => m.role === 'user' && m.contentBlocks.some(b => b.type === 'text' && (b as { text: string }).text.includes('【历史对话摘要】')))
    expect((summaryMsg!.contentBlocks[0] as { text: string }).text).toContain('【交接笔记】')

    // Live history untouched — the compaction only ever sees API copies.
    expect(engine.messages).toBe(before)
  })

  it('summarizer failure keeps the notes (notesKept=true), landing a notes-only cache with an empty coverage claim', async () => {
    const engine = makeEngine({ contextLength: 6000 })
    ;(engine as unknown as { runHistorySummary: unknown }).runHistorySummary = async () => '' // LLM failure
    const out = await engine.compactForTool({ notes: '交接笔记：记住这个坑' })
    expect(out.ok).toBe(true)
    expect(out.notesKept).toBe(true)
    expect(out.summaryLanded).toBe(true) // the notes-only text IS the landed summary
    const cache = engine.getHistorySummary()!
    expect(cache.text).toContain('【交接笔记】\n交接笔记：记住这个坑')
    expect(cache.text).not.toContain('【摘要】测试摘要文本')
    // No LLM saw the dropped region → the ledger must claim nothing.
    expect((engine.compactor as unknown as { historySummary: { covered: Set<string> } }).historySummary.covered.size).toBe(0)
  })

  it('simulation == materialization: the prewarm drop pairs with the next build\'s actual drop', async () => {
    const events: CompactionEvent[] = []
    const engine = makeEngine({ contextLength: 6000, onCompaction: (e) => events.push(e) })
    const out = await engine.compactForTool({})
    expect(out.ok).toBe(true)
    const prewarmEvent = events.find(e => e.source === 'tool')!
    // The next request build emits its own 'request' event over the same,
    // unchanged history — the copy it sheds must match what the tool promised.
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    const requestEvent = events.filter(e => e.source === 'request' && !e.strategies.includes('refill_breaker')).pop()
    expect(requestEvent).toBeDefined()
    expect(requestEvent!.droppedMessages).toBe(prewarmEvent.droppedMessages)
    expect(out.tokensAfter).toBe(prewarmEvent.tokensAfter)
  })
})

describe('free_results: mandated ≠ marks, both directions', () => {
  async function buildWithMandates(engine: InstanceType<typeof AgentEngine>, freeResults: string[]) {
    const out = await engine.compactForTool({ freeResults })
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    return out
  }

  it('a mandated id keeps its placeholder while a quota-compressed id re-inflates', async () => {
    // 45 tier-2 uses → quota target 20 (the 20 OLDEST results compress and are
    // marked). tu_30 sits OUTSIDE the first quota window and OUTSIDE the
    // protection window (the last 4 result-bearing user messages are 41..44).
    const engine = makeEngine()
    const out = await buildWithMandates(engine, ['tu_30'])
    expect(out.freedResults).toEqual(['tu_30'])

    const copy1 = engineBodies[0]
    expect(resultContentOf(copy1, 'tu_30')).toMatch(/^\[tool_result_id: tr_30\]$/) // mandated: compressed regardless of quota
    expect(resultContentOf(copy1, 'tu_0')).toMatch(/^\[tool_result_id: tr_0\]$/)   // quota pick (marked)
    expect(resultContentOf(copy1, 'tu_44')).toMatch(/^x{1500}$/)                   // protection window

    // Second build: the marks' bounce applies to the QUOTA pick (it re-inflates
    // — one-shot nano semantics untouched), the MANDATED id stays a placeholder
    // on every request (independent persistence).
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    const copy2 = engineBodies[1]
    expect(resultContentOf(copy2, 'tu_0')).toMatch(/^x{1500}$/)                    // marked → allowed to re-inflate
    expect(resultContentOf(copy2, 'tu_30')).toMatch(/^\[tool_result_id: tr_30\]$/) // mandated → stable
  })

  it('skips and reports TIER3 / protection-window / unknown ids; idempotent on repeats', async () => {
    const engine = makeEngine({ cycles: 8 })
    // Append a tier-3 cycle (ask_user is never compressed) and a fresh one.
    const askTu: ToolUseBlock = { type: 'tool_use', id: 'tu_ask', name: 'ask_user', input: {}, status: 'completed' }
    engine.messages = [...engine.messages,
      { id: 'a_ask', role: 'assistant', contentBlocks: [askTu], createdAt: NOW },
      { id: 'u_ask', role: 'user', contentBlocks: [{ type: 'tool_result', tool_use_id: 'tu_ask', content: '答', tool_result_id: 'tr_ask', is_error: false } as ContentBlock], createdAt: NOW },
    ]
    const out = await buildWithMandates(engine, ['tu_ask', 'tu_7', 'tu_0', 'missing_id', 'tu_ask', 'tu_0'])
    // tu_ask: tier3 (both mentions). tu_7: inside the last-4 protection window
    // (cycles 4..7 + the ask result = the newest result-bearing user messages).
    // tu_0: accepted twice (idempotent — the placeholder outcome is stable).
    expect(out.freedResults).toEqual(['tu_0', 'tu_0'])
    expect(out.skippedIds).toEqual([
      { id: 'tu_ask', reason: 'tier3_protected' },
      { id: 'tu_7', reason: 'recent_protected' },
      { id: 'missing_id', reason: 'unknown_id' },
      { id: 'tu_ask', reason: 'tier3_protected' },
    ])
    expect(resultContentOf(engineBodies[0], 'tu_ask')).toBe('答')
    expect(resultContentOf(engineBodies[0], 'tu_7')).toMatch(/^x{1500}$/)
    expect(resultContentOf(engineBodies[0], 'tu_0')).toMatch(/^\[tool_result_id: tr_0\]$/)
  })
})

describe('lifecycle: per-turn bit, mandated ids, spawned engines', () => {
  it('reset clears the force bit, the per-turn cap and the mandated ids', async () => {
    const engine = makeEngine()
    engine.compactor.mandateToolResultIds(['tu_0'])
    engine.pendingToolCompactForce = true
    engine.toolCompactUsedThisTurn = true
    engine.reset()
    expect(engine.pendingToolCompactForce).toBe(false)
    expect(engine.toolCompactUsedThisTurn).toBe(false)
    expect((engine.compactor as unknown as { mandatedCompressIds: Set<string> }).mandatedCompressIds.size).toBe(0)
  })

  it('prepareTurn clears the per-turn cap (the next turn gets one main compaction back)', async () => {
    const engine = makeEngine()
    engine.toolCompactUsedThisTurn = true
    await (engine as unknown as { prepareTurn: (t: string) => Promise<string | null> }).prepareTurn('继续')
    expect(engine.toolCompactUsedThisTurn).toBe(false)
    // The force bit deliberately survives the turn boundary: the drop it arms
    // belongs to the next built copy, whenever that comes.
    engine.pendingToolCompactForce = true
    await (engine as unknown as { prepareTurn: (t: string) => Promise<string | null> }).prepareTurn('再继续')
    expect(engine.pendingToolCompactForce).toBe(true)
  })

  it('a spawned sub-agent engine carries the tool channel too (D9: 放行)', async () => {
    const engine = makeEngine({ spawnedToolset: true, cycles: 8 })
    const out = await engine.compactForTool({ freeResults: ['tu_1'] })
    expect(out).toMatchObject({ ok: true, freedResults: ['tu_1'] })
  })
})

describe('wiring — the scans that keep the channel honest', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const ROOT = join(__dirname, '..')
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

  it('ToolExecContext carries compactContext and the executor formats the outcome', () => {
    expect(read('src/renderer/src/agent/executors/context.ts')).toContain('compactContext?')
    const te = read('src/renderer/src/agent/tool-executors.ts')
    expect(te).toContain('execContextCompactTool(this, t)')
    expect(read('src/renderer/src/agent/executors/domain-tools.ts')).toContain("t.name !== 'context_compact'")
  })

  it('both isMemoryTool sites list context_compact — the trusted-group exemption is name-based', () => {
    const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
    const sites = flow.match(/isMemoryTool = \(name: string\): boolean =>/g) ?? []
    expect(sites.length).toBe(2)
    expect(flow.match(/name === 'context_compact'/g)?.length).toBe(2)
  })

  it('the engine arms, consumes and clears the three state pieces', () => {
    const engineSrc = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engineSrc).toContain('compactForTool')
    expect(engineSrc).toContain('this.pendingToolCompactForce = false')
    expect(engineSrc).toContain('this.toolCompactUsedThisTurn = false')
    expect(engineSrc).toContain('clearMandatedToolResultIds()')
  })
})
