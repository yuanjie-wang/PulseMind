// ── Project domain types (PLAN-0.4.0 M3) ──
// A project is a container of conversations bound to one fixed workspace
// directory, enforced by a sandbox policy (D1/D2).

import type { ProjectSandboxPolicy } from '../sandbox/policy'

export interface Project {
  id: string
  name: string
  /** Fixed workspace directory — every conversation in the project resolves
   *  relative paths against this, and writes are jailed to it. */
  workspaceDir: string
  icon?: string
  sandbox: ProjectSandboxPolicy
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
  sandbox?: ProjectSandboxPolicy
}

export interface ProjectUpdateInput {
  name?: string
  workspaceDir?: string
  icon?: string
  sandbox?: ProjectSandboxPolicy
}
