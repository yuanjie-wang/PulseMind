import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SETTINGS_PATH, DATA_DIR, ensureDataDir } from './index'
import { resolveEnvVarsDeep, resolveEnvVarsInString } from '../../shared/env'
import { toSandboxApprovalMode } from '../../shared/sandbox/policy'
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

// ── Secrets at rest (PLAN-security-hardening P1) ─────────────────────────
// In memory an AppSettings is ALWAYS plaintext/placeholder; the DISK bytes are
// ciphertext (except ${VAR} placeholders, which are designed to be readable).
// Every consumer — session-manager, api-proxy, the renderer settings editor —
// keeps reading `profile.apiKey` unchanged. The walk touches exactly two
// fields (each profile's apiKey + each headers value); widening it later
// means re-checking the restorePlaceholders contract, not just adding a key.

const ENC_PREFIX = 'enc:v1:'

/** True only when a REAL safeStorage answers. Under ELECTRON_RUN_AS_NODE
 *  (probes) `require('electron')` yields the binary path, so safeStorage is
 *  undefined here and every secret stays plaintext on disk — which is exactly
 *  how the probe exercises the fallback branch for free. */
function encryptionAvailable(): boolean {
  try {
    return !!safeStorage && typeof (safeStorage as { isEncryptionAvailable?: unknown }).isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

let warnedPlaintextFallback = false

function encryptSecretValue(plain: string): string {
  if (!plain || plain.startsWith('${')) return plain
  if (!encryptionAvailable()) {
    if (!warnedPlaintextFallback) {
      warnedPlaintextFallback = true
      console.warn('[settings] safeStorage unavailable — apiKey/headers are stored in PLAINTEXT')
    }
    return plain
  }
  try {
    return ENC_PREFIX + Buffer.from(safeStorage.encryptString(plain)).toString('base64')
  } catch (err) {
    // The user DECLINED the macOS keychain prompt (encryptString throws) —
    // a save must never die on that: fall back to plaintext with one warn,
    // the same contract as "keychain unavailable".
    if (!warnedPlaintextFallback) {
      warnedPlaintextFallback = true
      console.warn('[settings] keychain denied — storing secrets in PLAINTEXT:', err instanceof Error ? err.message : err)
    }
    return plain
  }
}

/** Undecryptable = dropped with a warn, never returned as the ciphertext
 *  string: the one unrecoverable outcome (a keychain reset) must fail as "no
 *  key configured", not as "requests signed with base64 noise". */
function decryptSecretValue(value: string): string | undefined {
  if (!value.startsWith(ENC_PREFIX)) return value
  if (!encryptionAvailable()) {
    console.warn('[settings] encrypted secret found but safeStorage is unavailable — dropping the value')
    return undefined
  }
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    console.warn('[settings] a stored secret could not be decrypted (keychain changed?) — dropping it')
    return undefined
  }
}

interface SecretCarrier {
  apiKey?: unknown
  headers?: Record<string, unknown>
}

function mapProfileSecrets(profiles: unknown[], map: (value: string) => string | undefined): unknown[] {
  return profiles.map((p) => {
    if (!p || typeof p !== 'object') return p
    const next: SecretCarrier & Record<string, unknown> = { ...(p as Record<string, unknown>) }
    if (typeof next.apiKey === 'string') {
      const mapped = map(next.apiKey)
      if (mapped === undefined) delete next.apiKey
      else next.apiKey = mapped
    }
    if (next.headers && typeof next.headers === 'object' && !Array.isArray(next.headers)) {
      const headers: Record<string, unknown> = { ...next.headers }
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== 'string') continue
        const mapped = map(v)
        if (mapped === undefined) delete headers[k]
        else headers[k] = mapped
      }
      next.headers = headers
    }
    return next
  })
}

/** Disk → memory: decode `enc:v1:` values. Runs BEFORE resolveEnvVarsDeep in
 *  get(), so env resolution sees plaintext/placeholders, never ciphertext. */
