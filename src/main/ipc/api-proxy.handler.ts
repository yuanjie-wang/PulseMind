import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'
import { isPrivateHost } from '../utils/ssrf'
import { applyLlmRequestHook } from '../llm-hook'
import { dumpLlmRequest, dumpLlmResponse } from '../llm/request-dump'
import { ensureLaunchHooks } from '../hooks-runner'
import { resolveEnvVarsInString, findUnresolvedEnvVar } from '../../shared/env'
import { withProxyDispatcher, ProxyConfigError } from '../utils/proxy'

/**
 * Resolve ${VAR_NAME} patterns in a string using environment variables.
 * If the variable is not set, the original placeholder is kept so the API
 * error message will hint at the missing variable.
 */

interface ApplyProfileHeadersOptions {
  /**
   * Only LLM requests should carry the profile's custom headers. Generic
   * fetches (e.g. the webfetch tool, which can hit arbitrary public URLs)
   * must never leak credentials like Authorization / x-api-key.
   */
  mergeProfileHeaders?: boolean
  /**
   * Profile id captured by the renderer when it froze the apiKey/baseURL
   * for a request loop. Merging headers from the *then-active* profile keeps
   * headers and credentials in sync even if the user switches profiles
   * mid-loop. Falls back to URL matching (below), then the currently active
   * profile when omitted.
   */
  profileId?: string
  /**
   * The request's target URL. One-shot calls (title, history summary, session
   * review, memory extraction — the `callNonStreaming` path) never know a
   * profileId, and the active profile is not necessarily the provider they
   * post to: conv_20260927170026's summarizer calls hit the OpenCode gateway
   * while the global default was another provider, got that provider's headers
   * (i.e. no `x-opencode-session`), and the gateway 400'd every one of them —
   * byte-identical retry pairs in logs/llm-requests, and a history summary
   * that never once landed. When present, the URL is matched against each
   * profile's baseURL BEFORE the active-profile fallback, so headers follow
   * the provider actually being posted to.
   */
  url?: string
}

/** True when the request URL lives under the profile's baseURL (path-boundary
 *  aligned, trailing slashes ignored): `…/v1/chat/completions` matches `…/v1`
 *  but not `…/v11`. */
export function urlMatchesProfileBaseURL(requestUrl: string, baseURL: string): boolean {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (!base) return false
  const url = requestUrl.trim().replace(/\/+$/, '')
  return url === base || url.startsWith(`${base}/`)
}

/**
 * Resolve env vars in the request headers, then merge a profile's custom
 * headers over them (custom wins). Values may reference ${ENV_VAR}.
 * Blank-value headers are skipped so an empty UI row never clobbers a default.
 * Merging is case-insensitive: a custom `authorization` replaces an existing
 * `Authorization` instead of sending both headers.
 *
 * This is the ONE place every ${ENV} placeholder resolves (LLM streams, simple
 * fetches, llm-probe), so it gates on the launch hooks: hooks run concurrently
 * with window creation now, and a first request racing an unfinished hook
 * would otherwise resolve `${VAR}` against a process.env the hook hasn't
 * populated yet and fail fast on a variable that was about to exist.
 */
