// ── Routine parameter resolution tests ──
// The contract that makes params real (参数不再只是摆设):
//   1. A provided value wins; an empty/missing one falls back to the default —
//      a blank {{repo}} inside a prompt is a broken instruction, never a value.
//   2. A required param whose resolved value is still blank refuses to run.
//   3. Every run path passes one gate (the runner), and every manual entry
//      point passes one dialog (useRoutineRunNow) — no caller bypasses either.
// (1) and (2) are pure logic driven directly; (3) is source-scanned because
// vitest here is node-env (no Electron, no React mount) — the same recipe as
// tests/form-assist-approval.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveParamValue, resolveParamValues, missingRequiredParamKeys, assertRunnableParams, renderRoutinePrompt, builtinRoutineVars } from '../src/shared/routine/params'
import type { Routine, RoutineParam } from '../src/shared/types/routine'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

function routineWith(params: RoutineParam[], prompt = '检查 {{repo}} 的 {{branch}} 分支，抄送 {{mail}}'): Routine {
  return {
    id: 'r_test',
    name: '巡检',
    description: '',
    prompt,
    params,
    enabled: true,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
}

describe('resolveParamValue', () => {
  const p: RoutineParam = { key: 'repo', label: '仓库', default: 'vue' }

  it('prefers a provided value', () => {
    expect(resolveParamValue(p, { repo: 'react' })).toBe('react')
  })

  it('falls back to the default when the provided value is blank', () => {
    // The old ?? chain treated '' as a value — a cleared field in the run
    // dialog produced 「检查  仓库」 instead of the default. Blank = "not given".
    expect(resolveParamValue(p, { repo: '' })).toBe('vue')
    expect(resolveParamValue(p, { repo: '   ' })).toBe('vue')
  })

  it('falls back to the default when the key is absent', () => {
    expect(resolveParamValue(p)).toBe('vue')
    expect(resolveParamValue(p, {})).toBe('vue')
  })

  it('resolves to empty string only when nothing was ever stored', () => {
    expect(resolveParamValue({ key: 'q', label: 'Q' })).toBe('')
  })
})

describe('resolveParamValues', () => {
  it('resolves exactly the declared params and ignores stale provided keys', () => {
    const r = routineWith([
      { key: 'repo', label: '仓库', default: 'vue' },
      { key: 'mail', label: '邮箱' },
    ])
    const values = resolveParamValues(r, { repo: '', mail: 'a@b.c', removed: 'x' })
    expect(values).toEqual({ repo: 'vue', mail: 'a@b.c' })
  })
})

describe('missingRequiredParamKeys', () => {
  it('lists required params whose resolved value is blank', () => {
    const r = routineWith([
      { key: 'repo', label: '仓库', required: true },
      { key: 'mail', label: '邮箱', required: true, default: 'a@b.c' },
      { key: 'branch', label: '分支' },
    ])
    expect(missingRequiredParamKeys(r, { repo: '' })).toEqual(['repo'])
    expect(missingRequiredParamKeys(r, {})).toEqual(['repo'])
    expect(missingRequiredParamKeys(r, { repo: 'vue' })).toEqual([])
  })

  it('never lists optional params', () => {
    const r = routineWith([{ key: 'branch', label: '分支' }])
    expect(missingRequiredParamKeys(r, {})).toEqual([])
  })
})

describe('assertRunnableParams', () => {
  it('throws naming every missing required param', () => {
    const r = routineWith([
      { key: 'repo', label: '仓库', required: true },
      { key: 'mail', label: '邮箱', required: true },
    ])
    expect(() => assertRunnableParams(r, {})).toThrow(/repo、mail/)
  })

  it('passes when required params carry values', () => {
    const r = routineWith([{ key: 'repo', label: '仓库', required: true, default: 'vue' }])
    expect(() => assertRunnableParams(r, {})).not.toThrow()
    expect(() => assertRunnableParams(r, { repo: 'react' })).not.toThrow()
  })
})

describe('renderRoutinePrompt', () => {
  it('substitutes defaults and lets provided values win', () => {
    const r = routineWith([
      { key: 'repo', label: '仓库', default: 'vue' },
      { key: 'branch', label: '分支', default: 'main' },
      { key: 'mail', label: '邮箱' },
    ])
    expect(renderRoutinePrompt(r, { repo: 'react', mail: 'a@b.c' })).toBe('检查 react 的 main 分支，抄送 a@b.c')
  })

  it('leaves undeclared placeholders visible instead of blanking them', () => {
    const r = routineWith([{ key: 'repo', label: '仓库', default: 'vue' }], '检查 {{repo}} 和 {{typo}}')
    expect(renderRoutinePrompt(r)).toBe('检查 vue 和 {{typo}}')
  })
})

// ── Built-in prompt variables (user 2026-09-21) ──
// The runner always renders through renderRoutinePrompt, so the built-ins ride
// the same function; a fixed `now` makes the clock assertions deterministic.

const FIXED_NOW = new Date(2026, 8, 21, 9, 5) // 2026-09-21 09:05 local — a Monday

describe('builtinRoutineVars', () => {
  it('formats the clock in fixed local-time shapes', () => {
    const vars = builtinRoutineVars({ now: FIXED_NOW })
    expect(vars.date).toBe('2026-09-21')
    expect(vars.time).toBe('09:05')
    expect(vars.datetime).toBe('2026-09-21 09:05')
    expect(vars.weekday).toBe('周一')
  })

  it('pads single-digit months, days, hours and minutes', () => {
    const vars = builtinRoutineVars({ now: new Date(2026, 0, 3, 7, 2) })
    expect(vars.date).toBe('2026-01-03')
    expect(vars.time).toBe('07:02')
    expect(vars.datetime).toBe('2026-01-03 07:02')
    expect(vars.weekday).toBe('周六')
  })

  it('maps every weekday onto 周日..周六 by getDay()', () => {
    for (let day = 0; day < 7; day++) {
      const vars = builtinRoutineVars({ now: new Date(2026, 8, 20 + day, 12, 0) })
      expect(vars.weekday).toBe(`周${'日一二三四五六'[day]}`)
    }
  })

  it('leaves the workspace empty unless the run context carries one', () => {
    expect(builtinRoutineVars({ now: FIXED_NOW }).workspace).toBe('')
    expect(builtinRoutineVars({ now: FIXED_NOW, workspaceDir: '/tmp/w' }).workspace).toBe('/tmp/w')
  })
})

describe('renderRoutinePrompt: built-in variables', () => {
  it('substitutes the built-ins with no declared params at all', () => {
    const r = routineWith([], '今天是 {{date}} {{weekday}}，工作区 {{workspace}}')
    expect(renderRoutinePrompt(r, undefined, { now: FIXED_NOW, workspaceDir: '/tmp/w' }))
      .toBe('今天是 2026-09-21 周一，工作区 /tmp/w')
  })

  it('gives a declared param precedence over the same-named built-in', () => {
    // Params run first: by the time the built-in pass runs, the token is gone.
    const r = routineWith([{ key: 'date', label: '日期', default: '2026-01-01' }], '{{date}}')
    expect(renderRoutinePrompt(r, undefined, { now: FIXED_NOW })).toBe('2026-01-01')
  })

  it('blanks {{workspace}} when no context was handed in (still resolved)', () => {
    const r = routineWith([], '工作区={{workspace}}')
    expect(renderRoutinePrompt(r)).toBe('工作区=')
  })

  it('keeps the third parameter optional — old two-arg calls still render params', () => {
    const r = routineWith([{ key: 'repo', label: '仓库', default: 'vue' }], '检查 {{repo}} 于 {{date}}')
    // {{date}} without ctx resolves to today's real clock — assert the shape
    // instead of a fixed day.
    expect(renderRoutinePrompt(r)).toMatch(/^检查 vue 于 \d{4}-\d{2}-\d{2}$/)
  })
})

// ── Wiring (source scans — the shape the wiring tests can see) ──

describe('wiring: the runner is the one gate', () => {
  const RUNNER = read('src', 'main', 'routine', 'routine-runner.ts')

  it('runs assertRunnableParams before creating the run row', () => {
    const start = RUNNER.indexOf('start(routine: Routine, trigger:')
    const gate = RUNNER.indexOf('assertRunnableParams(routine, params)', start)
    const create = RUNNER.indexOf('routineStore.startRun(routine.id, trigger, convId)', start)
    expect(gate).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(gate)
  })

  it('records a failed run for a scheduled fire, throws for a manual click', () => {
    // Anchor on the CALL site — the import line also names the symbol and sits
    // before persistTranscript's own catch.
    const gate = RUNNER.indexOf('assertRunnableParams(routine, params)')
    const catchAt = RUNNER.indexOf('catch (err) {', gate)
    const body = RUNNER.slice(catchAt, RUNNER.indexOf('}\n', catchAt))
    expect(body).toContain("if (trigger === 'manual') throw err")
    expect(body).toContain("finishRun(run.id, { status: 'failed', error: message })")
  })

  it('renders the prompt through the shared resolver, not a local copy', () => {
    expect(RUNNER).toContain("from '../../shared/routine/params'")
    expect(RUNNER).not.toContain('function renderRoutinePrompt')
  })
})

describe('wiring: the dialog is the one manual entry', () => {
  const MODAL = 'src/renderer/src/components/routine/RoutineRunModal.tsx'

  it('routes every renderer routineRun call through the shared hook file', () => {
    // The old shape had two callers hand-building params — one of them shipped
    // the defaults back verbatim. The hook is the choke point now.
    const callers = ['src/renderer/src/components/routine/RoutineCenter.tsx', 'src/renderer/src/components/welcome/WelcomeSuggestions.tsx']
    for (const f of callers) {
      expect(read(f)).toContain('useRoutineRunNow(')
      expect(read(f)).not.toContain('electronAPI.routineRun(')
    }
    expect(read(MODAL)).toContain('useRoutineRunNow')
  })

  it('decides dialog-vs-direct from the declared params only', () => {
    expect(read(MODAL)).toContain('routine.params?.length ?? 0')
  })

  it('blocks 运行 while a required param is blank', () => {
    const src = read(MODAL)
    expect(src).toContain('missingRequiredParamKeys(routine, values)')
    expect(src).toContain('disabled: missing.length > 0')
  })
})

describe('wiring: the authoring form completes the loop', () => {
  it('exposes 必填 on the param row', () => {
    const FORM = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineForm.tsx')
    expect(FORM).toContain('required: e.target.checked')
  })
})
