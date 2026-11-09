// ── Task event triggers (PLAN-routine-triggers M1; 两模式同一套 user 2026-11-08) ──
// Two LOCAL event sources that start a task outside the cron schedule:
//   - file:    fs.watch (recursive where the platform allows) over declared
//              paths, trailing-debounced per task;
//   - webhook: a loopback-only HTTP endpoint —
//              POST /routine/<id>/fire?token=…  (对话式任务)
//              POST /workflow/<id>/fire?token=… (工作流)
//              on 127.0.0.1, per-task token minted by the store at save.
//
// 「两种模式在触发与批量上的能力一致，以任务式对话为准」(user 2026-11-08):
// the manager is task-keyed, not routine-keyed. A workflow fire goes through
// its own single door (launchWorkflowRun) exactly like a routine fire goes
// through routineRunner.start — same discipline, different runner.
//
// Discipline carried over from the scheduler:
//   - a trigger fire goes through the SAME door as a manual run (routine:
//     routineRunner.start — assert params, mint the row, executeUnattended;
//     workflow: launchWorkflowRun — required gate, mint the run row, enqueue);
//     it never touches `nextRunAt`, so cron math is untouched;
//   - overlap: a task with a 'running' run silently drops the event (audit
//     `skipped`, webhook answers 409) — no queuing, no pile-up;
//   - LIVE-ONLY: events seen while the app is closed are gone; cron remains
//     the only catch-up-able source. Both editors say so in copy.
//
// Public webhooks (SaaS → this endpoint) are the user's bridge to build
// (ntfy / a gateway forwarding to 127.0.0.1); the endpoint never leaves the
// loopback — same posture as the data-at-rest story.

import { watch, type FSWatcher } from 'node:fs'
import * as http from 'node:http'
import { routineStore } from '../storage/routine-store'
import { workflowStore } from '../storage/workflow-store'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { auditStore } from '../storage/audit-store'
import { routineRunner } from '../routine/routine-runner'
import { launchWorkflowRun } from '../pipeline/launch'
import type { TaskKind } from '../../shared/task/triggers'
import type { RoutineWebhookTrigger, RoutineTrigger } from '../../shared/types/routine'

const WEBHOOK_PORTS = [8780, 8781, 8782, 8783, 8784, 8785, 8786, 8787, 8788, 8789]
const DEFAULT_DEBOUNCE_MS = 5_000

/** The two task families the manager serves. The key prefix keeps a routine id
 *  and a workflow id from ever colliding in the watcher maps. */
type FireTrigger = 'file' | 'webhook'

function taskKey(kind: TaskKind, id: string): string {
  return `${kind}:${id}`
}

function parseTaskKey(key: string): { kind: TaskKind; id: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  const kind = key.slice(0, i)
  if (kind !== 'routine' && kind !== 'workflow') return null
  return { kind, id: key.slice(i + 1) }
}

/** The one lookup both `sync()` and `fireTrigger()` use — a missing/disabled
 *  row is simply null (no fire, no watcher). Returns the loaded row itself so
 *  a fire never re-reads the store: the row checked at the gate IS the row
 *  handed to the runner (a second read would also open a delete-in-between
 *  window, and review_20261007 中5 was exactly about per-fire store reads). */
type LoadedTask =
  | { kind: 'routine'; enabled: boolean; triggers: RoutineTrigger[]; row: NonNullable<ReturnType<typeof routineStore.get>> }
  | { kind: 'workflow'; enabled: boolean; triggers: RoutineTrigger[]; row: NonNullable<ReturnType<typeof workflowStore.get>> }

function loadTask(kind: TaskKind, id: string): LoadedTask | null {
  if (kind === 'routine') {
    const r = routineStore.get(id)
    return r ? { kind, enabled: r.enabled, triggers: r.triggers ?? [], row: r } : null
  }
  const w = workflowStore.get(id)
  // 启停位与对话式任务同形（user 2026-11-09 卡片统一开关）：缺席 = 启用。
  // 关掉之后文件变化 / 回环 webhook 都不再自动跑，手动运行不受影响。
  return w ? { kind, enabled: w.enabled !== false, triggers: w.triggers ?? [], row: w } : null
}

