import { describe, expect, it } from 'vitest'
import { createTailFollow, type TailFollowTarget, type TailInputEvent } from '../src/shared/tail-follow'

/** A scroll container with real clamping and a manual event/ frame pump. */
class FakeEl implements TailFollowTarget {
  scrollTop = 0
  scrollHeight = 1000
  clientHeight = 400
  scrolling: Array<{ top: number; behavior?: string }> = []
  private handlers = new Map<string, Array<(ev: TailInputEvent) => void>>()

  get maxTop(): number {
    return Math.max(0, this.scrollHeight - this.clientHeight)
  }
  /** Grow the document the way a streaming transcript does. */
  grow(by: number): void {
    this.scrollHeight += by
  }
  setTop(top: number): void {
    this.scrollTop = Math.min(Math.max(0, top), this.maxTop)
  }
  scrollTo(opts: { top: number; behavior?: 'auto' | 'smooth' }): void {
    this.scrolling.push(opts)
    this.setTop(opts.top)
  }
  addEventListener(type: string, handler: (ev: TailInputEvent) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }
  removeEventListener(type: string, handler: (ev: TailInputEvent) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== handler))
  }
  emit(type: string, ev: TailInputEvent = {}): void {
    for (const handler of this.handlers.get(type) ?? []) handler(ev)
  }
  listenerCount(type: string): number {
    return (this.handlers.get(type) ?? []).length
  }
}

interface Harness {
  el: FakeEl
  follow: ReturnType<typeof createTailFollow>
  flips: boolean[]
  frames: (n?: number) => void
  clock: { t: number }
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const el = new FakeEl()
  const queue: Array<() => void> = []
  const flips: boolean[] = []
  const clock = { t: 0 }
  const follow = createTailFollow(() => el, {
    onFollowingChange: (f) => flips.push(f),
    schedule: (cb) => {
      queue.push(cb)
      return queue.length
    },
    cancel: () => {
      queue.length = 0
    },
    now: () => clock.t,
    ...overrides,
  })
  // Hosts always attach; tests that exercise detach() do it explicitly.
  follow.attach(el)
  const frames = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      const pending = queue.splice(0)
      for (const cb of pending) cb()
    }
  }
  return { el, follow, flips, frames, clock }
}

/** One commit of streaming output: the document grows, then the host settles. */
function commit(ctx: Harness, by: number): void {
  ctx.el.grow(by)
  ctx.follow.settle()
}

/**
 * The settle loop only runs when the HOST reports a commit. Child components grow
 * the DOM on their own — an XMarkdown body, a code block, an ask-user card laying
 * out its rows after the first paint — without re-rendering ChatView, so nothing
 * reports it and no loop is even alive to notice. That is the case that left the
 * view short of the tail in a running conversation and under an ask-user prompt
 * (user 2026-11-17 反馈：ask user 在底部、进行中的会话这两类仍不跟随).
 */
