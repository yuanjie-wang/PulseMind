// ── Navigation registry ──
// PLAN-0.4.0 M1.1: the single source of truth for the top-left menu. Adding a
// new top-level view means adding an entry here — nothing else.
//
// Items come in three flavours:
//   action — performs something (new chat) without changing the view
//   view   — navigates to a top-level content view
//   modal  — opens an AppLayout-owned modal (settings, about)

import type { ComponentType } from 'react'
import {
  MessageOutlined,
  ProjectOutlined,
  ScheduleOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  ToolOutlined,
  SettingOutlined,
  InfoCircleOutlined
} from '@ant-design/icons'
import type { AppViewKind } from './types'

export interface MenuActionItem {
  type: 'action'
  id: 'new-chat' | 'new-project'
  labelKey: string
  icon: ComponentType
}

export interface MenuViewItem {
  type: 'view'
  view: AppViewKind
  labelKey: string
  icon: ComponentType
}

export interface MenuModalItem {
  type: 'modal'
  id: 'settings' | 'about'
  labelKey: string
  icon: ComponentType
}

export type MenuItem = MenuActionItem | MenuViewItem | MenuModalItem

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

/** Menu groups, rendered top to bottom with separators between groups. */
export const MENU_GROUPS: MenuItem[][] = [
  [
    { type: 'action', id: 'new-chat', labelKey: 'menu.newChat', icon: MessageOutlined },
    { type: 'view', view: 'project', labelKey: 'menu.newProject', icon: ProjectOutlined },
  ],
  [
    { type: 'view', view: 'routines', labelKey: 'menu.routines', icon: ScheduleOutlined },
    { type: 'view', view: 'capability', labelKey: 'menu.capability', icon: AppstoreOutlined },
    { type: 'view', view: 'knowledge', labelKey: 'menu.knowledge', icon: DatabaseOutlined },
    { type: 'view', view: 'tools', labelKey: 'menu.tools', icon: ToolOutlined },
  ],
  [
    { type: 'modal', id: 'settings', labelKey: 'menu.settings', icon: SettingOutlined },
    { type: 'modal', id: 'about', labelKey: 'menu.about', icon: InfoCircleOutlined },
  ],
]
