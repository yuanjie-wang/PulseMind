import { ipcMain, BrowserWindow } from 'electron'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { settingsStore } from '../storage/settings-store'

/**
 * Resolve ${VAR_NAME} patterns in a string using environment variables.
 * If the variable is not set, the original placeholder is kept so the API
 * error message will hint at the missing variable.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    return process.env[name] ?? match
  })
}

/**
 * Resolve env vars in the request headers, then merge the active profile's
 * custom headers over them (custom wins). Values may reference ${ENV_VAR}.
 * Blank-value headers are skipped so an empty UI row never clobbers a default.
 */
async function applyProfileHeaders(headers?: Record<string, string>): Promise<Record<string, string> | undefined> {
  const settings = await settingsStore.get()
  const active = settings.profiles.find(p => p.id === settings.activeProfileId)
  const base: Record<string, string> = headers
    ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolveEnvVars(v)]))
    : {}
  if (!active?.headers) return Object.keys(base).length ? base : headers
  for (const [k, v] of Object.entries(active.headers)) {
    if (!v.trim()) continue
    base[k] = resolveEnvVars(v)
  }
  return base
}

/** Check if an IP falls within private/reserved ranges (SSRF prevention). */
function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')
  // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
  return parts[0] === 127 || parts[0] === 10 || parts[0] === 169
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

const PRIVATE_HOST_TTL = 5 * 60 * 1000 // 5 minutes
const privateHostCache = new Map<string, { result: boolean; time: number }>()

/** Check whether a hostname resolves to a private IP (with in-memory cache). */
async function isPrivateHost(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return isPrivateIP(hostname)
  const cached = privateHostCache.get(hostname)
  if (cached !== undefined && Date.now() - cached.time < PRIVATE_HOST_TTL) return cached.result
  try {
    const { address } = await lookup(hostname)
    const result = isPrivateIP(address)
    privateHostCache.set(hostname, { result, time: Date.now() })
    return result
  } catch {
    return false // DNS failure — let the fetch itself fail naturally
  }
}

/** Verify the request URL is not an SSRF attempt against the user's configured API host. */
async function validateRequestUrl(requestUrl: string): Promise<void> {
  let parsed: URL
  try { parsed = new URL(requestUrl) } catch { throw new Error(`无效 URL: ${requestUrl.slice(0, 100)}`) }

  if (!(await isPrivateHost(parsed.hostname))) return // public IP — safe

  // Private IP — only allow if the user's configured baseURL also points to one (local LLM)
  const settings = await settingsStore.get()
  const activeProfile = settings.profiles.find(p => p.id === settings.activeProfileId)
  if (activeProfile?.baseURL) {
    try {
      const baseParsed = new URL(activeProfile.baseURL)
      if (baseParsed.hostname === parsed.hostname) return // same host as configured — allow
    } catch { /* ignore parse failures */ }
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

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithRetry(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
  maxRetries = 20,
  onRetry?: (attempt: number, reason: string) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: options.method || 'POST',
        headers: { ...options.headers },
        body: options.body,
        signal,
      })
      if (response.ok || !isRetryable(response.status) || attempt >= maxRetries) {
        return response
      }
      const delay = (attempt + 5) * 1000
      console.log(`[API-Proxy] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (HTTP ${response.status})`)
      onRetry?.(attempt + 1, `HTTP ${response.status}`)
      await sleep(delay)
    } catch (err) {
      // Don't retry aborted requests (user cancellation)
      if (signal?.aborted) throw err
      // Network error (ECONNRESET, ETIMEDOUT, ECONNREFUSED, DNS, TLS…) — retry
      if (attempt >= maxRetries) throw err
      const delay = (attempt + 5) * 1000
      console.log(`[API-Proxy] Retry ${attempt + 1}/${maxRetries} after ${delay}ms (${err instanceof Error ? err.message : 'Unknown'})`)
      onRetry?.(attempt + 1, err instanceof Error ? err.message : '网络错误')
      await sleep(delay)
    }
  }
}

