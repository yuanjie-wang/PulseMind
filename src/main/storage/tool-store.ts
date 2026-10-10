// ── Tool store (PLAN-0.4.0 M5.1; presets per M5R) ──
// One directory per tool under ~/.pulsemind/tools/<id>/:
//   tool.json    — manifest
//   app.html     — the generated app (single file)
//   storage.json — bridge KV persistence (M6.6)
// Preset tools (M5R): bundle distributions under <bundle>/tools/presets/<id>/
// are stamped into ~/.pulsemind/tools/preset_<id>/ at startup — real tools
// with the same rights as user tools (run / edit in place / duplicate /
// delete, D-R2). Deletions are recorded in .presets.deleted.json so an app
// upgrade never resurrects them (D-R3), and「恢复预置工具」re-seeds on demand.

import { prefixedId } from '../utils/id'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS_DIR } from './index'
import { safeChildPath } from './safe-name'
import { planPresetSeeds } from '../../shared/preset-seeding'
import type { ToolCreateInput, ToolUpdateInput, UserTool } from '../../shared/types/user-tool'

/** Directory-id prefix of a seeded preset tool. */
export const TOOL_PRESET_PREFIX = 'preset_'

const DELETED_PRESETS_FILE = join(TOOLS_DIR, '.presets.deleted.json')
/** Legacy template copies from pre-M5R installs — promoted once, then removed. */
const LEGACY_TEMPLATES_DIR = join(TOOLS_DIR, 'templates')

function toolDir(id: string): string {
  return join(TOOLS_DIR, id)
}

function manifestPath(id: string): string {
  return join(toolDir(id), 'tool.json')
}

function readManifest(id: string): UserTool | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(id), 'utf-8')) as UserTool
    if (!parsed || parsed.id !== id) return null
    return parsed
  } catch {
    return null
  }
}

function readDeletedPresets(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(DELETED_PRESETS_FILE, 'utf-8')) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function listPresetIdsIn(baseDir: string): string[] {
  if (!existsSync(baseDir)) return []
  return readdirSync(baseDir).filter((name) => existsSync(join(baseDir, name, 'tool.json')))
}

/** Copy a distribution dir into ~/.pulsemind/tools/preset_<id>/, stamping the
 *  manifest (id / preset / presetId; legacy sourceTemplateId dropped). */
function stampPresetDir(sourceBase: string, presetId: string): void {
  const srcDir = join(sourceBase, presetId)
  const raw = JSON.parse(readFileSync(join(srcDir, 'tool.json'), 'utf-8')) as UserTool & { sourceTemplateId?: string }
  const { sourceTemplateId: _legacy, ...manifest } = raw
  const dest = toolDir(`${TOOL_PRESET_PREFIX}${presetId}`)
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    if (entry === 'tool.json') continue
    copyFileSync(join(srcDir, entry), join(dest, entry))
  }
  const stamped: UserTool = { ...manifest, id: `${TOOL_PRESET_PREFIX}${presetId}`, preset: true, presetId }
  writeFileSync(join(dest, 'tool.json'), JSON.stringify(stamped, null, 2), 'utf-8')
}

