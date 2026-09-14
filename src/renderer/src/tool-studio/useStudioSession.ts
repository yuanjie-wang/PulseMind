/**
 * Studio session client (M5R unification).
 *
 * The studio runs on the same hosted engine as the main chat: it creates an
 * agent session in the main process (`toolstudio_<toolId>`) whose prompt, tool
 * allowlist, working directory and approval mode are pinned to tool building,
 * then mirrors that session's event stream locally. Everything the renderer
 * used to own — the engine, the per-turn app.html read, the transcript — is
 * now the same protocol the chat uses (see utils/session-mirror).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentStatus, ContentBlock } from '../types/agent'
import type { AgentEventData } from '../../../shared/agent-protocol'
import type { SessionState } from '../utils/session-mirror'
import { applySessionEvent, freshSessionState, isActiveStatus, seedSessionState } from '../utils/session-mirror'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../utils/message-utils'
import { TOOL_STUDIO_ALLOWED_TOOLS, TOOL_SYSTEM_PROMPT, studioConversationId } from './tool-prompt'

export interface StudioSession {
  messages: AgentMessage[]
  agentStatus: AgentStatus
  streamingBlocks: ContentBlock[]
  /** True while the agent loop is active (drives the stop button). */
  isRunning: boolean
  /** Latest app.html read from the tool directory; null before the first build. */
  html: string | null
  /** Remount key for the preview iframe (also bumped by a manual refresh). */
  htmlVersion: number
  /** True until the first restore (snapshot or stored history) has landed. */
  restoring: boolean
  /** Send a build/iteration instruction. */
  ask: (text: string) => void
  cancel: () => void
  clearError: () => void
  retryLast: () => void
  /** Signal the main-side engine to rebuild its options (e.g. after the
   *  active profile was switched) — the next loop uses them. */
  refreshOptions: () => void
  /** Re-read app.html from disk (header's preview refresh). */
  reloadPreview: () => void
}

/**
 * Attach to a tool's studio conversation. `toolDir` is the session's working
 * directory — the only place the builder may write; null while the data paths
 * are still loading, in which case the session is not created yet.
 */
