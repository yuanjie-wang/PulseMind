import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs'
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

/**
 * Recursively copy template files to DATA_DIR, but only for files
 * that don't already exist (never overwrite user data).
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
      } else if (entry.isFile() && !existsSync(destPath)) {
        try {
          copyFileSync(srcPath, destPath)
          console.log(`[init] Created ${destPath} from template`)
        } catch (e) {
          console.error(`[init] Failed to copy template ${srcPath}:`, e)
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
  for (const dir of [DATA_DIR, SKILLS_DIR, EXPERIENCES_DIR, KNOWLEDGE_DIR, KNOWLEDGE_RAW_DIR, KNOWLEDGE_WIKI_DIR, KNOWLEDGE_SCHEMA_DIR, WORKSPACE_DIR, HOOKS_DIR, join(DATA_DIR, 'db'), join(DATA_DIR, 'mcp'), join(DATA_DIR, 'memory'), join(DATA_DIR, 'tmp'), join(DATA_DIR, 'tmp', 'trunc')]) {
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
