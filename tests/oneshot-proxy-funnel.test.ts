import { createServer, type Server, type IncomingHttpHeaders } from 'node:http'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { performLlmStream, performSimpleFetch } from '../src/main/ipc/api-proxy.handler'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'

const HOME = process.env.HOME as string
const SETTINGS_PATH = join(HOME, '.pulsemind', 'settings.json')

/**
 * conv_20260927170026 (2026-09-28): every ONE-SHOT LLM call to a non-default
 * provider went out with the GLOBAL-DEFAULT profile's headers (one-shots carry
 * no profileId), the opencode zen gateway 400'd `MissingSessionID` on all of
 * them, and the history summary — along with titles, session reviews and
 * memory extraction — silently never worked there.
 *
 * This file pins the WHOLE one-shot funnel end to end, both adapter shapes:
 *   adapter.callNonStreaming → proxy (performLlmStream / performSimpleFetch)
 *   → URL-matched profile headers (applyProfileHeaders' url resolution)
 *   → ~/.pulsemind/hooks/llm-request.js applied.
 * The transport wiring mirrors main-host.ts (the production host) so the test
 * exercises the same funnel shape the app runs.
 */

// ── Local provider double ─────────────────────────────────────────────

interface SeenRequest { path: string; headers: IncomingHttpHeaders; body: string }
const seen: SeenRequest[] = []
let server: Server | null = null
let zenBase = ''

// ── Fake host: main-host.ts's LLM transport wiring, event loops in-test ──

const chunkListeners = new Set<(d: { requestId: string; data: string }) => void>()
const doneListeners = new Set<(d: { requestId: string }) => void>()
const errorListeners = new Set<(d: { requestId: string; error: string }) => void>()
const noop = () => Promise.resolve([] as unknown[])

const fakeHost = new Proxy(
  {
    apiFetchStream: (requestId: string, url: string, options?: Record<string, unknown>) => {
      const controller = new AbortController()
      return performLlmStream(requestId, url, (options ?? {}) as never, {
        onError: (error) => errorListeners.forEach(fn => fn({ requestId, error })),
        onRetry: () => {},
        onChunk: (data) => chunkListeners.forEach(fn => fn({ requestId, data })),
        onDone: () => doneListeners.forEach(fn => fn({ requestId })),
      }, controller)
    },
    apiFetch: async (url: string, options?: Record<string, unknown>) => performSimpleFetch(url, (options ?? {}) as never),
    onApiStreamChunk: (fn: (d: { requestId: string; data: string }) => void) => { chunkListeners.add(fn); return () => { chunkListeners.delete(fn) } },
    onApiStreamError: (fn: (d: { requestId: string; error: string }) => void) => { errorListeners.add(fn); return () => { errorListeners.delete(fn) } },
    onApiStreamDone: (fn: (d: { requestId: string }) => void) => { doneListeners.add(fn); return () => { doneListeners.delete(fn) } },
    onApiStreamRetry: () => () => {},
    mcpListServers: noop,
    expertList: noop,
    getSkillPreferences: () => Promise.resolve({}),
    getSettings: () => Promise.resolve({ locale: 'zh' }),
  },
  { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => Promise.resolve([] as unknown[])) }
) as PulseHost

// ── Fixture: two providers, the DEFAULT one is NOT the one under test ──

let clockTick = 0
function writeFixture(zenBaseURL: string): void {
  // Default sits on the SAME host as Zen but at the shorter path prefix —
  // so the SSRF gate sees a private active baseURL AND the URL resolution
  // must pick the LONGEST matching prefix (Zen), not the first list entry.
  const defaultBaseURL = zenBaseURL.replace(/\/v1$/, '')
  const settings = {
    // 全局默认指向 Default —— one-shot 若回落到 activeProfileId，合并到的
    // 就是这家的头（没有 x-opencode-session），正是被修掉的那个缺陷形状。
    activeProfileId: 'model_default',
    providers: [
      {
        name: 'Default', apiFormat: 'openai', baseURL: defaultBaseURL, apiKey: 'sk-default',
        headers: { 'x-default-provider': 'yes' },
        models: [{ id: 'model_default', model: 'default-model', name: 'default-model' }]
      },
      {
        name: 'Zen', apiFormat: 'openai', baseURL: zenBaseURL, apiKey: 'sk-zen',
        headers: { 'x-opencode-session': 'sess-123' },
        models: [{ id: 'model_zen', model: 'zen-model', name: 'zen-model' }]
      }
    ]
  }
  mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings), 'utf-8')
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(SETTINGS_PATH, stamp, stamp)
}

