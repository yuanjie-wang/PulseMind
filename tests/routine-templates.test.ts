import { describe, it, expect } from 'vitest'
import {
  ROUTINE_TEMPLATES,
  draftFromTemplate,
  routineScheduleLabel,
  routineTemplateById,
} from '../src/renderer/src/components/routine/routine-templates'
import { draftToRoutineInput, validateDraft } from '../src/renderer/src/components/routine/routine-form-model'
import { checkCron, nextRun } from '../src/shared/schedule/cron'

// The 推荐模板 half of the routines landing page is pure data plus one pure
// function, so the whole contract is testable here — and it needs to be, because
// what a template gets wrong only shows up in a form nobody has saved yet:
//
//   - a cron the scheduler cannot parse would make a template that never fires
//   - a `{{param}}` with no param behind it reaches the model verbatim, and a
//     param the prompt never uses is dead UI
//   - a draft that fails validateDraft is a starter the user cannot save
//   - a missing locale field silently falls back to Chinese copy for an EN user
//   - the schedule label is DERIVED from the cron (one source of truth), so its
//     output is asserted rather than trusted — an unknown shape must show the
//     expression instead of a guess

const LOCALES = ['zh', 'en'] as const

/** The next `count` fire instants of a cron from a fixed reference point. Two
 *  expressions with the same fire times schedule the same thing — which is what
 *  "the card and the saved routine agree" means, and the only comparison that
 *  survives the friendly-fields round trip: the editor stores 工作日 as
 *  `1,2,3,4,5` where the template writes `1-5`. */
function fireTimes(cron: string, count = 6): number[] {
  const out: number[] = []
  let cursor = Date.parse('2026-09-21T00:00:00')
  for (let i = 0; i < count; i++) {
    const next = nextRun(cron, cursor)
    if (next == null) return out
    out.push(next)
    cursor = next
  }
  return out
}

