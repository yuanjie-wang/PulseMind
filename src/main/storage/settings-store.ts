import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SETTINGS_PATH, DATA_DIR, ensureDataDir } from './index'
import { resolveEnvVarsDeep, resolveEnvVarsInString } from '../../shared/env'
import { toSandboxApprovalMode } from '../../shared/sandbox/policy'
import type { AppSettings, LlmProfile, LlmProviderConfig, LlmModelConfig, LLMProvider } from '../../shared/types/settings'
import type { ProjectSortMode } from '../../shared/types/project'

const DEFAULT_WORKSPACE_DIR = join(DATA_DIR, 'workspace')

/** Provider `headers` and `apiKey` keep raw ${VAR} placeholders: nothing
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

// ── 供应商/模型两层结构（模型配置分层）────────────────────────────────────
// settings.json 的权威形态是 providers[]（连接层：apiFormat/baseURL/apiKey/
// headers 被名下模型共享）+ 嵌套的 models[]（模型层：模型名/maxTokens/
// contextLength 各自设置）。磁盘上**不存在**扁平的 profiles —— 那是 get()
// 在读取时物化的派生视图（每个模型一条，连接字段从所属供应商填入），写入时
// 被丢弃重算。迁移只发生在读取：旧扁平 profiles 按「接口规范+baseURL+apiKey+
// headers」归组成供应商，模型条目**继承旧 profile id**，所以
// conversations.profile_id / lastUsedProfileId / 插件面板选中值等引用不需要
// 任何数据迁移就继续解析。get() 的迁移是幂等纯函数（不写盘）；第一次整存
// 自然把新形态落盘。

/** 常见官方端点 → 供应商展示名（迁移旧 profiles 时给归组结果起名用）。
 *  未命中回落 baseURL 主机名，再回落接口规范的通名。 */
const WELL_KNOWN_PROVIDER_HOSTS: Array<[string, string]> = [
  ['api.anthropic.com', 'Anthropic'],
  ['api.openai.com', 'OpenAI'],
  ['api.deepseek.com', 'DeepSeek'],
  ['api.moonshot.cn', 'Moonshot AI'],
  ['api.moonshot.ai', 'Moonshot AI'],
  ['open.bigmodel.cn', '智谱 AI'],
  ['dashscope.aliyuncs.com', '阿里云百炼'],
  ['api.siliconflow.cn', '硅基流动'],
  ['openrouter.ai', 'OpenRouter'],
  ['api.mistral.ai', 'Mistral'],
  ['api.groq.com', 'Groq'],
  ['api.x.ai', 'xAI'],
]

const PROVIDER_FORMAT_LABELS: Record<LLMProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI Compatible',
}

