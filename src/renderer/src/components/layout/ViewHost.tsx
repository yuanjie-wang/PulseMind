// ── View host ──
// PLAN-0.4.0 M1.4: renders the active non-chat content view from the navigation
// registry. Chat is NOT rendered here — AppLayout keeps it permanently mounted
// (display:none while another view is active) so streaming is never interrupted.
// The heavy canvas view is lazy: it only loads when first navigated to.

import React, { Suspense, lazy, useRef, useState, useEffect } from 'react'
import { Button, Dropdown, Progress, Tooltip } from 'antd'
import { PlusOutlined, FolderOpenOutlined, FileTextOutlined, LinkOutlined, ClearOutlined, LoadingOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import CanvasToolbar from '../canvas/CanvasToolbar'
import KnowledgePanel from '../knowledge/KnowledgePanel'
import type { KnowledgePanelHandle, KnowledgePanelState } from '../knowledge/KnowledgePanel'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { ConversationListItem } from '../../types/conversation'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'
import ProjectView from '../project/ProjectView'
import RoutineCenter from '../routine/RoutineCenter'
import CapabilityCenter from '../capability/CapabilityCenter'
import ToolCenter from '../tool-studio/ToolCenter'
import { SearchView } from '../search/SearchView'

const LazyCanvasView = lazy(() => import('../canvas/CanvasView'))

export interface ViewHostProps {
  knowledgeManager?: KnowledgeManager
  tools?: ToolState[]
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  conversations?: ConversationListItem[]
  onSelectConversation?: (key: string) => void
  onCreateProjectConversation?: (projectId: string) => void
  /** Reveal the memory manager (a settings-modal page) from a search result. */
  onOpenMemory?: () => void
}

/** The knowledge pane's own toolbar — moved out of the global header (M1.5) so
 *  AppLayout carries no per-view controls. Import progress replaces the header
 *  progress bar that used to sit on the right of the title bar. */
function KnowledgePane({ knowledgeManager }: { knowledgeManager: KnowledgeManager }): React.ReactElement {
  const knowledgeRef = useRef<KnowledgePanelHandle>(null)
  const [knowledgeState, setKnowledgeState] = useState<KnowledgePanelState | null>(null)

  // ── Import progress bar fade-out (moved from AppLayout header) ──
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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 24px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 24 }}>
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
            <Tooltip title={<span style={{ fontSize: 11 }}>源文件总数 / 已编译文件数 / Wiki页面数</span>}>
              <span style={{ fontSize: 12, color: '#bbb', cursor: 'pointer', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {knowledgeState.stats.total}/{knowledgeState.stats.compiled}/{knowledgeState.stats.wikiFileCount}
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        <KnowledgePanel knowledgeManager={knowledgeManager} ref={knowledgeRef} onStateChange={setKnowledgeState} />
      </div>
    </div>
  )
}

export function ViewHost({ knowledgeManager, tools, skills, onToggleSkill, onImportSkill, onRefreshSkills, onDeleteSkill, importError, conversations, onSelectConversation, onCreateProjectConversation, onOpenMemory }: ViewHostProps): React.ReactElement | null {
  const view = useNavigationStore((s) => s.view)
  const handleCanvasClearAll = () => {
    window.electronAPI.canvasClearAll().catch((err: unknown) =>
      console.warn('[ViewHost] Failed to clear all canvas data:', err)
    )
  }

  switch (view.kind) {
    case 'canvas':
      return (
        <Suspense fallback={null}>
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
              <CanvasToolbar onClearAll={handleCanvasClearAll} />
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <LazyCanvasView />
            </div>
          </div>
        </Suspense>
      )
    case 'knowledge':
      return knowledgeManager ? <KnowledgePane knowledgeManager={knowledgeManager} /> : null
    case 'search':
      return <SearchView onOpenConversation={onSelectConversation} onOpenMemory={onOpenMemory} />
    case 'project':
      return (
        <ProjectView
          conversations={conversations ?? []}
          onSelectConversation={onSelectConversation ?? (() => {})}
          onCreateConversation={onCreateProjectConversation ?? (() => {})}
        />
      )
    case 'routines':
      return <RoutineCenter />
    case 'capability':
      return (
        <CapabilityCenter
          initialTab={view.capabilityTab}
          tools={tools}
          skills={skills}
          onToggleSkill={onToggleSkill}
          onImportSkill={onImportSkill}
          onRefreshSkills={onRefreshSkills}
          onDeleteSkill={onDeleteSkill}
          importError={importError}
        />
      )
    case 'tools':
      return <ToolCenter />
    default:
      return null
  }
}
