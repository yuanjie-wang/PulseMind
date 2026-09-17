// ── Deletion vs the background save tick ──
// The auto-cleanup eviction in createNewConversation (MAX_SESSIONS) removed the
// conversation from the list and fired the delete IPC, but left the cached
// engine in enginesRef; the new 10s sweep and the beforeunload flush iterate
// that map, so the deleted id was re-saved — and both write channels
// (appendConversationMessages / saveConversation) are UPSERTs, which resurrected
// the deleted row. deleteConversation had the right shape (dispose → forget →
// delete); the cleanup path skipped all three.
//
// A source scan cannot prove ordering under a held in-flight write, and the
// hook itself cannot be mounted (vitest is node-env, no jsdom/React). What is
// testable is the exact production shape, exercised through the REAL pieces:
// teardownConversation (the shared lifecycle helper the hook now calls) +
// the real ConversationSaveQueue + a synthetic engine map + a recording
// transport standing in for window.electronAPI, plus a sweep loop that
// replicates the hook's setInterval body verbatim
// (`for (const id of enginesRef.current.keys()) save(id)`).
//
// Non-vacuity: the resurrect case was measured against the pre-fix shape —
// eviction WITHOUT teardown (engine left in the map, no forget) fails every
// "never written again" assertion below.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConversationSaveQueue, teardownConversation } from '../src/renderer/src/utils/incremental-save'
import type { PersistableSnapshot } from '../src/renderer/src/utils/incremental-save'

interface Msg { id: string; text?: string }

/** Synthetic cached-engine map entry: the hook only reads `.messages` when
 *  snapshotting and calls `.dispose()` on teardown. */
function fakeEngine(msgs: Msg[]) {
  return {
    messages: msgs,
    disposed: false,
    dispose() { this.disposed = true },
  }
}

type Write = { convId: string; ids: string[]; mode: 'append' | 'full' }

/** Recording transport mirroring the hook's write callback (full → saveConversation,
 *  else → appendConversationMessages) and the row deletion. */
