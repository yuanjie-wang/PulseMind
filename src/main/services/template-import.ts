// ── 模板包导入的纯逻辑（2026-11-05 一次性入口）──
// 无密钥 welcome 引导卡的「导入模板包」：zip 里放整份 settings.json（团队从
// 配置好的机器拷出）+ 可选 skills/。这里只放可单测的纯函数——解压、落盘、
// 广播等 IO 都在 ipc/template.handler.ts。导入语义是整份替换（用户裁定）：
// settingsStore.set 走既有管线（normalizeProviders / restorePlaceholders /
// encodeSecrets opt-in / 派生 profiles 重算），本文件不做字段级合并。
//
// 2026-11-10：两种落盘形态都收。权威形态是 providers[]（供应商 → 模型两层，
// 2026-09-25 起），但更早的扁平 profiles[] 存储层读/写两条路都还认（读取时
// 归组、写入时 providersForDisk 的旧格式分支）。模板是从「另一台配置好的机器」
// 拷出来的——那台机器可能还没升级，只认新格式会让旧机器的整份配置导不进来，
// 而跨机器搬运配置正是这个入口存在的理由。

import type { AppSettings, LlmModelConfig, LlmProfile, LlmProviderConfig } from '../../shared/types/settings'

/** 与 LlmSettings.tsx 的手填路径同一铸造惯例（prov_/model_<ts>_<rand>）。 */
function mintId(prefix: 'prov' | 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export interface TemplateSettingsValidation {
  settings?: AppSettings
  error?: string
}

/**
 * Structural gate for the zip's settings.json. The template is authored on
 * another machine, so only the load-bearing provider/model shape is checked —
 * everything else (theme/locale/…) rides along untouched by design (整份替换).
 * Deliberately tolerant: missing optional fields fall back to the store's
 * defaults on the next `get()`.
 */
export function validateTemplateSettings(parsed: unknown): TemplateSettingsValidation {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'settings.json: expected a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.providers)) {
    // 旧扁平格式（见文件头）：没有 providers 但带 profiles 时按旧形态校验，
    // 并原样返回整份对象（theme/locale 等字段同样随模板走）。
    if (Array.isArray(obj.profiles)) return validateLegacyProfiles(obj, obj.profiles)
    return { error: 'settings.json: "providers" must be an array (legacy "profiles" is also accepted)' }
  }
  const providers = obj.providers
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]
    if (p == null || typeof p !== 'object' || Array.isArray(p)) {
      return { error: `settings.json: providers[${i}] must be an object` }
    }
    const provider = p as Record<string, unknown>
    if (typeof provider.name !== 'string' || !provider.name.trim()) {
      return { error: `settings.json: providers[${i}].name is required` }
    }
    if (provider.apiFormat !== 'anthropic' && provider.apiFormat !== 'openai') {
      return { error: `settings.json: providers[${i}].apiFormat must be "anthropic" or "openai"` }
    }
    if (typeof provider.baseURL !== 'string' || !provider.baseURL.trim()) {
      return { error: `settings.json: providers[${i}].baseURL is required` }
    }
    if (!Array.isArray(provider.models)) {
      return { error: `settings.json: providers[${i}].models must be an array` }
    }
    for (let j = 0; j < provider.models.length; j++) {
      const m = provider.models[j]
      if (m == null || typeof m !== 'object' || Array.isArray(m)) {
        return { error: `settings.json: providers[${i}].models[${j}] must be an object` }
      }
      if (typeof (m as Record<string, unknown>).model !== 'string' || !(m as Record<string, unknown>).model) {
        return { error: `settings.json: providers[${i}].models[${j}].model is required` }
      }
    }
  }
  return { settings: parsed as AppSettings }
}

/** 旧扁平 profiles 的结构门：模型名与 baseURL 是硬要求；provider（接口规范）
 *  缺席时存储层按 anthropic 归组（groupLegacyProfiles），所以只有显式写了
 *  非法值才拒。maxTokens 缺席同样放行（模型条目原样透传，服务端默认接管）。 */
