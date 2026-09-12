// ── View host ──
// PLAN-0.4.0 M1.4: renders the active non-chat content view from the navigation
// registry. Chat is NOT rendered here — AppLayout keeps it permanently mounted
// (display:none while another view is active) so streaming is never interrupted.
// The heavy canvas view is lazy: it only loads when first navigated to.
// The three centers (capability/knowledge/tools) share one page (D4a revision);
// their tab is the view kind itself.

import React, { Suspense, lazy } from 'react'
import { useNavigationStore } from '../../stores/navigationStore'
import CanvasToolbar from '../canvas/CanvasToolbar'
import CentersPage from '../centers/CentersPage'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'
import type { ConversationListItem } from '../../types/conversation'
import ProjectView from '../project/ProjectView'
import RoutineCenter from '../routine/RoutineCenter'
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
    case 'knowledge':
    case 'tools':
      return (
        <CentersPage
          knowledgeManager={knowledgeManager}
          tools={tools}
          skills={skills}
          onToggleSkill={onToggleSkill}
          onImportSkill={onImportSkill}
          onRefreshSkills={onRefreshSkills}
          onDeleteSkill={onDeleteSkill}
          importError={importError}
        />
      )
    default:
      return null
  }
}
