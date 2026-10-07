import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// Same HOME sandbox as thinking-only-retry.test.ts — the engine import chain
// touches real stores, and a test must never write into the user's live
// ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-mid-stream-steer-'))

const { AgentEngine } = await import('../src/renderer/src/agent/AgentEngine')
const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
const { ToolManager } = await import('../src/renderer/src/tools/ToolManager')
const { SkillManager } = await import('../src/renderer/src/skills/SkillManager')

import type { PulseHost } from '../src/renderer/src/agent/host/types'
import { setHost } from '../src/renderer/src/agent/host'
import type { AgentEngineOptions, AgentMessage } from '../src/renderer/src/agent/AgentEngine'
import type { SteerOutcome } from '../src/renderer/src/types/agent'

const tick = () => new Promise((r) => setTimeout(r, 10))

/**
 * PLAN-mid-stream-steer M1 (product_20261005 B7 方案 A): steer redirects the
 * LIVE LLM stream with a new user instruction. The engine reuses prepareTurn's
 * request-level abort seam (cancelledRequestIds + apiAbortStream) — NOT
 * pauseExecution — so the old request dies silently: no awaiting_continue, no
 * sub-agent freeze, no spawn settlement. The round's solid output (text, and
 * thinking with a COMPLETE signature) rides into the transcript as an ordinary
 * assistant message; unsigned thinking and tool_use are dropped. The steer
 * re-dispatches through continueLoop, so the loop cap governs it like any
 * round.
 *
 * These tests drive the REAL AgentEngine.steer over a fake host whose
 * apiFetchStream PARKS (deferred) — the stream is genuinely mid-flight when
 * steer fires — and pump chunks into the real StreamRunner parser.
 */

