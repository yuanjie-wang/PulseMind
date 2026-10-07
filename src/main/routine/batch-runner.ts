// ── Batch runner (PLAN-routine-batch M3; resume per PLAN-batch-resume) ──
// Executes a routine once per CSV row, each row an independent conversation
// through the SAME unattended primitive a single run uses (routine-runner's
// executeUnattended) — the gates, timeout and settlement are not re-implemented
// here, only the dispatch: per-row child run rows over a BatchQueue worker
// pool, and the parent row's progress/settlement.
//
// Live state is in memory (keyed by parent run id), but the RECORD is all in
// routine_runs — one parent row + one child row per attempt. That is what makes
// 「继续运行」 possible: an interrupted batch (user stop, or the process dying —
// failStaleRuns settles the leftovers at boot) is re-opened under the SAME
// parent and only its unfinished rows are dispatched again, as a new wave of
// child rows. Progress and settlement always read the store folded to each
// row's LATEST attempt, so waves stack without double-counting.

import { routineStore } from '../storage/routine-store'
import { auditStore } from '../storage/audit-store'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { shortUuid } from '../utils/id'
import { notify, executeUnattended } from './routine-runner'
import { postSettlementEvent } from './webhook-out'
import { BatchQueue } from './batch-queue'
import { loadBatchSource } from './batch-source'
import { rowParamsAt, planResumeRows, progressFromAttempts, DEFAULT_BATCH_CONCURRENCY, normalizeBatchConcurrency, normalizeBatchTimeoutMinutes, effectiveTimeoutMinutes } from '../../shared/routine/batch'
import { assertRunnableParams } from '../../shared/routine/params'
import type { Routine, RoutineRun } from '../../shared/types/routine'

interface BatchState {
  parentRun: RoutineRun
  routine: Routine
  /** The CSV rows this run executes (a fresh batch: all of them; a resume
   *  wave: only the unfinished ones, under their real row numbers). */
  indices: number[]
  /** Values per row index — snapshots for rows that ran and failed, CSV-derived
   *  for the rest. Complete over `indices`; the dispatch path never re-reads. */
  paramsByIndex: Map<number, Record<string, string>>
  /** The batch's declared row count — the settlement denominator (a wave's
   *  settlement describes the whole batch, not just its own rows). */
  totalRows: number
  queue: BatchQueue
  stopped: boolean
  settled: { success: number; failed: number; skipped: number }
  /** Auto-handled approvals/questions aggregated from the rows'
   *  onSettled — the parent's one settlement webhook carries the totals. */
  skippedCalls: { approvals: number; questions: number }
  /** Per-row hard ceiling in minutes — every row of this run executes under
   *  it (executeUnattended's timeoutMs). Frozen at start/resume so a config
   *  edit mid-batch cannot move a running row's goalposts. */
  timeoutMinutes: number
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

  /** Fire-and-forget; resolves with the parent run row (already 'running') so
   *  the caller can jump into the workspace. Async because the source read is
   *  (xlsx has no sync load); the refusal cases (another batch active, file
   *  unreadable, mapping broken) REJECT — a manual click surfaces the reason;
   *  the scheduler only calls this when applyToSchedule is set and never over
   *  a running routine (overlap guard), and it is the one deciding whether a
   *  fire means batch or single (L10).
   *  `overrides.concurrency` is the start dialog's per-run choice (user
   *  2026-09-22: the pool size must be adjustable where the run is started);
   *  absent, the routine's configured value applies, then the default. Same
   *  chain for `overrides.timeoutMinutes` — each row's 单次超时 (user
   *  2026-09-23: a hung row must be stoppable at a configured bound). */
  async start(routine: Routine, trigger: RoutineRun['trigger'], overrides?: { concurrency?: number; timeoutMinutes?: number }): Promise<RoutineRun> {
    for (const state of this.active.values()) {
      if (state.routine.id === routine.id) {
        throw new Error(`「${routine.name}」已有批量运行在进行，请等待完成或先停止`)
      }
    }
    const source = await loadBatchSource(routine)
    // The guard above must hold at WRITE time, and the read yields to get here
    // (xlsx: dynamic import + zip load), so another start/resume can pass ITS
    // guard while we wait. Re-check now; from startBatchRun down everything is
    // synchronous, so whichever caller resumes from the await first wins.
    for (const state of this.active.values()) {
      if (state.routine.id === routine.id) {
        throw new Error(`「${routine.name}」已有批量运行在进行，请等待完成或先停止`)
      }
    }
    // normalizeBatchConcurrency throws on present-but-invalid values, so a
    // hand-crafted payload cannot widen the pool; a saved config was already
    // validated at the save door — re-running it here is belt. The timeout
    // chain mirrors it (a bad value must refuse the start, not fire late).
    const concurrency = normalizeBatchConcurrency(overrides?.concurrency)
      ?? normalizeBatchConcurrency(routine.batch?.concurrency)
      ?? DEFAULT_BATCH_CONCURRENCY
    const timeoutMinutes = normalizeBatchTimeoutMinutes(overrides?.timeoutMinutes)
      ?? effectiveTimeoutMinutes(routine.batch)
    const parentRun = routineStore.startBatchRun(routine.id, trigger, {
      csvName: source.csvName,
      totalRows: source.rows.length,
      concurrency,
      timeoutMinutes,
    })
    auditStore.record({ scope: 'routine', actor: routine.id, action: 'batch.start', target: parentRun.id, decision: 'allowed' })
    this.spawn(parentRun, routine, source.rows.length, (i) => rowParamsAt(source.headers, source.rows, routine.params, i), concurrency, timeoutMinutes)
    return parentRun
  }