function validateLegacyProfiles(obj: Record<string, unknown>, profiles: unknown[]): TemplateSettingsValidation {
  for (let i = 0; i < profiles.length; i++) {
    const raw = profiles[i]
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `settings.json: profiles[${i}] must be an object` }
    }
    const profile = raw as Record<string, unknown>
    if (profile.provider !== undefined && profile.provider !== 'anthropic' && profile.provider !== 'openai') {
      return { error: `settings.json: profiles[${i}].provider must be "anthropic" or "openai"` }
    }
    if (typeof profile.baseURL !== 'string' || !profile.baseURL.trim()) {
      return { error: `settings.json: profiles[${i}].baseURL is required` }
    }
    if (typeof profile.model !== 'string' || !profile.model) {
      return { error: `settings.json: profiles[${i}].model is required` }
    }
  }
  return { settings: obj as unknown as AppSettings }
}

/** `enc:v1:` ciphertext is safeStorage-bound to the machine that wrote it —
 *  it decodes to nothing here (the store DROPS undecryptable values on read),
 *  so importing it silently would hand the user a provider whose key no
 *  longer exists. Warn per affected value; never block the import. */
function looksLikeLocalCiphertext(value: string): boolean {
  return value.startsWith('enc:v1:')
}

/** 密钥/headers 里的本机密文警告（供应商层与旧扁平 profile 共用一份）。 */
function collectCiphertextWarnings(holder: { apiKey?: string; headers?: Record<string, string> }, label: string, warnings: string[]): void {
  if (holder.apiKey && looksLikeLocalCiphertext(holder.apiKey)) {
    warnings.push(`${label} 的密钥是本机加密密文（enc:v1:），无法迁移到新机器，请在设置页重新填写`)
  }
  for (const [key, value] of Object.entries(holder.headers ?? {})) {
    if (typeof value === 'string' && looksLikeLocalCiphertext(value)) {
      warnings.push(`${label} 的 header "${key}" 是本机加密密文（enc:v1:），无法迁移，请在设置页重新填写`)
    }
  }
}

export interface TemplateSanitizeResult {
  settings: AppSettings
  warnings: string[]
}

/**
 * Backfill missing ids (hand-authored templates) and collect ciphertext
 * warnings. Everything else passes through verbatim — the replacement
 * semantics are the point, not a normalization pass.
 */
export function sanitizeTemplateSettings(input: AppSettings): TemplateSanitizeResult {
  const warnings: string[] = []
  if (!Array.isArray((input as { providers?: unknown }).providers)) {
    // 旧扁平格式：只补 id + 收密文警告，**绝不补一个空的 providers** ——
    // 那会让 providersForDisk 走 normalizeProviders([]) 而不是旧格式归组，
    // 整份配置在写盘时被静默清空（providers 缺位正是存储层旧格式的判据）。
    const legacy = input as unknown as { profiles?: LlmProfile[] }
    const profiles: LlmProfile[] = (legacy.profiles ?? []).map((profile, pi) => {
      const fixed: LlmProfile = profile && typeof profile === 'object' ? { ...profile } : ({} as LlmProfile)
      if (!fixed.id) {
        warnings.push(`profiles[${pi}] 模型 "${fixed.model ?? ''}" 缺 id，已自动补铸`)
        fixed.id = mintId('model')
      }
      collectCiphertextWarnings(fixed, `模型 "${fixed.name || fixed.model || pi}"`, warnings)
      return fixed
    })
    return { settings: { ...(input as unknown as Record<string, unknown>), profiles } as unknown as AppSettings, warnings }
  }

  const providers: LlmProviderConfig[] = (input.providers ?? []).map((provider, pi) => {
    const models: LlmModelConfig[] = (provider.models ?? []).map((model) => {
      if (!model.id) warnings.push(`providers[${pi}] 模型 "${model.model}" 缺 id，已自动补铸`)
      return model.id ? model : { ...model, id: mintId('model') }
    })
    if (!provider.id) warnings.push(`供应商 "${provider.name}" 缺 id，已自动补铸`)
    const fixed: LlmProviderConfig = provider.id ? { ...provider, models } : { ...provider, id: mintId('prov'), models }

    collectCiphertextWarnings(fixed, `供应商 "${fixed.name}"`, warnings)
    return fixed
  })
  return { settings: { ...input, providers }, warnings }
}
