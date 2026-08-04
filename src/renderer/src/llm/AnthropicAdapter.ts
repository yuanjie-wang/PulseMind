import type { AgentMessage, ToolUseBlock, ContentBlock } from '../types/agent'
import type { ToolDefinition } from '../tools/types'
import type { LlmAdapter } from './adapter'
import type { LlmRequestParams } from './types'
import type { StreamEventHandlers, StreamParser } from './stream-types'
import { createStreamParser } from './stream-utils'

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

function reconcileToolResults(messages: AgentMessage[]): void {
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
        contentBlocks: unresolvedToolUses.map(tu => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: 'Tool execution was interrupted or cancelled.',
          is_error: true
        })),
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
        messages[targetIndex].contentBlocks.push({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: 'Tool execution was interrupted or cancelled.',
          is_error: true
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
        if (messages[j].role !== 'user') break
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
    for (const msg of messages) {
      const blocks = msg.contentBlocks
      if (!blocks || blocks.length === 0) continue
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
        if (next.role !== 'user') break
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
          content: unresolved.map(tu => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Tool execution was interrupted or cancelled.',
            is_error: true
          }))
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
    maxTokens: number = 1000
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
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: userMessages
    }

    try {
      const responseText = await window.electronAPI.apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      })
      if (!responseText) return null

      const parsed = JSON.parse(responseText)
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
