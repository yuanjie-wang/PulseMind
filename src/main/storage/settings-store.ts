import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SETTINGS_PATH, DATA_DIR, ensureDataDir } from './index'
import type { AppSettings, LlmProfile } from '../../shared/types/settings'

const DEFAULT_WORKSPACE_DIR = join(DATA_DIR, 'workspace')

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
  locale: 'zh'
}

/** Replace ${VAR_NAME} patterns with process.env values in all string values. */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars)
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      // Profile headers keep raw ${VAR} so the renderer can display them;
      // they're resolved at request time in api-proxy.handler.ts.
      if (k === 'headers') { result[k] = v; continue }
      result[k] = resolveEnvVars(v)
    }
    return result
  }
  return obj
}

export class SettingsStore {
  async get(): Promise<AppSettings> {
    ensureDataDir()
    try {
      const data = await readFile(SETTINGS_PATH, 'utf-8')
      const parsed = resolveEnvVars(JSON.parse(data)) as any

      // New format: has profiles array
      if (parsed.profiles && Array.isArray(parsed.profiles)) {
        const profiles: LlmProfile[] = parsed.profiles
        return {
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
          locale: parsed.locale ?? 'zh'
        }
      }

      // Old format: migrate single profile to profiles array
      return this.migrate(parsed)
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
    await writeFile(SETTINGS_PATH, JSON.stringify(clean, null, 2), 'utf-8')
  }
}

export const settingsStore = new SettingsStore()
