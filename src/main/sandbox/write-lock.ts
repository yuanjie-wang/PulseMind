// ── Workspace write lock (PLAN-parallel-experts T6) ──
// Per-path FIFO mutex for the file-ops write mouths. Parallel experts share
// one workspace (user ruling: shared workspace + conflict error, no per-expert
// subdirectories), so their read-modify-write cycles can interleave and updates
// are silently lost. The key is the ABSOLUTE path AFTER resolveWritablePath —
// the same file reached through different spellings (~, .., relative) must map
// to one lock, while different files never wait on each other. Pure in-memory
// coordination is enough: every writer funnels through this main process.

interface LockEntry {
  held: boolean
  /** FIFO waiters; each resolved exactly once at ownership hand-over. */
  queue: Array<() => void>
}

const locks = new Map<string, LockEntry>()

function obtain(key: string): LockEntry {
  let entry = locks.get(key)
  if (!entry) {
    entry = { held: false, queue: [] }
    locks.set(key, entry)
  }
  return entry
}

/**
 * Run `fn` holding the exclusive lock for `resolvedPath`.
 * - Same path: FIFO. A caller whose entry still has queued waiters queues
 *   behind them even while the lock is momentarily in hand-over, so no one
 *   barges ahead of an earlier waiter.
 * - Different paths: never wait on each other.
 * - `fn` throwing releases the lock in `finally` — the next waiter proceeds
 *   and the lock is not poisoned.
 */
export async function withPathLock<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
  const entry = obtain(resolvedPath)
  if (entry.held || entry.queue.length > 0) {
    await new Promise<void>((resolve) => { entry.queue.push(resolve) })
  }
  entry.held = true
  try {
    return await fn()
  } finally {
    const next = entry.queue.shift()
    if (next) {
      next() // hand-over: `held` stays true — the woken waiter is the new owner
    } else {
      entry.held = false
      // No await between this and the delete, and acquire is synchronous from
      // Map.get to queue-push, so no newcomer can end up enqueued on a removed
      // entry object.
      locks.delete(resolvedPath)
    }
  }
}