export function useStudioSession(toolId: string, toolName: string, toolDir: string | null): StudioSession {
  const convId = studioConversationId(toolId)
  const stateRef = useRef<SessionState>(freshSessionState())
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ status: 'idle' })
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([])
  const [html, setHtml] = useState<string | null>(null)
  /** Increments on every app.html read — the preview iframe's remount key. */
  const [htmlVersion, setHtmlVersion] = useState(0)
  const [restoring, setRestoring] = useState(true)

  const sync = useCallback((state: SessionState): void => {
    setMessages([...state.messages])
    setAgentStatus(state.agentStatus)
    setStreamingBlocks([...state.streamingBlocks])
  }, [])

  const readPreview = useCallback((id: string): void => {
    void window.electronAPI.toolReadHtml(id)
      .then((content) => {
        setHtml(content || null)
        // Bumped on every read (not just on change) so the preview iframe
        // remounts when the user asks for a refresh of identical markup.
        setHtmlVersion((v) => v + 1)
      })
      .catch(() => { /* no app.html yet */ })
  }, [])

  // ── Save the transcript (mirrors the chat's end-of-stream save) ──
  const persist = useCallback((): void => {
    const msgs = stateRef.current.messages
    if (msgs.length === 0) return
    const conv = agentMessagesToConversation(msgs, convId, toolName)
    window.electronAPI.saveConversation(conv).catch((err) =>
      console.warn('[ToolStudio] save failed:', err))
  }, [convId, toolName])

  // ── Create the session, then restore it (live snapshot first, DB second) ──
  // Runs once per (conversation, tool dir): the workspace is keyed by tool, so a
  // different tool mounts a fresh instance rather than re-running this.
  useEffect(() => {
    if (!toolDir) return
    let alive = true
    const state = freshSessionState()
    stateRef.current = state

    const created = window.electronAPI.agentSessionCreate(convId, {
      workspaceDir: toolDir,
      systemPromptOverride: TOOL_SYSTEM_PROMPT,
      allowedTools: TOOL_STUDIO_ALLOWED_TOOLS,
      yoloMode: true,
    }).then(() => undefined).catch((err) => {
      console.warn('[ToolStudio] session create failed:', err)
    })

    const unsub = window.electronAPI.onAgentSessionEvent(({ sessionId, data: raw }) => {
      if (sessionId !== convId) return
      if (!applySessionEvent(state, raw as AgentEventData)) return
      if (alive) sync(state)
    })

    void (async () => {
      await created
      if (!alive) return
      const snapshot = await window.electronAPI.agentSessionSnapshot(convId).catch(() => null)
      const live = snapshot && (snapshot.messages.length > 0 || snapshot.status.status !== 'idle')
      if (live) {
        seedSessionState(state, snapshot)
        if (!alive) return
        sync(state)
        setRestoring(false)
      } else {
        // Idle and empty main-side: rebuild context from the stored transcript so
        // the next instruction iterates on the tool's existing history.
        try {
          const stored = await window.electronAPI.hydrateConversation(convId)
          if (!alive) return
          if (stored?.messages?.length) {
            const msgs = storedMessagesToAgentMessages(stored.messages)
            state.messages = msgs
            await window.electronAPI.agentSessionHydrate(convId, msgs, stored.historySummary
              ? { text: stored.historySummary, firstKeptId: stored.historySummaryFrontier ?? '' }
              : null)
          }
        } catch (err) {
          console.warn('[ToolStudio] history load failed:', err)
        }
        if (!alive) return
        sync(state)
        setRestoring(false)
      }
      // Read on every restore, never gated on the transcript: app.html belongs to
      // the tool, not to the build conversation. A preset ships one with no
      // conversation at all, and a re-opened session that is live but idle has
      // one too — both used to leave the preview blank.
      readPreview(toolId)
    })()

    return () => {
      alive = false
      unsub()
    }
  }, [convId, toolDir, toolId, sync, readPreview])

  // ── Run completion: persist, then pull the freshly written app.html ──
  const prevStatusRef = useRef(agentStatus.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = agentStatus.status
    if (!isActiveStatus({ status: prev } as AgentStatus)) return
    if (agentStatus.status === 'completed') {
      persist()
      readPreview(toolId)
    } else if (agentStatus.status === 'error') {
      persist()
    }
  }, [agentStatus, toolId, persist, readPreview])

  const ask = useCallback((text: string): void => {
    const content = text.trim()
    if (!content) return
    void window.electronAPI.agentSessionAsk(convId, content).catch((err) => {
      // A failed send (no session, provider error) must be visible, not just a
      // console line — surface it through the same status the loop reports.
      stateRef.current.agentStatus = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
      setAgentStatus(stateRef.current.agentStatus)
    })
  }, [convId])

  const cancel = useCallback((): void => {
    void window.electronAPI.agentSessionCancel(convId)
  }, [convId])

  const clearError = useCallback((): void => {
    void window.electronAPI.agentSessionEngineCall(convId, 'clearError', [])
  }, [convId])

  const retryLast = useCallback((): void => {
    void window.electronAPI.agentSessionEngineCall(convId, 'retryLastTurn', [])
  }, [convId])

  const refreshOptions = useCallback((): void => {
    void window.electronAPI.agentSessionRefreshOptions(convId)
  }, [convId])

  const reloadPreview = useCallback((): void => readPreview(toolId), [readPreview, toolId])

  return {
    messages,
    agentStatus,
    streamingBlocks,
    isRunning: isActiveStatus(agentStatus),
    html,
    htmlVersion,
    restoring,
    ask,
    cancel,
    clearError,
    retryLast,
    refreshOptions,
    reloadPreview,
  }
}
