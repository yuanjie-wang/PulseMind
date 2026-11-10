// ── 一次性模板包导入（2026-11-05）──
// 无密钥 welcome 引导卡的「导入模板包」：zip = 整份 settings.json（团队从配置
// 好的机器拷出）+ 可选 skills/（与技能 zip 导入同一落盘形态）。入口是一次性的
// ——只挂在无密钥引导卡上，设置页无常驻入口；语义是整份替换（用户裁定），
// settingsStore.set 走既有管线，主题/locale 等随模板走，不做字段级合并。
// 纯逻辑（校验/补 id/密文警告）在 services/template-import.ts，内容定位在
// services/template-pack.ts，这里只做 dialog + 解压 + 落盘 + 生效 + 广播。
//
// 2026-11-10 三处修正：
// ① 内容定位改由 locateTemplatePack 负责（包装目录里的 settings.json 也算数）；
// ② 失败一律进 result.error（结构化），不再混进 warnings——旧实现把「解析失败」
//    与「没找到」都当警告，且「没找到」的条件覆盖了「找到了但坏了」，用户看到的
//    提示与事实相反；③ 写盘后跑 applySettingsSideEffects（与 SETTINGS_SET 同一
//    份），导入的配置立刻生效而不是等重启。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { skillStore } from '../storage/skill-store'
import { registerLiveSkills } from '../agent/live-skill-registry'
import { logMain, describeError } from '../main-log'
import { withZipExtraction } from '../utils/zip-extractor'
import { validateTemplateSettings, sanitizeTemplateSettings } from '../services/template-import'
import { locateTemplatePack } from '../services/template-pack'
import { applySettingsSideEffects } from '../services/settings-side-effects'
import type { TemplateImportResult } from '../../shared/types/electron-bridge'

function emptyResult(): TemplateImportResult {
  return {
    settingsApplied: false,
    warnings: [],
    skills: { imported: [], skipped: [], errors: [], warnings: [] },
  }
}

export function registerTemplateHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TEMPLATE_IMPORT, async (event): Promise<TemplateImportResult | null> => {
    let picked: Awaited<ReturnType<typeof dialog.showOpenDialog>>
    try {
      picked = await dialog.showOpenDialog({
        title: 'Import Template Pack (.zip)',
        filters: [{ name: 'Template Package', extensions: ['zip'] }],
        properties: ['openFile'],
      })
    } catch (err) {
      logMain('ERROR', 'template', `open dialog failed: ${describeError(err)}`)
      return { ...emptyResult(), error: `打开文件选择框失败：${describeError(err)}` }
    }
    if (picked.canceled || picked.filePaths.length === 0) return null

    const result = emptyResult()

    // 解压失败（损坏/非 zip/无权限）必须落成结构化错误：旧实现让它逃成 IPC
    // rejection，渲染端只剩一句泛化的「导入失败」，主日志也没有任何痕迹。
    try {
      await withZipExtraction(picked.filePaths[0], async (extractDir) => {
        const located = await locateTemplatePack(extractDir)

        // 1) settings.json — whole-file replacement through the store's normal
        //    write chain (normalizeProviders / restorePlaceholders / encodeSecrets
        //    opt-in / derived profiles re-derivation all live inside set()).
        if (located.settingsPath) {
          let parsed: unknown
          try {
            parsed = JSON.parse(await readFile(located.settingsPath, 'utf-8'))
          } catch (err) {
            result.error = `settings.json 解析失败：${describeError(err)}`
            logMain('ERROR', 'template', `settings.json parse failed: ${describeError(err)}`)
            parsed = null
          }
          if (parsed != null) {
            const validated = validateTemplateSettings(parsed)
            if (validated.error || !validated.settings) {
              result.error = validated.error ?? 'settings.json 结构无效'
              logMain('ERROR', 'template', `settings.json rejected: ${result.error}`)
            } else {
              const sanitized = sanitizeTemplateSettings(validated.settings)
              result.warnings.push(...sanitized.warnings)
              try {
                await settingsStore.set(sanitized.settings)
                result.settingsApplied = true
              } catch (err) {
                // 写盘失败（磁盘满/EACCES/rename 失败）：设置没落地，如实报错，
                // 不冒充「已应用」。
                result.error = `settings.json 写入失败：${describeError(err)}`
                logMain('ERROR', 'template', `settings write failed: ${describeError(err)}`)
              }
            }
          }
        }

        // 2) skills/ — same on-disk shape as a skill zip; duplicates skip.
        // 「无 skills/ = 纯配置包」只由定位结果判定（settings 臂同形）：walk/
        // readFile/cp/活体登记的真实故障必须落 issues 面 + 主日志，不得吞成
        // 「选错文件」（review_20261106 中2：旧写法一个 catch 包住全部）。
        if (located.skillsDir) {
          try {
            // store 的返回形状没有 skipped（重名串按错误返回，分流在下面）——
            // 先补齐 TemplateImportResult.skills 的字段再交给分流臂。
            const storeResult = await skillStore.importSkillsFromDirectory(located.skillsDir)
            result.skills = { ...storeResult, skipped: [] }
            // 重名跳过是幂等重复导入的预期行为，不是错误：分流进 skipped，
            // UI 对它保持沉默（用户裁定 2026-11-05：重复内容不弹提示）。
            const dupPattern = / already exists — skipped$/
            const dups = result.skills.errors.filter((e) => dupPattern.test(e))
            if (dups.length > 0) {
              result.skills = {
                ...result.skills,
                skipped: dups,
                errors: result.skills.errors.filter((e) => !dupPattern.test(e)),
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
    } catch (err) {
      // 到这里只可能是解压/清理本身炸了（两个载荷臂各自兜底）：什么都没落地。
      logMain('ERROR', 'template', `zip extraction failed: ${describeError(err)}`)
      return { ...emptyResult(), error: `压缩包读取失败：${describeError(err)}` }
    }

    // 生效动作与设置页保存共用一份（主题重绘 / 开机自启 / 休眠守卫 / 记忆开关 /
    // 菜单语言 / 保留期清扫），随后广播存储层视图：渲染端从合并后的 profiles
    // 重新推 hasApiKey，引导卡自己让位——调用方无需手动 reload。
    if (result.settingsApplied) {
      // 解压/落盘可能耗时数秒，发起窗口未必还在——取不到就只跑无窗口动作，
      // 不能因为窗口没了把整串生效动作一起跳过。
      let senderWindow: BrowserWindow | null = null
      try {
        senderWindow = BrowserWindow.fromWebContents(event.sender)
      } catch {
        /* window gone */
      }
      try {
        await applySettingsSideEffects(await settingsStore.get(), { window: senderWindow })
      } catch (err) {
        // 副作用是尽力而为（设置已落盘）；失败只落日志，不改判定。
        logMain('ERROR', 'template', `settings side effects failed: ${describeError(err)}`)
      }
    }
    if (result.skills.imported.length > 0) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send(IPC_CHANNELS.SKILLS_CHANGED)
          } catch {
            /* window closing */
          }
        }
      }
    }

    return result
  })
}
