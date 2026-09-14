/**
 * Hosted prompt router (PLAN-browser-extension M0.2 / M3.1): watches session
 * status events and routes the engine's "the user must decide" moments to the
 * client that is actually driving the loop:
 *
 *   awaiting_approval   → approval.request  (per held tool, callId = toolUseId)
 *   awaiting_user_input → ask_user.request  (the ask_user tool's question)
 *
 * The desktop UI is untouched: it keeps reading the same status events, and
 * sessions without a hosted client bound never enter this router. Timeouts
 * follow the "silence means no" rule — an unanswered approval is rejected, an
 * unanswered question is answered with a timeout note so the loop continues.
 */
import type {
  AgentEventData,
  ApprovalKind,
  ApprovalResponseParams,
  AskUserResponseParams,
  IterationLimitResponseParams,
  StatusToolInfo,
} from '../../../shared/agent-protocol'
import { agentClientRegistry, isHostedClientId, type ClientTransport } from '../client-registry'
import type { AgentServiceSessions } from '../service-sessions'
import { auditStore } from '../../storage/audit-store'

const APPROVAL_TIMEOUT_MS = 120_000
const ASK_USER_TIMEOUT_MS = 300_000

interface PendingPrompt {
  sessionId: string
  transport: ClientTransport
  toolUseId: string
  timer: NodeJS.Timeout
}

const KIND_BY_TOOL: Partial<Record<string, ApprovalKind>> = {
  write: 'write',
  edit: 'write',
  exec: 'shell',
}

function approvalKindFor(toolName: string): ApprovalKind {
  const known = KIND_BY_TOOL[toolName]
  if (known) return known
  if (toolName === 'page_execute_js') return 'page_exec'
  if (toolName.startsWith('page_')) return 'browser_write'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'shell'
}

class HostedPromptRouter {
  private sessions: AgentServiceSessions | null = null
  private unsubscribe: (() => void) | null = null
  /** callId (= toolUseId) → in-flight confirmation. */
  private approvals = new Map<string, PendingPrompt>()
  private asks = new Map<string, PendingPrompt>()

  /** Wire to the effective session manager (startAgentService owns the lifetime). */
  attach(sessions: AgentServiceSessions): void {
    this.detach()
    this.sessions = sessions
    this.unsubscribe = sessions.onEvent((sessionId, data) => this.onEvent(sessionId, data))
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.sessions = null
    for (const entry of this.approvals.values()) clearTimeout(entry.timer)
    for (const entry of this.asks.values()) clearTimeout(entry.timer)
    this.approvals.clear()
    this.asks.clear()
  }

  handleApprovalResponse(params: ApprovalResponseParams): void {
    const entry = this.approvals.get(params.callId)
    if (!entry) return
    this.clear('approvals', params.callId)
    this.engineCall(entry.sessionId, params.approved ? 'approveTool' : 'rejectTool', [entry.toolUseId])
  }

  handleAskUserResponse(params: AskUserResponseParams): void {
    const entry = this.asks.get(params.callId)
    if (!entry) return
    this.clear('asks', params.callId)
    this.engineCall(entry.sessionId, 'respondToTool', [entry.toolUseId, String(params.response ?? '')])
  }

  /** Loop-limit decision from the panel: continue extends the loop, anything
   *  else stops it. No pending state — the status event itself is the prompt. */
  handleIterationLimit(params: IterationLimitResponseParams): void {
    this.engineCall(params.sessionId, params.approved ? 'extendLoop' : 'stopExecution', [])
  }

  /** Connection died: its pending confirmations can never be answered — settle
   *  them now (reject approvals, answer asks with a timeout note). */
  dropTransport(transport: ClientTransport): void {
    for (const [callId, entry] of this.approvals) {
      if (entry.transport !== transport) continue
      this.clear('approvals', callId)
      this.engineCall(entry.sessionId, 'rejectTool', [entry.toolUseId])
    }
    for (const [callId, entry] of this.asks) {
      if (entry.transport !== transport) continue
      this.clear('asks', callId)
      this.engineCall(entry.sessionId, 'respondToTool', [entry.toolUseId, '（浏览器连接已断开，未能回答）'])
    }
  }

  pendingCounts(): { approvals: number; asks: number } {
    return { approvals: this.approvals.size, asks: this.asks.size }
  }

  private onEvent(sessionId: string, data: AgentEventData): void {
    if (data.type !== 'status') return
    if (data.status === 'awaiting_approval' && data.tools?.length) this.routeApprovals(sessionId, data.tools)
    else if (data.status === 'awaiting_user_input' && data.tools?.length) this.routeAskUser(sessionId, data.tools)
  }

  /** Only hosted clients get prompts routed: the desktop UI confirms its own
   *  sessions by reading status events directly. */
  private routeApprovals(sessionId: string, tools: StatusToolInfo[]): void {
    const transport = agentClientRegistry.get(sessionId)
    if (!transport || !isHostedClientId(transport.clientId)) return
    for (const tool of tools) {
      if (this.approvals.has(tool.toolUseId)) continue // already prompted (re-emit guard)
      const entry: PendingPrompt = {
        sessionId,
        transport,
        toolUseId: tool.toolUseId,
        timer: setTimeout(() => {
          if (this.approvals.delete(tool.toolUseId)) {
            this.audit(transport.clientId, sessionId, tool.name, 'timeout')
            this.engineCall(sessionId, 'rejectTool', [tool.toolUseId])
          }
        }, APPROVAL_TIMEOUT_MS),
      }
      this.approvals.set(tool.toolUseId, entry)
      this.audit(transport.clientId, sessionId, tool.name, 'requested')
      transport.sendApprovalRequest({
        sessionId,
        callId: tool.toolUseId,
        kind: approvalKindFor(tool.name),
        summary: tool.detail ? `${tool.name} — ${tool.detail}` : tool.name,
      })
    }
  }

  private routeAskUser(sessionId: string, tools: StatusToolInfo[]): void {
    const transport = agentClientRegistry.get(sessionId)
    if (!transport || !isHostedClientId(transport.clientId)) return
    const tool = tools.find((t) => t.name === 'ask_user')
    if (!tool || this.asks.has(tool.toolUseId)) return
    const question = (tool.args as { prompt?: string } | undefined)?.prompt ?? tool.detail ?? '请选择'
    const entry: PendingPrompt = {
      sessionId,
      transport,
      toolUseId: tool.toolUseId,
      timer: setTimeout(() => {
        if (this.asks.delete(tool.toolUseId)) {
          this.engineCall(sessionId, 'respondToTool', [tool.toolUseId, '（超时未回答，请继续或换个方式）'])
        }
      }, ASK_USER_TIMEOUT_MS),
    }
    this.asks.set(tool.toolUseId, entry)
    transport.sendAskUserRequest({ sessionId, callId: tool.toolUseId, question })
  }

  private clear(kind: 'approvals' | 'asks', callId: string): void {
    const map = kind === 'approvals' ? this.approvals : this.asks
    const entry = map.get(callId)
    if (entry) clearTimeout(entry.timer)
    map.delete(callId)
  }

  private engineCall(sessionId: string, method: string, args: unknown[]): void {
    this.sessions?.engineCall(sessionId, method, args).catch((err) => {
      console.warn(`[HostedPrompts] engineCall(${method}) failed:`, err instanceof Error ? err.message : err)
    })
  }

  private audit(actor: string | undefined, sessionId: string, tool: string, decision: string): void {
    try {
      auditStore.record({ scope: 'hosted-approval', actor, action: tool, target: sessionId, decision })
    } catch { /* best-effort */ }
  }
}

export const hostedPromptRouter = new HostedPromptRouter()
