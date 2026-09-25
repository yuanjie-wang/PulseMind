// @vitest-environment jsdom
// The deliverables surface (2026-09-19): the per-turn inline card. The
// workbench 产物 aggregate tab was removed the same day — the turn cards are
// the only surface. The non-negotiable links are store-level facts, assertable
// here without a layout engine:
//   - a row click → the REAL previewPaneStore.openFile → the workbench flips
//     to 'files' with the file's tab registered;
//   - when a turn ends on assistant text, the card mounts INSIDE the message
//     ABOVE its action toolbar (MessageGroup's aboveActions slot) — DOM order
//     card-before-toolbar is pinned here;
//   - the workbench pane has no deliverables tab/panel any more.
// The pixel-side facts (spacing to the next turn's bubble, scroll-following)
// belong to probe-chat-deliverables.mjs. createElement, not JSX — vitest here
// runs plain .ts through esbuild (see the include glob), so JSX does not parse.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnDeliverablesCard } from '../src/renderer/src/components/chat/TurnDeliverablesCard'
import { SegmentBlock } from '../src/renderer/src/components/chat/SegmentView'
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
  useWorkbenchStore.setState({ activeTab: 'files', openByConversation: {} })
  usePreviewPaneStore.setState({ tabsByConversation: {}, activeByConversation: {} })
})
afterEach(() => { vi.unstubAllGlobals() })

async function mount(node: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(TranslationProvider, { initialLocale: 'zh' }, node))
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

const noop = () => {}

describe('TurnDeliverablesCard', () => {
  it('renders nothing when the derivation is empty', async () => {
    const mounted = await mount(
      React.createElement(TurnDeliverablesCard, { deliverable: collectDeliverables([]), conversationId: 'conv_1' })
    )
    try {
      expect(mounted.container.querySelector('[data-testid="turn-deliverables"]')).toBeNull()
    } finally {
      await mounted.unmount()
    }
  })

  it('shows one row per path with op counts, office badge and child attribution', async () => {
    const base = collectDeliverables(msgs)
    const withChild = {
      rows: [
        ...base.rows,
        { path: '/ws/child-only.md', ops: [{ tool: 'write', at: AT, ok: true }], lastAt: AT, fromConvIds: ['sub_9'] }
      ],
      sources: [...base.sources, { convId: 'sub_9', title: '调研专家' }]
    }
    const mounted = await mount(
      React.createElement(TurnDeliverablesCard, { deliverable: withChild, conversationId: 'conv_1', workspaceDir: '/ws' })
    )
    try {
      const rows = mounted.container.querySelectorAll('[data-testid="turn-deliverables-row"]')
      expect(rows).toHaveLength(3)
      expect(rows[0].textContent).toContain('report.md')
      expect(rows[0].textContent).toContain('写入文件 ×2')
      expect(rows[0].textContent).toContain('编辑文件 ×1')
      expect(rows[1].textContent).toContain('Word')
      expect(rows[2].textContent).toContain('来自：调研专家')
      expect(mounted.container.textContent).toContain('本轮产物')
      // the honesty boundary rides the head's tooltip — the footnote itself
      // went away with the aggregate panel
      expect(mounted.container.querySelector('[data-testid="turn-deliverables"]')!.getAttribute('title'))
        .toContain('命令行间接产物不在此列')
    } finally {
      await mounted.unmount()
    }
  })

  it('row click calls the REAL openFile — tab registered, workbench flips to files', async () => {
    const mounted = await mount(
      React.createElement(TurnDeliverablesCard, {
        deliverable: collectDeliverables(msgs), conversationId: 'conv_1', workspaceDir: '/ws'
      })
    )
    try {
      const row = mounted.container.querySelector('[data-testid="turn-deliverables-row"]')!
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
})

describe('Placement — the card mounts above the action toolbar', () => {
  it('a turn-ending assistant text carries the card between its bubble and its 对话工具条', async () => {
    const textSeg: AgentMessage = {
      id: 'm-text', role: 'assistant', createdAt: AT,
      contentBlocks: [{ type: 'text', text: '两份报告已经生成完毕。' }]
    }
    const card = React.createElement(TurnDeliverablesCard, {
      deliverable: collectDeliverables(msgs), conversationId: 'conv_1', workspaceDir: '/ws'
    })
    const mounted = await mount(
      React.createElement(SegmentBlock, {
        seg: { type: 'single', msg: textSeg },
        isLastSegment: true,
        actions: 'full',
        onApproveTool: noop,
        onRejectTool: noop,
        onKillTool: noop,
        aboveActions: card
      })
    )
    try {
      const cardEl = mounted.container.querySelector('[data-testid="turn-deliverables"]')!
      const toolbar = mounted.container.querySelector('[data-testid="knowledge-save"]')!
      // card strictly BEFORE the toolbar in document order (the toolbar's
      // compareDocumentPosition reports PRECEDING for a node before it)
      expect((toolbar.compareDocumentPosition(cardEl) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).toBe(true)
      // …and both live inside the same segment block — the card did not fall
      // out to a sibling slot
      const segment = toolbar.closest('div[id^="chat-msg-"]')
      expect(segment).not.toBeNull()
      expect(segment!.contains(cardEl)).toBe(true)
    } finally {
      await mounted.unmount()
    }
  })
})

describe('Wiring (source scans — the mount itself is probe territory)', () => {
  const read = (p: string) => require('node:fs').readFileSync(p, 'utf-8')
  const CHAT_VIEW = 'src/renderer/src/components/layout/ChatView.tsx'
  const WORKBENCH_PANE = 'src/renderer/src/components/workbench/WorkbenchPane.tsx'

  it('ChatView: the derivation eats the FULL messages; the slot and the sibling path both exist', () => {
    const src = read(CHAT_VIEW)
    expect(src).toContain('useDeliverables(conversationId, messages, agentStatus)')
    // per-turn derivation keyed on the FULL message identity — never the
    // render window (head truncation would drop old turns' cards)
    expect(src).toContain('collectTurnDeliverables(messages, childDeliverables)')
    expect(src).not.toContain('collectTurnDeliverables(renderedSegments')
    expect(src).toContain('<TurnDeliverablesCard')
    // the two mount points: the aboveActions slot for text-ending turns, the
    // sibling column wrapper for everything else
    expect(src).toContain('renderSegment(seg, abs, cardInMessage ? card : undefined)')
    expect(src).toContain('{!cardInMessage && card && (')
    // the workbench aggregate is gone — no data flows to the pane
    expect(src).not.toContain('deliverable={deliverables')
  })

  it('WorkbenchPane: the deliverables tab/panel is gone', () => {
    const src = read(WORKBENCH_PANE)
    expect(src).not.toContain('DeliverablesPanel')
    expect(src).not.toContain("'deliverables'")
    // a persisted activeTab naming the removed tab must not blank the pane
    expect(src).toContain('WORKBENCH_TAB_IDS.has(s.activeTab)')
  })
})