function decodeSecretsDeep<T>(settings: T): T {
  const out = settings as { profiles?: unknown }
  if (!Array.isArray(out?.profiles)) return settings
  return { ...out, profiles: mapProfileSecrets(out.profiles, decryptSecretValue) } as T
}

/** Memory → disk: encrypt non-placeholder secrets — ONLY when the user opted
 *  in (`encryptSecrets: true`, 2026-09-25 ruling: the macOS keychain prompt
 *  is not for everyone, and P0's file permissions carry the default posture).
 *  Existing ciphertext passes through untouched (get() still decodes it, so a
 *  switch-off + one save naturally converts back to plaintext). */
function encodeSecretsDeep<T>(settings: T): T {
  const out = settings as { profiles?: unknown; encryptSecrets?: boolean }
  if (!Array.isArray(out?.profiles)) return settings
  if (out.encryptSecrets !== true) return settings
  return { ...out, profiles: mapProfileSecrets(out.profiles, encryptSecretValue) } as T
}

/** P1 one-time migration: rewrite settings.json whose secrets are still
 *  plaintext (a pre-hardening file, or a key that predates this build). A
 *  no-op identity update drives the whole write path — doSet decodes,
 *  restores placeholders and re-encodes — so the rewrite is the SAME code
 *  every save runs. Idempotent: the second scan finds nothing. */
export async function migrateEncryptedSecrets(): Promise<boolean> {
  // Opt-in gate first (2026-09-25): the flag OFF must never touch the
  // keychain — that is the whole point of the switch.
  if (!encryptionAvailable()) return false
  const current = await settingsStore.get()
  if (current.encryptSecrets !== true) return false
  let raw: { profiles?: Array<Record<string, unknown>> } | null = null
  try {
    raw = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
  } catch {
    return false
  }
  const isPlainSecret = (v: unknown): boolean =>
    typeof v === 'string' && v.length > 0 && !v.startsWith('${') && !v.startsWith(ENC_PREFIX)
  const needs = (raw?.profiles ?? []).some((p) =>
    p && typeof p === 'object' && (
      isPlainSecret((p as SecretCarrier).apiKey) ||
      Object.values(((p as SecretCarrier).headers ?? {}) as Record<string, unknown>).some(isPlainSecret)
    )
  )
  if (!needs) return false
  if (!encryptionAvailable()) {
    console.warn('[settings] plaintext secrets found but safeStorage is unavailable — leaving settings.json untouched')
    return false
  }
  await settingsStore.update((s) => ({ ...s }))
  console.log('[settings] migrated plaintext secrets to safeStorage encryption')
  return true
}

function readWorkspaceDir(parsed: Record<string, unknown>): string {
  return (parsed.workspaceDir as string) || (parsed.outputDir as string) || DEFAULT_WORKSPACE_DIR
}

/** 运行历史保留天数：正整数才有效，0 / 缺失 / 非法值都回落到“永久保留”。 */
function readRetentionDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/** 备份保留天数的读取器：与 readRetentionDays 的「缺失=永久」刻意不同 ——
 *  这里的预期就是默认开启（用户批准 P3 时点名了存量备份），所以缺失/非法
 *  落到调用方给的默认值；只有显式 0 才是永久保留。 */
function readRetentionDaysWithDefault(raw: unknown, fallback: number): number {
  if (raw === 0) return 0
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** 有界正整数字段（agent 运行上限）：缺失 / 非法 / 越界一律回落默认值——
 *  这些数字直接喂给循环与并发的边界判断，宁可回落也不放行坏值。 */
function readIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const floored = Math.floor(raw)
  if (floored < min || floored > max) return fallback
  return floored
}

/** 记忆合并水位读取器：形状不对就丢弃（合并层会当作从未合并过，重新
 *  收敛一次——幂等，无害），绝不带病入库。 */
