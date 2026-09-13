// ── App-level navigation model ──
// PLAN-0.4.0 M1.1: a single typed view replaces the ad-hoc boolean/string states
// that used to live in AppLayout (canvasMode / knowledgeMode / settings `view`).
// The sidebar nav column (components/layout/SidebarNav.tsx) and the view container
// (components/layout/ViewHost.tsx) both read from this via the navigation store.

/** Kinds of top-level content views. `canvas` is kept rendered but is not
 *  reachable from the nav column (PLAN-0.4.0 D7 — entry hidden, code retained). */
export type AppViewKind = 'chat' | 'search' | 'project' | 'routines' | 'capability' | 'knowledge' | 'tools' | 'settings' | 'usage' | 'about' | 'canvas'

/** The currently displayed top-level view. Extra fields are params consumed by
 *  specific kinds; they are ignored by the rest. */
export interface AppView {
  kind: AppViewKind
  /** `project` detail: which project is open. Absent = project list. */
  projectId?: string
  /** `tools` detail: which user tool is open. Absent = browse (list + empty pane). */
  toolId?: string
  /** `tools` studio state (M5R): true = 工作室 (live preview + conversation);
   *  without `toolId` this is the create-from-scratch flow. */
  toolEditing?: boolean
  /** `capability`: which tab is active (used by jump entries, e.g. after `install`). */
  capabilityTab?: 'mcp' | 'skills' | 'subagent'
  /** `settings`: which section to open (jump entries, e.g. search → 记忆). */
  settingsTab?: 'environment' | 'settings' | 'assistant' | 'memory' | 'experiences' | 'favorites'
}

export const CHAT_VIEW: AppView = { kind: 'chat' }
