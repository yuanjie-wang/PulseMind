// ── Shared project list (renderer side) ──
// One snapshot of the project list for every consumer: the sidebar's group
// headers, the welcome page's project picker and the project center all read
// the same state, so a rename/create/delete made in one view is visible in
// the others after a single reload(). Callers still trigger reload() on
// mount/open — the store only removes the duplicated fetching and the
// stale-name problem across views.

import { create } from 'zustand'
import type { Project } from '../../../shared/types/project'
import { stringToHue } from '../../../shared/hash-color'

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

/** A project's identity hue — stored on the row since 2026-09-16, so the same
 *  project wears the same color on every surface (its welcome card, and the
 *  composer's send button) and *renaming it does not move the color*. Surfaces
 *  each own what they do with the hue; this is only where it comes from.
 *  The name hash remains as the fallback for a project with no stored hue — a
 *  row read before the startup backfill ran, or the synthesized default project
 *  that has no row at all — so a missing field degrades to the pre-storage
 *  behavior instead of to no color. */
export function projectHue(project: Pick<Project, 'name' | 'colorHue'>): number {
  return project.colorHue ?? stringToHue(project.name)
}

/** Identity hue of the project behind an id, for surfaces that only know which
 *  project is selected (the welcome composer). Undefined while nothing is
 *  picked, or while the list is still in flight — callers fall back to their
 *  neutral look rather than inventing a color. */
export function useProjectHue(projectId: string | null | undefined): number | undefined {
  return useProjectStore((s) => {
    const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined
    return project ? projectHue(project) : undefined
  })
}
