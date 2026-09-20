// ── Conversation workspace resolution (PLAN-0.4.0 M8) ──
// Single entry point for "which directory does this conversation work in".
// Resolved ONCE per conversation and persisted on `conversations.workspace_dir`:
//   1. already stored → returned as-is (idempotent across restarts);
//   2. bound to a (non-default) project → the project's fixed workspace;
//   3. otherwise → a fresh `yyyyMMddHHmmss` folder under the global workspace,
//      minted (named + persisted) here but NOT created: the directory is
//      materialized on first genuine use — a file write into it (file-ops
//      creates parent dirs) or a shell cwd inside it (terminal ensures the
//      cwd). Idle chats therefore leave no empty folders behind.
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

/** Mint `<global workspace>/yyyyMMddHHmmss` (collision-safe: `-2`, `-3`…) —
 *  the NAME only: no mkdir. The path is persisted immediately so it is stable
 *  for the conversation's life, while the directory itself materializes at the
 *  first write/exec that needs it (user report 2026-09-20: idle chats were
 *  leaving an empty timestamped folder per conversation). The readdir is what
 *  keeps a mint from claiming a name already taken on disk; a same-second race
 *  between two first resolutions can still share a name — it could before the
 *  change too (recursive mkdir never failed), so behavior is unchanged. */
async function createTimestampedWorkspaceDir(convId: string): Promise<string> {
  const base = await globalWorkspaceDir()
  const preferred = conversationDirNameFor(convId) ?? formatConversationDirName(new Date())
  const existing = existsSync(base) ? await readdir(base) : []
  return join(base, nextConversationDirName(existing, preferred))
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
    if (project?.workspaceDir) {
      // The project's dir is normally materialized at creation; recreate it if
      // it was deleted on disk. Failing hard (instead of falling through to a
      // timestamped dir) keeps the jail root consistent.
      try {
        await mkdir(project.workspaceDir, { recursive: true })
      } catch (err) {
        throw new Error(`项目工作区目录不可用（${project.workspaceDir}）：${err instanceof Error ? err.message : String(err)}`)
      }
      dir = project.workspaceDir
    }
  }
  if (!dir) dir = await createTimestampedWorkspaceDir(convId)

  setConversationWorkspaceDir(convId, dir)
  return dir
}
