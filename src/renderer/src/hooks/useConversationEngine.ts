import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock, Plan, SteerOutcome } from '../types/agent'
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
import { applySessionEvent, freshSessionState, type SessionState } from '../../../shared/agent-session/mirror'
import type { CompactionEvent } from '../../../shared/agent-protocol'
import type { SummonedExpert } from '../../../shared/expert-context'
import { SYNC_COALESCE_MS } from '../agent/engine/engine-constants'

// ── Client-side session state ────────────────────────────────────────
// Engines are hosted in the main process (M1.4 session manager); this hook is
// a protocol client that mirrors their observable state (see
// shared/agent-session/mirror) and forwards commands over the agent-session IPC
// channels.

// ── Sidebar status light (user ruling 2026-09-30) ──
/** The four lights a conversation's mirrored status can paint in the sidebar.
 *  All of them derive from the ONE agentStatus, so they can never disagree:
 *  自动执行中 spins, waiting parks are the orange dot, API-level exceptions the
 *  red dot, and a turn completed unread the green dot. */
export type ConversationLight = 'running' | 'waiting' | 'error' | 'unread'

/** Map a session's mirrored status onto its sidebar light (null = unlit).
 *  自动执行中 = streaming/executing/awaiting_extension → the spinning ring.
 *  等待用户反馈 = awaiting_approval / awaiting_user_input / awaiting_continue
 *  (the 暂停 park — 继续执行/停止任务 is also a user decision) → orange dot.
 *  异常 = retrying backoff and the turn's error end (api 请求异常、网络及非
 *  正常响应) → red dot, tied to the status: it clears when the next turn moves
 *  the status, not when the conversation is opened. 任务完成未读 → green dot,
 *  lit when the completed status lands while the conversation is NOT the
 *  active one (watching the turn finish is the read), cleared by
 *  activateEngine (clearUnreadLight). */
export function statusToLight(status: AgentStatus['status'], isRead: boolean): ConversationLight | null {
  switch (status) {
    case 'streaming':
    case 'executing':
    case 'awaiting_extension':
      return 'running'
    case 'awaiting_approval':
    case 'awaiting_user_input':
    case 'awaiting_continue':
      return 'waiting'
    case 'retrying':
    case 'error':
      return 'error'
    case 'completed':
      return isRead ? null : 'unread'
    default:
      return null
  }
}

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
  /** Mid-stream steering (PLAN-mid-stream-steer M1): resolve with the engine's
   *  structured outcome — false means the caller must fall back (stage/send). */
  steer(text: string): Promise<SteerOutcome>
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

/** Opening a conversation is the read receipt: only the 未读 light goes out —
 *  error/waiting/running lights track the status, not the reading. Returns the
 *  SAME object when nothing changed so the setState can bail out. */
export function clearUnreadLight(
  prev: Record<string, ConversationLight>,
  convId: string
): Record<string, ConversationLight> {
  if (prev[convId] !== 'unread') return prev
  const next = { ...prev }
  delete next[convId]
  return next
}

/** Fold one conversation's light into the map (null = unlit). Returns the SAME
 *  object when nothing changed so the setState can bail out. */
export function foldConvLight(
  prev: Record<string, ConversationLight>,
  convId: string,
  light: ConversationLight | null
): Record<string, ConversationLight> {
  if ((prev[convId] ?? null) === light) return prev
  const next = { ...prev }
  if (light) next[convId] = light
  else delete next[convId]
  return next
}

// ── Mirror eviction (12h-run memory bound) ──
// Every conversation the desktop chat ever OPENED this run keeps a full
// SessionState mirror (all messages, all blocks) in statesRef — and its
// main-hosted engine holds the same transcript again — with no eviction path,
// so a long session that visits many conversations grows renderer AND main
// memory monotonically. The cap bounds the cache; the sweep (in
// useConversationPersistence's 10s tick) drops the OLDEST-IDLE mirrors past
// it. Reopening an evicted conversation follows the ordinary cold-open path
// (hydrate from DB), so eviction costs a rehydrate, never data: candidates
// are terminal-status only, and the persistence gate refuses anything the
// verified-save ledger has not covered.
export const MAX_CACHED_CONVERSATIONS = 20

export const TERMINAL_EVICTABLE_STATUSES: AgentStatus['status'][] = ['idle', 'completed', 'error']

/** Pure candidate policy (tests drive this directly): non-active conversations
 *  whose mirrored status can no longer move, oldest-touch first. Live statuses
 *  are never candidates — their events must keep flowing for the sidebar
 *  lights, the background-completion callbacks and the approval cards. */
export function selectEvictionCandidates(
  entries: Array<{ id: string; status: AgentStatus['status']; touchedAt: number }>,
  activeId: string,
): string[] {
  return entries
    .filter((e) => e.id !== activeId && TERMINAL_EVICTABLE_STATUSES.includes(e.status))
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .map((e) => e.id)
}

