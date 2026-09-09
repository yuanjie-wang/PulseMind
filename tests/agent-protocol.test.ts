import { describe, expect, it } from 'vitest'
import {
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  isCall,
  makeError,
  makeResult,
} from '../src/shared/agent-protocol'
import type { AgentEventData, JsonRpcRequest, JsonRpcResponse } from '../src/shared/agent-protocol'

describe('jsonrpc envelope', () => {
  it('builds success responses with the 2.0 envelope', () => {
    const res: JsonRpcResponse = makeResult(7, { ok: true })
    expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  it('builds error responses carrying code and message', () => {
    const res = makeError('abc', ErrorCodes.sessionNotFound, 'no such session', { sessionId: 's1' })
    expect(res.error).toEqual({ code: -32004, message: 'no such session', data: { sessionId: 's1' } })
    expect(res.id).toBe('abc')
  })

  it('distinguishes calls from notifications', () => {
    const call: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Methods.ping }
    const note: JsonRpcRequest = { jsonrpc: '2.0', method: Notifications.agentEvent }
    expect(isCall(call)).toBe(true)
    expect(isCall(note)).toBe(false)
  })

  it('survives a JSON round-trip', () => {
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: Methods.agentAsk, params: { sessionId: 's', content: 'hi' } }
    const back = JSON.parse(JSON.stringify(req))
    expect(back).toEqual(req)
  })
})

describe('protocol surface', () => {
  it('pins the protocol version and error codes for wire compatibility', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(ErrorCodes.protocolVersionMismatch).toBe(-32002)
    expect(ErrorCodes.sessionNotFound).toBe(-32004)
  })

  it('keeps Anywhere-compatible method spellings', () => {
    expect(Methods.hello).toBe('hello')
    expect(Methods.sessionCreate).toBe('session.create')
    expect(Methods.agentAsk).toBe('agent.ask')
    expect(Methods.agentCancel).toBe('agent.cancel')
    expect(Methods.agentHistory).toBe('agent.history')
    expect(Methods.toolCall).toBe('tool.call')
    expect(Methods.toolResult).toBe('tool.result')
    expect(Methods.approvalRequest).toBe('approval.request')
    expect(Methods.approvalResponse).toBe('approval.response')
    expect(Methods.askUserRequest).toBe('ask_user.request')
    expect(Methods.iterationLimitResponse).toBe('iteration_limit.response')
  })

  it('exposes agent.event as the streaming notification channel', () => {
    expect(Notifications.agentEvent).toBe('agent.event')
    expect(Notifications.configChanged).toBe('config.changed')
  })
})

describe('AgentEventData', () => {
  it('accepts the full event union without dropping discriminants', () => {
    const events: AgentEventData[] = [
      { type: 'status', status: 'streaming' },
      { type: 'token', blockType: 'text', text: 'hel' },
      { type: 'block_start', blockType: 'tool_use', toolName: 'bash' },
      { type: 'tool_input_preview', toolUseId: 't1', partialJson: '{"command"' },
      { type: 'tool_start', toolUseId: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'out', isError: false, exitCode: 0 },
      { type: 'plan_update', plan: { objective: 'o', mode: 'normal', steps: [{ text: 's', state: 'pending' }] } },
      { type: 'plan_update', plan: null },
      { type: 'spawn_progress', message: '子代理思考中...' },
      { type: 'usage', inputTokens: 1, outputTokens: 2 },
      { type: 'done', stopReason: 'end_turn' },
      { type: 'error', message: 'boom' },
    ]
    const types = new Set(events.map(e => e.type))
    expect(types.size).toBe(11) // 12 events, plan_update intentionally duplicated (null plan)
    for (const e of events) {
      expect(JSON.parse(JSON.stringify(e))).toEqual(e)
    }
  })

  it('tool_result always carries isError so the loop can branch', () => {
    const e: AgentEventData = { type: 'tool_result', toolUseId: 't', content: '', isError: true }
    if (e.type === 'tool_result') expect(e.isError).toBe(true)
  })
})
