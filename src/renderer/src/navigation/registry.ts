// ── Navigation registry ──
// PLAN-0.4.0 M1.1, revised 2026-09-12 (user decision D4-rev): primary
// navigation is a persistent sidebar button column — NOT a hamburger popover.
// This file is the single source of truth: adding a top-level view means
// adding an entry here and a case in ViewHost.

import type { ComponentType, CSSProperties } from 'react'
import { PlusOutlined, SearchOutlined, ScheduleOutlined, AppstoreOutlined, DatabaseOutlined, ToolOutlined } from '@ant-design/icons'
import { MessageOutlined, FolderOutlined, GlobalOutlined } from '@ant-design/icons'
import type { AppViewKind } from './types'
import type { NewTaskMode } from '../stores/newTaskStore'

export interface SidebarNavItem {
  labelKey: string
  icon: ComponentType<{ style?: CSSProperties }>
  view: AppViewKind
  /** Action items (新建任务) perform extra work on top of navigating. */
  isAction?: boolean
  /** Hover submenu. A non-empty list turns the entry into a split button:
   *  hovering reveals these, and the entry itself runs its own default. */
  submenu?: SidebarNavItem[]
  /** 新建任务的子菜单档位（PLAN-layout-modes 十四期）：携带的任务形态决定
   *  welcome 落在哪张表单（chat 对话 composer / project 项目选择 / browser
   *  URL 表单）。任务形态不是导航视图——三档的 view 都是 'chat'，消费方
   *  （AppLayout.handleNewTaskWithMode）据它设 newTaskStore.mode。 */
  taskMode?: NewTaskMode
}

/** Behind 能力 • 知识 • 工具 — the three centers, which share one page whose tab
 *  is the view kind itself (CentersPage + the header Segmented). */
export const CENTERS_SUBMENU: SidebarNavItem[] = [
  { labelKey: 'menu.capability', icon: AppstoreOutlined, view: 'capability' },
  { labelKey: 'menu.knowledge', icon: DatabaseOutlined, view: 'knowledge' },
  { labelKey: 'menu.tools', icon: ToolOutlined, view: 'tools' },
]

/** 新建任务的三档子菜单（十四期）：悬浮展开，点档位进对应形态的 welcome；
 *  点按钮本体走 listTab 语义（对话/项目 pill 决定）。 */
export const NEW_TASK_SUBMENU: SidebarNavItem[] = [
  { labelKey: 'menu.newTaskChat', icon: MessageOutlined, view: 'chat', isAction: true, taskMode: 'chat' },
  { labelKey: 'menu.newTaskProject', icon: FolderOutlined, view: 'chat', isAction: true, taskMode: 'project' },
  { labelKey: 'menu.newTaskBrowser', icon: GlobalOutlined, view: 'chat', isAction: true, taskMode: 'browser' },
]

/** 某一档任务形态的图标。会话头三态循环钮（components/layout/primary-cycle.ts）
 *  直接取这一份（2026-11-04 用户裁定「切换按钮的图标需要和新建任务子菜单的
 *  图标保持一致，相同语义」）：两处是同一份表，改名/换形不可能只改到一边。 */
export function newTaskModeIcon(mode: NewTaskMode): ComponentType<{ style?: CSSProperties }> {
  return NEW_TASK_SUBMENU.find((item) => item.taskMode === mode)?.icon ?? MessageOutlined
}

/** The sidebar's nav column, top to bottom. An entry's own `view` is what
 *  clicking it opens — for a grouped entry, its first sub-entry. */
export const SIDEBAR_NAV: SidebarNavItem[] = [
  { labelKey: 'menu.newTask', icon: PlusOutlined, view: 'chat', isAction: true, submenu: NEW_TASK_SUBMENU },
  { labelKey: 'menu.search', icon: SearchOutlined, view: 'search' },
  { labelKey: 'menu.routines', icon: ScheduleOutlined, view: 'routines' },
  { labelKey: 'menu.centers', icon: AppstoreOutlined, view: 'capability', submenu: CENTERS_SUBMENU },
]

/** Header title for each view kind. Chat shows the active conversation's title
 *  instead (AppLayout), so its entry here is only a fallback. */
export const VIEW_TITLE_KEY: Record<AppViewKind, string> = {
  chat: 'menu.newChat',
  search: 'viewTitle.search',
  routines: 'viewTitle.routines',
  capability: 'viewTitle.capability',
  knowledge: 'viewTitle.knowledge',
  tools: 'viewTitle.tools',
  settings: 'viewTitle.settings',
  usage: 'viewTitle.usage',
  about: 'viewTitle.about',
}
