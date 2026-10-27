// ── Workbench store (PLAN-workbench W7) ──
// Single right-side pane host state: which tool tab is frontmost (工作区 /
// 浏览器 / 工作计划), one shared width, and per-conversation open/closed —
// each conversation remembers its own pane, and one with no entry (a fresh
// conversation included) starts closed. Auto-open entries all funnel through
// openTab: create_plan → 'plan', a fresh browser tab → 'browser', a file
// preview → 'workspace' (the standalone 文件预览 tab was merged into 工作区 —
// tree left, preview right), each tagged with the conversation it belongs to.
// Width is persisted; open state is deliberately not (a restart has no live
// plan or browser session to show). The deliverables aggregate tab that
// existed here for one day (2026-09-19) is gone — the per-turn cards in the
// transcript are the only deliverables surface; a persisted activeTab naming
// it (or the removed 'files') must not render an empty pane body, hence the
// ID set below.
//
// Conversation keys come from callers (previewPaneStore's DRAFT key covers
// new tasks with no row yet) — this store stays key-format-agnostic so it
// does not import previewPaneStore back.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type WorkbenchTab = 'workspace' | 'browser' | 'plan'

/** The renderable tabs. A persisted `activeTab` outside this set (a tab that
 *  was since removed — 'files' merged into 'workspace') falls back to
 *  'workspace' in WorkbenchPane instead of rendering a pane body with no
 *  view. */
export const WORKBENCH_TAB_IDS: ReadonlySet<WorkbenchTab> = new Set<WorkbenchTab>([
  'workspace',
  'browser',
  'plan',
])

export const WORKBENCH_DEFAULT_WIDTH = 420
/** 工作区 tab's tree column (px) — the tree↔preview divider drag persists
 *  here, global like the pane width (pane geometry is about the user, not
 *  the conversation). Clamped at consumption: clampTreeWidth against the
 *  live row measurement, never trusted raw off the disk. */
export const WORKBENCH_DEFAULT_TREE_WIDTH = 180

/** How many conversations' open flags to remember before MRU-pruning. */
const MAX_OPEN_MAPS = 20

interface WorkbenchState {
  /** Pane open per conversation key; absent = closed. */
  openByConversation: Record<string, boolean>
  width: number
  activeTab: WorkbenchTab
  treeWidth: number
  setOpen: (convKey: string, open: boolean) => void
  setWidth: (width: number) => void
  setTreeWidth: (width: number) => void
  setActiveTab: (tab: WorkbenchTab) => void
  /** Bring a tab to the front, opening this conversation's workbench if closed. */
  openTab: (convKey: string, tab: WorkbenchTab) => void
}

/** Re-insert `convKey` as most-recently-used, then prune beyond the cap —
 *  same shape as previewPaneStore's touch(); a pruned conversation just
 *  re-enters as closed. */
function touchOpen(map: Record<string, boolean>, convKey: string, open: boolean): Record<string, boolean> {
  const rest = { ...map }
  delete rest[convKey]
  const entries = Object.entries(rest)
  entries.push([convKey, open])
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_OPEN_MAPS)))
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      openByConversation: {},
      width: WORKBENCH_DEFAULT_WIDTH,
      activeTab: 'workspace',
      treeWidth: WORKBENCH_DEFAULT_TREE_WIDTH,
      setOpen: (convKey, open) => set((s) => ({ openByConversation: touchOpen(s.openByConversation, convKey, open) })),
      setWidth: (width) => set({ width }),
      setTreeWidth: (treeWidth) => set({ treeWidth }),
      setActiveTab: (activeTab) => set({ activeTab }),
      openTab: (convKey, tab) =>
        set((s) => ({ openByConversation: touchOpen(s.openByConversation, convKey, true), activeTab: tab })),
    }),
    {
      name: 'pulsemind-workbench',
      partialize: (s) => ({ width: s.width, activeTab: s.activeTab, treeWidth: s.treeWidth }) as WorkbenchState,
    },
  ),
)
