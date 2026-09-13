import React, { useState } from 'react'
import { Layout, Button, theme, Switch, Tooltip } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import {
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  InfoCircleOutlined,
  BarChartOutlined
} from '@ant-design/icons'
import ConversationSidebar from './ConversationSidebar'
import ProjectSidebarList from './ProjectSidebarList'
import SidebarNav from './SidebarNav'
import { ViewHost } from './ViewHost'
import { TITLE_BAR_HEIGHT } from '../../../../shared/window-chrome'
import { CENTERS_SUBMENU, VIEW_TITLE_KEY } from '../../navigation/registry'
import { useNavigationStore } from '../../stores/navigationStore'
import type { ConversationListItem } from '../../types/conversation'
import type { MemoryManager } from '../../memory/MemoryManager'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'

const { Header, Sider, Content } = Layout
const MAX_SESSIONS = 100

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

// With the sidebar collapsed the header starts at the window's left edge, where the
// window controls sit, so its content has to clear them.
const headerLeftInset = (collapsed: boolean): number => (collapsed && CONTROLS_ON_LEFT ? windowControls.inset : 0)

interface AppLayoutProps {
  children?: React.ReactNode
  conversations: ConversationListItem[]
  activeConversationKey: string | Symbol | undefined
  /** Session-cap inputs: creating is capped unless auto-cleanup is on. */
  totalSessions: number
  autoCleanup: boolean
  onCreateNew: () => void
  onDeleteConversation: (key: string) => void
  onRenameConversation: (key: string, newLabel: string) => void
  onSelectConversation: (key: string) => void
  onTogglePinConversation: (key: string, pinned: boolean) => void
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  memoryManager?: MemoryManager
  knowledgeManager?: KnowledgeManager
  yoloMode?: boolean
  onToggleYoloMode?: (checked: boolean) => void
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  /** Create a conversation bound to a project (from ProjectView). */
  onCreateProjectConversation?: (projectId: string) => void
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
  tools,
  onToggleTool,
  skills,
  onToggleSkill,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError,
  memoryManager,
  knowledgeManager,
  yoloMode,
  onToggleYoloMode,
  activeLoopConvIds,
  retryingConvIds,
  onCreateProjectConversation,
  children
}: AppLayoutProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)
  const navigateKind = useNavigationStore((s) => s.navigateKind)

  // The history area's tab: the conversation list or the project list.
  const [listTab, setListTab] = useState<'chats' | 'projects'>('chats')
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const canCreateNew = autoCleanup || totalSessions < MAX_SESSIONS
  const activeConvTitle = typeof activeConversationKey === 'string'
    ? conversations.find((c) => c.key === activeConversationKey)?.label
    : undefined
  // Sidebar highlight key: only while a chat view is open. Both history tabs
  // (对话 and 项目) take it, so the open conversation reads as active in either.
  const activeChatKey = view.kind === 'chat' && typeof activeConversationKey === 'string'
    ? activeConversationKey
    : undefined

  // With the sidebar collapsed the header starts at the window's left edge, so the
  // macOS traffic lights land on it and its content has to move out of their way.
  const headerLeft = headerLeftInset(collapsed)

  // The three centers share one page (D4a revision); their switcher lives in the
  // header, right of the sidebar toggle, and the tab is the view kind itself.
  // The switcher doubles as the page title, so the centered header title is skipped.
  // Plain buttons driven by the registry's centers submenu — one data source for the
  // sidebar flyout and this switcher, and no antd-internal styling to fight.
  const isCentersView = view.kind === 'capability' || view.kind === 'knowledge' || view.kind === 'tools'
  const centersSwitcher = isCentersView ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}`, background: '#F8F8F8' }}>
        {/* Space for the macOS traffic lights; the sidebar title deliberately sits below
            them. Not rendered elsewhere, where the sidebar starts at the top. */}
        {SIDEBAR_TOP_BAND_HEIGHT > 0 && (
          <div style={{ height: SIDEBAR_TOP_BAND_HEIGHT, flexShrink: 0, WebkitAppRegion: 'drag' } as React.CSSProperties} />
        )}
        {/* Sidebar header; the title and the switch opt out of dragging. */}
        <div style={{
          padding: `${SIDEBAR_TITLE_PADDING_TOP}px 16px 8px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000', cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => navigateKind('about')}>
            {t('appLayout.title')}
          </div>
          <Switch
            checked={yoloMode}
            onChange={onToggleYoloMode}
            checkedChildren={t('appLayout.yoloMode')}
            unCheckedChildren={t('appLayout.yoloMode')}
            size="small"
            className={yoloMode ? 'yolo-switch-on' : ''}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          />
        </div>
        <SidebarNav canCreateNew={canCreateNew} onCreateNew={onCreateNew} />
        {/* Tab switcher is pinned; only the list below it scrolls. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* alignSelf: the track is a pill sized to its labels (inline-flex in
              the stylesheet); as a flex child it would otherwise stretch full-width. */}
          <div className="sidebar-list-track" style={{ flexShrink: 0, alignSelf: 'flex-start' }}>
            <Button type="text" className={`sidebar-list-tab${listTab === 'chats' ? ' on' : ''}`} onClick={() => setListTab('chats')}>
              {t('appLayout.listTabChats')}
            </Button>
            <Button type="text" className={`sidebar-list-tab${listTab === 'projects' ? ' on' : ''}`} onClick={() => setListTab('projects')}>
              {t('appLayout.listTabProjects')}
            </Button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {listTab === 'chats' ? (
              conversations.length === 0 ? (
                <div style={{ padding: '16px 0', color: '#999', fontSize: 12, textAlign: 'center' }}>
                  {t('appLayout.noConversations')}
                </div>
              ) : (
                <ConversationSidebar
                conversations={conversations}
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
                onOpenProject={(projectId) => navigate({ kind: 'project', projectId })}
                onOpenConversation={(key: string) => { navigate({ kind: 'chat' }); onSelectConversation(key) }}
                onDelete={onDeleteConversation}
                onRename={onRenameConversation}
                onTogglePin={onTogglePinConversation}
              />
            )}
          </div>
        </div>
        <div style={{ padding: '4px 8px 8px', display: 'flex', gap: 4, borderTop: '1px solid #f0f0f0' }}>
          {/* Bottom entries navigate to standard views (the former modal/drawers). */}
          <Tooltip title={t('menu.settings')}>
            <Button
              type="text"
              className={`sidebar-icon-btn${view.kind === 'settings' ? ' active-mode-btn' : ''}`}
              aria-label={t('menu.settings')}
              icon={<SettingOutlined style={{ fontSize: 16 }} />}
              onClick={() => navigateKind('settings')}
            />
          </Tooltip>
          <Tooltip title={t('sessionManager.statsTooltip')}>
            <Button
              type="text"
              className={`sidebar-icon-btn${view.kind === 'usage' ? ' active-mode-btn' : ''}`}
              aria-label={t('sessionManager.statsTooltip')}
              icon={<BarChartOutlined style={{ fontSize: 16 }} />}
              onClick={() => navigateKind('usage')}
            />
          </Tooltip>
          <Tooltip title={t('menu.about')}>
            <Button
              type="text"
              className={`sidebar-icon-btn${view.kind === 'about' ? ' active-mode-btn' : ''}`}
              aria-label={t('menu.about')}
              icon={<InfoCircleOutlined style={{ fontSize: 16 }} />}
              onClick={() => navigateKind('about')}
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
          {/* Sidebar toggle, then the centers switcher when one of them is open. */}
          <div style={{ position: 'absolute', left: 24 + headerLeft, display: 'flex', alignItems: 'center', gap: 12, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {sidebarToggle}
            {centersSwitcher}
          </div>

          {/* Center content: the chat view shows the conversation title, every other
              view shows its own name. Skipped for the centers page — its switcher
              switcher already says which center is open. */}
          {!isCentersView && (
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: '#333',
                maxWidth: '55%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {view.kind === 'chat' ? (activeConvTitle || '') : t(VIEW_TITLE_KEY[view.kind])}
            </span>
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
                tools={tools}
                skills={skills}
                onToggleSkill={onToggleSkill}
                onImportSkill={onImportSkill}
                onRefreshSkills={onRefreshSkills}
                onDeleteSkill={onDeleteSkill}
                importError={importError}
                conversations={conversations}
                onSelectConversation={onSelectConversation}
                onCreateProjectConversation={onCreateProjectConversation}
              />
            )}
          </div>
        </Content>
      </Layout>

      {/* Force antd's sider-children wrapper to be a flex column so our flex:1 on the conversation list works */}
      <style>{`
        .ant-layout-sider-children {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
        }

        .yolo-switch-on {
          background: #52c41a !important;
        }
        .yolo-switch-on .ant-switch-handle::before {
          background-color: #fff !important;
        }
        .ant-switch:focus-visible {
          outline: none;
        }

        .ant-layout-sider-children {
          background: #F8F8F8;
        }

        .ant-btn-primary {
          background: #000 !important;
          border-color: #000 !important;
          color: #fff !important;
        }
        .ant-btn-primary:hover {
          background: #333 !important;
          border-color: #333 !important;
        }

        .ant-switch.ant-switch-checked {
          background: #000 !important;
        }
        .ant-switch.ant-switch-checked:hover {
          background: #333 !important;
        }

        .new-chat-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: #000 !important;
          display: flex !important;
          justify-content: flex-start !important;
          align-items: center !important;
          width: 100% !important;
          height: 40px !important;
          font-weight: 600 !important;
          padding-left: 8px !important;
        }
        .new-chat-btn:hover {
          background: rgba(0, 0, 0, 0.06) !important;
        }
        .new-chat-btn.active-mode-btn {
          background: rgba(0, 0, 0, 0.08) !important;
        }
        .new-chat-btn .ant-btn-icon {
          margin-inline-end: 4px !important;
        }

        /* Sidebar bottom: icon-only entries (settings/about). */
        .sidebar-icon-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: #000 !important;
          width: 32px !important;
          height: 32px !important;
          padding: 0 !important;
          border-radius: 6px !important;
        }
        .sidebar-icon-btn:hover {
          background: rgba(0, 0, 0, 0.06) !important;
        }
        /* The open view (settings/usage/about) keeps its entry highlighted. */
        .sidebar-icon-btn.active-mode-btn {
          background: rgba(0, 0, 0, 0.08) !important;
        }

        /* History area switcher: a shared light-gray pill track, sized to the
           labels; the open tab is a black pill with white text. */
        .sidebar-list-track {
          display: inline-flex;
          align-items: center;
          margin: 10px 12px 6px;
          padding: 2px;
          background: rgba(0, 0, 0, 0.06);
          border-radius: 999px;
        }
        .sidebar-list-tab {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: #666 !important;
          font-weight: 600 !important;
          font-size: 13px !important;
          height: 24px !important;
          padding: 0 14px !important;
          border-radius: 999px !important;
        }
        .sidebar-list-tab:hover {
          background: transparent !important;
          color: #000 !important;
        }
        .sidebar-list-tab.on,
        .sidebar-list-tab.on:hover {
          color: #fff !important;
          background: #000 !important;
        }

        .settings-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .settings-scroll::-webkit-scrollbar-thumb {
          background: #d0d0d0;
          border-radius: 3px;
        }
        .settings-scroll::-webkit-scrollbar-thumb:hover {
          background: #b0b0b0;
        }

        .knowledge-header-tabs {
          align-self: flex-end;
        }
        .knowledge-header-tabs > .ant-tabs-nav {
          margin-bottom: 0 !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-tab-active .ant-tabs-tab-btn {
          color: #000 !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-tab:hover .ant-tabs-tab-btn {
          color: #000 !important;
        }
        .knowledge-header-tabs > .ant-tabs-nav .ant-tabs-ink-bar {
          background: #000 !important;
        }

        /* Centers switcher: plain text buttons, the active one black with white
           text. Scoped here so the sidebar's gray .active-mode-btn stays as is. */
        .centers-switch-btn {
          background: transparent !important;
          border: none !important;
          box-shadow: none !important;
          color: #333 !important;
          font-weight: 600 !important;
          height: 30px !important;
          padding: 0 12px !important;
        }
        .centers-switch-btn:hover {
          background: rgba(0, 0, 0, 0.06) !important;
          color: #000 !important;
        }
        .centers-switch-btn.active-mode-btn {
          background: #000 !important;
          color: #fff !important;
        }
      `}</style>
    </Layout>
  )
}

export default AppLayout
