// ── Routine form model ──
// Pure logic behind the routine editor's form: the draft state shape, drafts
// to/from stored routines, save validation and the IPC payload assembly, plus
// merging an assistant proposal into the draft. No React — importable from
// tests. The view lives in RoutineForm.tsx.

import { checkCron } from '../../../../shared/schedule/cron'
import { configToCron, parseCronToConfig } from '../../utils/schedule-builder'
import type { ScheduleConfig } from '../../utils/schedule-builder'
import type { RoutineAssistantDraft } from './routine-assist'
import type { Routine } from '../../../../shared/types/routine'

export interface RoutineDraftState {
  id?: string
  name: string
  description: string
  prompt: string
  scheduleEnabled: boolean
  sched: ScheduleConfig
  catchUp: 'once' | 'skip'
  enabled: boolean
  sourceConversationId?: string
  params: Array<{ key: string; label: string; required?: boolean; default?: string }>
}

const DEFAULT_TIME = '09:00'

export const SCHED_DEFAULTS: Record<'daily' | 'weekly' | 'monthly' | 'interval', ScheduleConfig> = {
  daily: { kind: 'daily', time: DEFAULT_TIME },
  weekly: { kind: 'weekly', weekdays: [1], time: DEFAULT_TIME },
  monthly: { kind: 'monthly', day: 1, time: DEFAULT_TIME },
  interval: { kind: 'interval', unit: 'hour', every: 1 },
}

export const EMPTY_DRAFT: RoutineDraftState = {
  name: '', description: '', prompt: '', scheduleEnabled: false,
  sched: SCHED_DEFAULTS.daily, catchUp: 'once', enabled: true, params: [],
}

/** Draft schedule fields for a stored cron; unparseable expressions land in
 *  the custom editor so they survive a round-trip. */
export function draftScheduleFromCron(cron: string): Pick<RoutineDraftState, 'scheduleEnabled' | 'sched'> {
  return cron ? { scheduleEnabled: true, sched: parseCronToConfig(cron) } : { scheduleEnabled: false, sched: SCHED_DEFAULTS.daily }
}

/** Prefill the editor draft from a stored routine. */
export function routineToDraft(routine: Routine): RoutineDraftState {
  return {
    id: routine.id,
    name: routine.name,
    description: routine.description,
    prompt: routine.prompt,
    ...draftScheduleFromCron(routine.schedule?.cron ?? ''),
    catchUp: routine.schedule?.catchUp ?? 'once',
    enabled: routine.enabled,
    sourceConversationId: routine.sourceConversationId,
    params: routine.params ?? [],
  }
}

/** First validation error, or null when the draft is saveable. */
export function validateDraft(draft: RoutineDraftState): string | null {
  if (!draft.scheduleEnabled) return null
  if (draft.sched.kind === 'custom' && !checkCron(draft.sched.cron).valid) return 'cron 表达式无效'
  if (draft.sched.kind === 'weekly' && draft.sched.weekdays.length === 0) return '请至少选择一个星期'
  return null
}

/** Assemble the payload for routineCreate / routineUpdate. */
export function draftToRoutineInput(draft: RoutineDraftState): Partial<Routine> {
  const cron = draft.scheduleEnabled ? configToCron(draft.sched) : ''
  return {
    name: draft.name.trim() || '未命名任务',
    description: draft.description,
    prompt: draft.prompt,
    enabled: draft.enabled,
    sourceConversationId: draft.sourceConversationId,
    params: draft.params.filter((p) => p.key.trim()),
    schedule: cron ? { cron, catchUp: draft.catchUp } : undefined,
  }
}

/** Merge an assistant proposal into the current draft. Only fields the
 *  proposal actually carries are overwritten (an empty proposal never blanks
 *  the form); the cron switches the schedule editor through the same
 *  friendly-fields path as a stored routine. */
export function applyAssistantDraft(proposed: RoutineAssistantDraft, current: RoutineDraftState): RoutineDraftState {
  const next: RoutineDraftState = {
    ...current,
    name: proposed.name?.trim() || current.name,
    description: proposed.description ?? current.description,
    prompt: proposed.prompt?.trim() || current.prompt,
  }
  if (proposed.cron?.trim()) Object.assign(next, draftScheduleFromCron(proposed.cron.trim()))
  if (proposed.params && proposed.params.length > 0) {
    next.params = proposed.params.map((p) => ({
      key: p.key,
      label: p.label || p.key,
      ...(p.required != null ? { required: p.required } : {}),
      ...(p.default != null ? { default: p.default } : {}),
    }))
  }
  return next
}
