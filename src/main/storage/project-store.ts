// ── Project store (PLAN-0.4.0 M3.2) ──
// CRUD for the `projects` table plus the synthesized default project (D1):
// the default project owns every conversation without an explicit project and
// its workspace follows the global `workspaceDir` setting, so pre-0.4.0
// installs keep behaving exactly as before. It is never stored as a row.

import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import { settingsStore } from './settings-store'
import { WORKSPACE_DIR } from './index'
import { deleteConversation } from './conversation.db'
import { DEFAULT_PROJECT_ID, type Project, type ProjectCreateInput, type ProjectUpdateInput } from '../../shared/types/project'
import { normalizeSandboxPolicy } from '../../shared/sandbox/policy'

interface ProjectRow {
  id: string
  name: string
  workspace_dir: string
  icon: string | null
  sandbox_json: string
  created_at: string
  updated_at: string
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    workspaceDir: r.workspace_dir,
    icon: r.icon || undefined,
    sandbox: normalizeSandboxPolicy(JSON.parse(r.sandbox_json)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

async function defaultProject(): Promise<Project> {
  const settings = await settingsStore.get()
  const now = new Date().toISOString()
  return {
    id: DEFAULT_PROJECT_ID,
    name: '默认项目',
    workspaceDir: settings.workspaceDir || WORKSPACE_DIR,
    sandbox: normalizeSandboxPolicy(null),
    createdAt: now,
    updatedAt: now,
  }
}

export const projectStore = {
  async list(): Promise<Project[]> {
    const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[]
    const projects = rows.map(rowToProject)
    return [await defaultProject(), ...projects]
  },

  async get(id: string): Promise<Project | null> {
    if (id === DEFAULT_PROJECT_ID) return defaultProject()
    const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? rowToProject(row) : null
  },

  async create(input: ProjectCreateInput): Promise<Project> {
    const now = new Date().toISOString()
    const project: Project = {
      id: `proj_${randomUUID().slice(0, 8)}`,
      name: input.name.trim() || '未命名项目',
      workspaceDir: input.workspaceDir,
      icon: input.icon,
      sandbox: normalizeSandboxPolicy(input.sandbox),
      createdAt: now,
      updatedAt: now,
    }
    getDb()
      .prepare('INSERT INTO projects (id, name, workspace_dir, icon, sandbox_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.workspaceDir, project.icon ?? null, JSON.stringify(project.sandbox), project.createdAt, project.updatedAt)
    return project
  },

  async update(id: string, patch: ProjectUpdateInput): Promise<Project | null> {
    const existing = await this.get(id)
    if (!existing || id === DEFAULT_PROJECT_ID) return existing // default project is not editable
    const next: Project = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      workspaceDir: patch.workspaceDir || existing.workspaceDir,
      icon: patch.icon !== undefined ? patch.icon : existing.icon,
      sandbox: patch.sandbox ? normalizeSandboxPolicy(patch.sandbox) : existing.sandbox,
      updatedAt: new Date().toISOString(),
    }
    getDb()
      .prepare('UPDATE projects SET name = ?, workspace_dir = ?, icon = ?, sandbox_json = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.workspaceDir, next.icon ?? null, JSON.stringify(next.sandbox), next.updatedAt, id)
    return next
  },

  /** D17: deleting a project deletes its conversations (and their messages)
   *  with it. The default project cannot be deleted. */
  async remove(id: string): Promise<{ removedConversations: number }> {
    if (id === DEFAULT_PROJECT_ID) throw new Error('默认项目不能删除')
    const db = getDb()
    const ids = (db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id)
    const run = db.transaction((convIds: string[]) => {
      for (const convId of convIds) deleteConversation(convId)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
    run(ids)
    return { removedConversations: ids.length }
  },

  /** Conversation ids belonging to a project (for the sidebar / project view). */
  listConversationIds(projectId: string): string[] {
    return (getDb().prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((r) => r.id)
  },
}
