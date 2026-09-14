/**
 * Client registry (PLAN-browser-extension M0.1): sessionId → the connection
 * currently driving that session's agent loop. A binding lives for exactly one
 * `agent.ask` round-trip: the WS server binds it when the ask lands and unbinds
 * when the loop settles, so reverse traffic (tool.call / approval.request /
 * ask_user.request) always reaches the client that is actually waiting — never
 * a stale or unrelated connection (multi-tab / multi-profile safe).
 */
import type { AskUserRequestParams, ApprovalRequestParams, ToolCallParams } from '../../shared/agent-protocol'

/** Client ids allowed to execute hosted (reverse-RPC) tools. `anywhere-extension`
 *  is accepted for protocol compatibility with the Anywhere extension (0.3.5 M4.1). */
export const HOSTED_CLIENT_IDS = new Set(['pulsemind-extension', 'anywhere-extension'])

export function isHostedClientId(clientId: string): boolean {
  return HOSTED_CLIENT_IDS.has(clientId)
}

export interface ClientTransport {
  /** Stable per-connection id: in-flight hosted calls correlate back to their
   *  socket when the connection drops. */
  readonly id: string
  readonly clientId: string
  sendToolCall(params: ToolCallParams): void
  sendApprovalRequest(params: ApprovalRequestParams): void
  sendAskUserRequest(params: AskUserRequestParams): void
}

class ClientRegistry {
  private bySession = new Map<string, ClientTransport>()

  bind(sessionId: string, transport: ClientTransport): void {
    this.bySession.set(sessionId, transport)
  }

  /** Remove the binding only if it is still this transport's — a newer ask from
   *  another connection must not be unbound by the older one settling late. */
  unbind(sessionId: string, transport: ClientTransport): void {
    if (this.bySession.get(sessionId) === transport) this.bySession.delete(sessionId)
  }

  get(sessionId: string): ClientTransport | undefined {
    return this.bySession.get(sessionId)
  }

  /** True when the session's bound client can execute hosted page tools — the
   *  gate behind "page_* tools exist only while the extension is online" (M2.4). */
  isHostedCapable(sessionId: string): boolean {
    const transport = this.bySession.get(sessionId)
    return !!transport && isHostedClientId(transport.clientId)
  }
}

export const agentClientRegistry = new ClientRegistry()