export class TaskTriggerManager {
  private watchers = new Map<string, FSWatcher[]>()
  /** The path set each watcher entry is mounted on — "already watching" is
   *  only true when these still match the store (review_20261007 高2: an
   *  id-stable, path-blind check let an edited path keep the OLD watcher live
   *  while the NEW path never watched, silently, until a restart). */
  private watchKeys = new Map<string, string>()
  /** Debounce per task, cached at sync() time. scheduleFire used to read the
   *  store per fs event for this — the store has no memory cache, so a build
   *  in a watched directory put hundreds of synchronous
   *  readFileSync+JSON.parse on the shared main process (review_20261007 中5). */
  private debounceMsCache = new Map<string, number>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private server: http.Server | null = null
  private started = false
  /** Resolved loopback port (0 fallback = ephemeral); surfaced to the UI so
   *  the editors can show the full fire URL. */
  port = 0

  /** Reconcile watchers with the stored tasks (both families). Called at start
   *  and after every create/update/delete/toggle of either family. */
  sync(): void {
    if (!this.started) return
    const wanted = new Set<string>()
    const desired: Array<{ key: string; paths: string[]; debounceMs: number }> = []
    const families: Array<{ kind: TaskKind; list: Array<{ id: string; enabled?: boolean; triggers?: RoutineTrigger[] }> }> = [
      { kind: 'routine', list: routineStore.list() },
      { kind: 'workflow', list: workflowStore.list() },
    ]
    for (const { kind, list } of families) {
      for (const task of list) {
        const fileTriggers = (task.triggers ?? []).filter((t) => t.type === 'file')
        const paths = fileTriggers.flatMap((t) => t.paths)
        if (task.enabled === false || paths.length === 0) continue
        const key = taskKey(kind, task.id)
        wanted.add(key)
        const debounceMs = fileTriggers.reduce<number | undefined>((acc, t) => t.debounceMs ?? acc, undefined) ?? DEFAULT_DEBOUNCE_MS
        desired.push({ key, paths, debounceMs })
      }
    }
    for (const { key, paths, debounceMs } of desired) {
      const mountKey = JSON.stringify(paths)
      if (this.watchers.has(key)) {
        if (this.watchKeys.get(key) === mountKey) {
          this.debounceMsCache.set(key, debounceMs) // a debounce-only edit still applies
          continue // same paths still mounted; re-watching would double-fire
        }
        this.closeWatchers(key) // path edit: close the old mount first — "close, then open" is the double-fire guard
      }
      // Set AFTER closeWatchers: the teardown drops the cache entry, and the
      // fresh mount must not fall back to the default window.
      this.debounceMsCache.set(key, debounceMs)
      this.watchKeys.set(key, mountKey)
      this.watchers.set(key, this.watchPaths(key, paths))
    }
    // Tasks whose triggers were removed / disabled / deleted.
    for (const key of [...this.watchers.keys()]) {
      if (wanted.has(key)) continue
      this.closeWatchers(key)
    }
  }

  /** The one teardown: handles closed, pending debounce and cached mount
   *  state dropped — used by path re-mount and removal alike. */
  private closeWatchers(key: string): void {
    const ws = this.watchers.get(key)
    if (ws) for (const w of ws) w.close()
    this.watchers.delete(key)
    this.watchKeys.delete(key)
    this.debounceMsCache.delete(key)
    this.clearDebounce(key)
  }

  /** Watchers for one task. A failed watch (missing path, no recursive
   *  support) degrades loudly to non-recursive — never silently. */
  private watchPaths(key: string, paths: string[]): FSWatcher[] {
    const watchers: FSWatcher[] = []
    for (const p of paths) {
      try {
        const w = watch(p, { recursive: true }, () => this.scheduleFire(key))
        w.on('error', (err) => console.warn(`[TaskTriggers] watcher error on ${p}:`, err))
        watchers.push(w)
      } catch {
        try {
          const w = watch(p, () => this.scheduleFire(key))
          w.on('error', () => {})
          watchers.push(w)
          console.warn(`[TaskTriggers] recursive watch unavailable for ${p} — watching non-recursively`)
        } catch (err) {
          console.warn(`[TaskTriggers] cannot watch ${p}:`, err instanceof Error ? err.message : err)
        }
      }
    }
    return watchers
  }

