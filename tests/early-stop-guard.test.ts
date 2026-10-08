import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-early-stop-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')
const { buildSystemPrompt } = await import('../src/renderer/src/agent/system-prompt-builder')
const { hasTaskDoneSentinel, stripTaskDoneSentinel, TASK_DONE_SENTINEL } = await import('../src/renderer/src/agent/engine/task-sentinel')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions } from '../src/renderer/src/agent/AgentEngine'

const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * Early-stop continuation guard (2026-10-08, per-model opt-in) + the
 * <<TASK_DONE>> completion sentinel it reads. The shape it fixes: a weak
 * model's chat prior narrates the next step as prose and ends the turn
 * (end_turn, visible text, no tool_use) while the task is in flight — the one
 * degenerate shape the thinking-only retry deliberately does not cover. The
 * guard fires ONLY when the turn has settled tool rounds (evidence of work in
 * flight) and the sentinel is absent (a guarded model's "done" vote); the
 * continuation rides the state block and re-arms on progress. max_tokens
 * closes keep their 2026-09-20 ruling; models without the flag never see any
 * of this.
 *
 * Same harness as tests/thinking-only-retry.test.ts: the REAL StreamRunner
 * dispatch over a fake host pumping queued SSE chunks per request.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

function makeStreamHost(): PulseHost & { pump(chunks: string[]): void } {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const queue: string[][] = []
  const noop = () => Promise.resolve([] as unknown[])
  const host = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: () => () => {},
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: async (requestId: string) => {
      const chunks = queue.shift() ?? []
      for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId, data: c })
      for (const fn of [...doneListeners]) fn({ requestId })
    },
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},
    onMcpServersChanged: () => () => {},
    onSkillsChanged: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  } as unknown as PulseHost & { pump(chunks: string[]): void }
  ;(host as unknown as { pump(chunks: string[]): void }).pump = (chunks: string[]) => { queue.push(chunks) }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

const toolStream = (): string[] => [
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.invalid"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 881, completion_tokens: 9 } }),
  'data: [DONE]\n\n',
]

