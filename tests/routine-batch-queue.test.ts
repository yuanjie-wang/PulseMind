/** BatchQueue semantics (PLAN-routine-batch M3).
 *
 * The pool is the concurrency guarantee of a batch run, so its contract is
 * pinned here with fake tasks: the ceiling holds (peak in-flight = N), rows
 * dispatch in FIFO order, stop hands back exactly the never-dispatched rows
 * and lets in-flight ones finish, and a rejecting task releases its slot —
 * a bug must be able to stall, but never jam, the pool.
 *
 * The deferred task helper is the whole harness: each row's promise resolves
 * only when the test releases it, mirroring the runner's contract that a slot
 * is held until the row truly settles (a dispatch-time resolve would let the
 * pump run away to unlimited parallelism). */

import { describe, expect, it } from 'vitest'
import { BatchQueue } from '../src/main/routine/batch-queue'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A queue over `total` rows whose execution is manual: tests release rows by
 *  index. Reports live in-flight state and the dispatch order. */
function harness(total: number, concurrency: number) {
  const gates = new Map<number, ReturnType<typeof deferred>>()
  const dispatchOrder: number[] = []
  let inFlight = 0
  let peak = 0
  const queue = new BatchQueue(total, concurrency, (index) => {
    dispatchOrder.push(index)
    inFlight++
    peak = Math.max(peak, inFlight)
    const d = deferred()
    gates.set(index, d)
    return d.promise.finally(() => { inFlight-- })
  })
  const release = (index: number): void => { gates.get(index)!.resolve() }
  return { queue, gates, dispatchOrder, release, getInFlight: () => inFlight, getPeak: () => peak }
}

async function tick(): Promise<void> {
  // resolve → finally → the queue's own finally → pump: the release lands a
  // few microtasks deep, so flush a macrotask instead of counting them.
  await new Promise((r) => setTimeout(r, 0))
}

describe('BatchQueue', () => {
  it('holds the concurrency ceiling and drains FIFO', async () => {
    const h = harness(7, 3)
    h.queue.start()
    await tick()
    // Peak is capped at 3 even though 7 rows are queued.
    expect(h.dispatchOrder).toEqual([0, 1, 2])
    expect(h.getInFlight()).toBe(3)
    h.release(0); h.release(1); h.release(2)
    await tick()
    expect(h.dispatchOrder).toEqual([0, 1, 2, 3, 4, 5])
    h.release(3); h.release(4); h.release(5)
    await tick()
    expect(h.dispatchOrder).toEqual([0, 1, 2, 3, 4, 5, 6])
    h.release(6)
    await tick()
    expect(h.queue.busy).toBe(false)
    expect(h.getInFlight()).toBe(0)
    expect(h.getPeak()).toBe(3)
  })

  it('reports busy only while rows are unsettled', async () => {
    const h = harness(2, 2)
    expect(h.queue.busy).toBe(false)
    h.queue.start()
    await tick()
    expect(h.queue.busy).toBe(true)
    h.release(0); h.release(1)
    await tick()
    expect(h.queue.busy).toBe(false)
  })

  it('stop returns exactly the never-dispatched rows and keeps in-flight ones', async () => {
    const h = harness(5, 2)
    h.queue.start()
    await tick()
    expect(h.dispatchOrder).toEqual([0, 1])
    const queued = h.queue.stop()
    expect(queued).toEqual([2, 3, 4])
    h.release(0)
    await tick()
    // Row 1 was already in flight — the stop does not revoke it.
    expect(h.getInFlight()).toBe(1)
    h.release(1)
    await tick()
    expect(h.dispatchOrder).toEqual([0, 1])
    expect(h.queue.busy).toBe(false)
  })

  it('a rejecting row releases its slot instead of stalling the pool', async () => {
    const executed: number[] = []
    const queue = new BatchQueue(3, 1, async (index) => {
      executed.push(index)
      if (index === 0) await Promise.reject(new Error('row bug'))
      else await new Promise((r) => setTimeout(r, 1))
    })
    queue.start()
    await new Promise((r) => setTimeout(r, 20))
    // The rejection must not jam the pump: rows 1 and 2 still ran, and the
    // queue drained to idle.
    expect(executed).toEqual([0, 1, 2])
    expect(queue.busy).toBe(false)
  })
})