  /** Trailing debounce per TASK (not per path): events inside the window push
   *  the fire back, so a burst of writes collapses into one run. The window
   *  length rides the value sync() cached — no store read here, this runs on
   *  every fs event (review_20261007 中5). */
  private scheduleFire(key: string): void {
    const debounce = this.debounceMsCache.get(key) ?? DEFAULT_DEBOUNCE_MS
    this.clearDebounce(key)
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key)
        this.fireTrigger(key, 'file')
      }, debounce),
    )
  }

  private clearDebounce(key: string): void {
    const t = this.debounceTimers.get(key)
    if (t) {
      clearTimeout(t)
      this.debounceTimers.delete(key)
    }
  }

  /** The one fire door (both families). Returns false when the event was
   *  dropped (missing/disabled task, overlap) — the webhook layer answers 409,
   *  file events just vanish with an audit row. */
  fireTrigger(key: string, trigger: FireTrigger): boolean {
    const parsed = parseTaskKey(key)
    if (!parsed) return false
    const task = loadTask(parsed.kind, parsed.id)
    if (!task || !task.enabled) return false
    const action = `${parsed.kind}.fire`
    if (this.hasRunningRun(task.kind, parsed.id)) {
      auditStore.record({
        scope: parsed.kind,
        actor: trigger,
        action,
        target: parsed.id,
        decision: 'skipped',
        metaJson: JSON.stringify({ reason: 'overlap' }),
      })
      return false
    }
    auditStore.record({ scope: parsed.kind, actor: trigger, action, target: parsed.id, decision: 'allowed' })
    try {
      // 批量配置是 cron 的 opt-in（applyToSchedule），事件触发恒起**单个**
      // 实例：一次保存/一串 fs 事件不该起一整批；批量仍可手动发起。
      // 用 loadTask 已经读到的那一行（不再二次读盘）。
      if (task.kind === 'routine') routineRunner.start(task.row, trigger)
      else launchWorkflowRun({ workflow: task.row, trigger })
    } catch (err) {
      console.warn(`[TaskTriggers] ${trigger} fire failed for ${key}:`, err instanceof Error ? err.message : err)
    }
    return true
  }

  private hasRunningRun(kind: TaskKind, id: string): boolean {
    return kind === 'routine' ? routineStore.hasRunningRun(id) : pipelineRunStore.hasRunningForWorkflow(id)
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.listen()
    this.sync()
  }

  stop(): void {
    this.started = false
    for (const key of [...this.watchers.keys()]) this.closeWatchers(key)
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
      const server = http.createServer((req, res) => {
        void this.handleWebhook(req, res)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => resolve())
        })
        this.server = server
        this.port = (server.address() as { port: number }).port
        console.log(`[TaskTriggers] webhook endpoint on http://127.0.0.1:${this.port}/routine/<id>/fire · /workflow/<id>/fire`)
        return
      } catch {
        server.close()
        server.closeAllConnections()
      }
    }
    console.warn('[TaskTriggers] no webhook port available — webhook triggers are dormant this session')
  }

  private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const m = u.pathname.match(/^\/(routine|workflow)\/([A-Za-z0-9_-]+)\/fire$/)
    const token = u.searchParams.get('token') ?? ''
    const kind = (m?.[1] as TaskKind | undefined) ?? null
    const id = m?.[2] ?? ''
    const task = kind ? loadTask(kind, id) : null
    const trigger = task?.triggers.find((t): t is RoutineWebhookTrigger => t.type === 'webhook')
    // 404 for unknown task, disabled task and wrong token alike — the endpoint
    // must not let a prober enumerate what exists (plan §7.2).
    if (!task || !task.enabled || !trigger || trigger.token !== token) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = this.fireTrigger(taskKey(task.kind, id), 'webhook') ? 204 : 409
    res.end()
  }
}

export const taskTriggerManager = new TaskTriggerManager()
