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
import type { ExpertRuntimeContext } from '../../../shared/types/expert'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import type { PageContext } from '../../../shared/agent-protocol'
import { PlanManager } from './plan-manager'
import { ensureCache, getCachedMcpServers, getCachedExpertProfiles, refreshMcpServers } from './mcp-cache'
import { ToolExecutor, UI_PREVIEW_MAX } from './tool-executors'
import { SpawnManager } from './engine/spawn-manager'
import { collectEnabledTools } from './engine/tool-collection'
import { scheduleMemoryExtraction, persistUnsavedToolResults } from './engine/memory-extraction'
import { ExecutionFlow } from './engine/execution-flow'
import { StreamRunner } from './engine/stream-runner'
import { ContextCompactor, summarizeToolCall } from './engine/context-compactor'
import type { EngineCore } from './engine/engine-core'
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
  /** How tool calls are gated for this engine (shared ladder; a project's
   *  sandbox policy is what the session manager resolves onto it). Absent =
   *  'auto' — derived sessions (tool studio, canvas) run unattended. */
  approvalMode?: SandboxApprovalMode
  locale?: 'zh' | 'en'
  conversationId?: string

  // Spawn sub-agent options
  allowedTools?: string[]
  allowedMcpServers?: string[]
  /** Session-level skill whitelist (expert config pack / spawn). Empty/absent = no restriction. */
  allowedSkills?: string[]
  /** @-summoned expert config pack: composed instructions + bound knowledge.
   *  Replaces the basic persona section in the system prompt (see
   *  system-prompt-builder) and scopes knowledge_search/knowledge_read. */
  expert?: ExpertRuntimeContext
  /** Delegated experts (spawn path): knowledge scope without the pack — the
   *  instructions ride in the spawn system prompt, this enforces the
   *  knowledge tools. Same shape as expert.knowledgeFiles. */
  knowledgeScope?: ExpertRuntimeContext['knowledgeFiles']
  systemPromptAppendix?: string
  /** Replace the built system prompt wholesale (derived sessions such as the
   *  tool studio, whose prompt is a builder contract rather than the assistant
   *  persona). Same code path as a spawned agent's prompt — see
   *  buildSystemPrompt's spawnSystemPrompt branch. */
  systemPromptOverride?: string
  /** The browser extension's current tab (per-turn state, set by the session
   *  manager before each ask). Rendered in the prompt's dynamic Current Page
   *  section — never enters the cached prefix. */
  pageContext?: PageContext
}

// ── AgentEngine Callbacks ───────────────────────────────────────────

export interface AgentEngineCallbacks {
  onMessagesChanged?: (messages: AgentMessage[]) => void
  onStatusChanged?: (status: AgentStatus) => void
  onStreamingBlocksChanged?: (blocks: ContentBlock[]) => void
  onPlanChanged?: (plan: Plan | null) => void
}

// ── AgentEngine ───────────────────────────────────────────────────────

// `implements EngineCore` keeps the class honest against the strategy
// modules' declared dependency surface (engine/engine-core.ts).
export class AgentEngine implements EngineCore {
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
  /** @internal */
  sessionStartTime = 0
  /** Consecutive idle-timeout retries for the current stream. Reset on success. */
  /** @internal */
  streamIdleRetries = 0
  /** @internal */
  pendingToolIds = new Set<string>()
  /** @internal */
  isAutoExecuting = false
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
  /** @internal Conversation-list title of a spawned sub-agent. */
  spawnTitle?: string
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
  /** @internal */
  planManager: PlanManager
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
    if (opts.systemPromptOverride) this.spawnSystemPrompt = opts.systemPromptOverride
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

  /** Swap the @-summoned expert config pack at runtime. Expert state lives on
   *  opts (single source of truth for the prompt builder); capability is
   *  inherited from the session, so this swaps identity only and invalidates
   *  the 6h system-prompt cache when the expert changed, so the next loop
   *  rebuilds the prompt with the new role. Called by session-manager before
   *  each ask — cheap no-op when nothing moved. */
  applyExpertContext(next: ExpertRuntimeContext | null): void {
    const expertChanged = JSON.stringify(this.opts.expert ?? null) !== JSON.stringify(next ?? null)
    if (!expertChanged) return

    this.opts.expert = next ?? undefined
    if (this.opts.conversationId) {
      this.systemPromptCache.delete(this.opts.conversationId)
      console.log(`[AgentEngine] expert context ${next ? `→ ${next.id}` : 'cleared'}, prompt cache invalidated`)
    }
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

  // stopReason dispatch delegation (ExecutionFlow, split 8)
  async handleToolUseResponse(toolUses: ToolUseBlock[]): Promise<void> { return this.executionFlow.handleToolUseResponse(toolUses) }
  async handleMaxTokensResponse(toolUses: ToolUseBlock[]): Promise<void> { return this.executionFlow.handleMaxTokensResponse(toolUses) }
  handleEndTurnResponse(stopReason: string | null): void { this.executionFlow.handleEndTurnResponse(stopReason) }

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

  // ── Compaction remaining-window floors ─────────────────────────────────
  // Compaction triggers on remaining window (contextLength - used). On small
  // model windows the percentage floor (10%/30%) collapses to tiny headroom,
  private static readonly LIGHT_COMPACT_MIN_REMAINING = 30_000

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
}
