import { ipcMain, dialog } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { skillStore } from '../storage/skill-store'
import { listSkillUses, recordSkillUse } from '../storage/skill-use-store'
import { registerLiveSkills, unregisterLiveSkill } from '../agent/live-skill-registry'
import { SKILLS_DIR } from '../storage'
import type { SkillDefinition, SkillPreferencesPatch } from '../../shared/types/skill-types'

/** 技能中心卡片的「使用 N 次 · 安装于 …」：计数来自 skill_uses，安装时间 = 技能目录
 *  的创建时间（birthtime；拿不到的文件系统回落 ctime）。零使用的技能也要有安装时间，
 *  所以按磁盘目录而不是按计数行枚举。 */
async function listSkillUseInfo(): Promise<Record<string, { useCount: number; lastUsedAt: string | null; installedAt: string | null }>> {
  const out: Record<string, { useCount: number; lastUsedAt: string | null; installedAt: string | null }> = {}
  for (const row of listSkillUses()) out[row.name] = { useCount: row.useCount, lastUsedAt: row.lastUsedAt, installedAt: null }
  let dirs: string[] = []
  try { dirs = await readdir(SKILLS_DIR) } catch { /* 目录不存在 = 无已安装技能 */ }
  for (const name of dirs) {
    if (name.startsWith('.')) continue
    try {
      const s = await stat(join(SKILLS_DIR, name))
      if (!s.isDirectory()) continue
      const ms = s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs
      const entry = out[name] ?? (out[name] = { useCount: 0, lastUsedAt: null, installedAt: null })
      entry.installedAt = new Date(ms).toISOString()
    } catch { /* 单个目录读不到不影响其余 */ }
  }
  return out
}

export function registerSkillHandlers(): void {
  // 技能使用计数（2026-10-27）
  ipcMain.handle(IPC_CHANNELS.SKILL_USE_RECORD, async (_event, name: string) => {
    if (typeof name === 'string' && name.trim()) recordSkillUse(name.trim())
  })
  ipcMain.handle(IPC_CHANNELS.SKILL_USE_LIST, async () => listSkillUseInfo())

  // Preferences
  ipcMain.handle(IPC_CHANNELS.SKILLS_GET_PREFERENCES, async () => {
    return skillStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.SKILLS_SET_PREFERENCES, (event, prefs) => {
    skillStore.set(prefs)
    event.sender.send(IPC_CHANNELS.SKILLS_CHANGED)
  })

  // Patch-shaped atomic update (PLAN-parallel-experts T10): merge instead of
  // whole-block replacement, so concurrent writers cannot clobber each other.
  ipcMain.handle(IPC_CHANNELS.SKILLS_UPDATE_PREFERENCES, (event, patch: SkillPreferencesPatch) => {
    skillStore.update(patch)
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
    const imported = await skillStore.importFromZip(result.filePaths[0])
    // 盘上落定 ≠ 引擎可见：主进程共享 SkillManager 只在首个会话创建时扫一
    // 次盘（ensureManagers），这里必须同步登记，否则 pick_skill 要到重启才
    // 能找到新导入的技能（live-skill-registry；渲染端 importSkill 的注册只
    // 服务 UI 列表，够不到引擎）。
    if (imported.imported.length > 0) registerLiveSkills(imported.imported)
    return imported
  })

  // List imported skills (called on app startup)
  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST_IMPORTED, async () => {
    return skillStore.listImported()
  })

  // Delete an imported skill
  ipcMain.handle(IPC_CHANNELS.SKILLS_DELETE_IMPORTED, async (_event, name: string) => {
    await skillStore.deleteImported(name)
    // 镜像摘除：注册表若还留着，pick_skill 会在文件已删后经
    // freshSkillDefinition 的回落臂拿到旧全文——已删除的技能在对话里继续
    // 「可用」。渲染端的 removeSkill prefs 补丁只清启用名单，够不到注册表。
    unregisterLiveSkill(name)
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

  // Write a raw SKILL.md verbatim (the agent install tool's `content`). The
  // sanctioned door into the deny-rooted skills dir — validation, the
  // no-overwrite rule and the path anchoring all live in the store.
  ipcMain.handle(IPC_CHANNELS.SKILLS_WRITE_SOURCE, async (event, content: string, expectedName?: string) => {
    const res = await skillStore.writeRawSkill(content, expectedName)
    if (res.ok) event.sender.send(IPC_CHANNELS.SKILLS_CHANGED)
    return res
  })

  // List a skill directory's files (skill-relative paths) for the browser view
  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST_FILES, async (_event, name: string) => {
    return skillStore.listFiles(name)
  })

  // Read one file inside a skill directory (skill-relative path)
  ipcMain.handle(IPC_CHANNELS.SKILLS_READ_FILE, async (_event, name: string, relPath: string) => {
    return skillStore.readFileContent(name, relPath)
  })
}
