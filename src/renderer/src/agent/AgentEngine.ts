import type {
  AgentMessage,
  AgentStatus,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  Plan
} from '../types/agent'
import type { ToolManager } from '../tools/ToolManager'
import type { ToolInputSchema } from '../tools/types'
import { BUILTIN_CATEGORY_SUMMARIES, builtinCategoryServerId } from '../tools/builtin-gate'
import type { SkillManager } from '../skills/SkillManager'
import type { HooksConfig } from '../types/hooks'
import type { MemoryManager } from '../memory/MemoryManager'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'
import type { PlatformInfo } from '../types/electron'
import type { LlmAdapter } from '../llm/adapter'
import { SkillKeywordAgent, SkillSelectionAgent } from './one-shot-agent'
import { sanitizeSchema, safeInvoke, safeInvokeObserver, MAX_LOOP_ITERATIONS, generateMsgId, type SubAgentResult, type SpawnSubAgentConfig, type SubAgentHandle } from './agent-utils'
import { buildCommandFromSkillInput } from './command-builder'
import { buildSystemPrompt } from './system-prompt-builder'
import { PlanManager } from './plan-manager'
import { ensureCache, getCachedMcpServers, getCachedSubAgentProfiles, refreshMcpServers } from './mcp-cache'
import { ToolExecutor, UI_PREVIEW_MAX } from './tool-executors'
import { agentMessagesToConversation } from '../utils/message-utils'
import { stripImageData } from './image-utils'

// ── Tool-result guardrail ─────────────────────────────────────────────
// Every tool result funnels through addToolResult; executors do NOT truncate
// on their own. This single cap is the one backstop: results over the token
// budget are head+tail truncated for context, and the full text is offloaded
// to ~/.pulsemind/tmp/trunc/ so the model can `read` it back. The budget is in
// estimated tokens because the context window is counted in tokens — a fixed
// char cap would be far too generous for CJK-heavy output (30K chars ≈ 7.5K
// tokens in English but ≈ 30K tokens in Chinese). The DB persists whatever
// lives in this.messages, so this also keeps oversized results out of the
// tool_results table. The read tool is exempt (passes Infinity as maxTokens):
// reading a file IS the task, so read results always land in full.
const MAX_TOOL_RESULT_TOKENS = 4_000

/** Rough token estimate: CJK chars ≈ 1 token, everything else ≈ 1 token per 4 chars. */
function estimateTokens(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

// ── AgentEngine Options ───────────────────────────────────────────────

export interface AgentEngineOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  myName: string
  soul: string
  yourName: string
  adapter: LlmAdapter
  toolManager: ToolManager
  skillManager: SkillManager
  workspaceDir?: string
  skillsDir?: string
  platformInfo?: PlatformInfo
  memoryManager?: MemoryManager
  knowledgeManager?: KnowledgeManager
  hooks?: HooksConfig
  onSkillStateChange?: () => void
  yoloMode?: boolean
  locale?: 'zh' | 'en'
  conversationId?: string

  // Spawn sub-agent options
  allowedTools?: string[]
  allowedMcpServers?: string[]
  systemPromptAppendix?: string
}

// ── AgentEngine Callbacks ───────────────────────────────────────────

export interface AgentEngineCallbacks {
  onMessagesChanged?: (messages: AgentMessage[]) => void
  onStatusChanged?: (status: AgentStatus) => void
  onStreamingBlocksChanged?: (blocks: ContentBlock[]) => void
  onPlanChanged?: (plan: Plan | null) => void
}

// ── AgentEngine ───────────────────────────────────────────────────────

export class AgentEngine {
  // ── Observable state (read by React wrapper) ────────────────────
  messages: AgentMessage[] = []
  agentStatus: AgentStatus = { status: 'idle' }
  streamingBlocks: ContentBlock[] = []

  // ── Internal state (was useRef) ─────────────────────────────────
  private opts: AgentEngineOptions
  private callbacks!: AgentEngineCallbacks
  private notify = (): void => {
    this.callbacks.onMessagesChanged?.(this.messages)
    this.callbacks.onStatusChanged?.(this.agentStatus)
    this.callbacks.onStreamingBlocksChanged?.(this.streamingBlocks)
  }

  private abortController: AbortController | null = null
  private currentAssistantBlocks: (ContentBlock | undefined)[] = []
  private toolUseBlocks: ToolUseBlock[] = []
  private jsonAccumulators: Map<number, string> = new Map()
  private loopCount = 0
  private maxLoopCount = MAX_LOOP_ITERATIONS
  private terminalCleanups: (() => void)[] = []
  private executingProcessId: string | null = null
  private isCancelled = false
  private requestStartTime = 0
  private sessionStartTime = 0
  /** Consecutive idle-timeout retries for the current stream. Reset on success. */
  private streamIdleRetries = 0
  private pendingToolIds = new Set<string>()
  private isAutoExecuting = false
  private currentRequestId: string | null = null
  private skillAppendix: string | null = null
  private systemPromptCache = new Map<string, { prompt: string; time: number }>()
  /** Frozen snapshot of buildMemoryContext() — preserved across system prompt
   *  rebuilds for prefix cache stability. Cleared when memory tools write. */
  private memoryContextSnapshot: string | null = null
  /** Frozen snapshot of buildWikiContext() — preserved across system prompt
   *  rebuilds for prefix cache stability. Invalidated when KnowledgeManager.wikiVersion changes. */
  private wikiContextSnapshot: string | null = null
  private wikiContextVersion = -1
  /** Maps MCP tool name → MCP server ID for routing */
  private mcpToolOwner = new Map<string, string>()
  /** MCP tool names selected via pick_tool — empty = none selected */
  public selectedMcpTools: string[] = []
  /** Gated built-in tool names activated via pick_tool or keyword trigger — empty = all hidden */
  public selectedBuiltinTools: string[] = []
  // Sub-agents for background LLM tasks (stateless singletons)
  private skillKeywordAgent = new SkillKeywordAgent()
  private skillSelectionAgent = new SkillSelectionAgent()
  // Spawn sub-agent state (set by startSpawnLoop)
  private resolveCompletion?: (result: SubAgentResult) => void
  private completionPromise?: Promise<SubAgentResult>
  private spawnSystemPrompt?: string
  private spawnSystemPromptAppendix?: string
  private onSpawnProgress?: (summary: string) => void
  private allowedToolsSet?: Set<string>
  private allowedMcpServersSet?: Set<string>
  /** Active spawned sub-agents, keyed by sub-agent id */
  private activeSubAgents = new Map<string, AgentEngine>()
  // Public access to plan (delegated to PlanManager)
  get plan(): Plan | null { return this.planManager.plan }
  // Managers for extracted concerns
  private planManager: PlanManager
  private toolExecutor: ToolExecutor

  constructor(opts: AgentEngineOptions, callbacks?: AgentEngineCallbacks) {
    this.opts = opts
    this.callbacks = callbacks || {}
    if (opts.allowedTools) this.allowedToolsSet = new Set(opts.allowedTools)
    if (opts.systemPromptAppendix) this.spawnSystemPromptAppendix = opts.systemPromptAppendix
    if (opts.allowedMcpServers) this.allowedMcpServersSet = new Set(opts.allowedMcpServers)

    // Initialise the shared cache (safe to call multiple times — no-op after first).
    // Fires initial IPC calls in the background and subscribes to
    // onMcpServersChanged / onSkillsChanged for reactive updates,
    // so collectEnabledTools and system-prompt-builder never need IPC.
    ensureCache().catch(() => {})

    this.planManager = new PlanManager(
      (id, content, isError) => this.addToolResult(id, content, isError),
      () => this.notify(),
      () => this.messages,
      (plan) => {
        this.savePlan(plan)
        this.callbacks.onPlanChanged?.(plan)
      },
    )

    this.toolExecutor = new ToolExecutor(
      opts,
      this.mcpToolOwner,
      this.skillKeywordAgent,
      this.skillSelectionAgent,
      (id, content, isError, imageData) => this.addToolResult(id, content, isError, imageData),
      () => this.notify(),
      (pid) => { this.executingProcessId = pid },
      () => {
        this.memoryContextSnapshot = null
        if (this.opts.conversationId) this.systemPromptCache.delete(this.opts.conversationId)
      },
      (config) => this.spawnSubAgent(config),
    )
  }

  /** Persist plan changes to DB whenever PlanManager mutates the plan. */
  private savePlan = async (plan: Plan | null): Promise<void> => {
    if (!this.opts.conversationId) return
    try {
      await window.electronAPI.saveConversationPlan(this.opts.conversationId, plan ? JSON.stringify(plan) : null)
    } catch (err) {
      console.warn('[AgentEngine] Failed to save plan:', err)
    }
  }

  /** Load a persisted plan from DB for an existing conversation. */
  async loadPlan(conversationId: string): Promise<void> {
    try {
      const json = await window.electronAPI.getConversationPlan(conversationId)
      if (json) {
        this.planManager.plan = JSON.parse(json) as Plan
        this.callbacks.onPlanChanged?.(this.plan)
      }
    } catch (err) {
      console.warn('[AgentEngine] Failed to load plan:', err)
    }
  }

  /** Update options (called from React when deps change) */
  updateOptions(opts: AgentEngineOptions): void {
    const oldModel = this.opts.model
    const newModel = opts.model
    console.log(`[AgentEngine] updateOptions: ${oldModel} -> ${newModel}`, {
      apiKey: opts.apiKey ? `${opts.apiKey.slice(0, 8)}...` : null,
      baseURL: opts.baseURL,
      model: opts.model,
      provider: opts.adapter.constructor.name
    })
    this.opts = opts
    this.toolExecutor.updateOptions(opts)
  }

