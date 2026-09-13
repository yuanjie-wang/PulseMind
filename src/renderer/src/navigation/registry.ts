// ── Navigation registry ──
// PLAN-0.4.0 M1.1, revised 2026-09-12 (user decision D4-rev): primary
// navigation is a persistent sidebar button column — NOT a hamburger popover.
// This file is the single source of truth: adding a top-level view means
// adding an entry here and a case in ViewHost.

import type { ComponentType, CSSProperties } from 'react'
import {
  MessageOutlined,
  ProjectOutlined,
  PlusOutlined,
  SearchOutlined,
  ScheduleOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import type { AppViewKind } from './types'

export interface SidebarNavItem {
  labelKey: string
  icon: ComponentType<{ style?: CSSProperties }>
  view: AppViewKind
  /** Action items (新建任务) perform extra work on top of navigating. */
  isAction?: boolean
  /** Hover submenu. A non-empty list turns the entry into a split button:
   *  hovering reveals these, and the entry itself runs its own default. */
  submenu?: SidebarNavItem[]
  /** New-task form to preselect on the welcome page (M8.4): the entry lands on
   *  the (empty) chat view and flips the welcome page's 对话/项目 switcher. */
  newTaskMode?: 'chat' | 'project'
}

/** Behind 新建任务 — the two ways to start work. Both land on the empty chat
 *  view; the welcome page's switcher is preselected accordingly. */
export const NEW_TASK_SUBMENU: SidebarNavItem[] = [
  { labelKey: 'menu.newChat', icon: MessageOutlined, view: 'chat', isAction: true, newTaskMode: 'chat' },
  { labelKey: 'menu.newProject', icon: ProjectOutlined, view: 'chat', isAction: true, newTaskMode: 'project' },
]

/** Behind 能力 • 知识 • 工具 — the three centers, which share one page whose tab
 *  is the view kind itself (CentersPage + the header Segmented). */
export const CENTERS_SUBMENU: SidebarNavItem[] = [
  { labelKey: 'menu.capability', icon: AppstoreOutlined, view: 'capability' },
  { labelKey: 'menu.knowledge', icon: DatabaseOutlined, view: 'knowledge' },
  { labelKey: 'menu.tools', icon: ToolOutlined, view: 'tools' },
]

/** The sidebar's nav column, top to bottom. An entry's own `view` is what
 *  clicking it opens — for a grouped entry, its first sub-entry. */
export const SIDEBAR_NAV: SidebarNavItem[] = [
  { labelKey: 'menu.newTask', icon: PlusOutlined, view: 'chat', isAction: true, newTaskMode: 'chat', submenu: NEW_TASK_SUBMENU },
  { labelKey: 'menu.search', icon: SearchOutlined, view: 'search' },
  { labelKey: 'menu.routines', icon: ScheduleOutlined, view: 'routines' },
  { labelKey: 'menu.centers', icon: AppstoreOutlined, view: 'capability', submenu: CENTERS_SUBMENU },
]

/** Header title for each view kind. Chat shows the active conversation's title
 *  instead (AppLayout), so its entry here is only a fallback. */
export const VIEW_TITLE_KEY: Record<AppViewKind, string> = {
  chat: 'menu.newChat',
  search: 'viewTitle.search',
  project: 'viewTitle.project',
  routines: 'viewTitle.routines',
  capability: 'viewTitle.capability',
  knowledge: 'viewTitle.knowledge',
  tools: 'viewTitle.tools',
  settings: 'viewTitle.settings',
  usage: 'viewTitle.usage',
  about: 'viewTitle.about',
  canvas: 'appLayout.newCanvas',
}
