// ── Shared project list (renderer side) ──
// One snapshot of the project list for every consumer: the sidebar's group
// headers, the welcome page's project picker and the project center all read
// the same state, so a rename/create/delete made in one view is visible in
// the others after a single reload(). Callers still trigger reload() on
// mount/open — the store only removes the duplicated fetching and the
// stale-name problem across views.

import { create } from 'zustand'
import type { Project } from '../../../shared/types/project'

interface ProjectListState {
  projects: Project[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useProjectStore = create<ProjectListState>((set) => ({
  projects: [],
  loaded: false,
  reload: async () => {
    try {
      const projects = await window.electronAPI.projectList()
      set({ projects, loaded: true })
    } catch (err) {
      console.warn('[projectStore] load failed:', err)
    }
  },
}))