/** The failure shape: narration instead of a tool call, then a clean stop. */
const earlyStopStream = (): string[] => [
  sse({ choices: [{ delta: { content: '好的，我已经读取了文件。接下来我将修改其中的配置项。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 881, completion_tokens: 24 } }),
  'data: [DONE]\n\n',
]

/** A guarded model's legitimate close: final summary + the sentinel line. */
const sentinelCloseStream = (): string[] => [
  sse({ choices: [{ delta: { content: `任务已全部完成，配置项已修改并通过测试。\n${TASK_DONE_SENTINEL}` } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 881, completion_tokens: 18 } }),
  'data: [DONE]\n\n',
]

function makeEngine(host: ReturnType<typeof makeStreamHost>, earlyStopGuard: boolean) {
  const engine = new AgentEngine({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid',
    model: 'test-model',
    maxTokens: 1024,
    myName: 'tester',
    soul: '',
    yourName: 'user',
    adapter: openaiAdapter,
    toolManager: new ToolManager() as never,
    skillManager: new SkillManager(),
    conversationId: 'conv_early_stop',
    earlyStopGuard,
  } as unknown as AgentEngineOptions)

  const statuses: string[] = []
  const baseNotify = engine.notify.bind(engine)
  engine.notify = () => { statuses.push(engine.agentStatus.status); baseNotify() }
  // Tool rounds must settle without touching a network: same stub shape as
  // auto-mode-phantom-approval.test.ts. The settle tick is what increments
  // toolRoundsThisTurn (recordToolBatchComplete) — the guard's evidence.
  engine.toolExecutor.execReadOnlyTools = async (tools: Array<{ id: string; status?: string; exitCode?: number | null }>) => {
    for (const t of tools) { t.status = 'completed'; t.exitCode = 0 }
    engine.addToolResult(tools[0].id, 'page body', false)
  }
  return { engine, statuses }
}

/** Drive the runner through a queue of rounds via a faked continueLoop. */
async function drive(host: ReturnType<typeof makeStreamHost>, engine: InstanceType<typeof AgentEngine>, rounds: string[][]) {
  let continueCalls = 0
  engine.continueLoop = async (): Promise<void> => {
    continueCalls += 1
    const chunks = rounds.shift()
    if (!chunks) return
    host.pump(chunks)
    await runnerOf(engine).run(engine.opts, REQ)
    await tick()
  }
  const first = rounds.shift()!
  host.pump(first)
  await runnerOf(engine).run(engine.opts, REQ)
  await tick()
  return { get continueCalls() { return continueCalls } }
}

describe('task-sentinel (pure helpers)', () => {
  it('detects the marker only as a standalone line', () => {
    expect(hasTaskDoneSentinel(`done.\n${TASK_DONE_SENTINEL}`)).toBe(true)
    expect(hasTaskDoneSentinel(`done.\n  ${TASK_DONE_SENTINEL}  `)).toBe(true)
    expect(hasTaskDoneSentinel(`the marker is ${TASK_DONE_SENTINEL} inline`)).toBe(false)
    expect(hasTaskDoneSentinel('just text')).toBe(false)
    expect(hasTaskDoneSentinel(undefined)).toBe(false)
    expect(hasTaskDoneSentinel('')).toBe(false)
  })

  it('strips the marker line and drops a block that was only the marker', () => {
    expect(stripTaskDoneSentinel(`结论：完成。\n${TASK_DONE_SENTINEL}`)).toBe('结论：完成。')
    expect(stripTaskDoneSentinel(TASK_DONE_SENTINEL)).toBeNull()
    expect(stripTaskDoneSentinel(`pre\n\n${TASK_DONE_SENTINEL}`)).toBe('pre')
    // prose mentioning the marker survives untouched
    const prose = `the marker is ${TASK_DONE_SENTINEL} inline`
    expect(stripTaskDoneSentinel(prose)).toBe(prose)
  })
})

describe('early-stop guard: fires on text-only end_turn after tool work without the sentinel', () => {
  it('auto-continues once; the unproductive follow-up closes the turn normally', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine, statuses } = makeEngine(host, true)

    // tool round → early stop → (nudge) another chaty text round → close.
    // continueCalls = 2: the tool round's own continuation + the guard's nudge
    // (round 3 exists ONLY because of the guard — assert via the transcript).
    const rounds = [toolStream(), earlyStopStream(), earlyStopStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(2)
    expect(statuses).toContain('retrying')
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    // One nudge consumed; no progress (second round had no tools) → no second.
    expect(engine.earlyStopContinues).toBe(1)
    expect(engine.earlyStopNudgesTotal).toBe(1)
    expect(engine.toolRoundsThisTurn).toBe(1)
    // All three rounds live in the transcript; the guard never deletes.
    expect(engine.messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
  })

  it('the sentinel closes cleanly — zero extra rounds, marker stripped from the stored text', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)

    const rounds = [toolStream(), sentinelCloseStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1) // only the tool round's own continuation
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    const last = engine.messages[engine.messages.length - 1]
    const text = last.contentBlocks.find((b) => b.type === 'text') as { text: string }
    expect(text.text).not.toContain(TASK_DONE_SENTINEL)
    expect(text.text).toContain('任务已全部完成')
    expect(engine.pendingEarlyStopNudge).toBe(false)
  })

  it('a bare sentinel round (nothing else) is a deliberate end, not a thinking-only retry', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)

    const bare = [
      sse({ choices: [{ delta: { content: TASK_DONE_SENTINEL } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ]
    const rounds = [toolStream(), bare]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    // The emptied text block is dropped whole — no blank bubble in history.
    const last = engine.messages[engine.messages.length - 1]
    expect(last.contentBlocks.some((b) => b.type === 'text')).toBe(false)
  })
})

describe('early-stop guard: gates', () => {
  it('never fires without the flag — strong-model dispatch unchanged', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, false)

    const rounds = [toolStream(), earlyStopStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1) // the tool round's own continuation only
    expect(engine.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    expect(engine.pendingEarlyStopNudge).toBe(false)
  })

  it('never fires without prior tool work — a pure Q&A text answer is a normal close', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)

    const rounds = [earlyStopStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(0)
    expect(engine.toolRoundsThisTurn).toBe(0)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
  })

  it('a productive continuation re-arms the guard — the next early stop nudges again', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)

    // tool → early stop → (nudge) tool → early stop → (nudge again) close
    const rounds = [toolStream(), earlyStopStream(), toolStream(), earlyStopStream(), sentinelCloseStream()]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(4)
    expect(engine.earlyStopNudgesTotal).toBe(2)
    expect(engine.earlyStopContinues).toBe(1) // last nudge was unproductive... closed by sentinel instead
    expect(engine.agentStatus).toEqual({ status: 'completed' })
  })

  it('respects the per-turn hard cap', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)
    engine.toolRoundsThisTurn = 3
    engine.earlyStopContinues = 0
    engine.earlyStopNudgesTotal = 10 // MAX_EARLYSTOP_CONTINUATIONS reached

    const rounds = [earlyStopStream()]
    await drive(host, engine, rounds)

    expect(engine.agentStatus).toEqual({ status: 'completed' })
    expect(engine.earlyStopNudgesTotal).toBe(10)
  })

  it('max_tokens closes with text stay closed (2026-09-20 ruling untouched, even guarded)', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)

    const cut = [
      sse({ choices: [{ delta: { content: '我先读取一下' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 8 } }),
      'data: [DONE]\n\n',
    ]
    const rounds = [toolStream(), cut]
    const { continueCalls } = await drive(host, engine, rounds)

    expect(continueCalls).toBe(1)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
    expect(engine.pendingEarlyStopNudge).toBe(false)
  })
})

