/**
 * LLM stream runner (PLAN-0.3.5 refactor, split 7/5): parser wiring, chunk
 * pump, stream-done await and idle-retry, extracted from AgentEngine.
 */
import { MAX_EARLYSTOP_CONTINUATIONS, MAX_STREAM_IDLE_RETRIES, MAX_THINKING_ONLY_RETRIES, STREAM_IDLE_TIMEOUT_MARKERS, STREAM_DONE_WATCHDOG_MS, STREAM_DONE_WATCHDOG_ERROR, STREAM_NETWORK_ERROR_MARKERS } from './engine-constants'
import { hasTaskDoneSentinel, stripTaskDoneSentinel } from './task-sentinel'
import { runTurnEndMemoryExtraction } from './memory-extraction'
import { isContextOverflowRejection, parseContextOverflowLimit } from './context-estimate'
import { IncrementalJsonTracker } from '../json-stream'
import { extractInvokeToolCalls } from './result-ingestion'
import { summarizeToolCall } from './context-compactor'
import { generateMsgId, safeInvokeObserver } from '../agent-utils'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import type { AgentEngineOptions } from '../AgentEngine'
import type { EngineCore } from './engine-core'

interface PreparedRequest {
  apiUrl: string
  headers: Record<string, string>
  resolvedBody: unknown
}

export class StreamRunner {
  constructor(private engine: EngineCore) {}

