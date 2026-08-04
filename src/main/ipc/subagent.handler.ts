import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { SubAgentProfile } from '../../shared/types/subagent'
import { subAgentStore } from '../storage/subagent-store'

export function registerSubAgentHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SUBAGENT_LIST, async (): Promise<SubAgentProfile[]> => {
    return subAgentStore.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SUBAGENT_CREATE, async (_event, profile: SubAgentProfile): Promise<SubAgentProfile[]> => {
    const profiles = await subAgentStore.getAll()
    profiles.push(profile)
    await subAgentStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.SUBAGENT_UPDATE, async (_event, profile: SubAgentProfile): Promise<SubAgentProfile[]> => {
    const profiles = await subAgentStore.getAll()
    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx === -1) throw new Error(`子代理配置不存在: ${profile.id}`)
    profiles[idx] = profile
    await subAgentStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.SUBAGENT_DELETE, async (_event, id: string): Promise<SubAgentProfile[]> => {
    const profiles = await subAgentStore.getAll()
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`子代理配置不存在: ${id}`)
    if (profiles[idx].isBuiltIn) throw new Error('内置子代理配置不可删除')
    profiles.splice(idx, 1)
    await subAgentStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.SUBAGENT_RESET, async (): Promise<SubAgentProfile[]> => {
    return subAgentStore.reset()
  })
}
