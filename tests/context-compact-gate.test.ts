import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-compact-gate-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'
import type { AgentMessage, ToolResultBlock } from '../src/renderer/src/types/agent'

const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * conv_20261021155951 (2026-10-21, DB 全量核对): the model called
 * context_compact SEVEN times across sessions and was refused with
 * 「当前有请求在飞」 EVERY time — the tool had never once succeeded in the
 * wild. The gate reads `currentRequestId || prepareLoopInProgress`, but the
 * ONLY request that id can name at tool-execution time is the request the
 * tool batch itself arrived in — its stream is over (onStreamComplete is what
 * dispatched the batch); the id just hasn't been reaped by cleanupListeners
 * yet. This suite drives the REAL StreamRunner + REAL OpenAIAdapter dispatch
 * so the gate's true reading at tool time is what gets asserted, not a guess
 * about microtask ordering.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

interface StreamHost extends PulseHost {
  pump(chunks: string[]): void
  neverSettle: boolean
  /** Production shape (performLlmStream): DONE fires synchronously, then the
   *  promise resolves only after the response dump's DISK WRITE — a macrotask
   *  that parks runner.run's cleanupListeners behind the whole microtask
   *  tool cascade. This is the gap all 7 real-world refusals lived in. */
  dumpWriteDelay: boolean
}

function makeStreamHost(): StreamHost {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const queue: string[][] = []
  const host = {
    neverSettle: false,
    dumpWriteDelay: false,
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: () => () => {},
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      const chunks = queue.shift() ?? []
      for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId, data: c })
      if ((host as StreamHost).neverSettle) await new Promise<void>(() => {}) // stream held open: no DONE
      for (const fn of [...doneListeners]) fn({ requestId })
      if ((host as StreamHost).dumpWriteDelay) await new Promise<void>((r) => setImmediate(r))
    },
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: () => Promise.resolve([] as unknown[]),
    expertList: () => Promise.resolve([] as unknown[]),
    getExecAllowlist: () => Promise.resolve([]),
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as StreamHost
  host.pump = (chunks: string[]) => { queue.push(chunks) }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** A stream whose round carries exactly one context_compact call. */
const compactCallStream = (): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_compact', type: 'function', function: { name: 'context_compact', arguments: '{"notes":"阶段交接：已完成翻译校对，开始修订版产出"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 60_000, completion_tokens: 9 } }),
  'data: [DONE]\n\n',
]

const WINDOW = 100_000

function makeEngine(_host: StreamHost) {
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 1024,
    contextLength: WINDOW,
    myName: 'tester',
    soul: '',
    yourName: 'user',
    adapter: openaiAdapter,
    toolManager: new ToolManager() as never,
    skillManager: new SkillManager(),
    conversationId: 'conv_compact_gate',
  } as unknown as AgentEngineOptions)
  engine.continueLoop = async (): Promise<void> => {}
  return engine
}

/** Long tool history past the 0.55 worthwhileness line: assistant (thinking +
 *  tool_use) → user collector, repeated. The thinking blocks are the weight
 *  nano CANNOT eat (it only rewrites tool_results) — light deletes whole
 *  cycles including them, so a tool-sourced compact has something real to
 *  drop even after the nano pass collapses the old results. */
function bigToolHistory(rounds = 40, heavyChars = 2_000): AgentMessage[] {
  const msgs: AgentMessage[] = [
    { id: 'u0', role: 'user', contentBlocks: [{ type: 'text', text: '开始校对合同译本' }], createdAt: '2026-10-21T08:00:00.000Z' },
  ]
  const thinking = '逐条核对原文与译文的一致性：术语、数字、条款引用、标点。'.repeat(Math.ceil(heavyChars / 33))
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      id: `a${i}`, role: 'assistant', createdAt: new Date(Date.parse('2026-10-21T08:00:00.000Z') + i * 60_000).toISOString(),
      contentBlocks: [
        { type: 'thinking', thinking: `${thinking}（第${i}轮）`, signature: undefined },
        { type: 'tool_use', id: `tu${i}`, name: 'exec', input: { command: `grep -c "第${i}条" contract.txt` }, status: 'completed' },
      ] as never,
    })
    msgs.push({
      id: `c${i}`, role: 'user', createdAt: new Date(Date.parse('2026-10-21T08:00:00.000Z') + i * 60_000 + 1_000).toISOString(),
      contentBlocks: [{ type: 'tool_result', tool_use_id: `tu${i}`, content: `命中 ${i} 处`, is_error: false }],
    })
  }
  msgs.push({ id: 'uLast', role: 'user', contentBlocks: [{ type: 'text', text: '现在把修订版做出来' }], createdAt: '2026-10-21T08:24:00.000Z' })
  return msgs
}

const resultOf = (engine: InstanceType<typeof AgentEngine>, toolUseId: string): string | null => {
  for (const m of engine.messages) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_result' && (b as ToolResultBlock).tool_use_id === toolUseId) {
        return (b as ToolResultBlock).content
      }
    }
  }
  return null
}

/** Stub the history-summary LLM call — the compact's prewarm would otherwise
 *  try a real request through the fake host. */
function stubSummary(engine: InstanceType<typeof AgentEngine>): void {
  ;(engine as unknown as { compactor: { deps: { runHistorySummary: (t: string) => Promise<string> } } })
    .compactor.deps.runHistorySummary = async () => '【用户诉求与决策】测试摘要（stub）'
}

describe('context_compact dispatched from its own tool batch must not be refused as request_in_flight', () => {
  it('production ordering (DONE sync, invoke resolves after the dump write): the gate must not see the stale id', async () => {
    const host = makeStreamHost()
    setHost(host)
    const engine = makeEngine(host)
    engine.messages = bigToolHistory()
    stubSummary(engine)
    host.dumpWriteDelay = true // performLlmStream's writeResponseDump gap

    host.pump(compactCallStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    const result = resultOf(engine, 'call_compact')
    expect(result).not.toBeNull()
    // The refusal that answered all 7 real-world calls — must be gone, and the
    // compact must actually LAND (the tool had never once succeeded).
    expect(result).not.toContain('当前有请求在飞')
    expect(result).toContain('已压缩')
  })

  it('clean ordering (invoke resolves right after DONE) also passes', async () => {
    const host = makeStreamHost()
    setHost(host)
    const engine = makeEngine(host)
    engine.messages = bigToolHistory()
    stubSummary(engine)

    host.pump(compactCallStream())
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()

    const result = resultOf(engine, 'call_compact')
    expect(result).not.toBeNull()
    expect(result).toContain('已压缩')
  })

  it('a GENUINELY in-flight request (no DONE yet) still refuses — the gate keeps its race guard', async () => {
    const host = makeStreamHost()
    setHost(host)
    const engine = makeEngine(host)
    engine.messages = bigToolHistory()
    host.neverSettle = true
    host.pump([compactCallStream()[0]])

    const running = runnerOf(engine).run(engine.opts, REQ)
    await tick()
    // The stream is provably open: the id is armed and no DONE was sent.
    expect(engine.currentRequestId).toBeTruthy()

    const outcome = await engine.compactForTool({ notes: '交接' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('request_in_flight')

    // Leave the runner parked on its never-settling await; nothing polls.
    void running
  })
})
