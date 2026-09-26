/** CSV↔param mapping + batch constants (PLAN-routine-batch M1).
 *
 * The mapping contract (L2): headers match param keys exactly (after header
 * trim); unmatched columns are surfaced but ignored; a required param without
 * a column refuses the batch; row cells feed resolveParamValues, so a blank
 * optional cell still falls back to the stored default. Also pins {{row}}:
 * injected by batch runs, absent (token stays visible) in single runs. */

import { describe, expect, it } from 'vitest'
import { analyzeCsvBatch, rowParamsAt, normalizeBatchConcurrency, normalizeBatchTimeoutMinutes, effectiveTimeoutMinutes, MAX_BATCH_CONCURRENCY, DEFAULT_BATCH_CONCURRENCY, BATCH_TIMEOUT_MINUTE_OPTIONS, MAX_BATCH_TIMEOUT_MINUTES, DEFAULT_BATCH_TIMEOUT_MINUTES } from '../src/shared/routine/batch'
import { builtinRoutineVars, renderRoutinePrompt, resolveParamValues, assertRunnableParams as assertRunnableParamsRow } from '../src/shared/routine/params'
import { parseCsv } from '../src/shared/routine/csv'
import type { Routine, RoutineParam } from '../src/shared/types/routine'

const PARAMS: RoutineParam[] = [
  { key: 'repo', label: '仓库', required: true },
  { key: 'branch', label: '分支' },
  { key: 'owner', label: '负责人', default: 'me' },
]

const headers = ['repo', 'branch', 'extra']

function routine(overrides?: Partial<Routine>): Routine {
  return {
    id: 'routine_x', name: 't', description: '', prompt: '检查 {{repo}}@{{branch}} 由 {{owner}} 负责 第{{row}}行',
    params: PARAMS, enabled: true, createdAt: '', updatedAt: '', ...overrides,
  }
}

describe('analyzeCsvBatch', () => {
  it('classifies matched / unmatched / missing-required', () => {
    const a = analyzeCsvBatch(headers, [[], []], PARAMS)
    expect(a.matchedParams).toEqual(['repo', 'branch'])
    expect(a.unmatchedHeaders).toEqual(['extra'])
    expect(a.missingRequiredHeaders).toEqual([])
    expect(a.totalRows).toBe(2)
  })

  it('reports a required param with no column', () => {
    const a = analyzeCsvBatch(['branch'], [[]], PARAMS)
    expect(a.missingRequiredHeaders).toEqual(['repo'])
    expect(a.matchedParams).toEqual(['branch'])
  })

  it('requires an exact key match (no case folding)', () => {
    const a = analyzeCsvBatch(['Repo'], [[]], PARAMS)
    expect(a.matchedParams).toEqual([])
    expect(a.missingRequiredHeaders).toEqual(['repo'])
    expect(a.unmatchedHeaders).toEqual(['Repo'])
  })

  it('duplicate headers resolve to the first occurrence', () => {
    const t = parseCsv('repo,repo\nfirst,second\n')
    expect(rowParamsAt(t.headers, t.rows, PARAMS, 0)).toEqual({ repo: 'first' })
  })
})

describe('rowParamsAt + resolution', () => {
  it('trims cells and provides only mapped keys', () => {
    const values = rowParamsAt(headers, [[' a ', ' b ', ' noise ']], PARAMS, 0)
    expect(values).toEqual({ repo: 'a', branch: 'b' })
    // Blank optional cell falls back to the default; the unmatched column's
    // value never leaks into the prompt.
    const resolved = resolveParamValues(routine(), values)
    expect(resolved.owner).toBe('me')
  })

  it('a short row reads missing cells as empty (blank = default fallback)', () => {
    const values = rowParamsAt(headers, [['only-repo']], PARAMS, 0)
    expect(values).toEqual({ repo: 'only-repo', branch: '' })
    // The empty branch cell resolves through the default chain like any blank.
    expect(resolveParamValues(routine(), values).branch).toBe('')
    expect(() => assertRunnableParamsRow(routine(), values)).not.toThrow()
  })

  it('feeds assertRunnableParams per row (blank required cell = row failure)', async () => {
    const { assertRunnableParams } = await import('../src/shared/routine/params')
    expect(() => assertRunnableParams(routine(), rowParamsAt(headers, [[' ', 'dev']], PARAMS, 0))).toThrow(/repo/)
    expect(() => assertRunnableParams(routine(), rowParamsAt(headers, [['r', 'dev']], PARAMS, 0))).not.toThrow()
  })
})

describe('batch concurrency validation', () => {
  it('absent/blank → undefined (default applies)', () => {
    expect(normalizeBatchConcurrency(undefined)).toBeUndefined()
    expect(normalizeBatchConcurrency(null)).toBeUndefined()
    expect(normalizeBatchConcurrency('')).toBeUndefined()
  })

  it('accepts integers within [1, MAX]', () => {
    expect(normalizeBatchConcurrency(1)).toBe(1)
    expect(normalizeBatchConcurrency(MAX_BATCH_CONCURRENCY)).toBe(MAX_BATCH_CONCURRENCY)
  })

  it('rejects out-of-range / non-integer / non-number values', () => {
    expect(() => normalizeBatchConcurrency(0)).toThrow()
    expect(() => normalizeBatchConcurrency(MAX_BATCH_CONCURRENCY + 1)).toThrow()
    expect(() => normalizeBatchConcurrency(2.5)).toThrow()
    expect(() => normalizeBatchConcurrency('3')).toThrow()
  })

  it('the default stays within the ceiling (both constants pinned)', () => {
    expect(DEFAULT_BATCH_CONCURRENCY).toBe(3)
    expect(MAX_BATCH_CONCURRENCY).toBe(5)
  })
})

