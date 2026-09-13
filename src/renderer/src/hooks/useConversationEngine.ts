import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock, Plan } from '../types/agent'
import type { AgentEngineOptions } from '../agent/AgentEngine'
import type { AgentEventData } from '../../../shared/agent-protocol'
import type { ToolManager } from '../tools/ToolManager'
import type { SkillManager } from '../skills/SkillManager'
import type { MemoryManager } from '../memory/MemoryManager'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'
import type { ExperienceManager } from '../experiences/ExperienceManager'
import type { LlmAdapter } from '../llm/adapter'
import type { PlatformInfo } from '../types/electron'
import type { HooksConfig } from '../types/hooks'
import { applySessionEvent, freshSessionState, isActiveStatus, type SessionState } from '../utils/session-mirror'

// ── Client-side session state ────────────────────────────────────────
// Engines are hosted in the main process (M1.4 session manager); this hook is
// a protocol client that mirrors their observable state (see
// utils/session-mirror) and forwards commands over the agent-session IPC
// channels.

/**
 * Facade returned by getOrCreateEngine — preserves the AgentEngine surface the
 * rest of the renderer consumes (persistence, controller) while every call is
 * forwarded to the main-hosted engine over the agent-session IPC channels.
 */
export interface SessionEngineHandle {
  readonly messages: AgentMessage[]
  readonly agentStatus: AgentStatus
  readonly streamingBlocks: ContentBlock[]
  readonly plan: Plan | null
  getHistorySummary(): { firstKeptId: string; text: string } | null
  reset(): void
  loadConversation(messages: AgentMessage[]): void
  seedHistorySummary(text?: string, firstKeptId?: string): void
  loadPlan(convId: string): void
  startLoop(userMessage: string): Promise<void>
  approveTool(toolUseId: string): void
  rejectTool(toolUseId: string): void
  killTool(toolUseId: string): void
  respondToTool(toolUseId: string, response: string): void
  extendLoop(): void
  stopExecution(): void
  resumeExecution(): void
  clearError(): void
  retryLastTurn(): void
  cancelLoop(): void
  dispose(): void
  updateOptions(_opts: AgentEngineOptions): void
}

export interface UseConversationEngineOptions {
  apiKey: string | null
  baseURL: string
  model: string
  maxTokens: number
  contextLength?: number
  profileId?: string
  adapter: LlmAdapter
  myName: string
  soul: string
  yourName: string
  workspaceDir?: string
  yoloMode?: boolean
  hooks?: HooksConfig
  locale?: 'zh' | 'en'
  // Injected managers — accepted for interface compatibility; engine assembly
  // now happens in the main-process session manager.
  toolManager: ToolManager
  skillManager: SkillManager
  memoryManager: MemoryManager
  knowledgeManager: KnowledgeManager
  experienceManager?: ExperienceManager
  skillsDir: string
  platformInfo: PlatformInfo | undefined
  /** Called when a non-active engine transitions to 'completed' status. */
  onBackgroundComplete?: (convId: string) => void
  /** Called when a tool/skill state changes (e.g. install_skill). */
  onSkillStateChange?: () => void
}

