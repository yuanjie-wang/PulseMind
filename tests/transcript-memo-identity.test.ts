// @vitest-environment jsdom
// 转录区的滚动卡顿（user 2026-11-09「在和助手聊天时，感觉对话区上下滚动有卡顿」）：
// 这个组件不做虚拟化，跳过重渲染全靠 memo 一层层挡住——
//   TranscriptView → SegmentBlock → SegmentView → MessageGroup(memo)
// 而 memo 的前提是「传下去的 props 身份稳定」。助手宿主（FormAssistColumn）每次
// render 都传新的箭头函数，于是每个流式 chunk 都换了整套 props；修法是在
// TranscriptView 里用 ref 转发（身份恒定、调用最新 prop）并给 SegmentBlock 补 memo。
// 像素/计时侧的证据在 scripts/probe-transcript-perf.mjs（一次 chunk 的同步渲染成本
// 12.45ms → 1.64ms）；这里钉的是机制本身，因为「身份稳定」是源码读得出、跑起来看不见
// 的契约：
//   - 段落层真的挂了 memo，且「同一段对象 + 等值 props」不重渲染子层；
//   - TranscriptView 交给段落的 handler 跨 render 身份不变（宿主传新箭头也一样），
//     但调用时打到的是最新的那个（新会话换引擎时旧闭包会驱动错引擎，比卡顿更糟）。
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentMessage } from '../src/renderer/src/types/agent'

// React 18 的 act 门：jsdom 环境下不设它，act() 会退化成裸 render 并打警告
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** SegmentBlock 收到的 props 中与本次契约有关的那几个。 */
type CapturedProps = {
  seg: { type: string }
  onApproveTool?: (id: string, alwaysAllow?: boolean) => void
  onRejectTool?: (id: string) => void
  onKillTool?: (id: string) => void
  onPromoteTool?: (id: string) => void
  onRespondToTool?: (id: string, response: string) => void
}

/** 捕获 SegmentBlock 收到的 props（TranscriptView 那一半用）。 */
const captured: CapturedProps[] = []
/** mock 掉的 MessageGroup 记账：每个 msg.id 被渲染几次（memo 那一半用）。 */
const groupRenders: string[] = []

vi.mock('../src/renderer/src/components/chat/MessageGroup', async () => {
  const R = await vi.importActual<typeof import('react')>('react')
  return {
    MessageGroup: (props: { msg: { id: string } }) => {
      groupRenders.push(props.msg.id)
      return R.createElement('div', { 'data-mock-group': props.msg.id })
    },
  }
})

vi.mock('../src/renderer/src/components/chat/SegmentView', async () => {
  const R = await vi.importActual<typeof import('react')>('react')
  return {
    MESSAGE_COLUMN_INSET: 24,
    SegmentBlock: (props: CapturedProps) => {
      captured.push(props)
      return R.createElement('div', null, props.seg.type)
    },
  }
})

import { TranscriptView } from '../src/renderer/src/components/chat/TranscriptView'

const AT = '2026-11-09T10:00:00.000Z'
const noop = () => {}

const assistant = (id: string, text: string): AgentMessage => ({
  id,
  role: 'assistant',
  content: '',
  createdAt: AT,
  contentBlocks: [{ type: 'text', text }],
})

let roots: Array<ReturnType<typeof createRoot>> = []
afterEach(() => {
  for (const r of roots) act(() => r.unmount())
  roots = []
  captured.length = 0
  groupRenders.length = 0
})

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(el))
  return container
}

const messages = [assistant('m1', '第一条回答'), assistant('m2', '第二条回答')]

/** 宿主每次 render 都新建箭头函数——FormAssistColumn 的原样形状。 */
function inlineHandlers(tag: string, calls: string[]) {
  return {
    onApproveTool: (id: string, always?: boolean) => calls.push(`${tag}:approve:${id}:${always === true}`),
    onRejectTool: (id: string) => calls.push(`${tag}:reject:${id}`),
    onKillTool: (id: string) => calls.push(`${tag}:kill:${id}`),
    onPromoteTool: (id: string) => calls.push(`${tag}:promote:${id}`),
    onRespondToTool: (id: string, response: string) => calls.push(`${tag}:respond:${id}:${response}`),
  }
}

function transcript(wired: Record<string, unknown>) {
  return React.createElement(TranscriptView, {
    messages,
    agentStatus: { status: 'idle' },
    streamingBlocks: [],
    isRequesting: false,
    restoring: false,
    contentInset: 0,
    ...wired,
    onClearError: noop,
    onRetry: noop,
  })
}

