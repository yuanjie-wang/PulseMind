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
// The intent rule has one blind spot: released AT the tail, no scroll event can
// ever carry the reattach (the view cannot move further down). Two escapes close
// it (2026-11-22 回到底部 stranded): a wheel-down within reattachPx reattaches
// instantly, and a released view that sits quiet within DWELL_REATTACH_PX of the
// tail for DWELL_QUIET_MS is read as "at the bottom" and re-grabbed.
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
  /** Quiet time released-within-DWELL_REATTACH_PX-of-the-tail before the engine
   *  takes the tail back (default 1200ms — the stranded-tail escape). */
  dwellQuietMs?: number
  /** Fired whenever `following` flips. */
  onFollowingChange?: (following: boolean) => void
  /** Frame hooks — injectable so tests can pump frames manually. */
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
  /** Clock — injectable for the jump hold window. */
  now?: () => number
  /**
   * Watch the scroller's content for size changes that no React commit reports
   * (async markdown, images, a card growing under an ask-user prompt). Returns a
   * disposer. Injectable so tests can drive it without a layout engine.
   */
  observeSize?: (el: TailFollowTarget, onChange: () => void) => () => void
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
/** Reattach-on-dwell window: how close to the tail counts as "parked at the
 *  bottom". Deliberately wider than `reattachPx` — the 回到底部 button's own
 *  above-card reserve lifts the tail ~8px the moment it mounts, and a wheel
 *  gesture can stop a few px short of the clamp, both invisible behind the
 *  floating composer band. */
const DWELL_REATTACH_PX = 40
/** How long the view must sit released, quiet, and within DWELL_REATTACH_PX of
 *  the tail before the engine takes the tail back (see the stranded-tail note
 *  on `release`). */
const DWELL_QUIET_MS = 1200

/**
 * Default content watcher: a ResizeObserver over the scroller's direct children.
 *
 * The settle loop alone cannot be the whole story: it gives up after ~0.4s of
 * unchanged frames, and plenty of growth arrives later than that AND without a
 * React commit to re-arm it — an ask-user card laying out its options, a code
 * block highlighting, an image decoding, a conversation that was already
 * streaming when you switched to it. All of those left the view short of the
 * tail until the user nudged it (user 2026-11-17 反馈: ask user 在底部、进行中的
 * 会话这两类场景仍不跟随).
 *
 * The scroller's OWN box never changes when its content overflows — the growth
 * shows up on its children — so observe each direct child, and re-observe when
 * the child list changes (a conversation switch replaces them).
 */
const domObserveSize = (el: TailFollowTarget, onChange: () => void): (() => void) => {
  const g = globalThis as {
    ResizeObserver?: new (cb: () => void) => { observe: (t: object) => void; disconnect: () => void }
    MutationObserver?: new (cb: () => void) => { observe: (t: object, o: object) => void; disconnect: () => void }
  }
  const RO = g.ResizeObserver
  if (!RO) return () => {}
  const ro = new RO(onChange)
  const observeChildren = (): void => {
    ro.disconnect()
    const kids = (el as { children?: ArrayLike<object> }).children
    if (!kids) return
    for (let i = 0; i < kids.length; i += 1) ro.observe(kids[i])
  }
  observeChildren()
  const MO = g.MutationObserver
  const mo = MO
    ? new MO(() => {
        observeChildren()
        onChange()
      })
    : null
  mo?.observe(el as object, { childList: true })
  return () => {
    ro.disconnect()
    mo?.disconnect()
  }
}

/**
 * Creates a tail follower over `getEl`. The element is resolved on every use so
 * a remount (conversation switch re-keying the scroller) needs no ceremony.
 */
