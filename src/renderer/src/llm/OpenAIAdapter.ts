import type { AgentMessage, TextBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock } from '../types/agent'
import type { ToolDefinition } from '../tools/types'
import type { LlmAdapter } from './adapter'
import type { LlmRequestParams } from './types'
import type { StreamEventHandlers, StreamParser } from './stream-types'
import { createStreamParser, fetchStreamChunks } from './stream-utils'

// ── Stop Reason Normalization ─────────────────────────────────────────

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'content_filter'
}

function normalizeFinishReason(reason: string | null): string | null {
  if (!reason) return null
  return FINISH_REASON_MAP[reason] || reason
}

// ── OpenAI SSE Parser ─────────────────────────────────────────────────

function createOpenAIStreamParser(handlers: StreamEventHandlers): StreamParser {
  let textBlockIndex = -1
  let textBlockStarted = false
  let thinkingBlockIndex = -1
  let thinkingBlockStarted = false
  // openai tool_call index -> internal block index
  const toolCallMap = new Map<number, number>()
  const toolCallIdMap = new Map<string, number>()
  let nextBlockIndex = 0
  let usageInputTokens = 0
  let usageOutputTokens = 0
  let completed = false
  let pendingFinishReason: string | null = null

  function finalizeBlocks(): void {
    if (thinkingBlockStarted) {
      handlers.onContentBlockStop(thinkingBlockIndex)
      thinkingBlockStarted = false
      thinkingBlockIndex = -1
    }
    if (textBlockStarted) {
      handlers.onContentBlockStop(textBlockIndex)
      textBlockStarted = false
      textBlockIndex = -1
    }
    const seen = new Set<number>()
    for (const [, blockIdx] of toolCallMap) seen.add(blockIdx)
    for (const [, blockIdx] of toolCallIdMap) seen.add(blockIdx)
    for (const blockIdx of seen) handlers.onContentBlockStop(blockIdx)
    toolCallMap.clear()
    toolCallIdMap.clear()
  }

  function processLine(line: string) {
    if (completed) return
    if (!line.startsWith('data: ')) return
    const data = line.slice(6).trim()

    if (data === '[DONE]') {
      if (pendingFinishReason) {
        completed = true
        handlers.onStreamComplete(normalizeFinishReason(pendingFinishReason), {
          inputTokens: usageInputTokens,
          outputTokens: usageOutputTokens
        })
        pendingFinishReason = null
      }
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    // Capture usage from the final chunk (OpenAI streams it alongside finish_reason)
    if (parsed.usage) {
      usageInputTokens = parsed.usage.prompt_tokens || 0
      usageOutputTokens = parsed.usage.completion_tokens || 0
    }

    const choices = parsed.choices
    if (!choices || choices.length === 0) {
      // Final chunk may have only usage (no choices) — flush and complete
      if (parsed.usage) {
        if (pendingFinishReason) {
          // Usage arrived in a separate chunk after finish_reason
          completed = true
          handlers.onStreamComplete(normalizeFinishReason(pendingFinishReason), {
            inputTokens: usageInputTokens,
            outputTokens: usageOutputTokens,
            promptCacheHitTokens: parsed.usage?.prompt_cache_hit_tokens ?? undefined
          })
          pendingFinishReason = null
        } else if (!completed) {
          finalizeBlocks()
          completed = true
          handlers.onStreamComplete('end_turn', {
            inputTokens: usageInputTokens,
            outputTokens: usageOutputTokens,
            promptCacheHitTokens: parsed.usage?.prompt_cache_hit_tokens ?? undefined
          })
        }
      }
      return
    }

    const delta = choices[0].delta || {}
    const finishReason = choices[0].finish_reason

    // ── Reasoning content (OpenAI o1/o3 thinking) ────────────
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      if (!thinkingBlockStarted) {
        thinkingBlockIndex = nextBlockIndex++
        handlers.onContentBlockStart(thinkingBlockIndex, { type: 'thinking' })
        thinkingBlockStarted = true
      }
      handlers.onContentBlockDelta(thinkingBlockIndex, {
        type: 'thinking_delta',
        thinking: delta.reasoning_content
      })
    }

    // ── Text content ──────────────────────────────────────────────
    if (delta.content !== undefined && delta.content !== null && (delta.content.trim() || textBlockStarted)) {
      // Close thinking block before text starts (reasoning comes first)
      if (thinkingBlockStarted) {
        handlers.onContentBlockStop(thinkingBlockIndex)
        thinkingBlockStarted = false
        thinkingBlockIndex = -1
      }

      if (!textBlockStarted) {
        textBlockIndex = nextBlockIndex++
        handlers.onContentBlockStart(textBlockIndex, { type: 'text' })
        textBlockStarted = true
      }
      handlers.onContentBlockDelta(textBlockIndex, { type: 'text_delta', text: delta.content })
    }

    // ── Tool calls ────────────────────────────────────────────────
    if (delta.tool_calls) {
      // Text block is done once tool calls start
      if (textBlockStarted) {
        handlers.onContentBlockStop(textBlockIndex)
        textBlockStarted = false
        textBlockIndex = -1
      }

      for (const tc of delta.tool_calls) {
        const tcIdx = tc.index

        // Use id as primary key (some providers reuse index across different tool calls).
        // IMPORTANT: use === undefined, not !blockIdx — blockIdx can be 0 which is falsy!
        let blockIdx: number | undefined
        if (tc.id) {
          blockIdx = toolCallIdMap.get(tc.id)
          if (blockIdx === undefined) {
            blockIdx = nextBlockIndex++
            toolCallIdMap.set(tc.id, blockIdx)
            toolCallMap.set(tcIdx, blockIdx)
            handlers.onContentBlockStart(blockIdx, {
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name || 'unknown'
            })
          }
        } else {
          blockIdx = toolCallMap.get(tcIdx)
        }

        if (blockIdx !== undefined && tc.function?.arguments) {
          handlers.onContentBlockDelta(blockIdx, {
            type: 'input_json_delta',
            partial_json: tc.function.arguments
          })
        }
      }
    }

    // ── Finish ────────────────────────────────────────────────────
    if (finishReason) {
      finalizeBlocks()
      if (parsed.usage) {
        // Same chunk carries both finish_reason and usage (typical OpenAI)
        completed = true
        handlers.onStreamComplete(normalizeFinishReason(finishReason), {
          inputTokens: usageInputTokens,
          outputTokens: usageOutputTokens,
          promptCacheHitTokens: parsed.usage?.prompt_cache_hit_tokens ?? undefined
        })
      } else {
        // Usage may arrive in a separate chunk — defer onStreamComplete
        pendingFinishReason = finishReason
      }
    }
  }

  return createStreamParser(processLine)
}

