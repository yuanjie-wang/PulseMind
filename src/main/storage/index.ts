import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { logMain, describeError } from '../main-log'

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
 * The hooks/ subtree is the one exception, and it is PROVENANCE-GATED
 * (2026-11-05, amending the 2026-10-30 "always follow the template" ruling
 * after that arm clobbered a hand-deployed login hook on first launch — the
 * UOS deployment placed its app-start.js before the app ever ran, and the
 * skeleton replaced it; the same would happen on any OS): the template may
 * replace an on-disk hook file only when the file's bytes are still exactly
 * what a previous launch seeded (tracked in .seed-hashes.json) — i.e. the
 * user never touched it. A file that differs from its recorded seed, or that
 * predates the manifest (hand-deployed content included), is user content:
 * kept verbatim on every launch, never backed up, never deleted. Identical
 * bytes skip silently; files no template carries — llm-request.js is purely
 * user-created, never seeded — and any other disk-only extra are never
 * deleted. An upgraded-over file is still backed up to <name>.<yyyyMMdd>.bak
 * next to itself first (second ruling of 2026-10-30), and the FIRST backup
 * of a day is never overwritten: backups are sacred, and a second update the
 * same day must not replace the recoverable state with an earlier one.
 * Outside hooks/ the never-overwrite contract stands unchanged.
 */
function copyTemplatesToDataDir(templatesDir: string): void {
  // Provenance for the hooks subtree only (see HOOKS_SEED_MANIFEST_PATH):
  // keys are template-relative paths (`/`-separated), values the sha256 of
  // the bytes a previous launch last seeded there.
  const seedManifest = loadSeedManifest()
  let manifestDirty = false
  const recordSeed = (seedKey: string, bytes: Buffer): void => {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (seedManifest[seedKey] !== hash) {
      seedManifest[seedKey] = hash
      manifestDirty = true
    }
  }
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
        const isHook = segs[0] === 'hooks'
        const seedKey = segs.join('/')
        const existed = existsSync(destPath)
        if (!existed || isHook) {
          try {
            const templateBytes = readFileSync(srcPath)
            if (!existed) {
              copyFileSync(srcPath, destPath)
              if (isHook) recordSeed(seedKey, templateBytes)
              console.log(`[init] Created ${destPath} from template`)
              logMain('INFO', 'init', `created ${destPath} from template`)
            } else {
              // hooks/ follows the template, but only through the provenance
              // gate (see the doc comment above); everything outside keeps
              // the plain never-overwrite contract untouched.
              const diskBytes = readFileSync(destPath)
              if (templateBytes.equals(diskBytes)) {
                // Pristine — either our own seed (the record is already
                // right) or a pre-manifest copy that equals today's
                // template; both are safe to track as ours.
                recordSeed(seedKey, templateBytes)
              } else if (seedManifest[seedKey] !== undefined && createHash('sha256').update(diskBytes).digest('hex') === seedManifest[seedKey]) {
                // The file is exactly what we last seeded — nobody has
                // touched it, so the template may upgrade it. The replaced
                // bytes stay recoverable: <name>.<yyyyMMdd>.bak next to the
                // file; the day's first backup is kept.
                const bakPath = `${destPath}.${backupDateStamp()}.bak`
                if (!existsSync(bakPath)) {
                  copyFileSync(destPath, bakPath)
                  console.log(`[init] Backed up ${destPath} -> ${bakPath}`)
                  logMain('INFO', 'init', `backed up ${destPath} -> ${bakPath}`)
                }
                copyFileSync(srcPath, destPath)
                recordSeed(seedKey, templateBytes)
                console.log(`[init] Updated ${destPath} from template`)
                logMain('INFO', 'init', `updated ${destPath} from template`)
              } else {
                // User content: hand-deployed before the app ever ran, or
                // edited after our seed. Never overwritten, never deleted —
                // the deployment's hook is the deployment's property.
                console.log(`[init] hooks: kept user content ${destPath} (differs from template/seed)`)
                logMain('INFO', 'init', `hooks: kept user content ${destPath} (differs from the template and its seed record; not overwritten)`)
              }
            }
          } catch (e) {
            console.error(`[init] Failed to copy template ${srcPath}:`, e)
            logMain('ERROR', 'init', `failed to copy template ${srcPath}: ${describeError(e)}`)
          }
        }
      }
    }
  }
  walk(templatesDir)
  if (manifestDirty) saveSeedManifest(seedManifest)
}

/** Provenance of the hooks template files this app seeds: template-relative
 *  path → sha256 hex of the bytes the seeder wrote (or adopted as pristine).
 *  Unconditional template-follow (2026-10-30) also clobbered hand-deployed
 *  hooks — the manifest is the same fix skills already use for their seed
 *  (skill-store.ts `.seed-hashes.json`): upgrade only what we seeded and the
 *  user never touched, keep everything else. */
const HOOKS_SEED_MANIFEST_PATH = join(HOOKS_DIR, '.seed-hashes.json')

/** Best-effort manifest read: a missing/corrupt file means "no records",
 *  which keeps user content — the fail-safe direction. */
function loadSeedManifest(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(HOOKS_SEED_MANIFEST_PATH, 'utf-8'))
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Best-effort manifest write; only called when the map actually changed. */
function saveSeedManifest(manifest: Record<string, string>): void {
  try {
    writeFileSync(HOOKS_SEED_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8')
  } catch (e) {
    console.error('[init] Failed to write hooks seed manifest:', e)
    logMain('ERROR', 'init', `failed to write hooks seed manifest: ${describeError(e)}`)
  }
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
  // experience/（单数，2026-11-12 经验 SKILL 化的磁盘真源）与 experiences/（复数，
  // 一代遗留、冻结只读）并存：前者进清单保证首启即存在，后者不动。
  for (const dir of [DATA_DIR, SKILLS_DIR, EXPERIENCES_DIR, join(DATA_DIR, 'experience'), KNOWLEDGE_DIR, KNOWLEDGE_SCHEMA_DIR, KNOWLEDGE_BASES_DIR, getBaseRawDir('default'), getBaseWikiDir('default'), WORKSPACE_DIR, HOOKS_DIR, join(DATA_DIR, 'db'), join(DATA_DIR, 'mcp'), join(DATA_DIR, 'memory'), join(DATA_DIR, 'tmp'), join(DATA_DIR, 'tmp', 'trunc')]) {
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
