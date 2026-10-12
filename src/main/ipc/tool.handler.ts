// ── Tool studio IPC handlers (PLAN-0.4.0 M5.3; presets per M5R) ──

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { toolStore } from '../storage/tool-store'
import { getBundlePresetsDir } from '../storage'
import { deleteConversationWithWorkspace } from '../storage/conversation-workspace'
import { svcToolBridgeInvoke } from '../tool-runtime'
import type { ToolCreateInput, ToolUpdateInput } from '../../shared/types/user-tool'

export function registerToolStudioHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TOOLBRIDGE_INVOKE, (_event, toolId: string, method: string, params: Record<string, unknown>) =>
    svcToolBridgeInvoke(toolId, method, params))
  ipcMain.handle(IPC_CHANNELS.TOOL_LIST, () => toolStore.list())
  ipcMain.handle(IPC_CHANNELS.TOOL_GET, (_event, id: string) => toolStore.get(id))

  ipcMain.handle(IPC_CHANNELS.TOOL_CREATE, (_event, input: ToolCreateInput) => {
    if (!input || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('工具名称不能为空')
    }
    return toolStore.create(input)
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_UPDATE, (_event, id: string, patch: ToolUpdateInput) => toolStore.update(id, patch))

  ipcMain.handle(IPC_CHANNELS.TOOL_DELETE, async (_event, id: string) => {
    toolStore.remove(id)
    // Cascade: the tool's studio conversation (and its messages) would
    // otherwise linger forever. Best-effort — tool removal must not fail
    // because of conversation cleanup. Rides the workspace-converged entry
    // for uniformity: studio rows rarely mint under the global base, so the
    // guard usually refuses — and the row delete always proceeds.
    try {
      await deleteConversationWithWorkspace(`toolstudio_${id}`)
    } catch (err) {
      console.warn(`[tool] failed to clean studio conversation for ${id}:`, err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_DUPLICATE, (_event, id: string) => toolStore.duplicate(id))

  ipcMain.handle(IPC_CHANNELS.TOOL_READ_HTML, (_event, id: string) => toolStore.readHtml(id))

  ipcMain.handle(IPC_CHANNELS.TOOL_WRITE_HTML, (_event, id: string, html: string) => {
    toolStore.writeHtml(id, html)
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_DELETED_PRESETS, () => toolStore.getDeletedPresets())
  ipcMain.handle(IPC_CHANNELS.TOOL_RESTORE_PRESETS, () => toolStore.restorePresets(getBundlePresetsDir()))
}
