// ── Staged-message queue (暂存区) ──
// Messages the user typed while a turn is running: staged instead of sent,
// drained automatically when the turn ends (see utils/staged-drain.ts for the
// edge rule), or sent immediately by an explicit 立即发送 click, which stops
// the running turn first. One FIFO per conversation.
//
// The queue survives a restart (zustand persist → localStorage), but a restored
// row does NOT auto-send: the turn it was waiting for ended before the app
// closed, so that edge is no longer evidence of the user's intent — firing it
// would execute a decision made in a previous session (user decision
// 2026-11-17). A restored row leaves only by an explicit click. It still blocks
// the queue head: FIFO order is the queue's core invariant, so skipping it
// would deliver a younger message ahead of an older one.
//
// The store is read by React (the strip in InputArea) and written from three
// non-React paths (the controller's drain effect, the send-now restore, the
// conversation-teardown sweep), so every operation is also a plain function on
// getState(), the takePendingApprovalMode shape.

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface StagedMessage {
  id: string
  text: string
  createdAt: string
  /** Came back from disk after a restart: the auto-drain must leave it alone.
   *  Absent on anything staged in this session. */
  restored?: true
}

interface PendingMessageState {
  /** FIFO per conversation id; an absent key is an empty queue. */
  queues: Record<string, StagedMessage[]>
  /** Append to a conversation's queue. Blank text is not worth a slot. */
  stage: (convId: string, text: string) => StagedMessage | null
  /** Pop the head — the auto-send drain. Atomic: a second call sees the next
   *  message (or null), so a double-fired effect cannot send twice. */
  takeHead: (convId: string) => StagedMessage | null
  /** Remove by id, returning the item and its index so a failed send can be
   *  restored in place (send-now jumps the queue by user choice; a send that
   *  never left must not lose its slot). */
  takeById: (convId: string, id: string) => { item: StagedMessage; index: number } | null
  /** Re-insert a failed send at its previous position (clamped — rows may have
   *  been deleted while the send was in flight). */
  restore: (convId: string, item: StagedMessage, index: number) => void
  remove: (convId: string, id: string) => void
  /** Drop a conversation's queue (deletion / clear-all teardown). */
  clear: (convId: string) => void
  clearAll: () => void
}

/** Only `queues` is durable — the operations are recreated by the initializer,
 *  and persisting them would serialise functions to null. */
type PersistedStaged = Pick<PendingMessageState, 'queues'>

const STORAGE_KEY = 'pulsemind-staged-messages'

/** localStorage is absent under vitest (`environment: 'node'`) and can be full
 *  in a browser, so neither end is trusted. In node a module-scoped Map stands
 *  in: returning an undefined storage would make every set log "the given
 *  storage is currently unavailable" — thousands of lines across a full run,
 *  each reading like a real failure. vitest isolates module graphs per file, so
 *  the Map starts empty for every test file and behaves exactly like the plain
 *  in-memory store the queue tests were written against. In a browser a failing
 *  setItem must not reach the caller either: an exhausted quota costs the
 *  restart copy, not the ability to stage. */
const memoryStorage = new Map<string, string>()

const stagedStorage = createJSONStorage<PersistedStaged>(() => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      getItem: (key: string): string | null => memoryStorage.get(key) ?? null,
      setItem: (key: string, value: string): void => void memoryStorage.set(key, value),
      removeItem: (key: string): void => void memoryStorage.delete(key),
    }
  }
  return {
    getItem: (key: string): string | null => {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key: string, value: string): void => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* quota exceeded — the in-memory queue keeps working */
      }
    },
    removeItem: (key: string): void => {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* already gone is the same outcome */
      }
    },
  }
})

/** localStorage is user-writable and outlives code changes, so nothing from it
 *  re-enters the queue unchecked. `restored: true` is what the drain effect
 *  keys on to withhold the automatic send. */
function isStagedMessage(value: unknown): value is StagedMessage {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' && row.id.length > 0 && typeof row.text === 'string' && typeof row.createdAt === 'string'
  )
}

/** Whole-queue replacement, not a per-row merge: `restored` wins and whatever
 *  `current` holds for that conversation is discarded. That is only safe because
 *  the storage below reads SYNCHRONOUSLY (localStorage), so hydrate has already
 *  landed before the UI can stage anything. Moving this store to an async
 *  storage (main-process IPC, IndexedDB) would let hydrate arrive AFTER the user
 *  staged a message and silently overwrite that fresh queue — such a move must
 *  merge per conversation id instead of returning `restored` outright. */
