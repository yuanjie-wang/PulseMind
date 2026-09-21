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
import { normalizeBatchConcurrency } from '../../shared/routine/batch'
import type { Routine, RoutineBatchConfig, RoutineParam } from '../../shared/types/routine'

/** The three approval levels a routine may pin (same ladder as the composer's
 *  授权 button); undefined = the unattended default. */
const APPROVAL_MODES: ReadonlySet<string> = new Set(['auto', 'outside-ask', 'always-ask'])

export function registerRoutineHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST, () => routineStore.list())
  ipcMain.handle(IPC_CHANNELS.ROUTINE_GET, (_event, id: string) => routineStore.get(id))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_CREATE, (_event, input: Partial<Routine>) => {
    assertCron(input)
    assertRunContext(input)
    return routineStore.create(normalizeInput(input))
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
    return routineStore.update(id, normalized)
  })

  // The card grid's delete dialog promises 「运行历史会一并删除」 — the task's
  // runs (and their transcripts) go with the definition, running row included.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_DELETE, (_event, id: string) => {
    routineStore.remove(id)
    routineRunHistory.clearRoutine(id, true)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_TOGGLE, (_event, id: string, enabled: boolean) => {
    const routine = routineStore.update(id, { enabled })
    return routine
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN, (_event, id: string, params?: Record<string, string>) => {
    const routine = routineStore.get(id)
    if (!routine) throw new Error(`routine not found: ${id}`)
    return routineRunner.start(routine, 'manual', params)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS, (_event, routineId?: string, limit?: number) => routineStore.listRuns(routineId, limit))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUN_DELETE, (_event, runId: string) => routineRunHistory.remove(runId))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS_CLEAR, (_event, routineId: string) => routineRunHistory.clearRoutine(routineId))

  // days omitted → the saved 保留策略; a number overrides it for this call.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_RUNS_PRUNE, (_event, days?: number) => routineRunHistory.prune(days))

  // ── Batch mode (PLAN-routine-batch) ──

  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_RUN, (_event, id: string) => {
    const routine = routineStore.get(id)
    if (!routine) throw new Error(`routine not found: ${id}`)
    if (!routine.batch?.csvPath) throw new Error('该任务没有配置批量数据文件')
    // Refusals (another batch active, unreadable file, missing required
    // column, over-limit rows) throw so the click surfaces the reason.
    return routineBatchRunner.start(routine, 'manual')
  })

  // Unknown/already-settled parent: a no-op, the row carries its own outcome.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_STOP, (_event, parentRunId: string) => {
    routineBatchRunner.stop(parentRunId)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_BATCH_ITEMS, (_event, parentRunId: string) => routineStore.listBatchChildren(parentRunId))

  // Mapping preview for the editor / start dialog. The routine may not be
  // saved yet (the draft's params are what the columns map to), so the
  // current param list rides along instead of an id. Parse failures return
  // { ok: false, error } — the UI shows them in place, it does not throw.
  ipcMain.handle(IPC_CHANNELS.ROUTINE_CSV_PREVIEW, (_event, filePath: string, params: RoutineParam[] | undefined) => {
    try {
      return { ok: true as const, preview: previewCsv(filePath, params) }
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

/** The batch config passes through the same door: a garbage concurrency would
 *  widen the run pool at run time, and only the shape (non-empty csvPath,
 *  integer 1–5 concurrency, boolean applyToSchedule) is checked here — the
 *  file itself is validated when it is read (preview / batch start). */
function normalizeBatchConfig(input?: Partial<RoutineBatchConfig>): RoutineBatchConfig | undefined {
  const csvPath = input?.csvPath?.trim()
  if (!csvPath) return undefined
  return {
    csvPath,
    concurrency: normalizeBatchConcurrency(input?.concurrency),
    applyToSchedule: input?.applyToSchedule === true,
  }
}

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
  }
}
