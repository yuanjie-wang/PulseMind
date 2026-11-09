// ── Routine IPC handlers (PLAN-0.4.0 M4.2; batch per PLAN-routine-batch M4) ──

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { routineStore } from '../storage/routine-store'
import { routineRunner } from '../routine/routine-runner'
import { routineBatchRunner } from '../routine/batch-runner'
import { previewCsv } from '../routine/batch-source'
import { routineRunHistory } from '../routine/routine-run-history'
import { checkCron } from '../../shared/schedule/cron'
import { checkWorkspacePathFormat } from '../../shared/workspace-path'
import { normalizeBatchConfig } from '../storage/task-config-normalize'
import { taskTriggerManager } from '../task/task-triggers'
import type { Routine, RoutineParam } from '../../shared/types/routine'

/** The three approval levels a routine may pin (same ladder as the composer's
 *  授权 button); undefined = the unattended default. */
const APPROVAL_MODES: ReadonlySet<string> = new Set(['auto', 'outside-ask', 'always-ask'])

export function registerRoutineHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST, () => routineStore.list())
  ipcMain.handle(IPC_CHANNELS.ROUTINE_GET, (_event, id: string) => routineStore.get(id))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_CREATE, (_event, input: Partial<Routine>) => {
    assertCron(input)
    assertRunContext(input)
    const created = routineStore.create(normalizeInput(input))
    taskTriggerManager.sync()
    return created
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_UPDATE, (_event, id: string, patch: Partial<Routine>) => {
    assertCron(patch)
    assertRunContext(patch)
    const existing = routineStore.get(id)
    const normalized = normalizeInput(patch)
    // A changed cron invalidates the persisted next-fire time — otherwise the
    // scheduler fires against the old phase (possibly immediately on save).
    if (existing && normalized.schedule?.cron && normalized.schedule.cron !== existing.schedule?.cron) {
      normalized.nextRunAt = undefined
    }
    const updated = routineStore.update(id, normalized)
    // Triggers may have changed shape (paths / token / enabled) — reconcile.
    taskTriggerManager.sync()
    return updated
  })

  // The card grid's delete dialog promises 「运行历史会一并删除」 — the task's
  // runs (and their transcripts) go with the definition, running row included.
  // clearRoutine is now async (workspace-converged deletes) and internally
  // best-effort per run; the trigger sync must not wait on folder IO — but
  // fire-and-forget no longer means silent: a cleanup failure is logged where
  // main.log can see it instead of dying as an unhandled rejection with zero
  // user-side signal. Leftover run rows retry on the next retention pass.
  // (review_20261013 低2)
  ipcMain.handle(IPC_CHANNELS.ROUTINE_DELETE, (_event, id: string) => {
    routineStore.remove(id)
    void routineRunHistory.clearRoutine(id, true).catch((err) => {
      console.warn('[Routine] run-history cleanup failed (rows may remain until next retention):', err)
    })
    taskTriggerManager.sync()
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_TOGGLE, (_event, id: string, enabled: boolean) => {
    const routine = routineStore.update(id, { enabled })
    taskTriggerManager.sync()
    return routine
  })

  // PLAN-routine-triggers M1: the resolved loopback port (0 = dormant) so the
  // editor can show the full fire URL for a webhook trigger.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_TRIGGERS_INFO, () => ({ port: taskTriggerManager.port }))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN, (_event, id: string, params?: Record<string, string>) => {
    const routine = routineStore.get(id)
    if (!routine) throw new Error(`routine not found: ${id}`)
    return routineRunner.start(routine, 'manual', params)
  })

  // 停止一次进行中的单笔运行 — the runner holds its engine handle, so a
  // settled/stale/batch row refuses (「该运行已不在进行中」) instead of
  // silently no-opping; a batch's 停止批量 is ROUTINE_BATCH_STOP.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_STOP, (_event, runId: string) => {
    routineRunner.stop(runId)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS, (_event, routineId?: string, limit?: number) => routineStore.listRuns(routineId, limit))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_DELETE, (_event, runId: string) => routineRunHistory.remove(runId))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS_CLEAR, (_event, routineId: string) => routineRunHistory.clearRoutine(routineId))

  // days omitted → the saved 保留策略; a number overrides it for this call.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS_PRUNE, (_event, days?: number) => routineRunHistory.prune(days))

  // ── Batch mode (PLAN-routine-batch) ──

  // concurrency (optional) is the start dialog's PER-RUN override (L2: the
  // routine's saved value is only the default); start() normalizes it, so a
  // hand-crafted payload rejects instead of widening the pool. timeoutMinutes
  // rides the same shape — each row's 单次超时 for THIS run only.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_RUN, (_event, id: string, concurrency?: number, timeoutMinutes?: number) => {
    const routine = routineStore.get(id)
    if (!routine) throw new Error(`routine not found: ${id}`)
    if (!routine.batch?.csvPath) throw new Error('该任务没有配置批量数据文件')
    // Refusals (another batch active, unreadable file, missing required
    // column, over-limit rows) reject so the click surfaces the reason.
    return routineBatchRunner.start(routine, 'manual', { concurrency, timeoutMinutes })
  })

  // Unknown/already-settled parent: a no-op, the row carries its own outcome.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_STOP, (_event, parentRunId: string) => {
    routineBatchRunner.stop(parentRunId)
  })

  // Continue an interrupted batch (user stop or app exit) under the SAME
  // parent: only the unfinished rows re-run. Refusals (no such batch, still
  // running, another batch of the task active, routine deleted, nothing left
  // to run, CSV reshaped) throw so the click surfaces the reason.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_RESUME, (_event, parentRunId: string) => {
    return routineBatchRunner.resume(parentRunId)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_ITEMS, (_event, parentRunId: string) => routineStore.listBatchChildren(parentRunId))

  // Mapping preview for the editor / start dialog. The routine may not be
  // saved yet (the draft's params are what the columns map to), so the
  // current param list rides along instead of an id. Parse failures return
  // { ok: false, error } — the UI shows them in place, it does not throw.
  // Async: the read covers .xlsx through exceljs, which has no sync load.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_CSV_PREVIEW, async (_event, filePath: string, params: RoutineParam[] | undefined) => {
    try {
      return { ok: true as const, preview: await previewCsv(filePath, params) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function assertCron(input: Partial<Routine>): void {
  const cron = input.schedule?.cron
  if (cron) {
    const check = checkCron(cron)
    if (!check.valid) throw new Error(`无效的 cron 表达式: ${check.error ?? cron}`)
  }
}

/** The run context fields are validated here, at the one door every save
 *  passes: a garbage approval mode would silently widen (or break) the
 *  unattended gates at run time, and a malformed workspace path would only
 *  surface as odd tool failures mid-run. profileId is deliberately NOT
 *  existence-checked — a profile can be deleted after the save, and a stale id
 *  must not block editing the routine; the runner falls back to the active
 *  profile at run time. */
function assertRunContext(input: Partial<Routine>): void {
  if (input.approvalMode && !APPROVAL_MODES.has(input.approvalMode)) {
    throw new Error(`无效的授权方式: ${input.approvalMode}`)
  }
  const dir = input.workspaceDir?.trim()
  if (dir) {
    const error = checkWorkspacePathFormat(dir)
    if (error) throw new Error(`无效的工作区目录: ${error}`)
  }
}

/** The batch config passes through the same door (task-config-normalize, shared
 *  with the workflow save path): only the shape is checked here — the file
 *  itself is validated when it is read (preview / batch start). */

/** Fill server-side fields; enabled defaults true. */
function normalizeInput(input: Partial<Routine>): Omit<Routine, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: input.name ?? '未命名任务',
    description: input.description ?? '',
    prompt: input.prompt ?? '',
    params: input.params,
    icon: input.icon,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    skills: input.skills,
    workspaceDir: input.workspaceDir?.trim() || undefined,
    approvalMode: input.approvalMode,
    profileId: input.profileId?.trim() || undefined,
    sourceConversationId: input.sourceConversationId,
    batch: normalizeBatchConfig(input.batch),
    triggers: input.triggers,
  }
}