type Runner = {
  run(opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void>
}
const REQ = { apiUrl: 'https://example.invalid/v1/chat/completions', headers: {}, resolvedBody: {} }
const runnerOf = (engine: InstanceType<typeof AgentEngine>): Runner =>
  (engine as unknown as { streamRunner: Runner }).streamRunner

function makeSteerHost(opts: { deferAbortMs?: number } = {}): PulseHost & {
  pump(chunks: string[], requestId?: string): void
  complete(): void
  doneFor(requestId: string): void
  errorFor(requestId: string, message: string): void
  aborted: string[]
  requestIds: string[]
} {
  const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
  const errorListeners = new Set<(d: { requestId: string; error: string }) => void>()
  const doneListeners = new Set<(d: { requestId: string }) => void>()
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
  let liveId: string | null = null
  const noop = () => Promise.resolve([] as unknown[])
  const host = {
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: (fn: (d: { requestId: string; error: string }) => void) => { errorListeners.add(fn); return () => { errorListeners.delete(fn) } },
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    apiFetchStream: (requestId: string) => {
      liveId = requestId
      ;(host as unknown as { requestIds: string[] }).requestIds.push(requestId)
      return new Promise<void>((resolve, reject) => { pending.set(requestId, { resolve, reject }) })
    },
    apiAbortStream: (requestId: string) => {
      ;(host as unknown as { aborted: string[] }).aborted.push(requestId)
      const p = pending.get(requestId)
      if (!p) return
      pending.delete(requestId)
      // The REAL abort wire (api-proxy.handler, review_20261007 中1):
      // sinks.onError('Request aborted') then `return` — an ERROR IPC event
      // plus a RESOLVED invoke, never a rejection. The old fake (p.reject)
      // exercised only the catch's isCancel arm and could not see the
      // dead-letter/watchdog path the real wire takes.
      const fire = () => {
        for (const fn of [...errorListeners]) fn({ requestId, error: 'Request aborted' })
        p.resolve()
      }
      // deferAbortMs mimics the real IPC window (review_20261006 中1): the
      // abort's ERROR event lands AFTER a DONE that was already queued, so the
      // old runner's listeners are still subscribed when it arrives.
      if (opts.deferAbortMs) setTimeout(fire, opts.deferAbortMs)
      else fire()
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
  } as unknown as PulseHost & {
    pump(chunks: string[], requestId?: string): void
    complete(): void
    doneFor(requestId: string): void
    errorFor(requestId: string, message: string): void
    aborted: string[]
    requestIds: string[]
  }
  const h = host as unknown as {
    pump(chunks: string[], requestId?: string): void
    complete(): void
    doneFor(requestId: string): void
    errorFor(requestId: string, message: string): void
    aborted: string[]
    requestIds: string[]
  }
  h.aborted = []
  h.requestIds = []
  h.pump = (chunks: string[], requestId?: string) => {
    const id = requestId ?? liveId
    if (!id) throw new Error('pump before any request')
    for (const c of chunks) for (const fn of [...chunkListeners]) fn({ requestId: id, data: c })
  }
  h.complete = () => {
    if (!liveId) throw new Error('complete before any request')
    for (const fn of [...doneListeners]) fn({ requestId: liveId })
    // The done event settles the runner's stream-done await; the transport
    // promise itself must resolve too — run() awaits apiFetchStream first.
    const p = pending.get(liveId)
    if (p) { pending.delete(liveId); p.resolve() }
    liveId = null
  }
  h.doneFor = (requestId: string) => {
    for (const fn of [...doneListeners]) fn({ requestId })
  }
  h.errorFor = (requestId: string, message: string) => {
    for (const fn of [...errorListeners]) fn({ requestId, error: message })
  }
  return host
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`

/** A mid-flight round: visible text already on the canvas, stream NOT closed. */
const partialTextStream = (): string[] => [
  sse({ choices: [{ delta: { content: '说到一半的正文，' } }] }),
]
/** Mid-flight with an unsigned thinking block AND a (never-completed) tool call. */
const partialMixedStream = (): string[] => [
  sse({ choices: [{ delta: { reasoning_content: '先想想' } }] }),
  sse({ choices: [{ delta: { content: '说到一半，' } }] }),
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://exam' } }] } }] }),
]
/** The steered round answers cleanly and ends the turn. */
const steeredReplyStream = (): string[] => [
  sse({ choices: [{ delta: { content: '好的，按新指示来。' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 8 } }),
  'data: [DONE]\n\n',
]

const userMsg = (text: string): AgentMessage => ({
  id: `u_${text.slice(0, 6)}`,
  role: 'user',
  contentBlocks: [{ type: 'text', text }],
  createdAt: new Date().toISOString()
})

function makeEngine(_host: ReturnType<typeof makeSteerHost>) {
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
    conversationId: 'conv_mid_stream_steer',
  } as unknown as AgentEngineOptions)
  engine.messages = [userMsg('原始任务')]
  const settleSpy = vi.fn()
  ;(engine as unknown as { resolveCompletionIfSpawned: unknown }).resolveCompletionIfSpawned = settleSpy
  return { engine, settleSpy }
}

describe('steer: only a live stream can be steered (M1 phase guard)', () => {
  it('rejects on an idle engine with the current status and touches nothing', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)
    const outcome: SteerOutcome = await engine.steer('转向')
    expect(outcome).toEqual({ ok: false, reason: 'not_streaming', status: 'idle' })
    expect(engine.messages).toHaveLength(1)
    expect(engine.isCancelled).toBe(false)
  })

  it('rejects during the executing phase (committed tools are not steerable)', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)
    engine.agentStatus = { status: 'executing', toolUseId: 't1' }
    const outcome = await engine.steer('转向')
    expect(outcome).toEqual({ ok: false, reason: 'not_streaming', status: 'executing' })
    expect(engine.messages).toHaveLength(1)
  })

  it('rejects an empty steer and leaves the stream running', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)
    // prepareTurn's assignment, emulated (see the core case above).
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    await tick()
    expect(engine.agentStatus.status).toBe('streaming')
    const outcome = await engine.steer('   ')
    expect(outcome).toEqual({ ok: false, reason: 'empty' })
    expect(host.aborted).toHaveLength(0)
    host.complete()
    await firstRun
    await tick()
  })
})

describe('steer: redirect the live stream (the 方案 A core)', () => {
  it('aborts silently, solidifies partial text, appends the steer message and re-dispatches', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine, settleSpy } = makeEngine(host)

    let continueCalls = 0
    engine.continueLoop = async (): Promise<void> => {
      continueCalls += 1
      // Listeners subscribe inside run() — pump only after it has started.
      const second = runnerOf(engine).run(engine.opts, REQ)
      await tick()
      host.pump(steeredReplyStream())
      host.complete()
      await second
      await tick()
    }

    engine.thinkingOnlyRetries = 1
    // prepareTurn's assignment, emulated: a direct runner.run never sets the
    // streaming status — the real turn does it before continueLoop.
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    await tick()
    expect(engine.agentStatus.status).toBe('streaming')

    const outcome = await engine.steer('转向：改做搜索')
    await firstRun // the aborted request settles through the dead-request gate (real wire: ERROR + resolved invoke)
    await tick()

    expect(outcome).toEqual({ ok: true })
    // The abort went through the request seam, not the stop freeze.
    expect(host.aborted).toHaveLength(1)
    expect(engine.isCancelled).toBe(false)
    // Silent settlement: the abort must not settle the turn as an error or an
    // aborted completion — the steered round's own normal 'completed' settlement
    // (a no-op for a non-spawn engine) is fine and follows below.
    expect(settleSpy).not.toHaveBeenCalledWith('error')
    expect(settleSpy).not.toHaveBeenCalledWith('aborted')
    // Transcript order: original ask → partial assistant → steer → the steered round.
    expect(engine.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const [partial, steerMsg, final] = engine.messages.slice(1)
    expect(partial.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('说到一半'))).toBe(true)
    expect((steerMsg.contentBlocks[0] as { text: string }).text).toBe('转向：改做搜索')
    expect(final.contentBlocks.some((b) => b.type === 'text' && (b as { text: string }).text.includes('新指示'))).toBe(true)
    // Fresh sampling window + the steer consumed a loop dispatch.
    expect(engine.thinkingOnlyRetries).toBe(0)
    expect(continueCalls).toBe(1)
    // The turn closed normally through the steered round.
    expect(engine.agentStatus).toEqual({ status: 'completed' })
  })

  it('drops unsigned thinking and tool_use, keeps text and COMPLETE-signature thinking', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)

    engine.continueLoop = async (): Promise<void> => {
      const second = runnerOf(engine).run(engine.opts, REQ)
      await tick()
      host.pump(steeredReplyStream())
      host.complete()
      await second
      await tick()
    }

    // prepareTurn's assignment, emulated (see the core case above).
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialMixedStream())
    await tick()
    const outcome = await engine.steer('别调工具，直接回答')
    await firstRun
    await tick()

    expect(outcome).toEqual({ ok: true })
    const partial = engine.messages[1]
    const types = partial.contentBlocks.map((b) => b.type)
    // reasoning_content streamed unsigned → dropped; tool_use → dropped; text stays.
    expect(types).toEqual(['text'])
    expect((partial.contentBlocks[0] as { text: string }).text).toContain('说到一半')
  })

  it('keeps a thinking block whose signature stream-completed (Anthropic-safe)', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)

    engine.continueLoop = async (): Promise<void> => {
      const second = runnerOf(engine).run(engine.opts, REQ)
      await tick()
      host.pump(steeredReplyStream())
      host.complete()
      await second
      await tick()
    }

    // prepareTurn's assignment, emulated (see the core case above).
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    await tick()
    // A completed thinking block (signature arrived at block stop) — safe to
    // resend; an unsigned one would 400 the next Anthropic request.
    engine.currentAssistantBlocks = [
      { type: 'thinking', thinking: '想完的', signature: 'sig-abc' } as never,
      ...engine.currentAssistantBlocks,
    ]
    const outcome = await engine.steer('继续')
    await firstRun
    await tick()

    expect(outcome).toEqual({ ok: true })
    const types = engine.messages[1].contentBlocks.map((b) => b.type)
    expect(types).toContain('thinking')
    expect(types).toContain('text')
  })

  it('clips the steer text at the 4K input cap (the prepareTurn backstop)', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)

    engine.continueLoop = async (): Promise<void> => {
      const second = runnerOf(engine).run(engine.opts, REQ)
      await tick()
      host.pump(steeredReplyStream())
      host.complete()
      await second
      await tick()
    }

    // prepareTurn's assignment, emulated (see the core case above).
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    await tick()
    await engine.steer('长'.repeat(5000))
    await firstRun
    await tick()

    const steerMsg = engine.messages[2]
    expect((steerMsg.contentBlocks[0] as { text: string }).text).toHaveLength(4000)
  })
})

// ── The DONE-in-flight race (review_20261006 中1) ──
// The round ends naturally; API_STREAM_DONE is already in the IPC queue when
// the user's steer runs. The steer clears the canvas, aborts R1 and dispatches
// R2; the stale DONE must then be a dead letter — the old guard (requestId
// equality alone) let it flush the just-cleared canvas into a contentless
// assistant message and — no text, no tool_use — walk the thinking-only branch
// into a second continueLoop beside the steered one. The same guard keeps late
// CHUNKS of the dead request off the canvas R2's completion will read. (The
// two faces are mutually exclusive on the wire — a late chunk would concatenate
// into a newline-less final line and destroy it — so they get one test each.)
describe('steer: DONE-in-flight race (dead-letter the aborted request)', () => {
  /** The stale round's wire tail: finish_reason arrived (pendingFinishReason
   *  set) but the final `data: [DONE]` line had no trailing newline — it sits
   *  in the parser buffer, and the DONE IPC event's flush() is what would fire
   *  onStreamComplete. */
  const staleWireTail = (): string[] => [
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]', // no trailing newline — the flush-only line
  ]

  const setup = (host: ReturnType<typeof makeSteerHost>, engine: InstanceType<typeof AgentEngine>, continueCalls: { n: number }) => {
    engine.continueLoop = async (): Promise<void> => {
      continueCalls.n += 1
      const second = runnerOf(engine).run(engine.opts, REQ)
      await tick()
      host.pump(steeredReplyStream())
      host.complete()
      await second
      await tick()
    }
    engine.thinkingOnlyRetries = 0
    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    return firstRun
  }

  it('a stale DONE flushes nothing: no empty message, no second loop', async () => {
    // The abort's ERROR event must land AFTER the stale DONE — that ordering
    // is the whole point, so the old runner's listeners are still subscribed.
    const host = makeSteerHost({ deferAbortMs: 60 })
    setHost(host)
    const { engine } = makeEngine(host)
    const calls = { n: 0 }
    const firstRun = setup(host, engine, calls)
    host.pump(staleWireTail())
    await tick()

    const outcome = await engine.steer('转向：改做搜索')
    host.doneFor(host.requestIds[0]) // the stale DONE
    await firstRun                   // settles via the dead-request gate
    await tick()
    await tick()                     // let the 60ms deferred abort drain

    expect(outcome).toEqual({ ok: true })
    expect(engine.isCancelled).toBe(false)
    // One steer round, one steered round — no contentless assistant message.
    expect(engine.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(engine.messages.every((m) => m.contentBlocks.length > 0)).toBe(true)
    const final = engine.messages[3]
    const finalText = final.contentBlocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    expect(finalText).toContain('新指示')
    // The stale DONE must not have walked the thinking-only branch into a
    // second concurrent loop.
    expect(calls.n).toBe(1)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
  })

  it('a late block_start chunk of the dead request cannot repopulate the canvas', async () => {
    const host = makeSteerHost({ deferAbortMs: 60 })
    setHost(host)
    const { engine } = makeEngine(host)
    const calls = { n: 0 }
    const firstRun = setup(host, engine, calls)
    await tick()

    await engine.steer('转向：改做搜索')
    // The dead round's SECOND block (a tool_use) starts after the canvas was
    // cleared: without the guard it lands at canvas[1] — beside the steered
    // round's own block — and rides into R2's completion as a ghost tool call.
    const r1 = host.requestIds[0]
    host.pump([sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_ghost', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://x"}' } }] } }] })], r1)
    expect(engine.currentAssistantBlocks.filter(Boolean)).toHaveLength(0)
    await firstRun
    await tick()
    await tick()

    // The steered round closes cleanly, with no ghost tool in its message.
    expect(engine.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(engine.messages[3].contentBlocks.some((b) => b.type === 'tool_use')).toBe(false)
    expect(calls.n).toBe(1)
    expect(engine.agentStatus).toEqual({ status: 'completed' })
  })

  // review_20261007 中1: the dead-letter guard dropped the ERROR's deferred
  // resolve, so the REAL cancel wire (ERROR event + resolved invoke — what
  // api-proxy actually sends) left the old runner waiting out the full 30s
  // watchdog per steer/stop, and the catch's isCancel arm then fired the
  // turn-end hooks over a transcript the replacement round already owns. The
  // fake host now pumps the real wire shape; the dead runner must settle
  // PROMPTLY through the gate, and no turn-end hook may fire for it.
  it('a real-shape abort settles the dead runner promptly, firing no turn-end hooks', async () => {
    const host = makeSteerHost()
    setHost(host)
    const { engine } = makeEngine(host)
    const afterLlmCall = vi.fn()
    const afterSession = vi.fn()
    ;(engine.opts as unknown as { hooks: Record<string, unknown> }).hooks = { afterLlmCall, afterSession }
    engine.continueLoop = async (): Promise<void> => {} // the steer's re-dispatch is not this test's subject

    engine.agentStatus = { status: 'streaming' }
    const firstRun = runnerOf(engine).run(engine.opts, REQ)
    host.pump(partialTextStream())
    await tick()

    const outcome = await engine.steer('转向：改做搜索')
    expect(outcome).toEqual({ ok: true })
    const t0 = Date.now()
    await firstRun
    const settleMs = Date.now() - t0
    expect(settleMs).toBeLessThan(2000) // the broken shape waited STREAM_DONE_WATCHDOG_MS (30s) here
    expect(afterLlmCall).not.toHaveBeenCalled()
    expect(afterSession).not.toHaveBeenCalled()
    expect(engine.isCancelled).toBe(false)
    await tick()
  })
})

// ── Wiring scans (static; the runtime surface is covered above) ──
describe('steer wiring', () => {
  const readSrc = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('session-manager dispatches steer, bypassing the loop semaphore', () => {
    const src = readSrc('src/main/agent/session-manager.ts')
    expect(src).toContain("case 'steer':")
    // The case lives in dispatchEngineCall (engineCall), NOT sendUserMessage —
    // the loop semaphore must never park a steer behind the turn it redirects.
    const dispatchIdx = src.indexOf('private dispatchEngineCall')
    expect(src.slice(dispatchIdx)).toContain("case 'steer':")
  })

  it('the renderer sends steer through the engine-call channel and the UI gates it on streaming', () => {
    expect(readSrc('src/renderer/src/hooks/useConversationEngine.ts')).toContain("'steer'")
    expect(readSrc('src/renderer/src/hooks/useChatController.ts')).toContain('steer: engine.steer')
    const input = readSrc('src/renderer/src/components/chat/InputArea.tsx')
    expect(input).toContain('canSteer')
    expect(input).toContain('submitSteer')
    // 方案 A: the veto branch rides the PROVEN keydown door (staging branch
    // precedent), and the stop button is untouched (single-stop ruling).
    expect(input).toContain('canSteer &&\n      e.key')
    expect(input).toContain('chatView.sender.steer')
  })
})
