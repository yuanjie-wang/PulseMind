// PLAN-long-task-perf M3-T1 — the save queue materializes on write, not on
// dispatch. The old eager `JSON.parse(JSON.stringify(snapshot))` cloned the
// whole session before the dirty check could answer 'none' (the C1 hotspot);
// the queue now fingerprints live data and hands the live snapshot to the
// write (the IPC bridge clones synchronously at invoke). These tests pin the
// new shape; the contract tests (ack-only-written-bytes, epoch, drain, teardown
// ordering) live in incremental-save / conversation-save-queue /
// teardown-conversation-lifecycle and stay green untouched.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { ConversationSaveQueue } from '../src/renderer/src/utils/incremental-save'

interface Snap {
  messages: Array<{ id: string; text: string }>
  historySummary?: string
}

const snap = (id: string, n: number): Snap => ({
  messages: Array.from({ length: n }, (_, i) => ({ id: `${id}-m${i}`, text: 'x'.repeat(100) })),
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('save queue materialization (M3-T1)', () => {
  it('append save: no clone on the dispatch path (JSON.parse never runs), and the write sees the live messages', async () => {
    const queue = new ConversationSaveQueue<Snap>()
    const live = snap('a', 5)
    queue.seed('c1', live)
    const next = { messages: [...live.messages, { id: 'a-m5', text: 'new' }] }
    let seen: Snap | undefined
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await queue.save('c1', () => next, async (snapshot, plan) => {
        seen = snapshot
        expect(plan.mode).toBe('append')
        // dirty indices select from the LIVE array — same references, no copy
        for (const i of (plan as { indices: number[] }).indices) {
          expect(next.messages.includes(snapshot.messages[i])).toBe(true)
        }
      })
    } finally {
      parse.mockRestore()
    }
    expect(seen).toBe(next) // the live snapshot itself, not a clone
    expect(parse).not.toHaveBeenCalled()
  })

  it('clean dispatch: the dirty check answers none without cloning anything', async () => {
    const queue = new ConversationSaveQueue<Snap>()
    const live = snap('b', 4)
    queue.seed('c2', live)
    const write = vi.fn()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await queue.save('c2', () => live, write)
      expect(write).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('full save: the write receives the live snapshot (the clone stays gone on the forced path too)', async () => {
    const queue = new ConversationSaveQueue<Snap>()
    const live = snap('c', 3)
    let seen: Snap | undefined
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await queue.save('c3', () => live, async (snapshot) => { seen = snapshot }, true)
    } finally {
      parse.mockRestore()
    }
    expect(seen).toBe(live)
    expect(parse).not.toHaveBeenCalled()
  })
})
