// ── Navigation registry ──
// PLAN-0.4.0 M1.1, revised 2026-09-12 (user decision D4-rev): primary
// navigation is a persistent sidebar button column — NOT a hamburger popover.
// This file is the single source of truth: adding a top-level view means
// adding an entry here and a case in ViewHost.

import type { ComponentType, CSSProperties } from 'react'
import {
  MessageOutlined,
  ProjectOutlined,
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
  /** Action items (新建对话) perform extra work on top of navigating. */
  isAction?: boolean
}

/** The sidebar's nav column, top to bottom. */
export const SIDEBAR_NAV: SidebarNavItem[] = [
  { labelKey: 'menu.newChat', icon: MessageOutlined, view: 'chat', isAction: true },
  { labelKey: 'menu.newProject', icon: ProjectOutlined, view: 'project' },
  { labelKey: 'menu.routines', icon: ScheduleOutlined, view: 'routines' },
  { labelKey: 'menu.capability', icon: AppstoreOutlined, view: 'capability' },
  { labelKey: 'menu.knowledge', icon: DatabaseOutlined, view: 'knowledge' },
  { labelKey: 'menu.tools', icon: ToolOutlined, view: 'tools' },
]

/** Header title for each view kind. Chat shows the active conversation's title
 *  instead (AppLayout), so its entry here is only a fallback. */
export const VIEW_TITLE_KEY: Record<AppViewKind, string> = {
  chat: 'menu.newChat',
  project: 'viewTitle.project',
  routines: 'viewTitle.routines',
  capability: 'viewTitle.capability',
  knowledge: 'viewTitle.knowledge',
  tools: 'viewTitle.tools',
  canvas: 'appLayout.newCanvas',
}
