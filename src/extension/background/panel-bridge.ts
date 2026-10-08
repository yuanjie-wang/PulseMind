/** Panel ↔ service-worker routing (PLAN-browser-extension M1.3/M1.4).
 *
 * Owns everything that happens between the in-page panel and the desktop
 * service: tab↔session binding, session lifecycle (create/resume/list/delete/
 * rename), asking, and pushing `agent.event` to the tab that owns the session.
 *
 * The worker itself is assembly only (index.ts); all of this lives here so the
 * message surface has one home and is testable with a fake client. */

import { applySessionEvent, freshSessionState, isActiveStatus, type SessionState } from '../../shared/agent-session/mirror'
import { Methods } from '../../shared/agent-protocol/methods'
import type {
  AgentEventData,
  AgentHistoryResult,
  ModelState,
  PageContext,
  SessionCreateResult,
  SessionListResult,
} from '../../shared/agent-protocol'
import type { WsClient } from './ws-client'
import type { ConnectionState, PanelRequest, PanelResponse, PanelSnapshot, SessionSummary } from '../bridge'
import {
  bindTabSession,
  clearSession,
  clearTab,
  clearTabApprovalMode,
  clearTabModelId,
  getSessionForTab,
  getTabApprovalMode,
  getTabForSession,
  getTabModelId,
  isPanelOpen,
  setPanelOpen,
  setTabApprovalMode,
  setTabModelId,
} from './state'

/** An ask can run for minutes; the client's default request timeout is 30s, so
 *  the ask carries its own generous ceiling instead of being cut off mid-run. */
const ASK_TIMEOUT_MS = 10 * 60_000

/** Mirrors held per session while the worker lives, so a panel that re-attaches
 *  (page navigation) can be handed the current transcript without a re-fetch.
 *  The service stays authoritative — this is only a cache. */
export interface PanelBridgeDeps {
  /** Null while disconnected; requests are rejected until it exists. */
  getClient: () => WsClient | null
  getConnection: () => ConnectionState
}

export class PanelBridge {
  private mirrors = new Map<string, SessionState>()

  constructor(private deps: PanelBridgeDeps) {}

  // ── panel → service ────────────────────────────────────────────────

