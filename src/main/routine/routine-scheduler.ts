// ── Routine scheduler (PLAN-0.4.0 M4.6) ──
// Minute-ish ticking scheduler in the main process. Survives window close
// (tray residency, PLAN-0.3.5 M2.3 on macOS). Design:
//   - `nextRunAt` is persisted on the routine JSON, so restarts resume.
//   - Missed fires: catchUp 'once' → run immediately, 'skip' → jump ahead.
//   - Overlap: a routine whose previous run is still 'running' is skipped.
//   - One routine run at a time globally (local app; LLM concurrency is the
//     scarce resource — the session manager's FIFO queue still guards).

import { routineStore } from '../storage/routine-store'
import { workflowStore } from '../storage/workflow-store'
import { pipelineRunStore } from '../storage/pipeline-run-store'
import { decideScheduleFire } from '../../shared/schedule/schedule-decision'
import { routineRunner, notify } from './routine-runner'
import { routineBatchRunner } from './batch-runner'
import { taskTriggerManager } from '../task/task-triggers'
import { routineRunHistory } from './routine-run-history'
import { auditStore } from '../storage/audit-store'
import { launchWorkflowRun } from '../pipeline/launch'
import { startWorkflowBatch } from '../pipeline/batch-feeder'
import { migrateRoutineConversationTypes } from '../storage/conversation.db'
import type { Routine } from '../../shared/types/routine'