describe('batch per-row timeout validation (单次超时)', () => {
  it('absent/blank → undefined (default applies)', () => {
    expect(normalizeBatchTimeoutMinutes(undefined)).toBeUndefined()
    expect(normalizeBatchTimeoutMinutes(null)).toBeUndefined()
    expect(normalizeBatchTimeoutMinutes('')).toBeUndefined()
  })

  it('accepts integers within [1, MAX]', () => {
    expect(normalizeBatchTimeoutMinutes(1)).toBe(1)
    expect(normalizeBatchTimeoutMinutes(MAX_BATCH_TIMEOUT_MINUTES)).toBe(MAX_BATCH_TIMEOUT_MINUTES)
  })

  it('rejects out-of-range / non-integer / non-number values', () => {
    expect(() => normalizeBatchTimeoutMinutes(0)).toThrow()
    expect(() => normalizeBatchTimeoutMinutes(MAX_BATCH_TIMEOUT_MINUTES + 1)).toThrow()
    expect(() => normalizeBatchTimeoutMinutes(2.5)).toThrow()
    expect(() => normalizeBatchTimeoutMinutes('30')).toThrow()
  })

  it('the pick list is exactly what the doors accept, default included', () => {
    // The editor and the start dialog offer this fixed list; every entry must
    // pass normalizeBatchTimeoutMinutes (a UI-only widening would start fine
    // but the runner would refuse at the last step) and the default must be
    // pickable — a default the list omits cannot be re-selected after change.
    for (const m of BATCH_TIMEOUT_MINUTE_OPTIONS) expect(normalizeBatchTimeoutMinutes(m)).toBe(m)
    expect(BATCH_TIMEOUT_MINUTE_OPTIONS).toContain(DEFAULT_BATCH_TIMEOUT_MINUTES)
    // Both constants pinned — changing one is a user-visible ruling.
    expect(DEFAULT_BATCH_TIMEOUT_MINUTES).toBe(15)
    expect(MAX_BATCH_TIMEOUT_MINUTES).toBe(120)
  })
})

describe('effectiveTimeoutMinutes — the one config→ceiling chain', () => {
  // A single run and a batch row must read the SAME value off the routine
  // (user 2026-09-26: 「设置批量参数后，再使用单笔运行，无法享受到超时时间等配置」).
  // routine-runner and batch-runner both call this, so a change to the chain
  // moves both shapes of run together — that is what these pin.
  it('the configured 单次超时 wins for both shapes of run', () => {
    expect(effectiveTimeoutMinutes({ timeoutMinutes: 45 })).toBe(45)
    expect(effectiveTimeoutMinutes({ timeoutMinutes: 1 })).toBe(1)
  })

  it('no config → the shared default (the single-run ceiling unchanged)', () => {
    expect(effectiveTimeoutMinutes(undefined)).toBe(DEFAULT_BATCH_TIMEOUT_MINUTES)
    expect(effectiveTimeoutMinutes({})).toBe(DEFAULT_BATCH_TIMEOUT_MINUTES)
  })

  it('an invalid stored value refuses rather than falling back silently', () => {
    // A hand-edited routine JSON must refuse the start — running under 15
    // minutes when the user wrote 900 is the late-fire bug in another shape.
    expect(() => effectiveTimeoutMinutes({ timeoutMinutes: 0 })).toThrow(/无效的单次超时/)
    expect(() => effectiveTimeoutMinutes({ timeoutMinutes: 900 })).toThrow(/无效的单次超时/)
    expect(() => effectiveTimeoutMinutes({ timeoutMinutes: 2.5 })).toThrow(/无效的单次超时/)
  })
})

describe('{{row}} variable', () => {
  it('substitutes the 1-based row number when a batch provides it', () => {
    const prompt = renderRoutinePrompt(routine(), { repo: 'r', branch: 'b', owner: 'o' }, { workspaceDir: '/w', row: '7' })
    expect(prompt).toContain('由 o 负责 第7行')
    expect(prompt).not.toContain('{{row}}')
  })

  it('stays visible in a single run (no row in context)', () => {
    const prompt = renderRoutinePrompt(routine(), { repo: 'r', branch: 'b', owner: 'o' }, { workspaceDir: '/w' })
    expect(prompt).toContain('第{{row}}行')
  })

  it('builtinRoutineVars only carries row when provided', () => {
    expect('row' in builtinRoutineVars({})).toBe(false)
    expect(builtinRoutineVars({ row: '2' }).row).toBe('2')
  })

  it('a declared param named row wins over the built-in', () => {
    const p: RoutineParam = { key: 'row', label: '行' }
    const prompt = renderRoutinePrompt(routine({ params: [...PARAMS, p] }), { repo: 'r', branch: 'b', owner: 'o', row: 'DECLARED' }, { row: '7' })
    expect(prompt).toContain('第DECLARED行')
  })
})
