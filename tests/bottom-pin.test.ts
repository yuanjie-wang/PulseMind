import { describe, it, expect, vi } from 'vitest'
import { startBottomPin } from '../src/renderer/src/utils/bottom-pin'

// ── Test doubles ──

/** Structural scroll container; records the input listeners the pin attaches. */
class FakeEl {
  scrollTop = 0
  listeners = new Map<string, Set<() => void>>()

  constructor(
    public scrollHeight = 1000,
    public clientHeight = 500
  ) {}

  addEventListener(type: string, handler: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: () => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  fire(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler()
  }
}

/** Manual timer queue: callbacks fire on pump(), respecting a virtual clock. */
function makeScheduler() {
  const queue: Array<{ cb: () => void }> = []
  return {
    schedule: (cb: () => void) => {
      queue.push({ cb })
      return queue.length
    },
    cancel: () => {
      queue.length = 0
    },
    pump() {
      const cbs = queue.splice(0)
      for (const q of cbs) q.cb()
    },
    get pending() {
      return queue.length
    }
  }
}

// ── Tests ──

describe('startBottomPin', () => {
  it('scrolls to the bottom immediately', () => {
    const el = new FakeEl()
    const cancel = startBottomPin(() => el, { schedule: makeScheduler().schedule })
    expect(el.scrollTop).toBe(500) // scrollHeight - clientHeight
    cancel()
  })

  it('re-scrolls whenever the content grows (markdown/images fill in later)', () => {
    const el = new FakeEl(1000)
    const s = makeScheduler()
    const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel })
    expect(el.scrollTop).toBe(500)

    el.scrollHeight = 4000
    s.pump()
    expect(el.scrollTop).toBe(3500)

    el.scrollHeight = 9000
    s.pump()
    expect(el.scrollTop).toBe(8500)
    cancel()
  })

  it('keeps retrying while the element is missing (container unmount/remount)', () => {
    let el: FakeEl | null = new FakeEl(2000)
    const s = makeScheduler()
    const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel, timeoutMs: 10_000 })
    expect(el.scrollTop).toBe(1500)

    // Container tears down mid-flight: the pin must not give up.
    el = null
    s.pump()
    expect(s.pending).toBe(1)

    // …and it must land the newly mounted container at the bottom.
    el = new FakeEl(6000)
    s.pump()
    expect(el.scrollTop).toBe(5500)
    cancel()
  })

  it('stops when the user scrolls with the wheel, without fighting them', () => {
    const el = new FakeEl(4000)
    const s = makeScheduler()
    const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel })
    expect(el.scrollTop).toBe(3500)

    el.scrollTop = 100 // user scrolls up
    el.fire('wheel')
    el.scrollHeight = 5000
    s.pump()
    expect(el.scrollTop).toBe(100) // left alone
    expect(s.pending).toBe(0)
    cancel()
  })

  it('stops on touch, pointer and key input too', () => {
    for (const type of ['touchstart', 'pointerdown', 'keydown']) {
      const el = new FakeEl(2000)
      const s = makeScheduler()
      const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel })
      el.scrollTop = 100 // user takes over
      el.fire(type)
      el.scrollHeight = 8000
      s.pump()
      expect(el.scrollTop).toBe(100)
      expect(s.pending).toBe(0)
      cancel()
    }
  })

  it('stops once the height has been quiet for quietMs', () => {
    const el = new FakeEl(1000)
    let t = 0
    const s = makeScheduler()
    startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel, now: () => t, quietMs: 300, pollMs: 100 })

    t = 100
    s.pump()
    expect(s.pending).toBe(1) // still armed
    t = 500 // > 300ms since the last height change
    s.pump()
    expect(s.pending).toBe(0)
  })

  it('gives up at the deadline even if the height never settles', () => {
    const el = new FakeEl()
    let t = 0
    const s = makeScheduler()
    startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel, now: () => t, timeoutMs: 1000, quietMs: 5000 })
    for (let i = 0; i < 20; i++) {
      t += 100
      el.scrollHeight += 500
      s.pump()
    }
    expect(s.pending).toBe(0)
  })

  it('notifies onStop exactly once when it settles', () => {
    const el = new FakeEl()
    let t = 0
    const s = makeScheduler()
    const onStop = vi.fn()
    startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel, now: () => t, quietMs: 100, pollMs: 100, onStop })
    t = 500
    s.pump()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('notifies onStop when the caller cancels (release of the viewport)', () => {
    const el = new FakeEl()
    const s = makeScheduler()
    const onStop = vi.fn()
    const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel, onStop })
    cancel()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('cancel() detaches input listeners and stops the loop', () => {
    const el = new FakeEl(2000)
    const s = makeScheduler()
    const cancel = startBottomPin(() => el, { schedule: s.schedule, cancel: s.cancel })
    expect(el.listeners.get('wheel')?.size).toBe(1)
    cancel()
    expect(el.listeners.get('wheel')?.size).toBe(0)
    s.pump()
    expect(s.pending).toBe(0)
  })
})
