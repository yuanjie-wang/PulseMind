import { describe, it, expect } from 'vitest'
import { applySessionEvent, freshSessionState, seedSessionState, type SessionState } from '../src/shared/agent-session/mirror'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

const NOW = '2026-09-16T10:00:00.000Z'

const toolUse = (id: string, name: string, status: ToolUseBlock['status']): ContentBlock =>
  ({ type: 'tool_use', id, name, status, input: {} })

const msg = (id: string, blocks: ContentBlock[]): AgentMessage =>
  ({ id, role: 'assistant', contentBlocks: blocks, createdAt: NOW })

function stateWith(messages: AgentMessage[]): SessionState {
  const state = freshSessionState()
  state.messages = messages
  return state
}

const blockOf = (state: SessionState, msgIndex: number, blockIndex: number): ToolUseBlock =>
  state.messages[msgIndex].contentBlocks[blockIndex] as ToolUseBlock

describe('applySessionEvent → tool_status', () => {
  it('applies the patch to the addressed block', () => {
    const state = stateWith([msg('a1', [toolUse('aq1', 'ask_user', 'running')])])
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 'aq1', status: 'completed', exitCode: 0, output: '生产' }],
    })
    expect(blockOf(state, 0, 0)).toMatchObject({ status: 'completed', exitCode: 0, output: '生产' })
  })

  it('REPLACES the patched block and its message instead of editing in place', () => {
    // The contract this fold cannot break: the views that render a tool block are
    // React.memo (MessageGroup / ExecutionSegment / CommandCard) and compare props
    // by reference, and matchSegment() decides a segment changed by comparing
    // tool_use statuses. An in-place edit keeps every identity, so all of them
    // conclude nothing happened — that is how an answered ask_user card kept its
    // chips and input box on screen, still clickable.
    const state = stateWith([msg('a1', [toolUse('aq1', 'ask_user', 'running')])])
    const before = state.messages
    const beforeMsg = before[0]
    const beforeBlock = blockOf(state, 0, 0)

    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 'aq1', status: 'completed', output: '生产' }],
    })

    expect(state.messages).not.toBe(before)
    expect(state.messages[0]).not.toBe(beforeMsg)
    expect(blockOf(state, 0, 0)).not.toBe(beforeBlock)
  })

  it('leaves untouched messages and blocks on their original objects', () => {
    const keep = msg('m0', [toolUse('t0', 'read', 'completed')])
    const state = stateWith([keep, msg('a1', [toolUse('t1', 'exec', 'running'), toolUse('t2', 'write', 'running')])])
    const spareBlock = blockOf(state, 1, 1)

    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 't1', status: 'completed', output: 'ok' }],
    })

    expect(state.messages[0]).toBe(keep)
    expect(blockOf(state, 1, 1)).toBe(spareBlock)
    expect(blockOf(state, 1, 1).status).toBe('running')
  })

  it('patches the skip path too (rejected carries no output)', () => {
    const state = stateWith([msg('a1', [toolUse('aq1', 'ask_user', 'running')])])
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 'aq1', status: 'rejected' }],
    })
    expect(blockOf(state, 0, 0)).toMatchObject({ status: 'rejected' })
  })

  it('ignores updates for a message or call the mirror does not hold', () => {
    const state = stateWith([msg('a1', [toolUse('t1', 'exec', 'running')])])
    const before = state.messages
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [
        { messageId: 'nope', toolUseId: 't1', status: 'completed' },
        { messageId: 'a1', toolUseId: 'nope', status: 'completed' },
      ],
    })
    expect(state.messages).toEqual(before)
    expect(blockOf(state, 0, 0).status).toBe('running')
  })

  it('never touches a non-tool block when patching its message', () => {
    const text: ContentBlock = { type: 'text', text: '先说一句' }
    const state = stateWith([msg('a1', [text, toolUse('t1', 'exec', 'running')])])
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 't1', status: 'completed', output: 'done' }],
    })
    expect(state.messages[0].contentBlocks[0]).toBe(text)
    expect(blockOf(state, 0, 1)).toMatchObject({ status: 'completed', output: 'done' })
  })

  it('carries the spawn link, which only ever arrives as a diff', () => {
    // spawn_agent writes subConvId/planNodeId while it executes — long after the
    // assistant message was appended — so the status diff is the only carrier.
    // Without this the DAG's node click and the card's sub-agent preview had
    // nothing to open with (the reported 「点击任务模块，没有跳转」).
    const state = stateWith([msg('a1', [toolUse('t1', 'spawn_agent', 'running')])])
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{
        messageId: 'a1', toolUseId: 't1', status: 'running',
        subConvId: 'sub_123', planNodeId: 'n2',
      }],
    })
    expect(blockOf(state, 0, 0)).toMatchObject({ subConvId: 'sub_123', planNodeId: 'n2' })

    // A later diff that says nothing about the link must not drop it.
    applySessionEvent(state, {
      type: 'tool_status',
      updates: [{ messageId: 'a1', toolUseId: 't1', status: 'completed', exitCode: 0 }],
    })
    expect(blockOf(state, 0, 0)).toMatchObject({ status: 'completed', subConvId: 'sub_123', planNodeId: 'n2' })
  })
})