export function useConversationEngine(options: UseConversationEngineOptions) {
  const statesRef = useRef<Map<string, SessionState>>(new Map())
  const enginesRef = useRef<Map<string, SessionEngineHandle>>(new Map())
  const activeEngineIdRef = useRef<string>('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [activeLoopConvIds, setActiveLoopConvIds] = useState<string[]>([])
  const [retryingConvIds, setRetryingConvIds] = useState<string[]>([])

  // ── Session registry ──
  const ensureSession = useCallback((convId: string): SessionState => {
    let st = statesRef.current.get(convId)
    if (!st) {
      const fresh = freshSessionState()
      statesRef.current.set(convId, fresh)
      // Main resolves the conversation's working directory here (M8): project
      // conversations get their project workspace, plain ones a timestamped
      // folder under the global workspace. Report it back for UI display.
      window.electronAPI.agentSessionCreate(convId)
        .then((r) => { if (r?.workspaceDir) fresh.workspaceDir = r.workspaceDir })
        .catch(() => { /* session create failures surface via ask */ })
      st = fresh
    }
    return st
  }, [])

  const makeHandle = useCallback((convId: string, st: SessionState): SessionEngineHandle => ({
    get messages() { return st.messages },
    get agentStatus() { return st.agentStatus },
    get streamingBlocks() { return st.streamingBlocks },
    get plan() { return st.plan },
    getHistorySummary() { return st.historySummary },
    reset() {
      st.messages = []
      st.agentStatus = { status: 'idle' }
      st.streamingBlocks = []
      st.plan = null
      st.historySummary = null
    },
    loadConversation(msgs: AgentMessage[]) {
      st.messages = msgs
      void window.electronAPI.agentSessionHydrate(convId, msgs, null)
    },
    seedHistorySummary(text?: string, firstKeptId?: string) {
      if (text === undefined) return
      st.historySummary = { text, firstKeptId: firstKeptId ?? '' }
      void window.electronAPI.agentSessionHydrate(convId, st.messages, { text, firstKeptId: firstKeptId ?? '' })
    },
    loadPlan(_convId: string) {
      // The main-side hydrate loads the persisted plan alongside history.
    },
    startLoop(userMessage: string) {
      return window.electronAPI.agentSessionAsk(convId, userMessage)
    },
    approveTool: (toolUseId) => { void window.electronAPI.agentSessionEngineCall(convId, 'approveTool', [toolUseId]) },
    rejectTool: (toolUseId) => { void window.electronAPI.agentSessionEngineCall(convId, 'rejectTool', [toolUseId]) },
    killTool: (toolUseId) => { void window.electronAPI.agentSessionEngineCall(convId, 'killTool', [toolUseId]) },
    respondToTool: (toolUseId, response) => { void window.electronAPI.agentSessionEngineCall(convId, 'respondToTool', [toolUseId, response]) },
    extendLoop: () => { void window.electronAPI.agentSessionEngineCall(convId, 'extendLoop', []) },
    stopExecution: () => { void window.electronAPI.agentSessionEngineCall(convId, 'stopExecution', []) },
    resumeExecution: () => { void window.electronAPI.agentSessionEngineCall(convId, 'resumeExecution', []) },
    clearError: () => { void window.electronAPI.agentSessionEngineCall(convId, 'clearError', []) },
    retryLastTurn: () => { void window.electronAPI.agentSessionEngineCall(convId, 'retryLastTurn', []) },
    cancelLoop() { void window.electronAPI.agentSessionCancel(convId) },
  dispose() { void window.electronAPI.agentSessionEngineCall(convId, 'dispose', []) },
    updateOptions(_opts: AgentEngineOptions) {
      // Options are rebuilt main-side; the client only signals WHEN they change.
      void window.electronAPI.agentSessionRefreshOptions(convId)
    },
  }), [])

  const getOrCreateEngine = useCallback((convId: string): SessionEngineHandle => {
    let handle = enginesRef.current.get(convId)
    if (!handle) {
      const st = ensureSession(convId)
      handle = makeHandle(convId, st)
      enginesRef.current.set(convId, handle)
    }
    return handle
  }, [ensureSession, makeHandle])

  // ── Global session event subscription ──
  useEffect(() => {
    const unsub = window.electronAPI.onAgentSessionEvent(({ sessionId, data: raw }) => {
      const data = raw as AgentEventData
      const st = statesRef.current.get(sessionId)
      if (!st) return
      // Transport-only events (token/tool_start/usage/…) are not mirrored; the
      // follow-up below must not run for them.
      if (!applySessionEvent(st, data)) return

      if (data.type === 'status') {
        setActiveLoopConvIds((prev) => {
          const isActive = isActiveStatus(st.agentStatus)
          const tracked = prev.includes(sessionId)
          if (isActive && !tracked) return [...prev, sessionId]
          if (!isActive && tracked) return prev.filter((id) => id !== sessionId)
          return prev
        })
        setRetryingConvIds((prev) => {
          const isRetrying = st.agentStatus.status === 'retrying'
          const tracked = prev.includes(sessionId)
          if (isRetrying && !tracked) return [...prev, sessionId]
          if (!isRetrying && tracked) return prev.filter((id) => id !== sessionId)
          return prev
        })
        if (st.agentStatus.status === 'completed' && activeEngineIdRef.current !== sessionId) {
          options.onBackgroundComplete?.(sessionId)
        }
      }

      // Best-effort refresh of the cached history summary (fire-and-forget).
      void window.electronAPI.agentSessionEngineCall(sessionId, 'getHistorySummary', [])
        .then((v) => { st.historySummary = (v as SessionState['historySummary']) ?? null })
        .catch(() => {})

      // React state follows only the ACTIVE conversation.
      if (activeEngineIdRef.current === sessionId) {
        setMessages([...st.messages])
        setAgentStatus(st.agentStatus)
        setStreamingBlocks([...st.streamingBlocks])
        setPlan(st.plan ? { ...st.plan, steps: st.plan.steps.map((s) => ({ ...s })) } : null)
      }
    })
    return unsub
    // options.onBackgroundComplete is bridged through a ref below — not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onBackgroundCompleteRef = useRef(options.onBackgroundComplete)
  onBackgroundCompleteRef.current = options.onBackgroundComplete

  /** Mark a conversation as the active one (keeps the ref in sync with callers). */
  const activateEngine = useCallback((convId: string) => {
    activeEngineIdRef.current = convId
    // Rehydrate React state from the mirrored session (events keep it fresh).
    const st = statesRef.current.get(convId)
    if (st) {
      setMessages([...st.messages])
      setAgentStatus(st.agentStatus)
      setStreamingBlocks([...st.streamingBlocks])
      setPlan(st.plan ? { ...st.plan, steps: st.plan.steps.map((s) => ({ ...s })) } : null)
    }
  }, [])

  // ── Signal option changes to the main-hosted engines ──
  const prevOptionsRef = useRef<Partial<typeof options>>({})
  const optionsChanged =
    prevOptionsRef.current.apiKey !== options.apiKey ||
    prevOptionsRef.current.baseURL !== options.baseURL ||
    prevOptionsRef.current.model !== options.model ||
    prevOptionsRef.current.maxTokens !== options.maxTokens ||
    prevOptionsRef.current.profileId !== options.profileId ||
    prevOptionsRef.current.myName !== options.myName ||
    prevOptionsRef.current.soul !== options.soul ||
    prevOptionsRef.current.yourName !== options.yourName ||
    prevOptionsRef.current.yoloMode !== options.yoloMode ||
    prevOptionsRef.current.locale !== options.locale
  if (optionsChanged) {
    prevOptionsRef.current = {
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      model: options.model,
      maxTokens: options.maxTokens,
      profileId: options.profileId,
      myName: options.myName,
      soul: options.soul,
      yourName: options.yourName,
      yoloMode: options.yoloMode,
      locale: options.locale
    }
  }
  useEffect(() => {
    if (!optionsChanged) return
    for (const convId of enginesRef.current.keys()) {
      void window.electronAPI.agentSessionRefreshOptions(convId)
    }
  }, [
    options.apiKey, options.baseURL, options.model, options.maxTokens,
    options.profileId,
    options.myName, options.soul, options.yourName, options.yoloMode,
    options.locale, optionsChanged
  ])

  // ── Engine method proxies (active conversation) ──
  const callActive = useCallback((method: string, ...args: unknown[]) => {
    const convId = activeEngineIdRef.current
    if (!convId) return
    void window.electronAPI.agentSessionEngineCall(convId, method, args)
  }, [])

  const approveTool = useCallback((toolUseId: string) => callActive('approveTool', toolUseId), [callActive])
  const rejectTool = useCallback((toolUseId: string) => callActive('rejectTool', toolUseId), [callActive])
  const killTool = useCallback((toolUseId: string) => callActive('killTool', toolUseId), [callActive])
  const respondToTool = useCallback((toolUseId: string, response: string) => callActive('respondToTool', toolUseId, response), [callActive])
  const extendLoop = useCallback(() => callActive('extendLoop'), [callActive])
  const stopExecution = useCallback(() => callActive('stopExecution'), [callActive])
  const resumeExecution = useCallback(() => callActive('resumeExecution'), [callActive])
  const clearError = useCallback(() => callActive('clearError'), [callActive])
  const retryLast = useCallback(() => callActive('retryLastTurn'), [callActive])
  const cancelLoop = useCallback(() => {
    const convId = activeEngineIdRef.current
    if (convId) void window.electronAPI.agentSessionCancel(convId)
  }, [activeEngineIdRef])

  /** Resolved working directory of a conversation (M8), undefined until the
   *  main-side session creation reports back. */
  const getWorkspaceDir = useCallback((convId: string): string | undefined =>
    statesRef.current.get(convId)?.workspaceDir, [])

  return {
    enginesRef,
    activeEngineIdRef,
    messages,
    agentStatus,
    streamingBlocks,
    plan,
    activeLoopConvIds,
    retryingConvIds,
    getOrCreateEngine,
    activateEngine,
    getWorkspaceDir,
    // State setters exposed for external load/restore operations
    setMessages,
    setAgentStatus,
    setStreamingBlocks,
    setPlan,
    setActiveLoopConvIds,
    // Engine proxies
    approveTool,
    rejectTool,
    killTool,
    respondToTool,
    cancelLoop,
    extendLoop,
    stopExecution,
    resumeExecution,
    clearError,
    retryLast
  }
}
