// ── Routine event triggers (PLAN-routine-triggers M1) ──
// Two LOCAL event sources that start a routine outside the cron schedule:
//   - file:    fs.watch (recursive where the platform allows) over declared
//              paths, trailing-debounced per routine;
//   - webhook: a loopback-only HTTP endpoint — POST /routine/<id>/fire?token=…
//              on 127.0.0.1, per-routine token minted by the store at save.
//
// Discipline carried over from the scheduler:
//   - a trigger fire goes through the SAME door as a manual run
//     (routineRunner.start — assert params, mint the row, executeUnattended);
//     it never touches `nextRunAt`, so cron math is untouched;
//   - overlap: a routine with a 'running' row silently drops the event
//     (audit `skipped`, webhook answers 409) — no queuing, no pile-up;
//   - LIVE-ONLY: events seen while the app is closed are gone; cron remains
//     the only catch-up-able source. The routine form says so in copy.
//
// Public webhooks (SaaS → this endpoint) are the user's bridge to build
// (ntfy / a gateway forwarding to 127.0.0.1); the endpoint never leaves the
// loopback — same posture as the data-at-rest story.

import { watch, type FSWatcher } from 'node:fs'
import * as http from 'node:http'
import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import { routineRunner } from './routine-runner'
import type { RoutineWebhookTrigger } from '../../shared/types/routine'

const WEBHOOK_PORTS = [8780, 8781, 8782, 8783, 8784, 8785, 8786, 8787, 8788, 8789]
const DEFAULT_DEBOUNCE_MS = 5_000

class RoutineTriggerManager {
  private watchers = new Map<string, FSWatcher[]>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private server: http.Server | null = null
  private started = false
  /** Resolved loopback port (0 fallback = ephemeral); surfaced to the UI so
   *  the editor can show the full fire URL. */
  port = 0

  /** Reconcile watchers with the stored routines. Called at start and after
   *  every routine create/update/delete/toggle. */
  sync(): void {
    if (!this.started) return
    const wanted = new Set<string>()
    for (const routine of routineStore.list()) {
      const paths = (routine.triggers ?? [])
        .filter((t) => t.type === 'file')
        .flatMap((t) => (t.type === 'file' ? t.paths : []))
      if (!routine.enabled || paths.length === 0) continue
      wanted.add(routine.id)
      if (this.watchers.has(routine.id)) continue // already watching; re-watching would double-fire
      this.watchers.set(routine.id, this.watchPaths(routine.id, paths))
    }
    // Routines whose triggers were removed / disabled / deleted.
    for (const [routineId, ws] of this.watchers) {
      if (wanted.has(routineId)) continue
      for (const w of ws) w.close()
      this.clearDebounce(routineId)
      this.watchers.delete(routineId)
    }
  }

  /** Watchers for one routine. A failed watch (missing path, no recursive
   *  support) degrades loudly to non-recursive — never silently. */
  private watchPaths(routineId: string, paths: string[]): FSWatcher[] {
    const watchers: FSWatcher[] = []
    for (const p of paths) {
      try {
        const w = watch(p, { recursive: true }, () => this.scheduleFire(routineId))
        w.on('error', (err) => console.warn(`[RoutineTriggers] watcher error on ${p}:`, err))
        watchers.push(w)
      } catch {
        try {
          const w = watch(p, () => this.scheduleFire(routineId))
          w.on('error', () => {})
          watchers.push(w)
          console.warn(`[RoutineTriggers] recursive watch unavailable for ${p} — watching non-recursively`)
        } catch (err) {
          console.warn(`[RoutineTriggers] cannot watch ${p}:`, err instanceof Error ? err.message : err)
        }
      }
    }
    return watchers
  }

  /** Trailing debounce per ROUTINE (not per path): events inside the window
   *  push the fire back, so a burst of writes collapses into one run. */
  private scheduleFire(routineId: string): void {
    const routine = routineStore.get(routineId)
    const debounce = routine?.triggers
      ?.filter((t) => t.type === 'file')
      .reduce<number | undefined>((acc, t) => (t.type === 'file' ? (t.debounceMs ?? acc) : acc), undefined)
      ?? DEFAULT_DEBOUNCE_MS
    this.clearDebounce(routineId)
    this.debounceTimers.set(routineId, setTimeout(() => {
      this.debounceTimers.delete(routineId)
      this.fireTrigger(routineId, 'file')
    }, debounce))
  }

  private clearDebounce(routineId: string): void {
    const t = this.debounceTimers.get(routineId)
    if (t) { clearTimeout(t); this.debounceTimers.delete(routineId) }
  }

  /** The one fire door. Returns false when the event was dropped (disabled
   *  routine / overlap) — the webhook layer answers 409, file events just
   *  vanish with an audit row. */
  fireTrigger(routineId: string, trigger: 'file' | 'webhook'): boolean {
    const routine = routineStore.get(routineId)
    if (!routine || !routine.enabled) return false
    if (routineStore.hasRunningRun(routineId)) {
      auditStore.record({
        scope: 'routine', actor: trigger, action: 'routine.fire', target: routineId,
        decision: 'skipped', metaJson: JSON.stringify({ reason: 'overlap' }),
      })
      return false
    }
    auditStore.record({ scope: 'routine', actor: trigger, action: 'routine.fire', target: routineId, decision: 'allowed' })
    try {
      // Batch routines fire as a SINGLE run from a trigger: applyToSchedule is
      // a cron-fire opt-in, and an event burst must not start a hundred-row
      // batch per save. A trigger-driven batch run stays available manually.
      routineRunner.start(routine, trigger)
    } catch (err) {
      console.warn(`[RoutineTriggers] ${trigger} fire failed for ${routineId}:`, err instanceof Error ? err.message : err)
    }
    return true
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.listen()
    this.sync()
  }

  stop(): void {
    this.started = false
    for (const [routineId, ws] of this.watchers) {
      for (const w of ws) w.close()
      this.clearDebounce(routineId)
    }
    this.watchers.clear()
    if (this.server) {
      this.server.close()
      this.server = null
      this.port = 0
    }
  }

  /** Loopback-only listener. Deterministic port scan (8780..8789) then an
   *  ephemeral fallback — the UI reads the resolved port back over IPC. */
  private async listen(): Promise<void> {
    for (const port of [...WEBHOOK_PORTS, 0]) {
      const server = http.createServer((req, res) => { void this.handleWebhook(req, res) })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => resolve())
        })
        this.server = server
        this.port = (server.address() as { port: number }).port
        console.log(`[RoutineTriggers] webhook endpoint on http://127.0.0.1:${this.port}/routine/<id>/fire`)
        return
      } catch {
        server.close()
        server.closeAllConnections()
      }
    }
    console.warn('[RoutineTriggers] no webhook port available — webhook triggers are dormant this session')
  }

  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const m = u.pathname.match(/^\/routine\/([A-Za-z0-9_-]+)\/fire$/)
    const token = u.searchParams.get('token') ?? ''
    const routine = m ? routineStore.get(m[1]) : null
    const trigger = routine?.triggers?.find((t): t is RoutineWebhookTrigger => t.type === 'webhook')
    // 404 for unknown routine, disabled routine and wrong token alike — the
    // endpoint must not let a prober enumerate what exists (plan §7.2).
    if (!routine || !routine.enabled || !trigger || trigger.token !== token) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = this.fireTrigger(routine.id, 'webhook') ? 204 : 409
    res.end()
  }
}

export const routineTriggerManager = new RoutineTriggerManager()
