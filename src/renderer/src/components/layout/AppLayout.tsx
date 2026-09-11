import React, { useState, useCallback } from 'react'
import { Layout, Button, theme, Switch, Modal, Tooltip } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import {
  SettingOutlined,
  MessageOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  StarOutlined,
  BookOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
  DesktopOutlined,
  ApartmentOutlined,
  ExperimentOutlined,
  ApiOutlined
} from '@ant-design/icons'
import ConversationSidebar from './ConversationSidebar'
import { AppMenu } from './AppMenu'
import { ViewHost } from './ViewHost'
import { TITLE_BAR_HEIGHT } from '../../../../shared/window-chrome'
import { VIEW_TITLE_KEY } from '../../navigation/registry'
import { useNavigationStore } from '../../stores/navigationStore'
import SessionManager from './SessionManager'
import StatisticsDrawer from './StatisticsDrawer'
import LlmSettings from '../settings/LlmSettings'
import ToolsSettings from '../settings/ToolSettings'
import SkillsSettings from '../settings/SkillSettings'
import SubAgentSettings from '../settings/SubAgentSettings'
import AgentSettings from '../settings/AgentSettings'
import MemorySettings from '../settings/MemorySettings'
import EnvironmentSettings from '../settings/EnvironmentSettings'
import FavoritesSettings from '../settings/FavoritesSettings'
import AboutSettings from '../settings/AboutSettings'
import MCPSettings from '../settings/MCPSettings'
import ExperiencePanel from '../settings/ExperiencePanel'
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
  totalSessions: number
  autoCleanup: boolean
  onClearAllConversations: () => Promise<void>
  onToggleAutoCleanup: (checked: boolean) => void
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
}

