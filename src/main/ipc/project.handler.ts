// ── Project IPC handlers (PLAN-0.4.0 M3.2) ──

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { projectStore } from '../storage/project-store'
import { auditStore } from '../storage/audit-store'
import { detectSandboxSupport } from '../sandbox/exec-sandbox'
import type { ProjectCreateInput, ProjectUpdateInput } from '../../shared/types/project'

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => projectStore.list())

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, (_event, id: string) => projectStore.get(id))

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_event, input: ProjectCreateInput) => {
    if (!input || typeof input.name !== 'string' || typeof input.workspaceDir !== 'string' || !input.workspaceDir.trim()) {
      throw new Error('项目名称和工作区目录不能为空')
    }
    return projectStore.create(input)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_event, id: string, patch: ProjectUpdateInput) => projectStore.update(id, patch))

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_event, id: string) => projectStore.remove(id))

  ipcMain.handle(IPC_CHANNELS.AUDIT_LIST, (_event, limit?: number) => auditStore.list(limit))

  ipcMain.handle(IPC_CHANNELS.SANDBOX_DETECT, () => detectSandboxSupport())
}
