// ── LLM connection probe (main side) ──
// 设置页「测试连接」的实现：对用户配置的 provider 发一次最小的非流式请求
// （max_tokens: 1），把结果翻成人话。刻意不走 performLlmStream：
//   - 探测要快、要一次到位（无 20 次重试，无 SSE 泵）；
//   - 不落请求转储（msgs=1 的探测文件只会淹没 llm-requests 目录）。
// llm-request hook 照跑（2026-11-02 用户裁定，翻转此前「探测不该被 hook 改写」
// 的设计）：hook 注入的头/体是真实请求的一部分，探测不跑就验证不到它。
// requestId 带 `probe-` 前缀，hook 脚本可据此跳过计数/外部签名等副作用；
// hook 改写了 url 就把 SSRF 校验重跑一遍——首轮校验的是改写前的地址。
// 头部合并与 SSRF 校验复用 api-proxy 的同一路径，所以探测通过的配置与
// 真实对话用的配置是同一条。

import { randomUUID } from 'node:crypto'
import { settingsStore } from '../storage/settings-store'
import { resolveEnvVarsInString, findUnresolvedEnvVar } from '../../shared/env'
import { ensureLaunchHooks } from '../hooks-runner'
import { applyLlmRequestHook } from '../llm-hook'
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
// The llm-request hook gets its OWN, shorter deadline (review_20261103 中7):
// the 15s timer above only feeds fetch's abort signal — a hook that hangs kept
// the settings spinner spinning forever, and one that returned after 15s fed
// an already-aborted signal to fetch, which describeNetworkProbeFailure then
// blamed on the network. A user script awaiting an external signing service is
// exactly the shape this guards; the deadline must be strictly inside the
// probe's own budget so a slow hook is reported AS a slow hook.
const HOOK_DEADLINE_MS = 10_000

export type { LlmProbeInput, LlmProbeOutcome }

/** SSRF 校验翻成探测结果；通过返回 null。首轮校验改写前的 url，hook 改写后再跑一次。 */
async function guardProbeUrl(url: string): Promise<LlmProbeOutcome | null> {
  try {
    await validateRequestUrl(url)
    return null
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '地址被安全策略拦截', detail: String(e) }
  }
}

export async function testLlmConnection(
  input: LlmProbeInput & { profileId?: string },
  /** The hook deadline lives here only so the timeout branch is drivable at
   *  test speed; production callers (the IPC handler) never pass it. */
  opts?: { hookDeadlineMs?: number },
): Promise<LlmProbeOutcome> {
  // The ${ENV} resolution below must see what a real request would see, and a
  // variable provided by hooks/app-start.js only exists once the launch hooks
  // have run — since they overlap the window boot (61acf04), a cold start can
  // reach 「测试连接」 while the hook is still on its way. Gate here, at the
  // ONE place every ${ENV} placeholder resolves (launch-hook gate only; the
  // llm-request hook runs later, over the assembled request).
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
  const blocked = await guardProbeUrl(url)
  if (blocked) return blocked

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), PROBE_TIMEOUT_MS)
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
    // llm-request hook, same seam as api-proxy: the hook sees the parsed body
    // and may override url/headers/body; a failing hook leaves the bytes
    // untouched. `probe-` prefix = the hook's own discriminator. Raced against
    // the hook's own deadline (see HOOK_DEADLINE_MS): applyLlmRequestHook has
    // no timeout of its own, and the probe is a user-facing synchronous action.
    const probeBody = buildProbeBody(provider, model)
    const hookDeadlineMs = opts?.hookDeadlineMs ?? HOOK_DEADLINE_MS
    let hookTimedOut = false
    const hookDeadline = new Promise<{ url: string; headers: Record<string, string> | undefined; body: unknown }>((resolve) => {
      setTimeout(() => {
        hookTimedOut = true
        resolve({ url, headers: mergedHeaders, body: probeBody })
      }, hookDeadlineMs)
    })
    const hookApplied = await Promise.race([
      applyLlmRequestHook(url, mergedHeaders, probeBody, {
        profileId: input.profileId,
        requestId: `probe-${randomUUID().slice(0, 8)}`,
      }),
      hookDeadline,
    ])
    if (hookTimedOut) {
      return {
        ok: false,
        message: `llm-request hook 超时（${hookDeadlineMs / 1000}s 未返回）`,
        hint: `hooks/llm-request.js 在 ${hookDeadlineMs / 1000}s 内没有返回——检查脚本里是否有阻塞的外部调用；修复或临时移走该脚本后重试`,
      }
    }
    if (hookApplied.url !== url) {
      const rewriteBlocked = await guardProbeUrl(hookApplied.url)
      if (rewriteBlocked) return rewriteBlocked
    }
    const finalBody = typeof hookApplied.body === 'string' ? hookApplied.body : JSON.stringify(hookApplied.body)
    // Latency measures the wire, not the hook.
    const t0 = Date.now()
    const response = await fetch(
      hookApplied.url,
      await withProxyDispatcher({
        method: 'POST',
        headers: hookApplied.headers,
        body: finalBody,
        signal: controller.signal,
      }),
    )
    const latencyMs = Date.now() - t0
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      const { message, hint } = describeHttpProbeFailure(response.status, bodyText)
      console.log(`[LlmProbe] HTTP ${response.status} for ${hookApplied.url}: ${bodyText.slice(0, 200)}`)
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
