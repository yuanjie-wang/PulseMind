// ── Conversation workspace resolution (PLAN-0.4.0 M8) ──
// Single entry point for "which directory does this conversation work in".
// Resolved ONCE per conversation and persisted on `conversations.workspace_dir`:
//   1. already stored → returned as-is (idempotent across restarts);
//   2. bound to a (non-default) project → the project's fixed workspace;
//   3. otherwise → a fresh `yyyyMMddHHmmss` folder under the global workspace,
//      created lazily on the conversation's first session.
// Callers: the agent-session IPC handler (local UI conversations). Routines,
// ws extension clients and spawn sub-agents pass their own workspaceDir and
// never go through here, so their behavior is unchanged.

import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb } from './database'
import { WORKSPACE_DIR } from './index'
import { settingsStore } from './settings-store'
import { projectStore } from './project-store'
import { setConversationWorkspaceDir } from './conversation.db'
import { DEFAULT_PROJECT_ID } from '../../shared/types/project'
import { conversationDirNameFor, formatConversationDirName, nextConversationDirName } from '../../shared/workspace-naming'

/** Rows created before this process started are OLD conversations: the one-shot
 *  backfill below must never claim them even when it runs late (a stub row from
 *  setConversationProject/saveConversation can exist before resolution). */
const PROCESS_START_ISO = new Date().toISOString()

let backfillDone = false

/** Give every pre-existing conversation the global workspace as its working
 *  directory, so resuming an old conversation keeps its historical behavior
 *  instead of minting a fresh timestamped folder (D-decision: 回填全局 workspace).
 *  Called from the startup sequence and again (cheap no-op) before the first
 *  resolution; safe to call repeatedly. */
export async function backfillConversationWorkspaces(): Promise<void> {
  if (backfillDone) return
  try {
    const settings = await settingsStore.get()
    const dir = settings.workspaceDir || WORKSPACE_DIR
    getDb()
      .prepare('UPDATE conversations SET workspace_dir = ? WHERE workspace_dir IS NULL AND created_at < ?')
      .run(dir, PROCESS_START_ISO)
    backfillDone = true
  } catch (err) {
    // Left un-backfilled, old conversations would get timestamped folders on
    // next resume — retry on the next resolution rather than caching the failure.
    console.warn('[workspace] workspace_dir backfill failed, will retry:', err)
  }
}

async function globalWorkspaceDir(): Promise<string> {
  const settings = await settingsStore.get()
  return settings.workspaceDir || WORKSPACE_DIR
}

/** Create `<global workspace>/yyyyMMddHHmmss` (collision-safe: `-2`, `-3`…). */
async function createTimestampedWorkspaceDir(convId: string): Promise<string> {
  const base = await globalWorkspaceDir()
  const preferred = conversationDirNameFor(convId) ?? formatConversationDirName(new Date())
  const existing = existsSync(base) ? await readdir(base) : []
  const dir = join(base, nextConversationDirName(existing, preferred))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Resolve (and persist) the conversation's working directory. */
export async function resolveConversationWorkspace(convId: string, explicitProjectId?: string): Promise<string> {
  await backfillConversationWorkspaces()

  const row = getDb()
    .prepare('SELECT workspace_dir, project_id FROM conversations WHERE id = ?')
    .get(convId) as { workspace_dir: string | null; project_id: string | null } | undefined
  if (row?.workspace_dir) return row.workspace_dir

  const boundProjectId = explicitProjectId && explicitProjectId !== DEFAULT_PROJECT_ID
    ? explicitProjectId
    : (row?.project_id && row.project_id !== DEFAULT_PROJECT_ID ? row.project_id : undefined)

  let dir: string | undefined
  if (boundProjectId) {
    const project = await projectStore.get(boundProjectId).catch(() => null)
    if (project?.workspaceDir) dir = project.workspaceDir
  }
  if (!dir) dir = await createTimestampedWorkspaceDir(convId)

  setConversationWorkspaceDir(convId, dir)
  return dir
}
