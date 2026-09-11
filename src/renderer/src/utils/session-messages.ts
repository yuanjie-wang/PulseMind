// ── Session message-append application ──
// The main-hosted engine streams message history as `messages_append`
// { fromIndex, items } events. Applying one literally is
// `[...current.slice(0, fromIndex), ...items]`, which is correct for a real
// append but destructive for a no-op: a brand-new session announces itself with
// { fromIndex: 0, items: [] } before its history is hydrated, and a client whose
// mirror is already populated (optimistic hydration from the DB) would truncate
// itself to an empty list. That empty frame unmounts the chat view — the welcome
// screen flashes and the scroll container is recreated at the top.
//
// An append carrying no items conveys nothing, so it must never shrink the
// mirror. Real truncation (regeneration / compaction) is shipped as a full
// `messages` event instead, so this can't swallow one.

/** Applies a `messages_append` payload to the local mirror. */
export function applyMessagesAppend<T>(current: T[], fromIndex: number, items: T[]): T[] {
  if (items.length === 0) return current
  return [...current.slice(0, fromIndex), ...items]
}