export function createTailFollow(getEl: () => TailFollowTarget | null, opts: TailFollowOptions = {}): TailFollow {
  const reattachPx = opts.reattachPx ?? 8
  const quietFrames = opts.quietFrames ?? 24
  const maxFrames = opts.maxFrames ?? 600
  const jumpHoldMs = opts.jumpHoldMs ?? 750
  const dwellQuietMs = opts.dwellQuietMs ?? DWELL_QUIET_MS
  const schedule = opts.schedule ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = opts.cancel ?? ((handle: number) => cancelAnimationFrame(handle))
  const now = opts.now ?? (() => performance.now())
  const observeSize = opts.observeSize ?? domObserveSize

  let following = true
  let held = false
  let holdUntil = 0
  let frameHandle: number | null = null
  let spent = 0
  let quiet = 0
  let lastHeight = -1
  let listenedEl: TailFollowTarget | null = null
  let stopObserving: (() => void) | null = null
  let touchY: number | null = null
  let lastTop: number | null = null
  // ── The stranded-tail escape ──
  // Released at (or just above) the tail, nothing can ever carry the reattach:
  // the condition needs a scroll event that moves TOWARD the tail, but at gap 0
  // the view cannot move further down — a wheel-up micro-event at the exact tail
  // (trackpad finger-lift artifacts) or a mid-descent x-markdown shrink-clamp
  // lands the view there and the 回到底部 button sits forever, immune to
  // scrolling (user 2026-11-22 反馈: 滚动到底部后按钮不消失). Two ways back:
  // a wheel-down within reattachPx (instant, the mirror intent of the wheel-up
  // release), and the quiet-dwell loop below — released + within
  // DWELL_REATTACH_PX of the tail + no input for DWELL_QUIET_MS ⇒ the user IS
  // at the bottom; take the tail back. Any event refreshes `dwellMark`, so a
  // reader actively scrolling up through the zone is never grabbed mid-gesture.
  let dwellFrame: number | null = null
  let dwellMark = 0

  const cancelDwell = (): void => {
    if (dwellFrame !== null) {
      cancelFrame(dwellFrame)
      dwellFrame = null
    }
  }

  const dwellStep = (): void => {
    dwellFrame = null
    if (following || held) return
    const el = getEl()
    if (!el) return
    const t = now()
    if (measureGap(el) > DWELL_REATTACH_PX) {
      dwellMark = t // away from the tail: the quiet clock restarts when they return
      dwellFrame = schedule(dwellStep)
      return
    }
    if (t - dwellMark < dwellQuietMs) {
      dwellFrame = schedule(dwellStep)
      return
    }
    following = true
    notify()
    settle()
  }

  const armDwell = (): void => {
    if (following || held) return
    dwellMark = now()
    cancelDwell()
    dwellFrame = schedule(dwellStep)
  }
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
    // Pre-paint catch-up: every settle caller reports growth from a point that
    // runs BEFORE the next paint (a React layout effect, a ResizeObserver or
    // MutationObserver callback) — but scheduling the loop alone left that
    // frame painting the stale offset first: the tail dipped for one frame and
    // snapped back on the next. With the turn-elapsed badge living at the tail
    // this read as a constant bounce at streaming cadence (user 2026-11-21).
    // Snap here, synchronously, so the correction lands in the same frame as
    // the growth it answers; the loop stays for the growth that keeps arriving
    // after this call returns. The jump hold window is respected — during a
    // smooth scroll the landing wins, and the loop idles through as before.
    if (now() >= holdUntil) snap()
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
    armDwell()
  }

  const resume = (): void => {
    cancelDwell()
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
    cancelDwell()
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
    // Any scroll is activity: the quiet-dwell escape must not fire under a
    // reader who is actively moving the view (even slowly through the zone).
    dwellMark = now()
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
      cancelDwell()
      following = true
      notify()
      settle()
    }
  }

  const hold = (on: boolean): void => {
    held = on
    if (on) {
      stopLoop()
      cancelDwell() // dwellStep exits on `held`; re-arm on release of the hold
    } else {
      settle()
      armDwell()
    }
  }

  const onWheel = (ev: TailInputEvent): void => {
    const dy = ev.deltaY ?? 0
    // Any wheel is activity: defer the quiet-dwell escape (also covers a second
    // wheel-up while already released, where release() is a no-op).
    dwellMark = now()
    if (dy < 0) {
      release()
      return
    }
    // Pressing toward the tail while released and parked within reattachPx of it
    // is the mirror intent of the wheel-up release — and at gap 0 no scroll
    // event will ever carry the reattach (2026-11-22 回到底部 stranded at the
    // tail). Same threshold as the scroll-event reattach above.
    if (dy > 0 && !following && !held && now() >= holdUntil) {
      const el = getEl()
      if (el && measureGap(el) <= reattachPx) {
        cancelDwell()
        following = true
        notify()
        settle()
      }
    }
  }
  const onTouchStart = (ev: TailInputEvent): void => {
    touchY = ev.touches?.[0]?.clientY ?? null
    dwellMark = now()
  }
  const onTouchMove = (ev: TailInputEvent): void => {
    const y = ev.touches?.[0]?.clientY
    if (y === undefined) return
    dwellMark = now()
    // A finger travelling DOWN drags the content down = the view moves up.
    if (touchY !== null && y - touchY > TOUCH_SLOP) release()
    touchY = y
  }
  const onKeyDown = (ev: TailInputEvent): void => {
    dwellMark = now()
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
    stopObserving?.()
    stopObserving = null
    const el = listenedEl
    listenedEl = null
    touchY = null
    cancelDwell()
    if (!el?.removeEventListener) return
    for (const [type, handler] of bindings) el.removeEventListener(type, handler)
  }

  const attach = (el: TailFollowTarget | null): void => {
    if (el === listenedEl) return
    detach()
    if (!el?.addEventListener) return
    listenedEl = el
    for (const [type, handler] of bindings) el.addEventListener(type, handler)
    // Growth without a commit — the settle loop may already have given up by the
    // time it lands, so every content size change re-arms it. A no-op when the
    // user has taken over (`settle` checks `following`).
    stopObserving = observeSize(el, settle)
    // A released engine switching elements still deserves the stranded-tail
    // escape (the getter resolves the new element every dwell frame).
    armDwell()
  }

  const dispose = (): void => {
    detach()
    stopLoop()
    cancelDwell()
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
