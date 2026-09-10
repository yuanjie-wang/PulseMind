import { getHost } from './host'
import { IncrementalJsonTracker } from './json-stream'
import type {
  AgentMessage,
  AgentStatus,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
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
import { SkillKeywordAgent, SkillSelectionAgent, HistorySummaryAgent } from './one-shot-agent'
import { sanitizeSchema, safeInvoke, safeInvokeObserver, MAX_LOOP_ITERATIONS, generateMsgId, type SubAgentResult, type SpawnSubAgentConfig, type SubAgentHandle } from './agent-utils'
import { buildCommandFromSkillInput } from './command-builder'
import { buildSystemPrompt } from './system-prompt-builder'
import { PlanManager } from './plan-manager'
import { ensureCache, getCachedMcpServers, getCachedSubAgentProfiles, refreshMcpServers } from './mcp-cache'
import { ToolExecutor, UI_PREVIEW_MAX } from './tool-executors'
import { SpawnManager } from './engine/spawn-manager'
import { collectEnabledTools } from './engine/tool-collection'
import { scheduleMemoryExtraction, persistUnsavedToolResults } from './engine/memory-extraction'
import { ExecutionFlow } from './engine/execution-flow'
import { StreamRunner } from './engine/stream-runner'
import { ContextCompactor, summarizeToolCall } from './engine/context-compactor'
import { addTruncatedResults, extractInvokeToolCalls, validateToolParams } from './engine/result-ingestion'
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
const SUMMARY_INPUT_CAP = 40000

// ── AgentEngine Options ───────────────────────────────────────────────

export interface AgentEngineOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  profileId?: string
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
  experienceManager?: import('../experiences/ExperienceManager').ExperienceManager
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
  /** @internal */
  opts: AgentEngineOptions
  private callbacks!: AgentEngineCallbacks
  /** @internal - reachable from collaborators (SpawnManager / ExecutionFlow) */
  getHost() {
    return getHost()
  }

  /** @internal - reachable from SpawnManager collaborators */
  notify = (): void => {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    this.callbacks.onMessagesChanged?.(this.messages)
    this.callbacks.onStatusChanged?.(this.agentStatus)
    this.callbacks.onStreamingBlocksChanged?.(this.streamingBlocks)
  }

  // SSE deltas and terminal output chunks arrive far faster than the render
  // framerate; each uncoalesced notify fans out into setMessages/setStreamingBlocks
  // state updates that re-render the whole chat view. Coalesce them to ~12fps.
  private static readonly NOTIFY_COALESCE_MS = 80
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  /** Trailing-edge coalesced full notify — for in-place block mutations driven by
   *  high-frequency events (e.g. terminal output streaming into tool_use.output). */
  /** @internal */
  notifyCoalesced = (): void => {
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify()
    }, AgentEngine.NOTIFY_COALESCE_MS)
  }

  /** Coalesced streaming-only notify for the SSE delta path: messages and status
   *  don't change per delta, so re-emitting them would only churn React identity. */
  /** @internal */
  notifyStreamingCoalesced = (): void => {
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.callbacks.onStreamingBlocksChanged?.(this.streamingBlocks)
    }, AgentEngine.NOTIFY_COALESCE_MS)
  }

  /** @internal */
  abortController: AbortController | null = null
  /** @internal */
  currentAssistantBlocks: (ContentBlock | undefined)[] = []
  /** @internal */
  toolUseBlocks: ToolUseBlock[] = []
  /** @internal */
  jsonAccumulators: Map<number, IncrementalJsonTracker> = new Map()
  /** @internal */
  loopCount = 0
  /** @internal */
  maxLoopCount = MAX_LOOP_ITERATIONS
  /** @internal */
  terminalCleanups: (() => void)[] = []
  /** @internal */
  executingProcessId: string | null = null
  /** @internal */
  isCancelled = false
  /** @internal */
  requestStartTime = 0
  private sessionStartTime = 0
  /** Consecutive idle-timeout retries for the current stream. Reset on success. */
  /** @internal */
  streamIdleRetries = 0
  /** @internal */
  pendingToolIds = new Set<string>()
  private isAutoExecuting = false
  /** @internal */
  currentRequestId: string | null = null
  private skillAppendix: string | null = null
  private experienceAppendix: string | null = null
  private systemPromptCache = new Map<string, { prompt: string; time: number }>()
  /** Frozen snapshot of buildMemoryContext() — preserved across system prompt
   *  rebuilds for prefix cache stability. Cleared when memory tools write. */
  private memoryContextSnapshot: string | null = null
  /** Frozen snapshot of buildWikiContext() — preserved across system prompt
   *  rebuilds for prefix cache stability. Invalidated when KnowledgeManager.wikiVersion changes. */
  private wikiContextSnapshot: string | null = null
  private wikiContextVersion = -1
  /** Maps MCP tool name → MCP server ID for routing */
  /** @internal */
  mcpToolOwner = new Map<string, string>()
  /** MCP tool names selected via pick_tool — empty = none selected */
  public selectedMcpTools: string[] = []
  /** Gated built-in tool names activated via pick_tool or keyword trigger — empty = all hidden */
  public selectedBuiltinTools: string[] = []
  /** Cached history summary for the currently-dropped leading region. Keyed by the
   *  id of the first kept message after hardTruncate; reused until the frontier advances. */
  private historySummary: { firstKeptId: string; text: string } | null = null
  // Sub-agents for background LLM tasks (stateless singletons)
  private skillKeywordAgent = new SkillKeywordAgent()
  private skillSelectionAgent = new SkillSelectionAgent()
  // Spawn sub-agent state (set by startSpawnLoop)
  /** @internal */
  resolveCompletion?: (result: SubAgentResult) => void
  /** @internal */
  completionPromise?: Promise<SubAgentResult>
  /** @internal */
  spawnSystemPrompt?: string
  private spawnSystemPromptAppendix?: string
  /** @internal */
  onSpawnProgress?: (summary: string) => void
  /** Last time onSpawnProgress fired — heartbeat updates are throttled to 800ms. */
  private _lastSpawnProgressAt = 0
  /** @internal */
  allowedToolsSet?: Set<string>
  /** @internal */
  allowedMcpServersSet?: Set<string>
  /** Active spawned sub-agents, keyed by sub-agent id */
  /** @internal */
  activeSubAgents = new Map<string, AgentEngine>()
  // Public access to plan (delegated to PlanManager)
  get plan(): Plan | null { return this.planManager.plan }
  // Managers for extracted concerns
  private planManager: PlanManager
  /** @internal */
  toolExecutor: ToolExecutor
  private spawnManager = new SpawnManager(this)
  private streamRunner = new StreamRunner(this)
  private runLlmStream = (opts: AgentEngineOptions, req: { apiUrl: string; headers: Record<string, string>; resolvedBody: unknown }): Promise<void> => this.streamRunner.run(opts, req)
  reportSpawnProgress = (msg: string, force = false): void => { this.spawnManager.reportProgress(msg, force) }
  /** @internal */
  compactor = new ContextCompactor({
    runHistorySummary: (regionText) => this.runHistorySummary(regionText),
    getMessages: () => this.messages,
  })

  /** Current history-summary cache (persisted with the conversation). */
  getHistorySummary(): { firstKeptId: string; text: string } | null {
    return this.compactor.getHistorySummary()
  }

  /** Restore the persisted history summary after rehydration. */
  seedHistorySummary(text?: string, frontierId?: string): void {
    this.compactor.seedHistorySummary(text, frontierId)
  }

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
      await getHost().saveConversationPlan(this.opts.conversationId, plan ? JSON.stringify(plan) : null)
    } catch (err) {
      console.warn('[AgentEngine] Failed to save plan:', err)
    }
  }

  /** Load a persisted plan from DB for an existing conversation. */
  async loadPlan(conversationId: string): Promise<void> {
    try {
      const json = await getHost().getConversationPlan(conversationId)
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
      getHost().apiAbortStream(this.currentRequestId)
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
      getHost().apiAbortStream(this.currentRequestId)
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

  /** @internal - driven by SpawnManager for spawned engines */
  continueLoop = async (): Promise<void> => {
    const opts = this.opts
    if (!opts.apiKey) {
      this.agentStatus = { status: 'error', error: 'API key not configured' }
      this.notify()
      return
    }

    // Reconcile orphaned tool_use blocks (interrupted tool executions) before
    // EVERY request. resumeExecution / stream-idle retry / sub-agent loops jump
    // straight here, bypassing startLoop's reconciliation. Without this, a
    // sleep/resume interrupt leaves an unpaired assistant tool_calls message
    // that OpenAI rejects with "insufficient tool messages following tool_calls".
    opts.adapter.reconcileMessages?.(this.messages)

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
    try {
      const req = await this.prepareLoopRequest(opts)
      await this.runLlmStream(opts, req)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[AgentEngine] loop request failed:', message)
      this.agentStatus = { status: 'error', error: message }
      this.notify()
      safeInvokeObserver(opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: null, status: { status: 'error', error: message } }, 'afterLlmCall')
      safeInvokeObserver(opts.hooks?.afterSession, { messages: this.messages, status: { status: 'error', error: message } }, 'afterSession')
      this.resolveCompletionIfSpawned('error')
    }
  }

  /**
   * Build the loop's LLM request: system prompt, tool schemas, compaction
   * pipeline and hook processing. Returns transport-ready request parts.
   */
  private prepareLoopRequest = async (opts: AgentEngineOptions): Promise<{
    apiUrl: string
    headers: Record<string, string>
    resolvedBody: unknown
  }> => {
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
      experienceAppendix: this.experienceAppendix,
      plan: this.planManager.plan,
      experienceManager: this.opts.experienceManager,
    })
    this.memoryContextSnapshot = spResult.memoryContextSnapshot
    this.wikiContextSnapshot = spResult.wikiContextSnapshot
    this.wikiContextVersion = spResult.wikiContextVersion
    this.skillAppendix = spResult.skillAppendix
    this.experienceAppendix = spResult.experienceAppendix
    const systemPrompt = spResult.systemPrompt

    // ── Tools ──────────────────────────────────────────────────────
    const enabledTools = await collectEnabledTools(this, toolManager)

    // ── Persist tool_results for tool_result_search ──────────────
    if (this.opts.conversationId) {
      await persistUnsavedToolResults(this)
    }

    // ── Background memory extraction (fire-and-forget, doesn't block request) ──
    scheduleMemoryExtraction(this)

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
    const experienceAppendix = this.experienceAppendix
    // Both appendices ride the last user message; find its index first
    const combinedAppendix = [skillAppendix, experienceAppendix].filter(Boolean).join('\n\n') || null
    const lastUserIdx = combinedAppendix
      ? (() => { for (let i = this.messages.length - 1; i >= 0; i--) { if (this.messages[i].role === 'user') return i } return -1 })()
      : -1
    const apiMessages = combinedAppendix && lastUserIdx >= 0
      ? this.messages.map((msg, idx) => {
          if (msg.role === 'user' && idx === lastUserIdx) {
            const blocks = msg.contentBlocks
            if (!blocks) return stripToolResultImages(msg)
            const newBlocks = blocks.map(b => ({ ...b } as ContentBlock))
            for (let i = newBlocks.length - 1; i >= 0; i--) {
              if (newBlocks[i].type === 'text') {
                ;(newBlocks[i] as TextBlock).text += '\n\n' + combinedAppendix
                break
              }
            }
            return { ...msg, contentBlocks: newBlocks }
          }
          return stripToolResultImages(msg)
        })
      : this.messages.map(stripToolResultImages)

    // ── Compaction pipeline (operates on API copy; this.messages untouched) ──
    // Fixed overhead the char heuristic never sees: system prompt + tool schemas.
    // Injected into the fallback estimate so compaction still fires at the right
    // pressure point before the first API token report arrives.
    const fixedOverhead = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(enabledTools))
    const nanoCompacted = this.compactor.nanoCompact(apiMessages)
    const lightCompacted = this.compactor.lightCompact(nanoCompacted, opts.contextLength || 128000, fixedOverhead)
    const truncatedMessages = this.compactor.hardTruncate(lightCompacted, opts.contextLength || 128000, fixedOverhead)
    // After truncation, inject an LLM summary of the dropped region into the API
    // copy so the model keeps the gist. Synthetic message never leaves this scope.
    // Pass the PRE-compaction copy as the summarizer source: nanoCompact has
    // already replaced old tool_results with [tool_result_id:] placeholders, so
    // summarizing lightCompacted would hide what the tools actually returned
    // (incl. failures) and let the summary fabricate outcomes.
    const finalMessages = await this.compactor.injectHistorySummary(apiMessages, lightCompacted, truncatedMessages)

    const { url: apiUrl, headers, body } = opts.adapter.buildRequest(opts.baseURL, opts.apiKey ?? '', {
      model: opts.model,
      maxTokens: Math.floor(opts.maxTokens * 1.5),
      messages: finalMessages,
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

    return { apiUrl, headers, resolvedBody }
  }

  // ── Tool building ────────────────────────────────────────────────────

  // ── Public methods ──────────────────────────────────────────────────

  cancelLoop = (): void => {
    this.isCancelled = true
    this.abortController?.abort()
    if (this.currentRequestId) { getHost().apiAbortStream(this.currentRequestId); this.currentRequestId = null }
    this.cleanupTerminalListeners()
    if (this.executingProcessId) { getHost().killCommand(this.executingProcessId); this.executingProcessId = null }

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

  clearError = (): void => {
    this.agentStatus = { status: 'idle' }
    this.notify()
  }

  // ── Tool execution lifecycle delegation (ExecutionFlow, split 4/5) ──
  private executionFlow = new ExecutionFlow(this)
  approveTool = async (toolUseId: string): Promise<void> => this.executionFlow.approveTool(toolUseId)
  rejectTool = (toolUseId: string): void => this.executionFlow.rejectTool(toolUseId)
  killTool = (toolUseId: string): void => this.executionFlow.killTool(toolUseId)
  pauseExecution = (): void => this.executionFlow.pauseExecution()
  resumeExecution = (): void => this.executionFlow.resumeExecution()
  stopExecution = (): void => this.executionFlow.stopExecution()

  // Sub-agent delegation (SpawnManager, split 3/5)
  spawnSubAgent = (config: SpawnSubAgentConfig): SubAgentHandle => this.spawnManager.spawnSubAgent(config)
  startSpawnLoop = (config: SpawnSubAgentConfig): void => this.spawnManager.startSpawnLoop(config)
  resolveCompletionIfSpawned = (status: SubAgentResult['status']): void => this.spawnManager.resolveCompletionIfSpawned(status)

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
      getHost().apiAbortStream(this.currentRequestId)
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
    this.historySummary = null
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

  // ── Private helpers ──────────────────────────────────────────────────

  /** @internal */
  addToolResult = (toolUseId: string, content: string, isError: boolean, imageData?: string, maxTokens?: number): void => {
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
        getHost().writeFile({ filePath: dest, content: text }).catch(() => {})
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

  // ── Stream idle-timeout retry ──────────────────────────────────────────
  // The main-process proxy aborts streams that stay idle for 120s (long silent
  // thinking, network blips). Instead of failing, re-issue the request a few
  // times — the messages array is untouched until onStreamComplete, so a retry
  // simply re-generates from scratch.
  static readonly MAX_STREAM_IDLE_RETRIES = 2
  static readonly STREAM_IDLE_TIMEOUT_MARKERS = ['闲置超时', 'Stream idle timeout']

  // ── Tool parameter size limits ──────────────────────────────────────────
  // Prevents the LLM from passing overly large arguments (e.g. write content,
  // edit diffs) that would waste tokens or cause memory issues.
  static readonly TOOL_PARAM_LIMITS: Record<string, Record<string, number>> = {
    write: { content: 500_000 },
    edit: { diff: 200_000, new_str: 200_000 },
    spawn_agent: { task: 200_000 },
  }
  static readonly MAX_TOOL_INPUT_JSON_BYTES = 1_000_000 // 1 MB safety net for any tool

  // ── Compaction remaining-window floors ─────────────────────────────────
  // Compaction triggers on remaining window (contextLength - used). On small
  // model windows the percentage floor (10%/30%) collapses to tiny headroom,
  private static readonly LIGHT_COMPACT_MIN_REMAINING = 30_000

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
    const isExperienceTool = (name: string): boolean => name === 'experience_read'
    const experienceTools = tools.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.mcpToolOwner.has(name)
    // Gated (requireApproval) MCP tools behave like otherTools: auto-executed only in
    // YOLO mode, otherwise they wait for user approval in handleToolUseResponse.
    const gatedMcpTools = tools.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpTools = tools.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const otherTools = tools.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !isMCPTool(t.name) && t.name !== 'ask_user')
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
      if (experienceTools.length > 0) for (const t of experienceTools) await this.toolExecutor.execOtherTool(t)
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

  /** @internal */
  async handleToolUseResponse(toolUses: ToolUseBlock[]): Promise<void> {
    const opts = this.opts

    const hasTruncated = toolUses.some(t => (t as any)._jsonTruncated === true)
    if (hasTruncated) {
      addTruncatedResults(this.messages, toolUses)
      this.notify()
      this.continueLoop()
      return
    }

    // Reject tools with oversized parameters before dispatching
    const oversized = validateToolParams(toolUses)
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
        return { type: 'tool_result' as const, tool_use_id: t.id, content: msg, is_error: true, tool_result_id: crypto.randomUUID() }
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
    const isExperienceTool = (name: string): boolean => name === 'experience_read'
    const experienceTools = toolUses.filter(t => isExperienceTool(t.name))
    const isMCPTool = (name: string): boolean => this.mcpToolOwner.has(name)
    const mcpApprovalTools = toolUses.filter(t => isMCPTool(t.name) && this.mcpRequiresApproval(t.name))
    const mcpAutoTools = toolUses.filter(t => isMCPTool(t.name) && !this.mcpRequiresApproval(t.name))
    const mcpTools = toolUses.filter(t => isMCPTool(t.name))
    const otherTools = toolUses.filter(t => !readOnlyTools.includes(t) && !writeEditTools.includes(t) && !systemTools.includes(t) && !memoryTools.includes(t) && !knowledgeTools.includes(t) && !experienceTools.includes(t) && !mcpTools.includes(t) && t.name !== 'ask_user')

    const isYoloMode = !!opts.yoloMode || !!this.spawnSystemPrompt

    this.toolUseBlocks = toolUses
    this.pendingToolIds = new Set(toolUses.map(t => t.id))
    this.isAutoExecuting = true
    for (const t of [...readOnlyTools, ...writeEditTools, ...systemTools, ...memoryTools, ...knowledgeTools, ...experienceTools, ...mcpAutoTools]) t.status = 'running'
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

  /** @internal */
  async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> {
    if (toolUses.length > 0) { addTruncatedResults(this.messages, toolUses); this.notify() }
    safeInvokeObserver(this.opts.hooks?.afterLlmCall, { messages: this.messages, stopReason: 'max_tokens', status: { status: 'streaming' } }, 'afterLlmCall')
    this.continueLoop()
  }

  /** @internal */
  handleEndTurnResponse(stopReason: string | null): void {
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

  // ── Tool result persistence (for tool_result_search) ──────────────────

  /**
   * Persist all unsaved tool_results to the tool_results table.
   * Saves original content before nanoCompact replaces it with placeholders in the API copy.

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

  /** @internal - also driven by ExecutionFlow */
  cleanupTerminalListeners(): void {
    for (const unsub of this.terminalCleanups) unsub()
    this.terminalCleanups = []
  }

  /** Run the HistorySummaryAgent non-streaming. Returns '' on LLM failure/empty. */
  private async runHistorySummary(regionText: string): Promise<string> {
    const summaryAgent = new HistorySummaryAgent()
    try {
      return await summaryAgent.execute(
        { regionText, locale: this.opts.locale },
        {
          llmConfig: {
            adapter: this.opts.adapter,
            apiKey: this.opts.apiKey || '',
            baseURL: this.opts.baseURL,
            model: this.opts.model
          },
          maxTokens: 500
        }
      )
    } catch (err) {
      console.warn('[AgentEngine] history summary failed, using plain truncation:', err)
      return ''
    }
  }


  // ── Background memory extraction (replaces old autoCompact) ──────────

  /** Prevents concurrent memory extraction runs */
  /** @internal */
  _memExtractionInProgress = false
  /** Cooldown timestamp for memory extraction */
  /** @internal */
  _lastMemExtractionTime = 0
  static readonly MEM_EXTRACTION_COOLDOWN = 30_000

}