  /** Continue an interrupted batch under the SAME parent run: re-open the
   *  parent and dispatch only the rows without a successful outcome, as a new
   *  wave of child rows. Values follow the snapshot rule — a row that ran and
   *  failed is frozen to its snapshot (the CSV may have changed under it);
   *  rows that never reached the engine take their values from the live CSV.
   *  Rejects for the refusal cases, like start. */
  async resume(parentRunId: string): Promise<RoutineRun> {
    const parent = routineStore.getRun(parentRunId)
    if (!parent?.batch) throw new Error('未找到该批量运行记录')
    if (parent.status === 'running') throw new Error('该批量运行仍在进行中，请等待完成或先停止')
    for (const state of this.active.values()) {
      if (state.routine.id === parent.routineId) {
        throw new Error(`「${state.routine.name}」已有批量运行在进行，请等待完成或先停止`)
      }
    }
    const routine = routineStore.get(parent.routineId)
    if (!routine) throw new Error('原任务已被删除，无法继续该批量运行')
    const total = parent.batch.totalRows
    const plan = planResumeRows(total, routineStore.listBatchChildren(parentRunId))
    if (plan.indices.length === 0) throw new Error('该批量的每一行都已成功，无需继续')
    // The CSV is validated (readable, required columns, row cap) only when the
    // wave needs it — and its row count must still match the parent's, or the
    // indices no longer mean the rows they meant when the batch ran.
    const paramsByIndex = new Map(plan.snapshotParams)
    if (plan.csvIndices.length > 0) {
      const source = await loadBatchSource(routine)
      if (source.rows.length !== total) {
        throw new Error(`批量数据行数已变化（${source.rows.length} 行 ≠ 原批量 ${total} 行），无法按原行号继续，请重新发起批量`)
      }
      for (const i of plan.csvIndices) {
        paramsByIndex.set(i, rowParamsAt(source.headers, source.rows, routine.params, i))
      }
    }
    // Same post-await re-check as start: a concurrent start/resume of this
    // routine can have entered the pool while we read the file (a fresh CSV
    // wave may not await at all — the re-check is then a harmless no-op).
    for (const state of this.active.values()) {
      if (state.routine.id === parent.routineId) {
        throw new Error(`「${state.routine.name}」已有批量运行在进行，请等待完成或先停止`)
      }
    }
    // Values resume what the PARENT ran with, not what the routine is
    // configured with now: start() records the effective per-run values in the
    // parent meta, and the workspace header reads them back — so a long task
    // given a 120-minute per-run override must not have its remaining rows
    // re-killed by the config default (15 minutes), and config edits between
    // waves must not silently diverge the header's number from the limit the
    // rows actually run under (review0924 M4).
    const concurrency = normalizeBatchConcurrency(parent.batch?.concurrency)
      ?? normalizeBatchConcurrency(routine.batch?.concurrency)
      ?? DEFAULT_BATCH_CONCURRENCY
    const timeoutMinutes = normalizeBatchTimeoutMinutes(parent.batch?.timeoutMinutes)
      ?? effectiveTimeoutMinutes(routine.batch)
    routineStore.reopenBatchRun(parentRunId)
    auditStore.record({ scope: 'routine', actor: routine.id, action: 'batch.resume', target: parentRunId, decision: 'allowed' })
    this.spawn({ ...parent, status: 'running', finishedAt: undefined, error: undefined }, routine, total, (i) => paramsByIndex.get(i) ?? {}, concurrency, timeoutMinutes, plan.indices)
    return routineStore.getRun(parentRunId) ?? parent
  }

