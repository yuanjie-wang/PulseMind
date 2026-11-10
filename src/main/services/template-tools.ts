// ── 模板包的 tools/ 落盘（2026-11-10）──
// 与 hooks/ 同一条缺陷：导入流程原先只有 settings.json 与 skills/ 两条臂，
// 团队把「配好的机器」压成模板时，工具工作室里攒下的工具一个都到不了新机器。
// 一个工具 = ~/.pulsemind/tools/<id>/ 一个目录（tool.json 清单 + app.html +
// 任意辅助文件），所以落盘单位是目录，不是文件。
//
// 落盘语义（显式导入 ≠ 启动播种）：
// - 逐工具目录判定：源里每个文件在盘上都字节一致 → unchanged，静默跳过；
// - 任一文件不同或缺失 → 先把盘上整个工具目录备份到 `<id>.<yyyyMMdd>.bak`
//   （当日首份永不覆盖，与 hooks/ 播种备份同一约定），再覆盖——整目录一起换，
//   避免新旧 app.html 与新旧 tool.json 拼成半个工具；备份是恢复点，包外的
//   盘上多余文件仍不删除；
// - 新目录：先拷全部文件、tool.json 最后写（半截目录不会以「有清单」的形态
//   出现在工具列表里），中途失败整目录清掉，不留幽灵工具；
// - 运行数据（storage.json，工具 bridge 的 KV）不随模板走——与 duplicate()
//   同一条规矩，避免把上一台机器的运行态灌进新机器；
// - 预置工具（preset_*）由应用自带并在启动时播种，包里的同名目录会与播种/
//   删除记录状态机撞车，跳过；包若来自「整份 templates/pulsemind」还会带
//   分发目录 presets/（应用包里的源，不是用户工具），同样跳过；旧版
//   templates/ 副本目录、隐藏项与 *.bak（上一轮导入的备份，整份
//   ~/.pulsemind 再打包时会带进来）同样跳过；
// - 清单校验：tool.json 可解析、id 必须等于目录名（与 readManifest 同一判据，
//   否则导入后 list() 也认不出来）、htmlPath 不得越出工具目录且入口页面必须
//   存在；符号链接与其它特殊文件不导入（可能指向包外）；
// - 逐工具故障进 errors，不因一个坏工具放弃整批。

import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { backupDateStamp } from '../storage/index'
import { safeChildPath } from '../storage/safe-name'
import type { UserTool } from '../../shared/types/user-tool'

/** 工具运行数据（bridge KV）：跟着模板包走就是把上一台机器的运行态带过来。 */
const RUN_DATA_FILE = 'storage.json'
/** 预置工具目录前缀（bundle 播种，见 tool-store.ts 的 TOOL_PRESET_PREFIX）。 */
const PRESET_PREFIX = 'preset_'
/** 旧版模板副本目录（pre-M5R 迁移源），不是工具。 */
const LEGACY_TEMPLATES_DIR = 'templates'
/** 应用包里的预置工具分发目录（getBundlePresetsDir 的末段），不是用户工具。 */
const BUNDLE_PRESETS_DIR = 'presets'

export interface ToolImportResult {
  /** 新落盘的工具 id（= 目录名）。 */
  imported: string[]
  /** 内容有变化、已整目录备份后覆盖的工具 id。 */
  replaced: string[]
  /** 与盘上完全一致、跳过的工具 id。 */
  unchanged: string[]
  /** 逐工具故障。 */
  errors: string[]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 源里可以当作工具导入的子目录。 */
async function listToolSources(sourceDir: string): Promise<Array<{ id: string; path: string }>> {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const tools: Array<{ id: string; path: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name.endsWith('.bak')) continue
    if (entry.name === LEGACY_TEMPLATES_DIR || entry.name === BUNDLE_PRESETS_DIR || entry.name.startsWith(PRESET_PREFIX)) continue
    tools.push({ id: entry.name, path: join(sourceDir, entry.name) })
  }
  return tools
}

type ManifestCheck = { manifest: UserTool; content: string } | { error: string }

