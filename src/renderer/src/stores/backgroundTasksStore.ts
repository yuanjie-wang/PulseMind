// ── Background-tasks store (PLAN-background-tasks D) ──
// The renderer-side registry of each live session's RUNNING background
// processes, keyed by conversation id, so the floating strip (ChatView's
// navTopSlot) can list task names without threading the session mirror through
// component layers. One writer: useConversationEngine's event fold — a
// tool_status diff that carries backgroundPid upserts a row (the label comes
// off the tool block in the mirror at that same beat), the background_task
// exit event removes it. Nothing here persists: a restart gives every
// conversation a fresh engine, and background processes never survive it
// anyway. Deliberately separate from bgRunningCounts — that map feeds the
// sidebar light (a number per session); this one feeds the panel (rows).

import { create } from 'zustand'

export interface BackgroundTaskRow {
  pid: number
  /** The command's first line, truncated — what the strip and the hover card
   *  show as the task name. Falls back to the tool name when the block carried
   *  no command-shaped input. */
  label: string
  startedAt: number
}

interface BackgroundTasksState {
  byConversation: Record<string, BackgroundTaskRow[]>
  /** Upsert one row per session (dedupe by pid — the same pid's duplicate
   *  diff / replay must not stack rows). */
  upsert: (conversationId: string, row: BackgroundTaskRow) => void
  /** The process exited (background_task exit event): forget the row. */
  remove: (conversationId: string, pid: number) => void
  /** The conversation's mirror was evicted: forget its rows. */
  drop: (conversationId: string) => void
}

const truncate = (text: string, cap: number): string => {
  const first = text.trim().split('\n', 1)[0]
  return first.length > cap ? `${first.slice(0, cap - 1)}…` : first
}

/** The display label for a background task, from the tool block the engine
 *  settled with a backgroundPid. The model-supplied short `name` wins (the
 *  exec manual makes it a requirement for background:true); the raw command
 *  is the fallback, then query, then the tool name. */
export function backgroundTaskLabel(blockInput: unknown, toolName: string): string {
  const input = (blockInput ?? {}) as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name) return truncate(name, 40)
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (command) return truncate(command, 64)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query) return truncate(query, 64)
  return toolName
}

export const useBackgroundTasksStore = create<BackgroundTasksState>()((set) => ({
  byConversation: {},

  upsert: (conversationId, row) =>
    set((s) => {
      const rows = s.byConversation[conversationId] ?? []
      const existing = rows.findIndex((r) => r.pid === row.pid)
      if (existing >= 0) {
        if (rows[existing].label === row.label) return s
        const next = rows.slice()
        next[existing] = row
        return { byConversation: { ...s.byConversation, [conversationId]: next } }
      }
      return { byConversation: { ...s.byConversation, [conversationId]: [...rows, row] } }
    }),

  remove: (conversationId, pid) =>
    set((s) => {
      const rows = s.byConversation[conversationId]
      if (!rows) return s
      const next = rows.filter((r) => r.pid !== pid)
      if (next.length === rows.length) return s
      const byConversation = { ...s.byConversation }
      if (next.length === 0) delete byConversation[conversationId]
      else byConversation[conversationId] = next
      return { byConversation }
    }),

  drop: (conversationId) =>
    set((s) => {
      if (!(conversationId in s.byConversation)) return s
      const next = { ...s.byConversation }
      delete next[conversationId]
      return { byConversation: next }
    }),
}))
