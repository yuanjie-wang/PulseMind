/**
 * Background memory extraction + tool-result persistence (PLAN-0.3.5 split):
 * extracted from AgentEngine. Functions take the engine back-reference.
 */
import { MEM_SALVAGE_MAX_PER_SESSION, MEM_SALVAGE_CONTEXT_RATIO } from './engine-constants'
import { MEMORY_ENTRY_MAX_CHARS } from '../../../../shared/memory/limits'
import type { EngineCore } from './engine-core'
import { enforceMaxOutputTokens, withNoThinkingDirective } from '../one-shot-agent/OneShotAgent'
import { getHost } from '../host'
import type { AgentMessage, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/agent'

export async function extractMemoriesFromOldToolPairs(engine: EngineCore): Promise<void> {
    // Find compressible assistant+user pairs (same logic as old autoCompact)
    const compressible: Array<{ assistant: AgentMessage; user: AgentMessage }> = []

    for (let i = 0; i < engine.messages.length - 1; i++) {
      if (compressible.length >= 3) break

      const current = engine.messages[i]
      const next = engine.messages[i + 1]

      if (current.role !== 'assistant' || next.role !== 'user') continue
      if (current.autoSummary || next.autoSummary) continue
      // P0 (PLAN-memory-extraction-dedup): a pair already mined keeps its mark
      // forever — without it every salvage pass re-ran the SAME oldest pairs
      // (nothing else moved the window). Deliberately NOT `autoSummary`: that
      // field is the compaction-eligibility contract and must stay separate.
      if ((current as AgentMessage).memExtracted || (next as AgentMessage).memExtracted) continue
      if (i >= engine.messages.length - 4) continue

      const hasToolUses = current.contentBlocks.some(b => b.type === 'tool_use')
      const hasToolResults = next.contentBlocks.some(b => b.type === 'tool_result')
      if (!hasToolUses || !hasToolResults) continue
      if (next.contentBlocks.some(b => b.type === 'text')) continue

      compressible.push({ assistant: current, user: next })
    }

    if (compressible.length === 0) return

    // Build a summary of tool pairs for extraction
    const pairTexts: string[] = []
    for (const pair of compressible) {
      const textBlocks = pair.assistant.contentBlocks
        .filter(b => b.type === 'text')
        .map(b => (b as TextBlock).text)
      const toolNames = pair.assistant.contentBlocks
        .filter(b => b.type === 'tool_use')
        .map(b => (b as ToolUseBlock).name)
      const line = textBlocks.length > 0
        ? `AI: ${textBlocks.join('\n').slice(0, 1000)} [Tools: ${toolNames.join(', ')}]`
        : `[Tools: ${toolNames.join(', ')}]`
      pairTexts.push(line)
    }

    const summary = pairTexts.join('\n---\n').slice(0, 3000)

    // Orientation (user ruling 2026-10-10: 记忆侧重用户的决策/偏好，不归纳模型
    // 产出): this path's input has NO user text — only assistant reasoning +
    // tool names — so decisions/preferences cannot legitimately come from here,
    // and the old prompt ("extract … decisions, file paths, or user
    // preferences") structurally produced task-output summaries. What this
    // transcript CAN durably reveal is the environment: tool/API quirks,
    // machine constraints, failure modes. Save only those.
    const prompt = 'You are a memory extraction system. The transcript below shows ONLY the assistant\'s reasoning and tool execution — the user\'s words are NOT in it. Extract ONLY durable ENVIRONMENT and TOOL facts worth reusing in future sessions: machine or tool constraints (missing flags, hard limits), API quirks and failure modes, capability boundaries, install/version pitfalls. Do NOT summarize what the task was about or what the assistant concluded — work-product narration is not a memory. The user is invisible here: do NOT invent decisions or user preferences. File paths are session-scoped — never save them. Each memory\'s "content" is ONE short sentence of at most 100 characters (短句，只留结论). Return a JSON array of memories, each with: "content" (string), "type": "fact", "category" (one of: "code", "architecture", "general"). Return [] when nothing durable appears. Return ONLY the JSON array, no other text.'

    let raw: string | null = null
    try {
      raw = await engine.opts.adapter.callNonStreaming(
        engine.opts.apiKey || '',
        engine.opts.baseURL || '',
        engine.opts.model || '',
        // Direct callNonStreaming site — the no-thinking directive that the
        // OneShotAgent funnel appends must be added by hand here.
        withNoThinkingDirective(prompt),
        [{ role: 'user' as const, content: summary }],
        // Wire budget = the model's output limit: thinking gateways settle
        // reasoning INSIDE max_tokens, so the old 500-token cap produced
        // empty extractions on every thinking model (LlmConfig.modelMaxTokens).
        engine.opts.maxTokens
      )
    } catch (err) {
      console.warn('[AgentEngine] Memory extraction LLM call failed:', err)
      return
    }

    if (!raw) return
    // The scenario's own output-length requirement (was the old wire cap —
    // thinking ate that). Over-cap JSON truncates and fails its parse into
    // `memories = []`, the honest degradation (PLAN-one-shot-reasoning-budget).
    raw = enforceMaxOutputTokens(raw, 500)

    // The call succeeded — mine these pairs once and never again, even when
    // the model comes back with an empty set (a no-op answer ends the pair's
    // candidacy; re-asking it every 30s was the reported waste).
    for (const pair of compressible) {
      ;(pair.assistant as AgentMessage).memExtracted = true
      ;(pair.user as AgentMessage).memExtracted = true
    }

    // Parse response
    let memories: Array<{ content: string; type: string; category: string }> = []
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        memories = parsed
      } else if (parsed && Array.isArray((parsed as any).memories)) {
        memories = (parsed as any).memories
      }
    } catch {
      // Try to extract JSON from the response
      const match = raw.match(/\[.*?\]/s) || raw.match(/\{[^]*"memories"[^]*\}/s)
      if (match) {
        try { memories = JSON.parse(match[0]) } catch {}
      }
    }

    // Save as pages（PLAN-memory-wiki：打捞产物也是记忆页；title 取结论头部，
    // 撞名/重样交给 compile pass 归并——打捞在上下文高压下，不做目录对齐）
    const ops = memories
      .filter((mem) => typeof mem?.content === 'string' && mem.content.length >= 10 && mem.content.length <= MEMORY_ENTRY_MAX_CHARS)
      .map((mem) => ({
        action: 'create' as const,
        title: mem.content.slice(0, 24),
        type: 'fact' as const,
        content: mem.content as string,
        links: [] as string[],
      }))
    let salvaged = 0
    if (ops.length > 0) {
      try {
        const results = await getHost().applyMemoryPageOps(ops)
        salvaged = results.filter((r) => r.ok).length
        for (const r of results.filter((x) => !x.ok)) {
          console.warn(`[AgentEngine] salvage page op failed (${r.op.title}):`, r.error)
        }
      } catch (err) {
        console.warn('[AgentEngine] Failed to save salvaged memory pages:', err)
      }
    }

    if (salvaged > 0) {
      console.log(`[AgentEngine] Memory extraction: salvaged ${salvaged} page(s) from ${compressible.length} old tool pairs`)
    }
  }

