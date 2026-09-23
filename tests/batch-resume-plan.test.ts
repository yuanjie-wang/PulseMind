/** Resume planning (PLAN-batch-resume): the three pure folds over a batch's
 *  children. A resumed batch appends ATTEMPTS under the same parent, so every
 *  read must collapse children to each row's LATEST attempt first — counting
 *  raw rows is the bug class these pin (a failed-then-succeeded row would read
 *  as both, and a wave's settlement would describe only its own rows).
 *
 *  Non-vacuity: each fold test is written against the naive raw-count
 *  implementation — revert latestAttemptsByIndex to identity and the wave test
 *  fails on failed===1/success-impossible, the snapshot test on a success row
 *  still occupying an index, the progress test on a stale attempt surviving. */

import { describe, expect, it } from 'vitest'
import { latestAttemptsByIndex, planResumeRows, progressFromAttempts } from '../src/shared/routine/batch'
import type { RoutineRun } from '../src/shared/types/routine'

let seq = 0
/** Minimal child row: only the fields the folds read. */
function child(rowIndex: number | undefined, status: RoutineRun['status'], extra: Partial<RoutineRun> = {}): RoutineRun {
  seq += 1
  return {
    id: `run_${seq}`,
    routineId: 'routine_1',
    status,
    trigger: 'manual',
    startedAt: new Date(Date.UTC(2026, 8, 23, 0, 0, seq)).toISOString(),
    rowIndex,
    ...extra,
  }
}

describe('latestAttemptsByIndex', () => {
  it('collapses repeated attempts to the LAST one (input is started_at asc)', () => {
    const children = [
      child(0, 'failed'),
      child(1, 'failed'),
      child(0, 'success', { attempts: 2 }), // the resume wave's retry of row 0
    ]
    const latest = latestAttemptsByIndex(children)
    expect(latest.size).toBe(2)
    expect(latest.get(0)?.status).toBe('success')
    expect(latest.get(0)?.attempts).toBe(2)
    expect(latest.get(1)?.status).toBe('failed')
  })

  it('skips rows without a rowIndex (a parent or foreign row cannot vote)', () => {
    const latest = latestAttemptsByIndex([child(undefined, 'success'), child(0, 'failed')])
    expect(latest.size).toBe(1)
    expect(latest.get(0)?.status).toBe('failed')
  })
})

describe('planResumeRows', () => {
  // The four unfinished shapes plus one success, in one batch:
  const failedRan = child(1, 'failed', { conversationId: 'conv_1', paramsSnapshot: { repo: 'frozen' } })
  const skippedAtStop = child(2, 'skipped', { conversationId: undefined })
  const precheckFailed = child(3, 'failed', { error: '缺少必填参数（第 4 行）' }) // no conversation: never reached the engine
  const children = [child(0, 'success'), failedRan, skippedAtStop, precheckFailed] // row 4 never attempted

  it('takes every non-success row, in ascending index order', () => {
    const plan = planResumeRows(5, children)
    expect(plan.indices).toEqual([1, 2, 3, 4])
  })

  it('freezes a failed row THAT RAN to its snapshot; everything else reads the live CSV', () => {
    const plan = planResumeRows(5, children)
    // Row 1 reached an engine — its values are the ones it failed with.
    expect(plan.snapshotParams.get(1)).toEqual({ repo: 'frozen' })
    // Skipped, pre-check-failed and never-attempted rows never reached an
    // engine, so the user's fix to the file is what resuming picks up.
    expect(plan.csvIndices).toEqual([2, 3, 4])
    expect(plan.snapshotParams.has(2)).toBe(false)
    expect(plan.snapshotParams.has(3)).toBe(false)
    expect(plan.snapshotParams.has(4)).toBe(false)
  })

  it('a retried-then-succeeded row is NOT re-run (latest attempt wins)', () => {
    const wave2 = [...children, child(1, 'success', { attempts: 2 })]
    const plan = planResumeRows(5, wave2)
    expect(plan.indices).toEqual([2, 3, 4])
    expect(plan.snapshotParams.has(1)).toBe(false)
  })

  it('an empty plan is the 全部行已成功 refusal (resume refuses on length 0)', () => {
    const allSucceeded = [0, 1, 2, 3, 4].map((i) => child(i, 'success'))
    expect(planResumeRows(5, allSucceeded).indices).toEqual([])
  })

  it('row-count mismatch is caught later, not here: indices follow the DECLARED total', () => {
    // Even with children for fewer rows than declared, never-attempted rows
    // still join the plan — the runner compares the live file's length against
    // the same total before trusting them.
    const plan = planResumeRows(7, [child(0, 'success'), child(1, 'failed', { conversationId: 'c', paramsSnapshot: {} })])
    expect(plan.indices).toEqual([1, 2, 3, 4, 5, 6])
    expect(plan.csvIndices).toEqual([2, 3, 4, 5, 6])
  })
})

describe('progressFromAttempts', () => {
  it('counts each row once, by its latest attempt — waves never double-count', () => {
    const children = [
      child(0, 'failed'), // attempt 1
      child(1, 'running'),
      child(0, 'success', { attempts: 2 }), // attempt 2 supersedes
    ]
    const progress = progressFromAttempts(children, 4)
    expect(progress).toEqual({ total: 4, success: 1, failed: 0, skipped: 0, running: 1 })
    // The raw count would read failed 1 AND success 1 for the same row — that
    // divergence from the folded result IS the assertion.
    expect(children.filter((c) => c.status === 'failed')).toHaveLength(1)
  })

  it('the denominator is the declared total, not the children (honest before dispatch)', () => {
    const progress = progressFromAttempts([], 5)
    expect(progress).toEqual({ total: 5, success: 0, failed: 0, skipped: 0, running: 0 })
  })

  it('settled status buckets cover every terminal state', () => {
    const progress = progressFromAttempts(
      [child(0, 'success'), child(1, 'failed'), child(2, 'skipped'), child(3, 'running')],
      4,
    )
    expect(progress.success + progress.failed + progress.skipped + progress.running).toBe(4)
    expect(progress.skipped).toBe(1)
  })
})
