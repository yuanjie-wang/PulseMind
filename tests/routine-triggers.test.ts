// PLAN-routine-triggers M1 — the event-fire door, the fs watcher and the
// loopback webhook endpoint, against mocked neighbours (store / runner /
// audit) in the same shape as routine-run-context.test.ts: the real module
// under test, mocks at its imports. The fs watch fires a REAL temp-dir event
// through the REAL debounce; the webhook tests hit the REAL http server over
// loopback fetch.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-routine-triggers-'))
mkdirSync(join(process.env.HOME, '.pulsemind'), { recursive: true })

const calls: { runner: Array<{ routineId: string; trigger: string }>; audit: Array<Record<string, unknown>>; storeGet: number } = { runner: [], audit: [], storeGet: 0 }
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
    get: (id: string) => {
      calls.storeGet++
      return fixture && fixture.id === id ? fixture : null
    },
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

    // review_20261007 高2: sync()'s dedup keyed on routine id alone — an edited
    // path set kept the OLD watcher live (removed path kept firing) while the
    // added path never watched, silently, until 停用再启用 or restart.
    it('editing the watched paths re-mounts: the old path goes silent, the new path fires', async () => {
      const dirB = mkdtempSync(join(tmpdir(), 'pm-trigger-watch-b-'))
      try {
        fixture = { id: 'rp', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 120 }] }
        mgr.sync()
        writeFileSync(join(watchDir, 'old.txt'), '1')
        await until(() => calls.runner.length === 1)
        fixture = { id: 'rp', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [dirB], debounceMs: 120 }] }
        mgr.sync()
        writeFileSync(join(watchDir, 'old2.txt'), '2') // removed path: must be silent now
        await new Promise((r) => setTimeout(r, 400))
        expect(calls.runner).toHaveLength(1)
        writeFileSync(join(dirB, 'new.txt'), '3') // added path: must watch and fire
        await until(() => calls.runner.length === 2)
        expect(calls.runner[1]).toMatchObject({ routineId: 'rp', trigger: 'file' })
      } finally {
        rmSync(dirB, { recursive: true, force: true })
      }
    })

    // review_20261007 中5: the store has no memory cache, so the old per-event
    // routineStore.get() paid a synchronous readFileSync+JSON.parse for every
    // fs event on the shared main process. The debounce now rides the value
    // sync() cached; only the actual fire reads the store (once).
    it('a write burst reads the store once per fire, not once per fs event', async () => {
      fixture = { id: 'rg', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 120 }] }
      mgr.sync()
      calls.storeGet = 0
      for (let i = 0; i < 20; i++) writeFileSync(join(watchDir, `burst-${i}.txt`), String(i))
      await until(() => calls.runner.length >= 1)
      await new Promise((r) => setTimeout(r, 300)) // let straggler events settle
      expect(calls.runner).toHaveLength(1)
      expect(calls.storeGet).toBe(1)
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
