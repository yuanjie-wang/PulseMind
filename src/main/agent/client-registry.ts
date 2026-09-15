/**
 * Client registry (PLAN-browser-extension M0.1): sessionId → the connection
 * driving that session's agent loop, so reverse traffic (tool.call /
 * approval.request / ask_user.request) reaches the client that is actually
 * waiting — never a stale or unrelated connection (multi-tab safe).
 *
 * The binding lives as long as the *connection*, not as long as one `agent.ask`
 * RPC. The engine parks on the client (awaiting_approval / awaiting_user_input)
 * and the loop promise settles right there, so `ask` resolves seconds before a
 * prompt is emitted: an ask-scoped binding would be released at exactly the
 * moment the card has to be delivered, and every answer would be dropped
 * silently. Released when the connection drops (`unbindTransport`) or when a
 * newer client asks for the same session (`bind` overwrites).
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

  /** Connection gone: release every session it was driving. Matching by
   *  transport identity leaves a newer connection's binding intact even when
   *  this one is torn down late (same-clientId replacement). */
  unbindTransport(transport: ClientTransport): void {
    for (const [sessionId, bound] of this.bySession) {
      if (bound === transport) this.bySession.delete(sessionId)
    }
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
