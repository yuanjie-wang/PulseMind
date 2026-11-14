import { getHost } from '../agent/host'
import type { AgentMessage, ToolUseBlock, ContentBlock, ToolResultBlock } from '../types/agent'
import type { ToolDefinition } from '../tools/types'
import type { LlmAdapter } from './adapter'
import type { LlmRequestParams } from './types'
import type { StreamEventHandlers, StreamParser, LlmUsage } from './stream-types'
import { createStreamParser } from './stream-utils'
import { reconcilePlaceholderFor } from './tool-reconcile'

// ── Helpers ────────────────────────────────────────────────────────────

function contentBlocksToApi(blocks: ContentBlock[]): string | Array<Record<string, unknown>> {
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return blocks[0].text
  }
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'thinking':
          return { type: 'thinking', thinking: (block as any).thinking }
        case 'redacted_thinking':
          return { type: 'redacted_thinking', data: (block as any).data }
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error ? { is_error: true } : {})
          }
        default:
          return { type: 'text', text: '' }
      }
    })
}

// ── SSE Dispatcher ────────────────────────────────────────────────────

function createSseDispatcher(handlers: StreamEventHandlers): StreamParser {
  let currentEvent = ''
  let currentData = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens: number | undefined

  const processLine = (line: string) => {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      currentData = line.slice(5).trim()
    } else if (line.trim() === '') {
      if (currentEvent && currentData) {
        try {
          const parsed = JSON.parse(currentData)
          const type = parsed.type || currentEvent
          switch (type) {
            case 'message_start':
              {
                const usage = parsed.message?.usage || {}
                inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
                cacheReadTokens = usage.cache_read_input_tokens ?? undefined
              }
              console.log('[SSE] message_start usage:', JSON.stringify(parsed.message?.usage))
              break
            case 'content_block_start':
              handlers.onContentBlockStart(parsed.index, parsed.content_block)
              break
            case 'content_block_delta':
              handlers.onContentBlockDelta(parsed.index, parsed.delta)
              break
            case 'content_block_stop':
              handlers.onContentBlockStop(parsed.index)
              break
            case 'message_delta':
              outputTokens = parsed.usage?.output_tokens || 0
              console.log('[SSE] message_delta usage:', JSON.stringify(parsed.usage))
              handlers.onStreamComplete(parsed.delta?.stop_reason || null, {
                inputTokens,
                outputTokens,
                promptCacheHitTokens: cacheReadTokens
              })
              break
            case 'message_stop':
              break
            case 'ping':
              break
            case 'error':
              // Report any accumulated token usage before erroring
              handlers.onStreamComplete(null, { inputTokens, outputTokens })
              handlers.onError(parsed.error?.message || 'API error')
              break
          }
        } catch {
          // skip malformed JSON
        }
      }
      currentEvent = ''
      currentData = ''
    }
  }

  return createStreamParser(processLine)
}

// ── Tool Result Reconciliation ────────────────────────────────────────

/** The fabricated tool_result for one unanswered tool_use — status-aware
 *  (llm/tool-reconcile.ts) and marked `_synthetic` so addToolResult replaces
 *  it with the real result instead of swallowing it as a duplicate. */
function fabricatedResultBlock(tu: ToolUseBlock): ToolResultBlock {
  const placeholder = reconcilePlaceholderFor(tu)
  return {
    type: 'tool_result',
    tool_use_id: tu.id,
    content: placeholder.content,
    is_error: placeholder.isError,
    tool_result_id: crypto.randomUUID(),
    _synthetic: true
  }
}

