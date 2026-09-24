/** Panel state hook: folds the service event stream into a session mirror.
 *
 * The fold itself is the shared reducer (`shared/agent-session/mirror`) that the
 * desktop chat client and the tool studio use too, so the panel interprets the
 * wire protocol identically to the rest of the product (PLAN-browser-extension
 * §3.1.4). This hook only owns React plumbing: attach/subscribe, re-attach after
 * reconnects, and the command surface. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { applySessionEvent, freshSessionState, isActiveStatus, mirroredStatus, type SessionState } from '../../shared/agent-session/mirror'
import type { AgentMessage } from '../../renderer/src/types/agent'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import type { ModelState } from '../../shared/agent-protocol'
import type { ConnectionState, PanelNotification, PanelSnapshot, SessionSummary } from '../bridge'
import { onNotification, request } from '../content/bridge'

const IDLE_CONNECTION: ConnectionState = { state: 'connecting', connected: false }

export interface PanelApi {
  sessionId: string | null
  connection: ConnectionState
  /** Panel visibility (persisted per tab so a reload keeps it open). */
  open: boolean
  sessions: SessionSummary[]
  session: SessionState
  /** The conversation's tool-approval level (授权), mirrored from the desktop. */
  approvalMode: SandboxApprovalMode | undefined
  /** Selectable models (模型) + the active one. Global, like the desktop picker. */
  model: ModelState | undefined
  busy: boolean
  error: string | null
  setError: (err: string | null) => void
  setOpen: (open: boolean) => void
  ask: (content: string) => Promise<void>
  cancel: () => void
  newSession: () => Promise<void>
  resumeSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** 授权按钮：写入 conversations.approval_mode，下一条消息生效。 */
  setApprovalMode: (mode: SandboxApprovalMode) => Promise<void>
  /** 模型下拉：写入 settings.activeProfileId（与桌面端同一个字段），服务端顺手把
   *  活跃会话换到新模型上，所以下一条消息即生效。 */
  setModel: (profileId: string) => Promise<void>
  /** A held tool call: approve or skip it (the engine is parked on the answer). */
  respondToApproval: (toolUseId: string, approved: boolean) => void
  /** The model's ask_user question. */
  answerQuestion: (toolUseId: string, response: string) => void
}

