// ── Project IPC handlers (PLAN-0.4.0 M3.2) ──
// CRUD only — the management UI (project center) is gone; the welcome page's
// project picker is the remaining consumer (list/create, plus edit from the
// welcome flow's create modal).

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { projectStore } from '../storage/project-store'
import type { ProjectCreateInput, ProjectUpdateInput } from '../../shared/types/project'

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
  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_event, id: string, patch: ProjectUpdateInput) => projectStore.update(id, patch))

  // Input-time probe for the create modal's workspace field. Returns a result
  // instead of throwing so the renderer needs no per-keystroke try/catch.
  ipcMain.handle(IPC_CHANNELS.PROJECT_VALIDATE_DIR, (_event, workspaceDir: string) => {
    if (typeof workspaceDir !== 'string') return { ok: false, error: '工作区路径格式不正确' }
    return projectStore.validateWorkspaceDir(workspaceDir.trim())
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_event, id: string) => projectStore.remove(id))
}