  /** Wire a batch state over the given rows and start the pool. `rowsFor` maps
   *  a row index to its values: computed from the CSV for a fresh batch, from
   *  the resume plan for a wave. */
  private spawn(parentRun: RoutineRun, routine: Routine, totalRows: number, rowsFor: (index: number) => Record<string, string>, concurrency: number, timeoutMinutes: number, indices?: number[]): BatchState {
    const rows = indices ?? Array.from({ length: totalRows }, (_, i) => i)
    const paramsByIndex = new Map<number, Record<string, string>>(rows.map((i) => [i, rowsFor(i)]))
    const state: BatchState = {
      parentRun,
      routine,
      indices: rows,
      paramsByIndex,
      totalRows,
      queue: new BatchQueue(rows, concurrency, (index) => this.executeRowAt(state, index)),
      stopped: false,
      settled: { success: 0, failed: 0, skipped: 0 },
      skippedCalls: { approvals: 0, questions: 0 },
      timeoutMinutes,
      inFlightHandles: new Map(),
      parentSettled: false,
    }
    this.active.set(parentRun.id, state)
    state.queue.start()
    return state
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
      const child = routineStore.startBatchChildRun(state.parentRun, rowIndex, state.paramsByIndex.get(rowIndex) ?? {}, null)
      routineStore.finishRun(child.id, { status: 'skipped' })
      state.settled.skipped++
    }
    for (const handle of state.inFlightHandles.values()) handle.stop()
    this.maybeSettleParent(state)
  }

  /** Whether the parent is still in the pool (a stopped/finished parent is
   *  not — and after a restart nothing is until the user resumes it). */
  isActive(parentRunId: string): boolean {
    return this.active.has(parentRunId)
  }

  // ── internals ──

  /** One row, dispatch to settlement. The returned promise resolves when the
   *  row truly settled — that is the pool's slot release, so the concurrency
   *  ceiling is only as real as this promise's honesty. */
  private executeRowAt(state: BatchState, rowIndex: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const { routine } = state
      const provided = state.paramsByIndex.get(rowIndex) ?? {}
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
      // The mint window's stop has no real handle yet — remember it and replay
      // it the moment the handle exists (executeUnattended's own stopRequested
      // guard then settles the row 「用户停止」 before any ask), or the row
      // would run the whole task out after 停止 (review_20260923 M1).
      let mintStopRequested = false
      const entry: { stop: () => void } = { stop: () => { mintStopRequested = true } }
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
          timeoutMs: state.timeoutMinutes * 60_000,
          onSettled: (status, _error, skipped) => {
            state.inFlightHandles.delete(convId)
            state.settled[status]++
            if (skipped) {
              state.skippedCalls.approvals += skipped.approvals
              state.skippedCalls.questions += skipped.questions
            }
            this.maybeSettleParent(state)
            resolve()
          },
        })
        entry.stop = handle.stop
        if (mintStopRequested) handle.stop()
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

  /** The parent settles when every row of THIS run has an outcome — never
   *  later than the last row's settlement, so the overlap guard opens as soon
   *  as it can. The outcome itself is counted from the STORE, folded to each
   *  CSV row's latest attempt: a resume wave's settlement must describe the
   *  whole batch (the rows that succeeded before the interruption included),
   *  not just its own rows. */
  private maybeSettleParent(state: BatchState): void {
    if (state.parentSettled) return
    const { success, failed, skipped } = state.settled
    if (success + failed + skipped < state.indices.length) return
    state.parentSettled = true
    this.active.delete(state.parentRun.id)
    const progress = progressFromAttempts(routineStore.listBatchChildren(state.parentRun.id), state.totalRows)
    const { total } = progress
    let status: RoutineRun['status']
    if (progress.failed === 0 && progress.skipped === 0 && progress.success === total) status = 'success'
    else if (progress.success === 0 && progress.failed === total) status = 'failed'
    else if (progress.success === 0 && progress.failed === 0) status = 'skipped'
    else status = 'partial'
    const summary = `成功 ${progress.success} / 失败 ${progress.failed}` + (progress.skipped > 0 ? ` / 跳过 ${progress.skipped}` : '')
    routineStore.finishRun(state.parentRun.id, { status, error: status === 'success' ? undefined : summary })
    // One notification per BATCH, never per row (a hundred rows would be a
    // hundred toasts); a batch stopped before it ran anything stays silent —
    // the user pressed the stop themselves. The settlement webhook follows
    // the same shape: ONE event for the parent, with the rows' aggregated
    // auto-handled counts (PLAN-routine-triggers M1).
    if (status !== 'skipped') {
      notify(
        status === 'success' ? `批量任务完成：${state.routine.name}` : status === 'failed' ? `批量任务失败：${state.routine.name}` : `批量任务部分完成：${state.routine.name}`,
        status === 'success' ? `全部 ${total} 行执行成功` : summary,
      )
      void postSettlementEvent({
        event: 'routine.settled',
        routineId: state.routine.id,
        runId: state.parentRun.id,
        conversationId: '',
        // The parent's own tri-state passes through — 'partial' must reach the
        // receiver as partial, not as failed (review_20261007 中4); `error`
        // already carries the 成功/失败/跳过 counts line for judgement.
        status,
        error: status === 'success' ? undefined : summary,
        skipped: { ...state.skippedCalls },
        finishedAt: new Date().toISOString(),
      })
    }
  }
}

export const routineBatchRunner = new BatchRunner()