// ── Message Builder ───────────────────────────────────────────────────

/**
 * Convert internal AgentMessage[] to OpenAI Chat Completions format.
 *
 * Rules:
 * - System prompt is the first message with role 'system' (not top-level field)
 * - Assistant messages with tool_use become role:'assistant' with tool_calls[]
 * - tool_result blocks become separate role:'tool' messages
 * - User content is a string (OpenAI doesn't use content block arrays for user msgs)
 * - thinking blocks become reasoning_content on the assistant message (OpenAI reasoning models)
 * - redacted_thinking blocks are filtered (not supported by OpenAI)
 */
function buildApiMessages(messages: AgentMessage[], systemPrompt: string): unknown[] {
  const result: unknown[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  // Track pending tool_call IDs from the most recent assistant message.
  // Used to detect orphaned tool_results whose matching tool_use was dropped
  // by the compaction pipeline (hardTruncate/lightCompact).
  let pendingToolCallIds: Set<string> | null = null

  for (const msg of messages) {
    const textBlocks = msg.contentBlocks.filter(
      (b): b is TextBlock => b.type === 'text'
    )
    const toolUseBlocks = msg.contentBlocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    )
    const toolResultBlocks = msg.contentBlocks.filter(
      (b): b is ToolResultBlock => b.type === 'tool_result'
    )
    const thinkingBlocks = msg.contentBlocks.filter(
      (b): b is ThinkingBlock => b.type === 'thinking'
    )

    if (msg.role === 'user') {
      // Safety net: orphaned tool_results (no preceding assistant with matching
      // tool_calls) are converted to text to prevent HTTP 400 from OpenAI.
      const pending = pendingToolCallIds
      pendingToolCallIds = null

      const orphanedText: string[] = []
      for (const tr of toolResultBlocks) {
        // OpenAI tool messages have no is_error field, so encode the failure
        // signal in the content itself — otherwise the model can't tell a
        // failed tool (timeout, truncated params, nonzero exit) from a success
        // once nanoCompact strips the result to a placeholder.
        const content = tr.is_error ? `[tool_result_error] ${tr.content}` : tr.content
        if (pending && pending.has(tr.tool_use_id)) {
          // Normal case: tool_call_id matches the preceding assistant
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content
          })
        } else {
          // Orphaned: compaction dropped the matching assistant's tool_calls.
          // Fall back to text so the LLM at least sees the content.
          orphanedText.push(`[Tool result for ${tr.tool_use_id}]: ${content.slice(0, 2000)}`)
        }
      }

      // Text content (with orphaned tool result text appended if any)
      const allText = [
        ...textBlocks.map(b => b.text),
        ...(orphanedText.length > 0 ? [`\n\n${orphanedText.join('\n\n')}`] : [])
      ].join('\n')
      if (allText) {
        result.push({ role: 'user', content: allText })
      }
    } else if (msg.role === 'assistant') {
      const assistantMsg: Record<string, unknown> = {
        role: 'assistant',
        content: textBlocks.length > 0
          ? textBlocks.map(b => b.text).join('\n')
          : null
      }

      // OpenAI reasoning models require reasoning_content to be passed back
      if (thinkingBlocks.length > 0) {
        assistantMsg.reasoning_content = thinkingBlocks.map(b => b.thinking).join('\n')
      }

      const toolCalls = toolUseBlocks.length > 0
        ? toolUseBlocks.map(tu => ({
            id: tu.id,
            type: 'function' as const,
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input)
            }
          }))
        : undefined

      if (toolCalls) {
        pendingToolCallIds = new Set(toolUseBlocks.map(tu => tu.id))
        assistantMsg.tool_calls = toolCalls
      } else {
        pendingToolCallIds = null
      }

      // Guard: don't send empty assistant messages (no content, no tool_calls).
      // Catches both null content AND empty string content (from empty text blocks).
      if ((!assistantMsg.content || assistantMsg.content === '') && (!toolCalls || toolCalls.length === 0)) {
        console.log('[OpenAI] Skipping empty assistant message in request, role:', msg.role, 'contentBlocks:', msg.contentBlocks.length, 'textBlocks:', textBlocks.length, 'toolUses:', toolUseBlocks.length)
        continue
      }
      result.push(assistantMsg)
    }
  }

  // Safety net: OpenAI requires every assistant tool_call to be answered by a
  // tool message. Interrupted executions (sleep/resume, user cancel mid-tool)
  // can leave an assistant message with tool_calls and no following tool
  // response. Inject synthetic responses so the request never 400s.
  for (let i = 0; i < result.length; i++) {
    const m = result[i] as { role?: string; tool_calls?: Array<{ id: string }> }
    if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) continue

    // OpenAI requires tool responses to directly follow the assistant message,
    // so the first non-tool message after it breaks the pairing.
    const resolvedIds = new Set<string>()
    for (let j = i + 1; j < result.length; j++) {
      const next = result[j] as { role?: string; tool_call_id?: string }
      if (next.role !== 'tool') break
      if (next.tool_call_id) resolvedIds.add(next.tool_call_id)
    }

    const unresolved = m.tool_calls.filter((tc) => !resolvedIds.has(tc.id))
    if (unresolved.length === 0) continue

    console.warn(`[OpenAI] Injecting synthetic tool response for ${unresolved.length} orphaned tool_call(s):`, unresolved.map((tc) => tc.id))
    const synthetic: unknown[] = unresolved.map((tc) => ({
      role: 'tool',
      tool_call_id: tc.id,
      content: 'Tool execution was interrupted or cancelled before producing a result.'
    }))
    result.splice(i + 1, 0, ...synthetic)
    i += synthetic.length
  }

  return result
}

