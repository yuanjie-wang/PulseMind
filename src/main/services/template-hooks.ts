// ── 模板包的 hooks/ 落盘（2026-11-10）──
// 用户实测：模板 zip 里带着 hooks/app-start.js 与 hooks/llm-request.js，
// 导入后一个都没落到 ~/.pulsemind/hooks/——因为导入流程原先只有 settings.json
// 与 skills/ 两条臂，hooks/ 连定位都不做（AGENTS「模板包」一节只承诺前两者）。
// 团队把「配好的机器」压成模板时，登录钩子正是最该跟着走的那部分。
//
// 落盘语义（显式导入 ≠ 启动播种）：
// - 缺的补上；字节与盘上完全一致 → unchanged，静默跳过；
// - 内容不同 → 先把盘上旧文件备份到 `<名>.<yyyyMMdd>.bak`（当日首份永不覆盖，
//   与 storage/index.ts 的播种备份同一约定），再覆盖——导入是用户显式动作，
//   模板包的 settings.json 本来就是整份替换，hooks 跟着走才一致；备份保证
//   手工部署的登录钩子仍可恢复（2026-10-30 那类事故的教训）；
// - 包外的盘上文件永不删除（导入按名替换，不做镜像同步）；
// - `.seed-hashes.json`（播种溯源清单，机器本地状态）与 `*.bak`（旧备份）
//   不导入；符号链接与其它特殊文件不导入（只认普通文件）；
// - 逐文件故障进 errors，不因一个坏文件放弃整批。

import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { backupDateStamp } from '../storage/index'

/** 播种溯源清单是机器本地状态：跟着模板包走会把上一台机器的 hash 当成自己的。 */
const SEED_MANIFEST_NAME = '.seed-hashes.json'

export interface HookImportResult {
  /** 新落盘的相对路径（`/` 分隔）。 */
  imported: string[]
  /** 内容不同、已备份后覆盖的相对路径。 */
  replaced: string[]
  /** 与盘上字节完全一致、跳过的相对路径。 */
  unchanged: string[]
  /** 逐文件/目录级故障。 */
  errors: string[]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isSkippedEntry(name: string): boolean {
  return name === SEED_MANIFEST_NAME || name.endsWith('.bak')
}

/**
 * Copy every regular file under `sourceDir` into `targetDir`, recursively.
 * `now` only exists so tests can pin the backup stamp.
 */
export async function importHookFiles(sourceDir: string, targetDir: string, now: Date = new Date()): Promise<HookImportResult> {
  const result: HookImportResult = { imported: [], replaced: [], unchanged: [], errors: [] }
  await copyTree(sourceDir, targetDir, '', result, now)
  return result
}

async function copyTree(sourceDir: string, targetDir: string, relDir: string, result: HookImportResult, now: Date): Promise<void> {
  let entries
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch (err) {
    result.errors.push(`hooks/${relDir || '.'} 读取失败：${describe(err)}`)
    return
  }

  for (const entry of entries) {
    if (isSkippedEntry(entry.name)) continue
    const srcPath = join(sourceDir, entry.name)
    const destPath = join(targetDir, entry.name)
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath, relPath, result, now)
      continue
    }
    // 只认普通文件：符号链接（可能指向包外）与设备文件一律不导入。
    if (!entry.isFile()) continue

    try {
      const bytes = await readFile(srcPath)
      if (!(await exists(destPath))) {
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, bytes)
        result.imported.push(relPath)
        continue
      }
      const diskBytes = await readFile(destPath)
      if (diskBytes.equals(bytes)) {
        result.unchanged.push(relPath)
        continue
      }
      // 先备份再覆盖：当日首份备份不覆盖（第二次导入同一天不把可恢复状态
      // 换成更早的一份），与 copyTemplatesToDataDir 的备份纪律一致。
      const bakPath = `${destPath}.${backupDateStamp(now)}.bak`
      if (!(await exists(bakPath))) await copyFile(destPath, bakPath)
      await writeFile(destPath, bytes)
      result.replaced.push(relPath)
    } catch (err) {
      result.errors.push(`hooks/${relPath} 导入失败：${describe(err)}`)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
