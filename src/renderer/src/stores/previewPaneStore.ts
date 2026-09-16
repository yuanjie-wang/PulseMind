// ── Preview pane store (PLAN-preview-pane §设计2) ──
// Renderer-local state for the workbench's file tab (PLAN-workbench W7):
// tab strips scoped per conversation (switching away and back restores them)
// and per-path reload ticks the content components watch to re-read a changed
// file. Pane visibility and width live in workbenchStore — opening the first
// tab of a conversation brings the workbench up on the files tab, and closing
// the last one folds it back (WorkBuddy-style). Tab-list mutations live in
// preview-tabs.ts (pure, unit-tested).

import { create } from 'zustand'
import { openTabInList, closeTabInList, type PreviewTab } from './preview-tabs'
import { resolvePreviewPath } from '../../../shared/preview/file-kind'
import { useWorkbenchStore } from './workbenchStore'

/** Key for conversations that have no id yet (new-task draft). */
export const DRAFT_CONVERSATION_KEY = '__draft__'

/** Per-conversation tab maps kept by recency (insertion order); LRU cap. */
const MAX_CONVERSATION_MAPS = 10

interface PreviewPaneState {
  activeConversationId: string | null
  /** Resolved working directory of the conversation currently on screen —
   *  entry points resolve tool-relative paths against it before opening. */
  workspaceDir: string | null
  tabsByConversation: Record<string, PreviewTab[]>
  /** path of the active tab per conversation */
  activeByConversation: Record<string, string | null>
  /** path → bump counter; content components re-read when it changes */
  reloadTicks: Record<string, number>
  openFile: (conversationId: string | null, path: string) => void
  closeTab: (conversationId: string | null, path: string) => void
  setActive: (conversationId: string | null, path: string) => void
  setWorkspaceDir: (dir: string | null) => void
  switchConversation: (conversationId: string | null) => void
  bumpReload: (path: string) => void
  forgetConversation: (conversationId: string) => void
}

const convKey = (id: string | null) => id ?? DRAFT_CONVERSATION_KEY

export const usePreviewPaneStore = create<PreviewPaneState>()((set, get) => ({
  activeConversationId: null,
  workspaceDir: null,
  tabsByConversation: {},
  activeByConversation: {},
  reloadTicks: {},

  openFile: (conversationId, path) => {
    const key = convKey(conversationId)
    const tabs = openTabInList(get().tabsByConversation[key] ?? [], path)
    set((s) => ({
      activeConversationId: key,
      tabsByConversation: touch(s.tabsByConversation, key, tabs),
      activeByConversation: { ...s.activeByConversation, [key]: path },
    }))
    useWorkbenchStore.getState().openTab(key, 'files')
  },

  closeTab: (conversationId, path) => {
    const key = convKey(conversationId)
    const tabs = get().tabsByConversation[key] ?? []
    const activePath = get().activeByConversation[key] ?? null
    const result = closeTabInList(tabs, path, activePath)
    set((s) => ({
      tabsByConversation: { ...s.tabsByConversation, [key]: result.tabs },
      ...(result.nextActive !== undefined
        ? { activeByConversation: { ...s.activeByConversation, [key]: result.nextActive } }
        : {}),
    }))
    // Last tab gone → fold the workbench back, but only when the user is
    // looking at the files tab (closing a background conversation's tab must
    // not yank the pane away from plan/browser).
    if (result.tabs.length === 0 && useWorkbenchStore.getState().activeTab === 'files') {
      useWorkbenchStore.getState().setOpen(key, false)
    }
  },

  setActive: (conversationId, path) => {
    const key = convKey(conversationId)
    set((s) => ({ activeByConversation: { ...s.activeByConversation, [key]: path } }))
  },

  setWorkspaceDir: (dir) => set({ workspaceDir: dir }),

  switchConversation: (conversationId) => {
    const key = convKey(conversationId)
    if (get().activeConversationId === key) return
    set((s) => {
      const existing = s.tabsByConversation[key]
      // Only conversations holding tabs occupy LRU slots.
      return {
        activeConversationId: key,
        tabsByConversation: existing !== undefined ? touch(s.tabsByConversation, key, existing) : s.tabsByConversation,
      }
    })
  },

  bumpReload: (path) =>
    set((s) => ({ reloadTicks: { ...s.reloadTicks, [path]: (s.reloadTicks[path] ?? 0) + 1 } })),

  forgetConversation: (conversationId) =>
    set((s) => ({
      tabsByConversation: Object.fromEntries(Object.entries(s.tabsByConversation).filter(([k]) => k !== conversationId)),
      activeByConversation: Object.fromEntries(Object.entries(s.activeByConversation).filter(([k]) => k !== conversationId)),
    })),
}))

/** Re-insert a conversation's tab list as most-recently-used, then prune
 *  beyond the LRU cap (insertion order = recency order). */
function touch(map: Record<string, PreviewTab[]>, key: string, tabs: PreviewTab[]): Record<string, PreviewTab[]> {
  const entries = Object.entries(map).filter(([k]) => k !== key)
  entries.push([key, tabs])
  return Object.fromEntries(entries.slice(entries.length - MAX_CONVERSATION_MAPS))
}

/** Entry point for chat-side previews (tool cards, file chips): resolves
 *  tool-relative paths against the on-screen conversation's workspace and
 *  opens in the active conversation's tab strip. */
export function openInPreviewPane(rawPath: string): void {
  const s = usePreviewPaneStore.getState()
  s.openFile(s.activeConversationId, resolvePreviewPath(rawPath, s.workspaceDir))
}
