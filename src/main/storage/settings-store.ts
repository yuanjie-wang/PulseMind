import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SETTINGS_PATH, DATA_DIR, ensureDataDir } from './index'
import { resolveEnvVarsDeep, resolveEnvVarsInString } from '../../shared/env'
import type { AppSettings, LlmProfile } from '../../shared/types/settings'
import type { ProjectSortMode } from '../../shared/types/project'

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

/** 运行历史保留天数：正整数才有效，0 / 缺失 / 非法值都回落到“永久保留”。 */
function readRetentionDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

const PROJECT_SORT_MODES: readonly ProjectSortMode[] = ['created', 'name', 'activity', 'manual']

function readProjectSortMode(raw: unknown): ProjectSortMode | undefined {
  return PROJECT_SORT_MODES.includes(raw as ProjectSortMode) ? (raw as ProjectSortMode) : undefined
}

/**
 * The optional group keys (git / knowledge / browser) were added after `get()`
 * became a field-by-field rebuild and were missing from it: a value written to
 * settings.json was unreadable after restart AND erased from the file by the
 * next whole-object save (review 2026-09-18 H1/H2). Each reader below keeps
 * unknown sub-keys it finds, so a future field inside these groups does not
 * repeat the disease.
 */
function readGroup<T extends object>(raw: unknown, normalize: (group: Record<string, unknown>) => T): T | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return normalize(raw as Record<string, unknown>)
}

function readGitSettings(group: Record<string, unknown>): { contextInjection: boolean } {
  return { ...group, contextInjection: group.contextInjection !== false } as { contextInjection: boolean }
}

function readKnowledgeSettings(group: Record<string, unknown>): { autoCompile: boolean } {
  return { ...group, autoCompile: group.autoCompile === true } as { autoCompile: boolean }
}

function readNumberOrDrop(group: Record<string, unknown>, key: string): void {
  const value = group[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) delete group[key]
}

function readBrowserSettings(group: Record<string, unknown>): AppSettings['browser'] {
  const out: Record<string, unknown> = { ...group }
  if (out.backend !== 'managed' && out.backend !== 'app-view') delete out.backend
  if (typeof out.headless !== 'boolean') delete out.headless
  readNumberOrDrop(out, 'timeoutMs')
  readNumberOrDrop(out, 'paneWidth')
  return out as AppSettings['browser']
}

const FALLBACK_SETTINGS: AppSettings = {
  activeProfileId: '',
  profiles: [],
  // Dark is the app's default look: only a brand-new install or a corrupt file
  // lands here — existing settings.json files carry an explicit theme and keep
  // it (PLAN-dark-mode M1; sidebar toggle default 2026-09-20).
  theme: 'dark',
  myName: '',
  soul: '',
  yourName: '',
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  autoCleanup: false,
  locale: 'zh',
  launchAtLogin: false,
  serviceEnabled: true,
  memoryEnabled: true,
  experienceEnabled: true,
  routineRunRetentionDays: 0,
  conversationRetentionDays: 0,
  debugLlmRequests: false,
  debugPerfLogs: false
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
          theme: parsed.theme ?? 'dark',
          myName: parsed.myName ?? '',
          soul: parsed.soul ?? '',
          yourName: parsed.yourName ?? '',
          workspaceDir: readWorkspaceDir(parsed),
          autoCleanup: parsed.autoCleanup ?? false,
          locale: parsed.locale ?? 'zh',
          launchAtLogin: parsed.launchAtLogin ?? false,
          serviceEnabled: parsed.serviceEnabled ?? true,
          servicePort: parsed.servicePort ?? undefined,
          memoryEnabled: parsed.memoryEnabled ?? true,
          experienceEnabled: parsed.experienceEnabled ?? true,
          routineRunRetentionDays: readRetentionDays(parsed.routineRunRetentionDays),
          conversationRetentionDays: readRetentionDays(parsed.conversationRetentionDays),
          debugLlmRequests: parsed.debugLlmRequests === true,
          debugPerfLogs: parsed.debugPerfLogs === true,
          projectSortMode: readProjectSortMode(parsed.projectSortMode),
          git: readGroup(parsed.git, readGitSettings),
          knowledge: readGroup(parsed.knowledge, readKnowledgeSettings),
          browser: readGroup(parsed.browser, readBrowserSettings),
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
      locale: 'zh',
      memoryEnabled: true,
      experienceEnabled: true,
      routineRunRetentionDays: 0,
      debugLlmRequests: false,
      debugPerfLogs: false
    }
  }

  // ── Serialized whole-file writes (PLAN-parallel-experts T10) ──
  // settings.json has several independent main-process writers (pane width,
  // login item, activeProfileId, the user's own save). Every `set` is a
  // read-modify-write of the WHOLE file, so two concurrent writers used to
  // interleave (both read the old file, both wrote) and the later full-content
  // write silently rolled the earlier one back. Chaining every set behind the
  // previous one makes those read-modify-write sections mutually exclusive;
  // the tmp+rename publish keeps concurrent READERS from seeing a half file.
  private writeChain: Promise<void> = Promise.resolve()

  async set(settings: AppSettings): Promise<void> {
    const job = this.writeChain.then(() => this.doSet(settings))
    // A failed write must not poison every future write — the caller still
    // sees this job's rejection.
    this.writeChain = job.catch(() => {})
    return job
  }

  /**
   * Merge-shaped atomic update for the small main-process writers (pane
   * width, activeProfileId, login item, service flag): the FRESH read happens
   * inside the write chain and the mutator carries only its own field, so two
   * concurrent writers merge instead of each shipping a stale whole-file
   * snapshot that rolls the other back (the audit's "pane width silently
   * reverted the user's save"). Whole-content writers — the settings editor's
   * save — keep using `set`, whose payload is the user's inspected snapshot.
   */
  async update(mutate: (current: AppSettings) => AppSettings): Promise<void> {
    const job = this.writeChain.then(async () => {
      await this.doSet(mutate(await this.get()))
    })
    this.writeChain = job.catch(() => {})
    return job
  }

  private async doSet(settings: AppSettings): Promise<void> {
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

    const tmp = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(toWrite, null, 2), 'utf-8')
      try {
        await rename(tmp, SETTINGS_PATH)
      } catch {
        // Windows rename-over-existing can fail (AV/indexer locks) — fall back
        // to a direct write; the serialization above is the real fix.
        await writeFile(SETTINGS_PATH, JSON.stringify(toWrite, null, 2), 'utf-8')
        await unlink(tmp).catch(() => {})
      }
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    // Drop the cache; the next get() re-reads from the new file (its mtime differs).
    cache = null
  }
}

export const settingsStore = new SettingsStore()
