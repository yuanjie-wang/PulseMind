/** The slice of the main agent session manager that the WS server and the
 *  hosted prompt router drive (PLAN-browser-extension M0). Declared as an
 *  interface so protocol tests can inject a fake without touching real
 *  settings, SQLite or LLM profiles — `agentSessionManager` satisfies it
 *  structurally. */
import type { AgentEventData, PageContext, ModelState, AgentSnapshotResult } from '../../shared/agent-protocol'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'

export interface AgentServiceSessions {
  /** `tabKey` is the client's history scope, stamped on the conversation row
   *  (the extension's per-tab 历史会话 list, 2026-11-03). */
  createSession(
    sessionId: string,
    opts: {
      agentId?: string
      title?: string
      clientId?: string
      tabKey?: string
      /** Create-time tool whitelist (the hosted page-tool posture): ws-server
       *  pins every extension-driven session to `PAGE_SESSION_ALLOWED_TOOLS`
       *  — the desktop toolset must not ride along into a conversation that
       *  happens inside a web page (page-tools.ts §3.4.1). */
      allowedTools?: string[]
    },
  ): Promise<{ sessionId: string; agentId: string }>
  ask(sessionId: string, content: string, pageContext?: PageContext): Promise<void>
  cancel(sessionId: string): void
  history(sessionId: string): Promise<{ messages: unknown[]; agentId: string }>
  /** agent.snapshot: the re-attach still-life (2026-10-31) — history() only
   *  answers with messages, this carries the status carriers + plan + ledger +
   *  last compaction too. Null when the service does not hold the session. */
  snapshot(sessionId: string): Promise<AgentSnapshotResult | null>
  hasSession(sessionId: string): boolean
  hydrate(sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null): Promise<void>
  engineCall(sessionId: string, method: string, args?: unknown[]): Promise<unknown>
  onEvent(sink: (sessionId: string, data: AgentEventData) => void): () => void
  /** model.list: the selectable LLM profiles + the active one — the session's
   *  own model when `sessionId` is given, the global default otherwise. */
  modelState(sessionId?: string): Promise<ModelState>
  /** model.setActive without a session: switch the DEFAULT profile
   *  (hot-swaps the live sessions that follow it). */
  setActiveProfile(profileId: string): Promise<ModelState>
  /** model.setActive with a session: pin (profileId) or unpin (null → the
   *  conversation follows the global default again) THAT conversation's model
   *  and hot-apply it. Answers with the model actually in force for the
   *  session afterwards — a create-time pin (a routine's model) outranks the
   *  column, so the caller reconciles against this answer. */
  setSessionProfile(sessionId: string, profileId: string | null): Promise<ModelState>
  /** session.setApprovalMode: write the conversation's 授权 level (the remote
   *  授权 button) and hot-apply it to the live session. Answers with the level
   *  actually in force for the session afterwards — a pinned unattended run
   *  keeps its own, so the caller must reconcile against this answer rather
   *  than against what it asked for. */
  setApprovalMode(sessionId: string, mode: SandboxApprovalMode): Promise<SandboxApprovalMode>
  /** session.handoff 的随件（可选，fake 免实现）：解除该会话的 create-time
   *  工具白名单——移交桌面后续聊必须拿回完整桌面工具集。 */
  releaseToolWhitelist?(sessionId: string): void
}
