// context_compact — the model-initiated compaction tool (PLAN-context-compact-tool,
// user rulings 2026-10-01 ×2; epoch rewrite 2026-11-21). Two-power split: the model
// drives nano (free_results mandated picks) and the packing pass (main action =
// prewarm with instruction/notes); hard stays agent-side and the tool arm never gets
// it. The pins below are the ones the plan calls out by name:
//   - guard matrix ①in-flight markers (currentRequestId/prepareLoopInProgress —
//     agentStatus is a stale proxy, see the ① case) ②once-per-turn ③copy at/below
//     the epoch cut target (with the just-above-line pass) ④nothing-to-drop — and
//     free_results-only exempt from ②③
//   - success: event source='tool', the prewarm packs to the epoch target with
//     `allowHard:false`, the next build's cut is armed (force ⇒ that same target
//     even below the trigger line) and consumed exactly once; notes verbatim in the
//     summary message AND the cache text, notes survive a failed summarizer
//   - mandated picks land INSIDE a cut: the epoch retired the "every request
//     re-derives the archive" arm (the base is frozen bytes), so below the target a
//     mandate stays full text — that honest negative is pinned next to the
//     over-target positive where the mandated id ships ⟨archived: …⟩
//   - the prewarm's summary is computed ONCE, off the request path: the next build
//     reuses it (zero extra summary calls) and ships it in the wire copy
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
 *  map (read), so the per-pass cap is TIER_SIZES[2]=20 results (the newest batch
 *  is kept). Since the epoch the cap is a CAP, not a trigger: the copy also has
 *  to cross the trigger line (T = b − headroom) before a cut runs at all, and the
 *  cut packs to T − Δ — see epochLines in context-compactor.ts. */
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
  resultChars?: number
  spawnedToolset?: boolean
  onCompaction?: (e: CompactionEvent) => void
}

