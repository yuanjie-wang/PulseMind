import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { ExpertProfile } from '../../shared/types/expert'
import { expertStore } from '../storage/expert-store'

export function registerExpertHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EXPERT_LIST, async (): Promise<ExpertProfile[]> => {
    return expertStore.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.EXPERT_CREATE, async (_event, profile: ExpertProfile): Promise<ExpertProfile[]> => {
    const profiles = await expertStore.getAll()
    profiles.push(profile)
    await expertStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.EXPERT_UPDATE, async (_event, profile: ExpertProfile): Promise<ExpertProfile[]> => {
    const profiles = await expertStore.getAll()
    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx === -1) throw new Error(`专家不存在: ${profile.id}`)
    profiles[idx] = profile
    await expertStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.EXPERT_DELETE, async (_event, id: string): Promise<ExpertProfile[]> => {
    const profiles = await expertStore.getAll()
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`专家不存在: ${id}`)
    profiles.splice(idx, 1)
    await expertStore.save(profiles)
    return profiles
  })

  ipcMain.handle(IPC_CHANNELS.EXPERT_RESET, async (): Promise<ExpertProfile[]> => {
    return expertStore.reset()
  })
}
