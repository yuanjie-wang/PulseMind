// @vitest-environment jsdom
// The streaming tail (2026-10-26, restructured 2026-11-21): the live text
// renders through x-markdown's streaming mode (hasNextChunk holds unclosed
// tokens back, enableAnimation fades in each refresh's new text). The in-text
// caret that used to ride its `tail` slot is RETIRED (user ruling 2026-11-21,
// 渐变流式期间不要光标): the growing fading text is the streaming indicator,
// so the invariant here is ZERO cursors while text streams. TranscriptView
// hosts' foot StreamingCursor (the only remaining host, tagged
// data-streaming-cursor) keeps the hasLiveTextTail yield — it shows only in
// the textless phases (thinking, tool rounds) and never during text, so
// counting the attribute across a host that composes them the way
// ChatView/TranscriptView do reads one in those phases, zero while text
// streams or once settled. createElement, not JSX — vitest here runs plain
// .ts through esbuild.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SegmentBlock } from '../src/renderer/src/components/chat/SegmentView'
import { StreamingCursor } from '../src/renderer/src/components/chat/StreamingCursor'
import { buildSegments, getSegmentKey, hasLiveTextTail, lastLiveTextIndex, type Segment } from '../src/renderer/src/components/chat/message-segments'
import { TranslationProvider } from '../src/renderer/src/i18n/useTranslation'
import type { ContentBlock } from '../src/renderer/src/types/agent'

const noop = () => {}
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const thinking = (t: string): ContentBlock => ({ type: 'thinking', thinking: t })
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read', input: { file_path: 'x.ts' } })
const R = (...p: string[]) => join(__dirname, '..', 'src', 'renderer', 'src', ...p)
const read = (p: string) => readFileSync(p, 'utf8')

// The stream throttle (150ms) freezes the shown snapshot between renders; the
// harness drives performance.now so every render lands past the interval.
let clock = 0

