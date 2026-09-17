// ── Project domain types (PLAN-0.4.0 M3, revised: sandbox policy removed) ──
// A project is a container of conversations bound to one fixed workspace
// directory. Invariants:
//   - workspaceDir is chosen explicitly at creation and never changes;
//   - names are unique (trim + case-insensitive; 「默认项目」 is reserved);
//   - colorHue is assigned once at creation and never recomputed, so renaming
//     a project does not move its color.
// The former per-project sandbox policy (fs / network / hard isolation) is
// gone: writes are always jailed to the conversation's resolved workspace,
// and tool approval is a per-conversation choice (`conversations.approval_mode`).

export interface Project {
  id: string
  name: string
  /** Fixed workspace directory — every conversation in the project resolves
   *  relative paths against this, and writes are jailed to it. */
  workspaceDir: string
  icon?: string
  /** Identity hue (0–360) of the project's color, stored on the row rather than
   *  derived per render: the welcome card's wash and the composer's send button
   *  both read it (`projectStore.projectHue`), and because it is frozen at
   *  creation a rename no longer re-rolls which color the project wears.
   *  Undefined only where there is no row to read it from — the synthesized
   *  default project, and rows read before the startup backfill filled it in;
   *  `projectHue` falls back to hashing the name so those still get a color. */
  colorHue?: number
  /** Manual position from the sidebar's drag-to-reorder (0-based). Undefined
   *  until the first drag — a project created after the last drag has none and
   *  sorts by created_at among the other unordered rows. */
  sortOrder?: number
  createdAt: string
  updatedAt: string
}

/** The synthesized project that owns every pre-0.4.0 conversation. Not stored
 *  in the projects table — its workspace follows the global `workspaceDir`
 *  setting so existing setups keep behaving exactly as before. */
export const DEFAULT_PROJECT_ID = 'default'

/** How the sidebar's 项目 list orders its groups. Persisted globally as
 *  `settings.projectSortMode` — the order is a preference about the user, not
 *  about one view, so it survives restarts like the theme does.
 *  - 'created': newest project first (the historical order).
 *  - 'name': by project name, zh-aware (`localeCompare` — pinyin for Chinese
 *    names, alphabetical for Latin ones).
 *  - 'activity': by the group's newest conversation, an idle project sinking
 *    to the bottom of that ordering.
 *  - 'manual': the drag-to-reorder order (`projects.sort_order`). Dropping a
 *    drag switches to this mode, so the arrangement the user just made is the
 *    one that sticks. */
export type ProjectSortMode = 'created' | 'name' | 'activity' | 'manual'

export interface ProjectCreateInput {
  name: string
  workspaceDir: string
  icon?: string
}

/** name/icon are editable; workspaceDir is deliberately excluded — it is fixed
 *  at creation, so a patch can never retarget a project's jail root behind
 *  conversations that already resolved (and persisted) the old dir. */
export interface ProjectUpdateInput {
  name?: string
  icon?: string
}