// ── Adapter ────────────────────────────────────────────────────────────

export const openaiAdapter: LlmAdapter = {
  provider: 'openai',

  buildRequest(baseURL: string, apiKey: string, params: LlmRequestParams) {
    const { model, maxTokens, messages, tools, systemPrompt, stream } = params

    const apiUrl = `${baseURL.replace(/\/+$/, '')}/chat/completions`
    console.log('[OpenAI] messages count:', messages.length, 'tools:', tools?.length ?? 0, 'last msg type:', messages[messages.length-1]?.role, 'blocks:', messages[messages.length-1]?.contentBlocks?.length)

    const { apiMessages } = this.buildMessages(messages, systemPrompt)
    // For OpenAI, system prompt is already in apiMessages — no systemField needed

    const apiTools = this.buildTools(tools)

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream,
      stream_options: { include_usage: true }
    }

    if (apiTools.length > 0) {
      body.tools = apiTools
    }
    body.messages = apiMessages

    return {
      url: apiUrl,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body
    }
  },

  createStreamParser(handlers: StreamEventHandlers): StreamParser {
    return createOpenAIStreamParser(handlers)
  },

  buildMessages(messages: AgentMessage[], systemPrompt: string) {
    return {
      apiMessages: buildApiMessages(messages, systemPrompt)
    }
  },

  buildTools(toolDefinitions: ToolDefinition[]) {
    return toolDefinitions.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }))
  },

  reconcileMessages(messages: AgentMessage[]) {
    // Inject synthetic tool_results for orphaned tool_use blocks (when user
    // interrupts mid-execution). Without this, the API would reject the request
    // with "assistant message with tool_calls must be followed by tool messages".
    for (let i = 0; i < messages.length - 1; i++) {
      const cur = messages[i]
      if (cur.role !== 'assistant') continue
      const toolUses = cur.contentBlocks.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use'
      )
      if (toolUses.length === 0) continue

      const resolvedIds = new Set<string>()
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role !== 'user') break
        for (const block of messages[j].contentBlocks) {
          if (block.type === 'tool_result') resolvedIds.add(block.tool_use_id)
        }
      }

      const unresolved = toolUses.filter(tu => !resolvedIds.has(tu.id))
      if (unresolved.length === 0) continue

      const next = messages[i + 1]
      const targetIndex = i + 1
      if (next?.role === 'user' && next.contentBlocks.some(b => b.type !== 'tool_result')) {
        messages.splice(targetIndex, 0, {
          id: `reconcile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          role: 'user',
          contentBlocks: unresolved.map(tu => ({
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: 'Tool execution was interrupted or cancelled.',
            is_error: true,
            tool_result_id: crypto.randomUUID()
          })),
          createdAt: new Date().toISOString()
        })
      } else {
        if (!next || next.role !== 'user') {
          messages.splice(targetIndex, 0, {
            id: `reconcile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            role: 'user',
            contentBlocks: [],
            createdAt: new Date().toISOString()
          })
        }
        for (const tu of unresolved) {
          messages[targetIndex].contentBlocks.push({
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: 'Tool execution was interrupted or cancelled.',
            is_error: true,
            tool_result_id: crypto.randomUUID()
          })
        }
      }
    }

    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') {
      last.contentBlocks = last.contentBlocks.filter(
        (b) => b.type !== 'tool_use'
      )
    }
  },

  async callNonStreaming(
    apiKey: string,
    baseURL: string,
    model: string,
    systemPrompt: string,
    userMessages: { role: string; content: string }[],
    maxTokens: number = 1000
  ): Promise<string | null> {
    const requestId = `ns_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    }
    const apiMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...userMessages]
      : userMessages
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: apiMessages
    }

    try {
      console.warn(`[OpenAIAdapter] callNonStreaming: url=${url} model=${model} maxTokens=${maxTokens} messages=${apiMessages.length}`)
      const rawChunks: string[] = await fetchStreamChunks(requestId, url, headers, body)

      // Parse SSE chunks, accumulating only visible content text.
      // reasoning_content is internal thinking that must NOT be passed to
      // OneShotAgent parsers — they expect clean responses (title, JSON, keywords).
      let buffer = ''
      let contentText = ''
      for (const chunk of rawChunks) {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) contentText += delta.content
          } catch { /* skip malformed JSON */ }
        }
      }
      // Flush remaining buffer
      if (buffer) {
        const line = buffer
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta
              if (delta?.content) contentText += delta.content
            } catch { /* skip malformed JSON */ }
          }
        }
      }

      if (!contentText) {
        console.warn(`[OpenAIAdapter] callNonStreaming: contentText empty, rawChunks.length=${rawChunks.length}`)
        if (rawChunks.length > 0) {
          const preview = rawChunks.slice(0, 5).map(c => c.slice(0, 300)).join('\\n')
          console.warn(`[OpenAIAdapter] callNonStreaming: chunks preview:`, preview)
          for (const chunk of rawChunks.slice(0, 10)) {
            const m = chunk.match(/data:\s*(\{.+\})/)?.[1]
            if (m) try {
              const p = JSON.parse(m)
              const rc = p.choices?.[0]?.delta?.reasoning_content
              if (rc) { console.warn(`[OpenAIAdapter] Found reasoning_content (len=${rc.length}):`, rc.slice(0, 200)); break }
              const finish = p.choices?.[0]?.finish_reason
              if (finish) { console.warn(`[OpenAIAdapter] finish_reason=${finish}`); break }
            } catch {}
          }
        }
      }
      return contentText || null
    } catch (err) {
      console.log(`[OpenAIAdapter] callNonStreaming failed:`, err)
      return null
    }
  },

  extractTextContent(response: string | null): string | null {
    if (!response) return null
    try {
      const data = JSON.parse(response)
      return data?.choices?.[0]?.message?.content || null
    } catch {
      return response
    }
  }
}
