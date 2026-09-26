// ── LLM connection probe (pure half) ──
// 设置页「测试连接」的纯逻辑：请求构造与 renderer 侧两个 LLM adapter 的
// buildRequest 保持同构（同样的 baseURL 规整、同样的路径拼法），错误翻译
// 把 HTTP 状态码 / 网络错误翻成人话 + 下一步动作。本文件不得 import
// electron / node / DOM API —— main 进程与 vitest 都直接使用它。
//
// 文案为中文硬编码：main 侧既有错误（SSRF 拦截、环境变量未设置等）同为
// 中文直出，探测结果保持同一口径；en 本地化等真实需求出现再做 code 映射。

import type { LLMProvider } from '../types/settings'

export interface LlmProbeInput {
  provider?: LLMProvider
  baseURL?: string
  apiKey?: string
  model?: string
  headers?: Record<string, string>
}

export interface LlmProbeOutcome {
  ok: boolean
  /** Round-trip latency of the probe request, ms. Present on success. */
  latencyMs?: number
  /** 人话结论（成功含模型名与耗时；失败为一句可读的原因）。 */
  message: string
  /** 用户下一步该做什么。 */
  hint?: string
  /** 原始错误/响应体片段，留痕用（tooltip / 控制台）。 */
  detail?: string
}

/** Same normalization as OpenAIAdapter/AnthropicAdapter.buildRequest:
 *  trailing slashes stripped, then the provider path appended. */
export function buildProbeUrl(provider: LLMProvider, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return provider === 'openai' ? `${base}/chat/completions` : `${base}/v1/messages`
}

export function buildProbeHeaders(provider: LLMProvider, apiKey: string): Record<string, string> {
  if (provider === 'openai') {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  }
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-03' }
}

export function buildProbeBody(provider: LLMProvider, model: string): string {
  const payload = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  return JSON.stringify(payload)
}

/** Missing-field guard, shared by the main handler and the renderer's
 *  pre-flight check so both sides give the same answer. */
export function probeMissingFields(input: LlmProbeInput): string | null {
  if (!input.baseURL?.trim()) return 'Base URL'
  if (!input.model?.trim()) return '模型名'
  if (!input.apiKey?.trim()) return 'API Key'
  return null
}

/** HTTP status (plus the response body snippet) → human words. */
export function describeHttpProbeFailure(status: number, bodyText: string): { message: string; hint?: string; detail?: string } {
  const body = bodyText.slice(0, 500)
  const bodyLower = body.toLowerCase()
  switch (true) {
    case status === 401 || status === 403:
      return {
        message: 'API Key 无效或没有访问权限',
        hint: '检查 Key 是否复制完整、是否属于这个服务商，以及是否已开通对应模型的权限',
      }
    case status === 404:
      return {
        message: '接口路径不存在',
        hint: 'OpenAI 兼容端点的 Base URL 通常要以 /v1 结尾（如 https://api.deepseek.com/v1）；也请核对模型名拼写',
      }
    case status === 400 && bodyLower.includes('model'):
      return {
        message: '模型名不存在或当前 Key 无权访问它',
        hint: '到服务商控制台核对模型名（注意区分 claude-3 / claude-sonnet-4 这类前缀）',
      }
    case status === 400:
      return {
        message: '服务商拒绝了这次探测请求',
        hint: 'Base URL 与模型名的组合可能不对；部分中转站对 max_tokens 有额外限制',
        detail: body,
      }
    case status === 429:
      return {
        message: '请求过于频繁或额度不足',
        hint: '网络与 Key 都是通的——连接没问题，请检查套餐额度或稍后再试',
      }
    case status >= 500:
      return {
        message: '服务商服务端错误',
        hint: '服务商侧的问题，稍后重试；如果持续出现，检查该服务商的状态页',
        detail: body,
      }
    default:
      return { message: `服务返回异常状态（HTTP ${status}）`, detail: body }
  }
}

/** fetch rejection → human words. Node's fetch wraps causes
 *  (`cause: Error`), so match against the whole chain's text. */
export function describeNetworkProbeFailure(err: unknown): { message: string; hint?: string; detail?: string } {
  const text = errorChainText(err)
  const t = text.toLowerCase()
  if (/timed?\s*out|timeout|etimedout|aborted/.test(t) || t.includes('socket connection timeout')) {
    return {
      message: '连接超时',
      hint: '检查网络与代理设置；公司网络可能拦截了非 443 端口的直连',
    }
  }
  if (t.includes('enotfound') || t.includes('eai_again') || t.includes('getaddrinfo')) {
    return {
      message: '域名无法解析',
      hint: '检查 Base URL 拼写、本机 DNS 与代理设置（自建域名需先能 ping 通）',
    }
  }
  if (t.includes('econnrefused')) {
    return {
      message: '连接被拒绝',
      hint: '目标主机 reachable 但端口没有服务——核对 Base URL 的端口（本地模型常见于 11434/8080）',
    }
  }
  if (t.includes('econnreset')) {
    return { message: '连接被重置', hint: '多为网络/代理不稳定或服务商暂时不可用，稍后重试' }
  }
  if (t.includes('cert') || t.includes('ssl') || t.includes('tls')) {
    return {
      message: 'HTTPS 证书校验失败',
      hint: '自签名证书或代理劫持都会触发；确认 Base URL 使用可信证书',
    }
  }
  return {
    message: '无法连接到服务',
    hint: '检查网络连接与代理设置',
    detail: text.slice(0, 500),
  }
}

function errorChainText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      cur = undefined
    }
  }
  return parts.join(' | ')
}
