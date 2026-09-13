// ── Routine IPC handlers (PLAN-0.4.0 M4.2) ──

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { routineStore } from '../storage/routine-store'
import { routineRunner } from '../routine/routine-runner'
import { checkCron } from '../../shared/schedule/cron'
import type { Routine } from '../../shared/types/routine'

export function registerRoutineHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ROUTINE_LIST, () => routineStore.list())
  ipcMain.handle(IPC_CHANNELS.ROUTINE_GET, (_event, id: string) => routineStore.get(id))

  ipcMain.handle(IPC_CHANNELS.ROUTINE_CREATE, (_event, input: Partial<Routine>) => {
    assertCron(input)
    return routineStore.create(normalizeInput(input))
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_UPDATE, (_event, id: string, patch: Partial<Routine>) => {
    assertCron(patch)
    const existing = routineStore.get(id)
    const normalized = normalizeInput(patch)
    // A changed cron invalidates the persisted next-fire time — otherwise the
    // scheduler fires against the old phase (possibly immediately on save).
    if (existing && normalized.schedule?.cron && normalized.schedule.cron !== existing.schedule?.cron) {
      normalized.nextRunAt = undefined
    }
    return routineStore.update(id, normalized)
  })

  ipcMain.handle(IPC_CHANNELS.ROUTINE_DELETE, (_event, id: string) => routineStore.remove(id))

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
}

function assertCron(input: Partial<Routine>): void {
  const cron = input.schedule?.cron
  if (cron) {
    const check = checkCron(cron)
    if (!check.valid) throw new Error(`无效的 cron 表达式: ${check.error ?? cron}`)
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
    projectId: input.projectId,
    skills: input.skills,
    sourceConversationId: input.sourceConversationId,
  }
}
