// ── Staged-message queue (暂存区) ──
// Messages the user typed while a turn is running: staged instead of sent,
// drained automatically when the turn ends (see utils/staged-drain.ts for the
// edge rule), or sent immediately by an explicit 立即发送 click, which stops
// the running turn first. One FIFO per conversation; nothing here is persisted
// — a staged message was never sent, so losing it on restart costs nothing.
//
// The store is read by React (the strip in InputArea) and written from three
// non-React paths (the controller's drain effect, the send-now restore, the
// conversation-teardown sweep), so every operation is also a plain function on
// getState(), the takePendingApprovalMode shape.

import { create, type UseBoundStore, type StoreApi } from 'zustand'

export interface StagedMessage {
  id: string
  text: string
  createdAt: string
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

let seq = 0
const newId = (): string => `staged_${Date.now()}_${(seq += 1)}`

/** trim here so a whitespace-only Enter never opens a queue slot the strip
 *  would then render. The buildMessage pass (attachments) runs BEFORE staging,
 *  so text and [file:] markers ride the same string a direct send would use. */
const normalize = (text: string): string => text.trim()

// The explicit annotation breaks the inference cycle: takeHead/takeById read
// `usePendingMessageStore.getState()` inside the initializer, and without it
// the const's type depends on itself (TS7022 → implicit any on every member).
export const usePendingMessageStore: UseBoundStore<StoreApi<PendingMessageState>> = create<PendingMessageState>((set) => ({
  queues: {},
  stage: (convId, text) => {
    const trimmed = normalize(text)
    if (!convId || !trimmed) return null
    const item: StagedMessage = { id: newId(), text: trimmed, createdAt: new Date().toISOString() }
    set((s) => ({ queues: { ...s.queues, [convId]: [...(s.queues[convId] ?? []), item] } }))
    return item
  },
  takeHead: (convId) => {
    const list = usePendingMessageStore.getState().queues[convId]
    if (!list || list.length === 0) return null
    const [head, ...rest] = list
    set((s) => ({ queues: { ...s.queues, [convId]: rest } }))
    return head
  },
  takeById: (convId, id) => {
    const list = usePendingMessageStore.getState().queues[convId]
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
}))

// ── Plain-function accessors for the non-React paths (controller effects) ──

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
