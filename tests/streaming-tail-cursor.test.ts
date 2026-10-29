// @vitest-environment jsdom
// The streaming tail (2026-10-26): the live text renders through x-markdown's
// streaming mode (hasNextChunk holds unclosed tokens back, enableAnimation
// fades in each refresh's new text) and carries the transcript caret at its
// end as the `tail` component. The user's one condition — 不要出现两个光标 — is
// the invariant pinned here through the REAL components (no x-markdown mock):
// the foot StreamingCursor and the in-text tail draw the same StreamingCaret,
// both tagged data-streaming-cursor, so counting that attribute across a host
// that composes them the way ChatView/TranscriptView do must read exactly one
// during a run — inside the markdown while text streams, at the foot while the
// loop works without text (thinking, tool rounds) — and zero once settled.
// createElement, not JSX — vitest here runs plain .ts through esbuild.
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

  it('is true only for a streaming segment carrying text', () => {
    expect(hasLiveTextTail([{ type: 'streaming', blocks: [text('hi')] }])).toBe(true)
    expect(hasLiveTextTail([{ type: 'streaming', blocks: [text('')] }])).toBe(false)
    expect(hasLiveTextTail([{ type: 'execution', msgs: [{ id: 'streaming-think', role: 'assistant', createdAt: '', contentBlocks: [thinking('…')] }] }])).toBe(false)
    expect(hasLiveTextTail([])).toBe(false)
  })

  it('is false once the round\'s tool call has begun — the finished text yields to the foot', () => {
    expect(hasLiveTextTail([{ type: 'streaming', blocks: [text('done narrating')], toolsStarted: true }])).toBe(false)
  })
})

describe('one cursor per run', () => {
  it('streaming text: the caret sits at the end of the text, the foot draws none', async () => {
    const m = await mount([text('Hello **world**')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.inText(carets[0])).toBe(true)
      expect(m.atFoot(carets[0])).toBe(false)
      // The tail follows the last text token, inside the paragraph.
      expect(carets[0].closest('p')).not.toBeNull()
    } finally { await m.close() }
  })

  it('thinking only: the caret stays at the foot', async () => {
    const m = await mount([thinking('weighing options')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('an opened but still empty text block has not taken the caret over yet', async () => {
    const m = await mount([text('')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('two text blocks: only the last one with text carries the caret', async () => {
    const m = await mount([text('first'), text('second')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      const roots = [...m.container.querySelectorAll('.x-markdown')]
      expect(roots).toHaveLength(2)
      expect(roots[1].contains(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('the caret moves from the foot into the text as the first token lands, and goes out when settled', async () => {
    const m = await mount([thinking('…')])
    try {
      expect(m.atFoot(m.carets()[0])).toBe(true)
      await m.render([thinking('…'), text('Answer')])
      const live = m.carets()
      expect(live).toHaveLength(1)
      expect(m.inText(live[0])).toBe(true)
      await m.render([], false)
      expect(m.carets()).toHaveLength(0)
    } finally { await m.close() }
  })

  // 2026-10-28 report: the caret used to stay parked at the end of the
  // completed narration while the tool card ran below it. The round lifecycle
  // is foot → in-text → foot, with exactly one caret at every stage.
  it('the caret yields back to the foot when the round moves on to its tool call', async () => {
    const m = await mount([text('Done narrating.'), toolUse('tu_1')])
    try {
      const carets = m.carets()
      expect(carets).toHaveLength(1)
      expect(m.inText(carets[0])).toBe(false)
      expect(m.atFoot(carets[0])).toBe(true)
    } finally { await m.close() }
  })

  it('full round lifecycle: foot while thinking, in-text while text streams, foot once the tool call begins', async () => {
    const m = await mount([thinking('…')])
    try {
      expect(m.atFoot(m.carets()[0])).toBe(true)
      await m.render([thinking('…'), text('Answer text')])
      expect(m.inText(m.carets()[0])).toBe(true)
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
// tool_use presence as `toolsStarted` on the streaming segment; StreamingText
// force-feeds its throttle with it.
describe('tool-call flush signal', () => {
  it('buildSegments stamps toolsStarted from the round\'s tool_use presence', () => {
    const build = (blocks: ContentBlock[]): Segment[] =>
      buildSegments({ messages: [], isStreaming: true, streamingBlocks: blocks, cached: [], streamingToolAccum: new Map() })
    const textOnly = build([text('narration')])
    expect(textOnly[textOnly.length - 1]).toMatchObject({ type: 'streaming', toolsStarted: false })
    const withTool = build([text('narration'), toolUse('tu_1')])
    const streamingSeg = withTool.find((s) => s.type === 'streaming')
    expect(streamingSeg).toMatchObject({ type: 'streaming', toolsStarted: true })
    // thinking + tool, no text: no streaming segment exists to stamp
    expect(build([thinking('…'), toolUse('tu_2')]).some((s) => s.type === 'streaming')).toBe(false)
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
  it('both transcript hosts gate the foot cursor on hasLiveTextTail', () => {
    expect(read(R('components', 'layout', 'ChatView.tsx'))).toContain('show={isRequesting && !hasLiveTextTail(allSegments)}')
    expect(read(R('components', 'chat', 'TranscriptView.tsx'))).toContain('show={isRequesting && !hasLiveTextTail(segments)}')
  })

  it('the live tail renders through x-markdown streaming mode with the shared caret as its tail', () => {
    const src = read(R('components', 'chat', 'SegmentView.tsx'))
    expect(src).toContain('hasNextChunk: true, enableAnimation: true')
    expect(src).toContain('tail: { component: StreamingTail }')
    expect(src).toContain('streaming={tail ? STREAMING_MD_TAIL : STREAMING_MD}')
    expect(src).toContain('a.shown === b.shown && a.tail === b.tail')
  })

  it('the tool-call flush rides buildSegments into the throttle feed', () => {
    expect(read(R('components', 'chat', 'message-segments.ts'))).toContain('toolsStarted: toolBlocks.length > 0')
    const view = read(R('components', 'chat', 'SegmentView.tsx'))
    expect(view).toContain('toolsStarted={seg.toolsStarted === true}')
    expect(view).toContain('throttle.feed(block.text, performance.now(), toolsStarted === true)')
    // the same signal yields the in-text tail (hasLiveTextTail agrees, so the
    // foot caret takes over in the same render — still one cursor)
    expect(view).toContain('tail={i === tailIndex && toolsStarted !== true}')
  })
})
