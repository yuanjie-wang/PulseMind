import { describe, expect, it, vi } from 'vitest'
import { ConversationSaveQueue } from '../src/renderer/src/utils/incremental-save'
import type { PersistableSnapshot } from '../src/renderer/src/utils/incremental-save'

/** Conversation-shaped fixture: id + content that can change in place. */
interface Msg { id: string; text?: string; exitCode?: number; status?: string }

function snapshot(msgs: Msg[], summary?: string): PersistableSnapshot & { messages: Msg[] } {
  return { messages: msgs, historySummary: summary }
}

/**
 * Deferred IPC write: every call records its payload and resolves immediately,
 * EXCEPT while held — then the promise parks until release(). Deterministic
 * under microtask flushing: no timers involved.
 */
function deferredWrite() {
  const payloads: Array<Array<{ id: string; text?: string; exitCode?: number; status?: string }>> = []
  const modes: Array<'append' | 'full'> = []
  let held = false
  let parked: Array<() => void> = []
  const write = vi.fn((snap: { messages: Msg[] }, plan: { mode: string; indices?: number[] }) => {
    const effective = plan.mode === 'full'
      ? snap.messages
      : (plan.indices ?? []).map(i => snap.messages[i])
    payloads.push(JSON.parse(JSON.stringify(effective)))
    modes.push(plan.mode === 'full' ? 'full' : 'append')
    if (!held) return Promise.resolve()
    return new Promise<void>(resolve => { parked.push(resolve) })
  })
  return {
    write,
    payloads,
    modes,
    hold: () => { held = true },
    release: () => {
      held = false
      const waiting = parked
      parked = []
      for (const r of waiting) r()
    },
  }
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('ConversationSaveQueue', () => {
  it('same-ID content change is dirty and re-saved in place', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'draft' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    msgs[0].text = 'final'
    await queue.save('c1', () => ({ messages: msgs }), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
    expect(d.payloads[0]).toEqual([{ id: 'm1', text: 'final' }])
  })

  it('an old message more than 8 behind the tail is saved when its content changes', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, text: `t${i}` }))
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    msgs[0].text = 'edited-first-message'
    await queue.save('c1', () => ({ messages: msgs }), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
    // Only the changed message is written, not a tail window.
    expect(d.payloads[0]).toEqual([{ id: 'm0', text: 'edited-first-message' }])
  })

  it('changes arriving while a save is in flight stay dirty and drain after the ack', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    d.hold()
    msgs[0].text = 'v2'
    const first = queue.save('c1', () => ({ messages: msgs }), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
    expect(d.payloads[0]).toEqual([{ id: 'm1', text: 'v2' }])

    // The write has not resolved yet; new content arrives on the live engine.
    msgs[0].text = 'v3'
    void queue.save('c1', () => ({ messages: msgs }), d.write)
    await flushMicrotasks()
    // No second IPC may start while the lane is held.
    expect(d.write).toHaveBeenCalledTimes(1)

    d.release()
    await first
    // After the ack, the newer value is re-dispatched from fresh live data —
    // not the stale in-flight payload.
    expect(d.write).toHaveBeenCalledTimes(2)
    expect(d.payloads[1]).toEqual([{ id: 'm1', text: 'v3' }])
  })

  it('a failed save keeps the snapshot dirty and the retry sends fresh data', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const writes: Array<Array<{ id: string; text?: string }>> = []
    let fail = true
    const write = vi.fn(async (snap: { messages: Msg[] }) => {
      writes.push(JSON.parse(JSON.stringify(snap.messages)))
      if (fail) throw new Error('ipc down')
    })
    msgs[0].text = 'v2'
    await expect(queue.save('c1', () => ({ messages: msgs }), write)).rejects.toThrow('ipc down')
    // A later tick retries with whatever is live now.
    msgs[0].text = 'v3'
    fail = false
    await queue.save('c1', () => ({ messages: msgs }), write)
    expect(write).toHaveBeenCalledTimes(2)
    expect(writes[1]).toEqual([{ id: 'm1', text: 'v3' }])
  })

  it('hydration seeding makes browsing a no-op', async () => {
    const queue = new ConversationSaveQueue()
    const stored = [{ id: 'm1', text: 'persisted', exitCode: 0, status: 'completed' }]
    queue.seed('c1', snapshot(stored))
    const d = deferredWrite()
    // The engine now holds the normalized live shape of the same rows
    // (status re-derived on load) — semantically the persisted data.
    await queue.save('c1', () => snapshot([{ id: 'm1', text: 'persisted', exitCode: 0, status: 'completed' }]), d.write)
    expect(d.write).not.toHaveBeenCalled()
  })

  it('queue order: a queued older snapshot is superseded, never written after newer data', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    d.hold()
    msgs[0].text = 'v2'
    const first = queue.save('c1', () => ({ messages: msgs }), d.write)
    // User switches away: a full save of the same (dirty) content is requested
    // while write #1 is still in flight.
    void queue.save('c1', () => ({ messages: msgs }), d.write, true)
    // The engine appends a new message before the first write resolves.
    msgs.push({ id: 'm2', text: 'v1' })
    d.release()
    await first
    // m1 v2 was acknowledged by write #1. Only m2 is still dirty at
    // dispatch #2; the queued full request then sees no changes to write.
    await flushMicrotasks()
    expect(d.write).toHaveBeenCalledTimes(2)
    expect(d.payloads).toEqual([
      [{ id: 'm1', text: 'v2' }],
      [{ id: 'm2', text: 'v1' }],
    ])
  })

  it('saveSync supersedes queued async work: no async write lands after it, and its baseline holds', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    d.hold()
    msgs[0].text = 'v2'
    const first = queue.save('c1', () => ({ messages: msgs }), d.write)
    // beforeunload: the sync write must be the final value on the channel.
    const sync = vi.fn()
    msgs[0].text = 'v3'
    queue.saveSync('c1', { messages: [{ id: 'm1', text: 'v3' }] }, sync)
    expect(sync).toHaveBeenCalledTimes(1)
    d.release()
    await first
    expect(d.write).toHaveBeenCalledTimes(1)
    // The epoch bump also stops the held write's completion from acking its
    // stale payload: a subsequent save still sees the message as dirty.
    const d2 = deferredWrite()
    await queue.save('c1', () => ({ messages: [{ id: 'm1', text: 'v3' }] }), d2.write)
    expect(d2.write).not.toHaveBeenCalled()
    msgs[0].text = 'v4'
    await queue.save('c1', () => ({ messages: msgs }), d2.write)
    expect(d2.write).toHaveBeenCalledTimes(1)
    expect(d2.payloads[0]).toEqual([{ id: 'm1', text: 'v4' }])
  })

  it('reverting to baseline mid-lane still sync-writes to supersede the in-flight IPC', () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    d.hold()
    msgs[0].text = 'v2'
    void queue.save('c1', () => ({ messages: msgs }), d.write)
    // User edits back to the persisted value before the write resolves.
    msgs[0].text = 'v1'
    const sync = vi.fn()
    queue.saveSync('c1', { messages: [{ id: 'm1', text: 'v1' }] }, sync)
    expect(sync).toHaveBeenCalledTimes(1)
    d.release()
  })

  it('forget cancels queued work and awaits the in-flight write before the row is deleted', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    d.hold()
    msgs[0].text = 'v2'
    void queue.save('c1', () => ({ messages: msgs }), d.write)
    let deleted = false
    const forgetThenDelete = queue.forget('c1').then(() => { deleted = true })
    await flushMicrotasks()
    expect(deleted).toBe(false)
    d.release()
    await forgetThenDelete
    expect(deleted).toBe(true)
    // The lane is gone: a subsequent save starts from an empty baseline and
    // re-writes everything (harmless after deletion) rather than acking stale.
    const d2 = deferredWrite()
    await queue.save('c1', () => ({ messages: [{ id: 'm1', text: 'v2' }] }), d2.write)
    expect(d2.write).toHaveBeenCalledTimes(1)
    expect(d2.modes[0]).toBe('append')
  })

  it('failed-write retry after supersession does not resurrect an older payload', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = [{ id: 'm1', text: 'v1' }]
    queue.seed('c1', snapshot(msgs))
    const writes: Array<Array<{ id: string; text?: string }>> = []
    let failFrom = 2 // write #1 succeeds, the drain's fresh re-write (#2) fails
    const write = vi.fn(async (snap: { messages: Msg[] }) => {
      writes.push(JSON.parse(JSON.stringify(snap.messages)))
      if (writes.length >= failFrom) throw new Error('boom')
    })
    // Write #1 (v2) is in flight and will succeed.
    msgs[0].text = 'v2'
    const first = queue.save('c1', () => ({ messages: msgs }), write).catch(() => {})
    // v3 lands while v2 is in flight; the drain retries with FRESH live data
    // (v3), which fails (write #2) and must stay dirty — never replay v2.
    msgs[0].text = 'v3'
    await first
    failFrom = 99
    await queue.save('c1', () => ({ messages: msgs }), write)
    expect(writes[0]).toEqual([{ id: 'm1', text: 'v2' }])
    expect(writes.slice(1).every(w => w[0].text === 'v3')).toBe(true)
  })

  it('empty/no-read snapshots and no-change saves never call the transport', async () => {
    const queue = new ConversationSaveQueue()
    const d = deferredWrite()
    await queue.save('c1', () => undefined, d.write)
    await queue.save('c1', () => ({ messages: [] }), d.write)
    expect(d.write).not.toHaveBeenCalled()
  })

  it('history summary change alone is dirty', async () => {
    const queue = new ConversationSaveQueue()
    queue.seed('c1', snapshot([{ id: 'm1', text: 'same' }], 'old summary'))
    const d = deferredWrite()
    await queue.save('c1', () => snapshot([{ id: 'm1', text: 'same' }], 'new summary'), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
  })

  it('a summary revert alone forces the full path (upsert-only DB cannot remove rows)', async () => {
    const queue = new ConversationSaveQueue()
    queue.seed('c1', snapshot([{ id: 'm1' }, { id: 'm2' }], 'summary'))
    const d = deferredWrite()
    await queue.save('c1', () => snapshot([{ id: 'm1' }], 'summary'), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
    expect(d.modes[0]).toBe('full')
  })

  it('saves serialize per conversation, never across conversations', async () => {
    const queue = new ConversationSaveQueue()
    const a = [{ id: 'a1', text: 'v1' }]
    const b = [{ id: 'b1', text: 'v1' }]
    queue.seed('c1', snapshot(a))
    queue.seed('c2', snapshot(b))
    const held = deferredWrite()
    const free = deferredWrite()
    held.hold()
    a[0].text = 'v2'
    b[0].text = 'v2'
    const heldSave = queue.save('c1', () => ({ messages: a }), held.write)
    // A slow c1 write must not block c2's lane.
    await queue.save('c2', () => ({ messages: b }), free.write)
    expect(free.write).toHaveBeenCalledTimes(1)
    expect(free.payloads[0]).toEqual([{ id: 'b1', text: 'v2' }])
    held.release()
    await heldSave
    expect(held.write).toHaveBeenCalledTimes(1)
  })

  it('content-dirty append excludes unchanged messages even when newer ones exist', async () => {
    const queue = new ConversationSaveQueue()
    const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: `t${i}` }))
    queue.seed('c1', snapshot(msgs))
    const d = deferredWrite()
    // An edit at index 0 AND two new messages: exactly those three are written.
    msgs[0].text = 'edited'
    msgs.push({ id: 'm12', text: 't12' }, { id: 'm13', text: 't13' })
    await queue.save('c1', () => ({ messages: msgs }), d.write)
    expect(d.write).toHaveBeenCalledTimes(1)
    expect(d.payloads[0].map(m => m.id)).toEqual(['m0', 'm12', 'm13'])
  })
})