  /** Dispose — cleanup all listeners and sub-agents */
  dispose(): void {
    this.isCancelled = true
    this.abortController?.abort()
    this.cleanupTerminalListeners()
    if (this.currentRequestId) {
      window.electronAPI.apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    for (const subEngine of this.activeSubAgents.values()) {
      subEngine.cancelLoop()
    }
    this.activeSubAgents.clear()
    this.planManager.plan = null
  }

  // ── Core methods ──────────────────────────────────────────────────

  startLoop = async (userMessage: string): Promise<void> => {
    if (!userMessage.trim()) return
    const opts = this.opts
    if (!opts.apiKey) {
      console.warn('[AgentEngine] startLoop blocked: no API key')
      this.agentStatus = { status: 'error', error: 'API key not configured' }
      this.notify()
      return
    }

    const beforeSessionCtx = await safeInvoke(opts.hooks?.beforeSession, { userMessage, messages: this.messages }, 'beforeSession')
    userMessage = beforeSessionCtx.userMessage
    if (!userMessage.trim()) return

    console.log(`[AgentEngine] startLoop: model=${opts.model}`)

    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.isCancelled = false
    this.pendingToolIds = new Set()
    // Cancel any in-flight request so two don't write to this.messages concurrently
    this.abortController?.abort()
    if (this.currentRequestId) {
      window.electronAPI.apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    this.cleanupTerminalListeners()

    const userMsg: AgentMessage = {
      id: generateMsgId(),
      role: 'user',
      contentBlocks: [{ type: 'text', text: userMessage }],
      createdAt: new Date().toISOString()
    }
    this.messages = [...this.messages, userMsg]
    this.agentStatus = { status: 'streaming' }
    this.notify()

    this.sessionStartTime = performance.now()
    opts.adapter.reconcileMessages?.(this.messages)

    await this.continueLoop()
  }

  private continueLoop = async (): Promise<void> => {
    const opts = this.opts
    if (!opts.apiKey) {
      this.agentStatus = { status: 'error', error: 'API key not configured' }
      this.notify()
      return
    }

    this.loopCount += 1
    if (this.loopCount > this.maxLoopCount) {
      if (this.spawnSystemPrompt) {
        this.maxLoopCount += MAX_LOOP_ITERATIONS
        this.loopCount = 0
        this.notify()
        setTimeout(() => this.continueLoop(), 0)
        return
      }
      this.agentStatus = { status: 'awaiting_extension', currentCount: this.loopCount - 1, limit: this.maxLoopCount }
      this.notify()
      return
    }

    this.requestStartTime = performance.now()
    const toolManager = opts.toolManager

    // ── Build system prompt ───────────────────────────────────────
    const spResult = await buildSystemPrompt({
      opts,
      spawnSystemPrompt: this.spawnSystemPrompt,
      spawnSystemPromptAppendix: this.spawnSystemPromptAppendix,
      messages: this.messages,
      memoryContextSnapshot: this.memoryContextSnapshot,
      wikiContextSnapshot: this.wikiContextSnapshot,
      wikiContextVersion: this.wikiContextVersion,
      systemPromptCache: this.systemPromptCache,
      conversationId: opts.conversationId,
      skillAppendix: this.skillAppendix,
      plan: this.planManager.plan,
    })
    this.memoryContextSnapshot = spResult.memoryContextSnapshot
    this.wikiContextSnapshot = spResult.wikiContextSnapshot
    this.wikiContextVersion = spResult.wikiContextVersion
    this.skillAppendix = spResult.skillAppendix
    const systemPrompt = spResult.systemPrompt

    // ── Tools ──────────────────────────────────────────────────────
    const enabledTools = await this.collectEnabledTools(toolManager)

    // ── Persist tool_results for tool_result_search ──────────────
    if (this.opts.conversationId) {
      await this.persistUnsavedToolResults()
    }

    // ── Background memory extraction (fire-and-forget, doesn't block request) ──
    this.scheduleMemoryExtraction()

    // Strip image data from tool_results before sending to LLM (keep originals for UI)
    const stripToolResultImages = (msg: AgentMessage): AgentMessage => {
      if (msg.role !== 'user') return msg
      const blocks = msg.contentBlocks
      if (!blocks || !blocks.some(b => b.type === 'tool_result')) return msg
      const newBlocks = blocks.map(b => {
        if (b.type !== 'tool_result') return b
        const tb = b as ToolResultBlock
        let content = tb.content || ''
        try {
          const parsed = JSON.parse(content)
          content = JSON.stringify(stripImageData(parsed))
        } catch {
          content = stripImageData(content) as string
        }
        return { ...tb, content }
      })
      return { ...msg, contentBlocks: newBlocks }
    }

    const skillAppendix = this.skillAppendix
    // Find the last user message index so we only append skillAppendix to it
    const lastUserIdx = skillAppendix
      ? (() => { for (let i = this.messages.length - 1; i >= 0; i--) { if (this.messages[i].role === 'user') return i } return -1 })()
      : -1
    const apiMessages = skillAppendix && lastUserIdx >= 0
      ? this.messages.map((msg, idx) => {
          if (msg.role === 'user' && idx === lastUserIdx) {
            const blocks = msg.contentBlocks
            if (!blocks) return stripToolResultImages(msg)
            const newBlocks = blocks.map(b => ({ ...b } as ContentBlock))
            for (let i = newBlocks.length - 1; i >= 0; i--) {
              if (newBlocks[i].type === 'text') {
                ;(newBlocks[i] as TextBlock).text += '\n\n' + skillAppendix
                break
              }
            }
            return { ...msg, contentBlocks: newBlocks }
          }
          return stripToolResultImages(msg)
        })
      : this.messages.map(stripToolResultImages)

    // ── Compaction pipeline (operates on API copy; this.messages untouched) ──
    const nanoCompacted = this.nanoCompact(apiMessages)
    const lightCompacted = this.lightCompact(nanoCompacted, opts.contextLength || 128000)
    const truncatedMessages = this.hardTruncate(lightCompacted, opts.contextLength || 128000)

    const { url: apiUrl, headers, body } = opts.adapter.buildRequest(opts.baseURL, opts.apiKey, {
      model: opts.model,
      maxTokens: Math.floor(opts.maxTokens * 1.5),
      messages: truncatedMessages,
      tools: enabledTools,
      systemPrompt,
      stream: true
    })

    // Log request payload for debugging (full detail for spawned/canvas agents)
    if (this.spawnSystemPrompt) {
      console.log('=== [CanvasEngine] FULL SYSTEM PROMPT ===')
      console.log(systemPrompt)
      console.log('=== [CanvasEngine] API MESSAGES ===')
      console.log(JSON.stringify(apiMessages, null, 2))
      console.log('=== [CanvasEngine] TOOLS ===')
      console.log(enabledTools.map(t => t.name))
    }
    console.log('[LLM Request] model:', opts.model, 'messages:', apiMessages.length, 'tools:', enabledTools?.length ?? 0, 'sysPromptLen:', systemPrompt?.length ?? 0, 'bodyPreview:', JSON.stringify(body))

    const controller = new AbortController()
    this.abortController = controller
    this.isCancelled = false

    this.currentAssistantBlocks = []
    this.streamingBlocks = []
    this.toolUseBlocks = []
    this.jsonAccumulators = new Map()
    this.agentStatus = { status: 'streaming' }
    this.notify()

//    console.log('[AgentEngine] POST', apiUrl, { model: opts.model, max_tokens: opts.maxTokens, msgCount: this.messages.length, tools: enabledTools.map(t => t.name), provider: opts.adapter.provider })

    // beforeLlmCall hook (skip for spawned agents)
    let resolvedBody = body
    if (!this.spawnSystemPrompt) {
      const beforeLlmCallCtx = await safeInvoke(opts.hooks?.beforeLlmCall, { body, messages: this.messages }, 'beforeLlmCall')
      resolvedBody = beforeLlmCallCtx.body
    }

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
      this.currentRequestId = requestId

      const dispatcher = opts.adapter.createStreamParser({
        onContentBlockStart: (index, blockData) => {
          const { type, id, name } = blockData
          if (type === 'text') { this.currentAssistantBlocks[index] = { type: 'text', text: '' } }
          else if (type === 'thinking') { this.currentAssistantBlocks[index] = { type: 'thinking', thinking: (blockData as any).thinking || '', signature: (blockData as any).signature || undefined } }
          else if (type === 'redacted_thinking') { this.currentAssistantBlocks[index] = { type: 'redacted_thinking', data: (blockData as any).data || '' } }
          else if (type === 'tool_use') {
            this.currentAssistantBlocks[index] = { type: 'tool_use', id: id || '', name: name || '', input: {}, status: 'pending' }
            this.jsonAccumulators.set(index, '')
          }
        },
        onContentBlockDelta: (index, delta) => {
          const block = this.currentAssistantBlocks[index]
          if (!block) return
          if (delta.type === 'text_delta' && block.type === 'text') { block.text += delta.text || '' }
          else if (delta.type === 'thinking_delta' && block.type === 'thinking') { (block as any).thinking += (delta as any).thinking || '' }
          else if (delta.type === 'signature_delta' && block.type === 'thinking') { (block as any).signature = ((block as any).signature || '') + ((delta as any).signature || '') }
          else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            const acc = this.jsonAccumulators.get(index) || ''
            const newAcc = acc + (delta.partial_json || '')
            this.jsonAccumulators.set(index, newAcc)
            try { block.input = JSON.parse(newAcc) } catch { /* accumulating */ }
          }
          this.streamingBlocks = this.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
          this.notify()
        },
        onContentBlockStop: (index) => {
          const block = this.currentAssistantBlocks[index]
          if (block?.type === 'tool_use') {
            const acc = this.jsonAccumulators.get(index) || ''
            try { block.input = JSON.parse(acc) } catch {
              if (block.name === 'write') {
                const fpMatch = acc.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
                if (fpMatch) { (block as any)._partialFilePath = fpMatch[1] }
              }
              block.input = {}
              ;(block as any)._jsonTruncated = true
            }
          }
          this.streamingBlocks = this.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
          this.notify()
        },
        onStreamComplete: async (stopReason, usage) => {
          if (this.isCancelled) return

          const elapsedMs = this.requestStartTime > 0 ? Math.round(performance.now() - this.requestStartTime) : 0
          const blocks = this.currentAssistantBlocks.filter((b): b is ContentBlock => b !== undefined)
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

          this.messages = [...this.messages, assistantMsg]
          this.streamingBlocks = []
          this.notify()

          const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')

          if (stopReason === 'tool_use' && toolUses.length > 0) {
            await this.handleToolUseResponse(toolUses)
            return
          }

          if (stopReason === 'max_tokens') {
            await this.handleMaxTokensResponse(toolUses)
            return
          }

          // end_turn / stop_sequence
          this.handleEndTurnResponse(stopReason)
        },

        onError: (error) => {
          console.error('[AgentEngine] SSE error:', error)
          if (!this.isCancelled) streamError = error
        }
      })

      // Register IPC listeners
      unsubChunk = window.electronAPI.onApiStreamChunk(data => { if (data.requestId === requestId) dispatcher.processChunk(data.data) })

      unsubError = window.electronAPI.onApiStreamError(data => { if (data.requestId !== requestId) return; streamError = data.error; streamDeferredResolve() })
      unsubDone = window.electronAPI.onApiStreamDone(data => { if (data.requestId !== requestId) return; streamDone = true; dispatcher.flush(); streamDeferredResolve() })
      unsubRetry = window.electronAPI.onApiStreamRetry(data => {
        if (data.requestId !== requestId) return
        this.agentStatus = { status: 'retrying', message: data.message, attempt: data.attempt, maxRetries: data.maxRetries, delay: data.delay }
        this.notify()
      })

      cleanupListeners = () => { unsubChunk(); unsubError(); unsubDone(); unsubRetry(); if (this.currentRequestId === requestId) this.currentRequestId = null }

      // console.log(`[AgentEngine] POST body: ${(resolvedBody as any).messages?.length ?? 0} messages`)

      await window.electronAPI.apiFetchStream(requestId, apiUrl, { method: 'POST', headers, body: resolvedBody })

      // Await the stream-done IPC event. The main process always sends either
      // API_STREAM_DONE or API_STREAM_ERROR, and both resolve streamDonePromise.
      // No timeout needed — IPC event arrives in the next event loop tick.
      if (!streamDone && !streamError) {
        await streamDonePromise
      }
      if (streamError) { cleanupListeners(); throw new Error(streamError) }
      cleanupListeners()
      this.streamIdleRetries = 0 // a stream succeeded — reset consecutive-retry counter
    } catch (err) {
      cleanupListeners?.()
      const message = err instanceof Error ? err.message : 'Unknown error'
      const isCancel = this.isCancelled

      // Auto-retry on stream idle timeout (main-process aborts after 120s idle):
      // the connection stalled mid-stream (long silent thinking, network blip).
      // this.messages is untouched until onStreamComplete, so discard the partial
      // streaming state and re-issue the request from scratch.
      const isIdleTimeout = AgentEngine.STREAM_IDLE_TIMEOUT_MARKERS.some(m => message.includes(m))
      if (!isCancel && isIdleTimeout && this.streamIdleRetries < AgentEngine.MAX_STREAM_IDLE_RETRIES) {
        this.streamIdleRetries += 1
        console.warn(`[AgentEngine] Stream idle timeout (${this.streamIdleRetries}/${AgentEngine.MAX_STREAM_IDLE_RETRIES}) — retrying`)
        this.currentAssistantBlocks = []
        this.streamingBlocks = []
        this.jsonAccumulators = new Map()
        this.toolUseBlocks = []
        this.agentStatus = { status: 'retrying', message: `连接闲置超时，自动重试 (${this.streamIdleRetries}/${AgentEngine.MAX_STREAM_IDLE_RETRIES})…`, attempt: this.streamIdleRetries, maxRetries: AgentEngine.MAX_STREAM_IDLE_RETRIES, delay: 0 }
        this.notify()
        await this.continueLoop()
        return
      }
      this.streamIdleRetries = 0

      if (!isCancel) { this.agentStatus = { status: 'error', error: message }; this.notify() }
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: null, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterLlmCall')
      safeInvokeObserver(opts.hooks?.afterSession, { messages: this.messages, status: isCancel ? { status: 'completed' } : { status: 'error', error: message } }, 'afterSession')
      if (!isCancel) this.resolveCompletionIfSpawned('error')
      if (isCancel) return
      this.notify()
    }
  }

