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
