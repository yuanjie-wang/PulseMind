// PLAN-share-import-export：分享 IPC 面。三个通道：
// - SHARE_EXPORT：主进程一气呵成（读存储 → 消毒 → showSaveDialog → 写盘）——
//   渲染端不经手文件内容。
// - SHARE_IMPORT_PREVIEW：openDialog → 解析 → 消毒/校验 → 暂存（importToken，
//   单槽覆盖）→ 预览行。消毒后的 payload 只在主进程内存。
// - SHARE_IMPORT_COMMIT：只收 importToken + 分辨率——渲染端回传本体被结构性
//   排除，杜绝「预览是消毒版、提交是未消毒版」的两版漂移。
//
// 导入 = 创建（重铸 id）；覆盖更新走 store.update（保留原 id 与 createdAt，
// 运行历史自然还在）；绝不静默覆盖（技能导入纪律的扩展）。导入必经
// store.create/update / workflowStore.save——绝不裸写 routines/、workflows/ 目录。

import { dialog, ipcMain, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import {
  buildEnvelope,
  parseShareFile,
  sanitizeRoutineForExport,
  routinePreviewWarnings,
  routineSummary,
  workflowSummary,
  workflowExportPayload,
  shareNameOf,
  workflowPreview,
} from '../../shared/share/sanitize'
import type { ShareItem, ShareImportResolution, ShareImportPreviewResult, SharePreviewItem } from '../../shared/share/types'
import { validateWorkflow } from '../../shared/workflow/validate'
import type { WorkflowDefinition } from '../../shared/workflow/types'
import { routineStore } from '../storage/routine-store'
import type { Routine } from '../../shared/types/routine'
import { workflowStore } from '../storage/workflow-store'

/** 预览暂存（单槽：新预览覆盖旧 token；过期 token 拒提交）。 */
const pendingImports = new Map<string, Array<{ kind: ShareItem['kind']; payload: Record<string, unknown> }>>()

/** 本机已注册技能名（内置 + 导入），best-effort——读取失败 = 不做缺失警示。 */
async function installedSkillNames(): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    const { BUILT_IN_SKILLS } = await import('../../renderer/src/skills/built-in-skills')
    for (const s of BUILT_IN_SKILLS) names.add(s.name)
    const { skillStore } = await import('../storage/skill-store')
    for (const s of await skillStore.listImported()) names.add(s.name)
  } catch {
    /* 预览警示降级为不做 */
  }
  return names
}

/** 导出文件名消毒：去路径成分与非法字符（routine-store 的 M9-P0-1 同款方向）。 */
function safeExportName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/i, '').trim()
  return cleaned || 'share'
}

async function buildPreviews(items: Array<{ kind: ShareItem['kind']; payload: Record<string, unknown> }>): { previews: SharePreviewItem[]; conflicts: Array<{ index: number; conflictId?: string }> } {
  const skills = await installedSkillNames()
  const routineNames = new Map(routineStore.list().map((r) => [r.name, r.id]))
  const workflowNames = new Map(workflowStore.list().map((w) => [w.name, w.id]))
  const previews: SharePreviewItem[] = []
  const conflicts: Array<{ index: number; conflictId?: string }> = []
  items.forEach((item, index) => {
    const name = shareNameOf(item.payload)
    if (item.kind === 'routine') {
      const warnings = routinePreviewWarnings(item.payload, skills)
      const conflictId = routineNames.get(name)
      if (conflictId) conflicts.push({ index, conflictId })
      previews.push({ index, kind: 'routine', name, summary: routineSummary(item.payload), warnings, blocked: typeof item.payload.prompt !== 'string' || !item.payload.prompt.trim(), nameConflict: !!conflictId, ...(conflictId ? { conflictId } : {}) })
    } else {
      const v = workflowPreview(item.payload, validateWorkflow)
      const blocked = v?.blocked ?? true
      if (blocked) conflicts.push({ index })
      const conflictId = workflowNames.get(name)
      if (conflictId && !blocked) conflicts.push({ index, conflictId })
      previews.push({ index, kind: 'workflow', name, summary: workflowSummary(item.payload), warnings: [...(v?.warnings ?? ['校验失败']), ...(blocked ? [] : routinePreviewWarnings(item.payload, skills))], blocked, nameConflict: !!conflictId && !blocked, ...(conflictId && !blocked ? { conflictId } : {}) })
    }
  })
  return { previews, conflicts }
}