describe('the continuation directive rides exactly one state block', () => {
  it('pendingEarlyStopNudge arms on the guard and the built state block carries the section', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)
    // No conversation row → prepareLoopRequest skips tool-result persistence
    // (the fake host has no DB-backed methods).
    ;(engine.opts as { conversationId?: string }).conversationId = undefined

    const rounds = [toolStream(), earlyStopStream()]
    await drive(host, engine, rounds)

    expect(engine.pendingEarlyStopNudge).toBe(true)
    const req = await (engine as unknown as { prepareLoopRequest(o: AgentEngineOptions): Promise<{ resolvedBody: { messages: Array<{ role: string; content: unknown }> } }> }).prepareLoopRequest(engine.opts)
    const messages = req.resolvedBody.messages as Array<{ role: string; content: unknown }>
    const last = messages[messages.length - 1]
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    expect(text).toContain('## Turn Continuation')
    expect(text).toContain(TASK_DONE_SENTINEL)
    // consumed by the build — a retry of the nudge round rebuilds without it
    expect(engine.pendingEarlyStopNudge).toBe(false)
  })
})

describe('spawned engines get the directive too', () => {
  const spawnOpts = {
    apiKey: 'k', baseURL: 'https://example.invalid', model: 'm', maxTokens: 1024,
    myName: '', soul: '', yourName: '', locale: 'zh' as const, earlyStopGuard: true,
  }
  it('spawn branch packs the nudge into a minimal state block', async () => {
    const on = await buildSystemPrompt({ opts: spawnOpts as unknown as AgentEngineOptions, spawnSystemPrompt: 'You are a spawned expert.', messages: [], plan: null, continuationNudge: true })
    expect(on.stateBlock).toContain('## Turn Continuation')
    expect(on.stateBlock).toContain(TASK_DONE_SENTINEL)
    expect(on.stateBlock).not.toContain('## Workspace') // minimal: no session state
    const off = await buildSystemPrompt({ opts: spawnOpts as unknown as AgentEngineOptions, spawnSystemPrompt: 'You are a spawned expert.', messages: [], plan: null })
    expect(off.stateBlock).toBeNull()
  })

  it('a spawned engine’s guard fires and its rebuilt request carries the directive', async () => {
    const host = makeStreamHost()
    setHost(host)
    const { engine } = makeEngine(host, true)
    engine.spawnSystemPrompt = 'You are a spawned expert doing the work.'
    ;(engine.opts as { conversationId?: string }).conversationId = undefined

    const rounds = [toolStream(), earlyStopStream()]
    await drive(host, engine, rounds)
    expect(engine.pendingEarlyStopNudge).toBe(true)

    const req = await (engine as unknown as { prepareLoopRequest(o: AgentEngineOptions): Promise<{ resolvedBody: { messages: Array<{ role: string; content: unknown }> } }> }).prepareLoopRequest(engine.opts)
    const messages = req.resolvedBody.messages as Array<{ role: string; content: unknown }>
    const last = messages[messages.length - 1]
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    expect(text).toContain('## Turn Continuation')
    expect(engine.pendingEarlyStopNudge).toBe(false)
  })
})