describe('tail-follow / growth that no commit reports', () => {
  /** A size watcher the test fires by hand, standing in for ResizeObserver. */
  function watched(): { ctx: Harness; resize: () => void; disposed: () => boolean } {
    let fire: (() => void) | null = null
    let disposed = false
    const ctx = harness({
      observeSize: (_el: TailFollowTarget, onChange: () => void) => {
        fire = onChange
        return () => {
          disposed = true
        }
      },
    })
    return { ctx, resize: () => fire?.(), disposed: () => disposed }
  }

  it('keeps the tail when content grows with no host commit', () => {
    const { ctx, resize } = watched()
    ctx.el.setTop(ctx.el.maxTop)
    expect(ctx.follow.gap()).toBe(0)

    ctx.el.grow(300) // async markdown lands — the host never calls settle()
    expect(ctx.follow.gap()).toBe(300)

    resize()
    ctx.frames()
    expect(ctx.follow.gap()).toBe(0)
  })

  it('re-arms after the settle loop already gave up', () => {
    const { ctx, resize } = watched()
    ctx.el.setTop(ctx.el.maxTop)
    commit(ctx, 100)
    ctx.frames(60) // well past quietFrames (24) — the loop is dead by now
    ctx.el.grow(400)
    expect(ctx.follow.gap()).toBe(400)

    resize()
    ctx.frames()
    expect(ctx.follow.gap()).toBe(0)
  })

  it('does not follow such growth once the user took over', () => {
    const { ctx, resize } = watched()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('wheel', { deltaY: -200 })
    ctx.el.setTop(200)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)

    ctx.el.grow(300)
    resize()
    ctx.frames()
    expect(ctx.el.scrollTop).toBe(200) // left exactly where the reader put it
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('disposes the size watcher on dispose', () => {
    const { ctx, disposed } = watched()
    expect(disposed()).toBe(false)
    ctx.follow.dispose() // detach() runs inside — the watcher must not outlive it
    expect(disposed()).toBe(true)
  })
})

describe('tail-follow / following while content grows', () => {
  it('snaps to the tail on every frame the height changes', () => {
    const ctx = harness()
    ctx.el.setTop(600)
    expect(ctx.follow.isFollowing()).toBe(true)

    commit(ctx, 500)
    // settle 的同步 pre-paint snap：报告生长的当帧就已贴底，不等帧泵。
    expect(ctx.follow.gap()).toBe(0)
    expect(ctx.el.scrollTop).toBe(1100)
    // 循环仍负责无人报告的生长：直接改高、再泵帧，照样跟上。
    ctx.el.grow(200)
    ctx.frames()
    expect(ctx.el.scrollTop).toBe(1300)
    expect(ctx.follow.gap()).toBe(0)
  })

  it('settle pins the tail synchronously, before any scheduled frame (2026-11-21 pre-paint snap)', () => {
    // user report「执行过程中徽章上下跳」：settle 的调用点（宿主 commit 的
    // layout effect、ResizeObserver/MutationObserver 回调）全部跑在下一次
    // paint 之前——修正必须在调用帧内落盘。回退成「只排帧」的话，生长帧会
    // 以旧 offset 画出来（尾部下坠一帧、下一帧弹回），徽章按流式拍频上下跳。
    const ctx = harness()
    ctx.el.setTop(600)
    ctx.el.grow(120)
    ctx.follow.settle()
    // 一帧都还没泵：尾部必须已经钉住（这就是 pre-paint 的含义）。
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
    expect(ctx.follow.gap()).toBe(0)
    // 循环仍在按调度跑，但已贴底——幂等，不再移动。
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
  })

  it('settle respects the jump hold window — the smooth landing wins', () => {
    // jump() 的 hold 窗口里 settle 不得硬 snap（会把 smooth 动画拽成瞬移）。
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.jump()
    expect(ctx.el.scrolling).toHaveLength(1)
    const writes = ctx.el.scrollTop
    ctx.el.grow(80)
    ctx.follow.settle() // hold 窗口内
    expect(ctx.el.scrollTop).toBe(writes)
  })

  it('keeps following through a growth step larger than any threshold', () => {
    // The old geometric rule gave up past 100px in one commit; the intent rule
    // must not care how far the tail moved.
    const ctx = harness()
    for (let i = 0; i < 6; i += 1) {
      commit(ctx, 400)
      ctx.frames(2)
    }
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
    expect(ctx.flips).toEqual([])
  })

  it('stops the settle loop after the height goes quiet', () => {
    const ctx = harness({ quietFrames: 3 })
    commit(ctx, 100)
    ctx.frames(1)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
    ctx.frames(10)
    // No further snapping once quiet — a user scroll is honoured afterwards.
    ctx.el.setTop(200)
    ctx.el.emit('wheel', { deltaY: -120 })
    ctx.el.emit('scroll')
    ctx.frames(5)
    expect(ctx.el.scrollTop).toBe(200)
  })

  it('does not fight growth that lands after the frame it was reported for', () => {
    const ctx = harness()
    commit(ctx, 100)
    ctx.frames(1)
    ctx.el.grow(250) // e.g. a late Markdown body
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
  })
})

describe('tail-follow / user intent', () => {
  it('releases on the first wheel-up, with no magnetic band', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)

    ctx.el.emit('wheel', { deltaY: -10 })
    expect(ctx.follow.isFollowing()).toBe(false)
    expect(ctx.flips).toEqual([false])

    // A 3px drift would have been inside the old 100px band and snapped back.
    ctx.el.setTop(ctx.el.maxTop - 3)
    const parked = ctx.el.scrollTop
    ctx.el.emit('scroll')
    commit(ctx, 300)
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(parked)
  })

  it('releases even when the user is only a few px from the tail', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -1 })
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('ignores wheel-down: scrolling toward the tail is not a takeover', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: 240 })
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('releases on PageUp / ArrowUp / Home / Shift+Space', () => {
    for (const key of ['PageUp', 'ArrowUp', 'Home']) {
      const ctx = harness()
      ctx.follow.attach(ctx.el)
      ctx.el.emit('keydown', { key })
      expect(ctx.follow.isFollowing(), key).toBe(false)
    }
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.el.emit('keydown', { key: ' ', shiftKey: true })
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('ignores keys that do not scroll back', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    for (const key of ['ArrowDown', 'PageDown', 'a', ' ']) ctx.el.emit('keydown', { key })
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('releases when a touch drags the content down', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.el.emit('touchstart', { touches: [{ clientY: 300 }] })
    ctx.el.emit('touchmove', { touches: [{ clientY: 301 }] }) // inside the slop
    expect(ctx.follow.isFollowing()).toBe(true)
    ctx.el.emit('touchmove', { touches: [{ clientY: 340 }] })
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('ignores a touch that drags the content up', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.el.emit('touchstart', { touches: [{ clientY: 300 }] })
    ctx.el.emit('touchmove', { touches: [{ clientY: 120 }] })
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('tolerates events without the fields it reads', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.el.emit('touchstart')
    ctx.el.emit('touchmove')
    ctx.el.emit('touchmove', { touches: [{ clientY: 500 }] })
    ctx.el.emit('keydown', {})
    ctx.el.emit('wheel', {})
    expect(ctx.follow.isFollowing()).toBe(true)
  })
})

describe('tail-follow / our own writes are not a takeover', () => {
  it('does not release on the scroll event our own snap provokes', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.snap()
    // The browser clamps the write and then reports it back.
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)

    ctx.el.grow(300)
    ctx.el.emit('scroll') // event still on the recorded write
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('keeps up when growth lands between the write and its scroll event', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.snap()
    ctx.el.grow(700)
    ctx.el.emit('scroll')
    expect(ctx.follow.gap()).toBe(0)
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('releases when a scrollbar drag moves above our own write', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.snap()
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)

    ctx.el.setTop(ctx.el.maxTop - 200) // no wheel event — a dragged thumb
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('does not release when the document shrinks and clamps the view', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.snap()
    ctx.el.emit('scroll')

    // A tool block collapsing above the fold pulls scrollTop down with it.
    ctx.el.scrollHeight -= 300
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
  })
})

describe('tail-follow / reattaching', () => {
  it('reattaches when the user scrolls back to the tail', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    ctx.el.emit('wheel', { deltaY: -200 })
    expect(ctx.follow.isFollowing()).toBe(false)

    ctx.el.setTop(200)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)

    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([false, true])
  })

  // user 2026-11-13 第二次反馈：流式输出中手动滚回底部，回到底部按钮仍不消失。
  // 成因：证据只在「我确实在写」时才该用来解释事件。流式时 settle 每帧 snap、
  // 每帧记一条新鲜证据，用户回到尾部的位置总能命中一条，被当成自家回声直接
  // return，永远走不到下面的 reattach——following 卡在 false，按钮因此常亮。
  it('a proof recorded while following cannot swallow the way back after release', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.el.emit('scroll')

    // Streaming: the document grows, the engine glues to the new tail and records
    // a proof at exactly that offset.
    ctx.el.grow(400)
    ctx.follow.settle()
    ctx.frames(5)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
    expect(ctx.follow.isFollowing()).toBe(true)

    // The user takes over and scrolls up.
    ctx.el.emit('wheel', { deltaY: -200 })
    expect(ctx.follow.isFollowing()).toBe(false)
    ctx.el.setTop(600)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)

    // Back to the tail, still INSIDE the proof's TTL — the clock never advances
    // here, so only gating the proof on `following` lets this reattach through.
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([false, true])
  })

  it('does not reattach while the view is still away from the tail', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -200 })

    ctx.el.setTop(ctx.el.maxTop - 40)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('does not reattach when a shrinking document lands the view at the tail', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -200 })
    expect(ctx.follow.isFollowing()).toBe(false)

    ctx.el.scrollHeight -= 350 // the away-position is now the tail
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  // user 2026-11-13 反馈：手动滚动到底部后，回到底部按钮还在。
  // 成因：把「我写过的位置」当成永久白名单，用户自己滚回尾巴那一次正好落在
  // 旧写入的位置上，被当成自家回声而忽略，following 永不回到 true。
  it('reattaches when the user returns to a tail offset we wrote earlier', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.snap() // writes the tail and records a proof…
    // …whose own scroll event never arrives (coalesced), then the user takes over.
    ctx.el.emit('wheel', { deltaY: -200 })
    expect(ctx.follow.isFollowing()).toBe(false)

    ctx.el.setTop(200)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)

    // Well past the window in which that write could still be echoing.
    ctx.clock.t = 1000
    ctx.el.setTop(ctx.el.maxTop) // manual scroll back to the bottom
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([false, true])
  })

  it('spends a write proof on the single event it explains', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.snap() // proof recorded at the tail
    ctx.el.emit('scroll') // its echo — spent here
    expect(ctx.follow.isFollowing()).toBe(true)

    ctx.el.emit('wheel', { deltaY: -200 })
    ctx.el.setTop(200)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(false)

    // The clock never advances here: only spending the proof can let this
    // reattach through, so the TTL cannot mask a broken whitelist.
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('records no proof when a snap moves nothing', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop) // already at the tail
    ctx.follow.snap() // no scrollTop change → no event → nothing to vouch for
    ctx.el.emit('wheel', { deltaY: -200 })

    ctx.el.setTop(200)
    ctx.el.emit('scroll')
    ctx.el.setTop(ctx.el.maxTop)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('resume() reattaches and snaps, even from far away', () => {
    const ctx = harness()
    ctx.el.setTop(0)
    ctx.follow.release()
    ctx.follow.resume()
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
    expect(ctx.flips).toEqual([false, true])
  })

  it('resume()/release() are idempotent in their notifications', () => {
    const ctx = harness()
    ctx.follow.resume()
    ctx.follow.resume()
    ctx.follow.release()
    ctx.follow.release()
    expect(ctx.flips).toEqual([false])
  })
})

