/**
 * The turn clock (PLAN-workbench 2026-09-16 user ruling).
 *
 * A turn's duration is what the user sees under the final answer, and the
 * definition is wall clock from **the user's send to the last output character**
 * — every thinking round and every tool call in between counts. What does not
 * count is time the engine spent waiting on the user: a held approval, an
 * ask_user question, the loop-limit prompt, or a manual 暂停. Those are real
 * delays but they are not execution, and counting them made the number read as
 * "how long was I away from my desk".
 *
 * So the clock is not a stopwatch started once — it is an accumulator with a
 * running segment on top, and **two independent reasons to be stopped**:
 *
 *  - `sync(waitingOnUser)` — the status surface: the engine parks with
 *    `awaiting_approval` / `awaiting_user_input` / `awaiting_extension` /
 *    `awaiting_continue`;
 *  - `pause()` / `resume()` — an explicit hold, for a pause that has no status
 *    of its own (the 暂停 button leaves the engine reporting `executing`).
 *
 * They are tracked separately on purpose: a manual hold must survive the
 * `notify()` that follows it, and a status-driven park must not be lifted by an
 * unrelated explicit resume. The clock runs only while neither is set, and
 * `assert`-ing that in one place (`apply`) is what keeps the banked segments
 * exact.
 *
 * `now` is injected so the arithmetic can be pinned in a test instead of being
 * measured.
 */

/** Statuses where the ball is in the user's court. The turn clock stops for
 *  these and only these: every one of them is the engine saying "I cannot
 *  proceed until a human answers". `retrying` is NOT one of them — an automatic
 *  retry is the engine still working, and `executing` is the tools running.
 *  `awaiting_continue` is the 暂停 button's own status (cancelLoop) — the user
 *  holding the turn, exactly the category the ruling excludes, and it must be
 *  here or the park that follows the button silently keeps counting. */
const WAITING_ON_USER: ReadonlySet<string> = new Set([
  'awaiting_approval',
  'awaiting_user_input',
  'awaiting_extension',
  'awaiting_continue',
])

export function isWaitingOnUserStatus(status: string): boolean {
  return WAITING_ON_USER.has(status)
}

export class TurnClock {
  /** Running time of segments already banked, in ms. */
  private bankedMs = 0
  /** When the current running segment started, or null while stopped. */
  private runningSince: number | null = null
  /** False until `start()`; a finished turn is idle again. */
  private started = false
  /** Parks reported by the status surface. */
  private parkedOnUser = false
  /** Explicit holds (the 暂停 button), which no status reports. */
  private held = false

  constructor(private now: () => number = () => performance.now()) {}

  /** The user hits send (or a sub-agent's kick-off is issued). */
  start(): void {
    this.bankedMs = 0
    this.runningSince = null
    this.started = true
    this.parkedOnUser = false
    this.held = false
    this.apply()
  }

  /** Stop counting until an explicit `resume()` — for pauses that carry no
   *  status of their own. */
  pause(): void {
    this.held = true
    this.apply()
  }

  /** Lift an explicit hold. A status-driven park is lifted by `sync(false)`. */
  resume(): void {
    this.held = false
    this.apply()
  }

  /** Follow the engine's own status: waiting statuses park, others release. A
   *  finished turn stays idle (`started === false`), so the 'completed' status
   *  that follows the last output character cannot restart it. */
  sync(waitingOnUser: boolean): void {
    this.parkedOnUser = waitingOnUser
    this.apply()
  }

  /** The one place the banked/running split is decided. */
  private apply(): void {
    const shouldRun = this.started && !this.parkedOnUser && !this.held
    if (shouldRun) {
      if (this.runningSince === null) this.runningSince = this.now()
    } else if (this.runningSince !== null) {
      this.bankedMs += this.now() - this.runningSince
      this.runningSince = null
    }
  }

  /** Is a turn in flight (running or parked on the user)? */
  isActive(): boolean {
    return this.started
  }

  /** Total running time so far. While parked this is the banked total, which is
   *  what an answer written at that moment should read. */
  elapsed(): number {
    return this.runningSince === null ? this.bankedMs : this.bankedMs + (this.now() - this.runningSince)
  }

  /** End the turn and hand over the total; the clock goes idle. */
  stop(): number {
    const total = this.elapsed()
    this.bankedMs = 0
    this.runningSince = null
    this.started = false
    this.parkedOnUser = false
    this.held = false
    return total
  }
}