export const toolStore = {
  /** Ensure the directories exist. */
  init(): void {
    mkdirSync(TOOLS_DIR, { recursive: true })
  },

  list(): UserTool[] {
    if (!existsSync(TOOLS_DIR)) return []
    return readdirSync(TOOLS_DIR)
      .filter((name) => !name.startsWith('.') && existsSync(manifestPath(name)))
      .map((name) => readManifest(name))
      .filter((t): t is UserTool => t != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  get(id: string): UserTool | null {
    return readManifest(id)
  },

  /** Ids recorded as deleted by the user (D-R2) — seeding skips them. */
  getDeletedPresets(): string[] {
    return readDeletedPresets()
  },

  /** Stamp bundle presets into real tool dirs; idempotent. Called at startup
   *  (after ensureDataDir). */
  seedPresets(bundlePresetsDir: string): void {
    try {
      const bundleIds = listPresetIdsIn(bundlePresetsDir)
      const existing = bundleIds.filter((id) => existsSync(toolDir(`${TOOL_PRESET_PREFIX}${id}`)))
      for (const id of planPresetSeeds(bundleIds, existing, readDeletedPresets())) {
        stampPresetDir(bundlePresetsDir, id)
      }
    } catch (err) {
      console.warn('[tool-store] preset seeding failed:', err)
    }
  },

  /** One-time promotion of pre-M5R template copies (~/.pulsemind/tools/templates/):
   *  each becomes preset_<id> under the seeding rules; a preset dir that already
   *  exists means the user already has their own version — skipped (D-R3). The
   *  legacy dir is removed only when every promotion succeeded; otherwise it is
   *  kept and migration retries on the next boot. */
  migrateLegacyTemplates(): void {
    if (!existsSync(LEGACY_TEMPLATES_DIR)) return
    try {
      const legacyIds = listPresetIdsIn(LEGACY_TEMPLATES_DIR)
      let failed = 0
      for (const legacyId of legacyIds) {
        try {
          if (!existsSync(toolDir(`${TOOL_PRESET_PREFIX}${legacyId}`))) {
            stampPresetDir(LEGACY_TEMPLATES_DIR, legacyId)
          }
        } catch (err) {
          failed++
          console.warn(`[tool-store] legacy template promotion failed for ${legacyId}:`, err)
        }
      }
      if (failed === 0) {
        rmSync(LEGACY_TEMPLATES_DIR, { recursive: true, force: true })
        console.log(`[tool-store] promoted ${legacyIds.length} legacy templates to presets`)
      }
    } catch (err) {
      console.warn('[tool-store] legacy template migration failed, will retry:', err)
    }
  },

  /** 恢复预置工具: clear deletion records + re-seed, return the newly added tools. */
  restorePresets(bundlePresetsDir: string): UserTool[] {
    try {
      writeFileSync(DELETED_PRESETS_FILE, '[]', 'utf-8')
    } catch (err) {
      console.warn('[tool-store] failed to clear deleted presets:', err)
    }
    const before = new Set(this.list().map((t) => t.id))
    this.seedPresets(bundlePresetsDir)
    return this.list().filter((t) => !before.has(t.id))
  },

  /** D-R1: duplicate any tool into an independent copy — plain tool (preset
   *  flags stripped), fresh KV storage, original untouched. */
  duplicate(id: string): UserTool | null {
    const src = readManifest(id)
    if (!src) return null
    const now = new Date().toISOString()
    const newId = prefixedId('tool')
    const copy: UserTool = {
      ...src,
      id: newId,
      name: `${src.name}（副本）`,
      preset: undefined,
      presetId: undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    const dest = toolDir(newId)
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(toolDir(id))) {
      // Manifest is written stamped below; storage.json must NOT carry over —
      // the duplicate's bridge KV starts blank (no run-data cross-talk).
      if (entry === 'tool.json' || entry === 'storage.json') continue
      copyFileSync(join(toolDir(id), entry), join(dest, entry))
    }
    writeFileSync(manifestPath(newId), JSON.stringify(copy, null, 2), 'utf-8')
    return copy
  },

  readHtml(id: string): string | null {
    const manifest = readManifest(id)
    if (!manifest) return null
    try {
      return readFileSync(join(toolDir(id), manifest.htmlPath || 'app.html'), 'utf-8')
    } catch {
      return null
    }
  },

  /** Create a tool (studio-driven creation only). */
  create(input: ToolCreateInput): UserTool {
    const now = new Date().toISOString()
    const id = prefixedId('tool')
    const tool: UserTool = {
      id,
      name: input.name.trim() || '未命名工具',
      description: input.description ?? '',
      category: input.category,
      htmlPath: 'app.html',
      capabilities: input.capabilities ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    mkdirSync(toolDir(id), { recursive: true })
    writeFileSync(manifestPath(id), JSON.stringify(tool, null, 2), 'utf-8')
    return tool
  },

  update(id: string, patch: ToolUpdateInput): UserTool | null {
    const existing = readManifest(id)
    if (!existing) return null
    const next: UserTool = {
      ...existing,
      ...patch,
      id,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(manifestPath(id), JSON.stringify(next, null, 2), 'utf-8')
    return next
  },

  /** Persist generated HTML (called by the studio after generation). */
  writeHtml(id: string, html: string): void {
    const manifest = readManifest(id)
    if (!manifest) throw new Error(`tool not found: ${id}`)
    mkdirSync(toolDir(id), { recursive: true })
    writeFileSync(join(toolDir(id), manifest.htmlPath || 'app.html'), html, 'utf-8')
  },

  /** Delete a tool. Preset tools are recorded in .presets.deleted.json so the
   *  next seeding (including after an app upgrade) will not restore them. */
  remove(id: string): void {
    // 名字消毒（full_20261011 M9-P0-1）：`id='..'` 曾把 toolDir 变成
    // TOOLS_DIR 的父目录并递归删除。
    if (!safeChildPath(TOOLS_DIR, id)) throw new Error(`invalid tool id: ${JSON.stringify(id)}`)
    rmSync(toolDir(id), { recursive: true, force: true })
    if (id.startsWith(TOOL_PRESET_PREFIX)) {
      const presetId = id.slice(TOOL_PRESET_PREFIX.length)
      const deleted = readDeletedPresets()
      if (!deleted.includes(presetId)) {
        try {
          writeFileSync(DELETED_PRESETS_FILE, JSON.stringify([...deleted, presetId], null, 2), 'utf-8')
        } catch (err) {
          console.warn('[tool-store] failed to record preset deletion:', err)
        }
      }
    }
  },
}
