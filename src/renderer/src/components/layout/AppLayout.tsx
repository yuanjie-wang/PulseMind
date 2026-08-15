import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Layout, Button, theme, Switch, Modal, Tooltip, Progress, Dropdown } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import {
  ApiOutlined,
  SettingOutlined,
  MessageOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LayoutOutlined,
  StarOutlined,
  BookOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
  DesktopOutlined,
  DatabaseOutlined,
  PlusOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  LinkOutlined,
  ClearOutlined,
  LoadingOutlined,
  ApartmentOutlined,
  ExperimentOutlined
} from '@ant-design/icons'
import ConversationSidebar from './ConversationSidebar'
import { ContextRing, estimateContextUsed } from '../chat/ContextRing'
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
import CanvasView from '../canvas/CanvasView'
import CanvasToolbar from '../canvas/CanvasToolbar'
import KnowledgePanel from '../knowledge/KnowledgePanel'
import type { KnowledgePanelHandle, KnowledgePanelState } from '../knowledge/KnowledgePanel'
import type { AgentMessage } from '../../types/agent'
import type { MemoryManager } from '../../memory/MemoryManager'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'

const { Header, Sider, Content } = Layout
const MAX_SESSIONS = 100

interface AppLayoutProps {
  children?: React.ReactNode
  conversations: Array<{ key: string; label: string }>
  activeConversationKey: string | Symbol | undefined
  totalSessions: number
  autoCleanup: boolean
  onClearAllConversations: () => Promise<void>
  onToggleAutoCleanup: (checked: boolean) => void
  messages: AgentMessage[]
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
  contextLength?: number
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
  onViewChange?: (view: 'chat' | 'canvas' | 'knowledge') => void
}