function providerNameFor(baseURL: string, apiFormat: LLMProvider): string {
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    const known = WELL_KNOWN_PROVIDER_HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`))
    if (known) return known[1]
    if (host) return host
  } catch { /* 不可解析的 URL —— 回落接口规范通名 */ }
  return PROVIDER_FORMAT_LABELS[apiFormat]
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 容错地归一一份 providers（读盘/写盘共用）：形状不对的字段回落默认值，
 *  未知子键保留（与 readGroup 的约定一致，未来加字段不再重演 H1/H2）。 */
function normalizeProviders(raw: unknown): LlmProviderConfig[] {
  if (!Array.isArray(raw)) return []
  const out: LlmProviderConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const p = item as Record<string, unknown>
    const apiFormat: LLMProvider = p.apiFormat === 'openai' ? 'openai' : 'anthropic'
    const baseURL = typeof p.baseURL === 'string' ? p.baseURL : ''
    out.push({
      ...(p as Record<string, unknown>),
      id: typeof p.id === 'string' && p.id ? p.id : randomId('prov'),
      name: typeof p.name === 'string' && p.name ? p.name : providerNameFor(baseURL, apiFormat),
      apiFormat,
      baseURL,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
      headers: p.headers && typeof p.headers === 'object' && !Array.isArray(p.headers)
        ? (p.headers as Record<string, string>)
        : undefined,
      models: normalizeModels(p.models),
    } as LlmProviderConfig)
  }
  return out
}

function normalizeModels(raw: unknown): LlmModelConfig[] {
  if (!Array.isArray(raw)) return []
  const out: LlmModelConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const m = item as Record<string, unknown>
    const entry: Record<string, unknown> = {
      ...(m as Record<string, unknown>),
      id: typeof m.id === 'string' && m.id ? m.id : randomId('model'),
      model: typeof m.model === 'string' ? m.model : '',
      name: typeof m.name === 'string' && m.name ? m.name : undefined,
      maxTokens: typeof m.maxTokens === 'number' && Number.isFinite(m.maxTokens) && m.maxTokens > 0
        ? m.maxTokens
        : 32768,
      contextLength: typeof m.contextLength === 'number' && Number.isFinite(m.contextLength) && m.contextLength > 0
        ? m.contextLength
        : undefined,
      earlyStopGuard: m.earlyStopGuard === true ? true : undefined,
    }
    out.push(entry as unknown as LlmModelConfig)
  }
  return out
}

/** 模型条目上误带的连接/派生字段（渲染端快照脏数据）在写盘前剥掉：
 *  连接字段只属于供应商层，模型条目带了也永远不会被读。 */
const MODEL_DISK_STRIP_KEYS = new Set(['providerId', 'providerName', 'provider', 'baseURL', 'apiKey', 'headers'])

function providersForDisk(settings: Pick<AppSettings, 'providers' | 'profiles'>): LlmProviderConfig[] {
  const providers = Array.isArray((settings as { providers?: unknown }).providers)
    ? normalizeProviders(settings.providers)
    : groupLegacyProfiles((settings.profiles ?? []) as LlmProfile[])
  return providers.map((p) => ({
    ...p,
    models: p.models.map((m) => {
      const entry: Record<string, unknown> = { ...(m as unknown as Record<string, unknown>) }
      for (const k of MODEL_DISK_STRIP_KEYS) delete entry[k]
      return entry as unknown as LlmModelConfig
    }),
  }))
}

/** 旧扁平 profiles → 供应商归组。归组键 = (接口规范, baseURL, apiKey, headers)；
 *  四元组完全一致的 profile 才共用一个供应商，其余各自成组（宁多勿错）。
 *  模型条目继承旧 profile 的 id 与展示名。 */
function groupLegacyProfiles(profiles: LlmProfile[]): LlmProviderConfig[] {
  interface LegacyGroup {
    apiFormat: LLMProvider
    baseURL: string
    apiKey?: string
    headers?: Record<string, string>
    profiles: LlmProfile[]
  }
  const groups = new Map<string, LegacyGroup>()
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue
    const apiFormat: LLMProvider = profile.provider === 'openai' ? 'openai' : 'anthropic'
    const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : ''
    const apiKey = typeof profile.apiKey === 'string' && profile.apiKey ? profile.apiKey : undefined
    const headers = profile.headers && typeof profile.headers === 'object' && Object.keys(profile.headers).length > 0
      ? profile.headers
      : undefined
    const key = JSON.stringify([apiFormat, baseURL, apiKey, headers ? Object.entries(headers).sort() : []])
    const group = groups.get(key)
    if (group) group.profiles.push(profile)
    else groups.set(key, { apiFormat, baseURL, apiKey, headers, profiles: [profile] })
  }
  return [...groups.values()].map((g) => ({
    id: randomId('prov'),
    name: providerNameFor(g.baseURL, g.apiFormat),
    apiFormat: g.apiFormat,
    baseURL: g.baseURL,
    apiKey: g.apiKey,
    headers: g.headers,
    models: g.profiles.map((p) => ({
      id: p.id,
      model: p.model,
      name: p.name,
      maxTokens: p.maxTokens,
      contextLength: p.contextLength,
    })),
  }))
}

/** 派生只读视图：每个模型一条 LlmProfile，连接字段从所属供应商物化。
 *  消费方（引擎/代理/探针/选择器）只读这个形态。 */
function materializeProfiles(providers: LlmProviderConfig[]): LlmProfile[] {
  const out: LlmProfile[] = []
  for (const provider of providers) {
    for (const m of provider.models ?? []) {
      out.push({
        id: m.id,
        name: m.name || m.model,
        providerId: provider.id,
        providerName: provider.name,
        provider: provider.apiFormat,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        headers: provider.headers,
        model: m.model,
        maxTokens: m.maxTokens,
        contextLength: m.contextLength,
        earlyStopGuard: m.earlyStopGuard,
      })
    }
  }
  return out
}

// ── Secrets at rest (PLAN-security-hardening P1) ─────────────────────────
// In memory an AppSettings is ALWAYS plaintext/placeholder; the DISK bytes are
// ciphertext (except ${VAR} placeholders, which are designed to be readable).
// Every consumer — session-manager, api-proxy, the renderer settings editor —
// keeps reading the merged view's apiKey/headers unchanged. The walk touches
// exactly the secret carriers (each provider's apiKey + headers, plus each
// LEGACY profile's — a pre-migration file is decoded before grouping) and the
// settlement webhook's signing secret (notifications.webhookSecret,
// review_20261007 中6).

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
let warnedCiphertextDropped = false

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

/** apiKey/headers 的载荷形状在 provider（供应商层）与 legacy profile（旧扁平
 *  层）上完全一致 —— 一个 walker 走两种数组。 */
function mapSecretCarriers(carriers: unknown[], map: (value: string) => string | undefined): unknown[] {
  return carriers.map((p) => {
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

function mapSettingsSecrets<T>(settings: T, map: (value: string) => string | undefined): T {
  const out = settings as { providers?: unknown; profiles?: unknown; notifications?: unknown }
  const next: Record<string, unknown> = { ...(out as Record<string, unknown>) }
  if (Array.isArray(out?.providers)) next.providers = mapSecretCarriers(out.providers, map)
  if (Array.isArray(out?.profiles)) next.profiles = mapSecretCarriers(out.profiles, map)
  // review_20261007 中6: the settlement webhook's signing secret is a secret
  // like the API keys — it rides the same walk instead of the plaintext bypass
  // the trigger feature shipped with. ${ENV} placeholders stay raw
  // (encryptSecretValue skips them) and restorePlaceholders covers this key
  // through its generic object walk.
  if (out?.notifications && typeof out.notifications === 'object' && !Array.isArray(out.notifications)) {
    const n = out.notifications as Record<string, unknown>
    if (typeof n.webhookSecret === 'string') {
      const mapped = map(n.webhookSecret)
      const nextN: Record<string, unknown> = { ...n }
      if (mapped === undefined) delete nextN.webhookSecret
      else nextN.webhookSecret = mapped
      next.notifications = nextN
    }
  }
  return next as T
}

/** Disk → memory: decode `enc:v1:` values — ONLY when the user opted in.
 *  Flag OFF (the default) means ZERO keychain contact: a ciphertext value is
 *  DROPPED with a re-enter warning instead of being decrypted. decryptString
 *  is synchronous and its securityd prompt once froze the whole app behind a
 *  hidden modal (2026-09-25 black-screen report) — the opt-out must be able
 *  to guarantee that never happens. */
function decodeSecretsDeep<T>(settings: T): T {
  const out = settings as { providers?: unknown; profiles?: unknown; notifications?: unknown; encryptSecrets?: boolean }
  const hasCarriers = Array.isArray(out?.providers) || Array.isArray(out?.profiles) ||
    !!(out?.notifications && typeof out.notifications === 'object' && !Array.isArray(out.notifications))
  if (!hasCarriers) return settings
  if (out.encryptSecrets !== true) {
    let dropped = false
    const cleaned = mapSettingsSecrets(settings, (v) => {
      if (typeof v === 'string' && v.startsWith(ENC_PREFIX)) { dropped = true; return undefined }
      return v
    })
    if (dropped && !warnedCiphertextDropped) {
      warnedCiphertextDropped = true
      console.warn('[settings] encryptSecrets is off but ciphertext values exist — dropped; 请在设置里重新填写 API Key')
    }
    return cleaned
  }
  return mapSettingsSecrets(settings, decryptSecretValue)
}

/** Memory → disk: encrypt non-placeholder secrets — ONLY when the user opted
 *  in (`encryptSecrets: true`, 2026-09-25 ruling: the macOS keychain prompt
 *  is not for everyone, and P0's file permissions carry the default posture).
 *  Existing ciphertext passes through untouched (get() still decodes it, so a
 *  switch-off + one save naturally converts back to plaintext). */
function encodeSecretsDeep<T>(settings: T): T {
  const out = settings as { providers?: unknown; profiles?: unknown; notifications?: unknown; encryptSecrets?: boolean }
  const hasCarriers = Array.isArray(out?.providers) || Array.isArray(out?.profiles) ||
    !!(out?.notifications && typeof out.notifications === 'object' && !Array.isArray(out.notifications))
  if (!hasCarriers) return settings
  if (out.encryptSecrets !== true) return settings
  return mapSettingsSecrets(settings, encryptSecretValue)
}

/** P1 one-time migration: rewrite settings.json whose secrets are still
 *  plaintext (a pre-hardening file, or a key that predates this build). A
 *  no-op identity update drives the whole write path — doSet decodes,
 *  restores placeholders and re-encodes — so the rewrite is the SAME code
 *  every save runs. Idempotent: the second scan finds nothing. */
export async function migrateEncryptedSecrets(): Promise<boolean> {
  // Opt-in gate FIRST — before ANY safeStorage probe (2026-09-25): even
  // isEncryptionAvailable() is a keychain round-trip on macOS, and behind
  // authd it can stall the main thread for a minute or more (measured 63–479s
  // of blocked startup, stack at SecKeychainAddGenericPassword →
  // makeLoginAuthUI). Flag OFF must never reach it — that is the whole point
  // of the switch. get() itself is safe: decodeSecretsDeep's flag-OFF branch
  // drops ciphertext without probing.
  const current = await settingsStore.get()
  if (current.encryptSecrets !== true) return false
  if (!encryptionAvailable()) return false
  let raw: { providers?: Array<Record<string, unknown>>; profiles?: Array<Record<string, unknown>>; notifications?: Record<string, unknown> } | null = null
  try {
    raw = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'))
  } catch {
    return false
  }
  const isPlainSecret = (v: unknown): boolean =>
    typeof v === 'string' && v.length > 0 && !v.startsWith('${') && !v.startsWith(ENC_PREFIX)
  const carrierNeeds = (p: unknown): boolean =>
    !!p && typeof p === 'object' && (
      isPlainSecret((p as SecretCarrier).apiKey) ||
      Object.values(((p as SecretCarrier).headers ?? {}) as Record<string, unknown>).some(isPlainSecret)
    )
  const needs =
    (raw?.providers ?? []).some(carrierNeeds) ||
    (raw?.profiles ?? []).some(carrierNeeds) ||
    // review_20261007 中6: the webhook secret joins the migration's promise —
    // an existing encryptSecrets install with a plaintext secret must not wait
    // for an unrelated save to encrypt it.
    isPlainSecret(raw?.notifications?.webhookSecret)
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

/** LLM 自动重试的附加状态码（AppSettings.llmRetryStatusCodes）：逐元素校验，
 *  只留 400–599 的整数（ok 短路与手动跟跳让 <400 的码永远到不了重试门，
 *  收进配置只会是死条目），去重升序；缺失/非数组/过滤后为空整体回落
 *  undefined = 只用内置默认码表（429 + 5xx）。 */
function readRetryStatusCodes(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = new Set<number>()
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const code = Math.floor(value)
    if (code < 400 || code > 599) continue
    out.add(code)
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : undefined
}

/** 记忆合并水位读取器：形状不对就丢弃（合并层会当作从未合并过，重新
 *  收敛一次——幂等，无害），绝不带病入库。lastAttemptAt 是失败/空尝试的
 *  时钟（空转修复 2026-09-26），与 lastRunAt 一样可选。 */
function readMergeWatermark(raw: unknown): { lastRunAt?: string; lastCount?: number; lastAttemptAt?: string; lastCursorAt?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const out: { lastRunAt?: string; lastCount?: number; lastAttemptAt?: string; lastCursorAt?: string } = {}
  if (typeof w.lastRunAt === 'string' && w.lastRunAt) out.lastRunAt = w.lastRunAt
  if (typeof w.lastCount === 'number' && Number.isFinite(w.lastCount) && w.lastCount >= 0) out.lastCount = w.lastCount
  if (typeof w.lastAttemptAt === 'string' && w.lastAttemptAt) out.lastAttemptAt = w.lastAttemptAt
  if (typeof w.lastCursorAt === 'string' && w.lastCursorAt) out.lastCursorAt = w.lastCursorAt
  return Object.keys(out).length > 0 ? out : undefined
}

const PROJECT_SORT_MODES: readonly ProjectSortMode[] = ['created', 'name', 'activity', 'manual']

function readProjectSortMode(raw: unknown): ProjectSortMode | undefined {
  return PROJECT_SORT_MODES.includes(raw as ProjectSortMode) ? (raw as ProjectSortMode) : undefined
}

/** 快捷键覆盖表（action id → accelerator）：get() 逐字段重建曾漏掉它 ——
 *  写盘成功、菜单永远读默认值、重启后渲染端快照无 shortcuts 导致再次重绑
 *  时把旧覆盖整体抹掉（review 2026-09-26 中1，b84b199 引入即坏）。只保留
 *  string→string 条目；未知 action id 无害保留（effectiveAccelerators 只查
 *  已知 id），非字符串值丢弃。 */
function readShortcutOverrides(raw: unknown): AppSettings['shortcuts'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v
  }
  return Object.keys(out).length > 0 ? (out as AppSettings['shortcuts']) : undefined
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

function readCommandsSettings(group: Record<string, unknown>): { projectInjection: boolean } {
  // 同一 fail-closed 模板（PLAN-coding-contract P1 #22）：缺失/非布尔一律关闭。
  return { ...group, projectInjection: group.projectInjection === true } as { projectInjection: boolean }
}

function readNotificationsSettings(group: Record<string, unknown>): NonNullable<AppSettings['notifications']> {
  return {
    webhookUrl: typeof group.webhookUrl === 'string' && group.webhookUrl.trim() ? group.webhookUrl : undefined,
    webhookSecret: typeof group.webhookSecret === 'string' ? group.webhookSecret : undefined,
    onSettled: group.onSettled !== false,
  }
}

function readKnowledgeSettings(group: Record<string, unknown>): { autoCompile: boolean } {
  return { ...group, autoCompile: group.autoCompile === true } as { autoCompile: boolean }
}

function readNumberOrDrop(group: Record<string, unknown>, key: string): void {
  const value = group[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) delete group[key]
}

function readBrowserSettings(group: Record<string, unknown>): NonNullable<AppSettings['browser']> {
  const out: Record<string, unknown> = { ...group }
  if (out.backend !== 'managed' && out.backend !== 'app-view') delete out.backend
  if (typeof out.headless !== 'boolean') delete out.headless
  readNumberOrDrop(out, 'timeoutMs')
  readNumberOrDrop(out, 'paneWidth')
  return out as NonNullable<AppSettings['browser']>
}

const FALLBACK_SETTINGS: AppSettings = {
  activeProfileId: '',
  providers: [],
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
  maxLoopIterations: 200,
  maxParallelSubAgents: 5,
  debugLlmRequests: false,
  debugPerfLogs: false,
  // 网络代理（抓包调试）：开关缺省开（走不走由开关决定，地址只管填哪），
  // 地址为空 + 严格校验证书 = 默认直连。
  proxyEnabled: true,
  proxyUrl: '',
  proxyStrictSSL: true
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

      // New format: providers/models two-layer (or a legacy flat profiles
      // array, which groups into it below — the read path never rejects an
      // old file, it migrates in memory).
      if (parsed && (Array.isArray(parsed.providers) || Array.isArray(parsed.profiles))) {
        const providers = Array.isArray(parsed.providers)
          ? normalizeProviders(parsed.providers)
          : groupLegacyProfiles(parsed.profiles as LlmProfile[])
        // 派生视图：模型条目继承旧 profile id，所以 activeProfileId /
        // conversations.profile_id 等既有引用原样可用。
        const profiles = materializeProfiles(providers)
        const result: AppSettings = {
          activeProfileId: profiles.length > 0
            ? (profiles.some((p) => p.id === parsed.activeProfileId) ? parsed.activeProfileId : profiles[0].id)
            : '',
          providers,
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
          maxLoopIterations: readIntInRange(parsed.maxLoopIterations, 200, 1, 500),
          maxParallelSubAgents: readIntInRange(parsed.maxParallelSubAgents, 5, 1, 10),
          debugLlmRequests: parsed.debugLlmRequests === true,
          debugPerfLogs: parsed.debugPerfLogs === true,
          // 网络代理（抓包调试，2026-10-27）：URL 原样保留（归一化与校验在
          // 消费点 shared/proxy.parseProxyUrl，读时即最新），开关与证书校验
          // 都缺省开（只有显式 false 才关）。
          proxyEnabled: parsed.proxyEnabled !== false,
          proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl : '',
          proxyStrictSSL: parsed.proxyStrictSSL !== false,
          llmRetryStatusCodes: readRetryStatusCodes(parsed.llmRetryStatusCodes),
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
          memoryExtractIntervalHours:
            typeof parsed.memoryExtractIntervalHours === 'number' && Number.isFinite(parsed.memoryExtractIntervalHours) && parsed.memoryExtractIntervalHours >= 0
              ? parsed.memoryExtractIntervalHours
              : 6,
          memoryPagesMigratedAt: typeof parsed.memoryPagesMigratedAt === 'string' ? parsed.memoryPagesMigratedAt : undefined,
          // 上次记忆提取完成时刻（运行态，主进程 sweep 落笔）：get() 是逐字段
          // 重建，漏了这里就是写进去读不出来 + 下次整存被抹掉（同 last-used）。
          memoryLastSweepAt: typeof parsed.memoryLastSweepAt === 'string' ? parsed.memoryLastSweepAt : undefined,
          memoryCompileWatermark: readMergeWatermark(parsed.memoryCompileWatermark),
          // 上次使用的授权/模型（「新建会话沿用上次选择」）：与可选组同病同治 ——
          // get() 是逐字段重建，漏掉这里就是写进去读不出来 + 下次整存被抹掉。
          lastUsedApprovalMode: toSandboxApprovalMode(parsed.lastUsedApprovalMode),
          lastUsedProfileId: typeof parsed.lastUsedProfileId === 'string' && parsed.lastUsedProfileId
            ? parsed.lastUsedProfileId
            : undefined,
          shortcuts: readShortcutOverrides(parsed.shortcuts),
          git: readGroup(parsed.git, readGitSettings),
          commands: readGroup(parsed.commands, readCommandsSettings),
          knowledge: readGroup(parsed.knowledge, readKnowledgeSettings),
          browser: readGroup(parsed.browser, readBrowserSettings),
          // 例行结算 webhook（PLAN-routine-triggers M1）：url/secret 逐字保留
          // （${ENV} 占位符在发送时解析，与供应商密钥同惯例），onSettled 缺省开。
          notifications: readGroup(parsed.notifications, readNotificationsSettings),
        }
        cache = { mtimeMs: stats.mtimeMs, settings: result }
        return structuredClone(result)
      }

      // Old format: migrate single profile to the two-layer format
      const migrated = this.migrate(parsed)
      cache = { mtimeMs: stats.mtimeMs, settings: migrated }
      return structuredClone(migrated)
    } catch {
      return { ...FALLBACK_SETTINGS }
    }
  }

  /**
   * Migrate from the pre-profiles single-profile format. The profile lands in
   * the same two-layer shape everything else reads.
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
    const providers = groupLegacyProfiles([profile])

    return {
      activeProfileId: 'default',
      providers,
      profiles: materializeProfiles(providers),
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
      maxLoopIterations: 200,
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
    // 派生的 profiles 不落盘：供应商层是唯一权威，模型条目上误带的连接字段
    // 一并剥掉（providersForDisk；快照缺 providers 时按旧 profiles 归组救回）。
    // Strip legacy outputDir key, write as workspaceDir only
    const { outputDir: _legacy, ...rest } = settings as unknown as Record<string, unknown>
    delete rest.profiles
    const canonical: Record<string, unknown> = { ...rest, providers: providersForDisk(settings) }

    // The renderer holds RESOLVED values (env placeholders already replaced),
    // so a naive write would persist the concrete value and permanently destroy
    // ${VAR} placeholders. Restore the original placeholder wherever the incoming
    // value still matches the resolved placeholder from the previous file.
    // The previous file is DECODED first: restorePlaceholders' contract is a
    // plaintext-to-plaintext comparison (旧占位符 resolve 后 === 新值 → 恢复)，
    // and a plaintext apiKey in prevRaw must compare with the renderer's
    // plaintext, not with its `enc:v1:` form. A pre-two-layer previous file is
    // grouped into the provider shape first, so the per-field comparison has a
    // counterpart on the format boundary (the first save after a migration).
    let toWrite: unknown = canonical
    try {
      const prevRaw = decodeSecretsDeep(JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')) as unknown) as Record<string, unknown>
      // 注意 providers 传 undefined（不是 []）—— providersForDisk 靠它的缺位
      // 才会走旧 profiles 的归组分支。
      const prevCanonical: Record<string, unknown> = Array.isArray(prevRaw?.providers)
        ? prevRaw
        : { ...prevRaw, providers: providersForDisk({ profiles: (prevRaw?.profiles ?? []) as LlmProfile[] } as AppSettings) }
      toWrite = restorePlaceholders(prevCanonical, canonical)
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

/**
 * Tri-state read of one raw boolean flag straight from settings.json: true or
 * false when the key is present, null when it is absent (or the file is
 * unreadable). `get()` normalizes an absent key to its default, which erases
 * "the user never touched this" — readers whose default differs by build (the
 * request dump is ON in dev until the settings switch is used) need that
 * distinction and read it here. One small file read per call; callers sit on
 * the per-request diagnostic path, not a hot loop.
 */
export async function readRawBooleanFlag(key: string): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const value = (parsed as Record<string, unknown>)[key]
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

export const settingsStore = new SettingsStore()
