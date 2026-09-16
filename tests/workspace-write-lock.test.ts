import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

// file-ops pulls in the sandbox guard, which pulls in the audit store and the
// SQLite layer (better-sqlite3 is Electron-ABI and cannot load under plain
// Node). The lock tests exercise lock ordering + staleness on real fs, not the
// jail (covered by path-jail.test.ts), so the guard is replaced wholesale with
// an allow-all.
vi.mock('../src/main/sandbox/guard', () => ({
  guardFsTarget: async (t: string) => ({ ok: true, resolved: t }),
  checkFsTarget: async (t: string) => ({ ok: true, resolved: t }),
}))

// `stat` is mocked so the staleness window (read → write inside one edit) can
// be crossed deterministically: everything forwards to the real fs.
const statHolder = vi.hoisted(() => ({ real: null as null | ((...a: unknown[]) => Promise<import('node:fs').Stats>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  statHolder.real = actual.stat as typeof statHolder.real
  return { ...actual, stat: vi.fn(actual.stat) }
})

import { withPathLock } from '../src/main/sandbox/write-lock'
import { svcEditFile } from '../src/main/services/file-ops'

const DIR = join(tmpdir(), 'pulsemind-write-lock-test')
const tick = () => new Promise((r) => setTimeout(r, 5))

/** Poll until cond() holds, then assert it (bounded, so a regression fails instead of hanging). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick()
  expect(cond()).toBe(true)
}

describe('withPathLock', () => {
  it('same path: strictly FIFO, one holder at a time', async () => {
    const order: string[] = []
    const releases: Array<() => void> = []
    const runs = [0, 1, 2].map((i) =>
      withPathLock('/wl/fifo.txt', async () => {
        order.push(`start-${i}`)
        await new Promise<void>((r) => { releases[i] = r })
        order.push(`end-${i}`)
      })
    )
    await until(() => order.length === 1 && order[0] === 'start-0')
    releases[0]()
    await until(() => order.join(',') === 'start-0,end-0,start-1')
    releases[1]()
    await until(() => order.join(',') === 'start-0,end-0,start-1,end-1,start-2')
    releases[2]()
    await Promise.all(runs)
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('same path: a newcomer cannot barge ahead of an already-queued waiter', async () => {
    const releases: Array<() => void> = []
    const order: string[] = []
    const holder = withPathLock('/wl/barge.txt', async () => {
      await new Promise<void>((r) => { releases[0] = r })
    })
    const first = withPathLock('/wl/barge.txt', async () => {
      order.push('first')
    })
    await until(() => releases.length === 1 && Array.isArray(releases))
    // `first` is queued; the latecomer must line up behind it.
    const late = withPathLock('/wl/barge.txt', async () => {
      order.push('late')
    })
    releases[0]()
    await Promise.all([holder, first, late])
    expect(order).toEqual(['first', 'late'])
  })

  it('different paths never wait on each other', async () => {
    let releaseA!: () => void
    const holderGate = new Promise<void>((r) => { releaseA = r })
    let aDone = false
    const a = withPathLock('/wl/a.txt', async () => {
      await holderGate
      aDone = true
    })
    await tick()
    const b = await withPathLock('/wl/b.txt', async () => 'b-result')
    expect(b).toBe('b-result')
    expect(aDone).toBe(false)
    releaseA()
    await a
    expect(aDone).toBe(true)
  })

  it('a failing fn releases the lock — the next caller proceeds, error still propagates', async () => {
    const p = '/wl/poison.txt'
    await expect(withPathLock(p, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withPathLock(p, async () => 'ok')).resolves.toBe('ok')
  })
})

describe('file-ops write serialization (real fs)', () => {
  mkdirSync(DIR, { recursive: true })

  it('two concurrent edits to different parts of one file both land', async () => {
    const target = join(DIR, 'shared.txt')
    writeFileSync(target, 'start ALPHA middle BETA end', 'utf-8')
    const [a, b] = await Promise.all([
      svcEditFile({ filePath: target, oldStr: 'ALPHA', newStr: 'ALPHA-1', multi: false }),
      svcEditFile({ filePath: target, oldStr: 'BETA', newStr: 'BETA-2', multi: false }),
    ])
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('start ALPHA-1 middle BETA-2 end')
  })

  it('rejects with an actionable error when the file changes between read and write', async () => {
    const target = join(DIR, 'stale.txt')
    writeFileSync(target, 'hello world', 'utf-8')
    const statMock = vi.mocked((await import('node:fs/promises')).stat)
    const realStat = statHolder.real!
    let calls = 0
    statMock.mockImplementation(async (p: never, opts: never) => {
      const real = await realStat(p, opts)
      if (String(p) === target) {
        calls++
        if (calls === 2) {
          // Another writer (user's editor) lands inside the read→write window.
          return { ...real, mtimeMs: real.mtimeMs + 12345, size: real.size + 3 }
        }
      }
      return real
    })
    try {
      const res = await svcEditFile({ filePath: target, oldStr: 'world', newStr: 'there', multi: false })
      expect(res.success).toBe(false)
      expect(res.error).toBe('file changed on disk since it was read — re-read and retry')
      expect(readFileSync(target, 'utf-8')).toBe('hello world')
      expect(calls).toBe(2) // once before the read, once before the write — both checks ran
    } finally {
      statMock.mockImplementation(realStat as never)
    }  })
})
