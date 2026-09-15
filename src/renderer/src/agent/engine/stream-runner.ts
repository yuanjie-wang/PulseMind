/**
 * LLM stream runner (PLAN-0.3.5 refactor, split 7/5): parser wiring, chunk
 * pump, stream-done await and idle-retry, extracted from AgentEngine.
 */
import { MAX_STREAM_IDLE_RETRIES, STREAM_IDLE_TIMEOUT_MARKERS } from './engine-constants'
import { IncrementalJsonTracker } from '../json-stream'
import { extractInvokeToolCalls } from './result-ingestion'
import { summarizeToolCall } from './context-compactor'
import { generateMsgId, safeInvoke, safeInvokeObserver } from '../agent-utils'
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
    const engine = this.engine

    // Variables for cleanup — hoisted outside try so catch can access them
    let requestId: string
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
      requestId = `api_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
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
          // state-block split and collectEnabledTools' tool ordering).
          if (usage?.inputTokens) {
            const hit = usage.promptCacheHitTokens ?? 0
            console.log(
              `[LLM Cache] hit ${hit}/${usage.inputTokens} (${((hit / usage.inputTokens) * 100).toFixed(1)}%) out=${usage.outputTokens ?? '?'}`
            )
          }

          const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')

          if (toolUses.length > 0) this.engine.reportSpawnProgress(`子代理第 ${this.engine.loopCount} 轮完成,${toolUses.length} 个工具待执行`, true)

          // Execute tools even when the model finished with end_turn/stop but we
          // recovered XML `<invoke>` calls — otherwise they'd sit unexecuted.
          if ((stopReason === 'tool_use' || convertedInvoke) && toolUses.length > 0) {
            await this.engine.handleToolUseResponse(toolUses)
            return
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

      // Register IPC listeners
      unsubChunk = this.engine.getHost().onApiStreamChunk(data => { if (data.requestId === requestId) dispatcher.processChunk(data.data) })

      unsubError = this.engine.getHost().onApiStreamError(data => { if (data.requestId !== requestId) return; streamError = data.error; streamDeferredResolve() })
      unsubDone = this.engine.getHost().onApiStreamDone(data => { if (data.requestId !== requestId) return; streamDone = true; dispatcher.flush(); streamDeferredResolve() })
      unsubRetry = this.engine.getHost().onApiStreamRetry(data => {
        if (data.requestId !== requestId) return
        this.engine.agentStatus = { status: 'retrying', message: data.message, attempt: data.attempt, maxRetries: data.maxRetries, delay: data.delay }
        this.engine.notify()
      })

      cleanupListeners = () => { unsubChunk(); unsubError(); unsubDone(); unsubRetry(); if (this.engine.currentRequestId === requestId) this.engine.currentRequestId = null }

      // console.log(`[AgentEngine] POST body: ${(resolvedBody as any).messages?.length ?? 0} messages`)

      await this.engine.getHost().apiFetchStream(requestId, apiUrl, { method: 'POST', headers, body: resolvedBody as string | object, profileId: this.engine.opts.profileId })

      // Await the stream-done IPC event. The main process always sends either
      // API_STREAM_DONE or API_STREAM_ERROR, and both resolve streamDonePromise.
      // No timeout needed — IPC event arrives in the next event loop tick.
      if (!streamDone && !streamError) {
        await streamDonePromise
      }
      if (streamError) { cleanupListeners(); throw new Error(streamError) }
      cleanupListeners()
      this.engine.streamIdleRetries = 0 // a stream succeeded — reset consecutive-retry counter
    } catch (err) {
      cleanupListeners?.()
      const message = err instanceof Error ? err.message : 'Unknown error'
      const isCancel = this.engine.isCancelled

      // Auto-retry on stream idle timeout (main-process aborts after 120s idle):
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
      this.engine.streamIdleRetries = 0

      if (!isCancel) { this.engine.agentStatus = { status: 'error', error: message }; this.engine.notify() }
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.engine.messages, stopReason: null, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterLlmCall')
      safeInvokeObserver(opts.hooks?.afterSession, { messages: this.engine.messages, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterSession')
      if (!isCancel) this.engine.resolveCompletionIfSpawned('error')
      if (isCancel) return
      this.engine.notify()
    }

  }
}
