// ── Project store (main process) ──
// Owns the projects table. The synthesized default project is not a row:
// its workspace follows the global `workspaceDir` setting, so pre-0.4.0
// installs keep behaving exactly as before. It is never stored as a row.

import { prefixedId } from '../utils/id'
import { access, constants, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getDb } from './database'
import { settingsStore } from './settings-store'
import { WORKSPACE_DIR } from './index'
import { deleteConversation } from './conversation.db'
import { DEFAULT_PROJECT_ID, type Project, type ProjectCreateInput, type ProjectUpdateInput } from '../../shared/types/project'
import { checkWorkspacePathFormat, windowsReservedNameError } from '../../shared/workspace-path'
import { stringToHue } from '../../shared/hash-color'

/** Display name of the synthesized default project — reserved for user projects. */
const DEFAULT_PROJECT_NAME = '默认项目'

/** The projects table still carries a `sandbox_json` column from the removed
 *  sandbox-policy era; fresh schemas get it with a DEFAULT, older dev
 *  databases have it NOT NULL — either way create() writes a fixed '{}' into
 *  it so both shapes accept the row. Nothing ever reads it back. */
const LEGACY_SANDBOX_JSON = '{}'

/** The identity hue a project is born with. Hashing the name is what the
 *  renderer used to do on every paint, so assigning it here keeps every color
 *  a user already sees exactly as it was — the difference is that it is now
 *  written down once, at creation, and read back thereafter. */
export function hueForProjectName(name: string): number {
  return stringToHue(name)
}

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

/** Dry-run twin of ensureWorkspaceDir: same verdict, no filesystem changes —
 *  the create modal probes every edited path so an unusable one is named at
 *  input time instead of failing the save. The format gate is the renderer's
 *  own shared check (isAbsolute() alone would fork the verdict: POSIX path
 *  modules call `C:\code` relative), plus Windows reserved device names when
 *  actually running on win32. mkdir recursive succeeds exactly when the
 *  nearest existing ancestor is a writable directory, so that is what gets
 *  checked when the path itself does not exist yet. */
async function validateWorkspaceDir(dir: string): Promise<void> {
  const formatError = checkWorkspacePathFormat(dir)
  if (formatError) throw new Error(formatError)
  if (process.platform === 'win32') {
    const reserved = windowsReservedNameError(dir)
    if (reserved) throw new Error(reserved)
  }
  let probe = dir
  for (;;) {
    let st: Awaited<ReturnType<typeof stat>> | undefined
    try {
      st = await stat(probe)
    } catch {
      st = undefined // missing segment — walk up to the nearest existing ancestor
    }
    if (st) {
      if (!st.isDirectory()) throw new Error(`${probe} 已存在且不是目录`)
      await access(probe, constants.W_OK)
      return
    }
    const parent = dirname(probe)
    if (parent === probe) throw new Error(`无法创建工作区目录 ${dir}：没有任何已存在且可写的上级目录`)
    probe = parent
  }
}

interface ProjectRow {
  id: string
  name: string
  workspace_dir: string
  icon: string | null
  color_hue: number | null
  sort_order: number | null
  created_at: string
  updated_at: string
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    workspaceDir: r.workspace_dir,
    icon: r.icon || undefined,
    // null (a row the backfill has not reached yet) stays undefined, which
    // projectHue reads as "no stored color — hash the name for now".
    colorHue: r.color_hue ?? undefined,
    sortOrder: r.sort_order ?? undefined,
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
    createdAt: now,
    updatedAt: now,
  }
}

