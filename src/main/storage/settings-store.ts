import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SETTINGS_PATH, DATA_DIR, ensureDataDir } from './index'
import { resolveEnvVarsDeep, resolveEnvVarsInString } from '../../shared/env'
import type { AppSettings, LlmProfile } from '../../shared/types/settings'

const DEFAULT_WORKSPACE_DIR = join(DATA_DIR, 'workspace')

/** Profile `headers` and `apiKey` keep raw ${VAR} placeholders: nothing
 * env-resolved ever round-trips through the renderer back into settings.json
 * (a resolved value saved back would permanently destroy the placeholder).
 * Both are resolved per-request in api-proxy.handler.ts. */
const SKIP_ENV_KEYS = new Set(['headers', 'apiKey'])

/** In-memory cache keyed on file mtime so reads skip disk+parse+env resolution. */
interface SettingsCache {
  mtimeMs: number
  settings: AppSettings
}
let cache: SettingsCache | null = null

function readWorkspaceDir(parsed: Record<string, unknown>): string {
  return (parsed.workspaceDir as string) || (parsed.outputDir as string) || DEFAULT_WORKSPACE_DIR
}

const FALLBACK_SETTINGS: AppSettings = {
  activeProfileId: '',
  profiles: [],
  theme: 'light',
  myName: '',
  soul: '',
  yourName: '',
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  autoCleanup: false,
  yoloMode: true,
  locale: 'zh',
  launchAtLogin: false
}

/**
 * Recursively re-apply ${VAR} placeholders from the previous raw file when the
 * incoming (already-resolved) value equals the resolution of that placeholder.
 * Genuine user edits (value differs from the old resolution) are kept as-is.
 * `headers`/`apiKey` are skipped by env resolution and stored raw, so they pass through.
 */
function restorePlaceholders(oldRaw: unknown, next: unknown): unknown {
  if (typeof oldRaw === 'string' && typeof next === 'string') {
    if (oldRaw !== next && resolveEnvVarsInString(oldRaw, false) === next) return oldRaw
    return next
  }
  if (Array.isArray(oldRaw) && Array.isArray(next)) {
    return next.map((v, i) => restorePlaceholders(oldRaw[i], v))
  }
  if (oldRaw && typeof oldRaw === 'object' && next && typeof next === 'object' && !Array.isArray(next)) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      result[k] = restorePlaceholders((oldRaw as Record<string, unknown>)[k], v)
    }
    return result
  }
  return next
}

export class SettingsStore {
  async get(): Promise<AppSettings> {
    ensureDataDir()
    try {
      const stats = await stat(SETTINGS_PATH)
      // Serve from cache when the file hasn't changed since last read.
      if (cache && cache.mtimeMs === stats.mtimeMs) return structuredClone(cache.settings)

      const data = await readFile(SETTINGS_PATH, 'utf-8')
      const parsed = resolveEnvVarsDeep(JSON.parse(data), {
        keepMissing: false,
        skipKeys: SKIP_ENV_KEYS,
      }) as any

      // New format: has profiles array
      if (parsed.profiles && Array.isArray(parsed.profiles)) {
        const profiles: LlmProfile[] = parsed.profiles
        const result: AppSettings = {
          activeProfileId: profiles.length > 0
            ? (parsed.activeProfileId || profiles[0].id)
            : '',
          profiles,
          theme: parsed.theme ?? 'light',
          myName: parsed.myName ?? '',
          soul: parsed.soul ?? '',
          yourName: parsed.yourName ?? '',
          workspaceDir: readWorkspaceDir(parsed),
          autoCleanup: parsed.autoCleanup ?? false,
          yoloMode: parsed.yoloMode ?? true,
          locale: parsed.locale ?? 'zh',
          launchAtLogin: parsed.launchAtLogin ?? false,
        }
        cache = { mtimeMs: stats.mtimeMs, settings: result }
        return structuredClone(result)
      }

      // Old format: migrate single profile to profiles array
      const migrated = this.migrate(parsed)
      cache = { mtimeMs: stats.mtimeMs, settings: migrated }
      return structuredClone(migrated)
    } catch {
      return { ...FALLBACK_SETTINGS }
    }
  }

  /**
   * Migrate from old single-profile format to the new profiles-based format.
   */
  private migrate(old: Record<string, unknown>): AppSettings {
    const profile: LlmProfile = {
      id: 'default',
      name: (old.profileName as string) || 'My LLM',
      baseURL: (old.baseURL as string) || '',
      model: (old.model as string) || '',
      maxTokens: (old.maxTokens as number) ?? 32768,
      provider: (old.provider as 'anthropic' | 'openai') || undefined,
      apiKey: (old.apiKey as string) || undefined
    }

    return {
      activeProfileId: 'default',
      profiles: [profile],
      theme: (old.theme as string) === 'dark' ? 'dark' : 'light',
      myName: '',
      soul: '',
      yourName: '',
      workspaceDir: DEFAULT_WORKSPACE_DIR,
      autoCleanup: false,
      yoloMode: true,
      locale: 'zh'
    }
  }

  async set(settings: AppSettings): Promise<void> {
    // Strip legacy outputDir key, write as workspaceDir only
    const { outputDir: _legacy, ...clean } = settings as unknown as Record<string, unknown>

    // The renderer holds RESOLVED values (env placeholders already replaced),
    // so a naive write would persist the concrete value and permanently destroy
    // ${VAR} placeholders. Restore the original placeholder wherever the incoming
    // value still matches the resolved placeholder from the previous file.
    let toWrite: unknown = clean
    try {
      const prevRaw = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')) as unknown
      toWrite = restorePlaceholders(prevRaw, clean)
    } catch {
      // No previous file (first write) — write as-is
    }

    await writeFile(SETTINGS_PATH, JSON.stringify(toWrite, null, 2), 'utf-8')
    // Drop the cache; the next get() re-reads from the new file (its mtime differs).
    cache = null
  }
}

export const settingsStore = new SettingsStore()
