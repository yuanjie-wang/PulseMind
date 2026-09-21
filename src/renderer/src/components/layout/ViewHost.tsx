// ── View host ──
// PLAN-0.4.0 M1.4: renders the active non-chat content view from the navigation
// registry. Chat is NOT rendered here — AppLayout keeps it permanently mounted
// (display:none while another view is active) so streaming is never interrupted.
// EVERY branch is lazy, and that is the rule rather than an optimization applied
// to one of them: a static import in this file puts the whole view's subtree in
// the first-paint chunk, and these views carry the heaviest dependencies in the
// renderer (echarts in StatisticsPage, the routine editor's assistant column,
// the knowledge panel). The switch below must therefore never gain a static
// import of a view module — only `lazy(() => import(...))` — and the one
// `Suspense` wraps the switch's result so a new branch cannot be added without it.
// The three centers (capability/knowledge/tools) share one page (D4a revision);
// their tab is the view kind itself. Settings / usage / about are the former
// modal & drawers, promoted to standard views.

import React, { Suspense, lazy } from 'react'
import { useNavigationStore } from '../../stores/navigationStore'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { MemoryManager } from '../../memory/MemoryManager'
import type { SkillState } from '../../skills/types'
import type { ToolState } from '../../tools/types'
import type { ConversationListItem } from '../../types/conversation'

const LazyCanvasToolbar = lazy(() => import('../canvas/CanvasToolbar'))
const LazyCanvasView = lazy(() => import('../canvas/CanvasView'))
const LazyCentersPage = lazy(() => import('../centers/CentersPage'))
const LazyRoutineCenter = lazy(() => import('../routine/RoutineCenter'))
const LazyRoutineEditorPage = lazy(() => import('../routine/RoutineEditorPage'))
const LazySearchView = lazy(() => import('../search/SearchView'))
const LazySettingsPage = lazy(() => import('../settings/SettingsPage'))
const LazyStatisticsPage = lazy(() => import('./StatisticsPage'))

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
  /** M4 (review 2026-09-18): forwarded to the settings page so 常规's 数据清理
   *  save (a tightened retention window) refreshes the sidebar's conversation list. */
  onReloadConversations?: () => void
}

export function ViewHost({ knowledgeManager, memoryManager, tools, onToggleTool, skills, onToggleSkill, onImportSkill, onRefreshSkills, onDeleteSkill, importError, conversations, onSelectConversation, onReloadConversations }: ViewHostProps): React.ReactElement | null {
  const view = useNavigationStore((s) => s.view)
  const handleCanvasClearAll = () => {
    window.electronAPI.canvasClearAll().catch((err: unknown) =>
      console.warn('[ViewHost] Failed to clear all canvas data:', err)
    )
  }

  let content: React.ReactElement | null
  switch (view.kind) {
    case 'canvas':
      content = (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <LazyCanvasToolbar onClearAll={handleCanvasClearAll} />
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <LazyCanvasView />
          </div>
        </div>
      )
      break
    case 'search':
      content = <LazySearchView onOpenConversation={onSelectConversation} />
      break
    // M19 fallback: a stale `kind:'about'` (persisted view state from before
    // 0.4.0, or a navigation the two redirected entries missed) used to reach
    // `default: null` — a blank pane with no escape. About lives inside
    // Settings now, so the kind renders Settings like `settings` does.
    case 'settings':
    case 'about':
      content = <LazySettingsPage memoryManager={memoryManager} onReloadConversations={onReloadConversations} />
      break
    case 'usage':
      content = <LazyStatisticsPage />
      break
    case 'routines':
      // routineEditing routes to the dedicated create/edit page (list · form ·
      // assistant); without it the kind renders the card grid / run workspace.
      content = view.routineEditing
        ? <LazyRoutineEditorPage routineId={view.routineId} templateId={view.routineTemplateId} routineDraft={view.routineDraft} />
        : <LazyRoutineCenter runHistoryOf={view.runHistoryOf} />
      break
    case 'capability':
    case 'knowledge':
    case 'tools':
      content = (
        <LazyCentersPage
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
      break
    default:
      content = null
  }

  return <Suspense fallback={null}>{content}</Suspense>
}
