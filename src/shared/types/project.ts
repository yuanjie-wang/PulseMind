// ── Project domain types (PLAN-0.4.0 M3, revised: sandbox policy removed) ──
// A project is a container of conversations bound to one fixed workspace
// directory. Invariants:
//   - workspaceDir is chosen explicitly at creation and never changes;
//   - names are unique (trim + case-insensitive; 「默认项目」 is reserved).
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
  createdAt: string
  updatedAt: string
}

/** The synthesized project that owns every pre-0.4.0 conversation. Not stored
 *  in the projects table — its workspace follows the global `workspaceDir`
 *  setting so existing setups keep behaving exactly as before. */
export const DEFAULT_PROJECT_ID = 'default'

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
