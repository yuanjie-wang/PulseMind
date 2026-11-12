/**
 * 第二代经验存储：磁盘为真源，一条经验一个目录。
 *
 * 形态与 SKILL 一致 —— `~/.pulsemind/experience/<id>/EXPERIENCE.md`（YAML
 * frontmatter + 五节正文）+ `scripts/` 子目录 —— 但住在独立目录、独立命名
 * 空间里，不进技能注册表，也不与 `skills/` 混名。
 *
 * 为什么不是第一代的 `experiences/`（复数）：那是 2026-11-12 弃用的孤立池，
 * 表已清空、磁盘上 80 个目录已成孤儿。新目录是 `experience/`（单数），二者
 * 不共用，避免把历史垃圾读回来。
 *
 * 分工（user 2026-11-12 裁定）：静态元数据进 frontmatter（title /
 * description / maturity / aliases / createdAt / updatedAt），会随每次命中
 * 变动的流水（use_count / last_used_at / recurrence / enabled）留给 DB 的
 * `experience_uses` —— 与技能把 use_count 放在 `skill_uses` 而非写回
 * SKILL.md 是同一个理由：热路径不能每次点一次就重写文件。
 *
 * frontmatter 里的 `name` 就是目录名（稳定 id，形如
 * `page_1793029436441_9w3bhsh`），所以改标题永远不用重命名目录、不会断链。
 * 标题是中文，被 `parseSkillMarkdown` 归入 `extra.title` —— 复用它而不改它
 * 意味着的 Agent Skills 规范校验（SPEC_NAME_RE 只认 ASCII slug）不会挡路。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DATA_DIR } from './index'
import { parseSkillMarkdown, type ParsedFrontmatter } from '../utils/skill-parser'

export const EXPERIENCE_V2_DIR = join(DATA_DIR, 'experience')
export const EXPERIENCE_FILE = 'EXPERIENCE.md'

/** 目录名 = 经验 id。只认 id 形态，任何路径分隔符/`..` 都进不来。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type ExperienceMaturity = 'clue' | 'sop'

/** frontmatter 里存放的静态元数据。 */
export interface ExperienceFileMeta {
  /** 目录名，稳定不变（来自 memory_pages.id 或新建时生成）。 */
  id: string
  /** 中文标题，可随意改而不用改目录。 */
  title: string
  /** 一句话摘要（原 MemoryPage.summary）。 */
  description: string
  maturity: ExperienceMaturity
  aliases: string[]
  sourceConversationId?: string
  createdAt?: string
  updatedAt?: string
}

export interface ExperienceFile {
  meta: ExperienceFileMeta
  /** 五节正文（`## 适用场景` / `## 步骤` / `## 注意事项` …），不含 frontmatter。 */
  body: string
}