export async function applyProfileHeaders(
  headers?: Record<string, string>,
  opts: ApplyProfileHeadersOptions = {},
): Promise<Record<string, string> | undefined> {
  await ensureLaunchHooks()
  const base: Record<string, string> = headers ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolveEnvVarsInString(v)])) : {}
  let result: Record<string, string> | undefined
  if (opts.mergeProfileHeaders === false) {
    result = Object.keys(base).length ? base : headers
  } else {
    const settings = await settingsStore.get()
    // Resolution order: explicit profileId (a loop's frozen binding) → the
    // profile that owns the request URL (one-shot calls have no profileId and
    // must follow the provider they post to) → the global default. When
    // several providers sit on one host, the LONGEST baseURL wins — the more
    // specific path prefix is the provider the URL actually belongs to.
    const urlMatched = opts.url
      ? settings.profiles
          .filter((p) => urlMatchesProfileBaseURL(opts.url!, p.baseURL ?? ''))
          .sort((a, b) => (b.baseURL ?? '').length - (a.baseURL ?? '').length)[0]
      : undefined
    const profile =
      (opts.profileId ? settings.profiles.find((p) => p.id === opts.profileId) : undefined) ??
      urlMatched ??
      settings.profiles.find((p) => p.id === settings.activeProfileId)
    if (!profile?.headers) {
      result = Object.keys(base).length ? base : headers
    } else {
      const seen = new Map<string, string>() // lowercase header name -> actual key in `base`
      for (const k of Object.keys(base)) seen.set(k.toLowerCase(), k)
      for (const [k, v] of Object.entries(profile.headers)) {
        if (!v.trim()) continue
        const existingKey = seen.get(k.toLowerCase())
        if (existingKey && existingKey !== k) {
          delete base[existingKey]
          seen.delete(k.toLowerCase())
        }
        base[k] = resolveEnvVarsInString(v)
        seen.set(k.toLowerCase(), k)
      }
      result = base
    }
  }
  // A placeholder that survived resolution means its env var is unset. Sending
  // it as-is would leak `${VAR}` to the API as broken credentials — fail fast
  // with a message naming the variable instead.
  if (result) {
    for (const [k, v] of Object.entries(result)) {
      const missing = findUnresolvedEnvVar(v)
      if (missing) throw new Error(`环境变量 ${missing} 未设置（请求头 ${k} 引用的 \${${missing}} 无法解析，请检查 hooks/app-start.js 或系统环境变量）`)
    }
  }
  return result
}

/** Verify the request URL is not an SSRF attempt against the user's configured API host. */
export async function validateRequestUrl(requestUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    throw new Error(`无效 URL: ${requestUrl.slice(0, 100)}`)
  }

  if (!(await isPrivateHost(parsed.hostname))) return // public IP — safe

  // Private IP — only allow if the user's configured baseURL also points to one (local LLM)
  const settings = await settingsStore.get()
  const activeProfile = settings.profiles.find((p) => p.id === settings.activeProfileId)
  if (activeProfile?.baseURL) {
    try {
      const baseParsed = new URL(activeProfile.baseURL)
      if (baseParsed.hostname === parsed.hostname) return // same host as configured — allow
    } catch {
      /* ignore parse failures */
    }
  }
  throw new Error(`SSRF 拦截: 目标地址 ${parsed.hostname} 为内网 IP，且非 LLM 配置地址`)
}

interface PendingRequest {
  controller: AbortController
  url: string
}

const pendingRequests = new Map<string, PendingRequest>()

function getSender(event: Electron.IpcMainInvokeEvent): Electron.WebContents {
  return BrowserWindow.fromWebContents(event.sender)?.webContents ?? event.sender
}

/** The built-in retryable set: rate limiting plus any 5xx. `extraCodes`
 *  extends it with user-configured codes (settings `llmRetryStatusCodes`) —
 *  additive, never replacing the defaults. Codes below 400 never reach here:
 *  `response.ok` short-circuits 2xx and redirects are followed manually inside
 *  the fetch, so the configured domain is 400–599 (mirrors the settings
 *  reader's normalization). */
