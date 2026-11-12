import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock, Plan, SteerOutcome } from '../types/agent'
import type { AgentEngineOptions } from '../agent/AgentEngine'
import type { AgentEventData } from '../../../shared/agent-protocol'
import type { ToolManager } from '../tools/ToolManager'
import type { SkillManager } from '../skills/SkillManager'
import type { MemoryManager } from '../memory/MemoryManager'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'
import type { LlmAdapter } from '../llm/adapter'
import type { PlatformInfo } from '../types/electron'
import type { HooksConfig } from '../types/hooks'
import { applySessionEvent, freshSessionState, seedSessionState, type SessionState } from '../../../shared/agent-session/mirror'
import { useSessionFileChangesStore } from '../stores/sessionFileChangesStore'
import { useBackgroundTasksStore, backgroundTaskLabel } from '../stores/backgroundTasksStore'
import { usePopoutWatchStore, isPoppedOut } from '../stores/popoutWatchStore'
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
  startLoop(userMessage: string, knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null): Promise<void>
  /** @-summon (召唤专家): the same ask carrying the turn's expert roster. One
   *  name delegates to that expert (whose conclusion comes back verbatim as the
   *  turn's own answer), several enter plan mode. Main decides which — the
   *  renderer only reports who was mentioned. `forcedSkills` is the turn's
   *  $-pinned skills, riding the same ask. */
  startSummonedLoop(userMessage: string, experts: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null): Promise<void>
  approveTool(toolUseId: string, alwaysAllow?: boolean): void
  rejectTool(toolUseId: string): void
  /** /init's time-bounded write window for .pulsemind/AGENTS.md (scoped, see
   *  AgentEngine.grantProjectInstructionsWrite). Resolves once main has opened
   *  it; a failure is swallowed by the caller — the turn still runs, protected
   *  writes just fall back to per-write approval. */
  grantProjectInstructionsWrite(ttlMs: number): Promise<void>
  killTool(toolUseId: string): void
  /** 运行中「转入后台」(PLAN-background-tasks A): the call's outcome rides the
   *  event stream (the block settles with a backgroundPid); the promise only
   *  carries the { ok, error? } ack for a failure toast. */
  promoteToolToBackground(toolUseId: string): Promise<{ ok: boolean; error?: string }>
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
  skillsDir: string
  platformInfo: PlatformInfo | undefined
  /** Called when a non-active engine transitions to 'completed' status. */
  onBackgroundComplete?: (convId: string) => void
  /** A background task of this conversation exited (PLAN-background-tasks B/C):
   *  the delivery/notification orchestrator's trigger. Fires for EVERY exit,
   *  watched or not — the orchestrator decides (active + focused + idle →
   *  deliver; else notify). */
  onBackgroundTaskExit?: (convId: string, pid: number, code: number | null) => void
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
 *  lights, the background-completion callbacks and the approval cards.
 *  `poppedOut` (optional) excludes conversations with a popout window attached:
 *  the popout is a live client of the mirror — evicting (disposing the
 *  main-hosted engine) under it would kill the view the user is looking at. */
