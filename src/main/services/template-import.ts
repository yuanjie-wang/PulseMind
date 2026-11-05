// ── 模板包导入的纯逻辑（2026-11-05 一次性入口）──
// 无密钥 welcome 引导卡的「导入模板包」：zip 里放整份 settings.json（团队从
// 配置好的机器拷出）+ 可选 skills/。这里只放可单测的纯函数——解压、落盘、
// 广播等 IO 都在 ipc/template.handler.ts。导入语义是整份替换（用户裁定）：
// settingsStore.set 走既有管线（normalizeProviders / restorePlaceholders /
// encodeSecrets opt-in / 派生 profiles 重算），本文件不做字段级合并。

import type { AppSettings, LlmModelConfig, LlmProviderConfig } from '../../shared/types/settings'

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
  const providers = obj.providers
  if (!Array.isArray(providers)) {
    return { error: 'settings.json: "providers" must be an array' }
  }
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

/** `enc:v1:` ciphertext is safeStorage-bound to the machine that wrote it —
 *  it decodes to nothing here (the store DROPS undecryptable values on read),
 *  so importing it silently would hand the user a provider whose key no
 *  longer exists. Warn per affected value; never block the import. */
function looksLikeLocalCiphertext(value: string): boolean {
  return value.startsWith('enc:v1:')
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
  const providers: LlmProviderConfig[] = (input.providers ?? []).map((provider, pi) => {
    const models: LlmModelConfig[] = (provider.models ?? []).map((model) => {
      if (!model.id) warnings.push(`providers[${pi}] 模型 "${model.model}" 缺 id，已自动补铸`)
      return model.id ? model : { ...model, id: mintId('model') }
    })
    if (!provider.id) warnings.push(`供应商 "${provider.name}" 缺 id，已自动补铸`)
    const fixed: LlmProviderConfig = provider.id ? { ...provider, models } : { ...provider, id: mintId('prov'), models }

    if (fixed.apiKey && looksLikeLocalCiphertext(fixed.apiKey)) {
      warnings.push(`供应商 "${fixed.name}" 的密钥是本机加密密文（enc:v1:），无法迁移到新机器，请在设置页重新填写`)
    }
    const cipherHeaders = Object.entries(fixed.headers ?? {}).filter(([, v]) => typeof v === 'string' && looksLikeLocalCiphertext(v))
    for (const [key] of cipherHeaders) {
      warnings.push(`供应商 "${fixed.name}" 的 header "${key}" 是本机加密密文（enc:v1:），无法迁移，请在设置页重新填写`)
    }
    return fixed
  })
  return { settings: { ...input, providers }, warnings }
}
