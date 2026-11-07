/** Panel ↔ service-worker routing (PLAN-browser-extension M1.3/M1.4).
 *
 * Owns everything that happens between the in-page panel and the desktop
 * service: tab↔session binding, session lifecycle (create/resume/list/delete/
 * rename), asking, and pushing `agent.event` to the tab that owns the session.
 *
 * The worker itself is assembly only (index.ts); all of this lives here so the
 * message surface has one home and is testable with a fake client. */

import { applySessionEvent, freshSessionState, isActiveStatus, seedSessionState, type SessionState } from '../../shared/agent-session/mirror'
import { Methods } from '../../shared/agent-protocol/methods'
import type {
  AgentEventData,
  AgentHistoryResult,
  AgentSnapshotResult,
  ModelState,
  PageContext,
  SessionCreateResult,
  SessionListResult,
} from '../../shared/agent-protocol'
import type { WsClient } from './ws-client'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import type { ConnectionState, PanelRequest, PanelResponse, PanelSnapshot, SessionSummary } from '../bridge'
import {
  bindTabSession,
  clearSession,
  clearTab,
  clearTabApprovalMode,
  clearTabModelId,
  getLiveTabScopes,
  getSessionForTab,
  getTabApprovalMode,
  getTabForSession,
  getTabModelId,
  getTabScope,
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
  /** The stored 授权 level per session, as last seen by this worker — seeded by
   *  the cold `agent.snapshot`, written through on every set (the panel's own
   *  click and the pre-session carry), dropped on delete. It exists because
   *  `session.list` lists only conversations WITH messages (2026-11-02): a
   *  fresh session whose 授权 was picked before its first message is not on
   *  that list, and the snapshot used to read the level off it — so the footer
   *  would have fallen back to the default right after the click, and after
   *  any reload, while the column held the real choice. Resolution order in
   *  snapshot(): the list row (the freshest read of the column) → this cache
   *  → the tab's pre-session carry. */
  private approvalModes = new Map<string, SandboxApprovalMode>()

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
          const created = await this.createSession(client, tabId, null, undefined)
          await clearTab(tabId)
          await bindTabSession(tabId, created.sessionId)
          this.mirrors.set(created.sessionId, freshSessionState())
          // Pre-session 授权/模型 choices ride onto the fresh conversation too —
          // the same carry the first ask performs, so where the choice lands
          // does not depend on whether the user sends or hits 新会话 first.
          await this.applyTabApprovalMode(tabId, created.sessionId)
          await this.applyTabModelId(tabId, created.sessionId)
          const summary = await this.listSessions(client, tabId)
          this.sendSessionsTo(tabId, summary)
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/resume-session': {
          const client = this.deps.getClient()
          if (!client?.connected) return { ok: false, error: '未连接桌面端' }
          // Validate BEFORE clearTab: a malformed row (the 2026-11-02 `id` vs
          // `sessionId` wire mismatch sent `undefined` here) must not unbind the
          // tab on its way to failing — that turned a broken click into "this
          // panel now has no conversation", which reads as the menu doing
          // nothing.
          if (!msg.sessionId) return { ok: false, error: '缺少会话 id' }
          await clearTab(tabId)
          await bindTabSession(tabId, msg.sessionId)
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/list-sessions':
          return { ok: true, data: await this.listSessions(this.requireClient(), tabId) }

        case 'panel/delete-session': {
          const client = this.requireClient()
          await client.request(Methods.sessionDelete, { sessionId: msg.sessionId })
          this.mirrors.delete(msg.sessionId)
          this.approvalModes.delete(msg.sessionId)
          await clearSession(msg.sessionId)
          this.sendSessionsTo(tabId, await this.listSessions(client, tabId).catch(() => []))
          return { ok: true, snapshot: await this.snapshot(tabId) }
        }

        case 'panel/rename-session': {
          await this.requireClient().request(Methods.sessionRename, { sessionId: msg.sessionId, title: msg.title })
          this.sendSessionsTo(tabId, await this.listSessions(this.requireClient(), tabId))
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
            this.approvalModes.set(sessionId, msg.mode)
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
    tabId: number,
    sessionId: string | null,
    pageContext: PageContext | undefined,
  ): Promise<SessionCreateResult> {
    // The service answers with the id it actually used: a stale id falls back to
    // a fresh session, so the caller must always store the *returned* id.
    const created = (await client.request(Methods.sessionCreate, {
      ...(sessionId ? { sessionId } : {}),
      ...(pageContext ? { pageContext } : {}),
      ...(pageContext?.title ? { title: pageContext.title } : {}),
      // The tab's 历史会话 scope (2026-11-03): stamped on the conversation row so
      // `session.list` can hand this tab its own list back after a refresh or
      // navigation, and never another tab's. Sent on EVERY create — a resume
      // included, so a session resumed by a tab that did not mint it (a worker
      // restart re-issuing create) keeps its scope instead of dropping to
      // unscoped.
      tabKey: await getTabScope(tabId),
    })) as SessionCreateResult
    // Seed the cache with the level the service settled on (review_20261103 高3):
    // doCreateSession plants the global last-used value on every unconfigured
    // fresh session, and that session reaches neither session.list (no messages
    // yet) nor the cold snapshot (the caller already holds the mirror) — so
    // without this the footer showed the default while the engine ran, say,
    // last-used `auto`. Covers BOTH mint points (panel/new-session and
    // ensureSession) in one place; an explicit pre-session carry still wins —
    // applyTabApprovalMode runs after this and writes over the cache.
    if (created.approvalMode) this.approvalModes.set(created.sessionId, created.approvalMode)
    return created
  }

  /** The tab's session, created (or resumed) if the tab has none yet. */
  async ensureSession(tabId: number, pageContext?: PageContext): Promise<string> {
    const existing = await getSessionForTab(tabId)
    const created = await this.createSession(this.requireClient(), tabId, existing, pageContext)
    if (created.sessionId !== existing) {
      if (!this.mirrors.has(created.sessionId)) this.mirrors.set(created.sessionId, freshSessionState())
      await bindTabSession(tabId, created.sessionId)
      await this.applyTabApprovalMode(tabId, created.sessionId)
      await this.applyTabModelId(tabId, created.sessionId)
      this.sendSessionsTo(tabId, await this.listSessions(this.requireClient(), tabId).catch(() => []))
    }
    return created.sessionId
  }

  /** Carry a pre-session 授权 choice onto the session that just appeared, then
   *  consume it: the value exists only to bridge the gap before the column,
   *  and surviving the carry it would resurface onto every later session this
   *  tab creates from scratch (a pick from sessions ago silently pinning a
   *  fresh conversation). Consumed even when the carry FAILS (review
   *  20261009 中5): ensureSession applies only while the session id moves, so
   *  "kept for a retry" meant "kept forever" — this session silently lost the
   *  choice AND the dormant value later pinned the tab's next fresh session.
   *  A failure here is deterministic in practice (the RPC runs right after a
   *  successful sessionCreate — say the picked profile was deleted
   *  desktop-side); the picker re-renders from the session's real state. */
  private async applyTabApprovalMode(tabId: number, sessionId: string): Promise<void> {
    const mode = await getTabApprovalMode(tabId)
    if (!mode) return
    try {
      await this.requireClient().request(Methods.sessionSetApprovalMode, { sessionId, mode })
      this.approvalModes.set(sessionId, mode)
    } catch {
      /* best effort — the choice is dropped either way, the snapshot shows the session's real mode */
    }
    await clearTabApprovalMode(tabId)
  }

  /** Carry a pre-session 模型 choice onto the session that just appeared —
   *  same contract as the 授权 carry above: consumed on every path, success
   *  or failure (review 20261009 中5 — keeping it on failure only ever
   *  delivered it to the WRONG, later session). */
  private async applyTabModelId(tabId: number, sessionId: string): Promise<void> {
    const profileId = await getTabModelId(tabId)
    if (!profileId) return
    try {
      await this.requireClient().request(Methods.modelSetActive, { sessionId, profileId })
    } catch {
      /* best effort — the label re-reads the session's real model on the next snapshot */
    }
    await clearTabModelId(tabId)
  }

  /** `session.list` answers with the model state riding along, so the two things
   *  a mounting panel needs come back in one round trip. Scoped to the tab
   *  (2026-11-03): 历史会话 belongs to this tab — refresh/navigation keeps it,
   *  a sibling tab's conversations never appear here. */
  private async inventory(client: WsClient, tabId: number): Promise<{ sessions: SessionSummary[]; model?: ModelState }> {
    const res = (await client.request(Methods.sessionList, {
      limit: 50,
      tabKey: await getTabScope(tabId),
      // The live scope set (review_20261104 中3): scopes from previous browser
      // sessions died with chrome.storage.session — the service releases their
      // stamps so the adoption below reclaims the history for this tab.
      liveScopes: await getLiveTabScopes(),
    })) as SessionListResult
    return { sessions: res.sessions ?? [], model: res.model }
  }

  private async listSessions(client: WsClient, tabId: number): Promise<SessionSummary[]> {
    return (await this.inventory(client, tabId)).sessions
  }

  /** Full state for a (re)mounting panel: binding + history + known status. */
  async snapshot(tabId: number): Promise<PanelSnapshot> {
    let sessionId = await getSessionForTab(tabId)
    const connection = this.deps.getConnection()
    const panelOpen = await isPanelOpen(tabId)
    const client = this.deps.getClient()!
    const inventory = connection.connected
      ? await this.inventory(client, tabId).catch(() => ({ sessions: [] as SessionSummary[], model: undefined }))
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
        // before asking for history — a snapshot request alone would answer
        // sessionNotFound from a freshly created, empty engine. A stale id
        // comes back as a new one.
        const resumedId = await this.ensureSession(tabId).catch(() => null)
        sessionId = resumedId ?? sessionId
        state = this.mirrors.get(sessionId) ?? state
        const client = this.deps.getClient()
        if (client) {
          try {
            // The full still-life (2026-10-31): plan + ledger + last compaction
            // + the retry carriers, which agent.history never carried. An older
            // desktop rejects the unknown method → the history fallback below
            // keeps the old (message-only, status-blind) behavior.
            const snap = (await client.request(Methods.agentSnapshot, { sessionId })) as AgentSnapshotResult
            seedSessionState(state, snap)
            // The stored 授权 rides the still-life now (an older service omits
            // it → the list/tab fallbacks below). Seeded here, before the
            // snapshot resolves the footer's value a few lines down.
            if (snap.approvalMode) this.approvalModes.set(sessionId, snap.approvalMode)
          } catch {
            try {
              const history = (await client.request(Methods.agentHistory, { sessionId })) as AgentHistoryResult
              state.messages = history.messages as SessionState['messages']
            } catch {
              /* session not created service-side yet — the first ask creates it */
            }
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
      // Retry carriers (2026-10-31): present only mid-backoff, exactly like the
      // live status event — an honest absence, the banner hides its (n/max).
      attempt: 'attempt' in state.agentStatus ? state.agentStatus.attempt : undefined,
      maxRetries: 'maxRetries' in state.agentStatus ? state.agentStatus.maxRetries : undefined,
      delayMs: 'delay' in state.agentStatus ? state.agentStatus.delay : undefined,
      // The three folded states' still-life (2026-10-31): undefined (not []) on
      // the history fallback so the panel can tell "older service" apart from
      // "known empty".
      plan: state.plan ?? undefined,
      fileChanges: state.fileChanges.length > 0 ? state.fileChanges : undefined,
      lastCompaction: state.lastCompaction ?? undefined,
      sessions,
      model,
      // The desktop's stored mode wins (the tab value is only a pre-session
      // carry-over, and applyTabApprovalMode pushed it into the same column).
      // The list row is the freshest read of that column, so it goes first;
      // the cache covers the session the list no longer carries — one without
      // messages yet (see `approvalModes`) — before the tab's pre-session carry.
      approvalMode:
        sessions.find((s) => s.sessionId === sessionId)?.approvalMode ??
        this.approvalModes.get(sessionId) ??
        (await getTabApprovalMode(tabId)) ??
        undefined,
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

  /** Connection state is global, so it is the one thing still broadcast to
   *  every open panel. */
  private broadcast(type: 'panel/connection', payload: unknown): void {
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

  /** Session lists are tab-scoped data (2026-11-03 的 scope；review_20261104
   *  高1): every refresh point computes the REQUESTING tab's list, so it may
   *  only be delivered to that tab. The old broadcast replaced every open
   *  panel's 历史会话 menu with one tab's rows — a sibling could then resume a
   *  row it was never shown, binding the session away from its owner (whose
   *  live transcript silently froze) and COALESCE-restamping the row's
   *  tab_key into the resuming tab's scope for good. */
  private sendSessionsTo(tabId: number, sessions: SessionSummary[]): void {
    void chrome.tabs.sendMessage(tabId, { type: 'panel/sessions', payload: sessions }).catch(() => {
      /* tab without a content script */
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