function AppLayout({
  conversations,
  activeConversationKey,
  totalSessions,
  autoCleanup,
  onClearAllConversations,
  onToggleAutoCleanup,
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
  children
}: AppLayoutProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<string>('environment')
  const [statisticsOpen, setStatisticsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const canCreateNew = autoCleanup || totalSessions < MAX_SESSIONS
  const activeConvTitle = typeof activeConversationKey === 'string'
    ? conversations.find((c) => c.key === activeConversationKey)?.label
    : undefined

  // Inject layout-owned callbacks into children (onOpenSettings, onOpenAbout)
  const childrenWithLayoutProps = React.isValidElement(children)
    ? React.cloneElement(children, {
        onOpenSettings: () => { setSettingsView('settings'); setSettingsOpen(true) },
        onOpenAbout: () => setAboutOpen(true)
      } as Record<string, unknown>)
    : children

  const renderSettingsView = useCallback((key: string) => {
    switch (key) {
      case 'favorites':
        return <FavoritesSettings inline open onClose={() => setSettingsView('favorites')} />
      case 'memory':
        return memoryManager ? <MemorySettings inline open onClose={() => setSettingsView('favorites')} memoryManager={memoryManager} /> : null
      case 'skills':
        return (
          <SkillsSettings
            inline open onClose={() => setSettingsView('favorites')}
            skills={skills || []}
            onToggleSkill={onToggleSkill || (() => {})}
            onImportSkill={onImportSkill}
            onRefreshSkills={onRefreshSkills}
            onDeleteSkill={onDeleteSkill}
            importError={importError}
          />
        )
      case 'experiences':
        return <ExperiencePanel inline open onClose={() => setSettingsView('favorites')} />
      case 'tools':
        return (
          <ToolsSettings
            inline open onClose={() => setSettingsView('favorites')}
            tools={tools || []}
            onToggleTool={onToggleTool || (() => {})}
          />
        )
      case 'assistant':
        return <AgentSettings inline open onClose={() => setSettingsView('favorites')} />
      case 'settings':
        return <LlmSettings inline open onClose={() => {}} />
      case 'subagent':
        return (
          <SubAgentSettings
            inline open onClose={() => setSettingsView('favorites')}
            tools={tools}
            skills={skills}
          />
        )
      case 'mcp':
        return <MCPSettings inline open onClose={() => setSettingsView('favorites')} />
      case 'environment':
        return <EnvironmentSettings inline open onClose={() => setSettingsView('favorites')} />
      default:
        return null
    }
  }, [skills, onToggleSkill, onImportSkill, onRefreshSkills, onDeleteSkill, importError, tools, onToggleTool, memoryManager])

  // With the sidebar collapsed the header starts at the window's left edge, so the
  // macOS traffic lights land on it and its content has to move out of their way.
  const headerLeft = headerLeftInset(collapsed)

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
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000', cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => setAboutOpen(true)}>
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
        <div style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Button className="new-chat-btn" onClick={() => { navigate({ kind: 'chat' }); onCreateNew() }} icon={<MessageOutlined style={{ fontSize: 18 }} />} disabled={!canCreateNew}>
            {t('appLayout.newChat')}
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {conversations.length > 0 && (
          <div style={{ padding: '10px 16px 5px', color: '#999', fontSize: 12 }}>
            {t('appLayout.conversationHistory')}
          </div>
          )}
          <ConversationSidebar
            conversations={conversations}
            activeKey={view.kind === 'chat' ? activeConversationKey : undefined}
            onSelect={(key: string) => { navigate({ kind: 'chat' }); onSelectConversation(key) }}
            onDelete={onDeleteConversation}
            onRename={onRenameConversation}
            onTogglePin={onTogglePinConversation}
            activeLoopConvIds={activeLoopConvIds}
            retryingConvIds={retryingConvIds}
          />
        </div>
        <SessionManager
          totalSessions={totalSessions}
          autoCleanup={autoCleanup}
          onClearAll={onClearAllConversations}
          onToggleAutoCleanup={onToggleAutoCleanup}
          onOpenStatistics={() => setStatisticsOpen(true)}
        />
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
          {/* App menu + sidebar toggle. */}
          <div style={{ position: 'absolute', left: 12 + headerLeft, display: 'flex', alignItems: 'center', gap: 2, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <AppMenu
              onCreateNew={() => { navigate({ kind: 'chat' }); onCreateNew() }}
              onOpenSettings={() => { setSettingsView('settings'); setSettingsOpen(true) }}
              onOpenAbout={() => setAboutOpen(true)}
            />
            {sidebarToggle}
          </div>

          {/* Center content: the chat view shows the conversation title, every other
              view shows its own name. */}
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
                {childrenWithLayoutProps}
              </div>
            </div>
            {view.kind !== 'chat' && (
              <ViewHost knowledgeManager={knowledgeManager} />
            )}
          </div>
        </Content>
      </Layout>

      <Modal
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        width={700}
        closable={false}
        style={{ top: 60 }}
      >
        <div style={{ display: 'flex', height: 520 }}>
          {/* Left sidebar menu */}
          <div style={{ width: 150, flexShrink: 0, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}>
            <div style={{ paddingRight: 8, overflow: 'auto', flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[
                { key: 'environment', icon: <DesktopOutlined />, label: t('appLayout.environment') },
                { key: 'settings', icon: <SettingOutlined />, label: t('appLayout.settings') },
                { key: 'assistant', icon: <UserOutlined />, label: t('appLayout.assistant') },
                { key: 'tools', icon: <ToolOutlined />, label: t('appLayout.tools') },
                { key: 'subagent', icon: <ApartmentOutlined />, label: '子代理' },
                { key: 'mcp', icon: <ApiOutlined />, label: t('appLayout.mcp') },
                { key: 'skills', icon: <ThunderboltOutlined />, label: t('appLayout.skills') },
                { key: 'experiences', icon: <ExperimentOutlined />, label: '经验' },
                { key: 'memory', icon: <BookOutlined />, label: t('appLayout.memory') },
                { key: 'favorites', icon: <StarOutlined />, label: t('appLayout.favorites') },
              ].map((item) => (
                <div
                  key={item.key}
                  onClick={() => setSettingsView(item.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 13, color: '#333', transition: 'background 0.15s',
                    background: settingsView === item.key ? '#f0f0f0' : 'transparent'
                  }}
                  onMouseEnter={(e) => {
                    if (settingsView !== item.key) e.currentTarget.style.background = '#f5f5f5'
                  }}
                  onMouseLeave={(e) => {
                    if (settingsView !== item.key) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
            </div>

            <div style={{ padding: '16px 12px 8px', fontSize: 11, color: '#bbb', textAlign: 'left' }}>
              PulseMind v{__APP_VERSION__}
            </div>
          </div>

          {/* Right content area */}
          <div style={{ flex: 1, overflow: 'auto' }} className="settings-scroll">
            <div style={{ padding: '0 20px' }}>
              {renderSettingsView(settingsView)}
            </div>
          </div>
        </div>
      </Modal>

      <StatisticsDrawer
        open={statisticsOpen}
        onClose={() => setStatisticsOpen(false)}
      />
      <AboutSettings
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
      />

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
      `}</style>
    </Layout>
  )
}

export default AppLayout
