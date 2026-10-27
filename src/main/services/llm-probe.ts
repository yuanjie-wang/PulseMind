// ── LLM connection probe (main side) ──
// 设置页「测试连接」的实现：对用户配置的 provider 发一次最小的非流式请求
// （max_tokens: 1），把结果翻成人话。刻意不走 performLlmStream：
//   - 探测要快、要一次到位（无 20 次重试，无 SSE 泵）；
//   - 不跑 llm-request hook（hook 是给真实对话用的，探测不该被它改写）；
//   - 不落请求转储（msgs=1 的探测文件只会淹没 llm-requests 目录）。
// 头部合并与 SSRF 校验复用 api-proxy 的同一路径，所以探测通过的配置与
// 真实对话用的配置是同一条。

import { settingsStore } from '../storage/settings-store'
import { resolveEnvVarsInString, findUnresolvedEnvVar } from '../../shared/env'
import { ensureLaunchHooks } from '../hooks-runner'
import {
  buildProbeBody,
  buildProbeHeaders,
  buildProbeUrl,
  describeHttpProbeFailure,
  describeNetworkProbeFailure,
  probeMissingFields,
  type LlmProbeInput,
  type LlmProbeOutcome,
} from '../../shared/llm/probe'
import { applyProfileHeaders, validateRequestUrl } from '../ipc/api-proxy.handler'
import { withProxyDispatcher } from '../utils/proxy'

const PROBE_TIMEOUT_MS = 15_000

export type { LlmProbeInput, LlmProbeOutcome }

export async function testLlmConnection(input: LlmProbeInput & { profileId?: string }): Promise<LlmProbeOutcome> {
  // The ${ENV} resolution below must see what a real request would see, and a
  // variable provided by hooks/app-start.js only exists once the launch hooks
  // have run — since they overlap the window boot (61acf04), a cold start can
  // reach 「测试连接」 while the hook is still on its way. Gate here, at the
  // ONE place every ${ENV} placeholder resolves (this stays the launch-hook
  // gate only; the llm-request hook deliberately never touches a probe).
  await ensureLaunchHooks()
  // A profileId resolves against the SAVED profile; inline fields test
  // unsaved edits in the settings drawer. Inline wins when both are given.
  let provider = input.provider
  let baseURL = input.baseURL
  let model = input.model
  let apiKey = input.apiKey
  let headers = input.headers
  if (input.profileId) {
    const settings = await settingsStore.get()
    const profile = settings.profiles.find((p) => p.id === input.profileId)
    if (profile) {
      provider = provider ?? profile.provider
      baseURL = baseURL ?? profile.baseURL
      model = model ?? profile.model
      apiKey = apiKey ?? profile.apiKey
      headers = headers ?? profile.headers
    }
  }
  provider = provider ?? 'anthropic'

  const missing = probeMissingFields({ baseURL, model, apiKey })
  if (missing) {
    return { ok: false, message: `配置不完整：缺少 ${missing}`, hint: '填好 Base URL、模型名和 API Key 后再测试' }
  }
  baseURL = baseURL!.trim()
  model = model!.trim()

  // ${ENV} placeholders resolve here exactly as they do for real requests —
  // an unresolved one means the env var is unset, which is the finding.
  const resolvedKey = resolveEnvVarsInString(apiKey!)
  const unresolved = findUnresolvedEnvVar(resolvedKey)
  if (unresolved) {
    return {
      ok: false,
      message: `环境变量 ${unresolved} 未设置`,
      hint: `API Key 引用了 \${${unresolved}}，请在系统环境变量或 hooks/app-start.js 里提供它`,
    }
  }

  const url = buildProbeUrl(provider, baseURL)
  try {
    await validateRequestUrl(url)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '地址被安全策略拦截', detail: String(e) }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), PROBE_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    // Defaults first, then the user's custom headers over them — inline edits
    // win over the saved profile (applyProfileHeaders' profileId merge runs on
    // top and is case-insensitive).
    const mergedHeaders = await applyProfileHeaders(
      { ...buildProbeHeaders(provider, resolvedKey), ...(headers ?? {}) },
      {
        profileId: input.profileId,
      },
    )
    const response = await fetch(
      url,
      await withProxyDispatcher({
        method: 'POST',
        headers: mergedHeaders,
        body: buildProbeBody(provider, model),
        signal: controller.signal,
      }),
    )
    const latencyMs = Date.now() - t0
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const { message, hint } = describeHttpProbeFailure(response.status, bodyText)
      console.log(`[LlmProbe] HTTP ${response.status} for ${url}: ${bodyText.slice(0, 200)}`)
      return { ok: false, latencyMs, message, hint, detail: bodyText.slice(0, 500) }
    }
    return {
      ok: true,
      latencyMs,
      message: `连接成功 · ${model} · ${latencyMs}ms`,
      hint: 'Key、地址与模型名都有效',
    }
  } catch (err) {
    const { message, hint, detail } = describeNetworkProbeFailure(err)
    return { ok: false, message, hint, detail }
  } finally {
    clearTimeout(timer)
  }
}
