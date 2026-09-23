// ── The staged-message queue (暂存区) ──
// The queue's semantics are the whole delivery guarantee of the feature: a
// message staged mid-turn must arrive exactly once, in order, or come back to
// exactly where it was when its send never left. The store is plain zustand
// (no React), so every operation runs for real here.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  usePendingMessageStore,
  takeStagedHead,
  restoreStaged,
  clearStagedMessages,
  clearAllStagedMessages,
} from '../src/renderer/src/stores/pendingMessageStore'

const stage = (convId: string, text: string) =>
  usePendingMessageStore.getState().stage(convId, text)
const queue = (convId: string) => usePendingMessageStore.getState().queues[convId] ?? []

beforeEach(() => {
  clearAllStagedMessages()
})

describe('stage', () => {
  it('starts with no queue for a conversation', () => {
    expect(queue('conv_a')).toEqual([])
    expect(usePendingMessageStore.getState().queues['conv_a']).toBeUndefined()
  })

  it('appends in FIFO order', () => {
    stage('conv_a', 'first')
    stage('conv_a', 'second')
    stage('conv_a', 'third')
    expect(queue('conv_a').map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('refuses blank text — a whitespace Enter never opens a slot', () => {
    expect(stage('conv_a', '   ')).toBeNull()
    expect(stage('conv_a', '')).toBeNull()
    expect(queue('conv_a')).toEqual([])
  })

  it('refuses a blank conversation id', () => {
    expect(stage('', 'hello')).toBeNull()
    expect(usePendingMessageStore.getState().queues).toEqual({})
  })

  it('trims the stored text', () => {
    const item = stage('conv_a', '  hello  ')
    expect(item?.text).toBe('hello')
  })

  it('mints a unique id per stage (same text twice = two rows)', () => {
    const a = stage('conv_a', 'same')
    const b = stage('conv_a', 'same')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.id).not.toBe(b!.id)
    expect(queue('conv_a')).toHaveLength(2)
  })

  it('keeps conversations isolated — one FIFO per convId', () => {
    stage('conv_a', 'a1')
    stage('conv_b', 'b1')
    stage('conv_a', 'a2')
    expect(queue('conv_a').map((m) => m.text)).toEqual(['a1', 'a2'])
    expect(queue('conv_b').map((m) => m.text)).toEqual(['b1'])
  })
})

describe('takeHead (the auto-send drain)', () => {
  it('pops the head, not the tail', () => {
    stage('conv_a', 'first')
    stage('conv_a', 'second')
    expect(takeStagedHead('conv_a')?.text).toBe('first')
    expect(queue('conv_a').map((m) => m.text)).toEqual(['second'])
  })

  it('is atomic: a second take sees the next message (double-fire cannot send twice)', () => {
    stage('conv_a', 'only')
    expect(takeStagedHead('conv_a')?.text).toBe('only')
    expect(takeStagedHead('conv_a')).toBeNull()
    expect(queue('conv_a')).toEqual([])
  })

  it('is null on an unknown or empty conversation', () => {
    expect(takeStagedHead('never_seen')).toBeNull()
    stage('conv_a', 'x')
    takeStagedHead('conv_a')
    expect(takeStagedHead('conv_a')).toBeNull()
  })
})

describe('takeById + restore (the 立即发送 round-trip)', () => {
  it('reports the original index so a failed send restores in place', () => {
    stage('conv_a', 'one')
    stage('conv_a', 'two')
    stage('conv_a', 'three')
    const mid = queue('conv_a')[1]

    const taken = usePendingMessageStore.getState().takeById('conv_a', mid.id)
    expect(taken).not.toBeNull()
    expect(taken!.item.text).toBe('two')
    expect(taken!.index).toBe(1)
    expect(queue('conv_a').map((m) => m.text)).toEqual(['one', 'three'])

    restoreStaged('conv_a', taken!.item, taken!.index)
    expect(queue('conv_a').map((m) => m.text)).toEqual(['one', 'two', 'three'])
  })

  it('restore is idempotent by id — a racing re-stage cannot duplicate the row', () => {
    const item = stage('conv_a', 'one')!
    restoreStaged('conv_a', item, 0)
    restoreStaged('conv_a', item, 0)
    expect(queue('conv_a')).toHaveLength(1)
  })

  it('restore clamps the index (rows deleted while the send was in flight)', () => {
    stage('conv_a', 'a')
    stage('conv_a', 'b')
    const late = stage('conv_b', 'late')! // staged elsewhere, restored here
    restoreStaged('conv_a', late, 99)
    expect(queue('conv_a').map((m) => m.text)).toEqual(['a', 'b', 'late'])
    // index 0 also works when the queue was emptied meanwhile
    const item = queue('conv_a')[0]
    takeStagedHead('conv_a')
    takeStagedHead('conv_a')
    takeStagedHead('conv_a')
    restoreStaged('conv_a', item, 0)
    expect(queue('conv_a').map((m) => m.text)).toEqual(['a'])
  })

  it('takeById is null for an unknown id or unknown conversation', () => {
    stage('conv_a', 'one')
    expect(usePendingMessageStore.getState().takeById('conv_a', 'nope')).toBeNull()
    expect(usePendingMessageStore.getState().takeById('never_seen', 'nope')).toBeNull()
  })
})

describe('remove / clear (the strip and teardown)', () => {
  it('remove drops exactly that row', () => {
    stage('conv_a', 'one')
    const two = stage('conv_a', 'two')!
    stage('conv_a', 'three')
    usePendingMessageStore.getState().remove('conv_a', two.id)
    expect(queue('conv_a').map((m) => m.text)).toEqual(['one', 'three'])
  })

  it('clear drops only the target conversation (delete sweep)', () => {
    stage('conv_a', 'a')
    stage('conv_b', 'b')
    clearStagedMessages('conv_a')
    expect(queue('conv_a')).toEqual([])
    expect(queue('conv_b').map((m) => m.text)).toEqual(['b'])
  })

  it('clear of an unknown conversation is a no-op', () => {
    stage('conv_a', 'a')
    clearStagedMessages('never_seen')
    expect(queue('conv_a')).toHaveLength(1)
  })

  it('clearAll wipes every queue (clear-all-conversations sweep)', () => {
    stage('conv_a', 'a')
    stage('conv_b', 'b')
    clearAllStagedMessages()
    expect(usePendingMessageStore.getState().queues).toEqual({})
  })
})
