/**
 * Result-ingestion helpers (PLAN-0.3.5 refactor, split 2/5): truncated-result
 * reporting, XML tool-call recovery and tool parameter validation. Pure
 * transforms over the engine's message list / options — no engine state.
 */
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../../types/agent'
import { generateMsgId } from '../agent-utils'
import { TOOL_PARAM_LIMITS, MAX_TOOL_INPUT_JSON_BYTES } from './engine-constants'
import { estimateTextTokens } from './context-estimate'
import type { AgentEngineOptions } from '../AgentEngine'


  /** The tool-result guardrail's context shape (MAX_TOOL_RESULT_TOKENS /
   *  MAX_READ_RESULT_TOKENS): errors pass whole; anything else over the token
   *  budget is head+tail truncated (75%/25%) with a marker pointing at the
   *  offload file — the CALLER writes the original to that file when
   *  `truncated` is true. Pure so the budget is testable without an engine.
   *  The length short-circuit skips estimation when even worst-case (all CJK)
   *  fits the budget. */
  export function applyToolResultBudget(
    content: string, isError: boolean, budget: number, offloadDest: string
  ): { text: string; truncated: boolean } {
    if (isError || content.length <= budget) return { text: content, truncated: false }
    const estTokens = estimateTextTokens(content)
    if (estTokens <= budget) return { text: content, truncated: false }
    const perChar = estTokens / content.length
    const head = Math.floor((budget * 0.75) / perChar)
    const tail = Math.floor((budget * 0.25) / perChar)
    const hidden = content.length - head - tail
    const text = `${content.slice(0, head)}\n\n… [Tool result truncated: ~${estTokens.toLocaleString()} tokens, ${hidden.toLocaleString()} chars omitted — full text saved at ${offloadDest}, use \`read\` to page through it] …\n\n${content.slice(-tail)}`
    return { text, truncated: true }
  }


  /** Returns the message list WITH the synthetic user message appended — the
   *  caller must assign it back (`engine.messages = addTruncatedResults(...)`).
   *  The pre-fix signature returned void and rebuilt a dead local array, so the
   *  assistant tool_use rode to the gateway with no paired tool_result
   *  (review_20261005 P1-01: adapter reconcile skips the LAST message, exactly
   *  where that orphan sits, so nothing repaired it). Also marks every truncated
   *  call completed in place — that mutation is on the caller's block objects. */
  export function addTruncatedResults(messages: AgentMessage[], tools: ToolUseBlock[]): AgentMessage[] {
    const combinedBlocks: ContentBlock[] = tools.map(tool => {
      tool.status = 'completed'
      const wasTruncated = (tool as any)._jsonTruncated === true
      let msg: string
      if (wasTruncated) {
        if (tool.name === 'write') {
          const partialPath = (tool as any)._partialFilePath
          msg = partialPath ? `Write to "${partialPath}" was truncated (max_tokens hit while generating content). The file was NOT written. Retry with a smaller payload or split the content across multiple write calls.` : 'Tool call input was truncated (max_tokens limit hit while generating parameters). Retry with a smaller payload or split across multiple calls.'
        } else { msg = 'Tool call input was truncated (max_tokens limit hit while generating parameters). Retry with a smaller payload or split across multiple calls.' }
      } else { msg = 'Tool call was interrupted by the token limit. Please continue.' }
      // tool_result_id must be assigned here: without it, sanitizeToolResults
      // generates a fresh UUID on every save (it only mutates the IPC copy, not
      // the live renderer block), producing duplicate tool_results rows.
      return { type: 'tool_result' as const, tool_use_id: tool.id, content: msg, is_error: true, tool_result_id: crypto.randomUUID() }
    })
    return [...messages, { id: generateMsgId(), role: 'user' as const, contentBlocks: combinedBlocks, createdAt: new Date().toISOString() }]
  }

  export function extractInvokeToolCalls(opts: AgentEngineOptions, blocks: ContentBlock[]): { blocks: ContentBlock[]; converted: boolean } {
    const enabledNames = new Set(opts.toolManager.getEnabledTools().map(t => t.definition.name))
    let converted = false
    let callCounter = 0
    const result: ContentBlock[] = []

    for (const block of blocks) {
      if (block.type !== 'text') {
        result.push(block)
        continue
      }

      const calls: Array<{ name: string; input: Record<string, unknown> }> = []
      const invokeRe = /<invoke\s+name\s*=\s*["']([^"']+)["']>([\s\S]*?)(?:<\/invoke>|$)/g
      let match: RegExpExecArray | null
      let cleaned = ''
      let lastIdx = 0
      while ((match = invokeRe.exec(block.text)) !== null) {
        const name = match[1].trim()
        if (!enabledNames.has(name)) continue // unknown tool — leave the XML as text
        const body = match[2]
        const input: Record<string, unknown> = {}
        const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']>([\s\S]*?)<\/parameter>/g
        let pm: RegExpExecArray | null
        while ((pm = paramRe.exec(body)) !== null) {
          // XML parameter bodies are strings by construction; restore the
          // boolean literals so strict-typed executors keep working — `write`'s
          // `append === true` silently executed an OVERWRITE when the recovery
          // handed it the STRING "true" while the model had asked to append
          // (2026-10-24 harness review). Numbers deliberately stay strings:
          // every consumer already Number()-coerces at use sites.
          const rawParam = pm[2].trim()
          input[pm[1].trim()] = rawParam === 'true' ? true : rawParam === 'false' ? false : rawParam
        }
        if (Object.keys(input).length === 0) continue
        calls.push({ name, input })
        cleaned += block.text.slice(lastIdx, match.index)
        lastIdx = invokeRe.lastIndex
      }
      if (calls.length === 0) {
        result.push(block)
        continue
      }

      converted = true
      cleaned += block.text.slice(lastIdx)
      const trimmed = cleaned.trim()
      if (trimmed) result.push({ ...block, text: trimmed })
      for (const call of calls) {
        result.push({
          type: 'tool_use',
          id: `invoke_${Date.now()}_${callCounter++}`,
          name: call.name,
          input: call.input,
          status: 'pending'
        })
      }
    }

    return { blocks: result, converted }
  }

  /** Check all tool inputs against size limits. Returns tools that exceed limits. */
  export function validateToolParams(tools: ToolUseBlock[]): ToolUseBlock[] {
    const oversized: ToolUseBlock[] = []
    for (const t of tools) {
      const limits = TOOL_PARAM_LIMITS[t.name]
      const inputJson = JSON.stringify(t.input)
      if (inputJson.length > MAX_TOOL_INPUT_JSON_BYTES) {
        oversized.push(t)
        console.warn(`[AgentEngine] Tool "${t.name}" input exceeds 1 MB safety net (${inputJson.length} bytes)`)
        continue
      }
      if (limits && t.input) {
        for (const [key, maxLen] of Object.entries(limits)) {
          const val = t.input[key]
          if (typeof val === 'string' && val.length > maxLen) {
            oversized.push(t)
            console.warn(`[AgentEngine] Tool "${t.name}" param "${key}" too large: ${val.length} chars (max ${maxLen})`)
            break // only report once per tool
          }
        }
      }
    }
    return oversized
  }