describe('prompt layer: the sentinel section is conditional on the flag', () => {
  const baseOpts = {
    apiKey: 'k', baseURL: 'https://example.invalid', model: 'm', maxTokens: 1024,
    myName: '', soul: '', yourName: '', locale: 'zh' as const,
  }
  it('guarded model prompt teaches the marker; unguarded prompt never mentions it', async () => {
    const on = await buildSystemPrompt({ opts: { ...baseOpts, earlyStopGuard: true } as unknown as AgentEngineOptions, messages: [], plan: null })
    expect(on.systemPrompt).toContain('## Task Completion')
    expect(on.systemPrompt).toContain(TASK_DONE_SENTINEL)

    const off = await buildSystemPrompt({ opts: baseOpts as unknown as AgentEngineOptions, messages: [], plan: null })
    expect(off.systemPrompt).not.toContain('## Task Completion')
    expect(off.systemPrompt).not.toContain(TASK_DONE_SENTINEL)
  })
})

describe('wiring scans (a half-landed edit must fail here)', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('session-manager maps the profile flag at BOTH engine construction sites', () => {
    const src = read('src/main/agent/session-manager.ts')
    expect(src.match(/earlyStopGuard: profile\.earlyStopGuard === true/g)?.length).toBe(2)
  })

  it('the sentinel section enters the core prompt ONLY behind the flag', () => {
    const src = read('src/renderer/src/agent/system-prompt-builder.ts')
    expect(src).toContain('if (opts.earlyStopGuard) parts.push(TASK_COMPLETION_SENTINEL_SECTION)')
  })

  it('the guard dispatch is flag-gated in stream-runner', () => {
    const src = read('src/renderer/src/agent/engine/stream-runner.ts')
    expect(src).toContain("this.engine.opts.earlyStopGuard === true && !hasTaskDone")
  })

  it('prepareTurn resets the guard budget — a new turn never inherits the old counters', () => {
    const src = read('src/renderer/src/agent/AgentEngine.ts')
    expect(src).toContain('this.earlyStopNudgesTotal = 0')
    expect(src).toContain('this.toolRoundsThisTurn = 0')
  })

  it('the settings store normalizes + materializes the flag', () => {
    const store = read('src/main/storage/settings-store.ts')
    expect(store).toContain('earlyStopGuard: m.earlyStopGuard === true ? true : undefined')
    expect(store).toContain('earlyStopGuard: m.earlyStopGuard,')
  })

  it('sub-agent prompts hang the sentinel section for guarded parents', () => {
    const src = read('src/renderer/src/agent/executors/spawn-tool.ts')
    expect(src).toContain('ex.opts.earlyStopGuard ? `\\n\\n${TASK_COMPLETION_SENTINEL_SECTION}`')
  })
})