export async function persistUnsavedToolResults(engine: EngineCore): Promise<void> {
    const entries: Array<{
      ref_id: string; message_id: string; block_index: number;
      tool_use_id: string; content: string; is_error: number
    }> = []
    // Incremental by the engine's persisted-id set: the old shape re-bound the
    // WHOLE history's result bodies on every request build only for the DB to
    // discard them via INSERT OR IGNORE — O(accumulated bytes) per request on
    // a marathon tool session (better-sqlite3 copies every bound content
    // buffer before the conflict check). ref ids are UUIDs minted once per
    // block, so a remembered id is permanently done.
    const seen = engine.persistedToolResultIds
    for (const msg of engine.messages) {
      if (msg.role !== 'user') continue
      for (let bi = 0; bi < msg.contentBlocks.length; bi++) {
        const block = msg.contentBlocks[bi]
        if (block.type !== 'tool_result') continue
        const tr = block as ToolResultBlock
        if (tr.tool_result_id && tr.content && !seen.has(tr.tool_result_id) && !tr.content.startsWith('[tool_result_id:') && !tr.content.startsWith('[Tool Result:')) {
          entries.push({
            ref_id: tr.tool_result_id,
            message_id: msg.id,
            block_index: bi,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error ? 1 : 0
          })
        }
      }
    }
    if (entries.length === 0) return
    try {
      await getHost().persistToolResults(engine.opts.conversationId!, entries)
      for (const e of entries) seen.add(e.ref_id)
    } catch (err) {
      console.warn('[AgentEngine] persistUnsavedToolResults failed:', err)
    }
  }

/** Turn-end memory salvage (PLAN-memory-extraction-dedup P0): the ONLY
 *  remaining in-session memory LLM path. In-loop extraction was deleted, so
 *  old tool pairs that a mid-turn compaction is about to EAT are salvaged
 *  here — once per turn end, capped per session, and only under context
 *  pressure (the pairs are at risk exactly then; below the line the ordinary
 *  turn-end extractAndSaveAll still sees them as text). Fire-and-forget.
 *  The per-pair `memExtracted` marks keep repeated turns from re-mining. */
export function runTurnEndMemoryExtraction(engine: EngineCore): void {
    if (engine._memExtractionInProgress) return
    if (engine.spawnSystemPrompt) return
    if (!engine.opts.conversationId) return
    // Feature master switch (设置 → 记忆): the shared manager's prefs mirror it.
    if (engine.opts.memoryManager && !engine.opts.memoryManager.getPreferences().autoCaptureEnabled) return
    if (engine._memSalvageCount >= MEM_SALVAGE_MAX_PER_SESSION) return

    const estimatedTokens = engine.compactor.contextTokens()
    if (estimatedTokens < (engine.opts.contextLength || 128000) * MEM_SALVAGE_CONTEXT_RATIO) return

    engine._memSalvageCount++
    engine._memExtractionInProgress = true

    void Promise.resolve().then(async () => {
      try {
        await extractMemoriesFromOldToolPairs(engine)
      } catch (err) {
        console.warn('[AgentEngine] Turn-end memory salvage failed:', err)
      } finally {
        engine._memExtractionInProgress = false
      }
    })
  }
