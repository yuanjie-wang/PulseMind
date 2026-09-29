/**
 * Shared client for a main-hosted agent session rendered outside the main
 * chat (run-history transcripts, the routine editor's assistant column).
 *
 * The session lives in the main process (agentSessionManager); this hook
 * folds its event stream with shared/agent-session/mirror, lazily creates the
 * session on the first send, and keeps the persisted conversation in sync
 * once an exchange settles. View concerns — composer, empty hints, run
 * badges — stay with the caller. Extracted from RunTranscript (PLAN-0.4.0
 * M4.4) when the routine editor's assistant column needed the same
 * attach/restore/persist protocol a second time; the tool studio's
 * useStudioSession keeps its eager variant because of its preview concerns.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../types/agent'
import type { SandboxApprovalMode } from '../../../shared/sandbox/policy'
import type { ExpertProfile } from '../../../shared/types/expert'
import type { AgentEventData } from '../../../shared/agent-protocol'
import type { SessionState } from '../../../shared/agent-session/mirror'
import { applySessionEvent, freshSessionState, isActiveStatus, seedSessionState } from '../../../shared/agent-session/mirror'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../utils/message-utils'
import { useConversationApprovalMode } from './useConversationApprovalMode'
import { SYNC_COALESCE_MS } from '../agent/engine/engine-constants'

/** agentSessionCreate options this hook hands through (title is owned by the
 *  `title` option; the rest of AgentSessionCreateOptions stays out of scope). */
export interface HostedSessionCreateOptions {
  /** Owning client tag, e.g. 'routine' / 'routine-assist'. */
  clientId?: string
  /** Full system-prompt replacement for derived sessions. */
  systemPromptOverride?: string
  /** Built-in tool allowlist (D17: a host-side pin, alongside the pack). */
  allowedTools?: string[]
  /** Internal expert config pack pinned at creation (D16: the assistants'
   *  identity — composed main-side, rides on top of the override). */
  expertProfile?: ExpertProfile
}

export interface HostedAgentSessionOptions {
  /** Conversation id; null = nothing selected, the hook stays dormant.
   *  Callers key the view by convId, so it is fixed per mount. */
  convId: string | null
  /** Session + persisted conversation title. */
  title: string
  /** Handed to agentSessionCreate on the first send. */
  createOptions?: HostedSessionCreateOptions
  /** Bump to discard the mirror and re-restore (新会话: the caller disposed
   *  the main-side session and deleted the row, so the re-restore lands on an
   *  empty thread under the SAME convId — the single slot per entity). */
  resetKey?: number
}

export interface HostedAgentSession {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  isBusy: boolean
  /** True until the first restore (live snapshot or stored history) landed. */
  restoring: boolean
  /** Send a user message; `annotation` is appended verbatim (callers pass
   *  context like the routine assistant's live-form block). */
  send: (text: string, annotation?: string) => void
  cancel: () => void
  /** Raw engine call (approveTool / rejectTool / killTool / respondToTool /
   *  clearError / retryLastTurn). */
  engineCall: (method: string, ...args: unknown[]) => void
  /** Signal the main-side engine to rebuild its options (e.g. after the
   *  active profile was switched) — the next ask uses them. */
  refreshOptions: () => void
  /** The conversation's tool-approval level and its setter — the shared
   *  per-conversation state behind the composer's 授权 button (see
   *  useConversationApprovalMode). */
  approvalMode: SandboxApprovalMode | undefined
  setApprovalMode: (mode: SandboxApprovalMode) => void
}

