// ── 工作区 tree store: the expansion cache (PLAN-workbench W15) ──
// The 工作区 tab is unmounted whenever another workbench tab is frontmost —
// WorkbenchPane renders the active view only — so antd's own expansion state
// died with it and every tab switch collapsed the whole tree (user report
// 2026-09-17: 「文件夹展开状态需要在用使用期间进行缓存，避免每次切换 tab 还要
// 重新展开」). The cache therefore lives in a store, keyed by the workspace dir
// (the tree's root), and WorkspaceTree drives DirectoryTree with controlled
// `expandedKeys` + `onExpand`.
//
// Loading does NOT come for free: rc-tree runs `loadData` only for a node the
// user expands in the current mount — a changed `expandedKeys` prop just
// recomputes `flattenNodes` (read off @rc-component/tree) — so a remount handed
// these keys would reopen every folder EMPTY. WorkspaceTree re-reads the cached
// levels on mount for exactly that reason. It is also why nothing here caches
// the *contents*: the store keeps keys, the listing stays fresh.

import { create } from 'zustand'
import { touchRecord } from '../utils/lru-record'
import { dropSubtree, MAX_WORKSPACE_DIRS } from './workspace-tree'

/** One shared empty list: the tree reads keys through a selector, and a fresh
 *  `[]` per render would change the prop identity DirectoryTree's sync effect
 *  keys on (which React would then loop on). */
export const NO_EXPANDED_KEYS: string[] = []

interface WorkspaceTreeState {
  /** workspace dir → its expanded keys, most-recently-used last. */
  expandedByDir: Record<string, string[]>
  setExpanded: (dir: string, keys: string[]) => void
  /** A path was deleted: forget it and its subtree everywhere it is cached. */
  dropDeleted: (path: string) => void
}

export const useWorkspaceTreeStore = create<WorkspaceTreeState>()((set) => ({
  expandedByDir: {},

  setExpanded: (dir, keys) => set((s) => ({ expandedByDir: touchRecord(s.expandedByDir, dir, keys, MAX_WORKSPACE_DIRS) })),

  dropDeleted: (path) =>
    set((s) => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [dir, keys] of Object.entries(s.expandedByDir)) {
        const kept = dropSubtree(keys, path)
        if (kept.length !== keys.length) changed = true
        next[dir] = kept
      }
      // A file (or a deleted folder nothing had expanded) changes nothing —
      // returning the same state keeps every subscriber from re-rendering.
      return changed ? { expandedByDir: next } : s
    }),
}))
