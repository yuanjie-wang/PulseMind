// ── Routine parameter resolution (PLAN-0.4.0 M4) ──
// Pure logic shared by the main-process runner and the renderer's run-now
// modal. The contract that makes params real: a provided value wins, and an
// empty/missing one falls back to the stored default — a blank {{repo}} inside
// a prompt is a broken instruction, never a legitimate value. Required params
// whose resolved value is still blank refuse to run.

import type { Routine, RoutineParam } from '../types/routine'

/** The effective value of one param for a run: non-empty provided wins;
 *  empty/missing falls back to the default; no default → empty string. */
export function resolveParamValue(p: RoutineParam, provided?: Record<string, string>): string {
  const given = provided?.[p.key]
  return given != null && given.trim() !== '' ? given : (p.default ?? '')
}

/** Resolved values for every declared param. Provided keys the routine no
 *  longer declares are ignored — replaceAll could never match them anyway. */
export function resolveParamValues(routine: Routine, provided?: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const p of routine.params ?? []) values[p.key] = resolveParamValue(p, provided)
  return values
}

/** Required params whose resolved value is still blank — these must not run. */
export function missingRequiredParamKeys(routine: Routine, provided?: Record<string, string>): string[] {
  return (routine.params ?? []).filter((p) => p.required && resolveParamValue(p, provided).trim() === '').map((p) => p.key)
}

/** The one gate every run path passes. Throws naming the missing params, so a
 *  manual run surfaces the reason at the click and a scheduled fire can record
 *  it as the run's error. */
export function assertRunnableParams(routine: Routine, provided?: Record<string, string>): void {
  const missing = missingRequiredParamKeys(routine, provided)
  if (missing.length > 0) {
    throw new Error(`缺少必填参数的值：${missing.join('、')}`)
  }
}

/** Substitute {{key}} placeholders with the resolved values. Undeclared
 *  placeholders stay as written — a typo should stay visible, not vanish. */
export function renderRoutinePrompt(
  routine: Routine,
  provided?: Record<string, string>,
  ctx?: RoutinePromptContext,
): string {
  let prompt = routine.prompt
  for (const p of routine.params ?? []) {
    prompt = prompt.replaceAll(`{{${p.key}}}`, resolveParamValue(p, provided))
  }
  // Built-ins run AFTER the declared params, so a param named `date` wins over
  // the built-in of the same name (its token is already gone by this pass).
  for (const [key, value] of Object.entries(builtinRoutineVars(ctx))) {
    prompt = prompt.replaceAll(`{{${key}}}`, value)
  }
  return prompt
}

/** Run-scoped values a caller may hand the renderer: the workspace actually
 *  resolved for this run, and a fixed clock for tests. `row` is the batch
 *  mode's 1-based data row number — absent (single runs) the `{{row}}` token
 *  stays visible, per the same rule that keeps a typo'd placeholder visible. */
export interface RoutinePromptContext {
  now?: Date
  workspaceDir?: string
  row?: string
}

/** Built-in variables every run can use without declaring anything. Fixed
 *  formats, local time (the same clock the cron schedule runs on); the weekday
 *  is a fixed Chinese name — it lands in an LLM prompt, not in the UI, so it
 *  does not follow the locale. */
export function builtinRoutineVars(ctx?: RoutinePromptContext): Record<string, string> {
  const now = ctx?.now ?? new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const vars: Record<string, string> = {
    date,
    time: `${hh}:${mm}`,
    datetime: `${date} ${hh}:${mm}`,
    weekday: `周${'日一二三四五六'[now.getDay()]}`,
    workspace: ctx?.workspaceDir ?? '',
  }
  // Batch-only: not in the fixed object above, so a single run never
  // substitutes {{row}} with anything (the token stays visible instead).
  if (ctx?.row != null) vars.row = ctx.row
  return vars
}
