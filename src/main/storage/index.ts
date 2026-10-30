import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'

export const DATA_DIR = join(homedir(), '.pulsemind')
export const CONVERSATIONS_DIR = join(DATA_DIR, 'conversations')
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json')
export const SKILLS_DIR = join(DATA_DIR, 'skills')
export const EXPERIENCES_DIR = join(DATA_DIR, 'experiences')
export const KNOWLEDGE_DIR = join(DATA_DIR, 'knowledge')
export const KNOWLEDGE_RAW_DIR = join(KNOWLEDGE_DIR, 'raw')
export const KNOWLEDGE_WIKI_DIR = join(KNOWLEDGE_DIR, 'wiki')
export const KNOWLEDGE_SCHEMA_DIR = join(KNOWLEDGE_DIR, '.schemas')
export const KNOWLEDGE_BASES_DIR = join(KNOWLEDGE_DIR, 'bases')

/** Physical directory for a knowledge base's raw files. */
export function getBaseRawDir(baseId: string): string {
  return join(KNOWLEDGE_BASES_DIR, baseId, 'raw')
}

/** Physical directory for a knowledge base's compiled wiki pages. */
export function getBaseWikiDir(baseId: string): string {
  return join(KNOWLEDGE_BASES_DIR, baseId, 'wiki')
}
export const HOOKS_DIR = join(DATA_DIR, 'hooks')
export const MEMORY_MD_PATH = join(DATA_DIR, 'memory', 'MEMORY.md')
export const WORKSPACE_DIR = join(DATA_DIR, 'workspace')
export const TOOLS_DIR = join(DATA_DIR, 'tools')

/**
 * Resolve the built-in template directory path.
 * Dev: <project-root>/templates/pulsemind/
 * Packaged: <resources>/templates/pulsemind/
 */
function getTemplatesDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'templates', 'pulsemind')
}

/**
 * Bundle-distributed preset tools (M5R). Seeded into ~/.pulsemind/tools/preset_<id>/
 * by toolStore.seedPresets — deliberately NOT handled by the generic copy below.
 */
export function getBundlePresetsDir(): string {
  return join(getTemplatesDir(), 'tools', 'presets')
}

/** Local-date stamp (yyyyMMdd) for the hooks template backup files —
 *  app-start.js.20261030.bak. Exported for the tests to pin the format. */
export function backupDateStamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
}

/**
 * Recursively copy template files to DATA_DIR, but only for files
 * that don't already exist (never overwrite user data).
 *
 * The one exception is the hooks/ subtree (user ruling 2026-10-30): template
 * files under hooks/ REPLACE their on-disk copies on every launch, so a
 * version upgrade ships the improved hook script to existing installs — the
 * plain !existsSync guard froze the first-ever seed on upgraded machines
 * forever. Identical bytes are skipped (no mtime churn); files no template
 * carries — llm-request.js is purely user-created, never seeded — and any
 * other disk-only extra are never deleted. A replaced file is backed up to
 * <name>.<yyyyMMdd>.bak next to itself first (second ruling the same day),
 * and the FIRST backup of a day is never overwritten: backups are sacred,
 * and a same-day second update must not replace the user's real content
 * with an earlier template state.
 */
function copyTemplatesToDataDir(templatesDir: string): void {
  function walk(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch { return } // skip unreadable
    for (const entry of entries) {
      const srcPath = join(dir, entry.name)
      const relPath = relative(templatesDir, srcPath)
      // tools/presets is the preset-tool distribution: the seeder takes it
      // (stamped manifests), a plain copy would be dead weight.
      const segs = relPath.split(/[\\/]/)
      if (segs[0] === 'tools' && segs[1] === 'presets') continue
      const destPath = join(DATA_DIR, relPath)
      if (entry.isDirectory()) {
        if (!existsSync(destPath)) {
          try { mkdirSync(destPath, { recursive: true }) } catch { /* ignore */ }
        }
        walk(srcPath)
      } else if (entry.isFile()) {
        const followTemplate = segs[0] === 'hooks'
        const existed = existsSync(destPath)
        if (!existed || followTemplate) {
          try {
            if (existed) {
              if (readFileSync(srcPath).equals(readFileSync(destPath))) continue
              // The replaced bytes stay recoverable: <name>.<yyyyMMdd>.bak
              // next to the file. The day's first backup is kept — a second
              // update the same day must not overwrite it (see doc above).
              const bakPath = `${destPath}.${backupDateStamp()}.bak`
              if (!existsSync(bakPath)) {
                copyFileSync(destPath, bakPath)
                console.log(`[init] Backed up ${destPath} -> ${bakPath}`)
              }
            }
            copyFileSync(srcPath, destPath)
            console.log(`[init] ${existed ? 'Updated' : 'Created'} ${destPath} from template`)
          } catch (e) {
            console.error(`[init] Failed to copy template ${srcPath}:`, e)
          }
        }
      }
    }
  }
  walk(templatesDir)
}

/**
 * Join path segments under the PulseMind data directory (~/.pulsemind / %USERPROFILE%\.pulsemind).
 *
 * Example: `joinDataPath('skills', 'my-skill', 'SKILL.md')`
 *   → macOS/Linux: /Users/name/.pulsemind/skills/my-skill/SKILL.md
 *   → Windows:     C:\Users\name\.pulsemind\skills\my-skill\SKILL.md
 */
export function joinDataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments)
}

export function ensureDataDir(): void {
  // Create parent directories if they don't exist
  for (const dir of [DATA_DIR, SKILLS_DIR, EXPERIENCES_DIR, KNOWLEDGE_DIR, KNOWLEDGE_SCHEMA_DIR, KNOWLEDGE_BASES_DIR, getBaseRawDir('default'), getBaseWikiDir('default'), WORKSPACE_DIR, HOOKS_DIR, join(DATA_DIR, 'db'), join(DATA_DIR, 'mcp'), join(DATA_DIR, 'memory'), join(DATA_DIR, 'tmp'), join(DATA_DIR, 'tmp', 'trunc')]) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch (e) {
        console.error(`[init] Failed to create directory ${dir}:`, e)
      }
    }
  }

  // Copy built-in template files to DATA_DIR (only if destination files don't exist).
  // Templates are the single source of truth for initial state — changing them
  // per environment (dev/staging/prod) replaces all hardcoded DEFAULT_* constants.
  const templatesDir = getTemplatesDir()
  if (existsSync(templatesDir)) {
    copyTemplatesToDataDir(templatesDir)
  }

  // Fallback: create empty MEMORY.md if templates weren't available
  if (!existsSync(MEMORY_MD_PATH)) {
    try {
      writeFileSync(MEMORY_MD_PATH, '', 'utf-8')
      console.log('[init] Created empty MEMORY.md (fallback, no template)')
    } catch (e) {
      console.error('[init] Failed to create MEMORY.md:', e)
    }
  }
}
