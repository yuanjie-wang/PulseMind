import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ── Slot-release regression (12h-run hardening) ──
// The scheduler used to release a fire's slot via a 15s poller with an
// UNCONDITIONAL 30-min kill — while a run's 单次超时 reaches 120 minutes and a
// 200-row batch at concurrency 1 can run for days. One >30-min run left the
// slot held forever and the routine skipped every later cron fire until
// restart. The release is EVENT-driven now (the runners' settlement hooks),
// with the poller kept as a boundless fallback whose own condition (no running
// run row) also clears it.

vi.mock('../src/shared/schedule/schedule-decision', () => ({
  // Every tick "decides" to fire — the test drives the slot mechanics, not
  // the schedule math (decideScheduleFire has its own coverage).
  decideScheduleFire: () => ({ fire: true, advanceTo: null }),
}))
vi.mock('../src/main/storage/routine-store', () => ({
  routineStore: {
    list: vi.fn(() => []),
    hasRunningRun: vi.fn(() => false),
    update: vi.fn(),
    startRun: vi.fn(),
    finishRun: vi.fn(),
    failStaleRuns: vi.fn(),
    getRun: vi.fn(),
    startBatchRun: vi.fn(),
    reopenBatchRun: vi.fn(),
    listBatchChildren: vi.fn(() => []),
  },
}))
vi.mock('../src/main/routine/routine-runner', () => ({
  routineRunner: { start: vi.fn(), stop: vi.fn() },
  notify: vi.fn(),
}))
vi.mock('../src/main/routine/batch-runner', () => ({
  routineBatchRunner: { start: vi.fn(), stop: vi.fn(), isActive: vi.fn(() => false) },
}))
vi.mock('../src/main/routine/routine-triggers', () => ({
  routineTriggerManager: { start: vi.fn(), stop: vi.fn() },
}))
vi.mock('../src/main/routine/routine-run-history', () => ({
  routineRunHistory: { prune: vi.fn(async () => 0) },
}))
vi.mock('../src/main/storage/audit-store', () => ({
  auditStore: { record: vi.fn() },
}))
vi.mock('../src/main/storage/conversation.db', () => ({
  migrateRoutineConversationTypes: vi.fn(),
}))

const { routineScheduler } = await import('../src/main/routine/routine-scheduler')
const { routineRunner } = await import('../src/main/routine/routine-runner')
const { routineBatchRunner } = await import('../src/main/routine/batch-runner')
const { routineStore } = await import('../src/main/storage/routine-store')

type StartMock = ReturnType<typeof vi.fn>

function makeRoutine(id: string, batch = false) {
  return {
    id,
    name: `任务 ${id}`,
    enabled: true,
    prompt: '检查',
    schedule: { cron: '*/5 * * * *', catchUp: 'once' },
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    ...(batch ? { batch: { applyToSchedule: true } } : {}),
  }
}

/** Fire once through the real tick, capture the settlement hook the runner
 *  received, and return a probe for whether the slot is still held (a second
 *  tick reaching the runner = released). */
async function fireOnce(id: string, batch = false) {
  const runnerMock = (batch ? routineBatchRunner.start : routineRunner.start) as StartMock
  runnerMock.mockClear()
  const listMock = routineStore.list as StartMock
  listMock.mockReturnValue([makeRoutine(id, batch)])
  ;(routineStore.hasRunningRun as StartMock).mockReturnValue(true)
  await Promise.resolve(routineScheduler.tick())
  await vi.advanceTimersByTimeAsync(0)
  expect(runnerMock).toHaveBeenCalledTimes(1)
  const onSettled = runnerMock.mock.calls[0][3] as (() => void) | undefined
  expect(onSettled).toBeTypeOf('function')
  const wasRefired = async () => {
    await Promise.resolve(routineScheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    return runnerMock.mock.calls.length > 1
  }
  return { onSettled: onSettled as () => void, wasRefired }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('routine scheduler slot release (event-driven, no 30-min kill)', () => {
  it('constant sanity: the old unconditional 30-min poller kill is gone', async () => {
    const src = await import('node:fs').then(fs => fs.promises.readFile('src/main/routine/routine-scheduler.ts', 'utf8'))
    expect(src).not.toContain('clearInterval(check), 30 * 60_000')
    // The release hook rides BOTH runners' start calls (4th argument).
    expect(src).toContain("routineRunner.start(routine, 'schedule', undefined, release)")
    expect(src).toContain("routineBatchRunner.start(routine, 'schedule', undefined, release)")
  })

  it('a single run settling after 40 minutes releases the slot (old bug: wedged forever)', async () => {
    const { onSettled, wasRefired } = await fireOnce('slot_single')
    // 40 minutes of the run still going — the old kill would have fired at 30.
    await vi.advanceTimersByTimeAsync(40 * 60_000)
    expect(await wasRefired()).toBe(false) // still held
    onSettled()
    expect(await wasRefired()).toBe(true) // event release opened the slot
  })

  it('a batch parent settling releases the slot', async () => {
    const { onSettled, wasRefired } = await fireOnce('slot_batch', true)
    expect(await wasRefired()).toBe(false)
    onSettled()
    expect(await wasRefired()).toBe(true)
  })

  it('a refused batch start (rejection, no run row) releases the slot', async () => {
    ;(routineBatchRunner.start as StartMock).mockRejectedValueOnce(new Error('数据文件不可读'))
    const listMock = routineStore.list as StartMock
    listMock.mockReturnValue([makeRoutine('slot_refused', true)])
    ;(routineStore.hasRunningRun as StartMock).mockReturnValue(false)
    await Promise.resolve(routineScheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    expect(routineBatchRunner.start).toHaveBeenCalledTimes(1)
    // The catch releases — the next tick reaches the runner again.
    await Promise.resolve(routineScheduler.tick())
    await vi.advanceTimersByTimeAsync(0)
    expect(routineBatchRunner.start).toHaveBeenCalledTimes(2)
  })

  it('the fallback poller still releases when the run row settles without an event', async () => {
    await fireOnce('slot_poller')
    ;(routineStore.hasRunningRun as StartMock).mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await (async () => {
      await Promise.resolve(routineScheduler.tick())
      await vi.advanceTimersByTimeAsync(0)
      return (routineRunner.start as StartMock).mock.calls.length > 1
    })()).toBe(true)
  })

  it('a 120-minute run is NOT killed at 30 minutes (the wedge scenario, end to end)', async () => {
    const { onSettled, wasRefired } = await fireOnce('slot_120min')
    // Exactly the old kill point: slot must still be held here.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(await wasRefired()).toBe(false)
    // Run finishes at its 120-minute ceiling.
    await vi.advanceTimersByTimeAsync(90 * 60_000)
    onSettled()
    expect(await wasRefired()).toBe(true)
  })
})
