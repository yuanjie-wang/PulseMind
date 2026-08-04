import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { skillStore } from '../storage/skill-store'
import type { SkillDefinition } from '../../shared/types/skill-types'

export function registerSkillHandlers(): void {
  // Preferences
  ipcMain.handle(IPC_CHANNELS.SKILLS_GET_PREFERENCES, async () => {
    return skillStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.SKILLS_SET_PREFERENCES, (event, prefs) => {
    skillStore.set(prefs)
    event.sender.send(IPC_CHANNELS.SKILLS_CHANGED)
  })

  // Import from .zip (opens file dialog)
  ipcMain.handle(IPC_CHANNELS.SKILLS_IMPORT, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Skill (.zip)',
      filters: [{ name: 'Skill Package', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return skillStore.importFromZip(result.filePaths[0])
  })

  // List imported skills (called on app startup)
  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST_IMPORTED, async () => {
    return skillStore.listImported()
  })

  // Delete an imported skill
  ipcMain.handle(IPC_CHANNELS.SKILLS_DELETE_IMPORTED, async (_event, name: string) => {
    await skillStore.deleteImported(name)
  })

  // Ensure built-in skills exist on disk (called on app startup)
  ipcMain.handle(IPC_CHANNELS.SKILLS_ENSURE_BUILT_IN, async (_event, skills: SkillDefinition[]) => {
    await skillStore.ensureBuiltInSkills(skills)
  })

  // Install a skill from disk (reads SKILL.md, parses it, returns SkillDefinition)
  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALL, async (_event, name: string) => {
    return skillStore.install(name)
  })

  // Read raw SKILL.md content from disk
  ipcMain.handle(IPC_CHANNELS.SKILLS_READ_RAW, async (_event, name: string) => {
    return skillStore.readRawContent(name)
  })

  // Write a skill definition to disk as SKILL.md
  ipcMain.handle(IPC_CHANNELS.SKILLS_WRITE, async (_event, skill: SkillDefinition) => {
    await skillStore.write(skill)
  })
}