describe('TranscriptView — handler identity is the memo contract', () => {
  it('hands the segment layer the SAME function across renders, even when the host passes fresh arrows', () => {
    const a: string[] = []
    const b: string[] = []
    let which: 'a' | 'b' = 'a'
    let force: () => void = () => {}
    function Host() {
      const [, setTick] = useState(0)
      force = () => setTick((n) => n + 1)
      return transcript(inlineHandlers(which, which === 'a' ? a : b))
    }
    mount(React.createElement(Host))
    const first = captured[captured.length - 1]
    expect(typeof first.onApproveTool).toBe('function')

    // 第二轮：换一整组新箭头（模拟新 render / 新会话），身份必须不变
    which = 'b'
    act(() => force())
    const second = captured[captured.length - 1]

    expect(second.onApproveTool).toBe(first.onApproveTool)
    expect(second.onRejectTool).toBe(first.onRejectTool)
    expect(second.onKillTool).toBe(first.onKillTool)
    expect(second.onPromoteTool).toBe(first.onPromoteTool)
    expect(second.onRespondToTool).toBe(first.onRespondToTool)
  })

  it('still calls the LATEST prop — a cached arrow must not drive a swapped session', () => {
    const a: string[] = []
    const b: string[] = []
    let which: 'a' | 'b' = 'a'
    let force: () => void = () => {}
    function Host() {
      const [, setTick] = useState(0)
      force = () => setTick((n) => n + 1)
      return transcript(inlineHandlers(which, which === 'a' ? a : b))
    }
    mount(React.createElement(Host))

    which = 'b'
    act(() => force())
    const latest = captured[captured.length - 1]
    act(() => {
      latest.onApproveTool('t1', true)
      latest.onRejectTool('t2')
      latest.onRespondToTool('t3', 'allow')
    })
    expect(b).toEqual(['b:approve:t1:true', 'b:reject:t2', 'b:respond:t3:allow'])
    expect(a).toEqual([])
  })

  it('keeps the 转入后台 gate: no prop in, no button out', () => {
    const { onPromoteTool: _omitted, ...withoutPromote } = inlineHandlers('a', [])
    mount(transcript(withoutPromote))
    expect(captured[captured.length - 1].onPromoteTool).toBeUndefined()

    captured.length = 0
    const calls: string[] = []
    mount(transcript(inlineHandlers('c', calls)))
    const promote = captured[captured.length - 1].onPromoteTool
    expect(typeof promote).toBe('function')
    act(() => promote('t9'))
    // 转发的是最新一组箭头（c: 前缀），不是任何缓存副本
    expect(calls).toEqual(['c:promote:t9'])
  })
})

describe('SegmentBlock — the segment layer actually memoizes', () => {
  it('is a React.memo component', async () => {
    const real = await vi.importActual<typeof import('../src/renderer/src/components/chat/SegmentView')>('../src/renderer/src/components/chat/SegmentView')
    expect((real.SegmentBlock as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })

  it('skips the child render for an unchanged segment, and still renders a changed one', async () => {
    const real = await vi.importActual<typeof import('../src/renderer/src/components/chat/SegmentView')>('../src/renderer/src/components/chat/SegmentView')
    const seg = { type: 'single' as const, msg: assistant('m1', '稳定段落') }
    const other = { type: 'single' as const, msg: assistant('m2', '换过的段落') }
    const block = (s: typeof seg) =>
      React.createElement(real.SegmentBlock, {
        // 每轮都新建 props 对象，但内容等值（真实转录的形状）
        seg: s,
        isLastSegment: true,
        actions: 'full',
        onApproveTool: noop,
        onRejectTool: noop,
        onKillTool: noop,
        onRespondToTool: noop,
      })

    let setSeg: (s: typeof seg) => void = () => {}
    function Host() {
      const [cur, set] = useState(seg)
      setSeg = set
      return block(cur)
    }
    mount(React.createElement(Host))
    expect(groupRenders).toEqual(['m1'])

    // 等值 rerender：props 对象是新的，段对象与函数都没变 → memo 短路，子层零渲染
    act(() => setSeg(seg))
    expect(groupRenders).toEqual(['m1'])

    // 段对象真的换了（正在增长的那一段）→ 子层必须重渲染
    act(() => setSeg(other))
    expect(groupRenders).toEqual(['m1', 'm2'])
  })
})