describe('applySessionEvent → plan_update', () => {
  it('folds the full plan object, the report fields included (B3 表达面)', () => {
    // recordNodeReport 落的 reportPath/declaredStatus 是报告表达面的全部数据
    // 源：plan_update 携带的就是 Plan 本体（payloads 的 type alias，无投影）。
    // 折叠若做字段挑选就会在这里丢字段——画布的声明徽标与「查看报告」永远
    // 无米下锅，且没有任何报错。
    const state = freshSessionState()
    applySessionEvent(state, {
      type: 'plan_update',
      plan: {
        id: 'plan_x', objective: '出一份竞品报告', completed: false, version: 2, mode: 'delegated',
        nodes: [{
          id: 'n1', description: '调研并产出报告', status: 'completed', dependsOn: [],
          reportPath: '/ws/.pulsemind/plans/plan_x/n1-report.md',
          declaredStatus: 'partial',
        }],
      },
    } as never)
    expect(state.plan?.nodes[0]).toMatchObject({
      reportPath: '/ws/.pulsemind/plans/plan_x/n1-report.md',
      declaredStatus: 'partial',
    })

    // 快照种子同路径：重连（renderer 重载/会话重开）后报告字段仍在。
    const reattached = freshSessionState()
    seedSessionState(reattached, { messages: [], status: { status: 'idle' }, streamingBlocks: [], plan: state.plan })
    expect(reattached.plan?.nodes[0]?.reportPath).toBe('/ws/.pulsemind/plans/plan_x/n1-report.md')
  })
})

describe('status folding — the reason rides with the status word', () => {
  it('carries the error text the wire sent', () => {
    // The regression this pins: the fold kept only `status`, so every client fell
    // back to its own copy and a failed turn read "Unknown error" / 未知错误 in the
    // chat no matter what main had said. Main has always shipped the reason
    // (`onStatusChanged`) — the reducer dereferenced it away.
    const state = freshSessionState()
    applySessionEvent(state, {
      type: 'status',
      status: 'error',
      error: 'API 请求失败 (400): model not found',
    })
    expect(state.agentStatus).toEqual({ status: 'error', error: 'API 请求失败 (400): model not found' })
  })

  it('leaves the key ABSENT when the wire carried none, so the fallback stays honest', () => {
    // `error: ''`/`error: undefined` must not become a blank reason: the clients
    // render `'error' in status ? status.error : <their own copy>`, and a present
    // empty string would draw an empty banner instead of the fallback.
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'error' })
    expect(state.agentStatus).toEqual({ status: 'error' })
    expect('error' in state.agentStatus).toBe(false)
  })

  it('folds a non-error status to the bare word', () => {
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'streaming' })
    expect(state.agentStatus).toEqual({ status: 'streaming' })
  })

  it('replaces the status object, like every other fold', () => {
    const state = freshSessionState()
    const before = state.agentStatus
    applySessionEvent(state, { type: 'status', status: 'streaming' })
    expect(state.agentStatus).not.toBe(before)
  })
})