beforeEach(() => {
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('electronAPI', new Proxy({}, { get: (_, key) => (String(key).startsWith('on') ? () => noop : async () => []) }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** The hosts' composition, reduced to what the cursor rule needs: the segments
 *  buildSegments derives from the live blocks, then the foot cursor behind the
 *  same gate ChatView and TranscriptView use. */
function Host({ blocks, isRequesting }: { blocks: ContentBlock[]; isRequesting: boolean }): React.ReactElement {
  const segs: Segment[] = buildSegments({ messages: [], isStreaming: isRequesting, streamingBlocks: blocks, cached: [], streamingToolAccum: new Map() })
  return React.createElement(TranslationProvider, { initialLocale: 'zh' },
    ...segs.map((seg, i) => React.createElement(SegmentBlock, {
      key: getSegmentKey(seg), seg, isLastSegment: i === segs.length - 1, isRequesting,
      onApproveTool: noop, onRejectTool: noop,
    })),
    React.createElement('div', { 'data-foot': '' },
      React.createElement(StreamingCursor, { show: isRequesting && !hasLiveTextTail(segs) })))
}

async function mount(blocks: ContentBlock[], isRequesting = true) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = async (next: ContentBlock[], req = isRequesting) => {
    clock += 1000
    await act(async () => { root.render(React.createElement(Host, { blocks: next, isRequesting: req })); await flush() })
  }
  await render(blocks)
  const carets = () => [...container.querySelectorAll('[data-streaming-cursor]')]
  const inText = (el: Element) => !!el.closest('.x-markdown')
  const atFoot = (el: Element) => !!el.closest('[data-foot]')
  return { container, carets, inText, atFoot, render, close: async () => {
    await act(async () => { root.unmount(); await flush() })
    container.remove()
  } }
}

describe('hasLiveTextTail / lastLiveTextIndex', () => {
  it('finds the last text block that has text', () => {
    expect(lastLiveTextIndex([])).toBe(-1)
    expect(lastLiveTextIndex([text('')])).toBe(-1)
    expect(lastLiveTextIndex([text('a'), thinking('t'), text('')])).toBe(0)
    expect(lastLiveTextIndex([text('a'), text('b')])).toBe(1)
  })

  // 2026-11-13 step 2: the live tail is a `single` segment carrying `live` —
  // the `type: 'streaming'` union member is gone, so the flag is the only test.
  const liveSeg = (blocks: ContentBlock[], toolsStarted = false): Segment => ({
    type: 'single',
    msg: { id: 'streaming-text', role: 'assistant', createdAt: '', contentBlocks: blocks },
    live: { toolsStarted },
  })

  it('is true only for a live tail segment carrying text', () => {
    expect(hasLiveTextTail([liveSeg([text('hi')])])).toBe(true)
    expect(hasLiveTextTail([liveSeg([text('')])])).toBe(false)
    expect(hasLiveTextTail([{ type: 'execution', msgs: [{ id: 'streaming-think', role: 'assistant', createdAt: '', contentBlocks: [thinking('…')] }] }])).toBe(false)
    expect(hasLiveTextTail([])).toBe(false)
  })

  it('is false once the round\'s tool call has begun — the finished text yields to the foot', () => {
    expect(hasLiveTextTail([liveSeg([text('done narrating')], true)])).toBe(false)
  })
})

describe('cursor per run phase', () => {
  it('streaming text: no cursor anywhere — the fading text is the indicator', async () => {
    const m = await mount([text('Hello **world**')])
    try {
      expect(m.carets()).toHaveLength(0)
    } finally { await m.close() }
  })

  it('thinking only: the caret sits at the foot', async () => {
    const m = await mount([thinking('weighing options')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('an opened but still empty text block has not taken over yet — the foot keeps the caret', async () => {
    const m = await mount([text('')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('two text blocks: still no cursor while either streams', async () => {
    const m = await mount([text('first'), text('second')])
    try {
      expect(m.carets()).toHaveLength(0)
      const roots = [...m.container.querySelectorAll('.x-markdown')]
      expect(roots).toHaveLength(2)
    } finally { await m.close() }
  })

  it('the caret leaves the foot as the first token lands and never enters the text', async () => {
    const m = await mount([thinking('…')])
    try {
      expect(m.atFoot(m.carets()[0])).toBe(true)
      await m.render([thinking('…'), text('Answer')])
      expect(m.carets()).toHaveLength(0)
      await m.render([], false)
      expect(m.carets()).toHaveLength(0)
    } finally { await m.close() }
  })

  // 2026-10-28 report: the caret used to stay parked at the end of the
  // completed narration while the tool card ran below it. Now the whole text
  // phase is caret-free; the foot caret only returns once the round's tool
  // call begins (and in the chat it never returns — the foot cursor there is
  // retired in favour of the live badge).
  it('the foot caret takes over when the round moves on to its tool call', async () => {
    const m = await mount([text('Done narrating.'), toolUse('tu_1')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.inText(carets[0])).toBe(false)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('full round lifecycle: foot while thinking, none while text streams, foot once the tool call begins', async () => {
    const m = await mount([thinking('…')])
    try {
      expect(m.atFoot(m.carets()[0])).toBe(true)
      await m.render([thinking('…'), text('Answer text')])
      expect(m.carets()).toHaveLength(0)
      await m.render([thinking('…'), text('Answer text'), toolUse('tu_1')])
      expect(m.carets()).toHaveLength(1)
      expect(m.inText(m.carets()[0])).toBe(false)
      expect(m.atFoot(m.carets()[0])).toBe(true)
    } finally { await m.close() }
  })

  it('the streamed markdown fades its text in (x-markdown enableAnimation)', async () => {
    const m = await mount([text('fade me')])
    try {
      const animated = [...m.container.querySelectorAll('.x-markdown p span')]
        .filter((el) => (el as HTMLElement).style.animation.includes('x-markdown-fade-in'))
      expect(animated.length).toBeGreaterThan(0)
    } finally { await m.close() }
  })

  // hasNextChunk's hold-back must cost nothing visible on plain prose — only
  // an unclosed token waits, and only until it closes.
  it('plain text shows at once; an unclosed ** is held back until it closes', async () => {
    const m = await mount([text('Hello wor')])
    try {
      const p = () => m.container.querySelector('.x-markdown p')?.textContent ?? ''
      expect(p()).toContain('Hello wor')
      await m.render([text('Hello world, **bo')])
      expect(p()).toContain('Hello world, ')
      expect(p()).not.toContain('**')
      expect(p()).not.toContain('bo')
      await m.render([text('Hello world, **bold** done')])
      expect(m.container.querySelector('.x-markdown strong')?.textContent).toBe('bold')
      expect(p()).toContain('done')
    } finally { await m.close() }
  })
})

// The tool-call flush (2026-10-28 report): within one round the model narrates
// text, then streams a tool_use. The execution segment (tool card) mounts on
// the first tick that carries the block — which can land INSIDE the parse
// throttle's 150ms interval — and the sentence above it must be COMPLETE in
// that same render, not one interval behind. buildSegments stamps the round's
// tool_use presence as `live.toolsStarted` on the tail segment; AssistantMarkdown
// force-feeds its throttle with it.
describe('tool-call flush signal', () => {
  it('buildSegments stamps toolsStarted from the round\'s tool_use presence', () => {
    const build = (blocks: ContentBlock[]): Segment[] =>
      buildSegments({ messages: [], isStreaming: true, streamingBlocks: blocks, cached: [], streamingToolAccum: new Map() })
    const textOnly = build([text('narration')])
    expect(textOnly[textOnly.length - 1]).toMatchObject({ type: 'single', live: { toolsStarted: false } })
    const withTool = build([text('narration'), toolUse('tu_1')])
    const streamingSeg = withTool.find((s) => s.type === 'single' && s.live !== undefined)
    expect(streamingSeg).toMatchObject({ type: 'single', live: { toolsStarted: true } })
    // thinking + tool, no text: no live tail exists to stamp
    expect(build([thinking('…'), toolUse('tu_2')]).some((s) => s.type === 'single' && s.live !== undefined)).toBe(false)
  })

  it('the tick that mounts the tool card renders the sentence complete, even inside the throttle interval', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const render = async (blocks: ContentBlock[]) => {
      await act(async () => { root.render(React.createElement(Host, { blocks, isRequesting: true })); await flush() })
    }
    try {
      clock = 0
      await render([text('Reading the config fi')])
      const p = () => container.querySelector('.x-markdown p')?.textContent ?? ''
      expect(p()).toContain('Reading the config fi')
      // Next tick at t=100 — INSIDE the 150ms interval. The old shape froze
      // the sentence tail here while the card rendered below it; the flush
      // must show the full sentence in the very render that mounts the card.
      clock = 100
      await render([text('Reading the config file done.'), toolUse('tu_1')])
      expect(p()).toContain('Reading the config file done.')
      // and the execution segment is on screen below the completed sentence
      expect(container.querySelector('[data-segment-head]')).not.toBeNull()
    } finally {
      await act(async () => { root.unmount(); await flush() })
      container.remove()
    }
  })
})

// The two production hosts compose the rule the harness above reproduces; a
// host that reverted to `show={isRequesting}` would blink two cursors again.
describe('wiring', () => {
  it('the chat foot cursor is retired — the live badge is the run indicator', () => {
    // 2026-11-21 user ruling: 「本回合已运行 X」就是会话进行中的指示，聊天
    // 脚部光标退役（徽章已覆盖 streaming/executing/retry/等待全状态）。负扫
    // 钉死不长回来；TranscriptView（工具 studio / 表单助手 / 例行转写——无
    // 徽章的宿主）保留光位与 hasLiveTextTail 门。同日第二刀：正文流式尾巴的
    // 内联 caret 也退役（渐变流式期间不要光标，见上面的 cursor per run phase）。
    const body = read(R('components', 'chat', 'ChatBody.tsx'))
    expect(body).not.toContain('<StreamingCursor')
    expect(body).toContain('data-pm-turn-elapsed')
    expect(read(R('components', 'layout', 'ChatView.tsx'))).not.toContain('showCursor')
    expect(read(R('components', 'chat', 'TranscriptView.tsx'))).toContain('show={isRequesting && !hasLiveTextTail(segments)}')
  })

  it('the live tail renders through x-markdown streaming mode with NO tail caret', () => {
    // 2026-11-13 step 2: the streaming config lives in the shared body now —
    // SegmentView no longer owns a streaming path of its own. 2026-11-21: the
    // in-text caret is retired — negative scans pin that no `tail` component
    // (and no StreamingCaret) can come back through this file.
    const src = read(R('components', 'chat', 'assistant-markdown.tsx'))
    expect(src).toContain('hasNextChunk: true, enableAnimation: true')
    expect(src).toContain('streaming={STREAMING_MD}')
    expect(src).not.toContain('STREAMING_MD_TAIL')
    expect(src).not.toContain("tail: { component:")
    expect(src).not.toContain('StreamingCaret')
    expect(src).toContain('a.shown === b.shown && a.streaming === b.streaming')
  })

  it('the tool-call flush rides buildSegments into the throttle feed', () => {
    expect(read(R('components', 'chat', 'message-segments.ts'))).toContain('toolsStarted: toolBlocks.length > 0')
    // `live` carries the signal across the boundary (2026-11-13 step 2):
    // buildSegments → SegmentView → MessageGroup → AssistantMarkdown.
    expect(read(R('components', 'chat', 'SegmentView.tsx'))).toContain('live={seg.live}')
    const body = read(R('components', 'chat', 'assistant-markdown.tsx'))
    expect(body).toContain('throttleRef.current.feed(text, performance.now(), live.toolsStarted === true)')
    // The tail pick (`lastLiveTextIndex` at the MessageGroup call site) is
    // retired with the in-text caret (2026-11-21) — pinned gone.
    expect(read(R('components', 'chat', 'MessageGroup.tsx'))).not.toContain('lastLiveTextIndex')
  })
})