export function registerApiProxyHandlers(): void {
  // Start a proxied streaming HTTP request
  ipcMain.handle(
    IPC_CHANNELS.API_FETCH_STREAM,
    async (
      event,
      requestId: string,
      url: string,
      options: {
        method?: string
        headers?: Record<string, string>
        body?: string | Record<string, unknown>
      }
    ) => {
      const webContents = getSender(event)
      const controller = new AbortController()

      try { await validateRequestUrl(url) } catch (e) {
        webContents.send(IPC_CHANNELS.API_STREAM_ERROR, {
          requestId, error: e instanceof Error ? e.message : 'SSRF 拦截'
        })
        return
      }

      pendingRequests.set(requestId, { controller, url })

      console.log(`[API-Proxy] Starting request: ${requestId} ${options.method || 'POST'} ${url}`)

      const maxRetries = 20
      const retryCb = (attempt: number, reason: string) => {
        const delay = (attempt + 4) * 1000
        webContents.send(IPC_CHANNELS.API_STREAM_RETRY, { requestId, attempt, maxRetries, delay, message: `${reason}，正在重试 (${attempt}/${maxRetries})…` })
      }

      try {
        // Stringify body in main process so the renderer isn't blocked on large JSON.
        const body = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
        const resolvedOptions: { method?: string; headers?: Record<string, string>; body?: string } = {
          ...options,
          body: body as string | undefined,
          headers: await applyProfileHeaders(options.headers)
        }
        const response = await fetchWithRetry(url, resolvedOptions, controller.signal, maxRetries, retryCb)

        console.log(`[API-Proxy] Response status: ${response.status} for ${requestId}`)

        if (!response.ok) {
          const errText = await response.text().catch(() => 'Unknown error')
          // Dump full request body for debugging 400 errors
          try {
            const reqBody = JSON.parse(resolvedOptions.body || '{}')
            const msgs = (reqBody.messages || []).map((m: any, i: number) => {
              const content = m.content
              const contentStr = typeof content === 'string' ? JSON.stringify(content) : JSON.stringify(content)
              return `${i}:${m.role} content=${contentStr} len=${typeof content === 'string' ? content.length : '?'} tool_calls=${m.tool_calls?.length ?? 0}${m.tool_calls ? ' calls=[' + m.tool_calls.map((tc: any) => `${tc.function?.name || '?'}(${(tc.function?.arguments || '').length})`).join(',') + ']' : ''}`
            })
            console.error(`[API-Proxy] HTTP ${response.status} full messages:`, msgs.join('\n  '))
          } catch { /* ignore parse error */ }
          webContents.send(IPC_CHANNELS.API_STREAM_ERROR, {
            requestId,
            error: `HTTP ${response.status}: ${errText.slice(0, 1000)}`
          })
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          webContents.send(IPC_CHANNELS.API_STREAM_ERROR, {
            requestId,
            error: 'No response body'
          })
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
            webContents.send(IPC_CHANNELS.API_STREAM_CHUNK, { requestId, data: text })
          }
        } finally {
          clearTimeout(readTimeout)
        }

        webContents.send(IPC_CHANNELS.API_STREAM_DONE, { requestId })
        console.log(`[API-Proxy] Stream complete: ${requestId}`)
      } catch (err) {
        if (controller.signal.aborted) {
          const isTimeout = controller.signal.reason instanceof Error
            && controller.signal.reason.message === 'Stream idle timeout'
          if (isTimeout) {
            console.log(`[API-Proxy] Stream idle timeout: ${requestId}`)
            webContents.send(IPC_CHANNELS.API_STREAM_ERROR, {
              requestId,
              error: '连接闲置超时，请重试'
            })
          } else {
            console.log(`[API-Proxy] Request aborted: ${requestId}`)
            webContents.send(IPC_CHANNELS.API_STREAM_DONE, { requestId })
          }
          return
        }
        const message = err instanceof Error ? err.message : 'Unknown error'
        const detail = err instanceof Error && err.cause ? ` | cause: ${err.cause}` : ''
        console.error(`[API-Proxy] Request error: ${requestId} - ${message}${detail}`)
        webContents.send(IPC_CHANNELS.API_STREAM_ERROR, {
          requestId,
          error: `${message}${detail}`
        })
      } finally {
        pendingRequests.delete(requestId)
      }
    }
  )

  // Abort an ongoing streaming request
  ipcMain.handle(IPC_CHANNELS.API_ABORT_STREAM, async (_event, requestId: string) => {
    const entry = pendingRequests.get(requestId)
    if (entry) {
      entry.controller.abort()
      pendingRequests.delete(requestId)
    }
  })

  // Simple non-streaming fetch for small requests (title generation, etc.)
  ipcMain.handle(IPC_CHANNELS.API_FETCH, async (_event, url: string, options: { method?: string; headers?: Record<string, string>; body?: string }) => {
    console.log(`[API-Proxy] Simple fetch: POST ${url}`)
    try { await validateRequestUrl(url) } catch (e) {
      console.error(`[API-Proxy] SSRF blocked: ${url}`)
      return null
    }
    const MAX_RESPONSE_SIZE = 50 * 1024 * 1024 // 50MB
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('Request timed out after 30s')), 30_000)
      try {
        const body2 = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
        const resolvedOptions2: { method?: string; headers?: Record<string, string>; body?: string } = {
          ...options,
          body: body2 as string | undefined,
          headers: await applyProfileHeaders(options.headers)
        }
        const response = await fetchWithRetry(url, resolvedOptions2, controller.signal)
        if (!response.ok) {
          const errText = await response.text().catch(() => 'Unknown error')
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
        return result
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[API-Proxy] Simple fetch failed: ${message}`)
      return null
    }
  })
}

/** Abort all active streaming requests (used after system sleep/resume). */
export function cancelAllRequests(): void {
  for (const [, entry] of pendingRequests) {
    entry.controller.abort()
  }
  pendingRequests.clear()
  console.log('[API-Proxy] Cancelled all pending requests after sleep/resume')
}
