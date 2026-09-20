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
export function renderRoutinePrompt(routine: Routine, provided?: Record<string, string>): string {
  let prompt = routine.prompt
  for (const p of routine.params ?? []) {
    prompt = prompt.replaceAll(`{{${p.key}}}`, resolveParamValue(p, provided))
  }
  return prompt
}
