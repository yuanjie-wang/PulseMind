// ── 一次性模板包导入（2026-11-05）──
// 无密钥 welcome 引导卡的「导入模板包」：zip = 整份 settings.json（团队从配置
// 好的机器拷出）+ 可选 skills/（与技能 zip 导入同一落盘形态）+ 可选 hooks/
// （登录/请求钩子，2026-11-10 补）+ 可选 tools/（工具工作室产出的用户工具，
// 2026-11-10 补）。入口是一次性的——只挂在无密钥引导卡上，设置页无常驻入口；
// 语义是整份替换（用户裁定），settingsStore.set 走既有管线，主题/locale 等随
// 模板走，不做字段级合并。
// 纯逻辑（校验/补 id/密文警告）在 services/template-import.ts，内容定位在
// services/template-pack.ts，hooks 落盘在 services/template-hooks.ts，tools
// 落盘在 services/template-tools.ts，这里只做 dialog + 解压 + 落盘 + 生效 + 广播。
//
// 2026-11-10 四处修正：
// ① 内容定位改由 locateTemplatePack 负责（包装目录里的 settings.json 也算数）；
// ② 失败一律进 result.error（结构化），不再混进 warnings——旧实现把「解析失败」
//    与「没找到」都当警告，且「没找到」的条件覆盖了「找到了但坏了」，用户看到的
//    提示与事实相反；③ 写盘后跑 applySettingsSideEffects（与 SETTINGS_SET 同一
//    份），导入的配置立刻生效而不是等重启；④ hooks/ 新增落盘臂（旧实现只有
//    settings 与 skills 两条，包里的 app-start.js / llm-request.js 被静默忽略）。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { skillStore } from '../storage/skill-store'
import { HOOKS_DIR, TOOLS_DIR } from '../storage/index'
import { rerunAppStartHook } from '../hooks-runner'
import { registerLiveSkills } from '../agent/live-skill-registry'
import { logMain, describeError } from '../main-log'
import { withZipExtraction } from '../utils/zip-extractor'
import { validateTemplateSettings, sanitizeTemplateSettings } from '../services/template-import'
import { locateTemplatePack } from '../services/template-pack'
import { importHookFiles } from '../services/template-hooks'
import { importToolDirs } from '../services/template-tools'
import { applySettingsSideEffects } from '../services/settings-side-effects'
import type { TemplateImportResult } from '../../shared/types/electron-bridge'

function emptyResult(): TemplateImportResult {
  return {
    settingsApplied: false,
    warnings: [],
    skills: { imported: [], skipped: [], errors: [], warnings: [] },
    hooks: { imported: [], replaced: [], unchanged: [], errors: [] },
    tools: { imported: [], replaced: [], unchanged: [], errors: [] },
    appStartTriggered: false,
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
    // hooks/ 这次到底改没改盘？决定导入结束后要不要就地重跑 app-start。
    // 辅助文件（app-start.js require 的模块）同样算变化：换掉 helper 也是换
    // 了启动钩子的行为。llm-request.js 变化会顺带触发一次重跑（它可能共用
    // helper），代价是钩子多跑一次，好过漏掉真正依赖 helper 的 app-start。
    let hooksChanged = false

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

        // 3) hooks/ — app-start.js / llm-request.js（及它们 require 的辅助文件）
        //    落进 ~/.pulsemind/hooks/。旧实现完全没有这条臂：包里的钩子被静默
        //    忽略，用户只看到「导入成功」。落盘语义（缺的补、同字节跳过、不同
        //    先备份再覆盖、包外文件不删）在 services/template-hooks.ts。
        if (located.hooksDir) {
          try {
            const hooksResult = await importHookFiles(located.hooksDir, HOOKS_DIR)
            result.hooks = hooksResult
            for (const error of hooksResult.errors) {
              logMain('ERROR', 'template', error)
            }
            if (hooksResult.imported.length > 0 || hooksResult.replaced.length > 0) {
              hooksChanged = true
              logMain('INFO', 'template', `hooks imported: ${[...hooksResult.imported, ...hooksResult.replaced].join(', ')}`)
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            result.hooks.errors.push(`hooks/ 导入失败：${message}`)
            logMain('ERROR', 'template', `hooks import failed: ${describeError(err)}`)
          }
        }

        // 4) tools/ — 用户工具（工具工作室产出）落进 ~/.pulsemind/tools/<id>/。
        //    与 hooks 同一条缺陷：旧实现没有这条臂，团队模板里的工具一个都
        //    不落盘。落盘语义（逐目录比较、整目录备份后覆盖、预置/运行数据
        //    跳过）在 services/template-tools.ts。
        if (located.toolsDir) {
          try {
            const toolsResult = await importToolDirs(located.toolsDir, TOOLS_DIR)
            result.tools = toolsResult
            for (const error of toolsResult.errors) {
              logMain('ERROR', 'template', error)
            }
            if (toolsResult.imported.length > 0 || toolsResult.replaced.length > 0) {
              logMain('INFO', 'template', `tools imported: ${[...toolsResult.imported, ...toolsResult.replaced].join(', ')}`)
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            result.tools.errors.push(`tools/ 导入失败：${message}`)
            logMain('ERROR', 'template', `tools import failed: ${describeError(err)}`)
          }
        }
      })
    } catch (err) {
      // 到这里只可能是解压/清理本身炸了（各载荷臂各自兜底）：什么都没落地。
      logMain('ERROR', 'template', `zip extraction failed: ${describeError(err)}`)
      return { ...emptyResult(), error: `压缩包读取失败：${describeError(err)}` }
    }

    // 启动钩子就地重跑，而不是重启整个应用（user 2026-11-11「我其实是想
    // 能够触发app-start脚本」）。重启只为让启动期脚本生效，却会杀掉进行中
    // 的会话/任务/终端并丢草稿；settings/skills/tools 本来就有热生效通道，
    // 唯一缺的 side effect 就是 app-start。硬错误（解压/解析/校验/写盘）
    // 不触发：半套配置下跑登录钩子只会把状态搅得更乱，错误也要留在屏幕上。
    // 仅当 hooks 真有落盘变化且盘上存在 app-start.js 时才算「已触发」。
    result.appStartTriggered = !result.error && hooksChanged && existsSync(join(HOOKS_DIR, 'app-start.js'))

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

    // Fire-and-forget：登录钩子可能开窗等待用户扫码，耗时不可预知（看门狗
    // 兜底 10 分钟）；IPC 回复不能被它拖住，导入结果提示先落地。重跑期间
    // 发起的请求经 ensureLaunchHooks() 等到它结束，新 env 才会被消费。
    if (result.appStartTriggered) {
      void rerunAppStartHook()
        .then((outcome) => {
          if (outcome.error) {
            logMain('ERROR', 'template', `app-start re-run failed: ${outcome.error}`)
          } else if (outcome.timedOut) {
            logMain('WARN', 'template', 'app-start re-run timed out; previous env kept')
          } else if (!outcome.ran) {
            logMain('WARN', 'template', 'app-start re-run skipped: no exported hook function')
          } else {
            logMain('INFO', 'template', `app-start re-run completed (${outcome.envKeys} env var(s))`)
          }
        })
        .catch((err) => {
          logMain('ERROR', 'template', `app-start re-run crashed: ${describeError(err)}`)
        })
    }

    return result
  })
}
