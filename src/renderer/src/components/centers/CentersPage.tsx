// ── Centers page ──
// PLAN-0.4.0 D4a/D4b revision: 能力中心 / 知识中心 / 工具中心 share one page.
// The selected tab IS the view kind (capability | knowledge | tools), so the header
// title, the header switcher, sidebar highlighting and deep links (e.g. the install
// notifier's capabilityTab jump) all keep working without a separate tab state.

import React, { useRef, useState } from 'react'
import { Button, Dropdown, Progress, Tooltip } from 'antd'
import { PlusOutlined, FolderOpenOutlined, FileTextOutlined, LinkOutlined, ClearOutlined, LoadingOutlined } from '@ant-design/icons'
import { useNavigationStore } from '../../stores/navigationStore'
import KnowledgePanel from '../knowledge/KnowledgePanel'
import type { KnowledgePanelHandle, KnowledgePanelState } from '../knowledge/KnowledgePanel'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { SkillState } from '../../skills/types'
import type { ToolState } from '../../tools/types'
import CapabilityCenter from '../capability/CapabilityCenter'
import ToolCenter from '../tool-studio/ToolCenter'

export interface CentersPageProps {
  knowledgeManager?: KnowledgeManager
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
}

/** The knowledge tab's own toolbar — moved out of the global header (M1.5) so
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

  // The mirror lives in the panel's own callback rather than an effect that watches
  // it: same transitions, no cascading render. When an import ends the bar lingers
  // for 1s at opacity 0 (the fade), then clears.
  const handleStateChange = (next: KnowledgePanelState): void => {
    setKnowledgeState(next)
    if (next.importProgress) {
      lastImportRef.current = next.importProgress
      setDisplayImport(next.importProgress)
      setImportFading(false)
      if (importFadeTimer.current) clearTimeout(importFadeTimer.current)
    } else if (lastImportRef.current && !next.isImporting) {
      lastImportRef.current = null
      setImportFading(true)
      importFadeTimer.current = setTimeout(() => {
        setDisplayImport(null)
        setImportFading(false)
      }, 1000)
    }
  }

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
              ],
            }}
            placement="bottomLeft"
            trigger={['click']}
          >
            <Tooltip title="导入知识">
              <Button type="text" icon={<PlusOutlined style={{ fontSize: 16 }} />} />
            </Tooltip>
          </Dropdown>
          <Tooltip title="打开知识库目录">
            <Button
              type="text"
              icon={<FolderOpenOutlined style={{ fontSize: 16 }} />}
              onClick={async () => {
                const { knowledgeDir } = await window.electronAPI.getDataPaths()
                await window.electronAPI.openFolder(knowledgeDir)
              }}
            />
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
              <span style={{ fontSize: 10, color: '#999', whiteSpace: 'nowrap' }}>{`${displayImport.current}/${displayImport.total}`}</span>
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
        <KnowledgePanel knowledgeManager={knowledgeManager} ref={knowledgeRef} onStateChange={handleStateChange} />
      </div>
    </div>
  )
}

export function CentersPage({
  knowledgeManager,
  skills,
  onToggleSkill,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError,
  tools,
  onToggleTool,
}: CentersPageProps): React.ReactElement | null {
  const view = useNavigationStore((s) => s.view)

  switch (view.kind) {
    case 'knowledge':
      return knowledgeManager ? <KnowledgePane knowledgeManager={knowledgeManager} /> : null
    case 'tools':
      return <ToolCenter />
    case 'capability':
    default:
      return (
        <CapabilityCenter
          initialTab={view.capabilityTab}
          skills={skills}
          onToggleSkill={onToggleSkill}
          onImportSkill={onImportSkill}
          onRefreshSkills={onRefreshSkills}
          onDeleteSkill={onDeleteSkill}
          importError={importError}
          tools={tools}
          onToggleTool={onToggleTool}
        />
      )
  }
}

export default CentersPage