export function useConversationEngine(options: UseConversationEngineOptions) {
  const statesRef = useRef<Map<string, SessionState>>(new Map())
  const enginesRef = useRef<Map<string, SessionEngineHandle>>(new Map())
  const touchTimesRef = useRef<Map<string, number>>(new Map())
  const activeEngineIdRef = useRef<string>('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [lastCompaction, setLastCompaction] = useState<CompactionEvent | null>(null)
  const [convLights, setConvLights] = useState<Record<string, ConversationLight>>({})

  // ── Session registry ──
  const ensureSession = useCallback((convId: string): SessionState => {
    touchTimesRef.current.set(convId, Date.now())
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
    steer: (text: string) =>
      window.electronAPI.agentSessionEngineCall(convId, 'steer', [text]) as Promise<SteerOutcome>,
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
  // The pending sync carries the session it was scheduled FOR. The scheduler
  // only accepts the active conversation's events, but the flush fires up to
  // one coalesce window (~80ms) later — after 新建任务 / a sidebar switch has
  // already cleared or replaced React's slices for the NEW active conversation.
  // Without the ownership check that stale flush re-pushes the OLD
  // conversation's messages/running status into the new view: the welcome page
  // comes back as the old transcript mid-run, or the draft view freezes on a
  // spinner no live event will ever settle (measured 2026-10-24, user report
  // 「新建会话后视图错乱继续」).
  const pendingSyncRef = useRef<{ sessionId: string; st: SessionState } | null>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const lastSyncAtRef = useRef(0)

  const flushActiveSync = useCallback(() => {
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    const pending = pendingSyncRef.current
    pendingSyncRef.current = null
    if (!pending) return
    // Drop a sync whose session stopped being the active one between schedule
    // and flush: every switch path (activateEngine / handleSelectConversation /
    // createNewConversation) writes activeEngineIdRef before the pending timer
    // can fire, so this is the single choke point that covers all of them.
    if (pending.sessionId !== activeEngineIdRef.current) return
    const st = pending.st
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

  const scheduleActiveSync = useCallback((sessionId: string, st: SessionState) => {
    pendingSyncRef.current = { sessionId, st }
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
      // Recency for the mirror-eviction sweep (selectEvictionCandidates): the
      // last event a conversation mirrored is the last time it was alive.
      touchTimesRef.current.set(sessionId, Date.now())
      // Transport-only events (token/tool_start/spawn_progress/…) are not
      // mirrored; the follow-up below must not run for them.
      if (!applySessionEvent(st, data)) return

      if (data.type === 'status') {
        // The light IS the mirrored status, read through statusToLight. 已读 is
        // judged AT EVENT TIME — watching the conversation when the status
        // lands — never "opened it once" (that marking ate every background
        // completion: a conversation you had sent a message in and left stayed
        // read forever, so its green dot could never light).
        const isRead = activeEngineIdRef.current === sessionId
        const light = statusToLight(st.agentStatus.status, isRead)
        setConvLights((prev) => foldConvLight(prev, sessionId, light))
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
        scheduleActiveSync(sessionId, st)
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

  /** The read receipt, callable from BOTH activation paths: this hook's
   *  activateEngine (the send path's activator) and persistence's
   *  handleSelectConversation (every sidebar/welcome switch — it drives
   *  activeEngineIdRef directly and never routes through activateEngine). */
  const markConversationRead = useCallback((convId: string) => {
    setConvLights((prev) => clearUnreadLight(prev, convId))
  }, [])

  /** Mark a conversation as the active one (keeps the ref in sync with callers). */
  const activateEngine = useCallback((convId: string) => {
    activeEngineIdRef.current = convId
    touchTimesRef.current.set(convId, Date.now())
    // Opening the conversation is the read receipt: its 未读 light goes out.
    // Later completions judge 已读 against the new active id — watching a turn
    // finish stays dark, walking away and letting it finish lights green.
    markConversationRead(convId)
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
  }, [markConversationRead])

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
  /** Mid-stream steering needs the OUTCOME back (the UI stages the text when
   *  the engine rejected), so it cannot ride the fire-and-forget callActive. */
  const steer = useCallback((text: string): Promise<SteerOutcome> => {
    const convId = activeEngineIdRef.current
    if (!convId) return Promise.resolve({ ok: false, reason: 'not_streaming' })
    return window.electronAPI.agentSessionEngineCall(convId, 'steer', [text]) as Promise<SteerOutcome>
  }, [activeEngineIdRef])
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

  // ── Mirror eviction (MAX_CACHED_CONVERSATIONS, 12h-run memory bound) ──
  // Mechanism only — the policy (when/what) lives in the persistence sweep,
  // which owns the verified-save ledger. `dispose` tears the MAIN-hosted
  // engine down too: an evicted conversation's transcript lives on in SQLite,
  // and re-opening follows the ordinary cold-open path (createSession +
  // hydrate from DB). Same-renderer IPC is ordered, so a re-open racing the
  // dispose lands after it.
  const evictEngine = useCallback((convId: string) => {
    enginesRef.current.get(convId)?.dispose()
    enginesRef.current.delete(convId)
    statesRef.current.delete(convId)
    touchTimesRef.current.delete(convId)
  }, [])

  const listEvictionCandidates = useCallback((): string[] => {
    const entries: Array<{ id: string; status: AgentStatus['status']; touchedAt: number }> = []
    for (const [id, st] of statesRef.current) {
      entries.push({ id, status: st.agentStatus.status, touchedAt: touchTimesRef.current.get(id) ?? 0 })
    }
    return selectEvictionCandidates(entries, activeEngineIdRef.current)
  }, [])

  return {
    enginesRef,
    activeEngineIdRef,
    messages,
    agentStatus,
    streamingBlocks,
    plan,
    convLights,
    markConversationRead,
    getOrCreateEngine,
    activateEngine,
    getWorkspaceDir,
    evictEngine,
    listEvictionCandidates,
    // State setters exposed for external load/restore operations
    setMessages,
    setAgentStatus,
    setStreamingBlocks,
    setPlan,
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
    steer,
    stopExecution,
    resumeExecution,
    clearError,
    retryLast
  }
}