  async run(opts: AgentEngineOptions, req: PreparedRequest): Promise<void> {
    const { apiUrl, headers, resolvedBody } = req

    // Variables for cleanup — hoisted outside try so catch can access them.
    // requestId is generated here too: it's side-effect-free, and the catch's
    // cancelledRequestIds check must see a definite string even if the try
    // body throws before the engine ever saw the id.
    const requestId = `api_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    let streamError: string | null = null
    let unsubChunk: () => void
    let unsubError: () => void
    let unsubDone: () => void
    let unsubRetry: () => void
    let cleanupListeners: (() => void) | undefined = undefined
    let streamDeferredResolve: () => void
    const streamDonePromise = new Promise<void>(resolve => { streamDeferredResolve = resolve })
    let streamDone = false

    try {
      this.engine.currentRequestId = requestId

      const dispatcher = opts.adapter.createStreamParser({
        onContentBlockStart: (index, blockData) => {
          const { type, id, name } = blockData
          if (type === 'text') { this.engine.currentAssistantBlocks[index] = { type: 'text', text: '' } }
          else if (type === 'thinking') { this.engine.currentAssistantBlocks[index] = { type: 'thinking', thinking: (blockData as any).thinking || '', signature: (blockData as any).signature || undefined } }
          else if (type === 'redacted_thinking') { this.engine.currentAssistantBlocks[index] = { type: 'redacted_thinking', data: (blockData as any).data || '' } }
          else if (type === 'tool_use') {
            this.engine.currentAssistantBlocks[index] = { type: 'tool_use', id: id || '', name: name || '', input: {}, status: 'pending' }
            this.engine.jsonAccumulators.set(index, new IncrementalJsonTracker())
            this.engine.reportSpawnProgress(`子代理正在生成工具调用: ${name || ''}...`)
          }
        },
        onContentBlockDelta: (index, delta) => {
          const block = this.engine.currentAssistantBlocks[index]
          if (!block) return
          if (delta.type === 'text_delta' && block.type === 'text') {
            block.text += delta.text || ''
            this.engine.reportSpawnProgress(`子代理思考中... (第${this.engine.loopCount}轮)`)
          }
          else if (delta.type === 'thinking_delta' && block.type === 'thinking') { (block as any).thinking += (delta as any).thinking || '' }
          else if (delta.type === 'signature_delta' && block.type === 'thinking') { (block as any).signature = ((block as any).signature || '') + ((delta as any).signature || '') }
          else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            // Incremental scan: only new chars are inspected; the full
            // JSON.parse runs exactly once when the top-level object closes
            // (the old per-delta JSON.parse(acc) was O(n²) and nearly always
            // threw while the object was incomplete).
            const tracker = this.engine.jsonAccumulators.get(index)
            if (tracker) {
              const r = tracker.push(delta.partial_json || '')
              if (r.justCompleted) block.input = r.value as Record<string, unknown>
            }
          }
          this.engine.streamingBlocks = this.engine.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
          this.engine.notifyStreamingCoalesced()
        },
        onContentBlockStop: (index) => {
          const block = this.engine.currentAssistantBlocks[index]
          if (block?.type === 'tool_use') {
            const acc = this.engine.jsonAccumulators.get(index)?.accumulated() ?? ''
            try { block.input = JSON.parse(acc) } catch {
              if (block.name === 'write') {
                const fpMatch = acc.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
                if (fpMatch) { (block as any)._partialFilePath = fpMatch[1] }
              }
              block.input = {}
              ;(block as any)._jsonTruncated = true
            }
            this.engine.reportSpawnProgress(`工具参数就绪: ${summarizeToolCall(block.name, block.input)}`, true)
          }
          this.engine.streamingBlocks = this.engine.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
          this.engine.notify()
        },
        onStreamComplete: async (stopReason, usage) => {
          if (this.engine.isCancelled) return

          const elapsedMs = this.engine.requestStartTime > 0 ? Math.round(performance.now() - this.engine.requestStartTime) : 0
          const rawBlocks = this.engine.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
          // Fallback: some models (e.g. deepseek-v4-flash via the opencode zen/go
          // gateway) drift into Codex/Claude-Code style `<invoke name=...>` XML
          // tool calls emitted as plain text. The adapter only converts
          // `delta.tool_calls`, so this XML lands in a text block and NEVER
          // executes — the model "thinks" it called a tool, nothing runs, and it
          // degenerates into repeat loops. Parse the XML back into real tool_use
          // blocks so the tools actually run.
          const extracted = extractInvokeToolCalls(this.engine.opts, rawBlocks)
          // Early-stop guard companion (2026-10-08): a guarded model ends a
          // finished task with the bare line <<TASK_DONE>>. The declaration is
          // engine bookkeeping, not user-facing prose — peel it off the text
          // blocks BEFORE the message lands (transcript, persistence and the
          // extension mirror never see it). A text block that was NOTHING but
          // the declaration is dropped whole. Flag-gated (review 20261009
          // 中2): an unguarded model never signed this protocol, so a literal
          // <<TASK_DONE>> line in its output — a code sample, a discussion of
          // this very mechanism — is content and must reach the transcript,
          // persistence and the mirror verbatim.
          let hasTaskDone = false
          if (opts.earlyStopGuard === true) {
            const kept: ContentBlock[] = []
            for (const b of extracted.blocks) {
              if (b.type === 'text' && hasTaskDoneSentinel((b as { text?: string }).text)) {
                hasTaskDone = true
                const text = stripTaskDoneSentinel((b as { text: string }).text)
                if (text !== null) kept.push({ ...b, text })
                continue
              }
              kept.push(b)
            }
            extracted.blocks = kept
          }
          const blocks = extracted.blocks
          const convertedInvoke = extracted.converted
          const assistantMsg: AgentMessage = {
            id: generateMsgId(),
            role: 'assistant',
            contentBlocks: blocks,
            createdAt: new Date().toISOString(),
            processingMs: elapsedMs,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            promptCacheHitTokens: usage?.promptCacheHitTokens
          }

          this.engine.messages = [...this.engine.messages, assistantMsg]
          this.engine.streamingBlocks = []
          this.engine.notify()

          // Prefix-cache readout: the share of the prompt that reused the previous
          // request's cache. Watch it across turns — a drop to ~0 means something
          // ahead of the history changed (see system-prompt-builder's core vs
          // state-block split and collectEnabledTools' tool ordering). The stop
          // reason rides along: it is not persisted anywhere else, and telling
          // `end_turn` from `max_tokens` after the fact is the difference
          // between "model chose to stop" and "output budget exhausted"
          // (conv_20260927170026 diagnosis cost an afternoon without it).
          if (usage?.inputTokens) {
            const hit = usage.promptCacheHitTokens ?? 0
            console.log(
              `[LLM Cache] hit ${hit}/${usage.inputTokens} (${((hit / usage.inputTokens) * 100).toFixed(1)}%) out=${usage.outputTokens ?? '?'} stop=${stopReason ?? '?'}`
            )
          }

          const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')

          if (toolUses.length > 0) this.engine.reportSpawnProgress(`子代理第 ${this.engine.loopCount} 轮完成,${toolUses.length} 个工具待执行`, true)

          // A round that produced tool calls is PROGRESS: the early-stop
          // guard's stretch counter re-arms (the manual pattern was "keep
          // nudging while it moves"). Covers the tool_use branch and the
          // max_tokens-with-truncated-calls branch alike.
          if (toolUses.length > 0) this.engine.earlyStopContinues = 0

          // Execute tools even when the model finished with end_turn/stop but we
          // recovered XML `<invoke>` calls — otherwise they'd sit unexecuted.
          if ((stopReason === 'tool_use' || convertedInvoke) && toolUses.length > 0) {
            this.engine.thinkingOnlyRetries = 0
            await this.engine.handleToolUseResponse(toolUses)
            return
          }

          // Thinking-only round (conv_20260927170026, 2026-09-28): a reasoning
          // model that ends with ONLY a thinking block — no text, no tool_use.
          // The measured shape: it writes 「我停止思考，正式输出」 into the CoT
          // and then loops 「好。发。（写）完成。」 hundreds of times until the
          // stream closes with nothing on the canvas. The old dispatch treated
          // the round as a normal turn end (and handleMaxTokensResponse closed
          // the max_tokens variant on purpose), so the user saw the model go
          // silently "unwilling" — the transcript held a collapsed thinking
          // block and no hint. One re-issue per turn is the bounded fix: a
          // fresh sampling chance that cannot reintroduce the 2026-09-20
          // content-less-reissue loop. A round with ANY text is exempt — that
          // is a real answer (or the "short visible reply cut by length" shape
          // that ruling protects), and still flows to handleMaxTokensResponse.
          const hasVisibleText = blocks.some((b) => b.type === 'text' && (b as { text?: string }).text?.trim())
          // A bare <<TASK_DONE>> round is a deliberate completion declaration
          // (possibly text-less after the strip) — NOT a degenerate thinking
          // round; it closes the turn below without a re-issue.
          if (toolUses.length === 0 && !hasVisibleText && !hasTaskDone) {
            if (this.engine.thinkingOnlyRetries < MAX_THINKING_ONLY_RETRIES) {
              this.engine.thinkingOnlyRetries += 1
              console.warn(`[AgentEngine] thinking-only round (stop=${stopReason}, no text/tool_use) — re-issuing (${this.engine.thinkingOnlyRetries}/${MAX_THINKING_ONLY_RETRIES})`)
              this.engine.agentStatus = {
                status: 'retrying',
                message: `模型只输出了思考、没有产出内容或工具调用，自动重试 (${this.engine.thinkingOnlyRetries}/${MAX_THINKING_ONLY_RETRIES})…`,
                attempt: this.engine.thinkingOnlyRetries,
                maxRetries: MAX_THINKING_ONLY_RETRIES,
                delay: 0
              }
              this.engine.notify()
              await this.engine.continueLoop()
              return
            }
            // Second consecutive degenerate round: re-issuing again is the
            // trap the 2026-09-20 ruling closed. End the turn LOUDLY — an
            // explicit error the user can retry or 继续 from — never the old
            // silent close.
            console.warn(`[AgentEngine] thinking-only round persisted after retry (stop=${stopReason}) — ending the turn with an explicit error`)
            const hint = '模型连续两轮只输出了思考，没有生成正文或工具调用，回合已停止。可直接重试，或输入「继续」让其接着当前进度往下做。'
            this.engine.agentStatus = { status: 'error', error: hint }
            this.engine.notify()
            safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason, status: { status: 'error', error: hint } }, 'afterLlmCall')
            safeInvokeObserver(opts.hooks?.afterSession, { messages: this.engine.messages, status: { status: 'error', error: hint } }, 'afterSession')
            runTurnEndMemoryExtraction(this.engine)
            this.engine.resolveCompletionIfSpawned('error')
            this.engine.notify()
            return
          }
          this.engine.thinkingOnlyRetries = 0

          // ── Early-stop continuation guard (2026-10-08, opts.earlyStopGuard
          // models only) ─────────────────────────────────────────────────
          // A weak model's chat prior narrates the next step as prose and ends
          // the turn (end_turn, visible text, no tool_use) while the task is
          // in flight — the one degenerate shape the thinking-only retry above
          // deliberately does not cover. Evidence of a task actually running:
          // this turn has SETTLED tool rounds. Signal of a legitimate close:
          // the <<TASK_DONE>> sentinel (its absence on a guarded model is the
          // "stopped early" vote; max_tokens closes stay with their own 2026-09-20
          // ruling below). Response: ONE continuation per progress stretch —
          // the next state block carries the Turn Continuation directive — and
          // a productive (tool-carrying) continuation re-arms it. An
          // unproductive one falls through to the ordinary close: the model's
          // words are on the canvas, a finished task ends exactly as before,
          // and a chatty stop hands the turn back to the user.
          // Ordering note: this guard consumes the text-only close BEFORE
          // execution-flow's multi-expert summon nudge can see it — an
          // @-summon turn (tool rounds counted, model closes in prose) burns
          // one bounded continuation here first. The two bounded mechanisms
          // overlap by at most one request per turn; accepted tradeoff.
          if (stopReason !== 'max_tokens' && this.engine.opts.earlyStopGuard === true && !hasTaskDone) {
            const canNudge = this.engine.toolRoundsThisTurn > 0
              && this.engine.earlyStopContinues === 0
              && this.engine.earlyStopNudgesTotal < MAX_EARLYSTOP_CONTINUATIONS
            if (canNudge) {
              this.engine.earlyStopContinues += 1
              this.engine.earlyStopNudgesTotal += 1
              this.engine.pendingEarlyStopNudge = true
              console.warn(`[AgentEngine] early-stop guard: text-only end_turn after ${this.engine.toolRoundsThisTurn} tool round(s), no sentinel — auto-continuing (${this.engine.earlyStopNudgesTotal}/${MAX_EARLYSTOP_CONTINUATIONS})`)
              this.engine.agentStatus = {
                status: 'retrying',
                message: `模型中途停止了工具调用，正在自动续跑 (${this.engine.earlyStopNudgesTotal}/${MAX_EARLYSTOP_CONTINUATIONS})…`,
                attempt: this.engine.earlyStopNudgesTotal,
                maxRetries: MAX_EARLYSTOP_CONTINUATIONS,
                delay: 0
              }
              this.engine.notify()
              await this.engine.continueLoop()
              return
            }
          }

          if (stopReason === 'max_tokens') {
            await this.engine.handleMaxTokensResponse(toolUses)
            return
          }

          // end_turn / stop_sequence
          this.engine.handleEndTurnResponse(stopReason)
        },

        onError: (error) => {
          console.error('[AgentEngine] SSE error:', error)
          if (!this.engine.isCancelled) streamError = error
        }
      })

      // Register IPC listeners. Every listener carries the same
      // cancelledRequestIds guard (review_20261006 中1): once steer/prepareTurn/
      // retry/dispose aborted THIS request, events already queued in the IPC
      // channel must be dead letters. Without it a DONE that was in flight when
      // the steer ran flushes the just-cleared canvas into an empty assistant
      // message and — no text, no tool_use — walks the thinking-only branch into
      // a second continueLoop running beside the steered one. The guard is the
      // same source the catch's isCancel check reads, so one line covers every
      // cancel entrance. cleanupListeners deletes the id only AFTER
      // unsubscribing, so a guarded id can never belong to a live request.
      const isDeadRequest = () => this.engine.cancelledRequestIds.has(requestId)
      unsubChunk = this.engine.getHost().onApiStreamChunk(data => { if (data.requestId === requestId && !isDeadRequest()) dispatcher.processChunk(data.data) })

      // Dead letters drop the PAYLOAD but still resolve the deferred: the real
      // cancel wire is an ERROR event plus the invoke RESOLVING (api-proxy
      // aborts via sinks.onError + return, never a reject), so nothing else
      // would ever settle the stream-done await below
      // (review_20261007 中1).
      unsubError = this.engine.getHost().onApiStreamError(data => { if (data.requestId !== requestId) return; if (isDeadRequest()) { streamDeferredResolve(); return } streamError = data.error; streamDeferredResolve() })
      unsubDone = this.engine.getHost().onApiStreamDone(data => { if (data.requestId !== requestId) return; if (isDeadRequest()) { streamDeferredResolve(); return } streamDone = true; dispatcher.flush(); streamDeferredResolve() })
      unsubRetry = this.engine.getHost().onApiStreamRetry(data => {
        if (data.requestId !== requestId || isDeadRequest()) return
        this.engine.agentStatus = { status: 'retrying', message: data.message, attempt: data.attempt, maxRetries: data.maxRetries, delay: data.delay }
        this.engine.notify()
      })

      cleanupListeners = () => { unsubChunk(); unsubError(); unsubDone(); unsubRetry(); if (this.engine.currentRequestId === requestId) this.engine.currentRequestId = null; this.engine.cancelledRequestIds.delete(requestId) }

      // console.log(`[AgentEngine] POST body: ${(resolvedBody as any).messages?.length ?? 0} messages`)

      await this.engine.getHost().apiFetchStream(requestId, apiUrl, { method: 'POST', headers, body: resolvedBody as string | object, profileId: this.engine.opts.profileId })

      // A dead request (steer/stop/retry/dispose aborted it) exits HERE: its
      // ERROR event was a dead letter above, and the invoke resolved normally —
      // without this gate the old runner sat out the full 30s watchdog per
      // steer/stop, and its catch's isCancel arm then fired afterSession's
      // memory extraction over a transcript the replacement round already owns
      // (review_20261007 中1).
      if (isDeadRequest()) { cleanupListeners(); return }

      // Await the stream-done IPC event. The main process always sends either
      // API_STREAM_DONE or API_STREAM_ERROR, and both resolve streamDonePromise.
      // The watchdog is the "always" insurance: done/error fire synchronously
      // before the invoke resolves, so a still-pending deferred here means a
      // resolver was dropped below — bounded wait, then a retryable error that
      // settles the turn instead of parking the engine forever
      // (conv_20260930091135: two plan sub-agents hung exactly here-shaped).
      if (!streamDone && !streamError) {
        await Promise.race([
          streamDonePromise,
          new Promise<void>((resolve) => setTimeout(resolve, STREAM_DONE_WATCHDOG_MS)),
        ])
        if (!streamDone && !streamError) throw new Error(STREAM_DONE_WATCHDOG_ERROR)
      }
      if (streamError) { cleanupListeners(); throw new Error(streamError) }
      cleanupListeners()
      this.engine.streamIdleRetries = 0 // a stream succeeded — reset consecutive-retry counter
      // A request the provider ACCEPTED reprices the context: the overflow
      // flag's forced cut did its job (or was never needed), so the regular
      // trigger chain regains authority and the next overflow gets one more
      // automatic retry.
      this.engine.contextOverflowLimit = null
      this.engine.contextOverflowRetries = 0
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      // Was THIS request cancelled? The request-id set, not the mutable
      // isCancelled: a resume (or retry) that lands between the abort and this
      // rejection's microtask clears the flag, and the old request's death
      // would be misread as a fresh engine error — erroring/settling an engine
      // the user just resumed (tests/stop-settles-subagents.test.ts pins it).
      const isCancel = this.engine.isCancelled || this.engine.cancelledRequestIds.has(requestId)
      cleanupListeners?.()

      // Auto-retry on stream idle timeout (main-process aborts after 60s idle):
      // the connection stalled mid-stream (long silent thinking, network blip).
      // this.engine.messages is untouched until onStreamComplete, so discard the partial
      // streaming state and re-issue the request from scratch.
      const isIdleTimeout = STREAM_IDLE_TIMEOUT_MARKERS.some(m => message.includes(m))
      if (!isCancel && isIdleTimeout && this.engine.streamIdleRetries < MAX_STREAM_IDLE_RETRIES) {
        this.engine.streamIdleRetries += 1
        console.warn(`[AgentEngine] Stream idle timeout (${this.engine.streamIdleRetries}/${MAX_STREAM_IDLE_RETRIES}) — retrying`)
        this.engine.currentAssistantBlocks = []
        this.engine.streamingBlocks = []
        this.engine.jsonAccumulators = new Map()
        this.engine.toolUseBlocks = []
        this.engine.agentStatus = { status: 'retrying', message: `连接闲置超时，自动重试 (${this.engine.streamIdleRetries}/${MAX_STREAM_IDLE_RETRIES})…`, attempt: this.engine.streamIdleRetries, maxRetries: MAX_STREAM_IDLE_RETRIES, delay: 0 }
        this.engine.notify()
        await this.engine.continueLoop()
        return
      }
      // Mid-stream network failure (see STREAM_NETWORK_ERROR_MARKERS): the
      // connection DIED actively — reset mid-body, an exhausted retry chain in
      // the proxy, or the sleep/resume cancelAllRequests sweep. Same budget as
      // the idle timeout above (consecutive transport failures are one
      // resource — which is why this branch sits BEFORE the reset below: a
      // non-transport error ends the turn and refills the budget, an
      // alternating idle/network sequence must not). Messages are untouched
      // until onStreamComplete, so the re-issue regenerates from scratch. An
      // 'HTTP …' status error never reaches here: 4xx are semantic and 429/5xx
      // already got the proxy's 20 backoff attempts — engine-level retries
      // would only re-hammer a provider that has been failing for minutes.
      const isNetworkFailure = !message.startsWith('HTTP ')
        && STREAM_NETWORK_ERROR_MARKERS.some(m => message.includes(m))
      if (!isCancel && isNetworkFailure && this.engine.streamIdleRetries < MAX_STREAM_IDLE_RETRIES) {
        this.engine.streamIdleRetries += 1
        console.warn(`[AgentEngine] Stream network failure (${this.engine.streamIdleRetries}/${MAX_STREAM_IDLE_RETRIES}): ${message.slice(0, 200)} — retrying`)
        this.engine.currentAssistantBlocks = []
        this.engine.streamingBlocks = []
        this.engine.jsonAccumulators = new Map()
        this.engine.toolUseBlocks = []
        this.engine.agentStatus = { status: 'retrying', message: `网络连接中断，自动重试 (${this.engine.streamIdleRetries}/${MAX_STREAM_IDLE_RETRIES})…`, attempt: this.engine.streamIdleRetries, maxRetries: MAX_STREAM_IDLE_RETRIES, delay: 0 }
        this.engine.notify()
        await this.engine.continueLoop()
        return
      }
      this.engine.streamIdleRetries = 0

      // Context-overflow rescue (0.4.1: "ring says 35%, model says overflow").
      // The provider's 400 is the ground truth the estimates answer to: park
      // the parsed limit on the engine — prepareLoopRequest will force the API
      // copy under it via compactor.emergencyTruncate — and re-issue the
      // request once, exactly like the idle-timeout retry above. If the
      // truncated request is ALSO rejected the turn errors out with the flag
      // still set, so every later request (manual retry included) stays forced
      // under the limit until one is accepted.
      if (!isCancel && isContextOverflowRejection(message)) {
        const limit = parseContextOverflowLimit(message) ?? Math.floor((this.engine.opts.contextLength || 128_000) / 2)
        this.engine.contextOverflowLimit = limit
        if (this.engine.opts.contextLength && limit < this.engine.opts.contextLength) {
          // The profile's number is the denominator of the context ring AND
          // the target of every compaction trigger — a wrong one disables both.
          console.warn(`[AgentEngine] provider limit ${limit} < profile contextLength ${this.engine.opts.contextLength} — fix the profile's 上下文长度 setting`)
        }
        if (this.engine.contextOverflowRetries < 1) {
          this.engine.contextOverflowRetries += 1
          console.warn(`[AgentEngine] context overflow (${limit} tokens) — emergency truncation + one retry`)
          this.engine.currentAssistantBlocks = []
          this.engine.streamingBlocks = []
          this.engine.jsonAccumulators = new Map()
          this.engine.toolUseBlocks = []
          this.engine.agentStatus = { status: 'retrying', message: '上下文超限，已按模型上限截断历史并重试…', attempt: 1, maxRetries: 1, delay: 0 }
          this.engine.notify()
          await this.engine.continueLoop()
          return
        }
      }

      if (!isCancel) { this.engine.agentStatus = { status: 'error', error: message }; this.engine.notify() }
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: null, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterLlmCall')
      safeInvokeObserver(opts.hooks?.afterSession, { messages: this.engine.messages, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterSession')
      // Turn-end memory salvage — same contract as execution-flow's call.
      runTurnEndMemoryExtraction(this.engine)
      if (!isCancel) this.engine.resolveCompletionIfSpawned('error')
      if (isCancel) return
      this.engine.notify()
    }

  }
}
