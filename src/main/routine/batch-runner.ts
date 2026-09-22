// ── Batch runner (PLAN-routine-batch M3) ──
// Executes a routine once per CSV row, each row an independent conversation
// through the SAME unattended primitive a single run uses (routine-runner's
// executeUnattended) — the gates, timeout and settlement are not re-implemented
// here, only the dispatch: per-row child run rows over a BatchQueue worker
// pool, and the parent row's progress/settlement.
//
// State lives in memory (keyed by parent run id) exactly like the scheduler's
// executingIds: a batch never resumes across a restart — failStaleRuns settles
// the leftover rows at boot and the user re-fires.

import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { shortUuid } from '../utils/id'
import { notify, executeUnattended } from './routine-runner'
import { BatchQueue } from './batch-queue'
import { loadBatchSource, type BatchSource } from './batch-source'
import { rowParamsAt, DEFAULT_BATCH_CONCURRENCY, normalizeBatchConcurrency } from '../../shared/routine/batch'
import { assertRunnableParams } from '../../shared/routine/params'
import type { Routine, RoutineRun } from '../../shared/types/routine'

interface BatchState {
  parentRun: RoutineRun
  routine: Routine
  source: BatchSource
  totalRows: number
  queue: BatchQueue
  stopped: boolean
  settled: { success: number; failed: number; skipped: number }
  /** In-flight rows by conversation id — what 停止 has to interrupt. */
  inFlightHandles: Map<string, { stop: () => void }>
  parentSettled: boolean
}

class BatchRunner {
  private active = new Map<string, BatchState>()
  /** Serializes per-row workspace mints: rows of one batch dispatch together,
   *  and two interleaved resolve-then-persist sequences would both read "not
   *  taken" and claim the same same-second folder name (the probe caught
   *  exactly that). One chain for all batches is fine — a mint is two quick
   *  awaits, and different routines mint under the same global workspace. */
  private mintChain: Promise<unknown> = Promise.resolve()

  /** Fire-and-forget; returns the parent run row (already 'running') so the
   *  caller can jump into the workspace. Throws synchronously for the refusal
   *  cases (another batch active, file unreadable, mapping broken) — a manual
   *  click surfaces the reason; the scheduler only calls this when
   *  applyToSchedule is set and never over a running routine (overlap guard),
   *  and it is the one deciding whether a fire means batch or single (L10).
   *  `overrides.concurrency` is the start dialog's per-run choice (user
   *  2026-09-22: the pool size must be adjustable where the run is started);
   *  absent, the routine's configured value applies, then the default. */
  start(routine: Routine, trigger: RoutineRun['trigger'], overrides?: { concurrency?: number }): RoutineRun {
    for (const state of this.active.values()) {
      if (state.routine.id === routine.id) {
        throw new Error(`「${routine.name}」已有批量运行在进行，请等待完成或先停止`)
      }
    }
    const source = loadBatchSource(routine)
    // normalizeBatchConcurrency throws on present-but-invalid values, so a
    // hand-crafted payload cannot widen the pool; a saved config was already
    // validated at the save door — re-running it here is belt.
    const concurrency = normalizeBatchConcurrency(overrides?.concurrency)
      ?? normalizeBatchConcurrency(routine.batch?.concurrency)
      ?? DEFAULT_BATCH_CONCURRENCY
    const parentRun = routineStore.startBatchRun(routine.id, trigger, {
      csvName: source.csvName,
      totalRows: source.rows.length,
      concurrency,
    })
    auditStore.record({ scope: 'routine', actor: routine.id, action: 'batch.start', target: parentRun.id, decision: 'allowed' })
    const state: BatchState = {
      parentRun,
      routine,
      source,
      totalRows: source.rows.length,
      queue: new BatchQueue(source.rows.length, concurrency, (index) => this.executeRowAt(state, index)),
      stopped: false,
      settled: { success: 0, failed: 0, skipped: 0 },
      inFlightHandles: new Map(),
      parentSettled: false,
    }
    this.active.set(parentRun.id, state)
    state.queue.start()
    return parentRun
  }

  /** 停止: no new rows (queued ones settle as 已跳过), in-flight rows are
   *  interrupted through their run handle, and the parent settles by counts. */
  stop(parentRunId: string): void {
    const state = this.active.get(parentRunId)
    if (!state) return
    state.stopped = true
    auditStore.record({ scope: 'routine', actor: state.routine.id, action: 'batch.stop', target: parentRunId, decision: 'allowed' })
    // Queued rows never got a session — record them so the item table shows
    // every row with its outcome.
    for (const rowIndex of state.queue.stop()) {
      const provided = rowParamsAt(state.source.headers, state.source.rows, state.routine.params, rowIndex)
      const child = routineStore.startBatchChildRun(state.parentRun, rowIndex, provided, null)
      routineStore.finishRun(child.id, { status: 'skipped' })
      state.settled.skipped++
    }
    for (const handle of state.inFlightHandles.values()) handle.stop()
    this.maybeSettleParent(state)
  }

