// The streaming→settled boundary is the one place a transcript row used to be
// torn down and rebuilt: the live tail carried the constant key 'streaming'
// and the message it became carries 's-<msgId>__text', so React saw a removal
// plus an insertion and SegmentBlock replayed its entrance animation — one
// visible refresh per finished paragraph (user report 2026-11-13).
//
// These cases pin the contract that closes it: the key the tail shows is the
// key the settled segment adopts, minted once per round, and an aborted round
// cannot strand or steal one.
import { describe, expect, it } from 'vitest'
import { buildSegments, createLiveKeys, getSegmentKey, type LiveKeys, type Segment } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage, ContentBlock, ToolUseBlock } from '../src/renderer/src/types/agent'

const textBlock = (text: string): ContentBlock => ({ type: 'text', text })

const msg = (id: string, role: 'user' | 'assistant', ...blocks: ContentBlock[]): AgentMessage => ({
  role,
  id,
  createdAt: '2026-11-13T00:00:00.000Z',
  contentBlocks: blocks,
})

/** One buildSegments call, with the per-view state threaded the way a host does. */
function render(opts: {
  messages: AgentMessage[]
  isStreaming: boolean
  streamingBlocks?: ContentBlock[]
  cached?: Segment[]
  liveKeys: LiveKeys
  accum?: Map<string, ToolUseBlock>
}): Segment[] {
  return buildSegments({
    messages: opts.messages,
    isStreaming: opts.isStreaming,
    streamingBlocks: opts.streamingBlocks ?? [],
    cached: opts.cached ?? [],
    streamingToolAccum: opts.accum ?? new Map(),
    liveKeys: opts.liveKeys,
  })
}

const tailKey = (segs: Segment[]): string => getSegmentKey(segs[segs.length - 1])

function settledTextKey(segs: Segment[], id: string): string | undefined {
  const seg = segs.find((s) => s.type === 'single' && s.msg.id === id)
  return seg ? getSegmentKey(seg) : undefined
}

describe('live tail key across the streaming→settled boundary', () => {
  it('hands the tail key to the settled text segment (the remount fix)', () => {
    const liveKeys = createLiveKeys()
    const user = msg('m1', 'user', textBlock('问题'))

    const streaming = render({ messages: [user], isStreaming: true, streamingBlocks: [textBlock('答')], liveKeys })
    expect(streaming[streaming.length - 1].type).toBe('single')
    const live = tailKey(streaming)

    // The round commits: the tail's text lands as a real message and the
    // streaming blocks are cleared, the turn still running.
    const commited = msg('m2', 'assistant', textBlock('答'))
    const settled = render({ messages: [user, commited], isStreaming: true, cached: streaming, liveKeys })

    expect(settledTextKey(settled, 'm2__text')).toBe(live)
    // …and the key is no longer the constant the old code used.
    expect(live).not.toBe('streaming')
  })

  it('adopts on the render that ends the turn (isStreaming already false)', () => {
    const liveKeys = createLiveKeys()
    const user = msg('m1', 'user', textBlock('问题'))
    const streaming = render({ messages: [user], isStreaming: true, streamingBlocks: [textBlock('答')], liveKeys })
    const live = tailKey(streaming)

    const commited = msg('m2', 'assistant', textBlock('答'))
    const settled = render({ messages: [user, commited], isStreaming: false, cached: streaming, liveKeys })
    expect(settledTextKey(settled, 'm2__text')).toBe(live)
  })

  it('mints a fresh key per round and leaves the earlier adoption pinned', () => {
    const liveKeys = createLiveKeys()
    const user = msg('m1', 'user', textBlock('问题'))
    const first = render({ messages: [user], isStreaming: true, streamingBlocks: [textBlock('答一')], liveKeys })
    const firstKey = tailKey(first)

    const a1 = msg('m2', 'assistant', textBlock('答一'))
    const afterFirst = render({ messages: [user, a1], isStreaming: true, cached: first, liveKeys })
    expect(settledTextKey(afterFirst, 'm2__text')).toBe(firstKey)

    // Round two streams its own tail: new key, not a reuse of round one's.
    const second = render({ messages: [user, a1], isStreaming: true, streamingBlocks: [textBlock('答二')], cached: afterFirst, liveKeys })
    const secondKey = tailKey(second)
    expect(secondKey).not.toBe(firstKey)

    const a2 = msg('m3', 'assistant', textBlock('答二'))
    const afterSecond = render({ messages: [user, a1, a2], isStreaming: true, cached: second, liveKeys })
    expect(settledTextKey(afterSecond, 'm3__text')).toBe(secondKey)
    // The first paragraph keeps what it adopted — adoption is not retroactive.
    expect(settledTextKey(afterSecond, 'm2__text')).toBe(firstKey)
  })

  it('carries the pending key over a round that lands no text segment', () => {
    const liveKeys = createLiveKeys()
    const user = msg('m1', 'user', textBlock('问题'))
    const streaming = render({ messages: [user], isStreaming: true, streamingBlocks: [textBlock('答')], liveKeys })
    const live = tailKey(streaming)

    // The round dies before committing anything (cancel / sentinel-stripped):
    // blocks vanish, no new message arrives. The pending key must survive…
    const afterAbort = render({ messages: [user], isStreaming: true, cached: streaming, liveKeys })
    expect(liveKeys.pending).toBe(live)
    expect(afterAbort.some((s) => s.type === 'single' && s.live !== undefined)).toBe(false)

    // …so the next round's tail reuses it and its own commit adopts it.
    const second = render({ messages: [user], isStreaming: true, streamingBlocks: [textBlock('答')], cached: afterAbort, liveKeys })
    expect(tailKey(second)).toBe(live)
    const commited = msg('m2', 'assistant', textBlock('答'))
    const settled = render({ messages: [user, commited], isStreaming: true, cached: second, liveKeys })
    expect(settledTextKey(settled, 'm2__text')).toBe(live)
  })

  it('keeps the old behaviour when a host passes no registry', () => {
    const user = msg('m1', 'user', textBlock('问题'))
    // Same segments, no liveKeys → the tail falls back to its constant key.
    const legacy = buildSegments({
      messages: [user],
      isStreaming: true,
      streamingBlocks: [textBlock('答')],
      cached: [],
      streamingToolAccum: new Map(),
    })
    // Without a registry the tail keeps a constant key derived from its
    // synthetic id (step 2: 's-streaming-text'), and the landing still changes
    // it — i.e. the old remounting behaviour, by design.
    expect(tailKey(legacy)).toBe('s-streaming-text')
    const legacyTail = legacy[legacy.length - 1]
    if (legacyTail.type !== 'single' || legacyTail.live === undefined) throw new Error('expected a live tail')
    expect(legacyTail.key).toBeUndefined()
  })
})