export function registerShareHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SHARE_EXPORT, async (_e, items: Array<{ kind: ShareItem['kind']; id: string }>) => {
    const payloads: ShareItem[] = []
    for (const entry of items ?? []) {
      if (entry.kind === 'routine') {
        const routine = routineStore.get(String(entry.id))
        if (routine) payloads.push({ kind: 'routine', payload: sanitizeRoutineForExport(routine as unknown as Record<string, unknown>) })
      } else {
        const wf = workflowStore.get(String(entry.id))
        if (wf) payloads.push({ kind: 'workflow', payload: workflowExportPayload(wf) })
      }
    }
    if (payloads.length === 0) return { canceled: true, count: 0 }
    const win = BrowserWindow.getFocusedWindow()
    const first = payloads[0]
    const defaultName = payloads.length === 1 ? `${safeExportName(shareNameOf(first.payload))}.json` : `pulsemind-share-${new Date().toISOString().slice(0, 10)}.json`
    const result = win ? await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PulseMind 分享文件', extensions: ['json'] }] }) : await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'PulseMind 分享文件', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    writeFileSync(result.filePath, JSON.stringify(buildEnvelope(payloads), null, 2), 'utf-8')
    return { canceled: false, path: result.filePath, count: payloads.length }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_IMPORT_PREVIEW, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PulseMind 分享文件', extensions: ['json'] }] }) : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PulseMind 分享文件', extensions: ['json'] }] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    let raw: string
    try {
      raw = await (await import('node:fs/promises')).readFile(result.filePaths[0], 'utf-8')
    } catch (err) {
      return { canceled: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
    const parsed = parseShareFile(raw)
    const { previews } = await buildPreviews(parsed.items)
    // 单槽暂存：token 铸新即旧作废
    const importToken = randomUUID()
    pendingImports.clear()
    pendingImports.set(importToken, parsed.items)
    const payload: ShareImportPreviewResult & { error?: string } = { importToken, items: previews }
    if (parsed.errors.length > 0) payload.error = parsed.errors.join('；')
    return { canceled: false, ...payload }
  })

  ipcMain.handle(IPC_CHANNELS.SHARE_IMPORT_COMMIT, async (_e, params: { importToken: string; resolutions: ShareImportResolution[] }) => {
    const items = pendingImports.get(String(params?.importToken ?? ''))
    if (!items) return { imported: 0, overwritten: 0, skipped: 0, failed: 0, errors: ['导入会话已过期——请重新打开分享文件'] }
    pendingImports.delete(String(params.importToken))
    const errors: string[] = []
    let imported = 0
    let overwritten = 0
    let skipped = 0
    let failed = 0
    for (const res of params.resolutions ?? []) {
      const item = items[res.index]
      if (!item || res.mode === 'skip') {
        skipped += 1
        continue
      }
      try {
        if (item.kind === 'routine') {
          const p = item.payload as Partial<Routine>
          if (res.mode === 'overwrite' && res.targetId) {
            const updated = routineStore.update(res.targetId, p)
            if (!updated) throw new Error('覆盖目标不存在（可能已被删除）')
            overwritten += 1
          } else {
            // 创建副本：默认名冲突时加「（导入）」后缀，仍冲突继续加
            let name = shareNameOf(item.payload)
            if (routineStore.list().some((r) => r.name === name)) name = `${name}（导入）`
            routineStore.create({
              name,
              description: typeof p.description === 'string' ? p.description : '',
              prompt: typeof p.prompt === 'string' ? p.prompt : '',
              ...(Array.isArray(p.params) ? { params: p.params } : {}),
              ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
              ...(p.schedule ? { schedule: p.schedule } : {}),
              enabled: p.enabled !== false,
              ...(Array.isArray(p.skills) ? { skills: p.skills } : {}),
              ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
              ...(p.approvalMode ? { approvalMode: p.approvalMode } : {}),
              ...(typeof p.profileId === 'string' ? { profileId: p.profileId } : {}),
              ...(p.batch ? { batch: p.batch } : {}),
              ...(Array.isArray(p.triggers) ? { triggers: p.triggers as Routine['triggers'] } : {}),
            })
            imported += 1
          }
        } else {
          const def = item.payload as unknown as WorkflowDefinition
          if (res.mode === 'overwrite' && res.targetId) {
            const existing = workflowStore.get(res.targetId)
            if (!existing) throw new Error('覆盖目标不存在（可能已被删除）')
            workflowStore.save({ ...def, id: res.targetId })
            overwritten += 1
          } else {
            // 创建副本：id 重铸防碰撞；name 冲突同样加后缀
            let name = def.name
            if (workflowStore.list().some((w) => w.name === name)) name = `${name}（导入）`
            const id = `wf_${randomUUID().replace(/-/g, '').slice(0, 10)}`
            workflowStore.save({ ...def, id, name })
            imported += 1
          }
        }
      } catch (err) {
        failed += 1
        errors.push(`${shareNameOf(item.payload)}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { imported, overwritten, skipped, failed, errors }
  })
}

