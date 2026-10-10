import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, isAbsolute, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { ExperienceRecord, ExperienceDraft } from '../../shared/types/experience-types'
import { MAX_EXPERIENCES } from '../../shared/types/experience-types'
import { sha256Hex, normalizeMemoryContent } from '../../shared/memory/content-hash'
import { parseExperienceMd } from '../../shared/experience/frontmatter'
import { EXPERIENCES_DIR } from './index'
import { getDb } from './database'
import { safeChildPath } from './safe-name'

// ── Script payload gates (PLAN-experience-scripts 1.3/1.5) ──
// An experience's SKILL.md is documentation; its scripts are RUNNABLE. Three
// gates at save: path jail (scripts/ prefix, no escaping), size (8KB/file,
// 3 files), and a syntax parse via `node --check` — parse only, never execute.
// Electron ships Node 20, so scripts run anywhere the app runs WITHOUT npm —
// hence the prompt-level constraint "node: builtins only".
const MAX_SCRIPT_BYTES = 8 * 1024
const MAX_SCRIPTS_PER_EXPERIENCE = 3

/** `path` must name a file under <experienceDir>/scripts/ — relative, no `..`,
 *  no absolute, no backticks into other dirs. Returns the error or null. */
export function scriptPathError(relPath: string): string | null {
  if (!relPath || typeof relPath !== 'string') return 'path is empty'
  if (isAbsolute(relPath)) return `path must be relative: ${relPath}`
  if (!relPath.startsWith('scripts/')) return `path must start with scripts/: ${relPath}`
  const rel = relative(join('exp', 'scripts'), join('exp', relPath))
  if (rel.startsWith('..') || isAbsolute(rel)) return `path escapes the experience dir: ${relPath}`
  if (relPath.includes('\\')) return `backslashes are not path separators here: ${relPath}`
  return null
}

/** Syntax parse only (`node --check`) — the script never executes at save.
 *  Runs under ELECTRON_RUN_AS_NODE so process.execPath (the Electron binary)
 *  behaves as plain Node. Returns null when OK, or the failing reason. */
