// ── View host ──
// PLAN-0.4.0 M1.4: renders the active non-chat content view from the navigation
// registry. Chat is NOT rendered here — AppLayout keeps it permanently mounted
// (display:none while another view is active) so streaming is never interrupted.
// The heavy canvas view is lazy: it only loads when first navigated to.
// The three centers (capability/knowledge/tools) share one page (D4a revision);
// their tab is the view kind itself. Settings / usage / about are the former
// modal & drawers, promoted to standard views.

import React, { Suspense, lazy } from 'react'
import { useNavigationStore } from '../../stores/navigationStore'
import CanvasToolbar from '../canvas/CanvasToolbar'
import CentersPage from '../centers/CentersPage'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { MemoryManager } from '../../memory/MemoryManager'
import type { SkillState } from '../../skills/types'
import type { ToolState } from '../../tools/types'
import type { ConversationListItem } from '../../types/conversation'
import RoutineCenter from '../routine/RoutineCenter'
import RoutineEditorPage from '../routine/RoutineEditorPage'
import { SearchView } from '../search/SearchView'
import SettingsPage from '../settings/SettingsPage'
import StatisticsPage from './StatisticsPage'

const LazyCanvasView = lazy(() => import('../canvas/CanvasView'))

export interface ViewHostProps {
  knowledgeManager?: KnowledgeManager
  memoryManager?: MemoryManager
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  conversations?: ConversationListItem[]
  onSelectConversation?: (key: string) => void
  /** M4 (review 2026-09-18): forwarded to the 数据与运行 settings tab so a
   *  tightened retention window refreshes the sidebar's conversation list. */
  onReloadConversations?: () => void
}

export function ViewHost({ knowledgeManager, memoryManager, tools, onToggleTool, skills, onToggleSkill, onImportSkill, onRefreshSkills, onDeleteSkill, importError, conversations, onSelectConversation, onReloadConversations }: ViewHostProps): React.ReactElement | null {
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
      return <SearchView onOpenConversation={onSelectConversation} />
    // M19 fallback: a stale `kind:'about'` (persisted view state from before
    // 0.4.0, or a navigation the two redirected entries missed) used to reach
    // `default: null` — a blank pane with no escape. About lives inside
    // Settings now, so the kind renders Settings like `settings` does.
    case 'settings':
    case 'about':
      return <SettingsPage memoryManager={memoryManager} onReloadConversations={onReloadConversations} />
    case 'usage':
      return <StatisticsPage />
    case 'routines':
      // routineEditing routes to the dedicated create/edit page (list · form ·
      // assistant); without it the kind renders the card grid / run workspace.
      if (view.routineEditing) return <RoutineEditorPage routineId={view.routineId} templateId={view.routineTemplateId} />
      return <RoutineCenter runHistoryOf={view.runHistoryOf} />
    case 'capability':
    case 'knowledge':
    case 'tools':
      return (
        <CentersPage
          knowledgeManager={knowledgeManager}
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
    default:
      return null
  }
}
