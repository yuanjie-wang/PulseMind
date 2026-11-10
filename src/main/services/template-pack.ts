// ── 模板包内容定位（2026-11-10）──
// 解压后的 settings.json、skills/、hooks/、tools/ 未必躺在根上：Finder /
// 资源管理器「压缩文件夹」产出的 zip 天然多一层 <文件夹名>/，而「把整个
// ~/.pulsemind 压上」正是最自然的制包动作（目录名还带点，.pulsemind/）。
// 旧实现只看根目录，这类包会被判成「没有找到 settings.json 或 skills/ 目录」
// ——错误信息与事实相反，用户拿到的是一句无从排查的提示。
//
// 由浅到深 BFS，四个目标各自独立找（同一层里先命中者胜）：一个包里
// settings.json 在根、skills/ 在包装目录里的组合是合法的，反之亦然。
// 深度上限 3 足够覆盖「压缩文件夹」的各种产物，也把恶意/畸形 zip 的遍历
// 成本封在常数级。

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 根 + 3 层包装：再深的目录布局不可能是「压缩一个文件夹」的产物。 */
const MAX_DEPTH = 3

/** 解压器自己的垃圾（macOS 的资源分支）与依赖树（模板包里出现必是误打包）。 */
const SKIP_DIRS = new Set(['__MACOSX', 'node_modules'])

export interface LocatedTemplatePack {
  /** 找到的 settings.json 绝对路径（未找到 = undefined）。 */
  settingsPath?: string
  /** 找到的 skills/ 目录绝对路径（未找到 = undefined）。 */
  skillsDir?: string
  /** 找到的 hooks/ 目录绝对路径（未找到 = undefined）。 */
  hooksDir?: string
  /** 找到的 tools/ 目录绝对路径（未找到 = undefined）。 */
  toolsDir?: string
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function childDirectories(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (await isDirectory(full)) dirs.push(full)
  }
  return dirs
}

/**
 * Locate the optional payloads of a template pack under `extractDir`.
 * Shallow-first, so a `settings.json` sitting next to a wrapper folder always
 * wins over the same-named file inside it.
 */
export async function locateTemplatePack(extractDir: string): Promise<LocatedTemplatePack> {
  const found: LocatedTemplatePack = {}
  let frontier = [extractDir]
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const dir of frontier) {
      if (!found.settingsPath && (await isFile(join(dir, 'settings.json')))) {
        found.settingsPath = join(dir, 'settings.json')
      }
      if (!found.skillsDir && (await isDirectory(join(dir, 'skills')))) {
        found.skillsDir = join(dir, 'skills')
      }
      if (!found.hooksDir && (await isDirectory(join(dir, 'hooks')))) {
        found.hooksDir = join(dir, 'hooks')
      }
      if (!found.toolsDir && (await isDirectory(join(dir, 'tools')))) {
        found.toolsDir = join(dir, 'tools')
      }
      if (found.settingsPath && found.skillsDir && found.hooksDir && found.toolsDir) return found
      if (depth === MAX_DEPTH) continue
      for (const child of await childDirectories(dir)) {
        // 已经认作载荷的目录不再下钻：skills/ 里的 SKILL.md 由技能导入自己走，
        // hooks/ 里的脚本由 hooks 导入自己走，tools/ 里的工具目录由工具导入
        // 自己走，它们的子目录里再出现 settings.json 只会是噪声。
        if (child === found.skillsDir || child === found.hooksDir || child === found.toolsDir) continue
        next.push(child)
      }
    }
    frontier = next
  }
  return found
}
