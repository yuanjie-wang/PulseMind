// ── Preview pane store (PLAN-preview-pane §设计2) ──
// Renderer-local state for the chat's right-hand file preview pane: tab
// strip scoped per conversation (switching away and back restores it),
// pane width (persisted to localStorage — unlike the browser pane there is
// no main-process dock that would need settings.json), and per-path reload
// ticks the content components watch to re-read a changed file. Tab-list
// mutations live in preview-tabs.ts (pure, unit-tested).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { openTabInList, closeTabInList, type PreviewTab } from './preview-tabs'
import { resolvePreviewPath } from '../../../shared/preview/file-kind'

/** Key for conversations that have no id yet (new-task draft). */
export const DRAFT_CONVERSATION_KEY = '__draft__'

/** Per-conversation tab maps kept by recency (insertion order); LRU cap. */
const MAX_CONVERSATION_MAPS = 10

export const DEFAULT_PREVIEW_WIDTH = 440

interface PreviewPaneState {
  open: boolean
  width: number
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
  setWidth: (width: number) => void
  setOpen: (open: boolean) => void
  setWorkspaceDir: (dir: string | null) => void
  switchConversation: (conversationId: string | null) => void
  bumpReload: (path: string) => void
  forgetConversation: (conversationId: string) => void
}

const convKey = (id: string | null) => id ?? DRAFT_CONVERSATION_KEY

export const usePreviewPaneStore = create<PreviewPaneState>()(
  persist(
    (set, get) => ({
      open: false,
      width: DEFAULT_PREVIEW_WIDTH,
      activeConversationId: null,
      workspaceDir: null,
      tabsByConversation: {},
      activeByConversation: {},
      reloadTicks: {},

      setWorkspaceDir: (dir) => set({ workspaceDir: dir }),

      openFile: (conversationId, path) => {
        const key = convKey(conversationId)
        const tabs = openTabInList(get().tabsByConversation[key] ?? [], path)
        set((s) => ({
          open: true,
          activeConversationId: key,
          tabsByConversation: touch(s.tabsByConversation, key, tabs),
          activeByConversation: { ...s.activeByConversation, [key]: path },
        }))
      },

      closeTab: (conversationId, path) => {
        const key = convKey(conversationId)
        const tabs = get().tabsByConversation[key] ?? []
        const activePath = get().activeByConversation[key] ?? null
        const result = closeTabInList(tabs, path, activePath)
        set((s) => ({
          // Last tab gone → collapse the pane with it (WorkBuddy-style).
          open: result.tabs.length > 0 ? s.open : false,
          tabsByConversation: { ...s.tabsByConversation, [key]: result.tabs },
          ...(result.nextActive !== undefined
            ? { activeByConversation: { ...s.activeByConversation, [key]: result.nextActive } }
            : {}),
        }))
      },

      setActive: (conversationId, path) => {
        const key = convKey(conversationId)
        set((s) => ({ activeByConversation: { ...s.activeByConversation, [key]: path } }))
      },

      setWidth: (width) => set({ width }),

      setOpen: (open) => set({ open }),

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
        set((s) => {
          const { [conversationId]: _tabs, ...restTabs } = s.tabsByConversation
          const { [conversationId]: _active, ...restActive } = s.activeByConversation
          return { tabsByConversation: restTabs, activeByConversation: restActive }
        }),
    }),
    {
      name: 'preview-pane',
      partialize: (s) => ({ width: s.width }) as PreviewPaneState,
    },
  ),
)

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