function makeEngine(o: MakeEngineOpts = {}): InstanceType<typeof AgentEngine> {
  const messages: AgentMessage[] = [userText('u_start', '跑一个长任务')]
  for (let i = 0; i < (o.cycles ?? 45); i++) {
    const [a, u] = toolCycle(i, o.resultChars)
    messages.push(a, u)
  }
  const callbacks: AgentEngineCallbacks = {}
  if (o.onCompaction) callbacks.onCompaction = o.onCompaction
  const engine = new AgentEngine({
    apiKey: 'test-key', baseURL: 'https://example.invalid', model: 'test-model', maxTokens: 1024,
    // 101_024 rather than 100_000: the engine divides by the INPUT budget, i.e.
    // the window minus maxTokens (1024) — see engine/window-budget.ts. This way
    // that budget is exactly 100_000, so guard ③'s line (the epoch cut target,
    // cold start = 0.70 × b) sits at 70_000.
    contextLength: o.contextLength ?? 101_024,
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

function archivedIdsOf(copy: AgentMessage[]): string[] {
  return copy
    .flatMap(m => m.contentBlocks)
    .filter((b): b is ToolResultBlock => b.type === 'tool_result' && (b.content ?? '').startsWith('⟨archived:'))
    .map(b => b.tool_use_id)
}

/** One request build — the path previews every gate the tool's force rides. */
function prepareLoop(engine: InstanceType<typeof AgentEngine>): Promise<unknown> {
  return (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
}

beforeEach(() => { engineBodies.length = 0 })

describe('guards ①—④ (main action only; free_results exempt from ②③)', () => {
  it('① an in-flight request (the marker pair, not agentStatus) REGISTERS instead of refusing (PLAN-tool-issues #6)', async () => {
    const engine = makeEngine({ cycles: 3, contextLength: 1000 })
    engine.currentRequestId = 'api_test_1'
    const out = await engine.compactForTool({})
    // Registration, not refusal: the drop is armed for the next build (the
    // same one-shot force a successful call arms itself); the prewarm cannot
    // run in flight, hence deferred (notes gap honest-enveloped executor-side).
    expect(out).toMatchObject({ ok: true, deferred: true })
    expect(engine.pendingToolCompactForce).toBe(true)
    // The build phase arms no request id (its summary call rides the same
    // transport) — the second in-flight marker covers it (watchdog pair);
    // registering twice just re-arms the same flag.
    engine.pendingToolCompactForce = false
    engine.currentRequestId = null
    engine.prepareLoopInProgress = true
    expect(await engine.compactForTool({})).toMatchObject({ ok: true, deferred: true })
    expect(engine.pendingToolCompactForce).toBe(true)
    // Both markers null is the sanctioned moment EVEN with agentStatus still
    // 'streaming' — the auto-run path never flips the status between requests
    // (only approveTool / the delegated loop / the plan scheduler write
    // 'executing'), which is exactly why the old status read refused every
    // mid-turn call. The 7-message history passes ③ but nothing is droppable
    // below MIN_KEEP.
    engine.prepareLoopInProgress = false
    engine.agentStatus = { status: 'streaming' }
    expect((await engine.compactForTool({})).reason).toBe('nothing_to_drop')
  })

  it('② already used this turn refuses', async () => {
    const engine = makeEngine()
    engine.toolCompactUsedThisTurn = true
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'already_this_turn' })
  })

  it('③ a copy at/below the epoch cut target refuses with readings; just above it passes the guard', async () => {
    const engine = makeEngine({ cycles: 2 })
    // Cold start (no growth samples yet) puts the cut target at 0.70 × 100_000
    // and the trigger line at 0.85 × 100_000 — ③ reads the copy price against
    // the TARGET, because that is where a cut would land.
    const spy = vi.spyOn(engine.compactor, 'copyTokens').mockReturnValue(69_000)
    const out = await engine.compactForTool({})
    expect(out).toMatchObject({ ok: false, reason: 'not_worthwhile', tokens: 69_000, window: 100_000 })
    // One token over the target the guard opens; the failure below is a
    // DIFFERENT guard (nothing to drop on a 5-message history — prewarm's
    // MIN_KEEP floor).
    spy.mockReturnValue(70_001)
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

  it('free_results-only is exempt from ②③: used-this-turn still mandates', async () => {
    const engine = makeEngine({ cycles: 8 })
    engine.toolCompactUsedThisTurn = true
    const out = await engine.compactForTool({ freeResults: ['tu_0'] })
    // The exemption lives at the `mainAction` early return — both ② and ③ sit
    // after it, so neither can refuse a light action.
    expect(out).toMatchObject({ ok: true, freedResults: ['tu_0'], skippedIds: [] })
    expect((engine.compactor as unknown as { mandatedCompressIds: Set<string> }).mandatedCompressIds.has('tu_0')).toBe(true)
    // The mandate lands INSIDE a cut, not as a per-request re-derivation: this
    // copy prices ~4.9K against a 70K target, so the honest outcome is "booked
    // for the next cut" — tu_0 ships verbatim until one actually runs.
    await prepareLoop(engine)
    expect(resultContentOf(engineBodies[0], 'tu_0')).toMatch(/^x{1500}$/)
  })
})

describe('success path: event, one-shot cut force, notes', () => {
  it('prewarm runs with source tool, arms the force, and the next build spends it on the epoch target once', async () => {
    const events: CompactionEvent[] = []
    // 6_000 is the INPUT budget the assertions below name; the window it is
    // derived from is 6_000 + maxTokens (1024). Cold epoch lines for it:
    // trigger 5_100, depth 900, target 4_200.
    const engine = makeEngine({ contextLength: 7_024, onCompaction: (e) => events.push(e) })
    let summaryCalls = 0
    ;(engine as unknown as { runHistorySummary: unknown }).runHistorySummary = async () => {
      summaryCalls++
      return '【摘要】测试摘要文本'
    }
    const cutSpy = vi.spyOn(engine.compactor, 'directCut')
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

    // The prewarm packs to the epoch target with hard off (the tool arm never
    // gets the hard layer — D3 two-powers split) and books no growth sample
    // (the request path owns the curve; record:false).
    expect(cutSpy).toHaveBeenCalledTimes(1)
    expect(cutSpy.mock.calls[0]![0]).toBe(4_200)
    expect(cutSpy.mock.calls[0]![1]).toMatchObject({ allowHard: false, record: false })
    expect(hardSpy).not.toHaveBeenCalled()
    expect(summaryCalls).toBe(1)

    // The next request build consumes the one-shot force. A tool mando is
    // UNCONDITIONAL — the pass is aimed at the epoch target even though the
    // copy sits below the trigger line — and it happens exactly once; whether
    // it drops anything depends on what is left (the prewarm already packed
    // everything droppable, so here it is a structural no-op — spent, not
    // sticky).
    await prepareLoop(engine)
    expect(engine.pendingToolCompactForce).toBe(false)
    expect(cutSpy.mock.calls).toHaveLength(2)
    expect(cutSpy.mock.calls[1]![0]).toBe(4_200)
    expect(cutSpy.mock.calls[1]![1]).toMatchObject({ allowHard: false })
    expect(((await cutSpy.mock.results[1]!.value) as { cut: boolean }).cut).toBe(false)
    expect(hardSpy).not.toHaveBeenCalled()
    // Zero extra LLM calls: the prewarm's text IS the epoch base.
    expect(summaryCalls).toBe(1)

    // The built copy carries the summary message with the notes section.
    const summaryMsg = engineBodies[0]!.find(m => m.role === 'user' && m.contentBlocks.some(b => b.type === 'text' && (b as { text: string }).text.includes('【历史对话摘要】')))
    expect((summaryMsg!.contentBlocks[0] as { text: string }).text).toContain('【交接笔记】')

    // Live history untouched — the compaction only ever sees API copies.
    expect(engine.messages).toBe(before)
  })

  it('summarizer failure keeps the notes (notesKept=true), landing a notes-only cache with an empty coverage claim', async () => {
    const engine = makeEngine({ contextLength: 7_024 })
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

  it('the prewarm lands REAL numbers: tokensAfter is the frozen base, and the next build reuses its summary', async () => {
    const engine = makeEngine({ contextLength: 7_024 })
    let summaryCalls = 0
    ;(engine as unknown as { runHistorySummary: unknown }).runHistorySummary = async () => {
      summaryCalls++
      return '【摘要】测试摘要文本'
    }
    const out = await engine.compactForTool({})
    expect(out.ok).toBe(true)
    expect(out.tokensAfter!).toBeLessThan(out.tokensBefore!)
    // The reported price is the materialized base's own — not a simulation of
    // a future pass (that arm retired with the ledger and its re-derivation).
    expect(engine.compactor.copyTokens(engine.compactor.assembleCopy(), engine.compactor.lastRequestOverhead)).toBe(out.tokensAfter)
    // The text it paid for is also the cache: the next build spends zero extra
    // summary calls and ships that very message.
    await prepareLoop(engine)
    expect(summaryCalls).toBe(1)
    const summaryMsg = engineBodies[0]!.find(m => m.contentBlocks.some(b => b.type === 'text' && (b as { text: string }).text.includes('【历史对话摘要】')))
    expect((summaryMsg!.contentBlocks[0] as { text: string }).text).toContain('【摘要】测试摘要文本')
  })
})

describe('free_results: mandated picks and gate picks are both stable across builds', () => {
  async function buildWithMandates(engine: InstanceType<typeof AgentEngine>, freeResults: string[]) {
    const out = await engine.compactForTool({ freeResults })
    await (engine as unknown as { prepareLoopRequest: (o: AgentEngineOptions) => Promise<unknown> }).prepareLoopRequest(engine.opts)
    return out
  }

  it('a mandated id and a cut pick both keep their placeholders (byte-stable archive)', async () => {
    // 60 × 5600 latin chars ≈ 69K tokens against a 100K budget: over the 70K
    // cut target, under the fresh-truth trigger — the cut fires and packs the
    // base, which is where both kinds of pick materialize.
    const engine = makeEngine({ cycles: 60, resultChars: 5_600 })
    const out = await buildWithMandates(engine, ['tu_30'])
    expect(out.freedResults).toEqual(['tu_30'])

    const copy1 = engineBodies[0]!
    expect(resultContentOf(copy1, 'tu_30')).toMatch(/^⟨archived: tr_30⟩$/) // mandated: packed by the cut regardless of nano's own pick
    expect(resultContentOf(copy1, 'tu_0')).toMatch(/^⟨archived: tr_0⟩$/) // nano's own pick inside the same cut
    expect(resultContentOf(copy1, 'tu_59')).toMatch(/^x{5600}$/) // protection window / kept tail

    // Second build over the SAME history: no growth, so no new cut — the copy
    // is the frozen base (same array), and the archive bytes are unchanged.
    // This byte-stability is what lets the provider prefix cache hold between
    // frontier advances.
    const frozen = engine.compactor.assembleCopy()
    await prepareLoop(engine)
    expect(engine.compactor.assembleCopy()).toBe(frozen)
    expect(archivedIdsOf(engineBodies[1]!)).toEqual(archivedIdsOf(copy1))
  })

  it('skips and reports TIER3 / protection-window / unknown ids; accepted picks are registered', async () => {
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
    // The accepted pick is BOOKED (a free_results-only call returns before the
    // main action, so no cut ran here) …
    expect([...(engine.compactor as unknown as { mandatedCompressIds: Set<string> }).mandatedCompressIds]).toEqual(['tu_0'])
    // … the skipped ones stay untouched …
    expect(resultContentOf(engineBodies[0]!, 'tu_ask')).toBe('答')
    expect(resultContentOf(engineBodies[0]!, 'tu_7')).toMatch(/^x{1500}$/)
    // … and the booked one stays full text too: this copy prices ~4.9K against
    // a 70K target, so nothing was cut — the honest below-target negative.
    expect(resultContentOf(engineBodies[0]!, 'tu_0')).toMatch(/^x{1500}$/)
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

  it('the refusal envelope still receipts freed/skipped picks (review 2026-10-04 中1)', async () => {
    // Combined call (free_results + notes) whose main action guard ② refuses:
    // the mandate is written BEFORE the guards run (free_results is exempt),
    // so the failure outcome carries freedResults/skippedIds — and the envelope
    // the model reads must carry them too, or the picks that DID take effect
    // land with no receipt.
    const engine = makeEngine({ cycles: 8 })
    engine.toolCompactUsedThisTurn = true
    const added: Array<{ content: string; isError: boolean }> = []
    const { execContextCompactTool } = await import('../src/renderer/src/agent/executors/domain-tools')
    await execContextCompactTool(
      {
        compactContext: (call) => engine.compactForTool(call),
        addToolResult: (_id: string, content: string, isError: boolean) => { added.push({ content, isError }) },
      } as never,
      { name: 'context_compact', id: 'call_receipt', input: { free_results: ['tu_0', 'tu_7'], notes: '交接笔记' } } as never,
    )
    expect(added).toHaveLength(1)
    expect(added[0]!.isError).toBe(true) // the refusal still marks the block — the main action did not run
    const text = added[0]!.content
    // The refusal text comes first…
    expect(text.indexOf('本回合已压缩过')).toBeGreaterThan(-1)
    // …followed by the receipt: tu_0 was mandated (tu_7 sits inside the
    // last-4 protection window), and both facts are on the envelope.
    expect(text).toContain('已压缩 1 条点名结果为占位符')
    expect(text.indexOf('本回合已压缩过')).toBeLessThan(text.indexOf('已压缩 1 条点名结果为占位符'))
    expect(text).toContain('跳过 1 条点名')
    expect(text).toContain('tu_7（最近 4 轮保护内）')
  })

  it('both isMemoryTool sites read the ONE shared list — the trusted-group exemption is name-based', () => {
    const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
    // 2026-10-24 harness review: the two sites (dispatch partition + approveTool
    // release routing) now read MEMORY_GROUP_TOOL_NAMES — one list, no drift.
    const sites = flow.match(/isMemoryTool = \(name: string\): boolean => MEMORY_GROUP_TOOL_NAMES\.includes\(name\)/g) ?? []
    expect(sites.length).toBe(2)
    // The shared list itself names context_compact exactly once (and is the
    // ONLY literal list — the drifted third copy in approveTool is gone).
    expect(flow.match(/MEMORY_GROUP_TOOL_NAMES = \[[^\]]*\]/g)?.length).toBe(1)
    expect(flow).toContain("'context_compact']")
    expect(flow.match(/'recall', 'memory_save'/g)?.length).toBe(1)  // 检索一元化：memory_search/conversation_search → recall
  })

  it('the engine arms, consumes and clears the three state pieces', () => {
    const engineSrc = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engineSrc).toContain('compactForTool')
    expect(engineSrc).toContain('this.pendingToolCompactForce = false')
    expect(engineSrc).toContain('this.toolCompactUsedThisTurn = false')
    expect(engineSrc).toContain('clearMandatedToolResultIds()')
  })
})

describe('deferred registration envelope (PLAN-tool-issues #6)', () => {
  it('an in-flight call renders 已登记 — and closes the notes/free_results gaps honestly', async () => {
    const added: Array<{ content: string; isError: boolean }> = []
    const { execContextCompactTool } = await import('../src/renderer/src/agent/executors/domain-tools')
    await execContextCompactTool(
      {
        compactContext: async () => ({ ok: true, deferred: true }),
        addToolResult: (_id: string, content: string, isError: boolean) => { added.push({ content, isError }) },
      } as never,
      { name: 'context_compact', id: 'call_deferred', input: { notes: '交接笔记', free_results: ['tu_3'] } } as never,
    )
    expect(added).toHaveLength(1)
    // A registration is NOT a failure — the model must not read it as one.
    expect(added[0]!.isError).toBe(false)
    expect(added[0]!.content).toContain('压缩已登记')
    expect(added[0]!.content).toContain('下一次请求构建')
    expect(added[0]!.content).toContain('无需再次调用')
    // The two things a deferred run cannot do must be named, not silently dropped.
    expect(added[0]!.content).toContain('交接笔记在延后模式下不会落地')
    expect(added[0]!.content).toContain('free_results 点名在延后模式下未处理')
    expect(added[0]!.content).toContain('不要因压缩收尾')
  })

  it('a deferred call with no notes/free_results stays a one-liner', async () => {
    const added: Array<{ content: string; isError: boolean }> = []
    const { execContextCompactTool } = await import('../src/renderer/src/agent/executors/domain-tools')
    await execContextCompactTool(
      {
        compactContext: async () => ({ ok: true, deferred: true }),
        addToolResult: (_id: string, content: string, isError: boolean) => { added.push({ content, isError }) },
      } as never,
      { name: 'context_compact', id: 'call_deferred_bare', input: {} } as never,
    )
    expect(added[0]!.isError).toBe(false)
    expect(added[0]!.content).not.toContain('交接笔记在延后模式下')
    expect(added[0]!.content).not.toContain('free_results 点名')
  })
})
