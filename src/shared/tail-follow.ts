// ── Tail following while content grows ──
// One place that answers "is the view still glued to the bottom, and may I keep
// it there?" for every scrolling transcript host (ChatView/ChatBody,
// TranscriptView, the extension panel).
//
// The rule this replaces was geometric: "within 100px of the bottom ⇒ keep
// following". It fails in both directions the user reports (2026-11-13):
//  - a large growth step moves the tail more than the threshold in one commit,
//    so the follow switched itself off mid-stream and the view stalled
//    ("不是 100% 能跟随保持在底部");
//  - a small scroll-up by the user stayed inside the threshold and got pulled
//    back, which reads as a magnetic band you must escape ("有一段自动吸附的距离").
//
// So following is now decided by INTENT, not by distance:
//  - real input scrolling away (wheel up, touch drag down, PageUp/Home/ArrowUp)
//    releases it on the spot, at any distance — no magnetic band;
//  - reattaching requires the user to bring the view back within `reattachPx`
//    of the tail, moving toward it — never by drifting into a threshold;
//  - scroll events we did not cause are told apart from our own writes by a
//    write proof: the (top, height) of every scrollTop we wrote recently. An
//    event landing on a recorded write is us catching up with growth, never a
//    user scroll and never a reason to release.
//
// Growth that no commit drives (late Markdown bodies, images, embeds) is caught
// by a bounded per-frame settle loop instead of a single rAF: it snaps on every
// frame the height changes and stops after `quietFrames` unchanged frames.

/** Structural view of a scroll container — plain objects work too (tests). */
export interface TailFollowTarget {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollTo?: (opts: { top: number; behavior?: 'auto' | 'smooth' }) => void
  addEventListener?: (type: string, handler: (ev: TailInputEvent) => void) => void
  removeEventListener?: (type: string, handler: (ev: TailInputEvent) => void) => void
}

/** The slice of a DOM input event this module reads. */
export interface TailInputEvent {
  deltaY?: number
  key?: string
  shiftKey?: boolean
  touches?: ArrayLike<{ clientY: number }>
}

export interface TailFollowOptions {
  /** Distance from the tail a user scroll must reach to reattach following. */
  reattachPx?: number
  /** Unchanged frames after which the settle loop gives up (default 24 ≈ 0.4s). */
  quietFrames?: number
  /** Hard frame budget for one settle run (default 600 ≈ 10s). */
  maxFrames?: number
  /** How long a programmatic jump keeps follow logic suppressed (default 750ms). */
  jumpHoldMs?: number
  /** Fired whenever `following` flips. */
  onFollowingChange?: (following: boolean) => void
  /** Frame hooks — injectable so tests can pump frames manually. */
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
  /** Clock — injectable for the jump hold window. */
  now?: () => number
}

export interface TailFollow {
  /** True while the view keeps itself pinned to the tail. */
  isFollowing(): boolean
  /** Distance between the viewport bottom and the document bottom, in px. */
  gap(): number
  /** Snap to the tail now and record the write proof. */
  snap(): void
  /** Reattach following and snap (user clicked 回到底部, message sent, switch). */
  resume(): void
  /** Stop following (the user scrolled away). */
  release(): void
  /** Smooth-scroll to the tail, suppressing follow logic while it animates. */
  jump(): void
  /** Host scroll handler: updates following from the event that arrived. */
  onScroll(): void
  /** Keep the view glued while the height settles; idempotent. */
  settle(): void
  /** Suppress follow logic while the host drives scrollTop itself (landing). */
  hold(on: boolean): void
  /** Attach input listeners to the element (call when it mounts). */
  attach(el: TailFollowTarget | null): void
  /** Detach listeners and stop any running loop. */
  dispose(): void
}

const RELEASE_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
/** Finger travel (px) before a touch is read as "dragging the view up". */
const TOUCH_SLOP = 2
/** How long a scrollTop we wrote stays attributable to us. Our own write provokes
 *  its scroll event within a frame or two, so this only has to cover that lag —
 *  anything longer lets a stale proof swallow a real user scroll. */
const PROOF_TTL_MS = 120

/**
 * Creates a tail follower over `getEl`. The element is resolved on every use so
 * a remount (conversation switch re-keying the scroller) needs no ceremony.
 */