/**
 * The stranded tail (2026-11-22 user report: 滚动到底部后回到底部按钮不消失).
 * Released at the exact tail, no scroll event can ever carry the reattach —
 * the condition needs a move TOWARD the tail and the view cannot move further
 * down. Two escapes: the wheel-down intent press, and the quiet dwell.
 */
describe('tail-follow / stranded at the tail', () => {
  /** Release while parked at the very tail, the way a micro wheel-up does. */
  function stranded(harnessOverrides: Record<string, unknown> = {}): Harness {
    const ctx = harness(harnessOverrides)
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -1 })
    expect(ctx.follow.isFollowing()).toBe(false)
    return ctx
  }

  it('a wheel-down within reattachPx reattaches a released view instantly', () => {
    const ctx = stranded()
    ctx.el.emit('wheel', { deltaY: 240 })
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([false, true])
  })

  it('a wheel-down away from the tail does not reattach', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop - 300)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -120 })
    expect(ctx.follow.isFollowing()).toBe(false)
    ctx.el.emit('wheel', { deltaY: 240 })
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('a wheel-down does not reattach while following (still not a takeover)', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: 240 })
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([])
  })

  it('sitting quiet at the tail re-grabs follow after the dwell', () => {
    const ctx = stranded()
    // 600ms of quiet frames: short of the dwell, still released.
    ctx.clock.t = 600
    ctx.frames(4)
    expect(ctx.follow.isFollowing()).toBe(false)
    ctx.clock.t = 1300
    ctx.frames(4)
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([false, true])
    // The re-grab owns the tail again: growth snaps down.
    commit(ctx, 200)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
  })

  it('input activity defers the dwell', () => {
    const ctx = stranded()
    ctx.clock.t = 600
    ctx.frames(4)
    // A wheel-up 600ms in (the already-released no-op path) restarts the quiet clock.
    ctx.el.emit('wheel', { deltaY: -10 })
    ctx.clock.t = 1500
    ctx.frames(4)
    expect(ctx.follow.isFollowing()).toBe(false)
    ctx.clock.t = 2800
    ctx.frames(4)
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('sitting quiet away from the tail never re-grabs; returning to the tail does', () => {
    const ctx = harness()
    ctx.el.setTop(ctx.el.maxTop - 300)
    ctx.follow.attach(ctx.el)
    ctx.el.emit('wheel', { deltaY: -120 })
    ctx.clock.t = 5000
    ctx.frames(6)
    expect(ctx.follow.isFollowing()).toBe(false)
    // The user scrolls back to the tail and rests: dwell completes.
    ctx.el.setTop(ctx.el.maxTop)
    ctx.clock.t = 5400
    ctx.frames(6)
    expect(ctx.follow.isFollowing()).toBe(false)
    ctx.clock.t = 6700
    ctx.frames(6)
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('an actively-scrolling reader inside the dwell zone is not grabbed', () => {
    const ctx = stranded()
    // Scroll events (even tiny ones) keep refreshing the quiet mark.
    for (let i = 1; i <= 8; i += 1) {
      ctx.clock.t = i * 400
      ctx.el.setTop(ctx.el.maxTop - i * 10)
      ctx.el.emit('scroll')
      ctx.frames(2)
      expect(ctx.follow.isFollowing(), `step ${i}`).toBe(false)
    }
  })

  it('dispose() stops the dwell loop', () => {
    const ctx = stranded()
    ctx.follow.dispose()
    ctx.clock.t = 5000
    ctx.frames(4)
    expect(ctx.follow.isFollowing()).toBe(false)
    expect(ctx.flips).toEqual([false])
  })
})

describe('tail-follow / jump and hold', () => {
  it('jump() smooth-scrolls to the tail and suppresses logic while animating', () => {
    const ctx = harness({ jumpHoldMs: 200 })
    ctx.el.setTop(0)
    ctx.follow.attach(ctx.el)
    ctx.follow.jump()

    expect(ctx.el.scrolling).toEqual([{ top: ctx.el.maxTop, behavior: 'smooth' }])
    expect(ctx.follow.isFollowing()).toBe(true)

    // The animation reports intermediate positions; none may release it.
    ctx.el.setTop(100)
    ctx.el.emit('scroll')
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('keeps the tail once the jump hold expires, even if growth continued', () => {
    const ctx = harness({ jumpHoldMs: 100 })
    ctx.el.setTop(0)
    ctx.follow.jump()
    ctx.el.grow(600) // grew while the animation ran
    ctx.frames(3)
    ctx.clock.t = 400
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
  })

  it('hold(true) freezes snapping, hold(false) resumes it', () => {
    const ctx = harness()
    ctx.follow.hold(true)
    commit(ctx, 400)
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(0)

    ctx.follow.hold(false)
    ctx.frames(2)
    expect(ctx.el.scrollTop).toBe(ctx.el.maxTop)
  })

  it('hold(true) still lets the user take over', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.follow.hold(true)
    ctx.el.emit('wheel', { deltaY: -50 })
    expect(ctx.follow.isFollowing()).toBe(false)
  })

  it('hold(false) after a release does not re-grab the view', () => {
    const ctx = harness()
    ctx.follow.release()
    ctx.follow.hold(false)
    commit(ctx, 400)
    ctx.frames(3)
    expect(ctx.el.scrollTop).toBe(0)
  })
})

describe('tail-follow / element lifecycle', () => {
  it('survives a missing element', () => {
    const follow = createTailFollow(() => null, { schedule: (cb) => (cb(), 1), cancel: () => {} })
    expect(() => {
      follow.snap()
      follow.settle()
      follow.onScroll()
      follow.jump()
      follow.resume()
      follow.release()
    }).not.toThrow()
    expect(follow.gap()).toBe(0)
  })

  it('attach()/detach() do not stack listeners', () => {
    const ctx = harness()
    ctx.follow.attach(ctx.el)
    ctx.follow.attach(ctx.el)
    expect(ctx.el.listenerCount('wheel')).toBe(1)

    ctx.follow.attach(null)
    expect(ctx.el.listenerCount('wheel')).toBe(0)
    ctx.el.emit('wheel', { deltaY: -10 })
    expect(ctx.follow.isFollowing()).toBe(true)
  })

  it('reattaches to a new element after a remount', () => {
    const first = new FakeEl()
    const second = new FakeEl()
    let current: FakeEl = first
    const follow = createTailFollow(() => current, { schedule: () => 1, cancel: () => {} })
    follow.attach(first)
    current = second
    follow.attach(second)
    expect(first.listenerCount('wheel')).toBe(0)
    second.emit('wheel', { deltaY: -10 })
    expect(follow.isFollowing()).toBe(false)
  })

  it('dispose() detaches and stops the loop', () => {
    const ctx = harness()
    commit(ctx, 400) // commit 即同步贴底（pre-paint snap）
    ctx.follow.attach(ctx.el)
    ctx.follow.dispose()
    expect(ctx.el.listenerCount('wheel')).toBe(0)
    // dispose 之后的生长无人认领：泵帧也不许再动尾部。
    const pinnedAt = ctx.el.scrollTop
    ctx.el.grow(300)
    expect(ctx.frames(5)).toBeUndefined()
    expect(ctx.el.scrollTop).toBe(pinnedAt)
  })

  it('reports an initially-following state without a notification', () => {
    const ctx = harness()
    expect(ctx.follow.isFollowing()).toBe(true)
    expect(ctx.flips).toEqual([])
  })

  it('clamps to zero when the document is shorter than the viewport', () => {
    const ctx = harness()
    ctx.el.scrollHeight = 200
    ctx.el.setTop(0)
    ctx.follow.snap()
    expect(ctx.el.scrollTop).toBe(0)
  })
})