  /** Whether the parent is still in the pool (a stopped/finished parent is
   *  not — and after a restart nothing is: leftovers were settled as failed). */
  isActive(parentRunId: string): boolean {
    return this.active.has(parentRunId)
  }

  // ── internals ──

  /** One row, dispatch to settlement. The returned promise resolves when the
   *  row truly settled — that is the pool's slot release, so the concurrency
   *  ceiling is only as real as this promise's honesty. */
  private executeRowAt(state: BatchState, rowIndex: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const { routine, source } = state
      const provided = rowParamsAt(source.headers, source.rows, routine.params, rowIndex)
      // Parameter pre-check BEFORE anything expensive: a row whose required
      // values resolve blank would run a mangled prompt — it becomes a failed
      // child row with no engine call (and no conversation to click through).
      let precheckError: string | null = null
      try {
        assertRunnableParams(routine, provided)
      } catch (err) {
        precheckError = `${err instanceof Error ? err.message : String(err)}（第 ${rowIndex + 1} 行）`
      }
      if (precheckError != null) {
        const child = routineStore.startBatchChildRun(state.parentRun, rowIndex, provided, null)
        routineStore.finishRun(child.id, { status: 'failed', error: precheckError })
        state.settled.failed++
        this.maybeSettleParent(state)
        resolve()
        return
      }
      const convId = `routine_${Date.now()}_${shortUuid(6)}`
      const child = routineStore.startBatchChildRun(state.parentRun, rowIndex, provided, convId)
      const entry: { stop: () => void } = { stop: () => undefined }
      state.inFlightHandles.set(convId, entry)
      // The mint rides the serial chain (a pinned routine dir skips it —
      // executeUnattended passes it through untouched).
      const pinnedDir = state.routine.workspaceDir?.trim() || undefined
      const minted = pinnedDir
        ? Promise.resolve(pinnedDir)
        : (this.mintChain = this.mintChain.then(
            () => resolveConversationWorkspace(convId),
            () => resolveConversationWorkspace(convId),
          ))
      void minted.then((dir) => {
        const handle = executeUnattended({
          runId: child.id,
          routine,
          convId,
          params: provided,
          transcriptLabel: `[日常] ${routine.name} · 第${rowIndex + 1}行`,
          row: String(rowIndex + 1),
          notifyOnFinish: false,
          workspaceDir: dir,
          onSettled: (status) => {
            state.inFlightHandles.delete(convId)
            state.settled[status]++
            this.maybeSettleParent(state)
            resolve()
          },
        })
        entry.stop = handle.stop
      }, (err: unknown) => {
        // A failed mint must settle the row — otherwise it hangs 'running'
        // and holds the parent (and the overlap guard) open forever.
        routineStore.finishRun(child.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
        state.inFlightHandles.delete(convId)
        state.settled.failed++
        this.maybeSettleParent(state)
        resolve()
      })
    })
  }

  /** The parent settles when every row has an outcome — never later than the
   *  last row's settlement, so the overlap guard opens as soon as it can. */
  private maybeSettleParent(state: BatchState): void {
    if (state.parentSettled) return
    const { success, failed, skipped } = state.settled
    if (success + failed + skipped < state.totalRows) return
    state.parentSettled = true
    this.active.delete(state.parentRun.id)
    let status: RoutineRun['status']
    if (failed === 0 && skipped === 0) status = 'success'
    else if (success === 0 && failed === state.totalRows) status = 'failed'
    else if (success === 0 && failed === 0) status = 'skipped'
    else status = 'partial'
    const summary = `成功 ${success} / 失败 ${failed}` + (skipped > 0 ? ` / 跳过 ${skipped}` : '')
    routineStore.finishRun(state.parentRun.id, { status, error: status === 'success' ? undefined : summary })
    // One notification per BATCH, never per row (a hundred rows would be a
    // hundred toasts); a batch stopped before it ran anything stays silent —
    // the user pressed the stop themselves.
    if (status !== 'skipped') {
      notify(
        status === 'success' ? `批量任务完成：${state.routine.name}` : status === 'failed' ? `批量任务失败：${state.routine.name}` : `批量任务部分完成：${state.routine.name}`,
        status === 'success' ? `全部 ${state.totalRows} 行执行成功` : summary,
      )
    }
  }
}

export const routineBatchRunner = new BatchRunner()
