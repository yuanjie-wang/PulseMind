// ── Project (immersive) window layout (2026-10-30) ──
// One persisted width: the explorer region (tree | preview) that sits left of
// the conversation. Global like the workbench pane's width — column geometry
// is about the user, not the project — and clamped at every consumption
// (clampExplorerWidth against the live row), never trusted raw off the disk.
//
// Deliberately its own store rather than a field on workbenchStore: the
// project window renders a WorkspacePane (which reads workbenchStore.treeWidth
// for the tree↔preview split), and its own explorer width is a different
// axis. Both are per-window module state, but the persisted keys share the
// origin's localStorage with the main window — which is the intent for both.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EXPLORER_DEFAULT_WIDTH } from '../../../shared/ui/layout-widths'

interface SecondaryLayoutState {
  explorerWidth: number
  setExplorerWidth: (width: number) => void
}

export const useSecondaryLayoutStore = create<SecondaryLayoutState>()(
  persist(
    (set) => ({
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      setExplorerWidth: (explorerWidth) => set({ explorerWidth }),
    }),
    {
      name: 'pulsemind-project-window-layout',
      partialize: (s) => ({ explorerWidth: s.explorerWidth }) as SecondaryLayoutState,
    },
  ),
)