/** 清单是工具的身份证：id 与目录名不一致的目录导入后 list() 也看不见。 */
async function checkManifest(dir: string, expectedId: string): Promise<ManifestCheck> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'tool.json'), 'utf-8')
  } catch (err) {
    return { error: `缺少 tool.json（${describe(err)}）` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { error: `tool.json 解析失败：${describe(err)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'tool.json 结构无效' }
  }
  const manifest = parsed as UserTool
  if (manifest.id !== expectedId) {
    return { error: `tool.json 的 id（${String(manifest.id)}）与目录名（${expectedId}）不一致` }
  }
  const htmlRel = typeof manifest.htmlPath === 'string' && manifest.htmlPath ? manifest.htmlPath : 'app.html'
  // htmlPath 是运行时 readHtml 的拼路径依据：越出工具目录的清单不导入
  //（否则一个模板包就能让工具页读到 ~/.pulsemind 下的任意文件）。
  if (!safeChildPath(dir, htmlRel)) {
    return { error: `tool.json 的 htmlPath 越出工具目录：${htmlRel}` }
  }
  if (!(await exists(join(dir, htmlRel)))) {
    return { error: `缺少入口页面 ${htmlRel}` }
  }
  // 落盘用归一后的清单（htmlPath 补全），比较也按这份字节——源里缺 htmlPath
  // 的清单与盘上写出的归一清单不会被误判成「有变化」。
  return { manifest: { ...manifest, htmlPath: htmlRel }, content: JSON.stringify({ ...manifest, htmlPath: htmlRel }, null, 2) }
}

/** 递归收集要落盘的文件（`/` 分隔的相对路径），清单单独处理。 */
async function collectFiles(rootDir: string, relDir: string, out: string[]): Promise<void> {
  const dir = relDir ? join(rootDir, relDir) : rootDir
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    // 符号链接可能是包外内容的跳板；设备/管道文件更不是工具内容。
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectFiles(rootDir, rel, out)
      continue
    }
    if (!entry.isFile()) continue
    if (rel === 'tool.json' || rel === RUN_DATA_FILE) continue
    if (entry.name.endsWith('.bak') || entry.name === '.DS_Store') continue
    out.push(rel)
  }
}

/** 源里每个文件（含归一清单）都在盘上且字节一致才算 unchanged。 */
async function allMatch(sourceDir: string, destDir: string, files: string[], manifestContent: string): Promise<boolean> {
  for (const rel of files) {
    try {
      const src = await readFile(join(sourceDir, rel))
      const dst = await readFile(join(destDir, rel))
      if (!src.equals(dst)) return false
    } catch {
      return false
    }
  }
  try {
    return (await readFile(join(destDir, 'tool.json'), 'utf-8')) === manifestContent
  } catch {
    return false
  }
}

async function copyFiles(sourceDir: string, destDir: string, files: string[]): Promise<string[]> {
  const errors: string[] = []
  for (const rel of files) {
    try {
      const bytes = await readFile(join(sourceDir, rel))
      const dest = join(destDir, rel)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, bytes)
    } catch (err) {
      errors.push(`${rel}：${describe(err)}`)
    }
  }
  return errors
}

/**
 * Import every tool directory under `sourceDir` into `targetDir`.
 * `now` only exists so tests can pin the backup stamp.
 */
export async function importToolDirs(sourceDir: string, targetDir: string, now: Date = new Date()): Promise<ToolImportResult> {
  const result: ToolImportResult = { imported: [], replaced: [], unchanged: [], errors: [] }

  let sources: Array<{ id: string; path: string }>
  try {
    sources = await listToolSources(sourceDir)
  } catch (err) {
    result.errors.push(`tools/ 读取失败：${describe(err)}`)
    return result
  }

  for (const source of sources) {
    const dest = safeChildPath(targetDir, source.id)
    if (!dest) {
      result.errors.push(`tools/${source.id} 跳过：目录名不合法`)
      continue
    }

    const checked = await checkManifest(source.path, source.id)
    if ('error' in checked) {
      result.errors.push(`tools/${source.id} 跳过：${checked.error}`)
      continue
    }

    const files: string[] = []
    try {
      await collectFiles(source.path, '', files)
    } catch (err) {
      result.errors.push(`tools/${source.id} 读取失败：${describe(err)}`)
      continue
    }

    const destExists = await exists(dest)
    if (destExists && (await allMatch(source.path, dest, files, checked.content))) {
      result.unchanged.push(source.id)
      continue
    }

    // 整目录备份：当日首份不覆盖（第二次导入同一天不把可恢复状态换成更早
    // 的一份），与 hooks/ 的备份纪律一致。
    let backupName: string | null = null
    try {
      if (destExists) {
        const bakPath = `${dest}.${backupDateStamp(now)}.bak`
        backupName = `${source.id}.${backupDateStamp(now)}.bak`
        if (!(await exists(bakPath))) await cp(dest, bakPath, { recursive: true })
      } else {
        await mkdir(dest, { recursive: true })
      }

      const copyErrors = await copyFiles(source.path, dest, files)
      if (copyErrors.length > 0) {
        // 新目录中途失败：清掉半截目录（工具列表按「有 tool.json」认人，但我们
        // 还没写清单——留着只会是永远看不见的垃圾）。
        if (!destExists) await rm(dest, { recursive: true, force: true })
        const hint = backupName ? `（原目录已备份为 ${backupName}）` : ''
        result.errors.push(`tools/${source.id} 导入失败：${copyErrors.join('；')}${hint}`)
        continue
      }

      // 清单最后写：任何一刻中断，盘上都不会出现「清单已更新、页面还是旧的」
      // 的工具（新目录里清单缺席 = list() 看不见）。
      await writeFile(join(dest, 'tool.json'), checked.content, 'utf-8')
      if (destExists) result.replaced.push(source.id)
      else result.imported.push(source.id)
    } catch (err) {
      if (!destExists) {
        try {
          await rm(dest, { recursive: true, force: true })
        } catch {
          /* 清理失败只是残留，原始错误更重要 */
        }
      }
      const hint = backupName ? `（原目录已备份为 ${backupName}）` : ''
      result.errors.push(`tools/${source.id} 导入失败：${describe(err)}${hint}`)
    }
  }

  return result
}
