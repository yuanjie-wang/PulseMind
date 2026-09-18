// @vitest-environment jsdom
// PLAN-deliverables M3: the card and its ChatView wiring. The non-negotiable
// link — row click → the REAL previewPaneStore.openFile → the workbench tab
// flips to 'files' — is a store-level fact, assertable here without a layout
// engine; the pixel-side facts belong to probe-chat-deliverables.mjs (M4).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliverablesCard } from '../src/renderer/src/components/chat/DeliverablesCard'
import { collectDeliverables } from '../src/renderer/src/components/chat/deliverables'
import { usePreviewPaneStore } from '../src/renderer/src/stores/previewPaneStore'
import { useWorkbenchStore } from '../src/renderer/src/stores/workbenchStore'
import { TranslationProvider } from '../src/renderer/src/i18n/useTranslation'
import type { AgentMessage } from '../src/renderer/src/types/agent'

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const AT = '2026-09-18T10:00:00.000Z'

const msgs: AgentMessage[] = [
  {
    id: 'm-a', role: 'assistant', createdAt: AT,
    contentBlocks: [
      { type: 'tool_use', id: 'u1', name: 'write', input: { file_path: 'report.md' } },
      { type: 'tool_use', id: 'u2', name: 'write', input: { file_path: 'report.md' } },
      { type: 'tool_use', id: 'u3', name: 'edit', input: { file_path: 'report.md' } },
      { type: 'tool_use', id: 'u4', name: 'docx_edit', input: { file_path: '交付.docx' } }
    ]
  },
  {
    id: 'm-r', role: 'user', createdAt: AT,
    contentBlocks: [
      { type: 'tool_result', tool_use_id: 'u1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'u2', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'u3', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'u4', content: 'ok' }
    ]
  }
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => { vi.unstubAllGlobals() })

async function mount(deliverable: ReturnType<typeof collectDeliverables>, props?: { conversationId?: string; workspaceDir?: string }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(TranslationProvider, { initialLocale: 'zh' },
      React.createElement(DeliverablesCard, { deliverable, conversationId: props?.conversationId, workspaceDir: props?.workspaceDir })))
    await flush()
  })
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); await flush() })
      container.remove()
    }
  }
}

describe('DeliverablesCard', () => {
  it('renders nothing when the derivation is empty — no card, no tail space', async () => {
    const empty = await mount(collectDeliverables([]))
    try {
      expect(empty.container.querySelector('.pm-deliverables-card')).toBeNull()
    } finally {
      await empty.unmount()
    }
  })

  it('shows one row per path with op counts, office badge and child attribution', async () => {
    const base = collectDeliverables(msgs)
    const withChild = {
      rows: [
        ...base.rows,
        {
          path: '/ws/child-only.md',
          ops: [{ tool: 'write', at: AT, ok: true }],
          lastAt: AT,
          fromConvIds: ['sub_9']
        }
      ],
      sources: [...base.sources, { convId: 'sub_9', title: '调研专家' }]
    }
    const mounted = await mount(withChild, { conversationId: 'conv_1', workspaceDir: '/ws' })
    try {
      const rows = mounted.container.querySelectorAll('[data-testid="deliverables-row"]')
      expect(rows).toHaveLength(3)
      // workspace-relative display
      expect(rows[0].textContent).toContain('report.md')
      // 写入 ×2 · 编辑 ×1 — the toolLabel verbs, reused
      expect(rows[0].textContent).toContain('写入文件 ×2')
      expect(rows[0].textContent).toContain('编辑文件 ×1')
      // office badge
      expect(rows[1].textContent).toContain('Word')
      // child attribution via the source title
      expect(rows[2].textContent).toContain('来自：调研专家')
      // the honesty footnote is on the card, not buried in a tooltip
      expect(mounted.container.textContent).toContain('命令行间接产物不在此列')
      expect(mounted.container.textContent).toContain('共 3 个文件')
    } finally {
      await mounted.unmount()
    }
  })

  it('row click calls the REAL openFile — tab registered, workbench flips to files', async () => {
    const mounted = await mount(collectDeliverables(msgs), { conversationId: 'conv_1', workspaceDir: '/ws' })
    try {
      const row = mounted.container.querySelector('[data-testid="deliverables-row"]')!
      await act(async () => { ; (row as HTMLElement).click(); await flush() })
      const store = usePreviewPaneStore.getState()
      const tabs = store.tabsByConversation['conv_1'] ?? []
      expect(tabs.map((tb) => tb.path)).toContain('/ws/report.md')
      expect(store.activeByConversation['conv_1']).toBe('/ws/report.md')
      expect(useWorkbenchStore.getState().activeTab).toBe('files')
    } finally {
      await mounted.unmount()
    }
  })

  it('collapses on head click and re-expands; conversation switch resets the fold', async () => {
    const mounted = await mount(collectDeliverables(msgs), { conversationId: 'conv_1', workspaceDir: '/ws' })
    try {
      const head = mounted.container.querySelector('[data-testid="deliverables-head"]')!
      await act(async () => { ; (head as HTMLElement).click(); await flush() })
      expect(mounted.container.querySelector('[data-testid="deliverables-rows"]')).toBeNull()
      await act(async () => { ; (head as HTMLElement).click(); await flush() })
      expect(mounted.container.querySelector('[data-testid="deliverables-rows"]')).not.toBeNull()
    } finally {
      await mounted.unmount()
    }
  })

  it('opens the workspace tab from the footer', async () => {
    const mounted = await mount(collectDeliverables(msgs), { conversationId: 'conv_1', workspaceDir: '/ws' })
    try {
      const footer = mounted.container.querySelector('[data-testid="deliverables-open-workspace"]')!
      await act(async () => { ; (footer as HTMLElement).click(); await flush() })
      expect(useWorkbenchStore.getState().activeTab).toBe('files')
    } finally {
      await mounted.unmount()
    }
  })
})

describe('ChatView wiring (source scan — the hook mount itself is probe territory)', () => {
  const read = (p: string) => require('node:fs').readFileSync(p, 'utf-8')
  const CHAT_VIEW = 'src/renderer/src/components/layout/ChatView.tsx'

  it('feeds the hook the FULL messages and renders the card in the tail', () => {
    const src = read(CHAT_VIEW)
    expect(src).toContain('useDeliverables(conversationId, messages, agentStatus)')
    // the card sits in the scroll tail, not the render window
    expect(src).toContain('<DeliverablesCard')
    expect(src.indexOf('useDeliverables(conversationId, messages, agentStatus)')).toBeGreaterThan(-1)
    // non-vacuity of the windowing red line: ChatView has a render window, and
    // the card must never receive it
    expect(src).not.toContain('useDeliverables(conversationId, renderedSegments')
    expect(src).not.toContain('deliverable={collectDeliverables(renderedSegments')
  })
})
