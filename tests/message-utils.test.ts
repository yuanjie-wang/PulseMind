import { describe, expect, it } from 'vitest'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'
import { agentMessagesToConversation, storedMessagesToAgentMessages } from '../src/renderer/src/utils/message-utils'

function textMsg(id: string, text: string): AgentMessage {
  return { id, role: 'assistant', contentBlocks: [{ type: 'text', text }], createdAt: '2026-01-01T00:00:00Z' }
}

function toolUse(id: string, name: string, status?: string): ContentBlock {
  return { type: 'tool_use', id, name, input: {}, ...(status ? { status } : {}) } as ToolUseBlock
}

describe('agentMessagesToConversation', () => {
  it('synthesizes plain-text content from text blocks for search', () => {
    const msg: AgentMessage = {
      id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    }
    const conv = agentMessagesToConversation([msg], 'c1', 'title')
    expect(conv.messages[0].content).toBe('first\nsecond')
  })

  it('strips runtime tool_use status so it is never persisted', () => {
    const msg: AgentMessage = {
      id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [toolUse('t1', 'bash', 'running')],
    }
    const conv = agentMessagesToConversation([msg], 'c1', 'title')
    expect((conv.messages[0].contentBlocks?.[0] as ToolUseBlock).status).toBeUndefined()
  })

  it('preserves ids, roles, timestamps and metadata', () => {
    const msg: AgentMessage = {
      id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [{ type: 'text', text: 'hi' }],
      inputTokens: 10, outputTokens: 20,
    }
    const conv = agentMessagesToConversation([msg], 'c1', 'title')
    expect(conv.messages[0]).toMatchObject({ id: 'm1', role: 'user', inputTokens: 10, outputTokens: 20 })
    expect(conv.id).toBe('c1')
    expect(conv.title).toBe('title')
  })

  // promptCacheHitTokens is the DB-persisted audit dimension (2026-10-24): a
  // finished task's true billable split is only reconstructable if the cache
  // hit count survives both conversion directions — round-tripping through
  // persistence is what makes a post-hoc cost audit possible.
  it('carries promptCacheHitTokens through both conversion directions', () => {
    const msg: AgentMessage = {
      id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [{ type: 'text', text: 'hi' }],
      inputTokens: 70, outputTokens: 5, promptCacheHitTokens: 60,
    }
    const conv = agentMessagesToConversation([msg], 'c1', 'title')
    expect(conv.messages[0].promptCacheHitTokens).toBe(60)
    const back = storedMessagesToAgentMessages(conv.messages)
    expect(back[0].promptCacheHitTokens).toBe(60)
  })
})

describe('storedMessagesToAgentMessages', () => {
  it('falls back to a text block built from plain content', () => {
    const msgs = [{ id: 'm1', role: 'assistant' as const, content: 'plain text', createdAt: '2026-01-01T00:00:00Z' }]
    const agentMsgs = storedMessagesToAgentMessages(msgs as never)
    expect(agentMsgs[0].contentBlocks).toEqual([{ type: 'text', text: 'plain text' }])
  })

  it('derives tool_use completed status from tool_result presence', () => {
    const msgs = [
      { id: 'm1', role: 'assistant' as const, createdAt: 't', content: '',
        contentBlocks: [toolUse('t1', 'bash')] },
      { id: 'm2', role: 'user' as const, createdAt: 't', content: '',
        contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const agentMsgs = storedMessagesToAgentMessages(msgs as never)
    expect((agentMsgs[0].contentBlocks[0] as ToolUseBlock).status).toBe('completed')
  })

  it('round-trips through agentMessagesToConversation', () => {
    const msgs: AgentMessage[] = [
      textMsg('m1', 'hello'),
      { id: 'm2', role: 'assistant', createdAt: 't', contentBlocks: [toolUse('t1', 'bash')] },
      { id: 'm3', role: 'user', createdAt: 't', contentBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] as ContentBlock[] },
    ]
    const conv = agentMessagesToConversation(msgs, 'c1', 'title')
    const back = storedMessagesToAgentMessages(conv.messages)
    expect(back.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(back[0].contentBlocks[0]).toEqual({ type: 'text', text: 'hello' })
    expect((back[1].contentBlocks[0] as ToolUseBlock).status).toBe('completed')
  })
})

// rejected 终态持久化（2026-10-10）：rejectTool 同时写 status='rejected' 和一个
// isError 的 tool_result（循环继续需要它），而重载规则「有 tool_result →
// completed」曾把每次拒绝都翻成已完成——拒绝角标（MessageGroup）与执行段落
// 的拒绝计数（ExecutionSegment）重载后消失。'rejected' 是终态、不会腐烂、
// 没有其他恢复来源，因此是唯一随盘持久化的 status。
describe('rejected status survives the persist/reload round trip', () => {
  it('sanitize keeps rejected, still strips the transient states', () => {
    const msg: AgentMessage = {
      id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [toolUse('t1', 'exec', 'rejected'), toolUse('t2', 'exec', 'running'), toolUse('t3', 'exec', 'completed')],
    }
    const conv = agentMessagesToConversation([msg], 'c1', 'title')
    const blocks = conv.messages[0].contentBlocks as ToolUseBlock[]
    expect(blocks[0].status).toBe('rejected')
    expect(blocks[1].status).toBeUndefined()
    expect(blocks[2].status).toBeUndefined()
  })

  it('reload respects the persisted rejected instead of stamping completed', () => {
    const msgs = [{
      id: 'm1', role: 'user' as const, createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [
        { type: 'tool_use', id: 't1', name: 'exec', input: {}, status: 'rejected' },
        { type: 'tool_result', tool_use_id: 't1', content: 'Command execution was rejected by the user.', is_error: true },
      ],
    }]
    const agentMsgs = storedMessagesToAgentMessages(msgs as never)
    const block = agentMsgs[0].contentBlocks.find((b) => b.type === 'tool_use') as ToolUseBlock
    expect(block.status).toBe('rejected')
  })

  it('reload still stamps completed for a tool_result without a persisted status', () => {
    const msgs = [{
      id: 'm1', role: 'user' as const, createdAt: '2026-01-01T00:00:00Z',
      contentBlocks: [
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
        { type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false },
      ],
    }]
    const agentMsgs = storedMessagesToAgentMessages(msgs as never)
    const block = agentMsgs[0].contentBlocks.find((b) => b.type === 'tool_use') as ToolUseBlock
    expect(block.status).toBe('completed')
  })
})
