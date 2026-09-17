import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, vi } from 'vitest'
import { MessageGroup } from '../src/renderer/src/components/chat/MessageGroup'
import type { AgentMessage } from '../src/renderer/src/types/agent'

vi.mock('../src/renderer/src/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@ant-design/x-markdown', () => ({ default: () => null }))
const noop = () => {}
const message = (id: string): AgentMessage => ({
  id, role: 'assistant', createdAt: '2026-09-17T00:00:00Z',
  contentBlocks: [{ type: 'tool_use', id: 'call', name: 'read', input: { file_path: '/example' } }],
})
function render(id: string) {
  return renderToStaticMarkup(React.createElement(MessageGroup, {
    msg: message(id), actions: 'none', onApproveTool: noop, onRejectTool: noop, onKillTool: noop,
  }))
}

describe('historical tool status', () => {
  it('does not call an unknown historical status instruction generation', () => {
    const html = render('stored-message')
    expect(html).toContain('执行状态未知')
    expect(html).not.toContain('指令生成中')
  })
  it('retains the hint for a genuinely streaming tool message', () => {
    const html = render('streaming-exec')
    expect(html).toContain('指令生成中')
    expect(html).not.toContain('执行状态未知')
  })
})