function readMergeWatermark(raw: unknown): { lastRunAt?: string; lastCount?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const out: { lastRunAt?: string; lastCount?: number } = {}
  if (typeof w.lastRunAt === 'string' && w.lastRunAt) out.lastRunAt = w.lastRunAt
  if (typeof w.lastCount === 'number' && Number.isFinite(w.lastCount) && w.lastCount >= 0) out.lastCount = w.lastCount
  return Object.keys(out).length > 0 ? out : undefined
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
  // 默认关闭（2026-09-21 用户裁定）：只有显式 true 才注入，缺失/非布尔一律回落关闭。
  return { ...group, contextInjection: group.contextInjection === true } as { contextInjection: boolean }
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
  keepAwakeEnabled: false,
  routineRunRetentionDays: 0,
  conversationRetentionDays: 0,
  backupRetentionDays: 30,
  maxLoopIterations: 50,
  maxParallelSubAgents: 5,
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
      // Decode ciphertext FIRST: env resolution must see plaintext/placeholder
      // values, never `enc:v1:` base64 (SKIP_ENV_KEYS keeps apiKey/headers raw
      // either way, but the ordering is the contract — see restorePlaceholders).
      const parsed = resolveEnvVarsDeep(decodeSecretsDeep(JSON.parse(data)), {
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
          keepAwakeEnabled: parsed.keepAwakeEnabled ?? false,
          routineRunRetentionDays: readRetentionDays(parsed.routineRunRetentionDays),
          conversationRetentionDays: readRetentionDays(parsed.conversationRetentionDays),
          maxLoopIterations: readIntInRange(parsed.maxLoopIterations, 50, 1, 500),
          maxParallelSubAgents: readIntInRange(parsed.maxParallelSubAgents, 5, 1, 10),
          debugLlmRequests: parsed.debugLlmRequests === true,
          debugPerfLogs: parsed.debugPerfLogs === true,
          projectSortMode: readProjectSortMode(parsed.projectSortMode),
          // 备份保留天数（P3-a）：缺失/非法 → 默认 30（这里的预期就是默认开启
          // ——用户点名了那三个 8 月的无主备份）；显式 0 → 永久保留。与
          // readRetentionDays 的「缺失=永久」语义刻意不同。
          backupRetentionDays: readRetentionDaysWithDefault(parsed.backupRetentionDays, 30),
          // P1 opt-in（2026-09-25 用户裁定：不要钥匙串弹窗）：缺省=false，
          // 明文 + P0 权限承担防护；只有显式 true 才加密。
          encryptSecrets: parsed.encryptSecrets === true,
          // 记忆合并水位（P2）：整存/逐字段读都走这里，漏了就是写进去读不出来。
          memoryMergeWatermark: readMergeWatermark(parsed.memoryMergeWatermark),
          // 上次使用的授权/模型（「新建会话沿用上次选择」）：与可选组同病同治 ——
          // get() 是逐字段重建，漏掉这里就是写进去读不出来 + 下次整存被抹掉。
          lastUsedApprovalMode: toSandboxApprovalMode(parsed.lastUsedApprovalMode),
          lastUsedProfileId: typeof parsed.lastUsedProfileId === 'string' && parsed.lastUsedProfileId
            ? parsed.lastUsedProfileId
            : undefined,
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
      keepAwakeEnabled: false,
      routineRunRetentionDays: 0,
      maxLoopIterations: 50,
      maxParallelSubAgents: 5,
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
    // The previous file is DECODED first: restorePlaceholders' contract is a
    // plaintext-to-plaintext comparison (旧占位符 resolve 后 === 新值 → 恢复)，
    // and a plaintext apiKey in prevRaw must compare with the renderer's
    // plaintext, not with its `enc:v1:` form. Today's field mix happens not to
    // lose data even against ciphertext (placeholders are never encrypted and
    // base64 cannot contain `${`), but that is a coincidence of the character
    // classes, not the contract — decode-first is the honest shape.
    let toWrite: unknown = clean
    try {
      const prevRaw = decodeSecretsDeep(JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')) as unknown)
      toWrite = restorePlaceholders(prevRaw, clean)
    } catch {
      // No previous file (first write) — write as-is
    }
    // Encode LAST: the disk bytes are ciphertext, the tmp file included
    // (rename-over preserves the tmp file's permissions, and the umask from
    // index.ts already keeps that 0600).
    toWrite = encodeSecretsDeep(toWrite)

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
