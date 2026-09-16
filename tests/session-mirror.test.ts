import { describe, it, expect } from 'vitest'
import { applySessionEvent, freshSessionState, type SessionState } from '../src/shared/agent-session/mirror'
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
