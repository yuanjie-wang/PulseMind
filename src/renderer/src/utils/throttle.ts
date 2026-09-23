/** Trailing-edge throttle for "reload the world" callbacks.
 *
 *  The knowledge import/compile queues used to fire a full list+stats reload
 *  after EVERY file — for a folder import that is thousands of IPC round trips
 *  back-to-back (「导入大批量文件时会卡死」, the renderer half). The rule here is
 *  the scroll-follow rule inverted into a timer:
 *
 *  - the first `schedule()` runs immediately (leading edge — a user-initiated
 *    single action still feels instant);
 *  - further calls inside `ms` coalesce into ONE run at the trailing edge, so a
 *    burst ends with a guaranteed refresh of the final state;
 *  - `flush()` runs a pending trailing call now (end-of-run paths that must not
 *    wait), `cancel()` drops it (unmount — a timer outliving its component is a
 *    leak, and the callback it would fire belongs to a dead mount).
 *
 *  Deliberately NOT `lodash.throttle`-shaped: no maxWait, no args/this
 *  forwarding beyond the last call's — every caller here is a zero-arg reload
 *  and a `maxWait` would reintroduce the unbounded refresh rate mid-burst. */
export interface ThrottledTrailing {
  /** Ask for a run: leading edge now (if idle), else one trailing run. */
  schedule(): void
  /** Run a pending trailing call immediately. No-op when nothing is pending. */
  flush(): void
  /** Drop any pending trailing call and stop the timer. */
  cancel(): void
}

export function throttleTrailing(fn: () => void, ms = 500): ThrottledTrailing {
  // -Infinity, not 0: "never ran" must read as an expired window on ANY clock,
  // including a fake one that starts near zero — otherwise the very first
  // schedule() computes `now - 0 < ms` and misses the leading edge.
  let lastRunAt = Number.NEGATIVE_INFINITY
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const runTrailing = (): void => {
    timer = null
    lastRunAt = Date.now()
    pending = false
    fn()
  }

  return {
    schedule(): void {
      const since = Date.now() - lastRunAt
      if (timer === null && since >= ms) {
        lastRunAt = Date.now()
        fn()
        return
      }
      pending = true
      if (timer === null) {
        timer = setTimeout(runTrailing, Math.max(0, ms - since))
      }
    },
    flush(): void {
      if (timer !== null && pending) {
        clearTimeout(timer)
        runTrailing()
      }
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = false
    },
  }
}