  /** Dispatch one panel request. Never throws: failures come back as ok:false. */
  async handleRequest(msg: PanelRequest, tabId: number | null): Promise<PanelResponse> {
    if (tabId === null) return { ok: false, error: 'no tab' }
    try {
      switch (msg.type) {
        case 'panel/attach':
          return { ok: true, snapshot: await this.snapshot(tabId) }

        case 'panel/set-open':
          await setPanelOpen(tabId, msg.open)
          return { ok: true }

        case 'panel/ask': {
          const client = this.deps.getClient()
          if (!client?.connected) return { ok: false, error: '未连接桌面端' }
          const sessionId = await this.ensureSession(tabId, msg.pageContext)
          // Fire and forget: completion arrives as `done`/`error` events. The
          // reply is the panel's cue that the message was accepted.
          void client
            .request(Methods.agentAsk, { sessionId, content: msg.content, pageContext: msg.pageContext }, ASK_TIMEOUT_MS)
            .catch((err: Error) => this.pushEvent(tabId, sessionId, { type: 'error', message: err.message }))
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/cancel': {
          const client = this.deps.getClient()
          const sessionId = await getSessionForTab(tabId)
          if (client?.connected && sessionId) void client.request(Methods.agentCancel, { sessionId }).catch(() => {})
          return { ok: true }
        }

        case 'panel/new-session': {
          const client = this.deps.getClient()
          if (!client?.connected) return { ok: false, error: '未连接桌面端' }
          const created = await this.createSession(client, null, undefined)
          await clearTab(tabId)
          await bindTabSession(tabId, created.sessionId)
          this.mirrors.set(created.sessionId, freshSessionState())
          // Pre-session 授权/模型 choices ride onto the fresh conversation too —
          // the same carry the first ask performs, so where the choice lands
          // does not depend on whether the user sends or hits 新会话 first.
          await this.applyTabApprovalMode(tabId, created.sessionId)
          await this.applyTabModelId(tabId, created.sessionId)
          const summary = await this.listSessions(client)
          this.broadcast('panel/sessions', summary)
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/resume-session': {
          const client = this.deps.getClient()
          if (!client?.connected) return { ok: false, error: '未连接桌面端' }
          await clearTab(tabId)
          await bindTabSession(tabId, msg.sessionId)
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/list-sessions':
          return { ok: true, data: await this.listSessions(this.requireClient()) }

        case 'panel/delete-session': {
          const client = this.requireClient()
          await client.request(Methods.sessionDelete, { sessionId: msg.sessionId })
          this.mirrors.delete(msg.sessionId)
          await clearSession(msg.sessionId)
          this.broadcast('panel/sessions', await this.listSessions(client).catch(() => []))
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/rename-session': {
          await this.requireClient().request(Methods.sessionRename, { sessionId: msg.sessionId, title: msg.title })
          this.broadcast('panel/sessions', await this.listSessions(this.requireClient()))
          return { ok: true }
        }

        case 'panel/set-approval': {
          // Tab-scoped choices are strictly PRE-session, like 模型: with no
          // session yet there is no conversation row to carry the choice, so it
          // waits here and ensureSession replays it once one exists (and clears
          // it). With a session the column takes the click directly — writing
          // the tab value too would leave a stale duplicate that resurrects on
          // the next fresh session.
          const sessionId = await getSessionForTab(tabId)
          if (sessionId) {
            await this.requireClient().request(Methods.sessionSetApprovalMode, { sessionId, mode: msg.mode })
          } else {
            await setTabApprovalMode(tabId, msg.mode)
          }
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/set-model': {
          // Per conversation now, like 授权: the request pins THIS tab's
          // session's conversation (`conversations.profile_id`). With no
          // session yet the choice waits in the tab's session storage and
          // ensureSession applies it to the one the first message creates —
          // the click is never lost. The answer's snapshot carries the model
          // in force afterwards; no cross-tab broadcast, other tabs'
          // conversations did not move.
          const sessionId = await getSessionForTab(tabId)
          if (sessionId) {
            await this.requireClient().request(Methods.modelSetActive, { profileId: msg.profileId, sessionId })
          } else {
            await setTabModelId(tabId, msg.profileId)
          }
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/approval-response': {
          // A request, not a notify: the service answers whether the callId was
          // still parked. After a server-side timeout (审批 2 分钟静默即拒) the
          // buttons can outlive their prompt — an unknown callId must reach the
          // panel as a failed answer, not vanish into a server-side warn.
          await this.requireClient().request(Methods.approvalResponse, { callId: msg.callId, approved: msg.approved })
          return { ok: true }
        }

        case 'panel/answer': {
          // Same shape as the approval relay: an unknown/timeout callId comes
          // back as an error the panel can show (the engine settles its own
          // timeouts with a timeout note, so the loop never stalls on it).
          await this.requireClient().request(Methods.askUserResponse, { callId: msg.callId, response: msg.response })
          return { ok: true }
        }

        case 'panel/iteration-response': {
          // The engine is parked on the loop-limit decision (status
          // awaiting_extension — no callId, the status event itself is the
          // prompt) and the resulting status event updates the panel. Still sent
          // as a request, so a session that is already gone surfaces as
          // 提交失败 instead of leaving the card up forever. The service's
          // hosted router maps the decision to extendLoop / stopExecution.
          const sessionId = await getSessionForTab(tabId)
          if (!sessionId) return { ok: false, error: 'no session' }
          await this.requireClient().request(Methods.iterationLimitResponse, { sessionId, approved: msg.approved })
          return { ok: true }
        }

        default:
          return { ok: false, error: `unknown request: ${(msg as { type: string }).type}` }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── service → panel ───────────────────────────────────────────────

  /** Fold one session event into the mirror, then push it to the owning tab. */
  onAgentEvent(sessionId: string, data: AgentEventData): void {
    const state = this.mirrors.get(sessionId) ?? freshSessionState()
    this.mirrors.set(sessionId, state)
    applySessionEvent(state, data)
    void this.deliverToSession(sessionId, { type: 'panel/event', sessionId, data })
  }

  /** Connection changed: everyone showing it should say so. */
  onConnectionChange(connection: ConnectionState): void {
    this.broadcast('panel/connection', connection)
  }

  /** A tab went away: drop its binding (the session row itself stays). */
  async onTabClosed(tabId: number): Promise<void> {
    await clearTab(tabId)
    await setPanelOpen(tabId, false)
  }

  /** Exposed for the worker's own status surface (options page). */
  mirrorState(sessionId: string): SessionState | undefined {
    return this.mirrors.get(sessionId)
  }

  // ── internals ─────────────────────────────────────────────────────

  private requireClient(): WsClient {
    const client = this.deps.getClient()
    if (!client?.connected) throw new Error('未连接桌面端')
    return client
  }

  private async createSession(
    client: WsClient,
    sessionId: string | null,
    pageContext: PageContext | undefined,
  ): Promise<SessionCreateResult> {
    // The service answers with the id it actually used: a stale id falls back to
    // a fresh session, so the caller must always store the *returned* id.
    return (await client.request(Methods.sessionCreate, {
      ...(sessionId ? { sessionId } : {}),
      ...(pageContext ? { pageContext } : {}),
      ...(pageContext?.title ? { title: pageContext.title } : {}),
    })) as SessionCreateResult
  }

  /** The tab's session, created (or resumed) if the tab has none yet. */
  async ensureSession(tabId: number, pageContext?: PageContext): Promise<string> {
    const existing = await getSessionForTab(tabId)
    const created = await this.createSession(this.requireClient(), existing, pageContext)
    if (created.sessionId !== existing) {
      if (!this.mirrors.has(created.sessionId)) this.mirrors.set(created.sessionId, freshSessionState())
      await bindTabSession(tabId, created.sessionId)
      await this.applyTabApprovalMode(tabId, created.sessionId)
      await this.applyTabModelId(tabId, created.sessionId)
      this.broadcast('panel/sessions', await this.listSessions(this.requireClient()).catch(() => []))
    }
    return created.sessionId
  }

  /** Carry a pre-session 授权 choice onto the session that just appeared, then
   *  consume it: the value exists only to bridge the gap before the column,
   *  and surviving the carry it would resurface onto every later session this
   *  tab creates from scratch (a pick from sessions ago silently pinning a
   *  fresh conversation). Kept on a failed carry — the next message retries. */
  private async applyTabApprovalMode(tabId: number, sessionId: string): Promise<void> {
    const mode = await getTabApprovalMode(tabId)
    if (!mode) return
    try {
      await this.requireClient().request(Methods.sessionSetApprovalMode, { sessionId, mode })
      await clearTabApprovalMode(tabId)
    } catch {
      /* the next message re-reads the stored mode anyway */
    }
  }

  /** Carry a pre-session 模型 choice onto the session that just appeared —
   *  same contract as the 授权 carry above: consumed on success, kept on
   *  failure. */
  private async applyTabModelId(tabId: number, sessionId: string): Promise<void> {
    const profileId = await getTabModelId(tabId)
    if (!profileId) return
    try {
      await this.requireClient().request(Methods.modelSetActive, { sessionId, profileId })
      await clearTabModelId(tabId)
    } catch {
      /* the label re-reads the stored model on the next snapshot anyway */
    }
  }

  /** `session.list` answers with the model state riding along, so the two things
   *  a mounting panel needs come back in one round trip. */
  private async inventory(client: WsClient): Promise<{ sessions: SessionSummary[]; model?: ModelState }> {
    const res = (await client.request(Methods.sessionList, { limit: 50 })) as SessionListResult
    return { sessions: res.sessions ?? [], model: res.model }
  }

  private async listSessions(client: WsClient): Promise<SessionSummary[]> {
    return (await this.inventory(client)).sessions
  }

  /** Full state for a (re)mounting panel: binding + history + known status. */
  async snapshot(tabId: number): Promise<PanelSnapshot> {
    let sessionId = await getSessionForTab(tabId)
    const connection = this.deps.getConnection()
    const panelOpen = await isPanelOpen(tabId)
    const client = this.deps.getClient()!
    const inventory = connection.connected
      ? await this.inventory(client).catch(() => ({ sessions: [] as SessionSummary[], model: undefined }))
      : { sessions: [] as SessionSummary[], model: undefined }
    const sessions = inventory.sessions
    if (!sessionId) {
      // No session yet: the picker shows the global default, overridden by a
      // pre-session 模型 choice still waiting to be carried onto the
      // conversation the first message creates (same shape as the 授权 line).
      const pendingModelId = await getTabModelId(tabId)
      return {
        sessionId: null,
        connection,
        panelOpen,
        messages: [],
        streamingBlocks: [],
        status: 'idle',
        sessions,
        model: pendingModelId && inventory.model
          ? { ...inventory.model, activeId: pendingModelId }
          : inventory.model,
        approvalMode: (await getTabApprovalMode(tabId)) ?? undefined,
      }
    }
    let state = this.mirrors.get(sessionId)
    if (!state) {
      state = freshSessionState()
      this.mirrors.set(sessionId, state)
      if (connection.connected) {
        // First attach in this worker's life (cold start, page reload, desktop
        // restart): the service may not hold this session yet, so resume it
        // before asking for history — `agent.history` alone would answer from a
        // freshly created, empty engine. A stale id comes back as a new one.
        const resumedId = await this.ensureSession(tabId).catch(() => null)
        sessionId = resumedId ?? sessionId
        state = this.mirrors.get(sessionId) ?? state
        const client = this.deps.getClient()
        if (client) {
          try {
            const history = (await client.request(Methods.agentHistory, { sessionId })) as AgentHistoryResult
            state.messages = history.messages as SessionState['messages']
          } catch {
            /* session not created service-side yet — the first ask creates it */
          }
        }
      }
    }
    // The picker renders the session's OWN model (its conversation's choice,
    // under the create-time pin); the global default is only the fallback for
    // a service that does not know the session yet.
    const model = connection.connected && sessionId
      ? ((await client.request(Methods.modelList, { sessionId }).catch(() => undefined)) as ModelState | undefined) ?? inventory.model
      : inventory.model
    return {
      sessionId,
      connection,
      panelOpen,
      messages: state.messages,
      streamingBlocks: state.streamingBlocks,
      status: state.agentStatus.status,
      // The same pair the event stream carries: a panel that attaches while the
      // session sits in `error` (worker restart, panel re-opened) has no other
      // carrier for the reason and would show 未知错误.
      statusError: 'error' in state.agentStatus ? state.agentStatus.error : undefined,
      sessions,
      model,
      // The desktop's stored mode wins (the tab value is only a pre-session
      // carry-over, and applyTabApprovalMode pushed it into the same column).
      approvalMode: sessions.find((s) => s.sessionId === sessionId)?.approvalMode ?? (await getTabApprovalMode(tabId)) ?? undefined,
    }
  }

  /** True while the session has work in flight (used by the keepalive path). */
  isBusy(sessionId: string): boolean {
    const state = this.mirrors.get(sessionId)
    return !!state && isActiveStatus(state.agentStatus)
  }

  private async deliverToSession(sessionId: string, msg: unknown): Promise<void> {
    const tabId = await getTabForSession(sessionId)
    if (tabId === null || !(await isPanelOpen(tabId))) return
    try {
      await chrome.tabs.sendMessage(tabId, msg)
    } catch {
      // No content script on that tab (chrome:// pages, unloaded tab) — the
      // transcript is persisted service-side, so nothing is lost.
    }
  }

  private broadcast(type: 'panel/connection' | 'panel/sessions', payload: unknown): void {
    void chrome.tabs.query({}).then(async (tabs) => {
      for (const tab of tabs) {
        if (tab.id === undefined || !(await isPanelOpen(tab.id))) continue
        try {
          await chrome.tabs.sendMessage(tab.id, { type, payload })
        } catch {
          /* tab without a content script */
        }
      }
    })
  }

  private pushEvent(tabId: number, sessionId: string, data: AgentEventData): void {
    // Fold + deliver exactly once (onAgentEvent routes by session→tab, which is
    // not the same tab here — this is a failed ask reported to its requester).
    const state = this.mirrors.get(sessionId) ?? freshSessionState()
    this.mirrors.set(sessionId, state)
    applySessionEvent(state, data)
    void chrome.tabs.sendMessage(tabId, { type: 'panel/event', sessionId, data }).catch(() => {})
  }
}
