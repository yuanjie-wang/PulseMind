import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HOOKS_DIR } from './storage/index'
import { logMain, describeError } from './main-log'
import type { LlmRequestHookContext, LlmRequestHookResult } from '../shared/types/hooks'

const HOOK_FILE = join(HOOKS_DIR, 'llm-request.js')

interface CachedHook {
  fn: (ctx: LlmRequestHookContext) => LlmRequestHookResult | Promise<LlmRequestHookResult>
  mtimeMs: number
}

let cached: CachedHook | null = null

/**
 * Load ~/.pulsemind/hooks/llm-request.js, re-reading it whenever the file
 * changes on disk so edits apply without restarting the app. Mirrors the
 * launch-hook contract: the file must export a single async function.
 */
function loadHook(): CachedHook | null {
  if (!existsSync(HOOK_FILE)) {
    cached = null
    return null
  }
  try {
    const mtimeMs = statSync(HOOK_FILE).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) return cached

    const resolved = require.resolve(HOOK_FILE)
    delete require.cache[resolved]
    const mod = require(resolved) as unknown
    const fn = (typeof mod === 'function' ? mod : (mod as { default?: unknown } | null)?.default)
    if (typeof fn !== 'function') {
      console.warn('[Hooks] llm-request.js does not export a function, skipping')
      logMain('WARN', 'hooks', 'llm-request.js does not export a function, skipping')
      cached = null
      return null
    }
    cached = { fn: fn as CachedHook['fn'], mtimeMs }
    return cached
  } catch (err) {
    console.error('[Hooks] Failed to load llm-request.js:', err)
    logMain('ERROR', 'hooks', `failed to load llm-request.js: ${describeError(err)}`)
    cached = null
    return null
  }
}

export interface ApplyLlmHookOptions {
  requestId: string
  profileId?: string
}

/**
 * Run the llm-request hook over a request right before it is sent. The hook
 * receives { url, headers, body, profileId, requestId } (body JSON-parsed
 * when possible) and may return { url?, headers?, body? } to override them.
 * Failures never block the request — the original values are used.
 */
export async function applyLlmRequestHook(
  url: string,
  headers: Record<string, string> | undefined,
  body: unknown,
  opts: ApplyLlmHookOptions,
): Promise<{ url: string; headers: Record<string, string> | undefined; body: unknown }> {
  const hook = loadHook()
  if (!hook) return { url, headers, body }

  let parsedBody = body
  if (typeof body === 'string') {
    try { parsedBody = JSON.parse(body) } catch { /* non-JSON body — pass through raw */ }
  }

  const context: LlmRequestHookContext = {
    event: 'llm-request',
    requestId: opts.requestId,
    url,
    headers: { ...headers },
    body: parsedBody,
    profileId: opts.profileId,
  }

  try {
    const result = await hook.fn(context)
    if (!result) return { url, headers, body }

    const mergedHeaders = { ...headers }
    if (result.headers) {
      const seen = new Map<string, string>()
      for (const k of Object.keys(mergedHeaders)) seen.set(k.toLowerCase(), k)
      for (const [k, v] of Object.entries(result.headers)) {
        const existingKey = seen.get(k.toLowerCase())
        if (existingKey && existingKey !== k) {
          delete mergedHeaders[existingKey]
          seen.delete(k.toLowerCase())
        }
        mergedHeaders[k] = v
        seen.set(k.toLowerCase(), k)
      }
    }

    return {
      url: result.url ?? url,
      headers: mergedHeaders,
      body: result.body ?? parsedBody,
    }
  } catch (err) {
    console.error('[Hooks] llm-request.js failed:', err)
    logMain('ERROR', 'hooks', `llm-request.js failed: ${describeError(err)}`)
    return { url, headers, body }
  }
}
