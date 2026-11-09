// PLAN-routine-triggers M1 — the event-fire door, the fs watcher and the
// loopback webhook endpoint, against mocked neighbours (stores / runners /
// audit) in the same shape as routine-run-context.test.ts: the real module
// under test, mocks at its imports. The fs watch fires a REAL temp-dir event
// through the REAL debounce; the webhook tests hit the REAL http server over
// loopback fetch.
//
// 2026-11-08：管理器从 routine/routine-triggers 迁到 task/task-triggers 并按
// 「两模式同一套」重写——键是 `<kind>:<id>`，routine fire 走 routineRunner.start，
// workflow fire 走 launchWorkflowRun，同一道门、两个 runner。文件名保持
// routine-triggers 只因为它是这个门的原始钉子。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-routine-triggers-'))
mkdirSync(join(process.env.HOME, '.pulsemind'), { recursive: true })

const calls: {
  routineRunner: Array<{ routineId: string; trigger: string }>
  workflowLaunch: Array<{ workflowId: string; trigger: string }>
  audit: Array<Record<string, unknown>>
  storeGet: number
} = { routineRunner: [], workflowLaunch: [], audit: [], storeGet: 0 }

interface Fixture {
  id: string
  name: string
  enabled?: boolean
  triggers: unknown[]
  running?: boolean
}

/** The single routine the fixture store serves; mutated per case. */
let routineFixture: Fixture | null = null
/** Same for the workflow family — no `enabled` (a definition is live by existing). */
let workflowFixture: Fixture | null = null

vi.mock('../src/main/routine/routine-runner', () => ({
  routineRunner: {
    start: (routine: { id: string }, trigger: string) => {
      calls.routineRunner.push({ routineId: routine.id, trigger })
      return { id: 'run_x' }
    },
    stop: () => {},
  },
}))
vi.mock('../src/main/pipeline/launch', () => ({
  launchWorkflowRun: (opts: { workflow: { id: string }; trigger: string }) => {
    calls.workflowLaunch.push({ workflowId: opts.workflow.id, trigger: opts.trigger })
    return ['prun_x']
  },
}))
vi.mock('../src/main/storage/audit-store', () => ({
  auditStore: {
    record: (entry: Record<string, unknown>) => {
      calls.audit.push(entry)
    },
  },
}))
vi.mock('../src/main/storage/routine-store', () => ({
  routineStore: {
    list: () => (routineFixture ? [routineFixture] : []),
    get: (id: string) => {
      calls.storeGet++
      return routineFixture && routineFixture.id === id ? routineFixture : null
    },
    hasRunningRun: () => routineFixture?.running === true,
  },
}))
vi.mock('../src/main/storage/workflow-store', () => ({
  workflowStore: {
    list: () => (workflowFixture ? [workflowFixture] : []),
    get: (id: string) => {
      calls.storeGet++
      return workflowFixture && workflowFixture.id === id ? workflowFixture : null
    },
  },
}))
vi.mock('../src/main/storage/pipeline-run-store', () => ({
  pipelineRunStore: { hasRunningForWorkflow: () => workflowFixture?.running === true },
}))

