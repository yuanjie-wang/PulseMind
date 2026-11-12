/**
 * Hosted tool proxy (PLAN-browser-extension M0.2): the service→client half of
 * the reverse RPC. The engine executes a `page_*` tool in the main process; we
 * hand it to the client over `tool.call` and park a promise keyed by callId
 * until the client's `tool.result` (or a timeout / disconnect) settles it.
 * Rules lifted from Anywhere §7.4: per-tool budgets, late/unknown results are
 * dropped as orphans (audited, never reject a stranger's promise), and a dead
 * connection settles all of its in-flight calls immediately.
 */
import { randomUUID } from 'node:crypto'
import type { ToolCallParams, ToolCallResultParams } from '../../../shared/agent-protocol'
import type { ClientTransport } from '../client-registry'
import { auditStore } from '../../storage/audit-store'

/** Wall-clock budgets per hosted tool. The same value rides inside `tool.call`
 *  so the client can race its own side; the proxy enforces it authoritatively. */
export const HOSTED_TOOL_TIMEOUT_MS: Record<string, number> = {
  page_get_content: 20_000,
  page_scroll: 10_000,
  page_wait: 15_000,
  page_click: 10_000,
  page_input: 10_000,
  page_select: 10_000,
  page_navigate: 15_000,
  page_back: 10_000,
  page_execute_js: 30_000,
}
export const HOSTED_DEFAULT_TIMEOUT_MS = 20_000

interface PendingCall {
  transport: ClientTransport
  sessionId: string
  tool: string
  timer: NodeJS.Timeout
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

class HostedToolProxy {
  private pending = new Map<string, PendingCall>()

  /** Hand a tool call to the session's bound client and wait for the result.
   *  Rejects (never throws into the loop) with an actionable message — the
   *  engine turns rejections into `is_error` tool results. */
  call(
    transport: ClientTransport | undefined,
    sessionId: string,
    tool: string,
    args: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (!transport) {
      return Promise.reject(new Error('当前会话没有连接的浏览器客户端，无法执行页面工具'))
    }
    const budget = timeoutMs ?? HOSTED_TOOL_TIMEOUT_MS[tool] ?? HOSTED_DEFAULT_TIMEOUT_MS
    const callId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(callId)) {
          this.audit(transport.clientId, sessionId, tool, 'timeout')
          reject(new Error(`页面工具 ${tool} 超时（${budget}ms）——浏览器端无响应，请重试或改用其他方式`))
        }
      }, budget)
      this.pending.set(callId, { transport, sessionId, tool, timer, resolve, reject })
      const params: ToolCallParams = { callId, sessionId, tool, args, timeoutMs: budget }
      transport.sendToolCall(params)
    })
  }

  /** Correlate a `tool.result`. Returns true when it settled a pending call;
   *  unknown or late callIds are orphans — dropped and audited. */
  handleResult(params: ToolCallResultParams): boolean {
    const entry = this.pending.get(params.callId)
    if (!entry) {
      this.audit(undefined, undefined, 'unknown', 'orphan', params.callId)
      return false
    }
    this.pending.delete(params.callId)
    clearTimeout(entry.timer)
    if (params.ok) {
      this.audit(entry.transport.clientId, entry.sessionId, entry.tool, 'ok')
      entry.resolve(params.result)
    } else {
      this.audit(entry.transport.clientId, entry.sessionId, entry.tool, 'error')
      entry.reject(new Error(params.error || `页面工具 ${entry.tool} 执行失败`))
    }
    return true
  }

  /** The connection died: settle every in-flight call bound to it so no engine
   *  loop stays parked on a socket that will never answer. */
  dropTransport(transport: ClientTransport, reason = '浏览器客户端连接已断开'): void {
    for (const [callId, entry] of this.pending) {
      if (entry.transport !== transport) continue
      this.pending.delete(callId)
      clearTimeout(entry.timer)
      this.audit(entry.transport.clientId, entry.sessionId, entry.tool, 'dropped')
      entry.reject(new Error(reason))
    }
  }

  pendingCount(): number {
    return this.pending.size
  }

  private audit(actor: string | undefined, sessionId: string | undefined, tool: string, decision: string, callId?: string): void {
    try {
      auditStore.record({
        scope: 'hosted-tool',
        actor,
        action: `tool:${tool}`,
        target: sessionId,
        decision,
        metaJson: callId ? JSON.stringify({ callId }) : undefined,
      })
    } catch { /* audit is best-effort */ }
  }
}

export const hostedToolProxy = new HostedToolProxy()