function reconcileToolResults(messages: AgentMessage[]): void {
  for (let i = 0; i < messages.length - 1; i++) {
    const cur = messages[i]
    if (cur.role !== 'assistant') continue
    const toolUses = cur.contentBlocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    )
    if (toolUses.length === 0) continue

    const resolvedIds = new Set<string>()
    // Scan ALL later messages, not just the contiguous user run: chained plan
    // dispatch (2026-09-30) lands an assistant message between a live batch
    // and its still-arriving results, and a call answered AFTER that
    // interleaved assistant is answered all the same. Breaking at the first
    // non-user message once fabricated "interrupted" results for spawns that
    // were merely still running — whose real outputs the duplicate guard in
    // addToolResult then swallowed.
    for (let j = i + 1; j < messages.length; j++) {
      for (const block of messages[j].contentBlocks) {
        if (block.type === 'tool_result') {
          resolvedIds.add(block.tool_use_id)
        }
      }
    }

    const unresolvedToolUses = toolUses.filter(tu => !resolvedIds.has(tu.id))
    if (unresolvedToolUses.length === 0) continue

    const next = messages[i + 1]
    const hasExistingContent = next?.role === 'user' && next.contentBlocks.some(b => b.type !== 'tool_result')
    const targetIndex = i + 1

    if (hasExistingContent) {
      messages.splice(targetIndex, 0, {
        id: `msg_reconcile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'user',
        contentBlocks: unresolvedToolUses.map(fabricatedResultBlock),
        createdAt: new Date().toISOString()
      })
    } else {
      if (!next || next.role !== 'user') {
        messages.splice(targetIndex, 0, {
          id: `msg_reconcile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          role: 'user',
          contentBlocks: [],
          createdAt: new Date().toISOString()
        })
      }
      for (const tu of unresolvedToolUses) {
        messages[targetIndex].contentBlocks.push(fabricatedResultBlock(tu))
      }
    }
  }

  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') {
    last.contentBlocks = last.contentBlocks.filter(
      (b) => b.type !== 'tool_use'
    )
  }
}

// ── Prompt-caching breakpoints ─────────────────────────────────────────
/**
 * Anthropic's Messages API does no implicit prompt caching: a request carrying
 * no `cache_control` marker re-bills its ENTIRE prefix at the full input rate.
 * We already read `cache_read_input_tokens` back into usage
 * (promptCacheHitTokens), but never SET a marker — so the hit rate we recorded
 * was whatever an upstream gateway happened to arrange for us.
 *
 * Three of the four breakpoints the API allows, each covering a region that is
 * genuinely stable across a tool loop:
 *   1. the last tool definition — the schema list is fixed for the session;
 *   2. the last system block — system prompt + appendices, stable per turn;
 *   3. the last markable content block of the final message — the SLIDING tail.
 *      Prefix caching is cumulative, so marker 3 alone lets the next request
 *      read back everything above it, including tool traffic that just landed.
 *      "Markable": the API rejects cache_control on thinking blocks, so the
 *      marker lands on the newest text/tool_use/tool_result block instead.
 *
 * Only the current turn's own tail below marker 3 is re-billed — the protocol's
 * minimum. The other half of the bargain is the compactor's: history bytes must
 * not churn between requests (see LIGHT_RECLAIM_MARGIN_RATIO in
 * context-compactor).
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const

/** The API rejects a `cache_control` marker on a thinking block ("Thinking
 *  blocks cannot be cached directly with cache_control"), so the tail marker
 *  walks back to the newest MARKABLE block instead of blindly marking the
 *  last one — requests that end on an assistant thinking block (max_tokens
 *  continuations) would otherwise hard-400 on the real endpoint. */
const UNMARKABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/** Attach the marker to a message's last markable block. Bare-string content
 *  has no block to mark, so it is promoted to the single-text-block form the
 *  API also accepts; an empty array is left alone (marking it would be
 *  meaningless, and the API rejects an empty content array anyway). */
function markLastContentBlock(content: unknown): unknown {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: CACHE_CONTROL }]
  }
  if (!Array.isArray(content) || content.length === 0) return content
  const out = content.slice()
  let i = out.length - 1
  while (i >= 0 && UNMARKABLE_BLOCK_TYPES.has((out[i] as { type?: string })?.type ?? '')) i--
  if (i < 0) return content // every block is thinking — nothing markable
  out[i] = { ...(out[i] as Record<string, unknown>), cache_control: CACHE_CONTROL }
  return out
}

/** Add the three breakpoints to an already-built request body, in place. Every
 *  touched container is shallow-copied FIRST: `apiMessages` shares its block
 *  objects with the copy the compactor handed us, and a marker must never leak
 *  back into engine state (it would then ride the persisted history). */