export function useHostedAgentSession({ convId, title, createOptions, resetKey }: HostedAgentSessionOptions): HostedAgentSession {
  const approval = useConversationApprovalMode(convId, resetKey)
  const stateRef = useRef<SessionState>(freshSessionState())
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([])
  // Nothing to restore without a conversation (fixed per keyed mount).
  const [restoring, setRestoring] = useState(convId != null)

  // ── Coalesced, slice-aware sync ──
  // Same contract as useConversationEngine's active sync (2026-09-29): the
  // mirror replaces every slice BY REFERENCE, so reference comparison is the
  // exact change test, and the rAF/80ms schedule caps mirror→React at the
  // cadence the engine leg already uses. Cold paths (restore, send's
  // catch-up, the error setter) call `sync` directly — immediate, and it
  // updates the ledger the scheduled flush compares against.
  const lastSyncedRef = useRef<{ messages?: AgentMessage[]; agentStatus?: AgentStatus; streamingBlocks?: ContentBlock[] }>({})
  const pendingSyncRef = useRef<SessionState | null>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const lastSyncAtRef = useRef(0)

  const applySync = useCallback((state: SessionState): void => {
    const last = lastSyncedRef.current
    if (state.messages !== last.messages) {
      last.messages = state.messages
      setMessages([...state.messages])
    }
    if (state.agentStatus !== last.agentStatus) {
      last.agentStatus = state.agentStatus
      setAgentStatus(state.agentStatus)
    }
    if (state.streamingBlocks !== last.streamingBlocks) {
      last.streamingBlocks = state.streamingBlocks
      setStreamingBlocks([...state.streamingBlocks])
    }
  }, [])

  const sync = useCallback((state: SessionState): void => {
    if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    pendingSyncRef.current = null
    lastSyncAtRef.current = Date.now()
    applySync(state)
  }, [applySync])

  // Fold the session's events into the mirror. The main-side bridge broadcasts
  // every session; this per-mount subscription filters by id (convId is fixed
  // for this keyed instance's lifetime).
  useEffect(() => {
    if (!convId) return
    let alive = true
    const state = freshSessionState()
    stateRef.current = state
    // A re-subscription is a restore cycle — the ledger must describe THIS
    // mirror, not the previous conversation's slices.
    lastSyncedRef.current = {}

    const scheduleSync = (next: SessionState): void => {
      pendingSyncRef.current = next
      if (syncTimerRef.current) return
      const since = Date.now() - lastSyncAtRef.current
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = undefined
        const pending = pendingSyncRef.current
        pendingSyncRef.current = null
        if (!pending || !alive) return
        lastSyncAtRef.current = Date.now()
        // rAF never fires in a hidden window — flush directly there.
        if (document.hidden) { applySync(pending); return }
        requestAnimationFrame(() => applySync(pending))
      }, since >= SYNC_COALESCE_MS ? 0 : SYNC_COALESCE_MS - since)
    }

    // A re-subscription IS a restore cycle (convId switched live): the mirror
    // was just wiped and is about to be reseeded from snapshot or DB. Downstream
    // consumers (the form-assist auto-apply ledger, the restoring hints) must
    // see restoring again, not only on first mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the restore gate when the subscription itself is rebuilt
    setRestoring(true)

    const unsub = window.electronAPI.onAgentSessionEvent(({ sessionId, data: raw }) => {
      if (sessionId !== convId) return
      if (!applySessionEvent(state, raw as AgentEventData)) return
      if (alive) scheduleSync(state)
    })

    // Attach: a live main-side session seeds the mirror from its snapshot; an
    // idle one just displays the persisted transcript read-only (the engine is
    // hydrated lazily on first send).
    void (async () => {
      const snap = await window.electronAPI.agentSessionSnapshot(convId).catch(() => null)
      if (!alive) return
      if (snap && (snap.messages.length > 0 || snap.status.status !== 'idle')) {
        seedSessionState(state, snap)
      } else {
        try {
          const stored = await window.electronAPI.hydrateConversation(convId)
          if (alive && stored?.messages?.length) state.messages = storedMessagesToAgentMessages(stored.messages)
        } catch { /* neither live nor stored — show the empty hint */ }
      }
      if (!alive) return
      sync(state)
      setRestoring(false)
    })()

    return () => {
      alive = false
      unsub()
      if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = undefined }
    }
  }, [convId, sync, applySync, resetKey])

  // Keep the persisted conversation in sync once an exchange settles — the
  // user's continuation (and the automated run's tail, idempotently) must
  // survive restarts. 'idle' covers a continuation the user stopped mid-way.
  const prevStatusRef = useRef<string>('idle')
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = agentStatus.status
    if (!isActiveStatus({ status: prev } as AgentStatus)) return
    if (agentStatus.status !== 'completed' && agentStatus.status !== 'error' && agentStatus.status !== 'idle') return
    const msgs = stateRef.current.messages
    if (!convId || msgs.length === 0) return
    window.electronAPI.saveConversation(agentMessagesToConversation(msgs, convId, title))
      .catch((err) => console.warn('[useHostedAgentSession] save failed:', err))
  }, [agentStatus, convId, title])

  // createOptions may change per render (the prompt override follows
  // the form); a ref keeps `send` referentially stable without stale values.
  const createOptionsRef = useRef(createOptions)
  useEffect(() => { createOptionsRef.current = createOptions })

  /** Ensure the main-hosted session exists, then hand the message to the
   *  engine — restoring stored context first when the mirror is behind. */
  const send = useCallback((text: string, annotation?: string): void => {
    const content = text.trim()
    if (!content || !convId) return
    void (async () => {
      try {
        await window.electronAPI.agentSessionCreate(convId, { title, ...createOptionsRef.current })
        const snap = await window.electronAPI.agentSessionSnapshot(convId).catch(() => null)
        if (!snap || (snap.messages.length === 0 && snap.status.status === 'idle')) {
          const stored = await window.electronAPI.hydrateConversation(convId).catch(() => null)
          if (stored?.messages?.length) {
            const msgs = storedMessagesToAgentMessages(stored.messages)
            stateRef.current.messages = msgs
            sync(stateRef.current)
            await window.electronAPI.agentSessionHydrate(convId, msgs, stored.historySummary
              ? { text: stored.historySummary, firstKeptId: stored.historySummaryFrontier ?? '' }
              : null)
          }
        } else if (snap.messages.length > stateRef.current.messages.length) {
          // The mirror fell behind the live session — catch up before extending.
          seedSessionState(stateRef.current, snap)
          sync(stateRef.current)
        }
        await window.electronAPI.agentSessionAsk(convId, annotation ? content + annotation : content)
      } catch (err) {
        // A failed send (no session, provider error) must be visible, not just
        // a console line — surface it through the same status the loop reports.
        stateRef.current.agentStatus = { status: 'error', error: err instanceof Error ? err.message : String(err) }
        setAgentStatus(stateRef.current.agentStatus)
      }
    })()
  }, [convId, title, sync])

  const engineCall = useCallback((method: string, ...args: unknown[]): void => {
    if (convId) void window.electronAPI.agentSessionEngineCall(convId, method, args)
  }, [convId])

  return {
    messages,
    agentStatus,
    streamingBlocks,
    isBusy: isActiveStatus(agentStatus),
    restoring,
    send,
    cancel: useCallback(() => { if (convId) void window.electronAPI.agentSessionCancel(convId) }, [convId]),
    engineCall,
    refreshOptions: useCallback(() => { if (convId) void window.electronAPI.agentSessionRefreshOptions(convId) }, [convId]),
    approvalMode: approval.approvalMode,
    setApprovalMode: approval.setApprovalMode,
  }
}
