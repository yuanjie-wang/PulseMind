// ── Sidebar project-list sorting (pure logic) ──
// Kept out of ProjectSidebarList so the comparators stay importable from
// node-env vitest (the component pulls antd + i18n with it). The AppLayout
// dropdown owns the *choice* (settings.projectSortMode); this file owns what
// the choice means.

import type { Project, ProjectSortMode } from '../../../../shared/types/project'
import type { ConversationListItem } from '../../types/conversation'

export type { ProjectSortMode }

export interface ProjectGroup {
  project: Project
  conversations: ConversationListItem[]
}

/** A group's last-activity instant: its newest conversation's updatedAt, else
 *  the project's own updatedAt (an empty project never moves for its
 *  conversations — there are none). ISO strings compare lexicographically. */
function lastActivity(group: ProjectGroup): string {
  let latest = group.project.updatedAt || group.project.createdAt
  for (const conv of group.conversations) {
    if (conv.updatedAt && conv.updatedAt > latest) latest = conv.updatedAt
  }
  return latest
}

/** Returns a new sorted array; the input is untouched. Ties keep their store
 *  order (V8 sort is stable), so equal keys never shuffle the list. */
export function sortProjectGroups(groups: ProjectGroup[], mode: ProjectSortMode): ProjectGroup[] {
  const sorted = [...groups]
  switch (mode) {
    case 'name':
      // zh-aware: pinyin ordering for Chinese names, alphabetical for Latin.
      sorted.sort((a, b) => a.project.name.localeCompare(b.project.name, 'zh'))
      break
    case 'activity':
      sorted.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
      break
    case 'manual':
      // The drag order lives on the row (`sort_order`); rows never dragged —
      // a project created after the last drag — have none and stay newest-first
      // AHEAD of the ordered block, so the list keeps looking like "new stuff
      // on top" instead of dropping new projects to the bottom forever.
      sorted.sort((a, b) => {
        const ao = a.project.sortOrder
        const bo = b.project.sortOrder
        if (ao !== undefined && bo !== undefined) return ao - bo
        if (ao !== undefined) return 1
        if (bo !== undefined) return -1
        return b.project.createdAt.localeCompare(a.project.createdAt)
      })
      break
    case 'created':
    default:
      sorted.sort((a, b) => b.project.createdAt.localeCompare(a.project.createdAt))
      break
  }
  return sorted
}