function writeHookFixture(): void {
  mkdirSync(join(HOME, '.pulsemind', 'hooks'), { recursive: true })
  writeFileSync(join(HOME, '.pulsemind', 'hooks', 'llm-request.js'), [
    'globalThis.__hookCalls = (globalThis.__hookCalls || [])',
    'module.exports = async (ctx) => {',
    '  globalThis.__hookCalls.push({ url: ctx.url, model: ctx.body && ctx.body.model, profileId: ctx.profileId })',
    '  return { headers: { "x-pulsemind-hook": "active" } }',
    '}',
  ].join('\n'), 'utf-8')
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      if (req.url?.includes('/messages')) {
        // Anthropic shape
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          content: [{ type: 'text', text: '你好' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn'
        }))
        return
      }
      // OpenAI SSE shape (callNonStreaming rides the streaming channel)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  zenBase = `http://127.0.0.1:${port}/v1`
  writeFixture(zenBase)
  writeHookFixture()
  setHost(fakeHost)
})

afterAll(() => {
  server?.close()
})

beforeEach(() => {
  seen.length = 0
  ;(globalThis as { __hookCalls?: unknown[] }).__hookCalls = []
})

// ── The funnel, end to end ────────────────────────────────────────────

describe('openai one-shot rides performLlmStream with URL-matched headers + hook', () => {
  it('callNonStreaming without a profileId gets the URL provider headers and the llm-request hook', async () => {
    const { openaiAdapter } = await import('../src/renderer/src/llm/OpenAIAdapter')
    const text = await openaiAdapter.callNonStreaming(
      'sk-zen', zenBase, 'zen-model', 'sys', [{ role: 'user', content: 'hi' }], 100
    )
    expect(text).toBe('好的')

    const call = seen.find(s => s.headers.authorization === 'Bearer sk-zen')
    expect(call, 'request never reached the provider').toBeDefined()
    // URL-matched profile headers — the 2026-09-28 fix. No profileId flows
    // through callNonStreaming, so the OLD activeProfileId fallback would
    // have merged the Default provider's headers here instead.
    expect(call!.headers['x-opencode-session']).toBe('sess-123')
    expect(call!.headers['x-default-provider']).toBeUndefined()
    // llm-request.js ran ON TOP of the merged headers.
    expect(call!.headers['x-pulsemind-hook']).toBe('active')
    const hooks = (globalThis as { __hookCalls: Array<{ url: string; model?: string; profileId?: string }> }).__hookCalls
    expect(hooks.some(c => c.model === 'zen-model' && c.url.includes('/chat/completions'))).toBe(true)
    // Known shape: one-shot calls carry no profileId, so the hook's ctx sees
    // n/a there — headers/routing are already correct by URL matching.
    expect(hooks.every(c => c.profileId === undefined)).toBe(true)
  })
})

describe('anthropic one-shot rides performSimpleFetch with the opt-in funnel', () => {
  it('callNonStreaming (withProfileHeaders) gets URL-matched headers and the hook', async () => {
    const { anthropicAdapter } = await import('../src/renderer/src/llm/AnthropicAdapter')
    const text = await anthropicAdapter.callNonStreaming(
      'sk-zen', zenBase, 'claude-x', 'sys', [{ role: 'user', content: 'hi' }], 100
    )
    expect(text).toBe('你好')

    const call = seen.find(s => s.path?.includes('/messages'))
    expect(call, 'request never reached the provider').toBeDefined()
    expect(call!.headers['x-opencode-session']).toBe('sess-123')
    expect(call!.headers['x-default-provider']).toBeUndefined()
    expect(call!.headers['x-pulsemind-hook']).toBe('active')
    const hooks = (globalThis as { __hookCalls: Array<{ url: string; model?: string }> }).__hookCalls
    expect(hooks.some(c => c.model === 'claude-x' && c.url.includes('/messages'))).toBe(true)
  })
})

// ── Wiring pins: the call sites must keep feeding `url` to the resolver ──

describe('the funnel call sites keep passing url to applyProfileHeaders', () => {
  const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf-8')

  it('performLlmStream passes url (the api_ loop AND the openai one-shot funnel)', () => {
    const proxy = src('src/main/ipc/api-proxy.handler.ts')
    expect(proxy).toContain('applyProfileHeaders(options.headers, { profileId: options.profileId, url })')
  })

  it('performSimpleFetch passes url (the anthropic one-shot funnel)', () => {
    const proxy = src('src/main/ipc/api-proxy.handler.ts')
    const simple = proxy.slice(proxy.indexOf('export async function performSimpleFetch'))
    expect(simple).toContain('url')
    expect(simple).toMatch(/applyProfileHeaders\(options\.headers, \{[^}]*url[^}]*\}\)/s)
  })
})