describe('routine templates', () => {
  it('offers exactly five starters under unique ids', () => {
    expect(ROUTINE_TEMPLATES).toHaveLength(5)
    const ids = ROUTINE_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toEqual(['daily-report', 'weekly-report', 'meeting-notes', 'today-priorities', 'monthly-review'])
  })

  it('schedules every template with a cron the scheduler can parse', () => {
    const scheduled = ROUTINE_TEMPLATES.filter((t) => t.cron)
    // A manual template is a legitimate shape (会议纪要整理 needs the user's own
    // notes), but the set must not silently become all-manual.
    expect(scheduled.length).toBe(4)
    for (const t of scheduled) {
      expect(checkCron(t.cron!).valid, `${t.id}: ${t.cron}`).toBe(true)
    }
  })

  it('carries name, description and a prompt in both locales', () => {
    for (const t of ROUTINE_TEMPLATES) {
      for (const locale of LOCALES) {
        expect(t.name[locale]?.trim(), `${t.id}.name.${locale}`).toBeTruthy()
        expect(t.description[locale]?.trim(), `${t.id}.description.${locale}`).toBeTruthy()
        // A template's prompt IS the routine's body — a one-liner would ship a
        // task that does not say what to do.
        expect(t.prompt[locale]?.trim().length ?? 0, `${t.id}.prompt.${locale}`).toBeGreaterThan(80)
      }
      expect(t.name.zh, `${t.id} name must be localized`).not.toBe(t.name.en)
      expect(t.prompt.zh, `${t.id} prompt must be localized`).not.toBe(t.prompt.en)
    }
  })

  it('keeps params and {{placeholders}} in step', () => {
    for (const t of ROUTINE_TEMPLATES) {
      const keys = (t.params ?? []).map((p) => p.key)
      for (const locale of LOCALES) {
        const placeholders = [...t.prompt[locale].matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
        for (const placeholder of placeholders) {
          expect(keys, `${t.id}: {{${placeholder}}} has no param`).toContain(placeholder)
        }
        for (const key of keys) {
          expect(placeholders, `${t.id}: param "${key}" is never used`).toContain(key)
        }
      }
    }
  })

  it('turns a template into a savable create-new draft', () => {
    for (const t of ROUTINE_TEMPLATES) {
      for (const locale of LOCALES) {
        const draft = draftFromTemplate(t, locale)
        expect(draft.id, `${t.id} must not claim an existing routine`).toBeUndefined()
        expect(draft.sourceConversationId).toBeUndefined()
        expect(draft.enabled).toBe(true)
        expect(validateDraft(draft), `${t.id}.${locale} must be saveable as-is`).toBeNull()
        expect(draft.name).toBe(t.name[locale])
        expect(draft.description).toBe(t.description[locale])
        expect(draft.prompt).toBe(t.prompt[locale])
        expect(draft.scheduleEnabled).toBe(!!t.cron)
        // Saving the draft must produce the schedule the card advertised. The
        // editor goes through its friendly schedule fields on the way out, so
        // the comparison is by fire time, not by string.
        const input = draftToRoutineInput(draft)
        expect(input.schedule?.cron ? fireTimes(input.schedule.cron) : []).toEqual(t.cron ? fireTimes(t.cron) : [])
        if (t.cron) expect(fireTimes(t.cron)).toHaveLength(6)
        expect(input.params).toHaveLength(t.params?.length ?? 0)
        expect(input.params?.map((p) => p.key)).toEqual((t.params ?? []).map((p) => p.key))
        // Param labels are localized at application time (the draft itself has
        // no locale), so an EN template must not carry Chinese labels.
        for (const p of input.params ?? []) {
          expect(p.label.trim()).toBeTruthy()
          if (t.params?.length) {
            const source = t.params.find((tp) => tp.key === p.key)!
            expect(p.label).toBe(source.label[locale])
          }
        }
      }
    }
  })

  it('resolves ids it knows and refuses the ones it does not', () => {
    expect(routineTemplateById('daily-report')?.id).toBe('daily-report')
    // A stale view param (or the plain 新建任务 path, which carries no id at all)
    // must land on the empty create-new form instead of throwing.
    expect(routineTemplateById('nope')).toBeNull()
    expect(routineTemplateById(undefined)).toBeNull()
  })
})

describe('routineScheduleLabel', () => {
  it('reads the shapes templates actually use', () => {
    expect(routineScheduleLabel('0 18 * * *', 'zh')).toBe('每天 18:00')
    expect(routineScheduleLabel('0 18 * * *', 'en')).toBe('Daily 18:00')
    expect(routineScheduleLabel('30 17 * * 5', 'zh')).toBe('每周五 17:30')
    expect(routineScheduleLabel('30 17 * * 5', 'en')).toBe('Weekly · Fri 17:30')
    expect(routineScheduleLabel('45 8 * * 1-5', 'zh')).toBe('工作日 08:45')
    expect(routineScheduleLabel('45 8 * * 1-5', 'en')).toBe('Weekdays 08:45')
    expect(routineScheduleLabel('0 17 1 * *', 'zh')).toBe('每月 1 日 17:00')
    expect(routineScheduleLabel('0 17 1 * *', 'en')).toBe('Monthly · day 1 17:00')
  })

  it('pads a single-digit time and keeps Sunday as 日/Sun', () => {
    expect(routineScheduleLabel('5 9 * * *', 'zh')).toBe('每天 09:05')
    expect(routineScheduleLabel('0 9 * * 0', 'zh')).toBe('每周日 09:00')
    expect(routineScheduleLabel('0 9 * * 0', 'en')).toBe('Weekly · Sun 09:00')
  })

  it('shows the expression for shapes it does not know rather than guessing', () => {
    for (const cron of ['*/30 * * * *', '0 9-18 * * 1-5', '0 9 1,15 * *', 'not a cron']) {
      expect(routineScheduleLabel(cron, 'zh')).toBe(cron)
    }
  })

  it('labels every template’s cron with something other than the raw expression', () => {
    for (const t of ROUTINE_TEMPLATES.filter((x) => x.cron)) {
      expect(routineScheduleLabel(t.cron!, 'zh'), t.id).not.toBe(t.cron)
      expect(routineScheduleLabel(t.cron!, 'en'), t.id).not.toBe(t.cron)
    }
  })
})