export function usePanel(): PanelApi {
  const mirror = useRef<SessionState>(freshSessionState())
  const [session, setSession] = useState<SessionState>(mirror.current)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>(IDLE_CONNECTION)
  const [open, setOpenState] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [approvalMode, setApprovalModeState] = useState<SandboxApprovalMode | undefined>(undefined)
  const [model, setModelState] = useState<ModelState | undefined>(undefined)

  /** Replace the mirror in place, keeping the same ref for later folds. */
  const seed = useCallback((snapshot: PanelSnapshot) => {
    const next = mirror.current
    next.messages = snapshot.messages as AgentMessage[]
    next.streamingBlocks = snapshot.streamingBlocks as SessionState['streamingBlocks']
    // The panel's snapshot is flat (status + statusError, panel-bridge.ts) and
    // only feeds the label 重试中 — no count — so it re-wraps into the carrier
    // shape rather than widening PanelSnapshot.
    next.agentStatus = mirroredStatus({ status: snapshot.status, error: snapshot.statusError })
    setSession({ ...next })
    setSessionId(snapshot.sessionId)
    setConnection(snapshot.connection)
    setOpenState(snapshot.panelOpen)
    setSessions(snapshot.sessions)
    setApprovalModeState(snapshot.approvalMode)
    // Absent while the service is unreachable (or older than the field): keep
    // whatever we had rather than blanking a picker the user is looking at.
    if (snapshot.model) setModelState(snapshot.model)
    setBusy(isActiveStatus(next.agentStatus))
  }, [])

  const attach = useCallback(async () => {
    const res = await request({ type: 'panel/attach' })
    if (res.ok && res.snapshot) seed(res.snapshot)
    else if (res.error) setError(res.error)
  }, [seed])

  // Attach on mount, and again whenever the service becomes reachable: a fresh
  // worker (or a desktop restart) has to resume the session and pull history.
  const wasConnected = useRef(false)
  useEffect(() => {
    void attach()
  }, [attach])

  useEffect(() => {
    if (connection.connected && !wasConnected.current) {
      wasConnected.current = true
      void attach()
    } else if (!connection.connected) {
      wasConnected.current = false
    }
  }, [connection.connected, attach])

  useEffect(() => {
    return onNotification((msg: PanelNotification) => {
      switch (msg.type) {
        case 'panel/snapshot':
          seed(msg.payload)
          break
        case 'panel/event': {
          // Events for a session this panel is not showing (another tab's).
          if (sessionId && msg.sessionId !== sessionId) return
          applySessionEvent(mirror.current, msg.data)
          const next = mirror.current
          setSession({ ...next })
          setBusy(isActiveStatus(next.agentStatus))
          break
        }
        case 'panel/connection':
          setConnection(msg.payload)
          break
        case 'panel/sessions':
          setSessions(msg.payload)
          break
        // No 'panel/model' branch: the 模型 switch is per conversation now,
        // so only the clicking tab's model moved and its own request answer
        // (snapshot.model, session-scoped service-side) carries the truth.
      }
    })
  }, [seed, sessionId])

  const ask = useCallback(
    async (content: string) => {
      const pageContext = { url: location.href, title: document.title }
      const res = await request({ type: 'panel/ask', content, pageContext })
      if (!res.ok) {
        setError(res.error ?? '发送失败')
        return
      }
      if (res.snapshot) seed(res.snapshot)
    },
    [seed],
  )

  const cancel = useCallback(() => {
    void request({ type: 'panel/cancel' })
  }, [])

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    void request({ type: 'panel/set-open', open: next })
  }, [])

  const newSession = useCallback(async () => {
    const res = await request({ type: 'panel/new-session' })
    if (res.snapshot) seed(res.snapshot)
    else if (res.error) setError(res.error)
  }, [seed])

  const resumeSession = useCallback(
    async (id: string) => {
      const res = await request({ type: 'panel/resume-session', sessionId: id })
      if (res.snapshot) seed(res.snapshot)
      else if (res.error) setError(res.error)
    },
    [seed],
  )

  const deleteSession = useCallback(
    async (id: string) => {
      const res = await request({ type: 'panel/delete-session', sessionId: id })
      if (res.snapshot) seed(res.snapshot)
      else if (res.error) setError(res.error)
    },
    [seed],
  )

  const renameSession = useCallback(async (id: string, title: string) => {
    const res = await request({ type: 'panel/rename-session', sessionId: id, title })
    if (!res.ok) setError(res.error ?? '重命名失败')
  }, [])

  /** 授权：level 写在 conversations.approval_mode 上（与桌面端同一个字段、同一
   *  个语义 —— 下一条消息生效），所以本地立即回显、失败则回退到服务端的答案。 */
  const setApprovalMode = useCallback(async (mode: SandboxApprovalMode) => {
    const previous = approvalMode
    setApprovalModeState(mode)
    const res = await request({ type: 'panel/set-approval', mode })
    if (!res.ok) {
      setApprovalModeState(previous)
      setError(res.error ?? '设置授权方式失败')
    }
  }, [approvalMode])

  /** 模型下拉：把本会话的会话固定到所选模型（conversations.profile_id），
   *  本地先回显、失败回退。服务端返回写后的权威状态（按会话解析的
   *  activeId），用它覆盖乐观值，避免两边不一致。 */
  const setModel = useCallback(
    async (profileId: string) => {
      const previous = model
      if (previous) setModelState({ ...previous, activeId: profileId })
      const res = await request({ type: 'panel/set-model', profileId })
      if (!res.ok) {
        setModelState(previous)
        setError(res.error ?? '切换模型失败')
        return
      }
      const authoritative = res.snapshot?.model
      if (authoritative) setModelState(authoritative)
    },
    [model],
  )

  /** Both of these answer a prompt the service is holding: the engine is parked
   *  until it arrives (approval 2 分钟 / ask_user 5 分钟超时由服务端兜底），
   *  so a refused answer must not look like a dead button. */
  const respondToApproval = useCallback((toolUseId: string, approved: boolean) => {
    void request({ type: 'panel/approval-response', callId: toolUseId, approved }).then((res) => {
      if (!res.ok) setError(res.error ?? '提交授权结果失败')
    })
  }, [])

  const answerQuestion = useCallback((toolUseId: string, response: string) => {
    void request({ type: 'panel/answer', callId: toolUseId, response }).then((res) => {
      if (!res.ok) setError(res.error ?? '提交回答失败')
    })
  }, [])

  return {
    sessionId,
    connection,
    open,
    sessions,
    session,
    approvalMode,
    model,
    busy,
    error,
    setError,
    setOpen,
    ask,
    cancel,
    newSession,
    resumeSession,
    deleteSession,
    renameSession,
    setApprovalMode,
    setModel,
    respondToApproval,
    answerQuestion,
  }
}