export function isRetryable(status: number, extraCodes?: number[]): boolean {
  if (status === 429 || (status >= 500 && status < 600)) return true
  return extraCodes?.includes(status) ?? false
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Per-attempt cap: DNS/TLS/request-write/response-headers must land within
 *  CONNECT_TIMEOUT_MS or the attempt aborts with a distinguishable error.
 *  The 60s idle watchdog below only arms AFTER `fetch()` resolves — before
 *  that line a black-holed connection awaited forever with no socket-level
 *  timeout to save it (conv_20260930091135: two sub-agents parked mid-plan on
 *  exactly such an await, no error, no done, for hours). The inner controller
 *  keeps the outer signal's cancel semantics intact: a user/entry abort still
 *  kills the attempt mid-flight, and an attempt timeout propagates as a
 *  retriable network error through fetchWithRetry's normal retry loop. */
const CONNECT_TIMEOUT_MS = 120_000

export async function fetchWithAttemptTimeout(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted')
  const attemptController = new AbortController()
  const abortFromOuter = () => attemptController.abort(signal?.reason)
  signal?.addEventListener('abort', abortFromOuter, { once: true })
  const timer = setTimeout(() => attemptController.abort(new Error(`Connect timeout: no response headers within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
  try {
    // SSRF 重定向复检（full_20261011 P1#4）：validateRequestUrl 只判初始
    // host，默认 redirect:'follow' 会把 302 → 内网地址整体带过分类器。手动
    // 逐跳，跳>0 时按首跳同一策略重新校验（公网直过；私网仅当与配置 baseURL
    // 同 host）。body 是完整字符串，重发无损；跳数封顶 5。
    let current = url
    let res: Response
    for (let hop = 0; ; hop++) {
      if (hop > 0) await validateRequestUrl(current)
      if (hop >= 5) throw new Error('SSRF 拦截: 重定向次数超过上限')
      res = await fetch(
        current,
        await withProxyDispatcher({
          method: options.method || 'POST',
          headers: { ...options.headers },
          body: options.body,
          signal: attemptController.signal,
          redirect: 'manual',
        }),
      )
      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).href
        continue
      }
      break
    }
    return res
  } finally {
    clearTimeout(timer)
    // The outer-signal link deliberately stays attached past the headers: the
    // body stream runs on the attempt controller, so the 60s idle abort and a
    // user/entry cancel must still reach it. Unlinking here (the tempting
    // finally) would orphan the body — an idle abort would stop breaking
    // reader.read() and the stream would hang again. The listener dies with
    // the request's controllers; no unbounded accumulation.
  }
}

async function fetchWithRetry(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
  maxRetries = 20,
  onRetry?: (attempt: number, reason: string) => void,
  extraRetryCodes?: number[],
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchWithAttemptTimeout(url, options, signal, CONNECT_TIMEOUT_MS)
      if (response.ok || !isRetryable(response.status, extraRetryCodes) || attempt >= maxRetries) {
        return response
      }
      const delay = (attempt + 5) * 1000
      console.log(`[API-Proxy] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (HTTP ${response.status})`)
      onRetry?.(attempt + 1, `HTTP ${response.status}`)
      await sleep(delay)
    } catch (err) {
      // Don't retry aborted requests (user cancellation)
      if (signal?.aborted) throw err
      // 代理配置无效是确定性错误——同一个拼写错误重试 20 次只会把一次失败
      // 放大成几分钟的退避停顿；立即失败，话术自己教修正（shared/proxy）。
      if (err instanceof ProxyConfigError) throw err
      // Network error (ECONNRESET, ETIMEDOUT, ECONNREFUSED, DNS, TLS…) — retry
      if (attempt >= maxRetries) throw err
      const delay = (attempt + 5) * 1000
      console.log(`[API-Proxy] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (${err instanceof Error ? err.message : 'Unknown'})`)
      onRetry?.(attempt + 1, err instanceof Error ? err.message : '网络错误')
      await sleep(delay)
    }
  }
}

export interface LlmStreamSinks {
  onError(message: string): void
  onRetry(attempt: number, maxRetries: number, delayMs: number, message: string): void
  onChunk(text: string): void
  onDone(): void
}

export interface LlmStreamOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | object
  profileId?: string
}

/** The response dump's capture cap: a runaway generation stops being recorded
 *  (the log line says TRUNCATED) instead of ballooning the request path. */
const RESPONSE_DUMP_MAX_CHARS = 20 * 1024 * 1024

/**
 * Transport for one streaming LLM request (PLAN-0.3.5 M1.4): validate SSRF →
 * merge profile headers (env placeholders resolved) → llm-request hook → fetch
 * with retry → SSE chunk pump with idle timeout. Transport-agnostic: the IPC
 * handler bridges sinks to the requesting webContents; the main-process agent
 * host passes callback sinks so the engine consumes chunks in-process.
 */
export async function performLlmStream(
  requestId: string,
  url: string,
  options: LlmStreamOptions,
  sinks: LlmStreamSinks,
  controller: AbortController,
  maxRetries = 20,
): Promise<void> {
  try {
    await validateRequestUrl(url)
  } catch (e) {
    sinks.onError(e instanceof Error ? e.message : 'SSRF 拦截')
    return
  }

  pendingRequests.set(requestId, { controller, url })

  console.log(`[API-Proxy] Starting request: ${requestId} ${options.method || 'POST'} ${url}`)

  const retryCb = (attempt: number, reason: string) => {
    const delay = (attempt + 4) * 1000
    sinks.onRetry(attempt, maxRetries, delay, `${reason}，正在重试 (${attempt}/${maxRetries})…`)
  }

  // Response capture for the dump, declared across the try/catch: a stream
  // that dies midway still writes what arrived, paired with its request dump.
  let requestDumpFile: string | null = null
  const responseCapture = { body: '', truncated: false }
  let responseDumpWritten = false
  const writeResponseDump = async (status: string): Promise<void> => {
    if (responseDumpWritten) return
    responseDumpWritten = true
    await dumpLlmResponse({ requestId, requestFile: requestDumpFile, status, body: responseCapture.body, truncated: responseCapture.truncated })
  }

  try {
    // Stringify body in main process so the renderer isn't blocked on large JSON.
    const body = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
    const mergedHeaders = await applyProfileHeaders(options.headers, { profileId: options.profileId, url })
    // 附加重试码表按请求读取（mtime 缓存的 store）——改完设置对下一次请求生效，
    // 与 dump 门同款语义；缓存命中时这是一次纯内存读。
    const extraRetryCodes = (await settingsStore.get()).llmRetryStatusCodes
    // llm-request hook: the streaming channel is LLM-only (AgentEngine loop +
    // OpenAIAdapter.callNonStreaming). webfetch goes through the simple fetch
    // handler, so every request here is an LLM request — always run the hook.
    const hookApplied = await applyLlmRequestHook(url, mergedHeaders, body, {
      profileId: options.profileId,
      requestId,
    })
    const finalUrl = hookApplied.url
    const finalBody = typeof hookApplied.body === 'object' ? JSON.stringify(hookApplied.body) : (hookApplied.body as string | undefined)
    const finalHeaders = hookApplied.headers
    const resolvedOptions: { method?: string; headers?: Record<string, string>; body?: string } = {
      ...options,
      body: finalBody,
      headers: finalHeaders,
    }
    // Full request dump (dev: always, packaged: `debugLlmRequests`). Placed here
    // on purpose — this is the last point where url/headers/body are the bytes
    // that go out, after the hook and after profile headers were merged.
    requestDumpFile = await dumpLlmRequest({
      requestId,
      url: finalUrl,
      method: resolvedOptions.method || 'POST',
      headers: finalHeaders,
      body: resolvedOptions.body || '',
    })
    const response = await fetchWithRetry(finalUrl, resolvedOptions, controller.signal, maxRetries, retryCb, extraRetryCodes)

    console.log(`[API-Proxy] Response status: ${response.status} for ${requestId}`)

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error')
      responseCapture.body = errText
      await writeResponseDump(String(response.status))
      // Dump full request body for debugging 400 errors
      try {
        const reqBody = JSON.parse(resolvedOptions.body || '{}')
        const msgs = (reqBody.messages || []).map((m: any, i: number) => {
          const content = m.content
          const contentStr = typeof content === 'string' ? JSON.stringify(content) : JSON.stringify(content)
          return `${i}:${m.role} content=${contentStr} len=${typeof content === 'string' ? content.length : '?'} tool_calls=${m.tool_calls?.length ?? 0}${m.tool_calls ? ' calls=[' + m.tool_calls.map((tc: any) => `${tc.function?.name || '?'}(${(tc.function?.arguments || '').length})`).join(',') + ']' : ''}`
        })
        console.error(`[API-Proxy] HTTP ${response.status} full messages:`, msgs.join('\n  '))
      } catch {
        /* ignore parse error */
      }
      sinks.onError(`HTTP ${response.status}: ${errText.slice(0, 1000)}`)
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      sinks.onError('No response body')
      return
    }

    const decoder = new TextDecoder()

    // Idle timeout: if no data received for 60 seconds, abort the stream.
    // Prevents the app from freezing when the TCP connection hangs
    // after macOS sleep/resume or other network interruptions.
    let readTimeout: ReturnType<typeof setTimeout> | undefined
    function resetReadTimeout(): void {
      clearTimeout(readTimeout)
      readTimeout = setTimeout(() => {
        controller.abort(new Error('Stream idle timeout'))
      }, 60_000)
    }
    resetReadTimeout()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetReadTimeout()
        const text = decoder.decode(value, { stream: true })
        // The dump captures the stream verbatim as the renderer receives it;
        // past the cap it stops capturing (the log line says TRUNCATED) while
        // the stream itself is untouched.
        if (responseCapture.body.length < RESPONSE_DUMP_MAX_CHARS) {
          responseCapture.body += text.slice(0, RESPONSE_DUMP_MAX_CHARS - responseCapture.body.length)
          if (responseCapture.body.length >= RESPONSE_DUMP_MAX_CHARS) responseCapture.truncated = true
        }
        sinks.onChunk(text)
      }
    } finally {
      clearTimeout(readTimeout)
    }

    sinks.onDone()
    await writeResponseDump(String(response.status))
    console.log(`[API-Proxy] Stream complete: ${requestId}`)
  } catch (err) {
    // Whatever killed the stream, the bytes that did arrive still go to the
    // dump — an aborted or timed-out response is exactly what one wants to
    // read. Nothing received yet skips inside dumpLlmResponse (empty body).
    await writeResponseDump(controller.signal.aborted ? 'aborted' : 'interrupted')
    if (controller.signal.aborted) {
      const isTimeout = controller.signal.reason instanceof Error && controller.signal.reason.message === 'Stream idle timeout'
      if (isTimeout) {
        console.log(`[API-Proxy] Stream idle timeout: ${requestId}`)
        sinks.onError('连接闲置超时，请重试')
      } else {
        // External abort (sleep/resume cancelAllRequests, entry teardown):
        // report ERROR, not done (PLAN-parallel-experts T11) — a `done` lets
        // the engine finalize a half-received response as a normal turn. The
        // renderer's own user-stop path sets isCancelled before aborting and
        // swallows this error in its catch.
        console.log(`[API-Proxy] Request aborted: ${requestId}`)
        sinks.onError('Request aborted')
      }
      return
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    const detail = err instanceof Error && err.cause ? ` | cause: ${err.cause}` : ''
    console.error(`[API-Proxy] Request error: ${requestId} - ${message}${detail}`)
    sinks.onError(`${message}${detail}`)
  } finally {
    pendingRequests.delete(requestId)
  }
}

export function registerApiProxyHandlers(): void {
  // Start a proxied streaming HTTP request — bridges performLlmStream sinks to
  // the requesting renderer's webContents.
  ipcMain.handle(IPC_CHANNELS.API_FETCH_STREAM, async (event, requestId: string, url: string, options: LlmStreamOptions) => {
    const webContents = getSender(event)
    const guard = (send: () => void) => {
      if (!webContents.isDestroyed()) {
        try {
          send()
        } catch {
          /* renderer frame disposed */
        }
      }
    }
    const controller = new AbortController()
    await performLlmStream(
      requestId,
      url,
      options,
      {
        onError: (message) => guard(() => webContents.send(IPC_CHANNELS.API_STREAM_ERROR, { requestId, error: message })),
        onRetry: (attempt, maxRetries, delay, message) =>
          guard(() => webContents.send(IPC_CHANNELS.API_STREAM_RETRY, { requestId, attempt, maxRetries, delay, message })),
        onChunk: (text) => guard(() => webContents.send(IPC_CHANNELS.API_STREAM_CHUNK, { requestId, data: text })),
        onDone: () => guard(() => webContents.send(IPC_CHANNELS.API_STREAM_DONE, { requestId })),
      },
      controller,
    )
  })

  // Abort an ongoing streaming request
  ipcMain.handle(IPC_CHANNELS.API_ABORT_STREAM, async (_event, requestId: string) => {
    abortLlmStream(requestId)
  })

  // Simple non-streaming fetch for small requests (title generation, etc.)
  ipcMain.handle(IPC_CHANNELS.API_FETCH, async (_event, url: string, options: SimpleFetchOptions): Promise<string | null> => {
    return performSimpleFetch(url, options)
  })
}

export interface SimpleFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  withProfileHeaders?: boolean
  profileId?: string
}

/** Abort one streaming request by id (no-op when already finished). */
export function abortLlmStream(requestId: string): void {
  const entry = pendingRequests.get(requestId)
  if (entry) {
    entry.controller.abort()
    pendingRequests.delete(requestId)
  }
}

/** Simple non-streaming fetch: SSRF-validated, 30s timeout, 50MB cap, returns text. */
export async function performSimpleFetch(url: string, options: SimpleFetchOptions): Promise<string | null> {
  console.log(`[API-Proxy] Simple fetch: POST ${url}`)
  try {
    await validateRequestUrl(url)
  } catch {
    console.error(`[API-Proxy] SSRF blocked: ${url}`)
    return null
  }
  const MAX_RESPONSE_SIZE = 50 * 1024 * 1024 // 50MB
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Request timed out after 30s')), 30_000)
    try {
      const body2 = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
      const mergedHeaders2 = await applyProfileHeaders(options.headers, {
        mergeProfileHeaders: options.withProfileHeaders === true,
        profileId: options.profileId,
        url,
      })
      // Same opt-in as the hook below — only LLM calls (one-shots over the
      // Anthropic wire, the connection probe) hook and dump. webfetch hits
      // arbitrary public URLs with no credentials: no hook, no dump.
      const isLlmCall = options.withProfileHeaders === true || options.profileId !== undefined
      const simpleRequestId = `simple-${randomUUID().slice(0, 8)}`
      // llm-request hook: LLM requests opt in via withProfileHeaders (webfetch does not).
      let finalUrl2 = url
      let finalBody2 = body2 as string | undefined
      let finalHeaders2 = mergedHeaders2
      if (isLlmCall) {
        const hookApplied = await applyLlmRequestHook(url, mergedHeaders2, body2, {
          profileId: options.profileId,
          requestId: 'simple',
        })
        finalUrl2 = hookApplied.url
        finalBody2 = typeof hookApplied.body === 'object' ? JSON.stringify(hookApplied.body) : (hookApplied.body as string | undefined)
        finalHeaders2 = hookApplied.headers
      }
      const resolvedOptions2: { method?: string; headers?: Record<string, string>; body?: string } = {
        ...options,
        body: finalBody2,
        headers: finalHeaders2,
      }
      // This funnel used to leave no request trace at all (the documented
      // one-shot dump blind spot) — with the response, both halves now land.
      const requestDumpFile = isLlmCall
        ? await dumpLlmRequest({
            requestId: simpleRequestId,
            url: finalUrl2,
            method: resolvedOptions2.method || 'POST',
            headers: finalHeaders2,
            body: resolvedOptions2.body || '',
          })
        : null
      // 附加重试码表只对 LLM 调用生效（webfetch 打的是任意公共 URL，不背
      // LLM 重试配置的名字）；非 LLM 路保持默认码表。
      const extraRetryCodes = isLlmCall ? (await settingsStore.get()).llmRetryStatusCodes : undefined
      const response = await fetchWithRetry(finalUrl2, resolvedOptions2, controller.signal, 20, undefined, extraRetryCodes)
      if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error')
        if (isLlmCall) await dumpLlmResponse({ requestId: simpleRequestId, requestFile: requestDumpFile, status: String(response.status), body: errText })
        console.error(`[API-Proxy] Simple fetch error: HTTP ${response.status} - ${errText.slice(0, 200)}`)
        return null
      }
      // Check content-length header first
      const contentLength = response.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        console.error(`[API-Proxy] Response too large: ${contentLength} bytes > ${MAX_RESPONSE_SIZE}`)
        return null
      }
      // Stream body with size limit
      const reader = response.body?.getReader()
      if (!reader) return null
      const decoder = new TextDecoder()
      let result = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        result += decoder.decode(value, { stream: true })
        if (result.length > MAX_RESPONSE_SIZE) {
          reader.cancel()
          console.error(`[API-Proxy] Response exceeded ${MAX_RESPONSE_SIZE} bytes, truncated`)
          return null
        }
      }
      // Final decode flush
      result += decoder.decode()
      if (isLlmCall && result) {
        await dumpLlmResponse({ requestId: simpleRequestId, requestFile: requestDumpFile, status: String(response.status), body: result })
      }
      return result
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[API-Proxy] Simple fetch failed: ${message}`)
    return null
  }
}

/** Abort all active streaming requests (used after system sleep/resume). */
export function cancelAllRequests(): void {
  for (const [, entry] of pendingRequests) {
    entry.controller.abort()
  }
  pendingRequests.clear()
  console.log('[API-Proxy] Cancelled all pending requests after sleep/resume')
}