export function scriptSyntaxError(_dir: string, relPath: string, content: string): string | null {
  // tmp lives in the OS temp dir — the experience dir may not exist yet (the
  // gates run before the save's mkdir) and we must not create half-trees.
  // Keep the script's extension: `node --check` picks CJS/ESM by extension,
  // and an extensionless tmp file parses `import` as a SyntaxError.
  const ext = relPath.endsWith('.mjs') ? '.mjs' : relPath.endsWith('.cjs') ? '.cjs' : '.js'
  const tmp = join(tmpdir(), `pm-expcheck-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`)
  try {
    require('node:fs').writeFileSync(tmp, content, 'utf-8')
    const res = spawnSync(process.execPath, ['--check', tmp], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10_000,
    })
    if (res.status === 0) return null
    const stderr = (res.stderr ?? '').toString().split('\n').slice(0, 3).join(' ').trim()
    return `node --check failed: ${stderr || 'syntax error'}`
  } catch (err) {
    return `node --check could not run: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    try { require('node:fs').unlinkSync(tmp) } catch {}
  }
}

function generateId(): string {
  return `exp_${Date.now()}_${randomBytes(4).toString('hex')}`
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return slug || `experience-${Date.now()}`
}

function localTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseTriggers(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : undefined
  } catch {
    return undefined
  }
}

function formatExperienceMd(rec: ExperienceRecord, content: string): string {
  const lines = [
    '---',
    `name: ${rec.name}`,
    `title: ${rec.title}`,
    `description: ${rec.description}`,
    `category: ${rec.category}`,
    `createdAt: ${rec.createdAt}`
  ]
  if (rec.updatedAt) lines.push(`updatedAt: ${rec.updatedAt}`)
  if (rec.triggers && rec.triggers.length > 0) {
    lines.push('triggers:', ...rec.triggers.map((t) => `  - ${t}`))
  }
  if (rec.sourceConversationId) lines.push(`sourceConversationId: ${rec.sourceConversationId}`)
  if (rec.lastUsedAt) lines.push(`lastUsedAt: ${rec.lastUsedAt}`)
  lines.push(`useCount: ${rec.useCount}`, '---', '', content)
  return lines.join('\n')
}

function rowToRecord(r: any): ExperienceRecord {
  let files: string[] | undefined
  if (typeof r.files_json === 'string' && r.files_json) {
    try {
      const parsed = JSON.parse(r.files_json)
      if (Array.isArray(parsed)) files = parsed.filter((f: unknown) => typeof f === 'string')
    } catch { /* malformed → treated as absent; the SKILL.md body still carries the docs */ }
  }
  let outcome: ExperienceRecord['outcome'] | undefined
  if (typeof r.outcome_json === 'string' && r.outcome_json) {
    try {
      const parsed = JSON.parse(r.outcome_json)
      if (parsed && typeof parsed === 'object' && (Number.isFinite(parsed.ok) || Number.isFinite(parsed.fail))) {
        outcome = {
          ok: Number.isFinite(parsed.ok) ? parsed.ok : 0,
          fail: Number.isFinite(parsed.fail) ? parsed.fail : 0,
          lastOutcomeAt: typeof parsed.lastOutcomeAt === 'string' ? parsed.lastOutcomeAt : null,
        }
      }
    } catch { /* malformed → absent; counters are advisory */ }
  }
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    category: r.category,
    sourceConversationId: r.source_conversation_id ?? undefined,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    triggers: parseTriggers(r.triggers),
    files: files && files.length > 0 ? files : undefined,
    dir: join(EXPERIENCES_DIR, r.name), // computed, never stored
    updatedAt: r.updated_at ?? null,
    outcome
  }
}

/** The raw `experiences` row shape save() reads back for upsert decisions —
 *  only the columns that gate id/createdAt/LRU preservation. */
interface ExperienceRow {
  id: string
  title: string
  created_at: string
  last_used_at: string | null
  use_count: number
  triggers: string | null
  files_json: string | null
  updated_at: string | null
  content_hash: string | null
}

/** Content hash of an experience body (PLAN-experience-iteration): the
 *  save-layer gate that distinguishes a real revision from a no-op re-save.
 *  Reuses the memory dedup's normalizer + SHA-256 — same rule: trim +
 *  collapse whitespace, then hash. */
export function experienceContentHash(content: string): string {
  return sha256Hex(normalizeMemoryContent(content))
}

export class ExperienceStore {
  // ── Reads ──

  list(): ExperienceRecord[] {
    const rows = getDb()
      .prepare('SELECT * FROM experiences ORDER BY COALESCE(last_used_at, created_at) DESC')
      .all() as any[]
    return rows.map(rowToRecord)
  }

  /** Read a companion script (panel's read-only view). Same jail as the save
   *  gate; null on ANY refusal — the panel shows 读取失败, never partial bytes. */
  async readFileContent(name: string, relPath: string): Promise<string | null> {
    if (scriptPathError(relPath)) return null
    const dir = join(EXPERIENCES_DIR, name)
    const target = join(dir, relPath)
    const rel = relative(dir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      return await readFile(target, 'utf-8')
    } catch {
      return null
    }
  }

  async read(name: string): Promise<string | null> {
    // 名字消毒（full_20261011 M9-P0-1/X3）：read 的 name 从 agent 侧
    // pick_skill 的经验兜底可达，`../skills/<x>` 曾能穿出 EXPERIENCES_DIR。
    const mdPath = safeChildPath(EXPERIENCES_DIR, join(name, 'SKILL.md'))
    if (!mdPath) return null
    try {
      return await readFile(mdPath, 'utf-8')
    } catch {
      return null
    }
  }

  // ── Writes ──

  /**
   * Persist an experience as a standalone SKILL.md under ~/.pulsemind/experiences/.
   * Enforces the MAX_EXPERIENCES cap with LRU eviction (least recently used wins
   * the old age first; never-used entries are evicted before used ones).
   *
   * Iteration (PLAN-experience-iteration): a draft carrying `targetName` looks
   * the row up by THAT name instead of the slugified title, so a revised title
   * lands on the record it revises instead of forking a second entry. An
   * unknown target falls back to the create path (宁可多一条不可丢洞见) with a
   * warning. `updated_at` is stamped only when an iteration's content hash
   * actually differs — a no-op re-save (or the trigger-extraction rewrite,
   * which only touches frontmatter) never marks the record as revised.
   */
  async save(draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord; rejectedFiles?: string[] }> {
    const slug = slugifyTitle(draft.title)
    const db = getDb()
    let name = slug
    let existing: ExperienceRow | undefined
    if (draft.targetName) {
      existing = db.prepare('SELECT * FROM experiences WHERE name = ?').get(draft.targetName) as ExperienceRow | undefined
      if (existing) name = draft.targetName
      else console.warn(`[experience] target "${draft.targetName}" not in the pool — falling back to create`)
    }
    if (!existing) {
      existing = db.prepare('SELECT * FROM experiences WHERE name = ?').get(slug) as ExperienceRow | undefined
      name = slug
    }
    const now = localTimestamp()
    const contentHash = experienceContentHash(draft.content)
    const contentChanged = !existing || existing.content_hash !== contentHash

    // ── Script gates (only when the draft carries files at all) ──
    const rejectedFiles: string[] = []
    const acceptedFiles: ExperienceDraft['files'] = []
    if (draft.files && draft.files.length > 0) {
      if (draft.files.length > MAX_SCRIPTS_PER_EXPERIENCE) {
        for (const f of draft.files.slice(MAX_SCRIPTS_PER_EXPERIENCE)) rejectedFiles.push(f.path)
      }
      for (const f of draft.files.slice(0, MAX_SCRIPTS_PER_EXPERIENCE)) {
        const pathErr = scriptPathError(f.path)
        if (pathErr) { rejectedFiles.push(f.path); console.warn('[experience] file rejected:', pathErr); continue }
        if (typeof f.content !== 'string' || f.content.length === 0) { rejectedFiles.push(f.path); continue }
        if (Buffer.byteLength(f.content, 'utf-8') > MAX_SCRIPT_BYTES) {
          rejectedFiles.push(f.path)
          console.warn(`[experience] file rejected (over ${MAX_SCRIPT_BYTES} bytes): ${f.path}`)
          continue
        }
        const syntaxErr = scriptSyntaxError(join(EXPERIENCES_DIR, name), f.path, f.content)
        if (syntaxErr) {
          rejectedFiles.push(f.path)
          console.warn(`[experience] file rejected (${syntaxErr}): ${f.path}`)
          continue
        }
        acceptedFiles.push(f)
      }
    }

    // 落盘规则只有一条：save 只写它收到的文件，从不清理目录。draft 不带
    // files 时保留旧 files_json（ensureTriggers 的回写只重写 SKILL.md，
    // 不许把脚本清单洗掉——记录与磁盘从此对不上）。
    const effectiveFiles = draft.files && draft.files.length > 0
      ? acceptedFiles.map((f) => f!.path)
      : (parseTriggers(existing?.files_json) as string[] | undefined)
    // `updated_at` marks an ITERATION: a declared target whose content really
    // changed (a pre-existing row whose content_hash is NULL counts as changed
    // — it was written before this gate existed). Creation leaves it null;
    // ensureTriggers carries no targetName, so a frontmatter-only rewrite
    // never reads as "revised". Legacy NULL hashes therefore only misfire when
    // a targetName save lands on a pre-upgrade row with byte-identical content
    // — a contradiction (the model was told to revise, produced no change).
    const bumpUpdated = Boolean(draft.targetName && existing && contentChanged)

    // ── Truncation-driven loss guard (review 2026-09-26 中5) ──
    // The iteration prompt shows each pool record truncated to the first 1500
    // characters (MemoryManager.buildExistingExperiencesText's per-record
    // budget) and asks for the FULL revised document back — so a record longer
    // than that budget gets merged from a PARTIAL view, and the whole-body
    // upsert below would silently drop everything the model never saw
    // (script-carrying records blow past 1500 easily: 8KB per script, 3 of
    // them). When the target's existing body exceeds the budget and the draft
    // comes back meaningfully SHORTER than that body, the revision is refused
    // with the record untouched; the agent reads the full SKILL.md (its
    // envelope names the directory) and resubmits with everything included.
    if (bumpUpdated && existing) {
      try {
        const oldMd = await readFile(join(EXPERIENCES_DIR, name, 'SKILL.md'), 'utf-8')
        const oldLen = parseExperienceMd(oldMd, existing.title).content.length
        const DEDUP_VIEW_BODY_BUDGET = 1500
        if (oldLen > DEDUP_VIEW_BODY_BUDGET && draft.content.length < oldLen * 0.9) {
          throw new Error(
            `修订被拒绝：「${existing.title}」现有正文共 ${oldLen} 字符，而提炼视图只展示前 ${DEDUP_VIEW_BODY_BUDGET} 字符；` +
            `新稿只有 ${draft.content.length} 字符，会把模型从未见过的尾部整体丢掉。` +
            `请先读取该记录目录下的完整 SKILL.md，把全部既有内容并入修订稿后重试（修订稿不应显著短于原正文）。`
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('修订被拒绝')) throw err
        /* old file unreadable (dir deleted etc.) → nothing to lose, save proceeds */
      }
    }

    const record: ExperienceRecord = {
      id: existing?.id ?? generateId(),
      name,
      title: draft.title,
      description: draft.description,
      category: draft.category,
      sourceConversationId: draft.sourceConversationId,
      createdAt: existing?.created_at ?? now,
      lastUsedAt: existing?.last_used_at ?? null,
      useCount: existing?.use_count ?? 0,
      triggers: draft.triggers && draft.triggers.length > 0
        ? draft.triggers
        : parseTriggers(existing?.triggers),
      updatedAt: bumpUpdated ? now : existing?.updated_at ?? null
    }
    // Rewrite SKILL.md only when the rendered bytes differ from what is on
    // disk — a stricter test than the content hash alone: the hash misses
    // frontmatter-only changes (ensureTriggers persisting new triggers), which
    // still have to reach the file the raw view and pick_skill hand to the model.
    const nextMd = formatExperienceMd(record, draft.content)
    let writeSkill = true
    if (existing) {
      try {
        writeSkill = await readFile(join(EXPERIENCES_DIR, name, 'SKILL.md'), 'utf-8').then((s) => s !== nextMd)
      } catch { /* no file yet (dir deleted, row remains) → write */ }
    }
    if (writeSkill) {
      await mkdir(join(EXPERIENCES_DIR, name), { recursive: true })
      await writeFile(join(EXPERIENCES_DIR, name, 'SKILL.md'), nextMd, 'utf-8')
    }
    for (const f of acceptedFiles) {
      if (!f) continue
      await mkdir(join(EXPERIENCES_DIR, name, 'scripts'), { recursive: true })
      await writeFile(join(EXPERIENCES_DIR, name, f.path), f.content, 'utf-8')
    }
    record.files = effectiveFiles && effectiveFiles.length > 0 ? effectiveFiles : undefined
    getDb()
      .prepare(
        `INSERT INTO experiences (id, name, title, description, category, source_conversation_id, created_at, last_used_at, use_count, triggers, files_json, updated_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           category = excluded.category,
           source_conversation_id = excluded.source_conversation_id,
           triggers = excluded.triggers,
           files_json = COALESCE(excluded.files_json, experiences.files_json),
           updated_at = excluded.updated_at,
           content_hash = excluded.content_hash`
      )
      .run(record.id, record.name, record.title, record.description, record.category, record.sourceConversationId ?? null, record.createdAt, record.lastUsedAt ?? null, record.useCount, JSON.stringify(record.triggers ?? []), record.files ? JSON.stringify(record.files) : null, record.updatedAt ?? null, contentHash)
    const evicted = await this.enforceLimit()
    return {
      record,
      evicted,
      rejectedFiles: rejectedFiles.length > 0 ? rejectedFiles : undefined,
    }
  }

  /** Evict experiences beyond MAX_EXPERIENCES using LRU ordering.
   *  The count read and the row deletes run inside ONE synchronous
   *  transaction (PLAN-parallel-experts T11): two concurrent saves used to
   *  compute deletions from a stale total and over-evict. File removal
   *  happens after — outside the transaction, best-effort. */
  private async enforceLimit(): Promise<ExperienceRecord | undefined> {
    const db = getDb()
    const evict = db.transaction((): any[] => {
      const total = (db.prepare('SELECT COUNT(*) as c FROM experiences').get() as { c: number }).c
      if (total <= MAX_EXPERIENCES) return []
      const rows = db
        .prepare(
          `SELECT * FROM experiences
           ORDER BY (last_used_at IS NULL) DESC, COALESCE(last_used_at, '0') ASC, use_count ASC
           LIMIT ?`
        )
        .all(total - MAX_EXPERIENCES) as any[]
      const del = db.prepare('DELETE FROM experiences WHERE name = ?')
      for (const row of rows) del.run(row.name)
      return rows
    })
    const rows = evict()
    let evicted: ExperienceRecord | undefined
    for (const row of rows) {
      evicted = rowToRecord(row)
      await rm(join(EXPERIENCES_DIR, row.name), { recursive: true, force: true }).catch(() => {})
    }
    return evicted
  }

  async delete(name: string): Promise<void> {
    // 名字消毒（full_20261011 M9-P0-1）：join 不做越界检查，`..` 会把
    // 「删一个经验目录」变成递归删 ~/.pulsemind 的任意祖先。
    const dir = safeChildPath(EXPERIENCES_DIR, name)
    if (!dir) throw new Error(`invalid experience name: ${JSON.stringify(name)}`)
    await rm(dir, { recursive: true, force: true })
    getDb().prepare('DELETE FROM experiences WHERE name = ?').run(name)
  }

  /** Remove every experience: all record dirs + the whole table. Returns the
   *  count that was removed. */
  async clear(): Promise<number> {
    const rows = getDb().prepare('SELECT name FROM experiences').all() as { name: string }[]
    getDb().prepare('DELETE FROM experiences').run()
    for (const row of rows) {
      await rm(join(EXPERIENCES_DIR, row.name), { recursive: true, force: true }).catch(() => {})
    }
    return rows.length
  }

  /** Record a trigger of an experience (called when the LLM reads it).
   *  `outcome` (PLAN-experience-outcome M1) rides the SAME touch — a script
   *  run observed by the exec settlement's static matcher books its exit
   *  verdict alongside the usage count, so one row update carries both. */
  async touch(name: string, outcome?: 'ok' | 'fail'): Promise<void> {
    if (!outcome) {
      getDb()
        .prepare('UPDATE experiences SET last_used_at = ?, use_count = use_count + 1 WHERE name = ?')
        .run(localTimestamp(), name)
      return
    }
    const db = getDb()
    const row = db.prepare('SELECT outcome_json FROM experiences WHERE name = ?').get(name) as { outcome_json?: string | null } | undefined
    if (!row) return
    let data: { ok: number; fail: number; lastOutcomeAt?: string | null } = { ok: 0, fail: 0, lastOutcomeAt: null }
    if (typeof row.outcome_json === 'string' && row.outcome_json) {
      try {
        const parsed = JSON.parse(row.outcome_json)
        if (parsed && typeof parsed === 'object') {
          data = {
            ok: Number.isFinite(parsed.ok) ? parsed.ok : 0,
            fail: Number.isFinite(parsed.fail) ? parsed.fail : 0,
            lastOutcomeAt: typeof parsed.lastOutcomeAt === 'string' ? parsed.lastOutcomeAt : null,
          }
        }
      } catch { /* malformed → start fresh; the counters are advisory */ }
    }
    data[outcome] += 1
    data.lastOutcomeAt = localTimestamp()
    db.prepare('UPDATE experiences SET last_used_at = ?, use_count = use_count + 1, outcome_json = ? WHERE name = ?')
      .run(data.lastOutcomeAt, JSON.stringify(data), name)
  }
}

export const experienceStore = new ExperienceStore()