  // ── Tool building ────────────────────────────────────────────────────

  private collectEnabledTools = async (toolManager: ToolManager): Promise<any[]> => {
    // Ensure the MCP cache is populated before reading (constructor fires ensureCache
    // as fire-and-forget, so this may be the first time we await it).
    await ensureCache()

    let enabledTools = toolManager.getEnabledTools().map(t => t.definition)

    // ── Gated built-in tools: keyword auto-trigger + session activation ──
    // Category-level: any trigger hit activates the whole gated category (git/memory/knowledge),
    // so "commit my changes" surfaces status/diff/log/commit/restore together.
    {
      const userText = this.messages
        .filter(m => m.role === 'user')
        .flatMap(m => m.contentBlocks)
        .filter(b => b.type === 'text')
        .map(b => (b as TextBlock).text)
        .join('\n')
        .toLowerCase()
      const gatedByCategory = new Map<string, string[]>()
      for (const def of enabledTools) {
        if (!def.gated) continue
        const arr = gatedByCategory.get(def.category) || []
        gatedByCategory.set(def.category, [...arr, ...(def.triggers || [])])
      }
      const activated = new Set(this.selectedBuiltinTools)
      for (const [category, keywords] of gatedByCategory) {
        if (keywords.some(kw => userText.includes(kw.toLowerCase()))) {
          for (const def of enabledTools) {
            if (def.gated && def.category === category) activated.add(def.name)
          }
        }
      }
      this.selectedBuiltinTools = [...activated]
    }
    // Apply the gate: hide gated tools unless activated (spawned-agent whitelist forces them in).
    {
      const activated = new Set(this.selectedBuiltinTools)
      const allowed = this.allowedToolsSet
      enabledTools = enabledTools.filter(t => !t.gated || activated.has(t.name) || allowed?.has(t.name))
    }

    const skillManager = this.opts.skillManager
    if (skillManager) {
      const pickSkillIdx = enabledTools.findIndex(t => t.name === 'pick_skill')
      if (pickSkillIdx !== -1) {
        const eSkills = skillManager.getEnabledSkills()
        if (eSkills.length > 0) {
          const skillNames = eSkills.map(s => s.definition.name).join(', ')
          enabledTools[pickSkillIdx] = { ...enabledTools[pickSkillIdx], description: `${enabledTools[pickSkillIdx].description} Available skills: ${skillNames}.` }
        }
      }
    }

    // ── Sub-agent list (injected into spawn_agent description) ──────────
    const spawnAgentIdx = enabledTools.findIndex(t => t.name === 'spawn_agent')
    if (spawnAgentIdx !== -1) {
      try {
        const profiles = getCachedSubAgentProfiles()
        const available = profiles.filter((p: any) => p.id !== 'subagent-canvas' && !p.isCanvasAgent && (p.enabled ?? true))
        if (available.length > 0) {
          const listStr = available.map((p: any) =>
            `- **${p.name}** (ID: \`${p.id}\`)${p.basePrompt ? ': ' + p.basePrompt.slice(0, 120).replace(/\n/g, ' ') : ''}`
          ).join('\n')
          enabledTools[spawnAgentIdx] = {
            ...enabledTools[spawnAgentIdx],
            description: `${enabledTools[spawnAgentIdx].description}\n\nAvailable sub-agents:\n${listStr}`,
          }
        }
      } catch { /* non-critical */ }
    }

    // ── MCP tools (from connected MCP servers) ──────────────────────
    const doMcpDiscovery = !this.spawnSystemPrompt || !!this.allowedMcpServersSet
    if (doMcpDiscovery) {
      this.mcpToolOwner.clear()
      const mcpToolList: Array<{ name: string; serverId: string; description: string; inputSchema: any }> = []
      try {
        // Force-refresh cache so we don't miss newly-connected servers (e.g. chrome-devtools).
        // pick_tool reads fresh via IPC, but collectEnabledTools uses the cache — without this
        // refresh, tools from a recently connected server would be missing from mcpToolOwner.
        await refreshMcpServers()
        const servers = getCachedMcpServers()
        for (const server of servers) {
          if (server.status !== 'connected') continue
          if (this.allowedMcpServersSet && !this.allowedMcpServersSet.has(server.id)) continue
          for (const tool of server.tools) {
            if (!this.mcpToolOwner.has(tool.name)) {
              this.mcpToolOwner.set(tool.name, server.id)
              mcpToolList.push({ name: tool.name, serverId: server.id, description: tool.description, inputSchema: tool.inputSchema })
            } else {
              console.warn(`[AgentEngine] MCP tool name collision: "${tool.name}" from server "${server.id}" conflicts with server "${this.mcpToolOwner.get(tool.name)}" — skipping`)
            }
          }
        }

        // Enrich pick_tool description with server-level summaries (NOT individual tool descriptions)
        // Include both connected and connecting servers so the LLM knows what's available
        const pickToolIdx = enabledTools.findIndex(t => t.name === 'pick_tool')
        if (pickToolIdx !== -1) {
          // Build description from all servers that are or will be available
          const serverRows: string[] = []
          for (const server of servers) {
            if (server.status !== 'connected' && server.status !== 'connecting') continue
            if (this.allowedMcpServersSet && !this.allowedMcpServersSet.has(server.id)) continue
            const statusTag = server.status === 'connecting' ? ' [连接中]' : ''
            const summary = server.summary || `${server.name} (${server.tools.length} tools)`
            // Append tool names (truncated) so the LLM knows what tools each server exposes
            const toolNames = server.tools.map(t => t.name)
            const toolSuffix = toolNames.length > 0 ? (() => {
              const all = toolNames.join(', ')
              const truncated = all.length > 120
              return ` | tools(${toolNames.length}): ${truncated ? all.slice(0, 120) + '...' : all}`
            })() : ''
            serverRows.push(`- [${server.id}]${statusTag} ${summary}${toolSuffix}`)
          }

          // Gated built-in categories the model can still activate via pick_tool —
          // one row per category (mirrors the per-server MCP rows above).
          const activatedBuiltins = new Set(this.selectedBuiltinTools)
          const builtinByCat = new Map<string, string[]>()
          for (const d of toolManager.getEnabledTools().map(t => t.definition)) {
            if (!d.gated || activatedBuiltins.has(d.name)) continue
            const arr = builtinByCat.get(d.category) || []
            arr.push(d.name)
            builtinByCat.set(d.category, arr)
          }
          const builtinRows = [...builtinByCat.entries()]
            .map(([cat, names]) => {
              const summary = BUILTIN_CATEGORY_SUMMARIES[cat] || `${cat} (${names.length} tools)`
              return `- [${builtinCategoryServerId(cat)}] ${summary} | tools(${names.length}): ${names.join(', ')}`
            })

          // Servers and built-in categories are activation units of the same kind,
          // so they share one list (rows are formatted identically).
          const availableRows = [...serverRows, ...builtinRows]
          if (availableRows.length > 0) {
            enabledTools[pickToolIdx] = {
              ...enabledTools[pickToolIdx],
              description: `${enabledTools[pickToolIdx].description}\n\nAvailable servers & tool categories (hidden until activated — mention their topic, or use \`pick_tool\` with \`names\`/\`serverName\`/\`intent\`):\n${availableRows.join('\n')}`,
            }
          }
        }

        // Auto-inject Chrome DevTools MCP tools when user references a URL
        // (same principle as skill keyword matching — message content triggers tool availability)
        const hasUrlRef = this.messages.some(m =>
          m.role === 'user' && m.contentBlocks?.some(b => b.type === 'text' && /https?:\/\/[^\s)]+/.test((b as TextBlock).text))
        )
        const chromeTools = ['list_pages', 'select_page', 'navigate_page', 'evaluate_script', 'take_screenshot']
        const selectedSet = new Set(this.selectedMcpTools)
        if (hasUrlRef) {
          for (const name of chromeTools) selectedSet.add(name)
        }

        for (const t of mcpToolList) {
          if (selectedSet.size === 0 || !selectedSet.has(t.name)) continue
          if (!t.inputSchema) continue
          const cleanSchema = sanitizeSchema(t.inputSchema)
          enabledTools.push({
            name: t.name,
            description: t.description,
            category: 'browser',
            input_schema: cleanSchema as ToolInputSchema,
            instructions: ''
          })
        }
      } catch (err) {
        console.log('[AgentEngine] MCP tool discovery failed:', err)
      }
    }

