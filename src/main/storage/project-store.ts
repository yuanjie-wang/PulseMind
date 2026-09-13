// ── Project store (PLAN-0.4.0 M3.2) ──
// CRUD for the `projects` table plus the synthesized default project (D1):
// the default project owns every conversation without an explicit project and
// its workspace follows the global `workspaceDir` setting, so pre-0.4.0
// installs keep behaving exactly as before. It is never stored as a row.

import { prefixedId } from '../utils/id'
import { access, constants, mkdir } from 'node:fs/promises'
import { getDb } from './database'
import { settingsStore } from './settings-store'
import { WORKSPACE_DIR } from './index'
import { deleteConversation } from './conversation.db'
import { DEFAULT_PROJECT_ID, type Project, type ProjectCreateInput, type ProjectUpdateInput } from '../../shared/types/project'
import { normalizeSandboxPolicy } from '../../shared/sandbox/policy'

/** Display name of the synthesized default project — reserved for user projects. */
const DEFAULT_PROJECT_NAME = '默认项目'

/** Project names are unique (trimmed, case-insensitive). Checked at create AND
 *  rename so a rename can never collide with an existing project. */
async function assertNameAvailable(name: string, excludeId?: string): Promise<void> {
  if (!name) throw new Error('项目名称不能为空')
  const lower = name.toLowerCase()
  if (lower === DEFAULT_PROJECT_NAME.toLowerCase()) throw new Error(`「${DEFAULT_PROJECT_NAME}」是保留名称，请换一个`)
  const rows = getDb().prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>
  const hit = rows.find((r) => r.id !== excludeId && r.name.trim().toLowerCase() === lower)
  if (hit) throw new Error(`项目名称「${hit.name.trim()}」已存在，请换一个`)
}

/** The workspace is chosen explicitly at creation and never changes afterwards,
 *  so materialize it right away: an invalid/unwritable path is rejected at
 *  creation time instead of failing the conversation's first session. */
async function ensureWorkspaceDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    await access(dir, constants.W_OK)
  } catch (err) {
    throw new Error(`无法创建或写入工作区目录 ${dir}：${err instanceof Error ? err.message : String(err)}`)
  }
}

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
    name: DEFAULT_PROJECT_NAME,
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
    const name = input.name.trim()
    await assertNameAvailable(name)
    await ensureWorkspaceDir(input.workspaceDir)
    const now = new Date().toISOString()
    const project: Project = {
      id: prefixedId('proj'),
      name,
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

  /** name/icon/sandbox are editable; workspaceDir is not — the type has no such
   *  field and the UPDATE statement below never touches workspace_dir. */
  async update(id: string, patch: ProjectUpdateInput): Promise<Project | null> {
    const existing = await this.get(id)
    if (!existing || id === DEFAULT_PROJECT_ID) return existing // default project is not editable
    if (patch.name !== undefined) await assertNameAvailable(patch.name.trim(), id)
    const next: Project = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      icon: patch.icon !== undefined ? patch.icon : existing.icon,
      sandbox: patch.sandbox ? normalizeSandboxPolicy(patch.sandbox) : existing.sandbox,
      updatedAt: new Date().toISOString(),
    }
    getDb()
      .prepare('UPDATE projects SET name = ?, icon = ?, sandbox_json = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.icon ?? null, JSON.stringify(next.sandbox), next.updatedAt, id)
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
