// ── Parallel expert cap (PLAN-parallel-experts P2; the plan document lives at
//    _task/20260916/PLAN-parallel-experts.md) ──
// A batch of spawn_agent blocks used to start every expert at once: the
// dispatcher runs them in one Promise.all and nothing anywhere counted them,
// so N blocks meant N engines, N live LLM streams and N concurrent tool
// loops — and because a sub-agent inherits `allowedTools: undefined`, an
// expert could spawn experts of its own, making the fan-out recursive with no
// depth or width bound at all. Provider rate limits and the main process both
// pay for that.
//
// The cap is per SESSION and the budget is shared with nested spawns (the
// session key is threaded through `sessionRootId`, see spawn-manager), so
// "本会话最多 5 个专家同时在跑" holds for the whole tree rather than per level.
//
// Where the slot lives (this is the part that has to be right): a dispatch
// acquires immediately before `spawnSubAgent` and releases when the expert's
// completion settles, which means the slot is held across
// `await handle.waitForCompletion()`. Two consequences that were the whole
// reason for choosing this shape:
//
//   * 暂停再恢复不会绕过上限 — a paused expert's dispatch is still parked on
//     that same await, so its slot was never handed back.
//   * 停止会话时排队者不会在停止之后再起一个专家 — `releaseQueuedSubAgents`
//     resolves the waiters with `null`, and the caller bails out instead of
//     starting work the user just cancelled.
//   * 嵌套派生永不排队（死锁修复 2026-09-29）— a dispatch whose caller is
//     itself holding a slot uses `tryAcquireSubAgentSlot` and fails fast at
//     cap; letting it wait would close the circular wait described there.
//     Queueing stays a top-level-only privilege (main agent / scheduler hold
//     no slot of their own).
//
// The count is module state on purpose: engines of one session are separate
// `AgentEngine` instances (they share nothing else), so a per-engine counter
// could not see the siblings it is supposed to be limiting.

/** 同一会话内并行工作的专家上限（用户裁定 2026-09-16，2026-09-17 由 3 上调为 5）。 */
export const MAX_PARALLEL_SUBAGENTS = 5

/** The cap's effective value: MAX_PARALLEL_SUBAGENTS until 设置 → 助手设置
 *  applies a saved `maxParallelSubAgents` (session-manager at startup/save for
 *  the main-process-hosted engines). Module state like the budget map itself — the limiter counts
 *  across engines of a session, so the cap cannot be per-engine. Read on every
 *  acquire, so a saved change lands on the next dispatch without touching
 *  experts already running. `null`/invalid falls back to the constant. */
let parallelSubAgentLimit: number | null = null

export function getSubAgentParallelLimit(): number {
  return parallelSubAgentLimit ?? MAX_PARALLEL_SUBAGENTS
}

export function setSubAgentParallelLimit(value: number | null | undefined): void {
  parallelSubAgentLimit = typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null
}

/** Release a held slot. Idempotent — safe to call from a `finally`. */
export type ReleaseSubAgentSlot = () => void

interface SessionBudget {
  /** Slots currently held by a dispatch. */
  running: number
  /** Dispatches parked until a slot frees, FIFO. */
  waiting: Array<(release: ReleaseSubAgentSlot | null) => void>
}

const budgets = new Map<string, SessionBudget>()

function budgetOf(key: string): SessionBudget {
  let budget = budgets.get(key)
  if (!budget) {
    budget = { running: 0, waiting: [] }
    budgets.set(key, budget)
  }
  return budget
}

/** Budget key for one engine: the session it belongs to, not the expert's own
 *  sub-conversation. A sub-agent inherits the root id (spawn-manager writes
 *  `sessionRootId`), which is what makes nested spawns count against the same
 *  five slots instead of starting a fresh five per level. */
export function subAgentBudgetKey(opts: { sessionRootId?: string; conversationId?: string }): string {
  return opts.sessionRootId || opts.conversationId || 'default'
}

/**
 * Take a slot only if one is free RIGHT NOW — never queues. For NESTED
 * dispatches (the caller engine is itself a spawned sub-agent): the caller's
 * own dispatch holds a slot and is parked on `waitForCompletion`, so letting
 * it wait for another slot closes a circular wait — holders wait for their
 * engines, engines wait for the nested spawn's tool result, the nested spawn
 * waits for a held slot; nothing can move (user report 2026-09-29: a plan
 * wave deadlocked the whole session exactly so). A slot-holder must never
 * wait for a slot: at cap this resolves `null` and the caller fails the
 * dispatch with a do-it-yourself message instead. The width cap still holds
 * (running is only incremented under the limit) and a freed slot still goes
 * to the FIFO queue first — a late nested acquire never jumps it, because
 * while the queue is non-empty `running` is at the limit by invariant.
 */
export function tryAcquireSubAgentSlot(key: string): ReleaseSubAgentSlot | null {
  const budget = budgetOf(key)
  if (budget.running >= getSubAgentParallelLimit()) return null
  budget.running += 1
  return makeRelease(key, budget)
}

/**
 * Take a slot, waiting in line when the session is at its cap.
 * Resolves with a release function, or `null` when the session was stopped
 * while this dispatch was queued (the caller must not start the expert).
 * TOP-LEVEL dispatches only (main agent / plan scheduler — they hold no slot
 * themselves, so queueing is safe); a nested dispatch must use
 * `tryAcquireSubAgentSlot` and never wait.
 */
export function acquireSubAgentSlot(key: string): Promise<ReleaseSubAgentSlot | null> {
  const budget = budgetOf(key)
  if (budget.running < getSubAgentParallelLimit()) {
    budget.running += 1
    return Promise.resolve(makeRelease(key, budget))
  }
  return new Promise((resolve) => {
    budget.waiting.push(resolve)
  })
}

function makeRelease(key: string, budget: SessionBudget): ReleaseSubAgentSlot {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = budget.waiting.shift()
    if (next) {
      // Hand the slot over rather than releasing and re-acquiring: `running`
      // stays put, so the next expert starts the moment one finishes and FIFO
      // order is decided by the queue, not by who wakes up first.
      next(makeRelease(key, budget))
      return
    }
    budget.running -= 1
    if (budget.running <= 0) {
      budget.running = 0
      budgets.delete(key)
    }
  }
}

/** Experts currently holding a slot in this session. */
export function activeSubAgentCount(key: string): number {
  return budgets.get(key)?.running ?? 0
}

/** Dispatches waiting for a slot in this session. */
export function queuedSubAgentCount(key: string): number {
  return budgets.get(key)?.waiting.length ?? 0
}

/**
 * Stop path: resolve every queued dispatch with `null` so none of them starts
 * an expert after the user stopped the turn. Held slots are left alone — they
 * are released by the dispatches themselves as their experts settle (the
 * stop path settles sub-agents as 'aborted', which is what lets them).
 */
export function releaseQueuedSubAgents(key: string): void {
  const budget = budgets.get(key)
  if (!budget) return
  const waiting = budget.waiting.splice(0)
  for (const resolve of waiting) resolve(null)
  if (budget.running <= 0) budgets.delete(key)
}

/** Test seam: drop all accounting (module state outlives a single test). */
export function resetSubAgentLimiter(): void {
  budgets.clear()
}