describe('status folding — a retry carries its count, delay and message', () => {
  it('reconstructs the full retrying status when attempt and maxRetries arrived', () => {
    // The regression this pins (user report 2026-09-24: 「网络波动，正在重试，
    // 这个提示后面现在不展示重试次数了」): stream-runner produced the full status
    // main-side, but the wire dropped attempt/maxRetries/delay at the emit AND
    // the fold kept only the status word — so the banner rendered with no
    // (n/max) and seeded its countdown from undefined → NaN, which also never
    // clears the interval (NaN <= 1 is false).
    const state = freshSessionState()
    applySessionEvent(state, {
      type: 'status',
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delayMs: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
    expect(state.agentStatus).toEqual({
      status: 'retrying',
      attempt: 2,
      maxRetries: 20,
      delay: 3000,
      message: '网络波动，正在重试 (2/20)…',
    })
  })

  it('defaults a missing delayMs to 0 and message to empty, never NaN', () => {
    // Idle-timeout and context-overflow retries carry delay: 0; a wire that
    // sends the pair without them must still yield a renderable status.
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'retrying', attempt: 1, maxRetries: 1 })
    expect(state.agentStatus).toEqual({ status: 'retrying', attempt: 1, maxRetries: 1, delay: 0, message: '' })
  })

  it('leaves a thin wire as the bare word so the banner hides its parens', () => {
    // Honest absence, same contract as `error`: an older main that never sent
    // the fields must not yield fake zeros — (0/0) is a wrong count, not a
    // missing one. The renderer keys its parens off the keys being present.
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'retrying' })
    expect(state.agentStatus).toEqual({ status: 'retrying' })
    expect('attempt' in state.agentStatus).toBe(false)
    expect('maxRetries' in state.agentStatus).toBe(false)
  })

  it('does not half-reconstruct when only one of the pair arrived', () => {
    // The count is one fact: attempt without maxRetries (or vice versa) is a
    // partial the banner cannot render, so it folds to the bare word rather
    // than a status where one key exists and the other does not.
    const state = freshSessionState()
    applySessionEvent(state, { type: 'status', status: 'retrying', attempt: 3 })
    expect(state.agentStatus).toEqual({ status: 'retrying' })
  })
})

describe('seedSessionState — the reason survives a re-attach', () => {
  const snapshot = (status: Parameters<typeof seedSessionState>[1]['status']): Parameters<typeof seedSessionState>[1] =>
    ({ messages: [], status, streamingBlocks: [], plan: null })

  it('seeds the reason from the snapshot, not just the status word', () => {
    // A client that re-attaches to a session parked in `error` (renderer reload,
    // conversation re-open, panel re-open after a worker restart) has no other
    // carrier: the failing status event was delivered while it was away.
    const state = freshSessionState()
    seedSessionState(state, snapshot({ status: 'error', error: '连接中断' }))
    expect(state.agentStatus).toEqual({ status: 'error', error: '连接中断' })
  })

  it('leaves the key absent when the snapshot has no reason', () => {
    const state = freshSessionState()
    seedSessionState(state, snapshot({ status: 'error' }))
    expect('error' in state.agentStatus).toBe(false)
  })

  it('seeds a healthy status bare', () => {
    const state = freshSessionState()
    seedSessionState(state, snapshot({ status: 'executing' }))
    expect(state.agentStatus).toEqual({ status: 'executing' })
  })

  it('seeds the full retrying status so the count shows after a re-attach', () => {
    // A client that re-attaches while a retry is parked (renderer reload,
    // conversation re-open mid-backoff) has no other carrier for the count:
    // the status event was delivered while it was away.
    const state = freshSessionState()
    seedSessionState(state, snapshot({ status: 'retrying', attempt: 3, maxRetries: 20, delayMs: 5000, message: '网络波动，正在重试 (3/20)…' }))
    expect(state.agentStatus).toEqual({ status: 'retrying', attempt: 3, maxRetries: 20, delay: 5000, message: '网络波动，正在重试 (3/20)…' })
  })

  it('stays bare when the snapshot carries no retry count', () => {
    const state = freshSessionState()
    seedSessionState(state, snapshot({ status: 'retrying' }))
    expect(state.agentStatus).toEqual({ status: 'retrying' })
    expect('attempt' in state.agentStatus).toBe(false)
  })
})