// The structural-sharing cache (buildSegments' prefix reuse via matchSegment)
// must treat a stats-only message change as a change. The terminal stamp
// (shared/agent-session/message-stats.ts) patches the answer message's stats
// IN PLACE after append — the turn total replacing that round's own stream
// time — and the mirror fold delivers it as a NEW message object. A cache
// keyed only by (id, tool_use statuses) reused the old segment object, so
// React.memo skipped the stats row forever: an 17.8min turn read as its last
// round's 16.4s on screen while the DB already held the total
// (conv_20261116210413, 用户反馈 2026-11-16「显示的处理时间才16.4s」).
describe('segment cache vs the terminal stats stamp', () => {
  const stats = (processingMs?: number, inputTokens?: number, outputTokens?: number, promptCacheHitTokens?: number) =>
    ({ processingMs, inputTokens, outputTokens, promptCacheHitTokens })

  it('the stamp reaches the segment MessageGroup renders', () => {
    const final = msg('m_final', 'assistant', textBlock('答案'))
    Object.assign(final, stats(16_400, 65_237, 980, 62_592))
    const prev = msg('m_prev', 'assistant', textBlock('上一轮'))
    Object.assign(prev, stats(28_553))

    const first = buildSegments({
      messages: [prev, final], isStreaming: false, streamingBlocks: [],
      cached: [], streamingToolAccum: new Map(),
    })
    const idx = first.findIndex((s) => s.type === 'single' && s.msg.id === 'm_final__text')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(first[idx].msg.processingMs).toBe(16_400) // the per-round value painted live

    // Turn closes: the mirror fold replaces the message object (new array).
    const patched = { ...final, ...stats(1_069_290) }
    const second = buildSegments({
      messages: [prev, patched], isStreaming: false, streamingBlocks: [],
      cached: first, streamingToolAccum: new Map(),
    })
    expect(second[idx].msg.processingMs).toBe(1_069_290) // ❌ was 16400 before the fix
  })

  it('genuinely unchanged messages still reuse the cache', () => {
    const prev = msg('m_prev', 'assistant', textBlock('上一轮'))
    Object.assign(prev, stats(28_553, 60_000, 1_200, 58_000))
    const final = msg('m_final', 'assistant', textBlock('答案'))
    Object.assign(final, stats(16_400))

    const first = buildSegments({
      messages: [prev, final], isStreaming: false, streamingBlocks: [],
      cached: [], streamingToolAccum: new Map(),
    })
    const second = buildSegments({
      messages: [prev, final], isStreaming: false, streamingBlocks: [],
      cached: first, streamingToolAccum: new Map(),
    })
    // Same objects, same stats → the prefix cache still hits (React.memo can skip).
    expect(second[0]).toBe(first[0])
  })
})