function mergePersisted(persisted: unknown, current: PendingMessageState): PendingMessageState {
  if (typeof persisted !== 'object' || persisted === null) return current
  const queues = (persisted as { queues?: unknown }).queues
  if (typeof queues !== 'object' || queues === null) return current
  const restored: Record<string, StagedMessage[]> = {}
  for (const [convId, raw] of Object.entries(queues as Record<string, unknown>)) {
    if (!convId || !Array.isArray(raw)) continue
    const rows = raw.filter(isStagedMessage).map((m) => ({ ...m, restored: true as const }))
    if (rows.length > 0) restored[convId] = rows
  }
  return { ...current, queues: restored }
}

let seq = 0
const newId = (): string => `staged_${Date.now()}_${(seq += 1)}`

/** trim here so a whitespace-only Enter never opens a queue slot the strip
 *  would then render. The buildMessage pass (attachments) runs BEFORE staging,
 *  so text and [file:] markers ride the same string a direct send would use. */
const normalize = (text: string): string => text.trim()

// `get` — the StateCreator's own reader — replaces the
// `usePendingMessageStore.getState()` calls the initializer used to make. That
// self-reference made the const's type depend on itself (TS7022 → implicit any
// on every member) and forced an explicit UseBoundStore annotation, which would
// also strip persist's `.persist` API off the type. persist() has to arrive
// through the curried create<T>()(…) form for the middleware's types to reach
// the store at all.
export const usePendingMessageStore = create<PendingMessageState>()(
  persist(
    (set, get) => ({
      queues: {},
      stage: (convId, text) => {
        const trimmed = normalize(text)
        if (!convId || !trimmed) return null
        const item: StagedMessage = { id: newId(), text: trimmed, createdAt: new Date().toISOString() }
        set((s) => ({ queues: { ...s.queues, [convId]: [...(s.queues[convId] ?? []), item] } }))
        return item
      },
      takeHead: (convId) => {
        const list = get().queues[convId]
        if (!list || list.length === 0) return null
        const [head, ...rest] = list
        set((s) => ({ queues: { ...s.queues, [convId]: rest } }))
        return head
      },
      takeById: (convId, id) => {
        const list = get().queues[convId]
        if (!list) return null
        const index = list.findIndex((m) => m.id === id)
        if (index < 0) return null
        const item = list[index]
        set((s) => ({ queues: { ...s.queues, [convId]: list.filter((m) => m.id !== id) } }))
        return { item, index }
      },
      restore: (convId, item, index) => {
        set((s) => {
          const list = s.queues[convId] ?? []
          // idempotent: a restore that races a user's own re-stage of the same
          // text must not duplicate the same item.
          if (list.some((m) => m.id === item.id)) return s
          const at = Math.max(0, Math.min(index, list.length))
          return { queues: { ...s.queues, [convId]: [...list.slice(0, at), item, ...list.slice(at)] } }
        })
      },
      remove: (convId, id) => {
        set((s) => {
          const list = s.queues[convId]
          if (!list) return s
          return { queues: { ...s.queues, [convId]: list.filter((m) => m.id !== id) } }
        })
      },
      clear: (convId) => {
        set((s) => {
          if (!(convId in s.queues)) return s
          const queues = { ...s.queues }
          delete queues[convId]
          return { queues }
        })
      },
      clearAll: () => set({ queues: {} }),
    }),
    {
      name: STORAGE_KEY,
      // Nothing was ever written under version 0 (persistence is new), so no
      // migrate is owed yet; the field is here to make the next format change a
      // one-line edit instead of a lost-queue surprise.
      version: 1,
      storage: stagedStorage,
      partialize: (s): PersistedStaged => ({ queues: s.queues }),
      merge: mergePersisted,
    },
  ),
)

// ── Plain-function accessors for the non-React paths (controller effects) ──

/** Peek the head WITHOUT taking it. The drain effect must know whether the head
 *  is a restored row *before* popping: taking it and giving it back would reopen
 *  the take/restore window the atomic pop exists to close. */
export function peekStagedHead(convId: string): StagedMessage | null {
  return usePendingMessageStore.getState().queues[convId]?.[0] ?? null
}

/** The auto-send drain: pop the head, or null when nothing is staged. */
export function takeStagedHead(convId: string): StagedMessage | null {
  return usePendingMessageStore.getState().takeHead(convId)
}

/** Put a drained message back where it was (its send never left — parse bail,
 *  missing API key, …), so the queue keeps its order. */
export function restoreStaged(convId: string, item: StagedMessage, index: number): void {
  usePendingMessageStore.getState().restore(convId, item, index)
}

/** Teardown sweep so a deleted conversation's queue cannot leak its slot. */
export function clearStagedMessages(convId: string): void {
  usePendingMessageStore.getState().clear(convId)
}

export function clearAllStagedMessages(): void {
  usePendingMessageStore.getState().clearAll()
}