function AppLayout({
  conversations,
  activeConversationKey,
  totalSessions,
  autoCleanup,
  onClearAllConversations,
  onToggleAutoCleanup,
  messages,
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
  contextLength,
  activeLoopConvIds,
  retryingConvIds,
  onViewChange,
  children
}: AppLayoutProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false)
  const [canvasMode, setCanvasMode] = useState(false)
  const [knowledgeMode, setKnowledgeMode] = useState(false)

  // Notify parent of view changes
  useEffect(() => {
    const view = canvasMode ? 'canvas' : knowledgeMode ? 'knowledge' : 'chat'
    onViewChange?.(view)
  }, [canvasMode, knowledgeMode, onViewChange])

  const handleCanvasClearAll = useCallback(() => {
    window.electronAPI.canvasClearAll().catch((err: unknown) =>
      console.warn('[AppLayout] Failed to clear all canvas data:', err)
    )
  }, [])

  const knowledgeRef = useRef<KnowledgePanelHandle>(null)
  const [knowledgeState, setKnowledgeState] = useState<KnowledgePanelState | null>(null)

  // ── Import progress bar fade-out ──
  const lastImportRef = useRef<{ current: number; total: number } | null>(null)
  const [displayImport, setDisplayImport] = useState<{ current: number; total: number } | null>(null)
  const [importFading, setImportFading] = useState(false)
  const importFadeTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (knowledgeState?.importProgress) {
      lastImportRef.current = knowledgeState.importProgress
      setDisplayImport(knowledgeState.importProgress)
      setImportFading(false)
      if (importFadeTimer.current) clearTimeout(importFadeTimer.current)
    } else if (lastImportRef.current && !knowledgeState?.isImporting) {
      lastImportRef.current = null
      setImportFading(true)
      importFadeTimer.current = setTimeout(() => {
        setDisplayImport(null)
        setImportFading(false)
      }, 1000)
    }
    return () => { if (importFadeTimer.current) clearTimeout(importFadeTimer.current) }
  }, [knowledgeState?.importProgress, knowledgeState?.isImporting])

  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<string>('environment')
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
        onOpenSettings: () => { setView('settings'); setMenuOpen(true) },
        onOpenAbout: () => setAboutOpen(true)
      } as Record<string, unknown>)
    : children

  // ── Context usage: use real token counts from API, fall back to estimation ──
  const contextUsed = React.useMemo(() => estimateContextUsed(messages), [messages])

  const renderView = useCallback((key: string) => {
    switch (key) {
      case 'favorites':
        return <FavoritesSettings inline open onClose={() => setView('favorites')} />
      case 'memory':
        return memoryManager ? <MemorySettings inline open onClose={() => setView('favorites')} memoryManager={memoryManager} /> : null
      case 'skills':
        return (
          <SkillsSettings
            inline open onClose={() => setView('favorites')}
            skills={skills || []}
            onToggleSkill={onToggleSkill || (() => {})}
            onImportSkill={onImportSkill}
            onRefreshSkills={onRefreshSkills}
            onDeleteSkill={onDeleteSkill}
            importError={importError}
          />
        )
      case 'experiences':
        return <ExperiencePanel inline open onClose={() => setView('favorites')} />
      case 'tools':
        return (
          <ToolsSettings
            inline open onClose={() => setView('favorites')}
            tools={tools || []}
            onToggleTool={onToggleTool || (() => {})}
          />
        )
      case 'assistant':
        return <AgentSettings inline open onClose={() => setView('favorites')} />
      case 'settings':
        return <LlmSettings inline open onClose={() => {}} />
      case 'subagent':
        return (
          <SubAgentSettings
            inline open onClose={() => setView('favorites')}
            tools={tools}
            skills={skills}
          />
        )
      case 'mcp':
        return <MCPSettings inline open onClose={() => setView('favorites')} />
      case 'environment':
        return <EnvironmentSettings inline open onClose={() => setView('favorites')} />
      default:
        return null
    }
  }, [knowledgeManager, skills, onToggleSkill, onImportSkill, onDeleteSkill, importError, tools, onToggleTool, memoryManager])

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={250}
        collapsedWidth={0}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
        trigger={null}
        style={{ borderRight: `1px solid ${token.colorBorderSecondary}`, background: '#F8F8F8' }}>
        {/* Sidebar header */}
        <div style={{ padding: '20px 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000', cursor: 'pointer' }} onClick={() => setAboutOpen(true)}>
            {t('appLayout.title')}
          </div>
          <Switch
            checked={yoloMode}
            onChange={onToggleYoloMode}
            checkedChildren={t('appLayout.yoloMode')}
            unCheckedChildren={t('appLayout.yoloMode')}
            size="small"
            className={yoloMode ? 'yolo-switch-on' : ''}
          />
        </div>
        <div style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Button className="new-chat-btn" onClick={() => { setCanvasMode(false); setKnowledgeMode(false); onCreateNew() }} icon={<MessageOutlined style={{ fontSize: 18 }} />} disabled={!canCreateNew}>
            {t('appLayout.newChat')}
          </Button>
          <Button className={`new-chat-btn${canvasMode ? ' active-mode-btn' : ''}`} icon={<LayoutOutlined style={{ fontSize: 18 }} />} onClick={() => { setCanvasMode(true); setKnowledgeMode(false) }}>
            {t('appLayout.newCanvas')}
          </Button>
          <Button className={`new-chat-btn${knowledgeMode ? ' active-mode-btn' : ''}`} icon={<DatabaseOutlined style={{ fontSize: 18 }} />} onClick={() => { setCanvasMode(false); setKnowledgeMode(true) }}>
            {t('appLayout.knowledgeManagement')}
          </Button>
          <Button className="new-chat-btn" icon={<SettingOutlined style={{ fontSize: 18 }} />} onClick={() => setMenuOpen(true)}>
            {t('appLayout.functionSettings')}
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
            activeKey={canvasMode || knowledgeMode ? undefined : activeConversationKey}
            onSelect={(key: string) => { setCanvasMode(false); setKnowledgeMode(false); onSelectConversation(key) }}
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
            height: 56,
            position: 'relative',
            zIndex: 1
          }}
        >
          {/* Collapse button — always at the far left */}
          <div style={{ position: 'absolute', left: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
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
              />
            </Tooltip>
            {knowledgeMode && (
              <>
                <Dropdown
                  menu={{
                    items: [
                      { key: 'file', icon: <FileTextOutlined />, label: '导入文件', onClick: () => knowledgeRef.current?.handleAddFile() },
                      { key: 'folder', icon: <FolderOpenOutlined />, label: '导入文件夹', onClick: () => knowledgeRef.current?.handleAddFolder() },
                      { key: 'url', icon: <LinkOutlined />, label: '导入链接', onClick: () => knowledgeRef.current?.setShowUrlInput(true) },
                    ]
                  }}
                  placement="bottomLeft"
                  trigger={['click']}
                >
                  <Tooltip title="导入知识">
                    <Button type="text" icon={<PlusOutlined style={{ fontSize: 16 }} />} />
                  </Tooltip>
                </Dropdown>
                <Tooltip title="打开知识库目录">
                  <Button type="text" icon={<FolderOpenOutlined style={{ fontSize: 16 }} />} onClick={async () => {
                    const { knowledgeDir } = await window.electronAPI.getDataPaths()
                    await window.electronAPI.openFolder(knowledgeDir)
                  }} />
                </Tooltip>
                <Tooltip title="重置知识库">
                  <Button type="text" icon={<ClearOutlined style={{ fontSize: 16 }} />} onClick={() => knowledgeRef.current?.handleReset()} />
                </Tooltip>
              </>
            )}
          </div>

          {/* Center content */}
          {canvasMode ? (
            <CanvasToolbar onClearAll={handleCanvasClearAll} />
          ) : knowledgeMode ? (
            <span style={{ fontSize: 15, fontWeight: 600, color: '#333' }}>{t('appLayout.knowledgeManagement')}</span>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 600, color: '#333', maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeConvTitle || ''}
            </span>
          )}

          {/* Right side: stats summary / import progress bar */}
          {knowledgeMode ? (
            <div style={{ position: 'absolute', right: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
              {displayImport ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: importFading ? 0 : 1, transition: 'opacity 0.6s ease' }}>
                  <LoadingOutlined style={{ color: '#000', fontSize: 14, marginRight: 10 }} />
                  <div style={{ position: 'relative', width: 140, height: 4 }}>
                    {displayImport.total > 0 && (
                      <Progress
                        percent={Math.round((displayImport.current / displayImport.total) * 100)}
                        size="small"
                        strokeColor="#52c41a"
                        status="active"
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, margin: 0, lineHeight: 1 }}
                        format={() => ''}
                      />
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: '#999', whiteSpace: 'nowrap' }}>
                    {`${displayImport.current}/${displayImport.total}`}
                  </span>
                </div>
              ) : knowledgeState?.stats ? (
                <Tooltip title={<span style={{ fontSize: 11 }}>源文件总数 / 已编译文件数 / Wiki页面数</span>} align={{ offset: [-10, 10] }}>
                  <span style={{ fontSize: 12, color: '#bbb', cursor: 'pointer', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {knowledgeState.stats.total}/{knowledgeState.stats.compiled}/{knowledgeState.stats.wikiFileCount}
                  </span>
                </Tooltip>
              ) : <span style={{ width: 32 }} />}
            </div>
          ) : !canvasMode && messages.length > 0 && contextLength != null && contextLength > 0 ? (
            <div style={{ position: 'absolute', right: 24, lineHeight: 0 }}>
              <ContextRing used={contextUsed} total={contextLength} />
            </div>
          ) : null}
        </Header>
        <Content
          style={{
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {/* Single filler div — all views mounted simultaneously, only active visible */}
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            {/* Chat */}
            <div style={{
              height: '100%',
              display: canvasMode || knowledgeMode ? 'none' : 'flex',
              flexDirection: 'column',
              overflow: 'hidden', minWidth: 0
            }}>
              <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                {childrenWithLayoutProps}
              </div>
            </div>
            {/* Canvas (conditionally rendered — Zustand store persists state across mount/unmount) */}
            {canvasMode && (
              <div style={{ height: '100%', overflow: 'hidden' }}>
                <CanvasView />
              </div>
            )}
            {/* Knowledge (conditionally rendered) */}
            {knowledgeMode && knowledgeManager && (
              <div style={{ height: '100%', overflow: 'auto', padding: 24, background: '#fff' }}>
                <KnowledgePanel knowledgeManager={knowledgeManager} ref={knowledgeRef} onStateChange={setKnowledgeState} />
              </div>
            )}
          </div>
        </Content>
      </Layout>

      <Modal
        open={menuOpen}
        onCancel={() => setMenuOpen(false)}
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
                  onClick={() => setView(item.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 13, color: '#333', transition: 'background 0.15s',
                    background: view === item.key ? '#f0f0f0' : 'transparent'
                  }}
                  onMouseEnter={(e) => {
                    if (view !== item.key) e.currentTarget.style.background = '#f5f5f5'
                  }}
                  onMouseLeave={(e) => {
                    if (view !== item.key) e.currentTarget.style.background = 'transparent'
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
              {renderView(view)}
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
