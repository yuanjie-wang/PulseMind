// @vitest-environment jsdom
// The sub-agent session view is the ONE hydrate consumer that used to skip the
// status restore: `tool_use.status` is stripped on save (runtime-only), so
// feeding raw stored rows to the transcript rendered EVERY completed tool as
// 执行状态未知 (user report 2026-09-25: 子代理执行任务的完成情况还是大量展示为执行状态未知).
// Its load path must run storedMessagesToAgentMessages like every other load
// path (useConversationPersistence / useHostedAgentSession / useStudioSession),
// while a tool with NO persisted tool_result must KEEP the 执行状态未知 fallback
// — tests/tool-card-history-status.test.ts pins that half at the MessageGroup
// level; this pins the restore at the view level.
// createElement, not JSX — vitest here runs plain .ts through esbuild.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubAgentSessionView } from '../src/renderer/src/components/subagent/SubAgentSessionView'
import { TranslationProvider } from '../src/renderer/src/i18n/useTranslation'
import type { Conversation } from '../src/shared/types/conversation'

vi.mock('@ant-design/x-markdown', () => ({
  default: () => null,
  XMarkdown: () => null
}))

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const AT = '2026-09-25T10:00:00.000Z'

/** A stored sub-conversation exactly as hydrateConversation returns it: status
 *  already stripped, tool_results present for u1 only (u2 never settled). */
const conv: Conversation = {
  id: 'sub_1',
  title: '调研专家',
  createdAt: AT,
  updatedAt: AT,
  messages: [
    {
      id: 'm1', role: 'assistant', createdAt: AT, content: '',
      contentBlocks: [
        { type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'ls' }, exitCode: 0 },
        { type: 'tool_use', id: 'u2', name: 'read', input: { file_path: '/x' } }
      ]
    },
    {
      id: 'm2', role: 'user', createdAt: AT, content: '',
      contentBlocks: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }]
    }
  ]
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn()
  })))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    hydrateConversation: async () => conv
  }
})
afterEach(() => { vi.unstubAllGlobals() })

async function mount(live = false, paused = false): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(
      TranslationProvider,
      { initialLocale: 'zh' },
      React.createElement(SubAgentSessionView, {
        subConvId: 'sub_1', title: '调研专家', live, paused, onBack: () => {}
      })
    ))
    await flush()
  })
  // The tool cards live inside the collapsed execution segment — expand it so
  // the per-call headers (where the status hint renders) are on the page.
  await act(async () => {
    container.querySelector('[data-segment-head]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
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

const headText = (container: HTMLElement, toolUseId: string): string =>
  container.querySelector(`[data-tool-head="${toolUseId}"]`)?.textContent ?? ''

describe('SubAgentSessionView stored status', () => {
  it('restores completion from persisted tool_results instead of 执行状态未知', async () => {
    const mounted = await mount()
    try {
      expect(headText(mounted.container, 'u1')).not.toContain('执行状态未知')
      expect(mounted.container.querySelector('[data-tool-head="u1"] .anticon-check')).not.toBeNull()
    } finally {
      await mounted.unmount()
    }
  })

  it('keeps 执行状态未知 for a tool with no persisted tool_result', async () => {
    const mounted = await mount()
    try {
      expect(headText(mounted.container, 'u2')).toContain('执行状态未知')
    } finally {
      await mounted.unmount()
    }
  })
})

// The blinking tail cursor while the node is open (user ruling 2026-09-25:
// 子对话需要和主对话一样有个闪烁光标). TranscriptView only renders
// StreamingCursor when its isRequesting prop is true, and the view derives that
// from `live && !loading` — so presence/absence of the data attribute IS the
// wiring, asserted through the real component tree rather than a source scan.
// Default mount stays live: false so the status tests above are unaffected.
describe('SubAgentSessionView run cursor', () => {
  it('blinks the streaming cursor while the sub-agent is live', async () => {
    const mounted = await mount(true)
    try {
      expect(mounted.container.querySelector('[data-streaming-cursor]')).not.toBeNull()
    } finally {
      await mounted.unmount()
    }
  })

  it('shows no cursor once the session is settled', async () => {
    const mounted = await mount(false)
    try {
      expect(mounted.container.querySelector('[data-streaming-cursor]')).toBeNull()
    } finally {
      await mounted.unmount()
    }
  })

  // 冻结树（停止 → awaiting_continue）：spawn 块仍标 running、计划节点仍
  // pending，App 侧的 live 因此仍为 true——但那是可恢复的在途工作，不是正在
  // 运行。徽标翻 已暂停、光标熄灭（用户报告：子代理在完成任务后，光标还在 —
  // 按下停止后钻入视图的光标永远闪烁的正是这个洞）。继续执行离开
  // awaiting_continue 后 paused 变 false，live 光标原样恢复（上面第一例）。
  it('a frozen tree shows 已暂停 and no cursor even though the blocks still read running', async () => {
    const mounted = await mount(true, true)
    try {
      expect(mounted.container.querySelector('[data-streaming-cursor]')).toBeNull()
      expect(mounted.container.textContent).toContain('已暂停')
      expect(mounted.container.textContent).not.toContain('子代理运行中')
    } finally {
      await mounted.unmount()
    }
  })
})
