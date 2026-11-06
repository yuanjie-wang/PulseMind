// ── 一次性模板包导入（2026-11-05）──
// 无密钥 welcome 引导卡的「导入模板包」：zip = 整份 settings.json（团队从配置
// 好的机器拷出）+ 可选 skills/（与技能 zip 导入同一落盘形态）。入口是一次性的
// ——只挂在无密钥引导卡上，设置页无常驻入口；语义是整份替换（用户裁定），
// settingsStore.set 走既有管线，主题/locale 等随模板走，不做字段级合并。
// 纯逻辑（校验/补 id/密文警告）在 services/template-import.ts，这里只做
// dialog + 解压 + 落盘 + 广播。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { skillStore } from '../storage/skill-store'
import { registerLiveSkills } from '../agent/live-skill-registry'
import { logMain, describeError } from '../main-log'
import { withZipExtraction } from '../utils/zip-extractor'
import { validateTemplateSettings, sanitizeTemplateSettings } from '../services/template-import'
import type { TemplateImportResult } from '../../shared/types/electron-bridge'

export function registerTemplateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_IMPORT, async (): Promise<TemplateImportResult | null> => {
    const picked = await dialog.showOpenDialog({
      title: 'Import Template Pack (.zip)',
      filters: [{ name: 'Template Package', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null

    const result: TemplateImportResult = {
      settingsApplied: false,
      warnings: [],
      skills: { imported: [], skipped: [], errors: [], warnings: [] }
    }

    await withZipExtraction(picked.filePaths[0], async (extractDir) => {
      // 1) settings.json — whole-file replacement through the store's normal
      //    write chain (normalizeProviders / restorePlaceholders / encodeSecrets
      //    opt-in / derived profiles re-derivation all live inside set()).
      const settingsPath = join(extractDir, 'settings.json')
      let hasSettings = false
      try {
        await access(settingsPath)
        hasSettings = true
      } catch { /* 纯技能包合法 */ }
      if (hasSettings) {
        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(settingsPath, 'utf-8'))
        } catch (err) {
          result.warnings.push(`settings.json 解析失败：${err instanceof Error ? err.message : String(err)}`)
          parsed = null
        }
        if (parsed != null) {
          const validated = validateTemplateSettings(parsed)
          if (validated.error || !validated.settings) {
            result.warnings.push(validated.error ?? 'settings.json 结构无效')
          } else {
            const sanitized = sanitizeTemplateSettings(validated.settings)
            result.warnings.push(...sanitized.warnings)
            await settingsStore.set(sanitized.settings)
            result.settingsApplied = true
          }
        }
      }

      // 2) skills/ — same on-disk shape as a skill zip; duplicates skip.
      // 「无 skills/ = 纯配置包」只由 access 判定（settings 臂同形）：walk/
      // readFile/cp/活体登记的真实故障必须落 issues 面 + 主日志，不得吞成
      // 「选错文件」（review_20261106 中2：旧写法一个 catch 包住全部）。
      const skillsRoot = join(extractDir, 'skills')
      let hasSkills = false
      try {
        await access(skillsRoot)
        hasSkills = true
      } catch { /* 无 skills/ 目录 = 纯配置包 */ }
      if (hasSkills) {
        try {
          // store 的返回形状没有 skipped（重名串按错误返回，分流在下面）——
          // 先补齐 TemplateImportResult.skills 的字段再交给分流臂。
          const storeResult = await skillStore.importSkillsFromDirectory(skillsRoot)
          result.skills = { ...storeResult, skipped: [] }
          // 重名跳过是幂等重复导入的预期行为，不是错误：分流进 skipped，
          // UI 对它保持沉默（用户裁定 2026-11-05：重复内容不弹提示）。
          const dupPattern = / already exists — skipped$/
          const dups = result.skills.errors.filter((e) => dupPattern.test(e))
          if (dups.length > 0) {
            result.skills = {
              ...result.skills,
              skipped: dups,
              errors: result.skills.errors.filter((e) => !dupPattern.test(e))
            }
          }
          // 盘上落定 ≠ 引擎可见：主进程共享 SkillManager 只在首个会话创建时扫
          // 一次盘（ensureManagers），必须同步登记（与技能 zip 导入同一对调用）。
          if (result.skills.imported.length > 0) {
            try {
              registerLiveSkills(result.skills.imported)
            } catch (err) {
              // 落盘已成功、只差引擎登记：如实告知重启后生效，不与落盘故障混淆
              //（review_20261106 中2 ②：被吞时该批技能对 pick_skill 隐形到重启）。
              const message = err instanceof Error ? err.message : String(err)
              result.skills.errors.push(`技能已导入，但引擎登记失败（重启后生效）：${message}`)
              logMain('ERROR', 'template', `live skill registration failed: ${describeError(err)}`)
            }
          }
        } catch (err) {
          // 权限/EBUSY/半截解压等真实故障：issues 面接住 + 主日志留痕
          //（打包态 GUI 无终端，console 不可见——logMain 是唯一落盘诊断面）。
          const message = err instanceof Error ? err.message : String(err)
          result.skills.errors.push(`skills/ 导入失败：${message}`)
          logMain('ERROR', 'template', `skills import failed: ${describeError(err)}`)
        }
      }
    })

    // 两者皆无 = 不是模板包，如实告诉调用方。
    if (!result.settingsApplied && result.skills.imported.length === 0) {
      result.warnings.push('压缩包里没有找到 settings.json 或 skills/ 目录')
    }

    // Broadcast the store's view (same pattern as SETTINGS_SET): the renderer
    // re-derives hasApiKey from the merged profiles and the guide card steps
    // aside on its own — no manual reload on the caller's side.
    if (result.settingsApplied) {
      try {
        const fresh = await settingsStore.get()
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            try { win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, fresh) } catch { /* window closing */ }
          }
        }
      } catch (err) {
        console.warn('[template] failed to broadcast settings change:', err)
      }
    }
    if (result.skills.imported.length > 0) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          try { win.webContents.send(IPC_CHANNELS.SKILLS_CHANGED) } catch { /* window closing */ }
        }
      }
    }

    return result
  })
}
