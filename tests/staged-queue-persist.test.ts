// ── Staged-queue persistence (B2) ──
// The queue outlives the app (zustand persist → localStorage), and a row that
// comes back from disk must NOT auto-send: the turn it was waiting for ended
// before the app closed, so that edge is no longer evidence of intent. These
// cases pin the promises that decision rests on — only the queues are
// persisted, everything read back is marked `restored`, and nothing from
// localStorage reaches the live queue unchecked — plus the drain guard that
// makes the flag mean anything at all.

import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { peekStagedHead, restoreStaged, takeStagedHead, usePendingMessageStore } from '../src/renderer/src/stores/pendingMessageStore'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const STORAGE_KEY = 'pulsemind-staged-messages'

/** persist exposes the storage it was built with. Under vitest there is no
 *  window, so that is the module-scoped Map inside pendingMessageStore — the
 *  same durability seam a restart crosses, reached without a browser. */
const disk = usePendingMessageStore.persist.getOptions().storage as unknown as {
  getItem: (name: string) => unknown
  setItem: (name: string, value: unknown) => unknown
  removeItem: (name: string) => unknown
}

const queuesOf = (): Record<string, Array<Record<string, unknown>>> =>
  usePendingMessageStore.getState().queues as unknown as Record<string, Array<Record<string, unknown>>>

const row = (id: string, text: string): Record<string, unknown> => ({ id, text, createdAt: '2026-11-17T00:00:00.000Z' })

/** Empty on disk and in memory, so every case starts from a cold queue. */
async function reset(): Promise<void> {
  usePendingMessageStore.getState().clearAll()
  await disk.removeItem(STORAGE_KEY)
}

/** Write a blob and pull it back through the real merge path — the closest a
 *  node test gets to "the app restarted". */
async function restartWith(persisted: unknown): Promise<void> {
  await disk.setItem(STORAGE_KEY, persisted)
  await usePendingMessageStore.persist.rehydrate()
}

beforeEach(reset)

describe('what reaches localStorage', () => {
  it('persists the queues and nothing else', async () => {
    usePendingMessageStore.getState().stage('conv1', '  hello  ')
    const raw = (await disk.getItem(STORAGE_KEY)) as { state?: Record<string, unknown> }
    expect(raw.state).toBeDefined()
    // partialize is the only thing keeping the operations out of the blob; a
    // function would be dropped silently by JSON, so a key list is the check.
    expect(Object.keys(raw.state ?? {})).toEqual(['queues'])
    expect(raw.state?.queues).toMatchObject({ conv1: [{ text: 'hello' }] })
  })

  it('leaves a live row unmarked — restored is only what disk hands back', () => {
    usePendingMessageStore.getState().stage('conv1', 'fresh')
    expect(queuesOf().conv1?.[0]?.restored).toBeUndefined()
  })
})

describe('what comes back from disk', () => {
  it('marks every restored row, so the drain leaves it alone', async () => {
    await restartWith({ state: { queues: { conv1: [row('staged_1', 'from last session')] } }, version: 1 })
    expect(peekStagedHead('conv1')?.text).toBe('from last session')
    expect(peekStagedHead('conv1')?.restored).toBe(true)
  })

  it('drops rows localStorage could not have produced', async () => {
    await restartWith({
      state: {
        queues: {
          kept: [row('a', 'ok')],
          emptyId: [{ id: '', text: 'no id', createdAt: 't' }],
          wrongText: [{ id: 'b', text: 42, createdAt: 't' }],
          notAList: 'nope',
          nothingValid: [{ id: 'c' }],
        },
      },
      version: 1,
    })
    // The empty-id row is the one that matters: it would render a strip item no
    // remove() could ever match, i.e. a row stuck until the app is killed.
    expect(Object.keys(queuesOf())).toEqual(['kept'])
    expect(queuesOf().kept?.[0]).toMatchObject({ id: 'a', restored: true })
  })

  it('leaves the live queue alone when the blob is not a queue map', async () => {
    usePendingMessageStore.getState().stage('live', 'still here')
    await restartWith(null)
    expect(queuesOf().live?.[0]?.text).toBe('still here')
    await restartWith({ state: { queues: 'nope' }, version: 1 })
    expect(queuesOf().live?.[0]?.text).toBe('still here')
  })
})

describe('the restored flag survives a failed send', () => {
  it('a send that never left goes back still marked', async () => {
    await restartWith({ state: { queues: { conv1: [row('r1', 'old')] } }, version: 1 })
    const head = peekStagedHead('conv1')
    expect(head?.restored).toBe(true)
    // The drain refuses this row; an explicit click takes it, the send bails,
    // and the restore must not launder it into an auto-sendable row.
    const taken = takeStagedHead('conv1')
    expect(taken).not.toBeNull()
    if (!taken) return
    restoreStaged('conv1', taken, 0)
    expect(peekStagedHead('conv1')?.restored).toBe(true)
  })
})

describe('peeking before taking', () => {
  it('peek does not consume the head', () => {
    usePendingMessageStore.getState().stage('conv1', 'one')
    expect(peekStagedHead('conv1')?.text).toBe('one')
    expect(peekStagedHead('conv1')?.text).toBe('one')
    expect(takeStagedHead('conv1')?.text).toBe('one')
    expect(peekStagedHead('conv1')).toBeNull()
  })

  it('the drain effect peeks, judges, and only then takes', () => {
    const src = read('src', 'renderer', 'src', 'hooks', 'useChatController.ts')
    // Names verified against the effect itself (2026-11-17). Order is the whole
    // point: judged after the take, a restored row is already out of the queue
    // by the time it is refused — the message is lost, not withheld.
    const peekAt = src.indexOf('const head = peekStagedHead(convId)')
    const guardAt = src.indexOf('if (!head || head.restored) return')
    const takeAt = src.indexOf('const item = takeStagedHead(convId)')
    expect(peekAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(peekAt)
    expect(takeAt).toBeGreaterThan(guardAt)
  })
})

describe('the strip says why a restored row is not moving', () => {
  it('renders a dedicated hint for a restored head, in both locales', () => {
    const area = read('src', 'renderer', 'src', 'components', 'chat', 'InputArea.tsx')
    expect(area).toContain('stagedQueue?.[0]?.restored')
    expect(area).toContain('chatView.staged.hintRestored')
    for (const locale of ['zh.ts', 'en.ts']) {
      const src = read('src', 'renderer', 'src', 'i18n', 'locales', locale)
      expect(src).toContain('hintRestored:')
    }
  })
})
