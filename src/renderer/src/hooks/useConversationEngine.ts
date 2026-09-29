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
import { applySessionEvent, freshSessionState, isActiveStatus, type SessionState } from '../../../shared/agent-session/mirror'
import type { CompactionEvent } from '../../../shared/agent-protocol'
import type { SummonedExpert } from '../../../shared/expert-context'
import { SYNC_COALESCE_MS } from '../agent/engine/engine-constants'

// ── Client-side session state ────────────────────────────────────────
// Engines are hosted in the main process (M1.4 session manager); this hook is
// a protocol client that mirrors their observable state (see
// shared/agent-session/mirror) and forwards commands over the agent-session IPC
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
  /** Explicit /compact [指示词] — resolves with the compaction event for UI
   *  feedback, or null when there was nothing to drop / a turn is in flight. */
  compactNow(instruction?: string): Promise<CompactionEvent | null>
  reset(): void
  loadConversation(messages: AgentMessage[]): void
  seedHistorySummary(text?: string, firstKeptId?: string): void
  loadPlan(convId: string): void
  startLoop(userMessage: string, knowledgeBase?: { id: string; name: string } | null): Promise<void>
  /** @-summon (召唤专家): the same ask carrying the turn's expert roster. One
   *  name delegates to that expert (whose conclusion comes back verbatim as the
   *  turn's own answer), several enter plan mode. Main decides which — the
   *  renderer only reports who was mentioned. */
  startSummonedLoop(userMessage: string, experts: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null): Promise<void>
  approveTool(toolUseId: string, alwaysAllow?: boolean): void
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
  const [lastCompaction, setLastCompaction] = useState<CompactionEvent | null>(null)
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

  const makeHandle = useCallback((convId: string, st: SessionState): SessionEngineHandle => {
    // One ask path, two entry points: a normal loop and the @-summon roster
    // (main picks the engine method off its length).
    const ask = (content: string, summon?: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null) =>
      window.electronAPI.agentSessionAsk(convId, content, summon, knowledgeBase).catch((err: unknown) => {
        // A failed ask (session creation blew up, profile missing, …) must be
        // visible in the conversation, not swallowed as an unhandled rejection
        // — that silence is how a dead first message used to look like nothing.
        st.agentStatus = { status: 'error', error: err instanceof Error ? err.message : String(err) }
        if (activeEngineIdRef.current === convId) setAgentStatus(st.agentStatus)
      })
    return {
    get messages() { return st.messages },
    get agentStatus() { return st.agentStatus },
    get streamingBlocks() { return st.streamingBlocks },
    get plan() { return st.plan },
    getHistorySummary() { return st.historySummary },
    compactNow(instruction?: string) {
      return window.electronAPI.agentSessionEngineCall(convId, 'compactNow', [instruction ?? null])
        .then((v) => (v ?? null) as CompactionEvent | null)
    },
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
    startLoop(userMessage: string, knowledgeBase?: { id: string; name: string } | null) {
      return ask(userMessage, undefined, knowledgeBase)
    },
    startSummonedLoop(userMessage: string, experts: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null) {
      return ask(userMessage, experts, knowledgeBase)
    },
    approveTool: (toolUseId, alwaysAllow) => { void window.electronAPI.agentSessionEngineCall(convId, 'approveTool', [toolUseId, alwaysAllow === true]) },
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
    }
  }, [])

  const getOrCreateEngine = useCallback((convId: string): SessionEngineHandle => {
    let handle = enginesRef.current.get(convId)
    if (!handle) {
      const st = ensureSession(convId)
      handle = makeHandle(convId, st)
      enginesRef.current.set(convId, handle)
    }
    return handle
  }, [ensureSession, makeHandle])

  // ── Coalesced, slice-aware sync of the ACTIVE conversation ──
  // The mirror replaces every slice BY REFERENCE on the events that touch it
  // (shared/agent-session/mirror), so reference comparison is the exact
  // "did this slice change" test. Copying all four slices on every mirrored
  // event — the shape before 2026-09-29 — made a streaming_blocks-only tick
  // (~12.5/s under the engine's NOTIFY_COALESCE_MS) rebuild the messages/plan
  // identity too, and every [messages, …] useMemo downstream (allSegments,
  // turnRows'「not re-paid per token」contract, the ring's estimate) re-paid
  // per tick anyway. The rAF/80ms schedule caps this leg at the cadence the
  // engine leg already uses; document.hidden skips rAF, which never fires in
  // a hidden window.
  const lastSyncedRef = useRef<{ messages?: AgentMessage[]; agentStatus?: AgentStatus; streamingBlocks?: ContentBlock[]; plan?: Plan | null }>({})
  const pendingSyncRef = useRef<SessionState | null>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const lastSyncAtRef = useRef(0)

  const flushActiveSync = useCallback(() => {
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    const st = pendingSyncRef.current
    pendingSyncRef.current = null
    if (!st) return
    lastSyncAtRef.current = Date.now()
    const last = lastSyncedRef.current
    if (st.messages !== last.messages) {
      last.messages = st.messages
      setMessages([...st.messages])
    }
    if (st.streamingBlocks !== last.streamingBlocks) {
      last.streamingBlocks = st.streamingBlocks
      setStreamingBlocks([...st.streamingBlocks])
    }
    if (st.agentStatus !== last.agentStatus) {
      last.agentStatus = st.agentStatus
      setAgentStatus(st.agentStatus)
    }
    if (st.plan !== last.plan) {
      last.plan = st.plan
      setPlan(st.plan ? { ...st.plan, nodes: st.plan.nodes.map((n) => ({ ...n })) } : null)
    }
  }, [])

  const scheduleActiveSync = useCallback((st: SessionState) => {
    pendingSyncRef.current = st
    if (syncTimerRef.current) return
    const since = Date.now() - lastSyncAtRef.current
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = undefined
      if (document.hidden) { flushActiveSync(); return }
      requestAnimationFrame(() => flushActiveSync())
    }, since >= SYNC_COALESCE_MS ? 0 : SYNC_COALESCE_MS - since)
  }, [flushActiveSync])

  // ── Global session event subscription ──
  useEffect(() => {
    // History-summary poll throttle: this refresh rode EVERY mirrored event
    // (~12.5 IPC round-trips/s during streaming) for a cache only the 10s
    // sweep and the turn-end saves read. Compaction events carry the summary
    // in-band, so 2s staleness here is invisible.
    const summaryPolledAt = new Map<string, number>()
    const unsub = window.electronAPI.onAgentSessionEvent(({ sessionId, data: raw }) => {
      const data = raw as AgentEventData
      const st = statesRef.current.get(sessionId)
      if (!st) return
      // Transport-only events (token/tool_start/spawn_progress/…) are not
      // mirrored; the follow-up below must not run for them.
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

      // Best-effort refresh of the cached history summary (fire-and-forget,
      // per-session 2s throttle).
      const now = Date.now()
      if (now - (summaryPolledAt.get(sessionId) ?? 0) > 2000) {
        summaryPolledAt.set(sessionId, now)
        void window.electronAPI.agentSessionEngineCall(sessionId, 'getHistorySummary', [])
          .then((v) => { st.historySummary = (v as SessionState['historySummary']) ?? null })
          .catch(() => {})
      }

      // React state follows only the ACTIVE conversation — coalesced and
      // slice-aware (see scheduleActiveSync above).
      if (activeEngineIdRef.current === sessionId) {
        if (data.type === 'compaction') setLastCompaction(data.event)
        scheduleActiveSync(st)
      }
    })
    return () => {
      unsub()
      if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    }
    // options.onBackgroundComplete is bridged through a ref below — not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onBackgroundCompleteRef = useRef(options.onBackgroundComplete)
  // eslint-disable-next-line react-hooks/refs -- latest-callback mirror bridged into the mount-only subscription above
  onBackgroundCompleteRef.current = options.onBackgroundComplete

  /** Mark a conversation as the active one (keeps the ref in sync with callers). */
  const activateEngine = useCallback((convId: string) => {
    activeEngineIdRef.current = convId
    // A pending coalesced flush belongs to the PREVIOUS conversation — drop it,
    // and seed the sync ledger from what this activation delivers so the first
    // post-switch event doesn't re-push slices React already has.
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    pendingSyncRef.current = null
    lastSyncedRef.current = {}
    // Rehydrate React state from the mirrored session (events keep it fresh).
    const st = statesRef.current.get(convId)
    if (st) {
      setMessages([...st.messages])
      setAgentStatus(st.agentStatus)
      setStreamingBlocks([...st.streamingBlocks])
      setPlan(st.plan ? { ...st.plan, nodes: st.plan.nodes.map((n) => ({ ...n })) } : null)
      lastSyncedRef.current = { messages: st.messages, agentStatus: st.agentStatus, streamingBlocks: st.streamingBlocks, plan: st.plan }
      setLastCompaction(st.lastCompaction)
    } else {
      // A conversation this app-run never touched has no mirror — every piece
      // of active-conversation state must reset, or the previous
      // conversation's compaction chip survives the switch.
      setLastCompaction(null)
    }
  }, [])

  // ── Signal option changes to the main-hosted engines ──
  const prevOptionsRef = useRef<Partial<typeof options>>({})
  /* eslint-disable react-hooks/refs -- render-time diff against the previous options to decide whether the refresh effect below fires; the diff IS the signal by design */
  const optionsChanged =
    prevOptionsRef.current.apiKey !== options.apiKey ||
    prevOptionsRef.current.baseURL !== options.baseURL ||
    prevOptionsRef.current.model !== options.model ||
    prevOptionsRef.current.maxTokens !== options.maxTokens ||
    prevOptionsRef.current.profileId !== options.profileId ||
    prevOptionsRef.current.myName !== options.myName ||
    prevOptionsRef.current.soul !== options.soul ||
    prevOptionsRef.current.yourName !== options.yourName ||
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
      locale: options.locale
    }
  }
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    if (!optionsChanged) return
    for (const convId of enginesRef.current.keys()) {
      void window.electronAPI.agentSessionRefreshOptions(convId)
    }
  }, [
    options.apiKey, options.baseURL, options.model, options.maxTokens,
    options.profileId,
    options.myName, options.soul, options.yourName,
    options.locale, optionsChanged
  ])

  // ── Engine method proxies (active conversation) ──
  const callActive = useCallback((method: string, ...args: unknown[]) => {
    const convId = activeEngineIdRef.current
    if (!convId) return
    void window.electronAPI.agentSessionEngineCall(convId, method, args)
  }, [])

  const approveTool = useCallback((toolUseId: string, alwaysAllow?: boolean) => callActive('approveTool', toolUseId, alwaysAllow === true), [callActive])
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
    // Last compaction pass of the active conversation (composer chip + ring
    // projection); null until the engine compacts something.
    lastCompaction,
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