const TICK_MS = 30_000
/** Retention is measured in days but this app stays resident for weeks (tray),
 *  so the prune is re-run at most this often during a session. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

class RoutineScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private executingIds = new Set<string>()
  private bootedAt = new Date().toISOString()
  private lastPruneAt = 0
  /** Workflow 定时的 nextRunAt——内存态，刻意不落盘：workflow JSON 由画布整
   *  文件写，调度器写盘会与用户保存撞车。代价（可接受）：重启后 catch-up
   *  降级为重新布防——isDue(undefined)=false 保证不会开机即火，下一个 cron
   *  拍点照常触发。 */
  private workflowNextRunAt = new Map<string, string>()

  start(): void {
    if (this.timer) return
    this.bootedAt = new Date().toISOString()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // Event triggers live with the scheduler (PLAN-routine-triggers M1): the
    // webhook endpoint binds and file watchers rebuild from the store here.
    taskTriggerManager.start()
    // First tick after a short delay so app startup (DB init, settings) settles.
    // Stale 'running' rows from a previous process must be settled before any
    // fire decision — otherwise the overlap guard blocks the routine forever.
    setTimeout(() => {
      try { migrateRoutineConversationTypes() } catch (err) { console.warn('[RoutineScheduler] conversation-type migration failed:', err) }
      try { routineStore.failStaleRuns(this.bootedAt) } catch (err) { console.warn('[RoutineScheduler] stale-run recovery failed:', err) }
      // Retention runs after stale rows were settled: the prune skips 'running'
      // rows, so this ordering lets a crashed run (now 'failed') go in the same pass.
      this.pruneHistory(true)
      this.tick()
    }, 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    taskTriggerManager.stop()
  }

  /** Enforce the saved 运行历史保留策略 (never the in-flight run). Fire and
   *  forget: a failed prune must not break the tick. */
  private pruneHistory(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = now
    void routineRunHistory.prune()
      .then((removed) => { if (removed > 0) console.log(`[RoutineScheduler] pruned ${removed} expired run records`) })
      .catch((err) => console.warn('[RoutineScheduler] run-history prune failed:', err))
  }

  tick(): void {
    if (this.running) return
    this.running = true
    this.pruneHistory()
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
    this.tickWorkflows(now)
  }

  /** Workflow 的 cron 触发段（P1 任务共享内核）：同一拍复用 decideScheduleFire，
   *  overlap 门 = pipelineRunStore.hasRunningForWorkflow，到点走 launchWorkflowRun
   *  的定时路径（单实例、工作区 mint、required 缺失落 failed 行）。 */
  private tickWorkflows(now: number): void {
    let workflows: ReturnType<typeof workflowStore.list> = []
    try {
      workflows = workflowStore.list()
    } catch (err) {
      console.warn('[RoutineScheduler] workflow list failed:', err)
      return
    }
    const liveIds = new Set(workflows.map((w) => w.id))
    // 已删/已去定时的 workflow 清掉内存布防，防 map 泄漏。
    for (const id of [...this.workflowNextRunAt.keys()]) {
      if (!liveIds.has(id)) this.workflowNextRunAt.delete(id)
    }
    for (const wf of workflows) {
      const cron = wf.schedule?.cron?.trim() ?? ''
      if (!cron) continue
      const decision = decideScheduleFire(
        {
          // 卡片开关（user 2026-11-09）：与对话式任务同一语义——没配 cron 就
          // 没有可开关的东西，配了才有意义；缺席 = 启用（旧定义零迁移）。
          enabled: wf.enabled !== false,
          cron,
          nextRunAt: this.workflowNextRunAt.get(wf.id),
          catchUp: wf.schedule?.catchUp,
        },
        now,
        { tickMs: TICK_MS, hasRunningRun: pipelineRunStore.hasRunningForWorkflow(wf.id) },
      )
      if (decision.advanceTo != null) {
        this.workflowNextRunAt.set(wf.id, new Date(decision.advanceTo).toISOString())
      }
      if (decision.fire) {
        const next = decision.advanceTo ?? now
        this.workflowNextRunAt.set(wf.id, new Date(next).toISOString())
        auditStore.record({ scope: 'routine', actor: 'scheduler', action: 'workflow.fire', target: wf.id, decision: 'allowed' })
        try {
          // 批量集成（批次 P3，与对话式任务同一判据）：勾了「定时也跑批量」且
          // 配了数据文件 → 一次 fire 跑整份数据；否则单实例。批量的子实例都是
          // running 行，所以重叠门（hasRunningForWorkflow）天然跳过后续拍点。
          if (wf.batch?.applyToSchedule && wf.batch.csvPath?.trim()) {
            void startWorkflowBatch({ workflow: wf, trigger: 'schedule' }).catch((err: unknown) => {
              notify(`工作流批量定时触发失败：${wf.name}`, err instanceof Error ? err.message : String(err))
            })
          } else {
            launchWorkflowRun({ workflow: wf, trigger: 'schedule' })
          }
        } catch (err) {
          // launch 的同步门（工作流校验等）抛错：落一条 failed run 行让运行
          // 记录如实显示，而不是静默吞掉。
          console.warn('[RoutineScheduler] workflow fire failed:', wf.id, err)
          notify(`工作流定时触发失败：${wf.name}`, err instanceof Error ? err.message : String(err))
        }
      }
    }
  }

  private fire(routine: Routine, next: number): void {
    this.executingIds.add(routine.id)
    auditStore.record({ scope: 'routine', actor: 'scheduler', action: 'routine.fire', target: routine.id, decision: 'allowed' })
    let checkTimer: ReturnType<typeof setInterval> | null = null
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (checkTimer) { clearInterval(checkTimer); checkTimer = null }
      this.executingIds.delete(routine.id)
    }
    // Fallback release poller, kept from the old design — but WITHOUT the
    // unconditional 30-min kill it used to carry: a run's 单次超时 reaches
    // 120 minutes and a 200-row batch at concurrency 1 can run for days, so a
    // fixed kill wedged every longer run's slot until restart (the routine then
    // skipped all its cron fires forever). Event release below is the primary
    // path; this poller only covers the shapes no settlement event can reach —
    // a fast-fail run whose row was created and finished before any hook was
    // wired. Its own condition (no running row) also self-clears it.
    checkTimer = setInterval(() => {
      if (!routineStore.hasRunningRun(routine.id)) release()
    }, 15_000)
    try {
      // Batch integration (L10): a routine that opted in (batch.applyToSchedule)
      // runs its whole data file on a fire; everything else stays the single
      // default. Overlap is already guarded upstream — a batch's child rows are
      // 'running' rows, so a long batch simply skips later fires. The start is
      // async now (xlsx read), so a refusal surfaces as a notification instead
      // of an unhandled rejection inside the tick.
      if (routine.batch?.applyToSchedule) {
        void routineBatchRunner.start(routine, 'schedule', undefined, release).catch((err: unknown) => {
          notify(`批量任务启动失败：${routine.name}`, err instanceof Error ? err.message : String(err))
          // A refused start never creates a run row, so no settlement event can
          // release the slot — release here.
          release()
        })
      } else routineRunner.start(routine, 'schedule', undefined, release)
    } finally {
      // Advance regardless of run outcome; the run itself reports separately.
      routineStore.update(routine.id, { nextRunAt: new Date(next).toISOString() })
    }
  }
}

export const routineScheduler = new RoutineScheduler()
