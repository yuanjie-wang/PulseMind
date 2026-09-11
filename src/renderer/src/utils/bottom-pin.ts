// ── Bottom pinning after a conversation switch ──
// Content height keeps growing well after the messages commit (XMarkdown
// returns null on its first render and fills its body a render later; images,
// syntax highlighting and Mermaid grow it even later), so a one-shot scroll
// lands mid-content — or at the top when the initial layout is shorter than the
// viewport and the view has not been scrolled yet. This pinner keeps snapping
// the element to its bottom while the height keeps changing.
//
// It deliberately avoids two traps:
//  - It polls on a timer instead of requestAnimationFrame, so it still runs
//    when frames are throttled, and it does not treat a long gap between layout
//    passes as "settled" (a fixed frame budget can expire before Markdown
//    bodies commit).
//  - It treats a missing element as "not ready yet" rather than "done": the
//    container can unmount/remount while a conversation loads, and giving up
//    there is what leaves the view stuck at the first message.
//
// User takeover is detected from real input events (wheel / touch / pointer /
// key) — not from scrollTop drift, because the browser's own scroll anchoring
// and offset clamping also move scrollTop and must not cancel the landing.

/** Structural view of a scroll container — plain objects work too (tests). */
export interface BottomPinTarget {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener?: (type: string, handler: () => void) => void
  removeEventListener?: (type: string, handler: () => void) => void
}

export interface BottomPinOptions {
  /** Give up after this long even if the height never settles. */
  timeoutMs?: number
  /** Stop once scrollHeight has been unchanged for this long. */
  quietMs?: number
  /** How often to re-check the element and its height. */
  pollMs?: number
  /** Called whenever the pin stops — settled, taken over, timed out, or cancelled. */
  onStop?: () => void
  /** Timer hooks — injectable so tests can pump time manually. */
  schedule?: (cb: () => void, delayMs: number) => number
  cancel?: (handle: number) => void
  now?: () => number
}

const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Starts pinning `getEl()` to its bottom. Returns a cancel function.
 *
 * The element is re-resolved on every tick so a remount is picked up, and user
 * input listeners are re-attached whenever the element identity changes.
 */
export function startBottomPin(
  getEl: () => BottomPinTarget | null,
  opts: BottomPinOptions = {}
): () => void {
  const timeoutMs = opts.timeoutMs ?? 3000
  const quietMs = opts.quietMs ?? 500
  const pollMs = opts.pollMs ?? 100
  const schedule = opts.schedule ?? ((cb, delay) => setTimeout(cb, delay) as unknown as number)
  const cancelTimer = opts.cancel ?? ((handle: number) => clearTimeout(handle))
  const now = opts.now ?? (() => performance.now())

  let cancelled = false
  let handle: number | null = null
  let lastHeight = -1
  let lastChangeAt = now()
  let listenedEl: BottomPinTarget | null = null
  const deadline = now() + timeoutMs

  const detachInput = (): void => {
    if (!listenedEl?.removeEventListener) return
    for (const type of USER_INPUT_EVENTS) listenedEl.removeEventListener(type, onUserInput)
    listenedEl = null
  }
  const stop = (): void => {
    if (cancelled) return
    cancelled = true
    detachInput()
    if (handle !== null) cancelTimer(handle)
    handle = null
    opts.onStop?.()
  }
  function onUserInput(): void {
    stop() // genuine user scrolling — never fight it
  }

  const attachInput = (el: BottomPinTarget): void => {
    if (el === listenedEl || !el.addEventListener) return
    detachInput()
    for (const type of USER_INPUT_EVENTS) el.addEventListener(type, onUserInput)
    listenedEl = el
  }

  const step = (): void => {
    if (cancelled) return
    const t = now()
    if (t > deadline) {
      stop()
      return
    }
    const el = getEl()
    if (el) {
      attachInput(el)
      const height = el.scrollHeight
      if (height !== lastHeight) {
        lastHeight = height
        lastChangeAt = t
        // A container shorter than its viewport has no scrollable range (0).
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      }
    }
    if (t - lastChangeAt > quietMs) {
      stop()
      return
    }
    handle = schedule(step, pollMs)
  }
  step()

  return () => {
    stop()
    cancelled = true // stop() may have run onStop; keep the loop dead either way
  }
}
