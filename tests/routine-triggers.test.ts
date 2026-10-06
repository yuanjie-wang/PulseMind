// PLAN-routine-triggers M1 — the event-fire door, the fs watcher and the
// loopback webhook endpoint, against mocked neighbours (store / runner /
// audit) in the same shape as routine-run-context.test.ts: the real module
// under test, mocks at its imports. The fs watch fires a REAL temp-dir event
// through the REAL debounce; the webhook tests hit the REAL http server over
// loopback fetch.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-routine-triggers-'))
mkdirSync(join(process.env.HOME, '.pulsemind'), { recursive: true })

const calls: { runner: Array<{ routineId: string; trigger: string }>; audit: Array<Record<string, unknown>> } = { runner: [], audit: [] }
/** The single fixture `routineStore` serves; mutated per case. */
let fixture: { id: string; name: string; enabled: boolean; triggers: unknown[]; running?: boolean } | null = null

vi.mock('../src/main/routine/routine-runner', () => ({
  routineRunner: {
    start: (routine: { id: string }, trigger: string) => {
      calls.runner.push({ routineId: routine.id, trigger })
      return { id: 'run_x' }
    },
    stop: () => {},
  },
}))
vi.mock('../src/main/routine/batch-runner', () => ({ routineBatchRunner: {} }))
vi.mock('../src/main/storage/audit-store', () => ({
  auditStore: { record: (entry: Record<string, unknown>) => { calls.audit.push(entry) } },
}))
vi.mock('../src/main/storage/routine-store', () => ({
  routineStore: {
    list: () => (fixture ? [fixture] : []),
    get: (id: string) => (fixture && fixture.id === id ? fixture : null),
    hasRunningRun: () => fixture?.running === true,
  },
}))

/** Predicate wait — never a fixed sleep (AGENTS.md flake rule 5). */
async function until(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('routineTriggerManager', () => {
  let mgr: typeof import('../src/main/routine/routine-triggers')['routineTriggerManager']
  let watchDir: string

  beforeAll(async () => {
    ;({ routineTriggerManager: mgr } = await import('../src/main/routine/routine-triggers'))
    watchDir = mkdtempSync(join(tmpdir(), 'pm-trigger-watch-'))
    mgr.start()
    await until(() => mgr.port > 0)
  })

  afterAll(() => {
    mgr.stop()
  })

  beforeEach(() => {
    calls.runner.length = 0
    calls.audit.length = 0
  })

  describe('fireTrigger gates', () => {
    it('a disabled routine is a silent no-drop-no-run', () => {
      fixture = { id: 'r1', name: '任务', enabled: false, triggers: [] }
      expect(mgr.fireTrigger('r1', 'file')).toBe(false)
      expect(calls.runner).toHaveLength(0)
    })

    it('overlap drops the event with a skipped audit row, runner untouched', () => {
      fixture = { id: 'r1', name: '任务', enabled: true, triggers: [], running: true }
      expect(mgr.fireTrigger('r1', 'webhook')).toBe(false)
      expect(calls.runner).toHaveLength(0)
      expect(calls.audit.at(-1)).toMatchObject({ action: 'routine.fire', decision: 'skipped' })
    })

    it('a live routine runs through the runner with its trigger kind', () => {
      fixture = { id: 'r1', name: '任务', enabled: true, triggers: [] }
      expect(mgr.fireTrigger('r1', 'webhook')).toBe(true)
      expect(calls.runner).toEqual([{ routineId: 'r1', trigger: 'webhook' }])
      expect(calls.audit.at(-1)).toMatchObject({ decision: 'allowed' })
    })
  })

  describe('file watcher', () => {
    it('a write burst collapses into exactly one debounced run', async () => {
      fixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 1000 }] }
      mgr.sync()
      writeFileSync(join(watchDir, 'a.txt'), '1')
      writeFileSync(join(watchDir, 'a.txt'), '2')
      writeFileSync(join(watchDir, 'a.txt'), '3')
      await until(() => calls.runner.length === 1)
      expect(calls.runner[0]).toMatchObject({ routineId: 'r1', trigger: 'file' })
      // No re-fire inside the quiet window after the run.
      const seen = calls.runner.length
      await new Promise((r) => setTimeout(r, 1200))
      expect(calls.runner.length).toBe(seen)
    })

    it('disabled or trigger-less routines lose their watchers on sync', async () => {
      fixture = { id: 'r1', name: '任务', enabled: false, triggers: [{ type: 'file', paths: [watchDir] }] }
      mgr.sync()
      writeFileSync(join(watchDir, 'b.txt'), 'x')
      await new Promise((r) => setTimeout(r, 1300))
      expect(calls.runner).toHaveLength(0)
    })
  })

  describe('webhook endpoint', () => {
    const fire = async (id = 'r1', token = 'tok', method = 'POST'): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${mgr.port}/routine/${id}/fire${token ? `?token=${token}` : ''}`, { method })
      void res.body?.cancel()
      return res.status
    }

    it('unknown id, wrong token and GET all answer 404/405 without leaking which', async () => {
      fixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'webhook', token: 'tok' }] }
      expect(await fire('ghost', 'tok')).toBe(404)
      expect(await fire('r1', 'wrong')).toBe(404)
      expect(await fire('r1', '', 'GET')).toBe(405)
      expect(calls.runner).toHaveLength(0)
    })

    it('a correct POST fires once (204); an overlap answers 409', async () => {
      fixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'webhook', token: 'tok' }] }
      expect(await fire()).toBe(204)
      expect(calls.runner).toEqual([{ routineId: 'r1', trigger: 'webhook' }])
      fixture = { ...fixture!, running: true }
      expect(await fire()).toBe(409)
      expect(calls.runner).toHaveLength(1)
    })
  })
})