export function createTailFollow(getEl: () => TailFollowTarget | null, opts: TailFollowOptions = {}): TailFollow {
  const reattachPx = opts.reattachPx ?? 8
  const quietFrames = opts.quietFrames ?? 24
  const maxFrames = opts.maxFrames ?? 600
  const jumpHoldMs = opts.jumpHoldMs ?? 750
  const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = opts.cancel ?? ((handle: number) => cancelAnimationFrame(handle))
  const now = opts.now ?? (() => performance.now())

  let following = true
  let held = false
  let holdUntil = 0
  let frameHandle: number | null = null
  let spent = 0
  let quiet = 0
  let lastHeight = -1
  let listenedEl: TailFollowTarget | null = null
  let touchY: number | null = null
  let lastTop: number | null = null
  // Every scrollTop we wrote recently, with the time we wrote it. Scroll events
  // arrive asynchronously, so a growth spurt can land between the write and the
  // event; matching against the recorded writes (not just the latest one) is what
  // keeps our own catch-up from reading as a user scroll.
  //
  // A proof is SPENT by the first event that matches it, and it expires after
  // PROOF_TTL_MS. Both rules matter: while proofs were a permanent whitelist, the
  // tail offset stayed flagged as "ours" for the rest of the session, so a user
  // who scrolled back down to the bottom produced an event that was dismissed as
  // our own write — following never resumed and 回到底部 never hid
  // (user 2026-11-13 反馈: 手动滚动到底部后按钮还在).
  const ourWrites: Array<{ top: number; height: number; at: number }> = []

  const notify = (): void => opts.onFollowingChange?.(following)
  const measureGap = (el: TailFollowTarget): number => el.scrollHeight - el.scrollTop - el.clientHeight

  const recordWrite = (top: number, height: number): void => {
    ourWrites.push({ top, height, at: now() })
    if (ourWrites.length > 8) ourWrites.shift()
  }
  /** True when this scroll event is the echo of a write we made — and it spends
   *  that proof, so one write can never vouch for a later move to the same offset. */
  const isOurWrite = (st: number, sh: number): boolean => {
    const at = now()
    const i = ourWrites.findIndex((w) => at - w.at <= PROOF_TTL_MS && Math.abs(st - w.top) <= 1 && sh >= w.height - 1)
    if (i < 0) return false
    ourWrites.splice(i, 1)
    return true
  }

  const snap = (): void => {
    const el = getEl()
    if (!el) return
    const height = el.scrollHeight
    const top = Math.max(0, height - el.clientHeight)
    // A write that moves nothing emits no scroll event, so recording a proof for
    // it would leave an unconsumed one lying on the tail offset.
    if (el.scrollTop === top) return
    recordWrite(top, height)
    el.scrollTop = top
  }

  const stopLoop = (): void => {
    if (frameHandle !== null) cancelFrame(frameHandle)
    frameHandle = null
    spent = 0
    quiet = 0
    lastHeight = -1
  }

  // One settle run: snap on every frame the height changed, give up after
  // `quietFrames` unchanged ones (or the frame budget). During a jump the loop
  // just idles out the hold window, then takes over the tail for good.
  const step = (): void => {
    frameHandle = null
    spent += 1
    if (spent >= maxFrames) return
    if (now() < holdUntil) {
      frameHandle = schedule(step)
      return
    }
    const el = getEl()
    if (!el || !following || held) return
    if (el.scrollHeight !== lastHeight) {
      lastHeight = el.scrollHeight
      quiet = 0
      snap()
    } else {
      quiet += 1
    }
    if (quiet >= quietFrames) return
    frameHandle = schedule(step)
  }

  const settle = (): void => {
    if (!following || held) return
    if (frameHandle !== null) {
      quiet = 0 // still alive — the caller is reporting fresh growth
      return
    }
    lastHeight = -1
    spent = 0
    quiet = 0
    frameHandle = schedule(step)
  }

  const release = (): void => {
    stopLoop()
    if (!following) return
    following = false
    notify()
  }

  const resume = (): void => {
    snap()
    holdUntil = 0
    if (!following) {
      following = true
      notify()
    }
    settle()
  }

  const jump = (): void => {
    const el = getEl()
    holdUntil = now() + jumpHoldMs
    if (!following) {
      following = true
      notify()
    }
    if (el) {
      const top = Math.max(0, el.scrollHeight - el.clientHeight)
      recordWrite(top, el.scrollHeight)
      if (el.scrollTo) el.scrollTo({ top, behavior: 'smooth' })
      else el.scrollTop = top
    }
    // The document can grow while the animation runs, so the settle loop keeps
    // the tail once the hold expires instead of trusting this one write.
    if (frameHandle !== null) cancelFrame(frameHandle)
    lastHeight = -1
    spent = 0
    quiet = 0
    frameHandle = schedule(step)
  }

  const onScroll = (): void => {
    const el = getEl()
    if (!el) return
    const st = el.scrollTop
    const sh = el.scrollHeight
    const prevTop = lastTop
    lastTop = st
    if (held || now() < holdUntil) return
    // A write proof may only explain an echo while we are actually writing. Once
    // released the engine stops writing, so every scroll event is the user's and
    // nothing here can be our echo. Letting a proof answer after release is what
    // kept 回到底部 stuck (user 2026-11-13 第二次反馈): mid-stream the settle loop
    // records a FRESH proof every frame, so a return to the tail always matched
    // one, was dismissed as our own echo, and never reached the reattach below.
    if (following && isOurWrite(st, sh)) {
      if (sh - st - el.clientHeight > 0) snap()
      return
    }
    const gapPx = sh - st - el.clientHeight
    if (prevTop !== null && st < prevTop) {
      // Moved toward earlier content. A shrinking document also clamps
      // scrollTop downward, so only a move that actually leaves the tail
      // counts as the user scrolling back to read.
      if (gapPx > reattachPx) release()
      else if (following) snap()
      return
    }
    // Reattaching needs BOTH pieces of evidence: the view sits within
    // `reattachPx` of the tail AND this event moved it toward the tail. Without
    // the second half a released user parked a few px above the bottom would be
    // re-grabbed by the next unrelated scroll event — the magnetic band again,
    // only narrower.
    if (!following && prevTop !== null && st > prevTop && gapPx >= 0 && gapPx <= reattachPx) {
      following = true
      notify()
      settle()
    }
  }

  const hold = (on: boolean): void => {
    held = on
    if (on) stopLoop()
    else settle()
  }

  const onWheel = (ev: TailInputEvent): void => {
    if ((ev.deltaY ?? 0) < 0) release()
  }
  const onTouchStart = (ev: TailInputEvent): void => {
    touchY = ev.touches?.[0]?.clientY ?? null
  }
  const onTouchMove = (ev: TailInputEvent): void => {
    const y = ev.touches?.[0]?.clientY
    if (y === undefined) return
    // A finger travelling DOWN drags the content down = the view moves up.
    if (touchY !== null && y - touchY > TOUCH_SLOP) release()
    touchY = y
  }
  const onKeyDown = (ev: TailInputEvent): void => {
    if (ev.key === ' ' && ev.shiftKey) release()
    else if (ev.key && RELEASE_KEYS.has(ev.key)) release()
  }

  const bindings: Array<[string, (ev: TailInputEvent) => void]> = [
    ['scroll', onScroll],
    ['wheel', onWheel],
    ['touchstart', onTouchStart],
    ['touchmove', onTouchMove],
    ['keydown', onKeyDown],
  ]

  const detach = (): void => {
    const el = listenedEl
    listenedEl = null
    touchY = null
    if (!el?.removeEventListener) return
    for (const [type, handler] of bindings) el.removeEventListener(type, handler)
  }

  const attach = (el: TailFollowTarget | null): void => {
    if (el === listenedEl) return
    detach()
    if (!el?.addEventListener) return
    listenedEl = el
    for (const [type, handler] of bindings) el.addEventListener(type, handler)
  }

  const dispose = (): void => {
    detach()
    stopLoop()
    held = false
    holdUntil = 0
    lastTop = null
    ourWrites.length = 0
  }

  const gap = (): number => {
    const el = getEl()
    return el ? measureGap(el) : 0
  }

  return {
    isFollowing: () => following,
    gap,
    snap,
    resume,
    release,
    jump,
    onScroll,
    settle,
    hold,
    attach,
    dispose,
  }
}
