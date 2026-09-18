// ── Project IPC handlers (PLAN-0.4.0 M3.2; edit + overview 2026-09-18) ──
// CRUD only — the management UI (project center) is gone; the welcome page's
// project picker is the remaining consumer (list/create), plus the sidebar's
// and welcome cards' edit entries.

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { projectStore } from '../storage/project-store'
import { agentSessionManager } from '../agent/session-manager'
import { DEFAULT_PROJECT_ID, type ProjectCreateInput, type ProjectUpdateInput } from '../../shared/types/project'

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => projectStore.list())

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, (_event, id: string) => projectStore.get(id))

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_event, input: ProjectCreateInput) => {
    if (!input || typeof input.name !== 'string' || !input.name.trim() ||
        typeof input.workspaceDir !== 'string' || !input.workspaceDir.trim()) {
      throw new Error('项目名称和工作区目录不能为空')
    }
    return projectStore.create(input)
  })

  // workspaceDir is fixed at creation: ProjectUpdateInput has no such field and
  // projectStore.update never touches workspace_dir, so a smuggled-in value is
  // simply ignored here.
  // A successful save of a REAL project sweeps its bound live sessions so the
  // new name/overview rides their very next request (立即生效, 2026-09-18).
  // The default project is refused by the store (which still returns the
  // synthesized object) — no sweep for it: unbound conversations have no
  // project section to refresh.
  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, async (_event, id: string, patch: ProjectUpdateInput) => {
    const updated = await projectStore.update(id, patch)
    if (updated && id !== DEFAULT_PROJECT_ID) {
      void agentSessionManager.refreshProjectSessions(id).catch((err) => {
        console.warn('[Project] post-update session sweep failed:', err)
      })
    }
    return updated
  })

  // Input-time probe for the create modal's workspace field. Returns a result
  // instead of throwing so the renderer needs no per-keystroke try/catch.
  ipcMain.handle(IPC_CHANNELS.PROJECT_VALIDATE_DIR, (_event, workspaceDir: string) => {
    if (typeof workspaceDir !== 'string') return { ok: false, error: '工作区路径格式不正确' }
    return projectStore.validateWorkspaceDir(workspaceDir.trim())
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_event, id: string) => projectStore.remove(id))

  // The sidebar's drag-to-reorder: the full display order of user projects.
  // Validation lives in projectStore.reorder (array-of-strings gate), same as
  // PROJECT_CREATE validates its input at the handler boundary.
  ipcMain.handle(IPC_CHANNELS.PROJECT_REORDER, (_event, orderedIds: string[]) => projectStore.reorder(orderedIds))
}
