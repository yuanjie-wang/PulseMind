import React, { useEffect, useRef, useState } from 'react'
import { Layout, Button, theme, Tooltip, Dropdown } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import {
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BarChartOutlined,
  PlusOutlined,
  SortAscendingOutlined
} from '@ant-design/icons'
import ConversationSidebar from './ConversationSidebar'
import ProjectSidebarList from './ProjectSidebarList'
import SidebarNav from './SidebarNav'
import { ViewHost } from './ViewHost'
import { ProjectModal } from '../project/ProjectModal'
import CommandPalette from './CommandPalette'
import { TITLE_BAR_HEIGHT } from '../../../../shared/window-chrome'
import { CENTERS_SUBMENU, VIEW_TITLE_KEY } from '../../navigation/registry'
import { useNavigationStore } from '../../stores/navigationStore'
import { useNewTaskStore, type NewTaskMode } from '../../stores/newTaskStore'
import { useProjectStore } from '../../stores/projectStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useCommandPaletteStore } from '../../stores/commandPaletteStore'
import { buildCommandItems } from '../../navigation/command-palette-items'
import { DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { conversationKeyOf } from '../../../../shared/conversation-key'
import { effectiveAccelerators, formatAccelerator, type ShortcutActionId } from '../../../../shared/shortcuts'
import { FONT_SIZE, FONT_WEIGHT } from '../../theme/tokens'
import { useThemeMode } from '../../theme/mode'
import type { Project, ProjectSortMode } from '../../../../shared/types/project'
import { useSettings } from '../../hooks/SettingsContext'
import type { ConversationListItem } from '../../types/conversation'
import type { MemoryManager } from '../../memory/MemoryManager'
import type { SkillState } from '../../skills/types'
import type { ToolState } from '../../tools/types'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'

const { Header, Sider, Content } = Layout
const MAX_SESSIONS = 100

// Right-pane toggle glyph (the "panel right" shape every editor uses for its
// dockable side panel): an outlined window split by a divider, the right
// section filling solid while the pane is open. Hand-drawn rather than antd's
// border/pic families, which read as static shapes, not as a panel toggle.
function PanelRightIcon({ size = 16, filled = false }: { size?: number; filled?: boolean }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
      {filled && <rect x="16.5" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  )
}

// Theme-toggle glyphs, hand-drawn in the same stroke idiom as PanelRightIcon
// above (@ant-design/icons has a moon but no sun, and one borrowed filled
// glyph beside one drawn outline would read as two different families).
// The button shows the mode the click LEADS TO: sun while dark, moon while
// light — the toggle advertises the state it switches into.
function SunIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

function MoonIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

// The OS draws the window controls over the app's own top bar — macOS traffic lights
// at its left, Windows/Linux caption buttons at its right — because the window is
// created with titleBarStyle 'hidden'. The top bar reserves the room those controls
// occupy, so nothing ends up underneath them.
// Read once: this is static per process, and AppLayout re-renders on every streamed
// token. The optional call tolerates a renderer hot-reload into an Electron process
// whose preload predates this API, which would otherwise throw at module scope and
// blank the window.
const windowControls = window.electronAPI.getWindowControls?.() ?? { side: 'right' as const, inset: 0 }
const CONTROLS_ON_LEFT = windowControls.side === 'left'

// Space reserved at the top of the sidebar for the macOS traffic lights, which the OS
// draws over the app's top-left corner. Zero on Windows/Linux: their window controls sit
// on the right, so reserving anything here would only push the sidebar down.
const SIDEBAR_TOP_BAND_HEIGHT = CONTROLS_ON_LEFT ? 50 : 0

// Top padding of the sidebar title row. With the band above it, 10px is enough breathing
// room; where the sidebar starts at the window's top edge it is the title's only gap from
// the edge, so it needs the larger value.
const SIDEBAR_TITLE_PADDING_TOP = SIDEBAR_TOP_BAND_HEIGHT > 0 ? 10 : 30

// The sidebar's wash: cool grey at the top easing to neutral grey at the bottom,
// painted on the Sider itself. `.ant-layout-sider-children` below must stay
// transparent — it spans the full Sider, so a fill there would flatten the
// gradient. The gradient itself lives in palette.ts (--pm-sidebar, both modes).
const SIDEBAR_BACKGROUND = 'var(--pm-sidebar)'

// With the sidebar collapsed the header starts at the window's left edge, where the
// window controls sit, so its content has to clear them.
const headerLeftInset = (collapsed: boolean): number => (collapsed && CONTROLS_ON_LEFT ? windowControls.inset : 0)

interface AppLayoutProps {
  children?: React.ReactNode
  conversations: ConversationListItem[]
  activeConversationKey: string | symbol | undefined
  /** Session-cap inputs: creating is capped unless auto-cleanup is on. */
  totalSessions: number
  autoCleanup: boolean
  onCreateNew: () => void
  onDeleteConversation: (key: string) => void
  onRenameConversation: (key: string, newLabel: string) => void
  onSelectConversation: (key: string) => void
  onTogglePinConversation: (key: string, pinned: boolean) => void
  /** M4 (review 2026-09-18): SETTINGS_SET prunes expired conversations main-side;
   *  the settings page's 数据清理 (常规 tab) calls this afterwards so the sidebar drops them. */
  onReloadConversations?: () => void
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  memoryManager?: MemoryManager
  knowledgeManager?: KnowledgeManager
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
}

function AppLayout({
  conversations,
  activeConversationKey,
  totalSessions,
  autoCleanup,
  onCreateNew,
  onDeleteConversation,
  onRenameConversation,
  onSelectConversation,
  onTogglePinConversation,
  onReloadConversations,
  skills,
  onToggleSkill,
  tools,
  onToggleTool,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError,
  memoryManager,
  knowledgeManager,
  activeLoopConvIds,
  retryingConvIds,
  children
}: AppLayoutProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)
  const navigateKind = useNavigationStore((s) => s.navigateKind)

  const { token } = theme.useToken()
  const { t } = useTranslation()

  // The history area's tab: the conversation list or the project list.
  const [listTab, setListTab] = useState<'chats' | 'projects'>('chats')

  // Switcher-row actions (PLAN-0.4.0): 新增 sits right of the 对话/项目 pill
  // and follows the selected tab — the former project center is gone, so the
  // 项目 tab's own action is 新增 (the same ProjectModal the welcome picker
  // uses). Conversation-management (清理策略) moved to the settings page's
  // 常规 section.
  const [projectModalOpen, setProjectModalOpen] = useState(false)
  // The project being edited (sidebar row's 编辑 / welcome card's edit entry
  // land here). Same ProjectModal instance serves both modes: open is true
  // while either trigger is set, and `editing` switches the modal's mode.
  const [projectEditTarget, setProjectEditTarget] = useState<Project | null>(null)
  const reloadProjects = useProjectStore((s) => s.reload)
  const projects = useProjectStore((s) => s.projects)

  // The 项目 list's group order. A global preference (settings.projectSortMode),
  // written through the shared save path like the theme is — the guard keeps a
  // click that races the initial settings load from persisting DEFAULT_SETTINGS
  // over the real file.
  const { settings, loading: settingsLoading, saveSettings } = useSettings()
  const projectSortMode: ProjectSortMode = settings.projectSortMode ?? 'created'
  const changeProjectSort = (mode: ProjectSortMode): void => {
    if (mode === projectSortMode || settingsLoading) return
    void saveSettings({ ...settings, projectSortMode: mode })
  }

  // The sidebar's 浅色/深色 toggle acts on the RESOLVED mode (`useThemeMode`
  // follows a `system` preference too) and writes the opposite concrete
  // preference — same field the environment settings' 外观 radio edits, so the
  // two surfaces cannot disagree. The settingsLoading guard is changeProjectSort's:
  // a click that races the initial load must not persist DEFAULT_SETTINGS.
  const themeMode = useThemeMode()
  const toggleTheme = (): void => {
    if (settingsLoading) return
    void saveSettings({ ...settings, theme: themeMode === 'dark' ? 'light' : 'dark' })
  }

  const canCreateNew = autoCleanup || totalSessions < MAX_SESSIONS
  // The open conversation, resolved once: `''` while nothing is open, which is
  // not a conversation — see conversationKeyOf.
  const activeConvKey = conversationKeyOf(activeConversationKey)
  const activeConvTitle = activeConvKey
    ? conversations.find((c) => c.key === activeConvKey)?.label
    : undefined
  // The right-side workbench pane's open state for THIS conversation — the
  // title bar's toggle mirrors it; the draft key covers a not-yet-created row.
  const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY
  const workbenchOpen = useWorkbenchStore((s) => s.openByConversation[wbKey] ?? false)
  // The 对话 tab covers the loose — project-less — conversations; project-bound
  // ones live under the 项目 tab, so the two tabs never duplicate each other.
  const looseConversations = conversations.filter((c) => !c.projectId)

  // 新建任务 follows the list switcher: with the 项目 tab selected it opens the
  // welcome form on a project task, with 对话 on a plain conversation — the same
  // 对话/项目 state the welcome page's capsule shows, so the sidebar button and
  // that capsule cannot disagree. Nothing is created here; the first message
  // does that (M8.4). The project pick is cleared on the way in: a fresh task is
  // never bound to whatever project an earlier task selected, and until a card
  // is picked the welcome composer's send button stays grey — only the
  // project row's own 新建任务 (handleProjectNewTask) preselects, because there
  // the user has named the project by clicking it.
  //
  // Both named entries ride this handler — the sidebar's 新建任务 button and the
  // history list's + (chats tab, via handleTabAdd) — so the guidance shake is
  // raised exactly here, targeted at the surface the mode is about to ask
  // about: the composer in chat mode, the whole project picker in project mode
  // (user 2026-09-23: 「左右摇晃」). The no-guide entries below cancel instead.
  const handleNewTask = (): void => {
    const mode: NewTaskMode = listTab === 'projects' ? 'project' : 'chat'
    useNewTaskStore.getState().setMode(mode)
    useNewTaskStore.getState().setProjectId(null)
    useNewTaskStore.getState().requestShake(mode === 'project' ? 'projectPicker' : 'composer')
    onCreateNew()
  }

  // 新增: chats tab → the same fresh form as SidebarNav's 新建任务 (its tooltip
  // says 新建对话, so it must not land in a project form carrying an earlier
  // pick); projects tab → the project create modal.
  const handleTabAdd = (): void => {
    if (listTab === 'projects') {
      setProjectEditTarget(null) // create mode, even if an edit modal just closed
      setProjectModalOpen(true)
      return
    }
    navigate({ kind: 'chat' })
    if (canCreateNew) handleNewTask()
  }

  // 项目行's 新建任务 and the sidebar create modal's success path: land on the
  // welcome form with the project preselected — the same deferred flow as the
  // welcome picker (M8.4), where nothing is created until a message is
  // actually sent. No guidance shake here (the user named the project by
  // clicking the row) — and a cancel, not silence: within the shake grace
  // window this mount would otherwise replay a just-clicked picker shake.
  const handleProjectNewTask = (projectId: string): void => {
    useNewTaskStore.getState().setMode('project')
    useNewTaskStore.getState().setProjectId(projectId)
    useNewTaskStore.getState().requestShake(null)
    navigate({ kind: 'chat' })
    if (canCreateNew) onCreateNew()
  }

  // ── Native menu / accelerator actions ──
  // macOS: the real application menu's accelerators; Windows/Linux: the
  // before-input fallback (menu.ts). Both push a MenuActionId over
  // MENU_ACTION. Subscribed ONCE; the dispatch table is refreshed after every
  // commit through a ref (assignment lives in an effect — render-period ref
  // writes are forbidden), so menu activations always see the current
  // closures without re-subscribing on every streamed-token render.
  const startPlainNewTask = (): void => {
    // Same semantics as the sidebar's 新建任务: a plain conversation, any
    // project pick cleared, nothing created until the first message. Deliberately
    // no guidance shake (the palette/accelerator path was not part of the
    // 新建任务 ruling) — the cancel keeps a just-clicked shake from replaying
    // onto this mount within the grace window.
    useNewTaskStore.getState().setMode('chat')
    useNewTaskStore.getState().setProjectId(null)
    useNewTaskStore.getState().requestShake(null)
    navigate({ kind: 'chat' })
    if (canCreateNew) onCreateNew()
  }
  const menuActionRef = useRef<(action: string) => void>(() => {})
  useEffect(() => {
    menuActionRef.current = (action: string): void => {
      switch (action) {
        case 'new-task':
          startPlainNewTask()
          break
        case 'new-project':
          setProjectEditTarget(null)
          setProjectModalOpen(true)
          break
        case 'command-palette':
          useCommandPaletteStore.getState().setOpen(true)
          break
        case 'toggle-sidebar':
          setCollapsed((c) => !c)
          break
        case 'toggle-workbench':
          if (workbenchOpen) useWorkbenchStore.getState().setOpen(wbKey, false)
          else useWorkbenchStore.getState().openTab(wbKey, 'workspace')
          break
        case 'open-search':
          navigate({ kind: 'search' })
          break
        case 'open-settings':
          navigateKind('settings')
          break
        case 'open-usage':
          navigateKind('usage')
          break
      }
    }
  })
  useEffect(() => {
    const unsub = window.electronAPI?.onMenuAction((action) => menuActionRef.current(action))
    return unsub
  }, [])

  // ── Command palette items ──
  // Rebuilt per render on purpose: the run closures capture live state
  // (listTab-adjacent stores, workbenchOpen), and AppLayout re-renders on
  // every streamed token anyway — memoizing would trade correctness for
  // nothing. ~30 items, built only to be filtered on demand.
  const isMac = /mac/i.test(navigator.platform)
  const paletteItems = buildCommandItems({
    labels: {
      groupActions: t('palette.groupActions'),
      groupViews: t('palette.groupViews'),
      groupConversations: t('palette.groupConversations'),
      groupProjects: t('palette.groupProjects'),
      groupSettings: t('palette.groupSettings'),
      newTask: t('palette.newTask'),
      newProject: t('palette.newProject'),
      toggleSidebar: t('palette.toggleSidebar'),
      toggleWorkbench: t('palette.toggleWorkbench'),
      openSearch: t('palette.openSearch'),
      openUsage: t('palette.openUsage'),
      openSettings: t('palette.openSettings'),
      openConversation: t('palette.openConversation'),
      newTaskInProject: t('palette.newTaskInProject'),
      settingsSection: t('palette.settingsSection'),
    },
    hints: (() => {
      // Derived from the shared table + the user's overrides, so a rebind made
      // in 设置 → 快捷键 updates these the moment the setting lands — the
      // palette never advertises a key the menu no longer owns.
      const acc = effectiveAccelerators(settings.shortcuts)
      const hint = (action: ShortcutActionId): string => formatAccelerator(acc[action], isMac)
      return {
        newTask: hint('new-task'),
        newProject: hint('new-project'),
        toggleSidebar: hint('toggle-sidebar'),
        toggleWorkbench: hint('toggle-workbench'),
        openSearch: hint('open-search'),
        openUsage: hint('open-usage'),
        openSettings: hint('open-settings'),
      }
    })(),
    conversations: conversations.map((c) => ({ key: String(c.key), label: c.label })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    settingsSections: [
      { key: 'environment', label: t('palette.sectionEnvironment') },
      { key: 'settings', label: t('palette.sectionModel') },
      { key: 'extension', label: t('palette.sectionExtension') },
      { key: 'shortcuts', label: t('palette.sectionShortcuts') },
      { key: 'assistant', label: t('palette.sectionAssistant') },
      { key: 'memory', label: t('palette.sectionMemory') },
      { key: 'experiences', label: t('palette.sectionExperiences') },
      { key: 'data', label: t('palette.sectionData') },
      { key: 'about', label: t('palette.sectionAbout') },
    ],
    run: {
      newTask: startPlainNewTask,
      newProject: () => { setProjectEditTarget(null); setProjectModalOpen(true) },
      toggleSidebar: () => setCollapsed((c) => !c),
      toggleWorkbench: () => {
        // Items rebuild every render, so this closes over the current pane
        // state directly — no ref indirection needed.
        if (workbenchOpen) useWorkbenchStore.getState().setOpen(wbKey, false)
        else useWorkbenchStore.getState().openTab(wbKey, 'workspace')
      },
      openSearch: () => navigate({ kind: 'search' }),
      openUsage: () => navigateKind('usage'),
      openSettings: () => navigateKind('settings'),
      openSettingsSection: (tab) => navigate({ kind: 'settings', settingsTab: tab as 'environment' }),
      openConversation: (key) => { navigate({ kind: 'chat' }); onSelectConversation(key) },
      newTaskInProject: handleProjectNewTask,
    },
  })

  // Sidebar highlight key: only while a chat view is open. Both history tabs
  // (对话 and 项目) take it, so the open conversation reads as active in either.
  const activeChatKey = view.kind === 'chat' ? activeConvKey : undefined

  // With the sidebar collapsed the header starts at the window's left edge, so the
  // macOS traffic lights land on it and its content has to move out of their way.
  const headerLeft = headerLeftInset(collapsed)

  // The three centers share one page (D4a revision); their switcher is the centered
  // content of the title bar (it doubles as the page title, so the centered header
  // title is skipped for these views), and the tab is the view kind itself.
  // Plain buttons driven by the registry's centers submenu — one data source for the
  // sidebar flyout and this switcher, and no antd-internal styling to fight.
  const isCentersView = view.kind === 'capability' || view.kind === 'knowledge' || view.kind === 'tools'
  const centersSwitcher = isCentersView ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {CENTERS_SUBMENU.map((item) => (
        <Button
          key={item.view}
          type="text"
          className={`centers-switch-btn${view.kind === item.view ? ' active-mode-btn' : ''}`}
          onClick={() => navigateKind(item.view)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {t(item.labelKey)}
        </Button>
      ))}
    </div>
  ) : null

  // Sits at the left of the header's action cluster, where it keeps its place whether the
  // sidebar is open or shut. It must never be a *sibling* of a drag region: there the
  // no-drag opt-out is ignored and the click is swallowed as a window drag.
  const sidebarToggle = (
    <Tooltip title={collapsed ? '展开侧边栏' : '收起侧边栏'}>
      <Button
        type="text"
        icon={
          collapsed ? (
            <MenuUnfoldOutlined style={{ fontSize: 18 }} />
          ) : (
            <MenuFoldOutlined style={{ fontSize: 18 }} />
          )
        }
        onClick={() => setCollapsed(!collapsed)}
        aria-label={t('appLayout.toggleSidebar')}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />
    </Tooltip>
  )

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={280}
        collapsedWidth={0}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        trigger={null}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}`, background: SIDEBAR_BACKGROUND }}>
        {/* Space for the macOS traffic lights; the sidebar title deliberately sits below
            them. Not rendered elsewhere, where the sidebar starts at the top. */}
        {SIDEBAR_TOP_BAND_HEIGHT > 0 && (
          <div style={{ height: SIDEBAR_TOP_BAND_HEIGHT, flexShrink: 0, WebkitAppRegion: 'drag' } as React.CSSProperties} />
        )}
        {/* Sidebar header; the title opts out of dragging. */}
        <div style={{
          padding: `${SIDEBAR_TITLE_PADDING_TOP}px 16px 8px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => navigate({ kind: 'settings', settingsTab: 'about' })}>
            <span style={{ fontSize: FONT_SIZE.xl, fontWeight: FONT_WEIGHT.semibold, color: 'var(--pm-ink)' }}>{t('appLayout.title')}</span>
            {/* Version rides the Vite `define` global (package.json's version). */}
            <span style={{ fontSize: FONT_SIZE.sm, fontWeight: FONT_WEIGHT.medium, color: 'var(--pm-text-muted)', lineHeight: 1 }}>v{__APP_VERSION__}</span>
          </div>
        </div>
        <SidebarNav canCreateNew={canCreateNew} onCreateNew={handleNewTask} />
        {/* Tab switcher is pinned; only the list below it scrolls. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* One row: the 对话/项目 pill on the left, its 管理/新增 actions on
              the right. 管理 opens from both tabs (one retention policy covers
              对话 and 项目 alike); 新增 follows the selected tab — the former
              project center is gone, so the 项目 tab creates via 新增. */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {/* Inline margins override the stylesheet's `10px 12px 6px` so the
                actions cluster can hug the row's right edge. */}
            <div className="sidebar-list-track" style={{ margin: '10px 0 6px 12px' }}>
              <Button type="text" className={`sidebar-list-tab${listTab === 'chats' ? ' on' : ''}`} onClick={() => setListTab('chats')}>
                {t('appLayout.listTabChats')}
              </Button>
              <Button type="text" className={`sidebar-list-tab${listTab === 'projects' ? ' on' : ''}`} onClick={() => setListTab('projects')}>
                {t('appLayout.listTabProjects')}
              </Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 8 }}>
              {listTab === 'projects' && (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    selectable: true,
                    selectedKeys: [projectSortMode],
                    items: [
                      { key: 'created', label: t('appLayout.projectSortCreated') },
                      { key: 'name', label: t('appLayout.projectSortName') },
                      { key: 'activity', label: t('appLayout.projectSortActivity') },
                      { key: 'manual', label: t('appLayout.projectSortManual') }
                    ],
                    onClick: ({ key }) => changeProjectSort(key as ProjectSortMode)
                  }}
                >
                  <Tooltip title={t('appLayout.projectSort')}>
                    <Button
                      type="text"
                      className="sidebar-list-action"
                      aria-label={t('appLayout.projectSort')}
                      icon={<SortAscendingOutlined style={{ fontSize: 14 }} />}
                    />
                  </Tooltip>
                </Dropdown>
              )}
              <Tooltip title={listTab === 'chats' ? t('menu.newChat') : t('menu.newProject')}>
                <Button
                  type="text"
                  className="sidebar-list-action"
                  aria-label={listTab === 'chats' ? t('menu.newChat') : t('menu.newProject')}
                  icon={<PlusOutlined style={{ fontSize: 14 }} />}
                  disabled={listTab === 'chats' && !canCreateNew}
                  onClick={handleTabAdd}
                />
              </Tooltip>
            </div>
          </div>
          <div className="auto-hide-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {listTab === 'chats' ? (
              looseConversations.length === 0 ? (
                <div style={{ padding: '16px 0', color: 'var(--pm-text-muted)', fontSize: FONT_SIZE.sm, textAlign: 'center' }}>
                  {t('appLayout.noConversations')}
                </div>
              ) : (
                <ConversationSidebar
                  conversations={looseConversations}
                  activeKey={activeChatKey}
                  onSelect={(key: string) => { navigate({ kind: 'chat' }); onSelectConversation(key) }}
                  onDelete={onDeleteConversation}
                  onRename={onRenameConversation}
                  onTogglePin={onTogglePinConversation}
                  activeLoopConvIds={activeLoopConvIds}
                  retryingConvIds={retryingConvIds}
                />
              )
            ) : (
              <ProjectSidebarList
                conversations={conversations}
                activeKey={activeChatKey}
                activeLoopConvIds={activeLoopConvIds}
                retryingConvIds={retryingConvIds}
                sortMode={projectSortMode}
                onManualOrder={() => changeProjectSort('manual')}
                onCreateTask={handleProjectNewTask}
                onEditProject={setProjectEditTarget}
                onOpenConversation={(key: string) => { navigate({ kind: 'chat' }); onSelectConversation(key) }}
                onDelete={onDeleteConversation}
                onRename={onRenameConversation}
                onTogglePin={onTogglePinConversation}
              />
            )}
          </div>
        </div>
        <div style={{ padding: '4px 8px 8px', display: 'flex', gap: 4, borderTop: '1px solid var(--pm-border-hairline)' }}>
          {/* Bottom entries: the theme toggle owns the left edge; the standard
              views (用量 / 设置) pin right via the auto margin on the first of them. */}
          <Tooltip title={themeMode === 'dark' ? t('appLayout.themeToLight') : t('appLayout.themeToDark')}>
            <Button
              type="text"
              className="sidebar-icon-btn"
              aria-label={themeMode === 'dark' ? t('appLayout.themeToLight') : t('appLayout.themeToDark')}
              icon={themeMode === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
              onClick={toggleTheme}
            />
          </Tooltip>
          <Tooltip title={t('sessionManager.statsTooltip')}>
            <Button
              type="text"
              style={{ marginLeft: 'auto' }}
              className={`sidebar-icon-btn${view.kind === 'usage' ? ' active-mode-btn' : ''}`}
              aria-label={t('sessionManager.statsTooltip')}
              icon={<BarChartOutlined style={{ fontSize: 16 }} />}
              onClick={() => navigateKind('usage')}
            />
          </Tooltip>
          <Tooltip title={t('menu.settings')}>
            <Button
              type="text"
              className={`sidebar-icon-btn${view.kind === 'settings' ? ' active-mode-btn' : ''}`}
              aria-label={t('menu.settings')}
              icon={<SettingOutlined style={{ fontSize: 16 }} />}
              onClick={() => navigateKind('settings')}
            />
          </Tooltip>
        </div>
      </Sider>

      <Layout style={{ minHeight: 0, overflow: 'hidden' }}>
        <Header
          style={{
            background: token.colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 24px',
            height: TITLE_BAR_HEIGHT,
            position: 'relative',
            zIndex: 1,
            WebkitAppRegion: 'drag'
          } as React.CSSProperties}
        >
          {/* Sidebar toggle at the left edge. */}
          <div style={{ position: 'absolute', left: 24 + headerLeft, display: 'flex', alignItems: 'center', gap: 12, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {sidebarToggle}
          </div>

          {/* Center content: the centers switcher when one of them is open, else
              the chat view's conversation title or every other view's own name —
              with, in the chat view, the side-window toggle right of the title.
              One flex group so the button hugs the title and both stay centered;
              the group itself carries the width clamp (the old per-span 55% would
              here clamp against the group, not the bar, and ellipsise early). */}
          {isCentersView ? (
            centersSwitcher
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '60%', minWidth: 0 }}>
              <span
                style={{
                  fontSize: FONT_SIZE.lg,
                  fontWeight: FONT_WEIGHT.semibold,
                  color: 'var(--pm-text)',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {view.kind === 'chat' ? (activeConvTitle || '') : t(VIEW_TITLE_KEY[view.kind])}
              </span>
              {/* The workbench pane only renders for an open conversation in the
                  chat view — hide the toggle when there is nothing to show.
                  Manual opens land on 工作区 (not the last-active tab); the
                  auto-open funnel (plan/browser/files) keeps its own tab. */}
              {view.kind === 'chat' && activeConvKey && (
                <Tooltip
                  title={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}
                >
                  <Button
                    type="text"
                    className={`header-pane-btn${workbenchOpen ? ' on' : ''}`}
                    aria-label={workbenchOpen ? t('appLayout.hideWorkbench') : t('appLayout.showWorkbench')}
                    icon={<PanelRightIcon size={16} filled={workbenchOpen} />}
                    onClick={() =>
                      workbenchOpen
                        ? useWorkbenchStore.getState().setOpen(wbKey, false)
                        : useWorkbenchStore.getState().openTab(wbKey, 'workspace')
                    }
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  />
                </Tooltip>
              )}
            </div>
          )}
        </Header>
        <Content
          style={{
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {/* Chat stays mounted; only the active view is visible. */}
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              display: view.kind === 'chat' ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden', minWidth: 0
            }}>
              <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                {children}
              </div>
            </div>
            {view.kind !== 'chat' && (
              <ViewHost
                knowledgeManager={knowledgeManager}
                memoryManager={memoryManager}
                skills={skills}
                onToggleSkill={onToggleSkill}
                tools={tools}
                onToggleTool={onToggleTool}
                onImportSkill={onImportSkill}
                onRefreshSkills={onRefreshSkills}
                onDeleteSkill={onDeleteSkill}
                importError={importError}
                onSelectConversation={onSelectConversation}
                onReloadConversations={onReloadConversations}
              />
            )}
          </div>
        </Content>
      </Layout>

      {/* Switcher-row actions' surfaces: the projects tab's create modal
          portals out of the sidebar. The same instance serves the project
          edit flow (sidebar row / welcome card) via `editing`. */}
      <ProjectModal
        open={projectModalOpen || projectEditTarget !== null}
        editing={projectEditTarget}
        onClose={() => {
          setProjectModalOpen(false)
          setProjectEditTarget(null)
        }}
        onSaved={(project) => {
          void reloadProjects()
          // Created (or directory-adopted, which reports the existing project):
          // jump straight into that project's new-task state — welcome page,
          // 项目 half of the capsule lit, the new project preselected. An edit
          // save reports no project and must not jump.
          if (project) handleProjectNewTask(project.id)
        }}
      />

      {/* Cmd/Ctrl+K palette: mounted like ProjectModal, always present so the
          accelerator works from any view; a closed Modal renders nothing. */}
      <CommandPalette items={paletteItems} />

      {/* Force antd's sider-children wrapper to be a flex column so our flex:1 on the conversation list works */}
      <style>{`
        .ant-layout-sider-children {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }

        /* 键盘可达性：Tab 焦点导航是开启的（浏览器只在 :focus-visible，即键盘
           焦点时画环）；鼠标点击留下的焦点环/描边在这里统一压掉。此前全应用
           在捕获阶段 preventDefault 一切 Tab（App.tsx），等于没有键盘导航 ——
           那条全局禁用已删除，这条规则是它的替代品，而不是又一处遮挡。 */
        :focus:not(:focus-visible) {
          outline: none;
        }
        .ant-switch:focus:not(:focus-visible) {
          box-shadow: none;
        }

        /* The Sider paints SIDEBAR_BACKGROUND; this wrapper covers the whole Sider,
           so it must stay transparent or its own fill would hide the gradient. */
        .ant-layout-sider-children {
          background: transparent;
        }

        /* Primary buttons, checked switches, active tabs and the like take the
           brand ink from the antd theme (colorPrimary) — there is deliberately
           no !important paint here: the blunt override used to erase antd's own
           hover and disabled states app-wide, which is how a disabled circle
           once painted byte-for-byte like an enabled one. The send circle's
           disabled fill is re-pinned in Composer's own scoped rules, the one
           place the dim language is "solid fill at reduced opacity". */

        .new-chat-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-ink) !important;
          display: flex !important;
          justify-content: flex-start !important;
          align-items: center !important;
          width: 100% !important;
          height: 40px !important;
          font-weight: 600 !important;
          padding-left: 8px !important;
        }
        .new-chat-btn:hover {
          background: var(--pm-veil) !important;
        }
        .new-chat-btn.active-mode-btn {
          background: var(--pm-veil-strong) !important;
        }
        .new-chat-btn .ant-btn-icon {
          margin-inline-end: 4px !important;
        }

        /* Sidebar bottom: icon-only entries (settings/about). */
        .sidebar-icon-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-ink) !important;
          width: 32px !important;
          height: 32px !important;
          padding: 0 !important;
          border-radius: 6px !important;
        }
        .sidebar-icon-btn:hover {
          background: var(--pm-veil) !important;
        }
        /* The open view (settings/usage/about) keeps its entry highlighted. */
        .sidebar-icon-btn.active-mode-btn {
          background: var(--pm-veil-strong) !important;
        }

        /* History area switcher: a shared light-gray pill track, sized to the
           labels; the open tab is a black pill with white text. */
        .sidebar-list-track {
          display: inline-flex;
          align-items: center;
          margin: 10px 12px 6px;
          padding: 2px;
          background: var(--pm-hover);
          border-radius: 999px;
        }
        .sidebar-list-tab {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-text-secondary) !important;
          font-weight: 600 !important;
          font-size: 13px !important;
          height: 24px !important;
          padding: 0 14px !important;
          border-radius: 999px !important;
        }
        .sidebar-list-tab:hover {
          background: transparent !important;
          color: var(--pm-ink) !important;
        }
        .sidebar-list-tab.on,
        .sidebar-list-tab.on:hover {
          color: var(--pm-ink-contrast) !important;
          background: var(--pm-ink) !important;
        }
        /* Windows: antd centers the label's *line box*, but where the glyphs sit
           inside that box is decided by the font — Microsoft YaHei's
           ascent/descent asymmetry parks CJK faces ~1px below the optical
           center (PingFang on macOS reads centered), so the 对话/项目 labels
           sat low in the pill. Lift the label 1px under Windows only; the hook
           is the data-platform attribute index.html stamps before React mounts. */
        html[data-platform='win32'] .sidebar-list-tab > span {
          position: relative;
          top: -1px;
        }

        /* Switcher-row actions (管理 / 新增): quiet icon buttons that match the
           pill track's scale; the disabled 新增 keeps the session-cap state visible. */
        .sidebar-list-action {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-text-secondary) !important;
          width: 26px !important;
          height: 26px !important;
          padding: 0 !important;
          border-radius: 6px !important;
        }
        .sidebar-list-action .ant-btn-icon {
          margin-inline-end: 0 !important;
        }
        .sidebar-list-action:hover {
          background: var(--pm-hover) !important;
          color: var(--pm-ink) !important;
        }
        .sidebar-list-action:disabled {
          color: var(--pm-text-disabled) !important;
        }

        /* Title bar's side-window toggle: a borderless icon right of the title.
           No background in any state (base, hover, open) — the open state reads
           from the darker icon colour alone. */
        .header-pane-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-text-muted) !important;
          width: 28px !important;
          height: 28px !important;
          padding: 0 !important;
          border-radius: 6px !important;
        }
        .header-pane-btn .ant-btn-icon {
          margin-inline-end: 0 !important;
        }
        .header-pane-btn:hover {
          background: transparent !important;
          color: var(--pm-ink) !important;
        }
        .header-pane-btn.on,
        .header-pane-btn.on:hover {
          background: transparent !important;
          color: var(--pm-ink) !important;
        }

        .settings-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .settings-scroll::-webkit-scrollbar-thumb {
          background: var(--pm-scrollbar);
          border-radius: 3px;
        }
        .settings-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--pm-scrollbar-active);
        }

        .knowledge-header-tabs {
          align-self: flex-end;
        }
        .knowledge-header-tabs > .ant-tabs-nav {
          margin-bottom: 0 !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-tab-active .ant-tabs-tab-btn {
          color: var(--pm-ink) !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-tab:hover .ant-tabs-tab-btn {
          color: var(--pm-ink) !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-ink-bar {
          background: var(--pm-ink) !important;
        }

        /* Centers switcher: plain text buttons, the active one black with white
           text. Scoped here so the sidebar's gray .active-mode-btn stays as is. */
        .centers-switch-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: var(--pm-text-strong) !important;
          font-weight: 600 !important;
          height: 30px !important;
          padding: 0 12px !important;
        }
        .centers-switch-btn:hover {
          background: var(--pm-hover) !important;
          color: var(--pm-ink) !important;
        }
        .centers-switch-btn.active-mode-btn {
          background: var(--pm-ink) !important;
          color: var(--pm-ink-contrast) !important;
        }

        /* 时间选择面板（TimePicker 的时/分列）滚到底不再露出大块空白：antd v6
           给每列画一个 ::after 滚动余量（高度 = 列高 − 单元格高，date-picker
           style/panel.js），为了让选中值能顶到列首 —— 代价是滚到底时露出近
           一整列的空白（用户 2026-09-24）。压掉余量后，滚到底正好显示最后
           几行；选中的值照常可见，只是不再强行顶对齐。作用域带
           .ant-picker-dropdown 是实测出的取胜权重：不带前缀的裸列选择器
           压不过 antd 自己的规则（实测对比过）。 */
        .ant-picker-dropdown .ant-picker-time-panel-column::after {
          height: 0;
        }
      `}</style>
    </Layout>
  )
}

export default AppLayout
