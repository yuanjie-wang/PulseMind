// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { BookFilled, BookOutlined } from '@ant-design/icons'
import { App, ConfigProvider } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageGroup, type MessageActions } from '../src/renderer/src/components/chat/MessageGroup'
import { TranslationProvider } from '../src/renderer/src/i18n/useTranslation'
import type { AgentMessage } from '../src/renderer/src/types/agent'
import type { KnowledgeFile } from '../src/shared/types/knowledge'

const noop = () => {}
const iconPaths = (element: Element) => [...element.querySelectorAll('svg path')].map(path => path.getAttribute('d'))
function expectedIconPaths(icon: typeof BookFilled) {
  const element = document.createElement('div')
  element.innerHTML = renderToStaticMarkup(React.createElement(icon))
  return iconPaths(element)
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const msg: AgentMessage = {
  id: 'favorite-integration-message', role: 'assistant', createdAt: '2026-09-17T00:00:00Z',
  contentBlocks: [{ type: 'text', text: 'A useful conclusion.' }, { type: 'text', text: 'Details stay intact.' }],
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => { vi.unstubAllGlobals() })

async function mount(actions: MessageActions, save: ReturnType<typeof vi.fn>) {
  const marker = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('electronAPI', new Proxy({}, { get: (_, key) => {
    if (key === 'knowledgeWriteFavorite') return save
    if (key === 'updateMessageMetadata') return marker
    if (String(key).startsWith('on')) return () => noop
    return async () => []
  } }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConfigProvider, null,
      React.createElement(App, null,
        React.createElement(TranslationProvider, { initialLocale: 'zh' },
          React.createElement(MessageGroup, {
            msg, actions, conversationId: 'favorite-integration-conversation', conversationTitle: 'Fixture title',
            onApproveTool: noop, onRejectTool: noop, onKillTool: noop,
          })))))
    await flush()
  })
  return { container, marker, close: async () => {
    await act(async () => { root.unmount(); await flush() })
    container.remove()
  } }
}

describe('MessageGroup knowledge-save integration', () => {
  it('saves one exact payload, waits for persistence, then shows a one-way solid book', async () => {
    let finish!: (file: KnowledgeFile) => void
    const save = vi.fn(() => new Promise<KnowledgeFile>(resolve => { finish = resolve }))
    const mounted = await mount('full', save)
    try {
      const saveBtn = mounted.container.querySelector<HTMLButtonElement>('[data-testid="knowledge-save"]')!
      expect(saveBtn).not.toBeNull()
      expect(saveBtn.title).toBe('收藏至知识库')
      expect(iconPaths(saveBtn)).toEqual(expectedIconPaths(BookOutlined))
      // Same-turn clicks exercise the synchronous latch, not just React state.
      await act(async () => { saveBtn.click(); saveBtn.click(); await flush() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith({
        content: 'A useful conclusion.\nDetails stay intact.', messageId: msg.id,
        conversationId: 'favorite-integration-conversation', title: 'Fixture title',
      })
      expect(saveBtn.title).toBe('收藏至知识库')
      expect(iconPaths(saveBtn)).toEqual(expectedIconPaths(BookOutlined))
      await act(async () => {
        finish({ id: 'favorite-integration-raw', status: 'raw' } as KnowledgeFile)
        await flush()
      })
      expect(saveBtn.title).toBe('已录入知识库')
      expect(saveBtn.getAttribute('aria-label')).toBe('已录入知识库')
      expect(iconPaths(saveBtn)).toEqual(expectedIconPaths(BookFilled))
      await act(async () => { saveBtn.click(); await flush() })
      expect(save).toHaveBeenCalledTimes(1)
      expect(mounted.marker).not.toHaveBeenCalled()
    } finally { await mounted.close() }
  })

  it('offers no save button and performs no writes for a viewOnly transcript', async () => {
    const save = vi.fn()
    const mounted = await mount('viewOnly', save)
    try {
      expect(mounted.container.querySelector('[data-testid="knowledge-save"]')).toBeNull()
      // Prove the actual transcript rendered instead of vacuously finding no button.
      expect(mounted.container.textContent).toContain('A useful conclusion.')
      expect(mounted.container.querySelector('button[title="复制"]')).not.toBeNull()
      expect(save).not.toHaveBeenCalled()
      expect(mounted.marker).not.toHaveBeenCalled()
    } finally { await mounted.close() }
  })
})