    // ── Tool whitelist for spawned agents ───────────────────────────
    if (this.allowedToolsSet) {
      const originalCount = enabledTools.length
      for (let i = enabledTools.length - 1; i >= 0; i--) {
        if (!this.allowedToolsSet.has(enabledTools[i].name)) {
          // Don't filter MCP tools — they're already gated by allowedMcpServersSet
          if (this.mcpToolOwner.has(enabledTools[i].name)) continue
          enabledTools.splice(i, 1)
        }
      }
      console.log(`[AgentEngine] Sub-agent tool whitelist: kept ${enabledTools.length}/${originalCount} tools`)
    }

    return enabledTools
  }

  // ── Public methods ──────────────────────────────────────────────────

  approveTool = async (toolUseId: string): Promise<void> => {
    if (!this.opts.apiKey) return

    let targetBlock: ToolUseBlock | undefined
    for (const msg of this.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { targetBlock = block; break }
      }
      if (targetBlock) break
    }
    if (!targetBlock) { this.agentStatus = { status: 'error', error: 'Tool use block not found' }; this.notify(); return }

    targetBlock.status = 'running'; this.notify()
    this.agentStatus = { status: 'executing', toolUseId }; this.notify()

    const memoryTools: string[] = ['memory_search', 'memory_save', 'conversation_search', 'tool_result_search']
    if (memoryTools.includes(targetBlock.name)) {
      await this.toolExecutor.execOtherTool(targetBlock)
      return
    }
    if (targetBlock.name === 'write' || targetBlock.name === 'edit') {
      await this.toolExecutor.execWorkspaceTool(targetBlock)
      return
    }
    if (this.mcpToolOwner.has(targetBlock.name)) {
      await this.toolExecutor.execMCPTool(targetBlock)
      return
    }
    if (targetBlock.name === 'spawn_agent') {
      await this.toolExecutor.execSpawnAgent(targetBlock)
      return
    }

    // ask_user — no tool_result yet, wait for respondToTool
    if (targetBlock.name === 'ask_user') {
      targetBlock.status = 'running'; this.notify(); return
    }

    // Shell execution (default)
    const platform = this.opts.platformInfo?.platform || ''
    const command = buildCommandFromSkillInput(targetBlock.name, targetBlock.input || {}, platform, this.opts.platformInfo?.ripgrepPath)
    const cwd = String(targetBlock.input.cwd || '')

    const beforeToolCtx = await safeInvoke(this.opts.hooks?.beforeTool, { toolUseId, toolName: targetBlock.name, toolInput: targetBlock.input, command, cwd }, 'beforeTool')
    const resolvedCommand = beforeToolCtx.command; const resolvedCwd = beforeToolCtx.cwd
    if (!resolvedCommand.trim()) { this.addToolResult(toolUseId, 'Tool execution was blocked by beforeTool hook (empty command).', true); return }

    this.cleanupTerminalListeners()
    let outputBuffer = ''

    const uo = window.electronAPI.onTerminalOutput(d => { outputBuffer += d.data; targetBlock!.output = outputBuffer; this.notify() })
    const ue = window.electronAPI.onTerminalExit(d => {
      targetBlock!.exitCode = d.code; targetBlock!.status = 'completed'; this.executingProcessId = null; this.cleanupTerminalListeners(); this.notify()
      this.addToolResult(toolUseId, outputBuffer || '(no output)', d.code !== 0)
    })
    let terminalErrorReceived = false
    const uerr = window.electronAPI.onTerminalError(d => {
      if (terminalErrorReceived) return; terminalErrorReceived = true
      targetBlock!.exitCode = -1; targetBlock!.status = 'completed'; this.executingProcessId = null; targetBlock!.output = d.message; this.cleanupTerminalListeners(); this.notify()
      this.addToolResult(toolUseId, `Error: ${d.message}`, true)
    })
    this.terminalCleanups = [uo, ue, uerr].filter(Boolean) as (() => void)[]

    try {
      const timeoutMs = targetBlock.input.timeout != null ? Number(targetBlock.input.timeout) * 1000 : undefined
      const processId = await window.electronAPI.executeCommand(resolvedCommand, resolvedCwd || undefined, timeoutMs)
      this.executingProcessId = processId
    } catch (err) {
      targetBlock.status = 'completed'; targetBlock.exitCode = -1; targetBlock.output = `Error: ${err instanceof Error ? err.message : 'Failed'}`
      this.cleanupTerminalListeners(); this.notify()
      this.addToolResult(toolUseId, targetBlock.output, true)
    }
  }

  rejectTool = (toolUseId: string): void => {
    for (const msg of this.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { block.status = 'rejected'; break }
      }
    }
    this.notify()
    this.addToolResult(toolUseId, 'Command execution was rejected by the user.', true)
  }

  killTool = (toolUseId: string): void => {
    if (this.executingProcessId) { window.electronAPI.killCommand(this.executingProcessId); this.executingProcessId = null }
    this.cleanupTerminalListeners()
    for (const msg of this.messages) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'tool_use' && block.id === toolUseId) { block.status = 'completed'; block.exitCode = -1; block.output = '(killed by user)'; break }
      }
    }
    this.notify()
    this.addToolResult(toolUseId, 'Command execution was killed by the user.', true)
  }

  cancelLoop = (): void => {
    this.isCancelled = true
    this.abortController?.abort()
    if (this.currentRequestId) { window.electronAPI.apiAbortStream(this.currentRequestId); this.currentRequestId = null }
    this.cleanupTerminalListeners()
    if (this.executingProcessId) { window.electronAPI.killCommand(this.executingProcessId); this.executingProcessId = null }

    // Pause all active sub-agents (stop streams but keep data + unresolved promises)
    for (const subEngine of this.activeSubAgents.values()) {
      subEngine.pauseExecution()
    }

    // Enter pause state — user decides whether to resume or fully stop
    this.agentStatus = {
      status: 'awaiting_continue',
      ...(this.activeSubAgents.size > 0 ? { subAgentCount: this.activeSubAgents.size } : {})
    }
    this.streamingBlocks = []
    this.pendingToolIds = new Set()
    this.notify()
  }

  /** Pause execution (cancel current work but DON'T resolve spawn completion) */
  pauseExecution = (): void => {
    this.isCancelled = true
    this.abortController?.abort()
    if (this.currentRequestId) { window.electronAPI.apiAbortStream(this.currentRequestId); this.currentRequestId = null }
    this.cleanupTerminalListeners()
    if (this.executingProcessId) { window.electronAPI.killCommand(this.executingProcessId); this.executingProcessId = null }
    this.streamingBlocks = []
    this.pendingToolIds = new Set()
    this.notify()
  }

  /** Resume execution (reset cancelled state and restart loop) */
  resumeExecution = (): void => {
    for (const subEngine of this.activeSubAgents.values()) {
      subEngine.resumeExecution()
    }
    this.isCancelled = false
    this.loopCount = 0
    this.pendingToolIds = new Set()
    this.agentStatus = { status: 'idle' }
    this.notify()
    setTimeout(() => this.continueLoop(), 0)
  }

  /** Fully stop execution (main agent + abort all sub-agents) */
  stopExecution = (): void => {
    this.isCancelled = true
    this.abortController?.abort()
    if (this.currentRequestId) { window.electronAPI.apiAbortStream(this.currentRequestId); this.currentRequestId = null }
    this.cleanupTerminalListeners()
    if (this.executingProcessId) { window.electronAPI.killCommand(this.executingProcessId); this.executingProcessId = null }
    for (const subEngine of this.activeSubAgents.values()) {
      subEngine.cancelLoop()
    }
    this.activeSubAgents.clear()
    this.agentStatus = { status: 'idle' }
    this.streamingBlocks = []
    this.pendingToolIds = new Set()
    this.resolveCompletionIfSpawned('aborted')
    this.notify()
  }

  clearError = (): void => {
    this.agentStatus = { status: 'idle' }
    this.notify()
  }

  /** Re-run the current turn after an error. this.messages already ends with the
   *  triggering user message (no assistant message was committed on failure), so a
   *  fresh continueLoop() re-issues the request without duplicating input. */
  retryLastTurn = async (): Promise<void> => {
    const opts = this.opts
    if (!opts.apiKey || this.messages.length === 0) return

    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.streamIdleRetries = 0
    this.abortController?.abort()
    if (this.currentRequestId) {
      window.electronAPI.apiAbortStream(this.currentRequestId)
      this.currentRequestId = null
    }
    this.currentAssistantBlocks = []
    this.streamingBlocks = []
    this.jsonAccumulators = new Map()
    this.toolUseBlocks = []
    this.agentStatus = { status: 'streaming' }
    this.notify()
    this.sessionStartTime = performance.now()
    opts.adapter.reconcileMessages?.(this.messages)
    await this.continueLoop()
  }

  reset = (): void => {
    this.cancelLoop()
    this.stopExecution()
    this.messages = []
    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.notify()
  }

  loadConversation = (msgs: AgentMessage[]): void => {
    this.cancelLoop()
    this.stopExecution()
    this.messages = msgs
    this.loopCount = 0
    this.maxLoopCount = MAX_LOOP_ITERATIONS
    this.streamingBlocks = []
    this.notify()
  }

  extendLoop = (): void => {
    this.maxLoopCount += MAX_LOOP_ITERATIONS
    this.loopCount = 0
    this.agentStatus = { status: 'idle' }
    this.notify()
    setTimeout(() => this.continueLoop(), 0)
  }

  /** The user responded to an ask_user prompt */
  respondToTool = (toolUseId: string, response: string): void => {
    this.messages = this.messages.map(msg => {
      const idx = msg.contentBlocks.findIndex(b => b.type === 'tool_use' && b.id === toolUseId)
      if (idx === -1) return msg
      const block = msg.contentBlocks[idx] as ToolUseBlock
      const updatedBlock: ToolUseBlock = {
        ...block,
        status: 'completed',
        exitCode: response === 'CANCELLED' ? 1 : 0,
        output: response
      }
      const newBlocks = [...msg.contentBlocks]
      newBlocks[idx] = updatedBlock
      return { ...msg, contentBlocks: newBlocks } as AgentMessage
    })
    this.notify()
    this.addToolResult(toolUseId, response, response === 'CANCELLED')
  }

  // ── Spawn sub-agent ──────────────────────────────────────────────────

  spawnSubAgent(config: SpawnSubAgentConfig): SubAgentHandle {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const subConvId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    const subOpts: AgentEngineOptions = {
      ...this.opts,
      conversationId: subConvId,
      hooks: undefined,
      allowedTools: config.allowedTools,
      allowedMcpServers: config.allowedMcpServers,
    }

    const engine = new AgentEngine(subOpts)

    // Set spawn state (consumed by continueLoop)
    engine.spawnSystemPrompt = config.systemPrompt
    engine.onSpawnProgress = config.onProgress
    engine.completionPromise = new Promise<SubAgentResult>((resolve) => {
      engine.resolveCompletion = resolve
    })

    // Inject initial messages
    engine.messages = [...config.initialMessages]

    // Set max loop iterations for sub-agent
    if (config.maxLoopIterations) {
      engine.maxLoopCount = config.maxLoopIterations
    }

    // Start loop (async but handle doesn't await it)
    engine.startSpawnLoop(config)

    // Periodic save during sub-agent execution so progress survives crashes
    const SUB_SAVE_INTERVAL = 5000
    const saveTimer = setInterval(() => {
      if (engine.messages.length > 0) {
        const conv = agentMessagesToConversation(engine.messages, subConvId, 'Sub-agent')
        window.electronAPI.saveConversation(conv).catch(() => {})
      }
    }, SUB_SAVE_INTERVAL)

    // Track for cancellation when the (parent) main agent is stopped
    const cleanup = (): void => {
      clearInterval(saveTimer)
      this.activeSubAgents.delete(id)
    }
    engine.completionPromise!.then(cleanup, cleanup)

    const handle: SubAgentHandle = {
      id,
      subConvId,
      get messages() { return engine.messages },
      get agentStatus() { return engine.agentStatus },
      abort: () => engine.cancelLoop(),
      waitForCompletion: () => engine.completionPromise!,
    }

    this.activeSubAgents.set(id, engine)
    return handle
  }

  /** Simplified loop entry for spawned agents — skips session/hooks/userMsg setup. */
  private startSpawnLoop(config: SpawnSubAgentConfig): void {
    this.loopCount = 0
    this.maxLoopCount = config.maxLoopIterations ?? 10
    this.isCancelled = false
    this.pendingToolIds = new Set()
    this.opts.adapter.reconcileMessages?.(this.messages)
    if (this.messages.length === 0) {
      this.messages = [{
        id: `spawn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'Please execute the task described in the system prompt.' }],
        createdAt: new Date().toISOString()
      }]
    }
    this.continueLoop()
  }

  /** Resolve the spawn completion promise if this is a spawned agent. */
  private resolveCompletionIfSpawned(status: SubAgentResult['status']): void {
    if (!this.resolveCompletion) return
    const outputTokens = this.messages.reduce((sum, m) => sum + (m.outputTokens || 0), 0)

    // Save conversation for token usage statistics
    const convId = this.opts.conversationId
    if (convId && this.messages.length > 0) {
      const firstText = this.messages[0]?.contentBlocks?.find(b => b.type === 'text')?.text || ''
      const title = firstText || 'Sub-agent'
      const conv = agentMessagesToConversation(this.messages, convId, title)
      window.electronAPI.saveConversation(conv).catch(err =>
        console.warn('[AgentEngine] Failed to save sub-agent conversation:', err)
      )
    }

    this.resolveCompletion({ messages: this.messages, status, outputTokens, subConversationId: convId ?? undefined })
    this.resolveCompletion = undefined
    this.completionPromise = undefined
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private addToolResult = (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number): void => {
    // Global guardrail (see MAX_TOOL_RESULT_TOKENS above): errors are kept whole,
    // anything else over the token budget is head+tail truncated and the full text
    // is offloaded to ~/.pulsemind/tmp/trunc/ for the model to `read` back. The length
    // short-circuit skips estimation when even worst-case (all CJK) fits the budget.
    // `maxTokens` overrides the default — the read tool passes Infinity to bypass
    // the guardrail entirely (reading a file IS the task, so results always land
    // in full; nothing is offloaded for it).
    const budget = maxTokens ?? MAX_TOOL_RESULT_TOKENS
    let text = content
    if (!isError && text.length > budget) {
      const estTokens = estimateTokens(text)
      if (estTokens > budget) {
        const perChar = estTokens / text.length
        const head = Math.floor((budget * 0.75) / perChar)
        const tail = Math.floor((budget * 0.25) / perChar)
        const hidden = text.length - head - tail
        const dest = `~/.pulsemind/tmp/trunc/trunc_${toolUseId.slice(0, 8)}_${Date.now()}.txt`
        window.electronAPI.writeFile({ filePath: dest, content: text }).catch(() => {})
        text = `${text.slice(0, head)}\n\n… [Tool result truncated: ~${estTokens.toLocaleString()} tokens, ${hidden.toLocaleString()} chars omitted — full text saved at ${dest}, use \`read\` to page through it] …\n\n${text.slice(-tail)}`
      }
    }

    // Guard against duplicate
    for (const msg of this.messages) {
      if (msg.role !== 'user') continue
      if (msg.contentBlocks.some(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)) {
        console.warn(`[AgentEngine] Duplicate tool_result skipped for ${toolUseId}`)
        this.pendingToolIds.delete(toolUseId)
        if (this.pendingToolIds.size === 0 && !this.isAutoExecuting) this.continueLoop()
        return
      }
    }

    // Auto-mark tool_use as completed — ensures React.memo re-renders ExecutionSegment
    // with the correct status, since addToolResult creates a new messages reference
    // that includes the updated block status.
    for (const msg1 of this.messages) {
      for (const block1 of msg1.contentBlocks) {
        if (block1.type === 'tool_use' && block1.id === toolUseId && block1.status === 'running') {
          block1.status = 'completed'
        }
      }
    }

    const msgs = this.messages
    const lastMsg = msgs[msgs.length - 1]
    const secondLast = msgs.length >= 2 ? msgs[msgs.length - 2] : null
    const isToolResultCollector = secondLast?.role === 'assistant' && secondLast.contentBlocks.some(b => b.type === 'tool_use') && lastMsg?.role === 'user'

    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: text,
      is_error: isError,
      tool_result_id: crypto.randomUUID(),
      ...(imageData ? { imageData } as any : {})
    }

    if (isToolResultCollector) {
      (lastMsg as AgentMessage).contentBlocks = [...lastMsg.contentBlocks, resultBlock]
      this.messages = [...msgs]
    } else {
      const resultMsg: AgentMessage = {
        id: generateMsgId(),
        role: 'user',
        contentBlocks: [resultBlock],
        createdAt: new Date().toISOString()
      }
      this.messages = [...msgs, resultMsg]
    }
    this.notify()

    // Auto-set tool_use block output for CommandCard display (skip exec — already has terminal output)
    const afterToolName = (() => {
      for (const msg of this.messages) { for (const b of msg.contentBlocks) { if (b.type === 'tool_use' && b.id === toolUseId) return b.name } }
      return 'unknown'
    })()
    safeInvokeObserver(this.opts.hooks?.afterTool, { toolUseId, toolName: afterToolName, content: text, isError }, 'afterTool')

    // Auto-set tool_use block output for CommandCard display (skip exec — already has terminal output from IPC)
    if (afterToolName !== 'exec') {
      for (const msg of this.messages) {
        for (const b of msg.contentBlocks) {
          if (b.type === 'tool_use' && b.id === toolUseId) {
            ;(b as ToolUseBlock).output = text.slice(0, UI_PREVIEW_MAX)
          }
        }
      }
    }

    this.pendingToolIds.delete(toolUseId)
    if (this.pendingToolIds.size === 0 && !this.isAutoExecuting) this.continueLoop()
    else if (this.pendingToolIds.size > 0) {
      const remaining = this.toolUseBlocks.filter(t => this.pendingToolIds.has(t.id))
      this.agentStatus = { status: 'awaiting_approval', tools: remaining }
      this.notify()
    }
  }

  private addTruncatedResults(tools: ToolUseBlock[]): void {
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
      return { type: 'tool_result' as const, tool_use_id: tool.id, content: msg, is_error: true }
    })
    this.messages = [...this.messages, { id: generateMsgId(), role: 'user' as const, contentBlocks: combinedBlocks, createdAt: new Date().toISOString() }]
  }

  // ── Stream idle-timeout retry ──────────────────────────────────────────
  // The main-process proxy aborts streams that stay idle for 120s (long silent
  // thinking, network blips). Instead of failing, re-issue the request a few
  // times — the messages array is untouched until onStreamComplete, so a retry
  // simply re-generates from scratch.
  private static readonly MAX_STREAM_IDLE_RETRIES = 2
  private static readonly STREAM_IDLE_TIMEOUT_MARKERS = ['闲置超时', 'Stream idle timeout']

  // ── Tool parameter size limits ──────────────────────────────────────────
  // Prevents the LLM from passing overly large arguments (e.g. write content,
  // edit diffs) that would waste tokens or cause memory issues.
  private static readonly TOOL_PARAM_LIMITS: Record<string, Record<string, number>> = {
    write: { content: 500_000 },
    edit: { diff: 200_000, new_str: 200_000 },
    spawn_agent: { task: 200_000 },
  }
  private static readonly MAX_TOOL_INPUT_JSON_BYTES = 1_000_000 // 1 MB safety net for any tool

  /** Check all tool inputs against size limits. Returns tools that exceed limits. */
  private validateToolParams(tools: ToolUseBlock[]): ToolUseBlock[] {
    const oversized: ToolUseBlock[] = []
    for (const t of tools) {
      const limits = AgentEngine.TOOL_PARAM_LIMITS[t.name]
      const inputJson = JSON.stringify(t.input)
      if (inputJson.length > AgentEngine.MAX_TOOL_INPUT_JSON_BYTES) {
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

  /** True when the MCP server owning a tool has requireApproval enabled. */
  private mcpRequiresApproval(toolName: string): boolean {
    const serverId = this.mcpToolOwner.get(toolName)
    if (!serverId) return false
    return getCachedMcpServers().find(s => s.id === serverId)?.config?.requireApproval === true
  }

  /** Categorize and execute tool_use blocks. Shared by normal path and oversized-param skip path. */
  private async dispatchToolExecution(tools: ToolUseBlock[]): Promise<void> {
    const readOnlyTools = tools.filter(t => t.name === 'read' || t.name === 'list_dir' || t.name === 'find' || t.name === 'search' || t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log')
    const writeEditTools = tools.filter(t => t.name === 'write' || t.name === 'edit' || t.name === 'git_commit' || t.name === 'git_restore')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'webfetch'
    const systemTools = tools.filter(t => isSystemTool(t.name))
    const isMemoryTool = (name: string): boolean => name === 'memory_search' || name === 'memory_save' || name === 'conversation_search' || name === 'tool_result_search'
    const memoryTools = tools.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (name: string): boolean => name === 'knowledge_search' || name === 'knowledge_read'
    const knowledgeTools = tools.filter(t => isKnowledgeTool(t.name))
    const isMCPTool = (name: string): boolean => this.mcpToolOwner.has(name)
    // Gated (requireApproval) MCP tools behave like otherTools: auto-executed only in
    // YOLO mode, otherwise they wait for user approval in handleToolUseResponse.
    const gatedMcpTools = tools.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = tools.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const otherTools = tools.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !isMCPTool(t.name) && t.name !== 'ask_user')
    const isYoloMode = !!this.opts.yoloMode || !!this.spawnSystemPrompt

    try {
      if (readOnlyTools.length > 0) await this.toolExecutor.execReadOnlyTools(readOnlyTools)
      if (writeEditTools.length > 0) for (const t of writeEditTools) await this.toolExecutor.execWorkspaceTool(t)
      if (mcpTools.length > 0) for (const t of mcpTools) await this.toolExecutor.execMCPTool(t)
      if (isYoloMode && gatedMcpTools.length > 0) for (const t of gatedMcpTools) await this.toolExecutor.execMCPTool(t)
      for (const t of systemTools) {
        if (t.name === 'pick_skill') await this.toolExecutor.execPickSkill(t)
        else if (t.name === 'pick_tool') await this.toolExecutor.execPickTool(t, (names) => {
          // Classify by built-in definition set (not mcpToolOwner): an MCP tool from a
          // server that connected after this loop's discovery is still a valid MCP pick.
          const builtinNames = new Set(this.opts.toolManager.getEnabledTools().map(x => x.definition.name))
          this.selectedMcpTools = names.filter(n => !builtinNames.has(n))
          this.selectedBuiltinTools = names.filter(n => builtinNames.has(n))
        })
        else if (t.name === 'install') await this.toolExecutor.execInstall(t)
        else if (t.name === 'spawn_agent') await this.toolExecutor.execSpawnAgent(t)
        else if (t.name === 'webfetch') await this.toolExecutor.execWebFetch(t)
        else if (t.name === 'create_plan') await this.planManager.execCreatePlan(t)
        else if (t.name === 'advance_plan') await this.planManager.execAdvancePlan(t)
      }
      if (memoryTools.length > 0) for (const t of memoryTools) await this.toolExecutor.execOtherTool(t)
      if (knowledgeTools.length > 0) for (const t of knowledgeTools) await this.toolExecutor.execOtherTool(t)
      if (isYoloMode && otherTools.length > 0) { for (const t of otherTools) await this.toolExecutor.execOtherTool(t) }
    } catch (err) {
      this.isAutoExecuting = false
      const msg = err instanceof Error ? err.message : 'Tool execution failed'
      console.error('[AgentEngine] Tool execution error:', msg)
      this.agentStatus = { status: 'error', error: msg }
      this.notify()
      return
    }
  }

  private async handleToolUseResponse(toolUses: ToolUseBlock[]): Promise<void> {
    const opts = this.opts

    const hasTruncated = toolUses.some(t => (t as any)._jsonTruncated === true)
    if (hasTruncated) {
      this.addTruncatedResults(toolUses)
      this.notify()
      this.continueLoop()
      return
    }

    // Reject tools with oversized parameters before dispatching
    const oversized = this.validateToolParams(toolUses)
    if (oversized.length > 0) {
      const oversizedIds = new Set(oversized.map(t => t.id))
      const oversizedResults: ContentBlock[] = oversized.map(t => {
        t.status = 'completed'
        const limits = AgentEngine.TOOL_PARAM_LIMITS[t.name] || {}
        const details = Object.entries(limits)
          .filter(([key]) => typeof t.input?.[key] === 'string')
          .map(([key, max]) => `${key}: ${String(t.input?.[key] ?? '').length} chars (max ${max})`)
          .join(', ')
        const msg = `Tool "${t.name}" was rejected: parameter(s) too large (${details}). Please split the work into smaller calls.`
        return { type: 'tool_result' as const, tool_use_id: t.id, content: msg, is_error: true }
      })
      this.messages = [...this.messages, { id: generateMsgId(), role: 'user' as const, contentBlocks: oversizedResults, createdAt: new Date().toISOString() }]
      // Execute non-oversized tools
      const validTools = toolUses.filter(t => !oversizedIds.has(t.id))
      if (validTools.length > 0) {
        await this.dispatchToolExecution(validTools)
      }
      this.notify()
      this.continueLoop()
      return
    }

    const readOnlyTools = toolUses.filter(t => t.name === 'read' || t.name === 'list_dir' || t.name === 'find' || t.name === 'search' || t.name === 'git_status' || t.name === 'git_diff' || t.name === 'git_log')
    const writeEditTools = toolUses.filter(t => t.name === 'write' || t.name === 'edit' || t.name === 'git_commit' || t.name === 'git_restore')
    const askUserTools = toolUses.filter(t => t.name === 'ask_user')
    const isSystemTool = (name: string): boolean => name === 'install' || name === 'pick_skill' || name === 'pick_tool' || name === 'spawn_agent' || name === 'create_plan' || name === 'advance_plan' || name === 'webfetch'
    const systemTools = toolUses.filter(t => isSystemTool(t.name))
    const isMemoryTool = (name: string): boolean => name === 'memory_search' || name === 'memory_save' || name === 'conversation_search' || name === 'tool_result_search'
    const memoryTools = toolUses.filter(t => isMemoryTool(t.name))
    const isKnowledgeTool = (name: string): boolean => name === 'knowledge_search' || name === 'knowledge_read'
    const knowledgeTools = toolUses.filter(t => isKnowledgeTool(t.name))
    const isMCPTool = (name: string): boolean => this.mcpToolOwner.has(name)
    const mcpApprovalTools = toolUses.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpAutoTools = toolUses.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const mcpTools = toolUses.filter(t => isMCPTool(t.name))
    const otherTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !mcpTools.includes(t) && t.name !== 'ask_user')

    const isYoloMode = !!opts.yoloMode || !!this.spawnSystemPrompt

    this.toolUseBlocks = toolUses
    this.pendingToolIds = new Set(toolUses.map(t => t.id))
    this.isAutoExecuting = true
    for (const t of [...readOnlyTools, ...writeEditTools, ...systemTools, ...memoryTools, ...knowledgeTools, ...mcpAutoTools]) t.status = 'running'
    for (const t of askUserTools) t.status = 'running'
    // Gated MCP tools auto-execute in YOLO mode (incl. sub-agents); in mixed mode
    // they stay pending until the user approves.
    if (isYoloMode) for (const t of [...otherTools, ...mcpApprovalTools]) t.status = 'running'
    else for (const t of mcpApprovalTools) t.status = 'pending'
    this.notify()

    await this.dispatchToolExecution(toolUses)

    this.isAutoExecuting = false
    // Report progress for spawned agents after each tool execution batch
    if (this.onSpawnProgress && this.spawnSystemPrompt) {
      const completed = toolUses.filter(t => t.status === 'completed').length
      this.onSpawnProgress(`子代理进度: [${completed}/${toolUses.length}] ${toolUses.map(t => t.name).join(', ')}`)
    }

    // YOLO mode (incl. sub-agents) bypasses the approval gate — gated MCP tools were
    // already executed by dispatchToolExecution. Only mixed mode holds them for approval.
    const shouldAutoExecAll = isYoloMode || (otherTools.length === 0 && mcpApprovalTools.length === 0)
    if (shouldAutoExecAll) {
      if (askUserTools.length > 0) {
        if (this.spawnSystemPrompt) {
          for (const t of askUserTools) {
            this.addToolResult(t.id, 'ask_user is not available in sub-agent mode.', true)
            t.status = 'completed'
          }
          if (this.pendingToolIds.size === 0) this.continueLoop()
          else { this.agentStatus = { status: 'completed' }; this.notify(); this.resolveCompletionIfSpawned('completed') }
        } else {
          this.agentStatus = { status: 'awaiting_user_input', tools: askUserTools }
        }
      } else if (this.pendingToolIds.size === 0) this.continueLoop()
      else { this.agentStatus = { status: 'completed' }; this.resolveCompletionIfSpawned('completed') }
      this.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: 'tool_use', status: this.agentStatus }, 'afterLlmCall')
      return
    }

    // Mixed mode: show approval UI (gated MCP tools are held for approval — only YOLO mode auto-executes them)
    this.toolUseBlocks = toolUses
    const approvalTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !mcpAutoTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t))
    this.pendingToolIds = new Set(approvalTools.map(t => t.id))
    this.agentStatus = { status: 'awaiting_approval', tools: toolUses }
    safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: 'tool_use', status: { status: 'awaiting_approval', tools: toolUses } }, 'afterLlmCall')
    this.notify()
  }

  private async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> {
    if (toolUses.length > 0) { this.addTruncatedResults(toolUses); this.notify() }
    safeInvokeObserver(this.opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: 'max_tokens', status: { status: 'streaming' } }, 'afterLlmCall')
    this.continueLoop()
  }

  private handleEndTurnResponse(stopReason: string | null): void {
    // Update last assistant message with total session time (user input → loop end)
    if (this.sessionStartTime > 0) {
      const totalMs = Math.round(performance.now() - this.sessionStartTime)
      const lastMsg = this.messages[this.messages.length - 1]
      if (lastMsg?.role === 'assistant') lastMsg.processingMs = totalMs
      this.sessionStartTime = 0
    }
    this.agentStatus = { status: 'completed' }
    this.notify()
    safeInvokeObserver(this.opts.hooks?.afterLlmCall, { messages: this.messages, stopReason, status: { status: 'completed' } }, 'afterLlmCall')
    safeInvokeObserver(this.opts.hooks?.afterSession, { messages: this.messages, status: { status: 'completed' } }, 'afterSession')
    this.resolveCompletionIfSpawned('completed')
  }

  private cleanupTerminalListeners(): void {
    for (const unsub of this.terminalCleanups) unsub()
    this.terminalCleanups = []
  }

  // ── Tool result persistence (for tool_result_search) ──────────────────

  /**
   * Persist all unsaved tool_results to the tool_results table.
   * Saves original content before nanoCompact replaces it with placeholders in the API copy.
   * to ensure original content is never lost.
   */
  private async persistUnsavedToolResults(): Promise<void> {
    const entries: Array<{
      ref_id: string; message_id: string; block_index: number;
      tool_use_id: string; content: string; is_error: number
    }> = []
    for (const msg of this.messages) {
      if (msg.role !== 'user') continue
      for (let bi = 0; bi < msg.contentBlocks.length; bi++) {
        const block = msg.contentBlocks[bi]
        if (block.type !== 'tool_result') continue
        const tr = block as ToolResultBlock
        if (tr.tool_result_id && tr.content && !tr.content.startsWith('[tool_result_id:') && !tr.content.startsWith('[Tool Result:')) {
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
      await window.electronAPI.persistToolResults(this.opts.conversationId!, entries)
    } catch (err) {
      console.warn('[AgentEngine] persistUnsavedToolResults failed:', err)
    }
  }

  // ── Compaction pipeline ──────────────────────────────────────────────
  //
  // Two-layer strategy (all operate on API copies; this.messages untouched):
  //
  //   Layer 1: nanoCompact — tiered tool_result content replacement (API copy)
  //   Layer 2: lightCompact — structured removal of complete tool cycles (API copy)
  //   Layer 3: hardTruncate — drop oldest messages (API copy, last resort)
  //
  // Background memory extraction replaces the old autoCompact mechanism —
  // saves memories from old tool pairs instead of modifying messages.

  /**
   * Layer 3: hard truncation — drop oldest messages from the API-bound array.
   * Operates on a COPY (apiMessages), never touches this.messages, so the UI
   * is unaffected. Last resort when all compression layers still leave us
   * over the context limit.
   *
   * Guarantees:
   *  - Keep at least MIN_KEEP messages (default 10)
   *  - Keep at least MIN_USER_TURNS (default 2) complete user→assistant cycles
   *    so the LLM has enough conversational context to respond coherently.
   */
  private hardTruncate(messages: AgentMessage[], contextLength: number): AgentMessage[] {
    const THRESHOLD = contextLength * 0.9
    const MIN_KEEP = 10
    const MIN_USER_TURNS = 2

    if (messages.length <= MIN_KEEP) return messages

    const estimatedTokens = this.estimateTokens(messages)
    if (estimatedTokens <= THRESHOLD) return messages

    // Scan from the end to find the earliest index that satisfies both guarantees
    let keepStart = messages.length

    // Count user turns from the end
    let userTurnsFound = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userTurnsFound++
        if (userTurnsFound >= MIN_USER_TURNS) {
          keepStart = i
          break
        }
      }
    }
    // Apply MIN_KEEP as a lower bound on the start index
    keepStart = Math.max(keepStart, messages.length - MIN_KEEP)

    // Walk forward from keepStart — estimate what remains to see if we fit
    while (keepStart > 0) {
      const remaining = messages.slice(keepStart - 1)
      if (this.estimateTokens(remaining) <= THRESHOLD) break
      keepStart--
    }

    if (keepStart === 0) return messages

    // ── Fix: preserve tool_use↔tool_result pairing ────────────────
    // If the first kept message is a user with tool_results, walk backward
    // to include the preceding assistant with matching tool_calls.
    // Without this, the OpenAI API rejects the request with
    // "insufficient tool messages following tool_calls message".
    const firstKept = messages[keepStart]
    if (firstKept.role === 'user' && firstKept.contentBlocks.some(b => b.type === 'tool_result')) {
      const orphanedResultIds = new Set(
        firstKept.contentBlocks
          .filter((b): b is ToolResultBlock => b.type === 'tool_result')
          .map(b => (b as ToolResultBlock).tool_use_id)
      )
      for (let i = keepStart - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        const hasMatchingToolUse = messages[i].contentBlocks.some(
          b => b.type === 'tool_use' && orphanedResultIds.has(b.id)
        )
        if (hasMatchingToolUse) {
          keepStart = i
          break
        }
      }
    }

    const truncated = messages.slice(keepStart)
    const dropped = messages.length - truncated.length
    console.log(
      `[AgentEngine] hardTruncate: dropped ${dropped}/${messages.length} oldest messages ` +
      `(est. ${estimatedTokens} → keep under ${THRESHOLD} of ${contextLength})`
    )
    return truncated
  }

  /** Estimate total token count for given messages.
   *  Uses stored outputTokens (LLM-reported) when available as the most accurate signal,
   *  falls back to per-block heuristic (chars/3.5) for user/tool messages.
   *  Pass messages to estimate a subset; defaults to this.messages (compaction path).
   */
  private estimateTokens(messages?: AgentMessage[]): number {
    const msgs = messages ?? this.messages
    let total = 0
    for (const msg of msgs) {
      // Use actual LLM-reported outputTokens when available (most accurate)
      if (msg.outputTokens) {
        total += msg.outputTokens * 3.5
        continue
      }
      for (const block of msg.contentBlocks) {
        if (block.type === 'text') total += block.text.length
        else if (block.type === 'tool_use') total += JSON.stringify(block.input).length + block.name.length
        else if (block.type === 'tool_result') total += (block as ToolResultBlock).content.length
        else if (block.type === 'thinking') total += (block as any).thinking.length
      }
    }
    return Math.ceil(total / 3.5)
  }


  /**
   * Layer 1: Replace stale tool_result content with [tool_result_id:] placeholders.
   * Operates on a copy — does NOT modify this.messages.
   * Uses a tiered strategy to keep the most recent results intact.
   */
  private nanoCompact(messages: AgentMessage[]): AgentMessage[] {
    const TIER_MAP: Record<string, number> = {
      exec: 1, search: 1, find: 1, list_dir: 1,
      read: 2, knowledge_read: 2, knowledge_search: 2,
      memory_search: 2, memory_save: 2, conversation_search: 2, tool_result_search: 2,
      spawn_agent: 2, edit: 2, write: 2, install: 2, pick_skill: 2, pick_tool: 2, webfetch: 2
    }
    const TIER_SIZES: Record<number, number> = { 1: 10, 2: 20 }
    const TIER3_NAMES = new Set(['ask_user', 'create_plan', 'advance_plan'])
    const PROTECTION_WINDOW = 4

    // Protect last N user messages with tool_results
    const protectedMsgIds = new Set<string>()
    {
      let found = 0
      for (let i = messages.length - 1; i >= 0 && found < PROTECTION_WINDOW; i--) {
        const msg = messages[i]
        if (msg.role !== 'user') continue
        if (msg.contentBlocks.some(b => b.type === 'tool_result')) {
          protectedMsgIds.add(msg.id)
          found++
        }
      }
    }

    // Count tool_uses by tier
    const toolUseToName = new Map<string, string>()
    const counts: Record<number, number> = {}
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      for (const block of msg.contentBlocks) {
        if (block.type !== 'tool_use') continue
        if (TIER3_NAMES.has(block.name)) continue
        const tier = TIER_MAP[block.name] ?? 2
        counts[tier] = (counts[tier] || 0) + 1
        toolUseToName.set(block.id, block.name)
      }
    }

    // Calculate compression targets: only compress when >= 2 full tiers exist
    const compressTargets: Record<number, number> = {}
    for (const [tierStr, count] of Object.entries(counts)) {
      const tier = Number(tierStr)
      const size = TIER_SIZES[tier]
      if (!size) continue
      const fullTiers = Math.floor(count / size)
      if (fullTiers >= 2) compressTargets[tier] = (fullTiers - 1) * size
    }

    if (Object.keys(compressTargets).length === 0) return messages

    // Build compressed copy
    const compressed: Record<number, number> = {}
    return messages.map(msg => {
      if (msg.role !== 'user') return msg
      if (protectedMsgIds.has(msg.id)) return msg

      let modified = false
      const newBlocks = msg.contentBlocks.map(block => {
        if (block.type !== 'tool_result') return block
        const name = toolUseToName.get(block.tool_use_id)
        if (!name) return block
        if (TIER3_NAMES.has(name)) return block
        // Skip already-compressed blocks from previous iterations
        if (this._compressedToolUseIds.has(block.tool_use_id)) return block
        const tier = TIER_MAP[name] ?? 2
        const target = compressTargets[tier]
        if (!target || target <= 0) return block
        if ((compressed[tier] || 0) >= target) return block
        const tr = block as ToolResultBlock
        if (tr.content.startsWith('[tool_result_id:') || tr.content.startsWith('[Tool Result:')) return block
        if (!tr.tool_result_id) tr.tool_result_id = crypto.randomUUID()
        compressed[tier] = (compressed[tier] || 0) + 1
        modified = true
        this._compressedToolUseIds.add(tr.tool_use_id)
        return { ...tr, content: `[tool_result_id: ${tr.tool_result_id}]` }
      })
      return modified ? { ...msg, contentBlocks: newBlocks } : msg
    })
  }

  /**
   * Layer 2: Structured pruning without LLM calls.
   *
   * When token estimate exceeds 70% of context length, walk from the OLDEST
   * messages and remove complete tool_use → tool_result cycles that are no
   * longer needed. This preserves:
   *   1. At least 8K token hot zone (recent messages)
   *   2. At least 3 most recent assistant+user rounds
   *   3. The last user message that contains text (conversation coherence)
   *
   * If a user message has text content alongside tool_results, the text is
   * kept and only tool_result blocks are removed (the paired assistant
   * message is still removed).
   *
   * Operates on a copy — does NOT modify this.messages.
   * Use this on the API-bound messages copy before hardTruncate.
   *
   * @returns Compacted messages array (or original if nothing removed).
   */
  private lightCompact(messages: AgentMessage[], contextLength: number): AgentMessage[] {
    if (!contextLength) return messages

    const estimatedTokens = this.estimateTokens(messages)
    if (estimatedTokens < contextLength * 0.7) return messages

    // Find the last text-containing user message (protected)
    let lastTextUserMsgId: string | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user' && m.contentBlocks.some(b => b.type === 'text')) {
        lastTextUserMsgId = m.id
        break
      }
    }

    // Walk forward from oldest to find complete tool cycles.
    // A "tool cycle" = assistant message with tool_uses → subsequent user
    // message(s) with the matching tool_results.
    const toDelete = new Set<number>()
    const toStrip: Map<number, ContentBlock[]> = new Map()

    let roundsDeleted = 0
    for (let i = 0; i < messages.length - 1; i++) {
      const current = messages[i]
      const next = messages[i + 1]

      if (toDelete.has(i)) continue

      if (current.role !== 'assistant' || next.role !== 'user') continue
      const hasToolUses = current.contentBlocks.some(b => b.type === 'tool_use')
      const hasToolResults = next.contentBlocks.some(b => b.type === 'tool_result')
      if (!hasToolUses || !hasToolResults) continue

      // Protection 1: is this the last text user message?
      if (next.id === lastTextUserMsgId) continue

      // Protection 2: keep at least 3 most recent rounds
      const remainingAfter = messages.length - i - 2
      if (remainingAfter < 3) continue

      // Protection 3: keep 8K token hot zone
      let remainingChars = 0
      for (let j = i + 2; j < messages.length; j++) {
        if (toDelete.has(j)) continue
        for (const b of messages[j].contentBlocks) {
          if (b.type === 'text') remainingChars += b.text.length
          else if (b.type === 'tool_result') remainingChars += b.content.length
          else if (b.type === 'thinking') remainingChars += (b as any).thinking.length
        }
      }
      if (remainingChars < 8000 * 3.5) continue

      const userHasText = next.contentBlocks.some(b => b.type === 'text')

      if (!userHasText) {
        toDelete.add(i)
        toDelete.add(i + 1)
        roundsDeleted++
      } else {
        toDelete.add(i)
        toStrip.set(i + 1, next.contentBlocks.filter(b => b.type === 'text'))
        roundsDeleted++
      }
    }

    if (roundsDeleted === 0) return messages

    const newMessages: AgentMessage[] = []
    for (let i = 0; i < messages.length; i++) {
      if (toDelete.has(i)) continue
      const msg = messages[i]
      if (toStrip.has(i)) {
        newMessages.push({ ...msg, contentBlocks: toStrip.get(i)! })
      } else {
        newMessages.push(msg)
      }
    }

    console.log(`[AgentEngine] lightCompact: removed ${roundsDeleted} tool cycles (tokens before: ~${estimatedTokens})`)
    return newMessages
  }

  // ── Background memory extraction (replaces old autoCompact) ──────────

  /** Tracks already-compressed tool_result tool_use_ids, reset on new messages */
  private _compressedToolUseIds = new Set<string>()
  /** Prevents concurrent memory extraction runs */
  private _memExtractionInProgress = false
  /** Cooldown timestamp for memory extraction */
  private _lastMemExtractionTime = 0
  private static readonly MEM_EXTRACTION_COOLDOWN = 30_000

  /**
   * Fire-and-forget memory extraction from old tool pairs.
   * Triggered when context pressure exceeds 90% — aligned with hardTruncate
   * (Layer 3), i.e. right before messages would actually be dropped, so we
   * salvage the tool pairs that are about to be lost rather than re-extracting
   * content that lightCompact can still carry without LLM calls.
   * Unlike autoCompact, this does NOT modify this.messages or DB —
   * it only saves extracted memories to the memory store.
   */
  private scheduleMemoryExtraction(): void {
    if (this._memExtractionInProgress) return
    if (this.spawnSystemPrompt) return
    if (!this.opts.conversationId) return

    if (Date.now() - this._lastMemExtractionTime < AgentEngine.MEM_EXTRACTION_COOLDOWN) return

    const estimatedTokens = this.estimateTokens()
    if (estimatedTokens < (this.opts.contextLength || 128000) * 0.9) return

    this._memExtractionInProgress = true
    this._lastMemExtractionTime = Date.now()

    Promise.resolve().then(async () => {
      try {
        await this.extractMemoriesFromOldToolPairs()
      } catch (err) {
        console.warn('[AgentEngine] Memory extraction failed:', err)
      } finally {
        this._memExtractionInProgress = false
      }
    })
  }

  /**
   * Find old tool_use → tool_result pairs and extract memories from them.
   * Same pair detection as the old autoCompact, but saves memories instead of
   * modifying messages.
   */
  private async extractMemoriesFromOldToolPairs(): Promise<void> {
    // Find compressible assistant+user pairs (same logic as old autoCompact)
    const compressible: Array<{ assistant: AgentMessage; user: AgentMessage }> = []

    for (let i = 0; i < this.messages.length - 1; i++) {
      if (compressible.length >= 3) break

      const current = this.messages[i]
      const next = this.messages[i + 1]

      if (current.role !== 'assistant' || next.role !== 'user') continue
      if (current.autoSummary || next.autoSummary) continue
      if (i >= this.messages.length - 4) continue

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

    // Call LLM for memory extraction
    const prompt = 'You are a memory extraction system. Given AI reasoning and tool execution, extract any important facts, decisions, file paths, or user preferences that should be saved for future reference. Return a JSON array of memories, each with: "content" (string), "type" (one of: "fact", "decision", "preference"), "category" (one of: "code", "architecture", "user_pref", "decision", "general"). Only include genuinely important, durable information. Return ONLY the JSON array, no other text.'

    let raw: string | null = null
    try {
      raw = await this.opts.adapter.callNonStreaming(
        this.opts.apiKey || '',
        this.opts.baseURL || '',
        this.opts.model || '',
        prompt,
        [{ role: 'user' as const, content: summary }],
        500
      )
    } catch (err) {
      console.warn('[AgentEngine] Memory extraction LLM call failed:', err)
      return
    }

    if (!raw) return

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

    // Save memories
    for (const mem of memories) {
      if (!mem.content || mem.content.length < 10) continue
      try {
        await window.electronAPI.saveMemory({
          id: crypto.randomUUID(),
          content: mem.content.slice(0, 2000),
          type: ['fact', 'decision', 'preference'].includes(mem.type) ? mem.type : 'auto',
          category: ['code', 'architecture', 'user_pref', 'decision', 'general'].includes(mem.category) ? mem.category : 'general',
          source: `conversation:${this.opts.conversationId}`
        })
      } catch (err) {
        console.warn('[AgentEngine] Failed to save extracted memory:', err)
      }
    }

    if (memories.length > 0) {
      console.log(`[AgentEngine] Memory extraction: saved ${memories.length} memories from ${compressible.length} old tool pairs`)
    }
  }

}