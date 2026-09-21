// ── Batch row queue (PLAN-routine-batch M3) ──
// The FIFO row queue behind a batch run, drained by a fixed-size worker pool.
// Pure scheduling — no imports, no clock — so vitest can drive it with fake
// tasks and pin the semantics (concurrency ceiling, FIFO order, stop) without
// a database or an engine.
//
// The ONE load-bearing contract: `executeRow` resolves only when its row has
// truly settled (engine finished / failed / stopped), not when it was merely
// dispatched — the pool's in-flight count IS the concurrency guarantee, and a
// row that resolved early would let the pump run away to unlimited parallelism.

export class BatchQueue {
  private nextIndex = 0
  private inFlight = 0
  private stopped = false

  constructor(
    private readonly total: number,
    private readonly concurrency: number,
    /** Runs one row to completion. Must never reject — a rejection is absorbed
     *  (and still releases its slot) so a bug cannot stall the whole batch. */
    private readonly executeRow: (index: number) => Promise<void>,
  ) {}

  start(): void {
    this.pump()
  }

  /** Stop dispatching; returns the queued-but-never-dispatched indices so the
   *  caller can settle them (已跳过). In-flight rows keep running. */
  stop(): number[] {
    this.stopped = true
    const rest: number[] = []
    while (this.nextIndex < this.total) rest.push(this.nextIndex++)
    return rest
  }

  /** True while at least one row is still executing. */
  get busy(): boolean {
    return this.inFlight > 0
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < this.concurrency && this.nextIndex < this.total) {
      const index = this.nextIndex++
      this.inFlight++
      Promise.resolve()
        .then(() => this.executeRow(index))
        .catch(() => { /* the slot is released either way; the row's own settlement is the source of truth */ })
        .finally(() => {
          this.inFlight--
          this.pump()
        })
    }
  }
}
