// ── Routine scheduler (PLAN-0.4.0 M4.6) ──
// Minute-ish ticking scheduler in the main process. Survives window close
// (tray residency, PLAN-0.3.5 M2.3 on macOS). Design:
//   - `nextRunAt` is persisted on the routine JSON, so restarts resume.
//   - Missed fires: catchUp 'once' → run immediately, 'skip' → jump ahead.
//   - Overlap: a routine whose previous run is still 'running' is skipped.
//   - One routine run at a time globally (local app; LLM concurrency is the
//     scarce resource — the session manager's FIFO queue still guards).

import { routineStore } from '../storage/routine-store'
import { decideScheduleFire } from '../../shared/schedule/schedule-decision'
import { routineRunner } from './routine-runner'
import { auditStore } from '../storage/audit-store'
import type { Routine } from '../../shared/types/routine'

const TICK_MS = 30_000

class RoutineScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private executingIds = new Set<string>()

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // First tick after a short delay so app startup (DB init, settings) settles.
    setTimeout(() => this.tick(), 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(): void {
    if (this.running) return
    this.running = true
    // Swallow: a tick must never produce an unhandled rejection (DB not ready,
    // transient IO) — the next tick retries.
    this.tickAsync().catch((err) => console.warn('[RoutineScheduler] tick failed:', err)).finally(() => { this.running = false })
  }

  private async tickAsync(): Promise<void> {
    const now = Date.now()
    const routines = routineStore.list()
    for (const routine of routines) {
      if (this.executingIds.has(routine.id)) continue

      const decision = decideScheduleFire(
        {
          enabled: routine.enabled,
          cron: routine.schedule?.cron ?? '',
          nextRunAt: routine.nextRunAt,
          catchUp: routine.schedule?.catchUp,
        },
        now,
        { tickMs: TICK_MS, hasRunningRun: routineStore.hasRunningRun(routine.id) },
      )

      if (decision.advanceTo != null) {
        routineStore.update(routine.id, { nextRunAt: new Date(decision.advanceTo).toISOString() })
      }
      if (decision.fire) this.fire(routine, decision.advanceTo ?? now)
    }
  }

  private fire(routine: Routine, next: number): void {
    this.executingIds.add(routine.id)
    auditStore.record({ scope: 'routine', actor: 'scheduler', action: 'routine.fire', target: routine.id, decision: 'allowed' })
    try {
      routineRunner.start(routine, 'schedule')
    } finally {
      // Advance regardless of run outcome; the run itself reports separately.
      routineStore.update(routine.id, { nextRunAt: new Date(next).toISOString() })
      // Free the slot once the run record stops being 'running' — poll loosely.
      const check = setInterval(() => {
        if (!routineStore.hasRunningRun(routine.id)) {
          clearInterval(check)
          this.executingIds.delete(routine.id)
        }
      }, 15_000)
      // Safety: never leak the slot poller.
      setTimeout(() => clearInterval(check), 30 * 60_000)
    }
  }
}

export const routineScheduler = new RoutineScheduler()
