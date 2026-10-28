// PLAN-long-task-perf M1-T3 — the streaming text throttle's state machine.
// Pure logic (clock injected), so node-env vitest drives it directly; the
// SegmentView wiring is a three-line useRef+feed and its behaviour is judged
// by probe-chat-stream-perf's growth curve.
import { describe, expect, it } from 'vitest'
import { createTextThrottle } from '../src/renderer/src/components/chat/stream-throttle'

describe('stream text throttle (M1-T3)', () => {
  it('lets the first snapshot through immediately', () => {
    const t = createTextThrottle(150)
    expect(t.feed('hello', 0)).toBe('hello')
  })

  it('holds a fresher text back inside the interval, and the frozen tail is a prefix of the live text', () => {
    const t = createTextThrottle(150)
    t.feed('hello,', 0)
    expect(t.feed('hello, wor', 100)).toBe('hello,') // 100 < 150 — frozen
  })

  it('advances to the LATEST text once the interval has elapsed (trailing coalesce)', () => {
    const t = createTextThrottle(150)
    t.feed('a', 0)
    expect(t.feed('ab', 100)).toBe('a')
    expect(t.feed('abcdef', 160)).toBe('abcdef') // one render, latest text
  })

  it('feeds at the throttled cadence keep advancing (long stream, many ticks)', () => {
    const t = createTextThrottle(150)
    let text = ''
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      text += 'x'
      const shown = t.feed(text, i * 80)
      if (i === 0 || i % 2 === 0) seen.add(shown) // at 80ms ticks, every other tick may advance
    }
    // 20 ticks at 80ms = 1600ms ≥ 150ms window → at least ~10 distinct renders
    expect(seen.size).toBeGreaterThanOrEqual(10)
  })

  it('feed is idempotent for the shown text (StrictMode double render cannot advance the clock)', () => {
    const t = createTextThrottle(150)
    t.feed('hello', 0)
    expect(t.feed('hello', 10)).toBe('hello')
    expect(t.feed('hello', 10)).toBe('hello')
    // the clock was NOT advanced by the no-op feeds: 150ms is still the gate
    expect(t.feed('hello world', 149)).toBe('hello')
    expect(t.feed('hello world', 150)).toBe('hello world')
  })

  it('reset drops the frozen snapshot (a new stream starts fresh)', () => {
    const t = createTextThrottle(150)
    t.feed('old stream tail', 0)
    t.reset()
    expect(t.feed('new stream', 10)).toBe('new stream')
  })
})

// The tool-call flush (2026-10-28 report): an execution segment mounting below
// the sentence must not outrun the sentence's frozen tail, so the boundary
// feed carries force and the gate opens whatever the clock says.
describe('stream text throttle force flush', () => {
  it('force advances past the interval gate immediately', () => {
    const t = createTextThrottle(150)
    t.feed('hello,', 0)
    expect(t.feed('hello, world', 100, true)).toBe('hello, world') // 100 < 150 — force wins
  })

  it('a forced advance re-arms the clock: the normal cadence resumes from the flush', () => {
    const t = createTextThrottle(150)
    t.feed('a', 0)
    t.feed('ab', 10, true)
    expect(t.feed('abc', 100)).toBe('ab') // 100 - 10 < 150 — frozen again
    expect(t.feed('abcd', 160)).toBe('abcd')
  })

  it('force stays idempotent for the shown text (tool-args phase feeds change nothing)', () => {
    const t = createTextThrottle(150)
    t.feed('complete sentence', 0)
    expect(t.feed('complete sentence', 10, true)).toBe('complete sentence')
    // the no-op did not advance the clock either
    expect(t.feed('complete sentence!', 100)).toBe('complete sentence')
    expect(t.feed('complete sentence!', 150)).toBe('complete sentence!')
  })
})