/** YAML 标量一律走双引号 —— parseYamlLite 的双引号转义覆盖 \\ " \n \t \r。 */
function emitScalar(value: string): string {
  return JSON.stringify(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function asMaturity(value: unknown): ExperienceMaturity {
  return asString(value) === 'sop' ? 'sop' : 'clue'
}

/** 把一个目录的 EXPERIENCE.md 文本解析成 ExperienceFile；不合形态就抛错。 */
export function parseExperienceMd(content: string, fileName: string): ExperienceFile {
  const parsed: ParsedFrontmatter = parseSkillMarkdown(content, fileName)
  const extra = parsed.extra ?? {}

  const id = asString(parsed.name)
  if (!ID_RE.test(id)) {
    throw new Error(`${fileName}: frontmatter "name" (${JSON.stringify(id)}) is not a valid experience id`)
  }
  // 只有显式标了 category: experience 的目录才算经验，防止误读别的形态。
  if (asString(parsed.category) !== 'experience') {
    throw new Error(`${fileName}: frontmatter "category" must be "experience" (got ${JSON.stringify(parsed.category)})`)
  }

  const title = asString(extra.title)
  if (!title) throw new Error(`${fileName}: missing required "title" field in frontmatter`)

  return {
    meta: {
      id,
      title,
      // parseSkillMarkdown 在 description 缺失时回退成 name —— 那是格式兜底，
      // 不是语义。读回时还原成空串，否则 id 会冒充摘要污染 intent 匹配。
      description: asString(parsed.description) === id ? '' : asString(parsed.description),
      maturity: asMaturity(extra.maturity),
      aliases: asStringList(extra.aliases),
      sourceConversationId: asString(parsed.sourceConversationId) || undefined,
      createdAt: asString(parsed.createdAt) || undefined,
      updatedAt: asString(extra.updatedAt) || undefined,
    },
    body: parsed.systemPrompt,
  }
}

/** 把 ExperienceFile 序列化回 EXPERIENCE.md 文本（与 parseExperienceMd 互逆）。 */
export function formatExperienceMd(file: ExperienceFile): string {
  const { meta, body } = file
  const lines: string[] = ['---']
  lines.push(`name: ${emitScalar(meta.id)}`)
  lines.push(`title: ${emitScalar(meta.title)}`)
  lines.push(`description: ${emitScalar(meta.description)}`)
  lines.push('category: experience')
  lines.push(`maturity: ${emitScalar(meta.maturity)}`)
  if (meta.aliases.length > 0) {
    lines.push('aliases:')
    for (const alias of meta.aliases) lines.push(`  - ${emitScalar(alias)}`)
  }
  if (meta.sourceConversationId) lines.push(`sourceConversationId: ${emitScalar(meta.sourceConversationId)}`)
  if (meta.createdAt) lines.push(`createdAt: ${emitScalar(meta.createdAt)}`)
  if (meta.updatedAt) lines.push(`updatedAt: ${emitScalar(meta.updatedAt)}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

/** 生成一个新经验 id（迁移沿用旧 id，新建时才用）。 */
export function newExperienceId(): string {
  const stamp = Date.now()
  const rand = Math.random().toString(36).slice(2, 9)
  return `page_${stamp}_${rand}`
}

export interface ExperienceScriptFile {
  /** `scripts/` 下的相对路径，如 `check.sh`。 */
  relativePath: string
  content: string
}

export class ExperienceStore {
  constructor(private readonly rootDir: string = EXPERIENCE_V2_DIR) {}

  get root(): string {
    return this.rootDir
  }

  /** id → 目录绝对路径。ID_RE 已挡掉分隔符与 `..`，越界在这里就抛。 */
  private dirOf(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid experience id: ${JSON.stringify(id)}`)
    const dir = join(this.rootDir, id)
    const rel = relative(this.rootDir, dir)
    if (!rel || rel.startsWith('..')) throw new Error(`unsafe experience dir: ${dir}`)
    return dir
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory() && ID_RE.test(e.name))
        .map((e) => e.name)
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** 扫描全部目录；单个目录坏掉不该拖垮整次读取，坏的那条跳过并上报。 */
  async list(onBad?: (id: string, err: unknown) => void): Promise<ExperienceFile[]> {
    const out: ExperienceFile[] = []
    for (const id of await this.listIds()) {
      try {
        const file = await this.read(id)
        if (file) out.push(file)
      } catch (err) {
        onBad?.(id, err)
      }
    }
    return out
  }

  async read(id: string): Promise<ExperienceFile | null> {
    const path = join(this.dirOf(id), EXPERIENCE_FILE)
    let content: string
    try {
      content = await readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = parseExperienceMd(content, path)
    // 目录名是稳定的身份，frontmatter 与目录不一致说明文件被手工挪过 —— 报出来而不是默默信任。
    if (parsed.meta.id !== id) {
      throw new Error(`${path}: frontmatter name ${JSON.stringify(parsed.meta.id)} does not match directory ${JSON.stringify(id)}`)
    }
    return parsed
  }

  /** 经验正文文件的绝对路径（pick_skill 信封里的 **Location:** 用它）。 */
  pathOf(id: string): string {
    return join(this.dirOf(id), EXPERIENCE_FILE)
  }

  async exists(id: string): Promise<boolean> {
    return (await this.read(id)) !== null
  }

  async write(file: ExperienceFile): Promise<void> {
    const dir = this.dirOf(file.meta.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, EXPERIENCE_FILE), formatExperienceMd(file), 'utf-8')
  }

  async remove(id: string): Promise<void> {
    await rm(this.dirOf(id), { recursive: true, force: true })
  }

  /** `scripts/` 下的脚本（取代第一代塞进 files_json 的内嵌 JSON）。 */
  async listScripts(id: string): Promise<ExperienceScriptFile[]> {
    const scriptsDir = join(this.dirOf(id), 'scripts')
    let names: string[]
    try {
      names = await readdir(scriptsDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: ExperienceScriptFile[] = []
    for (const name of names.sort()) {
      const content = await readFile(join(scriptsDir, name), 'utf-8').catch(() => null)
      if (content !== null) out.push({ relativePath: name, content })
    }
    return out
  }

  async writeScript(id: string, relativePath: string, content: string): Promise<void> {
    const safe = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!safe || safe.split('/').includes('..')) {
      throw new Error(`unsafe script path: ${JSON.stringify(relativePath)}`)
    }
    const scriptsDir = join(this.dirOf(id), 'scripts')
    await mkdir(scriptsDir, { recursive: true })
    await writeFile(join(scriptsDir, safe), content, 'utf-8')
  }

  // ── 同步镜像（2026-11-12）─────────────────────────────────────────────
  // 记忆写入链是同步的（`applyPageOps(ops): PageOpResult[]`，跑在 better-sqlite3
  // 事务里），经验写盘不能把 async 传染进去。promises 版留给读取面与迁移脚本，
  // 写入面走这里 —— 两份共用 parseExperienceMd / formatExperienceMd / dirOf，
  // 形态不会走散。

  listIdsSync(): string[] {
    try {
      return readdirSync(this.rootDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && ID_RE.test(e.name))
        .map((e) => e.name)
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  readSync(id: string): ExperienceFile | null {
    const path = join(this.dirOf(id), EXPERIENCE_FILE)
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const parsed = parseExperienceMd(content, path)
    // 与异步版同一条纪律：目录名才是身份，frontmatter 对不上就报错。
    if (parsed.meta.id !== id) {
      throw new Error(`${path}: frontmatter name ${JSON.stringify(parsed.meta.id)} does not match directory ${JSON.stringify(id)}`)
    }
    return parsed
  }

  listSync(onBad?: (id: string, err: unknown) => void): ExperienceFile[] {
    const out: ExperienceFile[] = []
    for (const id of this.listIdsSync()) {
      try {
        const file = this.readSync(id)
        if (file) out.push(file)
      } catch (err) {
        onBad?.(id, err)
      }
    }
    return out
  }

  writeSync(file: ExperienceFile): void {
    const dir = this.dirOf(file.meta.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, EXPERIENCE_FILE), formatExperienceMd(file), 'utf-8')
  }

  removeSync(id: string): void {
    rmSync(this.dirOf(id), { recursive: true, force: true })
  }

  listScriptsSync(id: string): ExperienceScriptFile[] {
    const scriptsDir = join(this.dirOf(id), 'scripts')
    let names: string[]
    try {
      names = readdirSync(scriptsDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: ExperienceScriptFile[] = []
    for (const name of names.sort()) {
      try {
        out.push({ relativePath: name, content: readFileSync(join(scriptsDir, name), 'utf-8') })
      } catch {
        // 单个脚本读不出来就跳过，与异步版同款
      }
    }
    return out
  }

  writeScriptSync(id: string, relativePath: string, content: string): void {
    const safe = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!safe || safe.split('/').includes('..')) {
      throw new Error(`unsafe script path: ${JSON.stringify(relativePath)}`)
    }
    const scriptsDir = join(this.dirOf(id), 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, safe), content, 'utf-8')
  }
}

export const experienceStore = new ExperienceStore()
