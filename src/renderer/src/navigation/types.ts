// ── App-level navigation model ──
// PLAN-0.4.0 M1.1: a single typed view replaces the ad-hoc boolean/string states
// that used to live in AppLayout (canvasMode / knowledgeMode / settings `view`).
// The sidebar nav column (components/layout/SidebarNav.tsx) and the view container
// (components/layout/ViewHost.tsx) both read from this via the navigation store.

/** Kinds of top-level content views. `canvas` is kept rendered but is not
 *  reachable from the nav column (PLAN-0.4.0 D7 — entry hidden, code retained). */
export type AppViewKind = 'chat' | 'search' | 'routines' | 'capability' | 'knowledge' | 'tools' | 'settings' | 'usage' | 'about' | 'canvas'

/** The currently displayed top-level view. Extra fields are params consumed by
 *  specific kinds; they are ignored by the rest. */
export interface AppView {
  kind: AppViewKind
  /** `tools` detail: which user tool is open. Absent = browse (list + empty pane). */
  toolId?: string
  /** `tools` studio state (M5R): true = 工作室 (live preview + conversation);
   *  without `toolId` this is the create-from-scratch flow. */
  toolEditing?: boolean
  /** `capability`: which tab is active (used by jump entries, e.g. after `install`). */
  capabilityTab?: 'mcp' | 'skills' | 'expert'
  /** `settings`: which section to open (jump entries, e.g. search → 记忆). */
  settingsTab?: 'environment' | 'settings' | 'assistant' | 'tools' | 'memory' | 'experiences' | 'favorites'
  /** `routines` detail: open the run-history workspace for this routine
   *  (deep links, e.g. the welcome page's routine card). */
  runHistoryOf?: string
  /** `routines` editor page: true = open the three-column create/edit page
   *  (list · form · assistant) instead of the card grid. */
  routineEditing?: boolean
  /** `routines` editor page: which routine is loaded into the form.
   *  Absent (with `routineEditing`) = the create-new flow. */
  routineId?: string
}

export const CHAT_VIEW: AppView = { kind: 'chat' }
