// ── Tool studio IPC handlers (PLAN-0.4.0 M5.3) ──

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { toolStore } from '../storage/tool-store'
import { svcToolBridgeInvoke } from '../tool-runtime'
import type { ToolCreateInput, ToolUpdateInput } from '../../shared/types/user-tool'

export function registerToolStudioHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TOOLBRIDGE_INVOKE, (_event, toolId: string, method: string, params: Record<string, unknown>) =>
    svcToolBridgeInvoke(toolId, method, params))
  ipcMain.handle(IPC_CHANNELS.TOOL_LIST, () => toolStore.list())
  ipcMain.handle(IPC_CHANNELS.TOOL_LIST_TEMPLATES, () => toolStore.listTemplates())
  ipcMain.handle(IPC_CHANNELS.TOOL_GET, (_event, id: string) => toolStore.get(id))

  ipcMain.handle(IPC_CHANNELS.TOOL_CREATE, (_event, input: ToolCreateInput) => {
    if (!input || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('工具名称不能为空')
    }
    return toolStore.create(input)
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_UPDATE, (_event, id: string, patch: ToolUpdateInput) => toolStore.update(id, patch))
  ipcMain.handle(IPC_CHANNELS.TOOL_DELETE, (_event, id: string) => toolStore.remove(id))

  ipcMain.handle(IPC_CHANNELS.TOOL_CLONE_TEMPLATE, (_event, templateId: string, name?: string) => {
    return toolStore.create({ name: name || '我的工具', sourceTemplateId: templateId })
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_READ_HTML, (_event, id: string) => toolStore.readHtml(id))
  ipcMain.handle(IPC_CHANNELS.TOOL_READ_TEMPLATE_HTML, (_event, templateId: string) => toolStore.readTemplateHtml(templateId))

  ipcMain.handle(IPC_CHANNELS.TOOL_WRITE_HTML, (_event, id: string, html: string) => {
    toolStore.writeHtml(id, html)
  })
}