function makeTransport() {
  const writes: Write[] = []
  const deleted: string[] = []
  const write = vi.fn(async (convId: string, snap: PersistableSnapshot, plan: { mode: string; indices?: number[] }) => {
    const ids = plan.mode === 'full'
      ? snap.messages.map(m => m.id)
      : (plan.indices ?? []).map(i => snap.messages[i].id)
    writes.push({ convId, ids, mode: plan.mode === 'full' ? 'full' : 'append' })
  })
  const deleteRow = vi.fn(async (convId: string) => { deleted.push(convId) })
  return { writes, deleted, write, deleteRow }
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** The hook's periodic sweep body, verbatim in shape: iterate the ENGINE MAP
 *  (not any list) and dispatch a save per entry. */
function sweepTick(
  engines: Map<string, { messages: Msg[] }>,
  queue: ConversationSaveQueue<PersistableSnapshot>,
  write: (convId: string, snap: PersistableSnapshot, plan: { mode: string; indices?: number[] }) => Promise<void>,
) {
  const dispatched: Promise<void>[] = []
  for (const id of engines.keys()) {
    dispatched.push(queue.save(
      id,
      () => engines.get(id) && { messages: engines.get(id)!.messages },
      (snap, plan) => write(id, snap, plan),
    ))
  }
  return dispatched
}

const noWrite = async () => {
  throw new Error('the transport must not be reached')
}

describe('teardownConversation lifecycle (eviction vs background save tick)', () => {
  it('a survivor engine keeps saving across an unrelated teardown', async () => {
    const queue = new ConversationSaveQueue<PersistableSnapshot>()
    const engines = new Map<string, { messages: Msg[]; dispose(): void }>()
    const t = makeTransport()
    const deletedMsgs: Msg[] = [{ id: 'd1', text: 'old chat' }]
    const survivorMsgs: Msg[] = [{ id: 's1', text: 'kept chat' }]
    engines.set('conv_dead', fakeEngine(deletedMsgs))
    engines.set('conv_keep', fakeEngine(survivorMsgs))
    // Both start at baseline; only the survivor gets new content.
    queue.seed('conv_dead', { messages: [{ id: 'd1', text: 'old chat' }] })
    queue.seed('conv_keep', { messages: [{ id: 's1' }] })

    // Tick one: survivor has new content, deleted one is at baseline.
    survivorMsgs[0].text = 'kept chat, new turn'
    const tick1 = sweepTick(engines, queue, t.write)
    await Promise.all(tick1)
    expect(t.writes.map(w => w.convId).sort()).toEqual(['conv_keep'])
    expect(t.writes[0].ids).toEqual(['s1'])

    // Tick two: still saves the survivor again if it changed further.
    survivorMsgs.push({ id: 's2', text: 'second' })
    await Promise.all(sweepTick(engines, queue, t.write))
    expect(t.writes.map(w => w.convId).sort()).toEqual(['conv_keep', 'conv_keep'])
    expect(t.writes[1].ids).toEqual(['s2'])
  })

  it('eviction via teardownConversation: the deleted id never reaches the transport again, the survivor does', async () => {
    const queue = new ConversationSaveQueue<PersistableSnapshot>()
    const engines = new Map<string, { messages: Msg[]; dispose(): void }>()
    const t = makeTransport()
    const deadMsgs: Msg[] = [{ id: 'd1', text: 'v1' }]
    const keepMsgs: Msg[] = [{ id: 'k1', text: 'v1' }]
    engines.set('conv_dead', fakeEngine(deadMsgs))
    engines.set('conv_keep', fakeEngine(keepMsgs))
    queue.seed('conv_dead', { messages: [{ id: 'd1', text: 'v0' }] }) // dead one is dirty
    queue.seed('conv_keep', { messages: [{ id: 'k1', text: 'v0' }] }) // keep one is dirty too

    // Pre-delete tick: both are dirty, so the transport carries both ids —
    // the sweep is a live channel for the deleted conversation too, which is
    // exactly the resurrection path.
    await Promise.all(sweepTick(engines, queue, t.write))
    expect(t.writes.map(w => w.convId).sort()).toEqual(['conv_dead', 'conv_keep'])

    // Auto-cleanup eviction, production shape: list entry dropped + teardown.
    await teardownConversation('conv_dead', engines as never, queue, t.deleteRow)
    expect(t.deleted).toEqual(['conv_dead'])

    // The deleted engine's content changes AFTER deletion — a late tool result
    // landing on a cached engine. With the engine still in the map this is
    // exactly what the sweep used to re-save (resurrection).
    deadMsgs[0].text = 'late tool result'
    // The survivor keeps working meanwhile.
    keepMsgs[0].text = 'kept v2'

    const writesAfter = t.writes.length
    await Promise.all(sweepTick(engines, queue, t.write))
    await flushMicrotasks()

    expect(t.writes.slice(writesAfter).map(w => w.convId)).toEqual(['conv_keep'])
    expect(t.writes[t.writes.length - 1].ids).toEqual(['k1'])
    // The engine was disposed and is out of the map, so nothing can even read it.
    expect(engines.has('conv_dead')).toBe(false)
  })

  it('in-flight save drains BEFORE the row is deleted, and nothing writes after', async () => {
    const queue = new ConversationSaveQueue<PersistableSnapshot>()
    const engines = new Map<string, { messages: Msg[]; dispose(): void }>()
    const writes: Write[] = []
    const deleted: string[] = []
    let held = true
    const parked: Array<() => void> = []
    const write = vi.fn(async (convId: string, snap: PersistableSnapshot, plan: { mode: string; indices?: number[] }) => {
      const ids = plan.mode === 'full' ? snap.messages.map(m => m.id) : (plan.indices ?? []).map(i => snap.messages[i].id)
      writes.push({ convId, ids, mode: plan.mode === 'full' ? 'full' : 'append' })
      if (held) return new Promise<void>(resolve => { parked.push(resolve) })
    })
    const msgs: Msg[] = [{ id: 'm1', text: 'v2' }]
    engines.set('conv_x', fakeEngine(msgs))
    queue.seed('conv_x', { messages: [{ id: 'm1', text: 'v1' }] })

    // A save is dispatched (its IPC is in flight, held at the transport).
    void queue.save('conv_x', () => ({ messages: engines.get('conv_x')!.messages }),
      (snap, plan) => write('conv_x', snap, plan))
    await flushMicrotasks(2)
    expect(writes).toHaveLength(1)

    // Deletion while the write is in flight: forget awaits the lane first.
    const teardown = teardownConversation('conv_x', engines as never, queue, async id => {
      deleted.push(id)
      // Guard the ordering contract itself: the row must not be deleted while
      // an in-flight write to it is still parked.
      expect(held).toBe(false)
    })
    await flushMicrotasks()
    expect(deleted).toHaveLength(0) // still waiting on the in-flight write

    held = false
    for (const r of parked) r()
    await teardown
    expect(deleted).toEqual(['conv_x'])

    // After teardown, further ticks write nothing at all (the map has no entry
    // for this id — the sweep cannot even read it).
    msgs[0].text = 'v3 after delete'
    await Promise.all(sweepTick(engines, queue, noWrite))
    await flushMicrotasks()
    expect(writes).toHaveLength(1)
  })

  it('the old-conversation full flush cannot resurrect the id the cleanup just evicted', async () => {
    // createNewConversation evicts the OLDEST entries of a newest-first list
    // (conversations.slice(-toRemove)) and then flushes the conversation the
    // user was leaving — when that one IS the oldest, the flush targets an id
    // the cleanup just deleted. Production arithmetic, MAX_SESSIONS = 100.
    const listLength = 100
    const MAX_SESSIONS = 100
    const toRemove = listLength - MAX_SESSIONS + 1
    const newestFirst = Array.from({ length: listLength }, (_, i) => `c${i}`)
    const activeId = newestFirst[newestFirst.length - 1] // the oldest = the flush target
    expect(newestFirst.slice(-toRemove)).toEqual([activeId])

    const queue = new ConversationSaveQueue<PersistableSnapshot>()
    const engines = new Map<string, { messages: Msg[]; dispose(): void }>()
    const t = makeTransport()
    const activeMsgs: Msg[] = [{ id: 'm_old', text: 'unsaved tail' }]
    engines.set(activeId, fakeEngine(activeMsgs))
    queue.seed(activeId, { messages: [{ id: 'm_old', text: 'stale' }] }) // dirty

    const evictedIds = new Set<string>()
    for (const key of newestFirst.slice(-toRemove)) {
      evictedIds.add(key)
      await teardownConversation(key, engines as never, queue, t.deleteRow)
    }
    expect(t.deleted).toEqual([activeId])

    // The flush, in the hook's shape: snapshotConversation reads the engine out
    // of the map and yields no snapshot when it is gone, so the queue no-ops.
    const flush = () => {
      const engine = engines.get(activeId)
      return queue.save(activeId, () => engine && { messages: engine.messages },
        (snap, plan) => t.write(activeId, snap, plan), true)
    }
    expect(evictedIds.has(activeId)).toBe(true) // the source guard the hook reads
    await flush()
    expect(t.writes).toHaveLength(0)

    // Non-vacuity for THIS half: the pre-fix cleanup — row deleted, engine
    // still cached, queue untouched — and the identical flush writes the
    // deleted conversation straight back (both write channels are upserts).
    const engines2 = new Map<string, { messages: Msg[]; dispose(): void }>()
    const queue2 = new ConversationSaveQueue<PersistableSnapshot>()
    const t2 = makeTransport()
    engines2.set(activeId, fakeEngine([{ id: 'm_old', text: 'unsaved tail' }]))
    queue2.seed(activeId, { messages: [{ id: 'm_old', text: 'stale' }] })
    await t2.deleteRow(activeId) // the row is gone …
    await queue2.save(activeId, () => ({ messages: (engines2.get(activeId) as { messages: Msg[] }).messages }),
      (snap, plan) => t2.write(activeId, snap, plan), true) // … and it comes back
    expect(t2.deleted).toEqual([activeId])
    expect(t2.writes.map(w => w.convId)).toEqual([activeId])
  })

  it('non-vacuity: the pre-fix eviction shape (no teardown) resurrects through the sweep', async () => {
    // Reconstruct the pre-fix cleanup: removeConversation + fire-and-forget
    // delete, engine left in enginesRef, queue untouched.
    const queue = new ConversationSaveQueue<PersistableSnapshot>()
    const engines = new Map<string, { messages: Msg[]; dispose(): void }>()
    const t = makeTransport()
    const msgs: Msg[] = [{ id: 'd1', text: 'v1' }]
    engines.set('conv_dead', fakeEngine(msgs))
    queue.seed('conv_dead', { messages: [{ id: 'd1', text: 'v0' }] })

    // Pre-fix eviction: delete fired, cache and queue untouched.
    t.deleteRow('conv_dead')

    // The 10s sweep iterates enginesRef — still holding the deleted engine.
    await Promise.all(sweepTick(engines, queue, t.write))
    expect(t.writes.map(w => w.convId)).toContain('conv_dead')
    // Both real write channels are upserts, so this write re-creates the row.
  })
})

// ── Wiring of the helper into the hook ──
// The hook cannot be mounted (node-env vitest), and the guard below is a
// one-line wiring fact no synthetic fixture can reach — the same reason
// tests/pending-approval.test.ts scans the hook's source. Both checks fail
// against the reverted code (guard dropped / helper bypassed).
describe('hook wiring of the teardown (source guard)', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'hooks', 'useConversationPersistence.ts'),
    'utf-8',
  )

  it('auto-cleanup evicts through teardownConversation, not a bare delete IPC', () => {
    expect(src).toContain('await teardownConversation(String(c.key)')
    // The pre-fix shape — delete fired without teardown — must not return.
    expect(src).not.toMatch(/removeConversation\(c\.key\)\s*\n\s*window\.electronAPI\.deleteConversation/)
  })

  it('the old-conversation flush is guarded against ids the cleanup just evicted', () => {
    expect(src).toContain('!evictedIds.has(oldConvId)')
  })

  it('explicit delete and clear-all share the same teardown order', () => {
    const deleteBody = src.slice(src.indexOf('const deleteConversation'), src.indexOf('── Rename'))
    expect(deleteBody).toContain('await teardownConversation(key')
    const clearBody = src.slice(src.indexOf('const clearAllConversations'), src.indexOf('── Toggle pin'))
    expect(clearBody).toContain('await teardownConversation(k')
  })
})