export function selectEvictionCandidates(
  entries: Array<{ id: string; status: AgentStatus['status']; touchedAt: number }>,
  activeId: string,
  poppedOut?: ReadonlySet<string>,
): string[] {
  return entries
    .filter((e) => e.id !== activeId && !(poppedOut?.has(e.id)) && TERMINAL_EVICTABLE_STATUSES.includes(e.status))
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
  // ── 后台运行中计数（PLAN-background-tasks B）──
  // exec 工具结果带 backgroundPid 时 +1（tool_status diff 把 pid 送过线）、
  // background_task exit 事件 -1。每会话一组：计数是「仍在跑的后台任务数」，
  // 侧栏状态灯槽画标记用。内存态、不落盘——与 convLights 同命（重启回归零）。
  const [bgRunningCounts, setBgRunningCounts] = useState<Record<string, number>>({})
  const bgPidsRef = useRef<Map<string, Set<number>>>(new Map())

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
    // (main picks the engine method off its length). forcedSkills rides the
    // same ask — the turn's $-pinned skills, staged main-side like knowledgeBase.
    const ask = (content: string, summon?: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null) =>
      window.electronAPI.agentSessionAsk(convId, content, summon, knowledgeBase, forcedSkills).catch((err: unknown) => {
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
      st.fileChanges = []
      useSessionFileChangesStore.getState().drop(convId)
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
    startLoop(userMessage: string, knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null) {
      return ask(userMessage, undefined, knowledgeBase, forcedSkills)
    },
    startSummonedLoop(userMessage: string, experts: SummonedExpert[], knowledgeBase?: { id: string; name: string } | null, forcedSkills?: string[] | null) {
      return ask(userMessage, experts, knowledgeBase, forcedSkills)
    },
    approveTool: (toolUseId, alwaysAllow) => { void window.electronAPI.agentSessionEngineCall(convId, 'approveTool', [toolUseId, alwaysAllow === true]) },
    rejectTool: (toolUseId) => { void window.electronAPI.agentSessionEngineCall(convId, 'rejectTool', [toolUseId]) },
    // /init 的限时写入窗: await creation first (agentSessionCreate is idempotent
    // and queues behind an in-flight one main-side), so the grant cannot race
    // the session's own creation and land on a session-not-found.
    async grantProjectInstructionsWrite(ttlMs: number) {
      await window.electronAPI.agentSessionCreate(convId)
      await window.electronAPI.agentSessionEngineCall(convId, 'grantProjectInstructionsWrite', [ttlMs])
    },
    killTool: (toolUseId) => { void window.electronAPI.agentSessionEngineCall(convId, 'killTool', [toolUseId]) },
    promoteToolToBackground: (toolUseId) =>
      window.electronAPI.agentSessionEngineCall(convId, 'promoteToolToBackground', [toolUseId]) as Promise<{ ok: boolean; error?: string }>,
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
      // ── background_task exit (PLAN-background-tasks B/C) ──
      // Handled BEFORE the mirror gate: the event carries no transcript change
      // (mirror folds it to false), and the light/count bookkeeping must run
      // even when this window holds no mirror for the session (a popout drove
      // the exec). Side effects here: running-count decrement, the delivery/
      // notification callback, and — for a NON-active conversation — the
      // unread-style light. Watching the conversation at event time counts as
      // read (the same rule the completed light uses), so no green for the
      // active view; the delivery path takes over there.
      if (data.type === 'background_task' && data.phase === 'exit') {
        const pids = bgPidsRef.current.get(sessionId)
        pids?.delete(data.pid)
        // 悬浮面板的行同步退场（PLAN-background-tasks D）：与计数同一拍。
        useBackgroundTasksStore.getState().remove(sessionId, data.pid)
        setBgRunningCounts((prev) => {
          const size = pids?.size ?? 0
          if ((prev[sessionId] ?? 0) === size) return prev
          const next = { ...prev, [sessionId]: size }
          if (size <= 0) delete next[sessionId]
          return next
        })
        // 未看本会话 → 亮既有未读绿点（「后台任务完成了」是「回合完成了」的
        // 同族信号）。本会话正被看着时不亮——投递编排负责播报。
        if (activeEngineIdRef.current !== sessionId) {
          setConvLights((prev) => foldConvLight(prev, sessionId, prev[sessionId] ? prev[sessionId] : 'unread'))
        }
        onBackgroundTaskExitRef.current?.(sessionId, data.pid, data.code)
        return
      }
      const st = statesRef.current.get(sessionId)
      if (!st) return
      // Recency for the mirror-eviction sweep (selectEvictionCandidates): the
      // last event a conversation mirrored is the last time it was alive.
      touchTimesRef.current.set(sessionId, Date.now())
      // Transport-only events (token/tool_start/spawn_progress/…) are not
      // mirrored; the follow-up below must not run for them.
      if (!applySessionEvent(st, data)) return

      // The 工作区 tree reads the ledger off a store, not the mirror (the mirror
      // is a ref here and four component layers away from the tree) — mirror
      // the fold's result into it so both say the same thing.
      if (data.type === 'file_changes') useSessionFileChangesStore.getState().set(sessionId, st.fileChanges)

      // 后台运行计数 +1（PLAN-background-tasks B）：diff 把 backgroundPid 送过
      // 线的那一拍登记——去重靠 pid 集合（同 pid 的重复 diff/重放是 no-op）。
      if (data.type === 'tool_status') {
        let added = false
        for (const u of data.updates) {
          if (typeof u.backgroundPid !== 'number' || u.backgroundPid <= 0) continue
          let pids = bgPidsRef.current.get(sessionId)
          if (!pids) { pids = new Set(); bgPidsRef.current.set(sessionId, pids) }
          if (!pids.has(u.backgroundPid)) { pids.add(u.backgroundPid); added = true }
          // 悬浮面板登记（PLAN-background-tasks D）：任务名取镜像里这个 tool_use
          // 块的命令（tool_status 已在同一拍 patch 进镜像，applySessionEvent 先
          // 于本分支跑）——与工具卡同一个对象，不另设推导。块找不到（重放乱序）
          // 回落 pid 字面量。
          const msg = st.messages.find((m) => m.id === u.messageId)
          const block = msg?.contentBlocks?.find(
            (b) => b.type === 'tool_use' && (b as { id?: string }).id === u.toolUseId,
          ) as { name?: string; input?: unknown } | undefined
          useBackgroundTasksStore.getState().upsert(sessionId, {
            pid: u.backgroundPid,
            label: block ? backgroundTaskLabel(block.input, block.name ?? '') : `pid=${u.backgroundPid}`,
            startedAt: Date.now(),
          })
        }
        if (added) {
          setBgRunningCounts((prev) => {
            const size = bgPidsRef.current.get(sessionId)?.size ?? 0
            if ((prev[sessionId] ?? 0) === size) return prev
            return { ...prev, [sessionId]: size }
          })
        }
      }

      if (data.type === 'status') {
        // The light IS the mirrored status, read through statusToLight. 已读 is
        // judged AT EVENT TIME — watching the conversation when the status
        // lands — never "opened it once" (that marking ate every background
        // completion: a conversation you had sent a message in and left stayed
        // read forever, so its green dot could never light). Watching through
        // a popout window counts as watching too (ruling 2026-10-30): the
        // popout registry reports it here, so a turn finished in front of the
        // popout never lights the main window's sidebar green.
        const isRead = activeEngineIdRef.current === sessionId || isPoppedOut(sessionId)
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
  const onBackgroundTaskExitRef = useRef<UseConversationEngineOptions['onBackgroundTaskExit']>(undefined)
  // eslint-disable-next-line react-hooks/refs, react-hooks/immutability -- latest-callback mirror bridged into the mount-only subscription above
  onBackgroundTaskExitRef.current = options.onBackgroundTaskExit

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

  /** Seed a mirror from a main-side snapshot WITHOUT touching React state —
   *  the caller orders this before activateEngine (whose rehydrate pushes the
   *  seeded slices into React). Two consumers:
   *  • the popout window attaching to a LIVE session (snapshot has content);
   *  • the main window ADOPTING a conversation a popout opened (single-writer
   *    saves: the main window needs the mirror so its 10s sweep persists the
   *    conversation, without switching its own view onto it).
   *  ensureSession also fires the idempotent createSession, so a seed alone
   *  is enough to have both the session and the mirror exist. */
  const seedSessionSnapshot = useCallback((key: string, snapshot: {
    messages: unknown[]
    status: { status: string; error?: string; attempt?: number; maxRetries?: number; delayMs?: number; message?: string }
    streamingBlocks: unknown[]
    plan: unknown
    fileChanges?: unknown
  }) => {
    const st = ensureSession(key)
    seedSessionState(st, snapshot)
    useSessionFileChangesStore.getState().set(key, st.fileChanges)
  }, [ensureSession])

  /** Seed a mirror from DB rows (the snapshot came back empty — no live
   *  session content). Same consumers, cold branch. Never touches the
   *  main-hosted engine: hydrating THAT is the engine handle's loadConversation
   *  job, which the caller drives explicitly. */
  const seedSessionHistory = useCallback((key: string, msgs: AgentMessage[], summary?: { text: string; firstKeptId: string } | null) => {
    const st = ensureSession(key)
    st.messages = msgs
    st.agentStatus = { status: 'idle' }
    if (summary) st.historySummary = summary
  }, [ensureSession])

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
  /** 转入后台 needs the OUTCOME back (the failure toast), like steer — not the
   *  fire-and-forget callActive. */
  const promoteToolToBackground = useCallback((toolUseId: string): Promise<{ ok: boolean; error?: string }> => {
    const convId = activeEngineIdRef.current
    if (!convId) return Promise.resolve({ ok: false, error: 'no active conversation' })
    return window.electronAPI.agentSessionEngineCall(convId, 'promoteToolToBackground', [toolUseId]) as Promise<{ ok: boolean; error?: string }>
  }, [activeEngineIdRef])
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
    useSessionFileChangesStore.getState().drop(convId)
    // 悬浮面板的行随镜像一起退场（PLAN-background-tasks D）：引擎已 dispose，
    // 后台进程的 exit 事件不会再被本窗口的行消费。
    useBackgroundTasksStore.getState().drop(convId)
  }, [])

  const listEvictionCandidates = useCallback((): string[] => {
    const entries: Array<{ id: string; status: AgentStatus['status']; touchedAt: number }> = []
    for (const [id, st] of statesRef.current) {
      entries.push({ id, status: st.agentStatus.status, touchedAt: touchTimesRef.current.get(id) ?? 0 })
    }
    const popped = usePopoutWatchStore.getState().byConversation
    return selectEvictionCandidates(entries, activeEngineIdRef.current, new Set(Object.keys(popped)))
  }, [])

  return {
    enginesRef,
    activeEngineIdRef,
    messages,
    agentStatus,
    streamingBlocks,
    plan,
    convLights,
    /** 每会话仍在跑的后台任务数（PLAN-background-tasks B）：exec 结果带
     *  backgroundPid 时 +1、exit 事件 -1；侧栏状态灯槽画「后台运行中」标记。 */
    bgRunningCounts,
    markConversationRead,
    getOrCreateEngine,
    activateEngine,
    seedSessionSnapshot,
    seedSessionHistory,
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
    promoteToolToBackground,
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