/** Predicate wait — never a fixed sleep (AGENTS.md flake rule 5). */
async function until(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('taskTriggerManager', () => {
  let mgr: (typeof import('../src/main/task/task-triggers'))['taskTriggerManager']
  let watchDir: string

  beforeAll(async () => {
    ;({ taskTriggerManager: mgr } = await import('../src/main/task/task-triggers'))
    watchDir = mkdtempSync(join(tmpdir(), 'pm-trigger-watch-'))
    mgr.start()
    await until(() => mgr.port > 0)
  })

  afterAll(() => {
    mgr.stop()
  })

  beforeEach(() => {
    calls.routineRunner.length = 0
    calls.workflowLaunch.length = 0
    calls.audit.length = 0
    routineFixture = null
    workflowFixture = null
  })

  describe('fireTrigger gates（routine 臂）', () => {
    it('a disabled routine is a silent no-drop-no-run', () => {
      routineFixture = { id: 'r1', name: '任务', enabled: false, triggers: [] }
      expect(mgr.fireTrigger('routine:r1', 'file')).toBe(false)
      expect(calls.routineRunner).toHaveLength(0)
    })

    it('overlap drops the event with a skipped audit row, runner untouched', () => {
      routineFixture = { id: 'r1', name: '任务', enabled: true, triggers: [], running: true }
      expect(mgr.fireTrigger('routine:r1', 'webhook')).toBe(false)
      expect(calls.routineRunner).toHaveLength(0)
      expect(calls.audit.at(-1)).toMatchObject({ action: 'routine.fire', decision: 'skipped' })
    })

    it('a live routine runs through the runner with its trigger kind', () => {
      routineFixture = { id: 'r1', name: '任务', enabled: true, triggers: [] }
      expect(mgr.fireTrigger('routine:r1', 'webhook')).toBe(true)
      expect(calls.routineRunner).toEqual([{ routineId: 'r1', trigger: 'webhook' }])
      expect(calls.audit.at(-1)).toMatchObject({ decision: 'allowed' })
    })

    it('a deleted routine and a malformed key are both silent drops', () => {
      expect(mgr.fireTrigger('routine:ghost', 'file')).toBe(false)
      expect(mgr.fireTrigger('bogus:r1', 'file')).toBe(false)
      expect(mgr.fireTrigger('routine:', 'file')).toBe(false)
      expect(calls.routineRunner).toHaveLength(0)
    })
  })

  describe('fireTrigger gates（workflow 臂，两模式同一套）', () => {
    it('a live workflow goes through launchWorkflowRun, audit scoped workflow', () => {
      workflowFixture = { id: 'w1', name: '流程', triggers: [] }
      expect(mgr.fireTrigger('workflow:w1', 'webhook')).toBe(true)
      expect(calls.workflowLaunch).toEqual([{ workflowId: 'w1', trigger: 'webhook' }])
      // 两族的 runner 不得互相串：routine 侧的 mock 一次都没被调。
      expect(calls.routineRunner).toHaveLength(0)
      expect(calls.audit.at(-1)).toMatchObject({ scope: 'workflow', action: 'workflow.fire', decision: 'allowed' })
    })

    it('overlap drops via pipelineRunStore.hasRunningForWorkflow', () => {
      workflowFixture = { id: 'w1', name: '流程', triggers: [], running: true }
      expect(mgr.fireTrigger('workflow:w1', 'file')).toBe(false)
      expect(calls.workflowLaunch).toHaveLength(0)
      expect(calls.audit.at(-1)).toMatchObject({ action: 'workflow.fire', decision: 'skipped' })
    })

    it('a disabled workflow is silent, same as a disabled routine (user 2026-11-09)', () => {
      // 工作流自 2026-11-09 起与对话式任务同一颗卡片开关，`enabled: false`
      // 就是关：事件触发不再自动跑（手动运行不受影响）。旧的「工作流没有开关、
      // enabled 一律当活」判词已随卡片统一下台。
      workflowFixture = { id: 'w1', name: '流程', enabled: false, triggers: [] }
      expect(mgr.fireTrigger('workflow:w1', 'file')).toBe(false)
      expect(calls.workflowLaunch).toHaveLength(0)
      // 缺席 = 启用：旧定义零迁移。
      workflowFixture = { id: 'w1', name: '流程', triggers: [] }
      expect(mgr.fireTrigger('workflow:w1', 'file')).toBe(true)
      expect(calls.workflowLaunch).toHaveLength(1)
    })

    it('same id in both families never collides (key prefix is the discriminator)', () => {
      routineFixture = { id: 'same', name: '任务', enabled: true, triggers: [] }
      workflowFixture = { id: 'same', name: '流程', triggers: [] }
      expect(mgr.fireTrigger('routine:same', 'file')).toBe(true)
      expect(mgr.fireTrigger('workflow:same', 'file')).toBe(true)
      expect(calls.routineRunner).toEqual([{ routineId: 'same', trigger: 'file' }])
      expect(calls.workflowLaunch).toEqual([{ workflowId: 'same', trigger: 'file' }])
    })
  })

  describe('file watcher', () => {
    it('a write burst collapses into exactly one debounced run', async () => {
      routineFixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 1000 }] }
      mgr.sync()
      writeFileSync(join(watchDir, 'a.txt'), '1')
      writeFileSync(join(watchDir, 'a.txt'), '2')
      writeFileSync(join(watchDir, 'a.txt'), '3')
      await until(() => calls.routineRunner.length === 1)
      expect(calls.routineRunner[0]).toMatchObject({ routineId: 'r1', trigger: 'file' })
      // No re-fire inside the quiet window after the run.
      const seen = calls.routineRunner.length
      await new Promise((r) => setTimeout(r, 1200))
      expect(calls.routineRunner.length).toBe(seen)
    })

    it('disabled or trigger-less routines lose their watchers on sync', async () => {
      routineFixture = { id: 'r1', name: '任务', enabled: false, triggers: [{ type: 'file', paths: [watchDir] }] }
      mgr.sync()
      writeFileSync(join(watchDir, 'b.txt'), 'x')
      await new Promise((r) => setTimeout(r, 1300))
      expect(calls.routineRunner).toHaveLength(0)
    })

    it('a workflow file trigger mounts through the same watcher set', async () => {
      workflowFixture = { id: 'wf-watch', name: '流程', triggers: [{ type: 'file', paths: [watchDir], debounceMs: 120 }] }
      mgr.sync()
      writeFileSync(join(watchDir, 'wf.txt'), '1')
      await until(() => calls.workflowLaunch.length === 1)
      expect(calls.workflowLaunch[0]).toMatchObject({ workflowId: 'wf-watch', trigger: 'file' })
    })

    // review_20261007 高2: sync()'s dedup keyed on routine id alone — an edited
    // path set kept the OLD watcher live (removed path kept firing) while the
    // added path never watched, silently, until 停用再启用 or restart.
    it('editing the watched paths re-mounts: the old path goes silent, the new path fires', async () => {
      const dirB = mkdtempSync(join(tmpdir(), 'pm-trigger-watch-b-'))
      try {
        routineFixture = { id: 'rp', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 120 }] }
        mgr.sync()
        writeFileSync(join(watchDir, 'old.txt'), '1')
        await until(() => calls.routineRunner.length === 1)
        routineFixture = { id: 'rp', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [dirB], debounceMs: 120 }] }
        mgr.sync()
        writeFileSync(join(watchDir, 'old2.txt'), '2') // removed path: must be silent now
        await new Promise((r) => setTimeout(r, 400))
        expect(calls.routineRunner).toHaveLength(1)
        writeFileSync(join(dirB, 'new.txt'), '3') // added path: must watch and fire
        await until(() => calls.routineRunner.length === 2)
        expect(calls.routineRunner[1]).toMatchObject({ routineId: 'rp', trigger: 'file' })
      } finally {
        rmSync(dirB, { recursive: true, force: true })
      }
    })

    // review_20261007 中5: the store has no memory cache, so the old per-event
    // routineStore.get() paid a synchronous readFileSync+JSON.parse for every
    // fs event on the shared main process. The debounce now rides the value
    // sync() cached; only the actual fire reads the store (once).
    it('a write burst reads the store once per fire, not once per fs event', async () => {
      routineFixture = { id: 'rg', name: '任务', enabled: true, triggers: [{ type: 'file', paths: [watchDir], debounceMs: 120 }] }
      mgr.sync()
      calls.storeGet = 0
      for (let i = 0; i < 20; i++) writeFileSync(join(watchDir, `burst-${i}.txt`), String(i))
      await until(() => calls.routineRunner.length >= 1)
      await new Promise((r) => setTimeout(r, 300)) // let straggler events settle
      expect(calls.routineRunner).toHaveLength(1)
      expect(calls.storeGet).toBe(1)
    })
  })

  describe('webhook endpoint', () => {
    const fire = async (id = 'r1', token = 'tok', method = 'POST', kind: 'routine' | 'workflow' = 'routine'): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${mgr.port}/${kind}/${id}/fire${token ? `?token=${token}` : ''}`, { method })
      void res.body?.cancel()
      return res.status
    }

    it('unknown id, wrong token and GET all answer 404/405 without leaking which', async () => {
      routineFixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'webhook', token: 'tok' }] }
      expect(await fire('ghost', 'tok')).toBe(404)
      expect(await fire('r1', 'wrong')).toBe(404)
      expect(await fire('r1', '', 'GET')).toBe(405)
      expect(calls.routineRunner).toHaveLength(0)
    })

    it('a correct POST fires once (204); an overlap answers 409', async () => {
      routineFixture = { id: 'r1', name: '任务', enabled: true, triggers: [{ type: 'webhook', token: 'tok' }] }
      expect(await fire()).toBe(204)
      expect(calls.routineRunner).toEqual([{ routineId: 'r1', trigger: 'webhook' }])
      routineFixture = { ...routineFixture!, running: true }
      expect(await fire()).toBe(409)
      expect(calls.routineRunner).toHaveLength(1)
    })

    it('the /workflow/<id>/fire route serves the same contract', async () => {
      workflowFixture = { id: 'w1', name: '流程', triggers: [{ type: 'webhook', token: 'wtok' }] }
      expect(await fire('w1', 'wtok', 'POST', 'workflow')).toBe(204)
      expect(calls.workflowLaunch).toEqual([{ workflowId: 'w1', trigger: 'webhook' }])
      // 另一个 kind 的同名 id 不可命中（路由段与 store 族一致）。
      expect(await fire('w1', 'wtok', 'POST', 'routine')).toBe(404)
    })

    it('a workflow without a webhook trigger 404s even with a token', async () => {
      workflowFixture = { id: 'w1', name: '流程', triggers: [{ type: 'file', paths: [watchDir] }] }
      expect(await fire('w1', 'tok', 'POST', 'workflow')).toBe(404)
      expect(calls.workflowLaunch).toHaveLength(0)
    })
  })
})
