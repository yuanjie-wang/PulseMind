import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { experienceStore } from '../storage/experience-store'
import type { ExperienceDraft } from '../../shared/types/experience-types'

export function registerExperienceHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.EXPERIENCES_LIST, async () => {
    return experienceStore.list()
  })

  ipcMain.handle(IPC_CHANNELS.EXPERIENCES_SAVE, async (event, draft: ExperienceDraft) => {
    const result = await experienceStore.save(draft)
    event.sender.send(IPC_CHANNELS.EXPERIENCES_CHANGED)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.EXPERIENCES_DELETE, async (event, name: string) => {
    await experienceStore.delete(name)
    event.sender.send(IPC_CHANNELS.EXPERIENCES_CHANGED)
  })

  ipcMain.handle(IPC_CHANNELS.EXPERIENCES_READ, async (_event, name: string) => {
    return experienceStore.read(name)
  })

  ipcMain.handle(IPC_CHANNELS.EXPERIENCES_TOUCH, async (_event, name: string) => {
    experienceStore.touch(name)
  })
}