export const projectStore = {
  /** Probe a would-be workspaceDir for the create modal: { ok } or { ok:false,
   *  error } with a user-readable reason. Read-only — creates nothing. */
  async validateWorkspaceDir(dir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await validateWorkspaceDir(dir)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async list(): Promise<Project[]> {
    // Newest first: a freshly created project tops the sidebar's 项目 list, and
    // the welcome picker reads the same snapshot. The synthesized default
    // project is still prepended ahead of every row.
    const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]
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
    // Same format gate the modal probes with: ensureWorkspaceDir would
    // otherwise literally mkdir a `C:\code`-named folder into the cwd.
    const formatError = checkWorkspacePathFormat(input.workspaceDir)
    if (formatError) throw new Error(formatError)
    await assertNameAvailable(name)
    await ensureWorkspaceDir(input.workspaceDir)
    const now = new Date().toISOString()
    const project: Project = {
      id: prefixedId('proj'),
      name,
      workspaceDir: input.workspaceDir,
      icon: input.icon,
      colorHue: hueForProjectName(name),
      createdAt: now,
      updatedAt: now,
    }
    getDb()
      .prepare('INSERT INTO projects (id, name, workspace_dir, icon, color_hue, sandbox_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.workspaceDir, project.icon ?? null, project.colorHue, LEGACY_SANDBOX_JSON, project.createdAt, project.updatedAt)
    return project
  },

  /** name/icon are editable; workspaceDir is not — the type has no such field
   *  and the UPDATE statement below never touches workspace_dir. color_hue is
   *  out of reach for the same reason, in the other direction: the color is
   *  the project's identity across surfaces, so renaming must not re-roll it. */
  async update(id: string, patch: ProjectUpdateInput): Promise<Project | null> {
    const existing = await this.get(id)
    if (!existing || id === DEFAULT_PROJECT_ID) return existing // default project is not editable
    if (patch.name !== undefined) await assertNameAvailable(patch.name.trim(), id)
    const next: Project = {
      ...existing,
      name: patch.name?.trim() || existing.name,
      icon: patch.icon !== undefined ? patch.icon : existing.icon,
      updatedAt: new Date().toISOString(),
    }
    getDb()
      .prepare('UPDATE projects SET name = ?, icon = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.icon ?? null, next.updatedAt, id)
    return next
  },

  /** Deleting a project deletes its conversations (and their messages) with
   *  it. The default project cannot be deleted. */
  async remove(id: string): Promise<{ removedConversations: number }> {
    if (id === DEFAULT_PROJECT_ID) throw new Error('默认项目不能删除')
    const db = getDb()
    const convs = db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(id) as Array<{ id: string }>
    const tx = db.transaction(() => {
      for (const c of convs) deleteConversation(c.id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
    tx()
    return { removedConversations: convs.length }
  },

  /** Persist the sidebar's drag-to-reorder: `orderedIds` is the FULL list of
   *  user projects in display order — every listed row gets sort_order = its
   *  index, and rows NOT listed (a project created mid-flight, or the
   *  synthesized default which has no row) fall back to NULL so the 'manual'
   *  sort mode keeps ordering them by created_at. The UPDATE binds named
   *  `@`-parameters: better-sqlite3's bind map stores names prefix-stripped,
   *  and the positional-bind swap that poisoned conversation project bindings
   *  (see AGENTS.md) is exactly the shape this must not reintroduce. */
  async reorder(orderedIds: string[]): Promise<void> {
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
      throw new Error('项目排序参数必须是字符串数组')
    }
    const db = getDb()
    const update = db.prepare('UPDATE projects SET sort_order = @order WHERE id = @id')
    const clear = db.prepare('UPDATE projects SET sort_order = NULL WHERE id NOT IN (SELECT value FROM json_each(@ids))')
    const tx = db.transaction(() => {
      orderedIds.forEach((id, order) => update.run({ id, order }))
      // json_each over the same array: rows outside the drag's list lose their
      // stale position instead of keeping one that no longer means anything.
      clear.run({ ids: JSON.stringify(orderedIds) })
    })
    tx()
  },
}

let colorBackfillDone = false

/** Give every project created before `color_hue` existed the color it was
 *  already being painted with: the same name hash the renderer derived per
 *  render, now written down once. Idempotent — it only ever touches rows whose
 *  column is NULL, so it cannot overwrite a color, and a second call is a
 *  no-op. Called from the startup sequence (main/index.ts), which is also what
 *  makes the renderer's fallback a formality rather than the mechanism. */
export async function backfillProjectColors(): Promise<void> {
  if (colorBackfillDone) return
  try {
    const db = getDb()
    const rows = db.prepare('SELECT id, name FROM projects WHERE color_hue IS NULL').all() as Array<{ id: string; name: string }>
    if (rows.length) {
      const update = db.prepare('UPDATE projects SET color_hue = ? WHERE id = ?')
      const tx = db.transaction(() => {
        for (const row of rows) update.run(hueForProjectName(row.name), row.id)
      })
      tx()
      console.log(`[Projects] Assigned identity colors to ${rows.length} project(s)`)
    }
    colorBackfillDone = true
  } catch (err) {
    // Next call retries: the flag is only set on success.
    console.warn('[Projects] identity-color backfill failed:', err)
  }
}
