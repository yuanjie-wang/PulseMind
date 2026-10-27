// ── App-level navigation model ──
// PLAN-0.4.0 M1.1: a single typed view replaces the ad-hoc boolean/string states
// that used to live in AppLayout (canvasMode / knowledgeMode / settings `view`).
// The sidebar nav column (components/layout/SidebarNav.tsx) and the view container
// (components/layout/ViewHost.tsx) both read from this via the navigation store.

/** Kinds of top-level content views. */
export type AppViewKind = 'chat' | 'search' | 'routines' | 'capability' | 'knowledge' | 'tools' | 'settings' | 'usage' | 'about'

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
  capabilityTab?: 'mcp' | 'skills' | 'expert' | 'tools'
  /** `settings`: which section to open (jump entries, e.g. search → 记忆).
   *  `tools` moved to the capability center; `favorites` became knowledge entries. */
  settingsTab?: 'environment' | 'settings' | 'extension' | 'shortcuts' | 'assistant' | 'memory' | 'data' | 'about'
  /** `routines` detail: open the run-history workspace for this routine
   *  (deep links, e.g. the welcome page's routine card). */
  runHistoryOf?: string
  /** `routines` editor page: true = open the three-column create/edit page
   *  (list · form · assistant) instead of the card grid. */
  routineEditing?: boolean
  /** `routines` editor page: which routine is loaded into the form.
   *  Absent (with `routineEditing`) = the create-new flow. */
  routineId?: string
  /** `routines` editor page: a recommended template (routine-templates.ts) to
   *  prefill the create-new form with. Ignored when `routineId` is set — editing
   *  an existing routine is never a template application. Nothing is created
   *  until the user saves. */
  routineTemplateId?: string
  /** `routines` editor page: a routine draft distilled from a conversation —
   *  the chat toolbar's 存为日常任务. Fills the create-new form once on mount
   *  (same contract as `routineTemplateId`: nothing exists until the user
   *  saves). Ignored when `routineId` is set. */
  routineDraft?: {
    name: string
    description: string
    prompt: string
    cron: string
    sourceConversationId: string
  }
  /** `knowledge`: which base the left rail has selected — the whole right side
   *  (table, stats, search, import target, compile/rebuild) scopes to it.
   *  Absent = the default base. Survives tab switches, not restarts. */
  knowledgeBaseId?: string
}

export const CHAT_VIEW: AppView = { kind: 'chat' }