function applyCacheBreakpoints(body: Record<string, unknown>): void {
  // 1. system — the API accepts either a string or a block array, but only the
  // array form can carry a marker.
  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [{ type: 'text', text: body.system, cache_control: CACHE_CONTROL }]
  }

  // 2. tools — one marker on the last definition caches the whole prefix ending
  // there, i.e. every schema.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools.slice()
    tools[tools.length - 1] = { ...(tools[tools.length - 1] as Record<string, unknown>), cache_control: CACHE_CONTROL }
    body.tools = tools
  }

  // 3. messages — the sliding tail marker.
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const messages = body.messages.slice()
    const last = messages[messages.length - 1] as Record<string, unknown>
    const marked = markLastContentBlock(last.content)
    if (marked !== last.content) {
      messages[messages.length - 1] = { ...last, content: marked }
      body.messages = messages
    }
  }
}

// ── Adapter ────────────────────────────────────────────────────────────

export const anthropicAdapter: LlmAdapter = {
  provider: 'anthropic',

  buildRequest(baseURL: string, apiKey: string, params: LlmRequestParams) {
    // Defensive reconciliation: ensure every tool_use has a paired tool_result
    // before serializing. Catches orphaned tool_use blocks from interrupted
    // tool executions that slip past the startLoop/continueLoop checks.
    reconcileToolResults(params.messages)

    const { model, maxTokens, messages, tools, systemPrompt, stream } = params

    const apiUrl = `${baseURL.replace(/\/+$/, '')}/v1/messages`

    const { apiMessages, systemField } = this.buildMessages(messages, systemPrompt)

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream,
      system: systemField,
      tools: this.buildTools(tools),
      messages: apiMessages
    }
    // Explicit cache breakpoints — see applyCacheBreakpoints. An
    // Anthropic-compatible gateway that rejects unknown fields can opt out
    // through `promptCache: false`; nothing else changes.
    if (params.promptCache !== false) applyCacheBreakpoints(body)

    return {
      url: apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04'
      },
      body
    }
  },

  createStreamParser(handlers: StreamEventHandlers): StreamParser {
    return createSseDispatcher(handlers)
  },

  buildMessages(messages: AgentMessage[], systemPrompt: string) {
    // Last-line defense: reconcile any orphaned tool_use blocks that weren't
    // caught by earlier reconciliation passes. Mutates messages in place.
    reconcileToolResults(messages)

    // Debug: verify no orphaned tool_use blocks remain after reconciliation
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'assistant') continue
      const toolUses = messages[i].contentBlocks.filter(b => b.type === 'tool_use')
      if (toolUses.length === 0) continue
      // Check if next messages have tool_results for these
      const resolvedIds = new Set<string>()
      for (let j = i + 1; j < messages.length; j++) {
        // WIDE scan (same semantics as reconcileToolResults): a result landing
        // after an interleaved assistant message still resolves its call —
        // the narrow `break` here kept logging false "ORPHANED" alarms for
        // exactly the chained-spawn shape reconcile had already fixed
        // (full_20261011 M7-P1-1).
        if (messages[j].role !== 'user') continue
        for (const b of messages[j].contentBlocks) {
          if (b.type === 'tool_result') resolvedIds.add(b.tool_use_id)
        }
      }
      const unresolved = toolUses.filter(tu => !resolvedIds.has(tu.id))
      if (unresolved.length > 0) {
        console.error(`[AnthropicAdapter] ORPHANED tool_use blocks AFTER reconciliation:`, unresolved.map(tu => tu.id))
      }
    }

    const result: Array<Record<string, unknown>> = []
    // Runtime status per tool_use id — the mapped wire shape drops it, and the
    // safety net below needs it to tell a live call from a dead one.
    const statusById = new Map<string, ToolUseBlock['status']>()
    for (const msg of messages) {
      const blocks = msg.contentBlocks
      if (!blocks || blocks.length === 0) continue
      for (const b of blocks) {
        if (b.type === 'tool_use') statusById.set(b.id, (b as ToolUseBlock).status)
      }
      if (blocks.length === 1 && blocks[0].type === 'tool_result' && !blocks[0].content) continue
      const content = contentBlocksToApi(blocks)
      // Skip messages where all blocks were filtered out (e.g. only thinking blocks)
      if (Array.isArray(content) && content.length === 0) continue
      result.push({ role: msg.role, content })
    }

    // Safety net: scan the final API-format result and inject synthetic
    // tool_result for any assistant tool_use that lacks a corresponding
    // tool_result in a subsequent consecutive user message.
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]
      if (msg.role !== 'assistant') continue
      const content = msg.content
      if (!Array.isArray(content)) continue
      const toolUses = content.filter((b: Record<string, unknown>) => b.type === 'tool_use') as Array<{ id: string }>
      if (toolUses.length === 0) continue

      // Collect tool_use IDs from ALL consecutive user messages after this one
      const resolvedIds = new Set<string>()
      for (let j = i + 1; j < result.length; j++) {
        const next = result[j]
        // WIDE scan — the safety net must agree with reconcileToolResults
        // about what "unresolved" means (full_20261011 M7-P1-1): under the
        // narrow `break`, a result sitting after an interleaved assistant
        // message (chained spawns) counted as missing and this net injected a
        // SECOND tool_result for the same tool_use_id into the outgoing
        // payload — a 400-shaped duplicate, or a fake "interrupted" verdict
        // for a tool that is still running (the 2026-09-30 regression's
        // exact shape). The injection only mutates the outgoing payload, not
        // engine.messages, so addToolResult's duplicate guard cannot catch it.
        if (next.role !== 'user') continue
        const nextContent = next.content
        if (!Array.isArray(nextContent)) continue
        for (const b of nextContent) {
          if ((b as Record<string, unknown>).type === 'tool_result') {
            resolvedIds.add((b as Record<string, unknown>).tool_use_id as string)
          }
        }
      }

      const unresolved = toolUses.filter(tu => !resolvedIds.has(tu.id))
      if (unresolved.length > 0) {
      console.warn(`[AnthropicAdapter] Injecting synthetic tool_result for ${unresolved.length} orphaned tool_use(s):`, unresolved.map(tu => tu.id))
      result.splice(i + 1, 0, {
        role: 'user',
        content: unresolved.map(tu => {
          const placeholder = reconcilePlaceholderFor({ status: statusById.get(tu.id) })
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: placeholder.content,
            ...(placeholder.isError ? { is_error: true } : {})
          }
        })
      })
      }
    }

    return {
      apiMessages: result,
      systemField: systemPrompt || undefined
    }
  },

  buildTools(toolDefinitions: ToolDefinition[]) {
    return toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
    }))
  },

  reconcileMessages(messages: AgentMessage[]) {
    reconcileToolResults(messages)
  },

  async callNonStreaming(
    apiKey: string,
    baseURL: string,
    model: string,
    systemPrompt: string,
    userMessages: { role: string; content: string }[],
    maxTokens: number = 1000,
    onUsage?: (usage: LlmUsage) => void,
    onFinishReason?: (reason: string | null) => void
  ): Promise<string | null> {
    const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024-04-04'
    }
    const body: Record<string, unknown> = {
      model,
      // maxTokens IS the wire budget — callers pass the model's configured
      // output limit because thinking gateways settle reasoning_tokens
      // INSIDE it and one-shot calls do not suppress thinking (see
      // LlmConfig.modelMaxTokens).
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: userMessages
    }

    try {
      const responseText = await getHost().apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        withProfileHeaders: true
      })
      if (!responseText) return null

      const parsed = JSON.parse(responseText)
      if (onUsage) {
        // Same normalization as the SSE dispatcher (message_start): inputTokens
        // is the FULL billed prompt — raw input_tokens excludes cache
        // creation/read, and cache-hit-rate.ts's denominator premise relies on
        // every adapter reporting the sum.
        const u = parsed?.usage ?? {}
        onUsage({
          inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) || undefined,
          outputTokens: u.output_tokens,
          promptCacheHitTokens: u.cache_read_input_tokens ?? undefined
        })
      }
      if (onFinishReason) onFinishReason(parsed?.stop_reason ?? null)
      const textBlock = parsed?.content?.find((b: { type: string }) => b.type === 'text')
      return textBlock?.text || null
    } catch (err) {
      console.log(`[AnthropicAdapter] callNonStreaming failed:`, err)
      return null
    }
  },

  extractTextContent(response: string | null): string | null {
    if (!response) return null
    try {
      const data = JSON.parse(response)
      // Use the first text block (skip thinking blocks that have no `text` field)
      const textBlock = data?.content?.find((b: { type: string }) => b.type === 'text')
      return textBlock?.text || null
    } catch {
      return response
    }
  }
}
