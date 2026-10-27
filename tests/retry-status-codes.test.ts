// ── llmRetryStatusCodes: LLM 请求自动重试的附加 HTTP 状态码 ──
// 三层钉子，与功能的三段管线一一对应：
//   1. isRetryable —— 判定矩阵（默认码表 429+5xx 永远在，配置是追加不是替换）
//   2. settings-store —— 读取器归一化（只留 400–599 整数，缺失/全废回落 undefined）
//   3. performLlmStream —— 端到端：本地 HTTP 服务器直驱真传输层（oneshot-
//      proxy-funnel 先例），配置里的码真的触发重试、不在配置里的码真的不触发。
// 端到端正例吃一次真实的 5s 首次退避——这是传输层自己的节拍，不做假时钟。

import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRetryable, performLlmStream } from '../src/main/ipc/api-proxy.handler'

const HOME = process.env.HOME as string
const SETTINGS_PATH = join(HOME, '.pulsemind', 'settings.json')

// ── 1. 判定矩阵 ──

describe('isRetryable', () => {
  it('keeps the built-in set (429 + all 5xx) when no codes are configured', () => {
    expect(isRetryable(429)).toBe(true)
    expect(isRetryable(500)).toBe(true)
    expect(isRetryable(529)).toBe(true)
    expect(isRetryable(599)).toBe(true)
    expect(isRetryable(404)).toBe(false)
    expect(isRetryable(408)).toBe(false)
  })

  it('configured codes are additive — defaults stay retryable, others stay fatal', () => {
    const codes = [408, 409]
    expect(isRetryable(408, codes)).toBe(true)
    expect(isRetryable(409, codes)).toBe(true)
    expect(isRetryable(429, codes)).toBe(true) // default survives
    expect(isRetryable(502, codes)).toBe(true)
    expect(isRetryable(404, codes)).toBe(false) // not configured → still fatal
    expect(isRetryable(404, undefined)).toBe(false)
  })
})

// ── 2. settings-store 归一化 ──

// settings-store 按 mtime 做模块级缓存；每个用例 vi.resetModules 拿全新实例，
// 与 settings-store.test.ts 同款纪律。
async function freshStore() {
  vi.resetModules()
  const mod = await import('../src/main/storage/settings-store')
  return mod.settingsStore
}

function writeRawSettings(raw: Record<string, unknown>): void {
  mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify(raw), 'utf-8')
}

const BASE_PROVIDER = {
  id: 'prov_x',
  name: 'P',
  apiFormat: 'openai',
  baseURL: 'https://api.example.com',
  models: [{ id: 'model_x', model: 'm' }],
}

describe('llmRetryStatusCodes normalization (settings-store)', () => {
  it('keeps only integer codes in 400–599, deduped and sorted', async () => {
    writeRawSettings({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', llmRetryStatusCodes: [408, 'junk', 399, 700, 408, 529.9, 499] })
    const store = await freshStore()
    expect((await store.get()).llmRetryStatusCodes).toEqual([408, 499, 529])
  })

  it('absent / empty / non-array / all-invalid all fall back to undefined (defaults only)', async () => {
    for (const raw of [undefined, [], '408', [399, 600, 'x'], [{ code: 408 }]]) {
      writeRawSettings({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', llmRetryStatusCodes: raw as unknown })
      const store = await freshStore()
      expect((await store.get()).llmRetryStatusCodes, JSON.stringify(raw)).toBeUndefined()
    }
  })

  it('survives the whole-file round trip (write path passes the field through)', async () => {
    writeRawSettings({ providers: [BASE_PROVIDER], activeProfileId: 'model_x', llmRetryStatusCodes: [408] })
    const store = await freshStore()
    const settings = await store.get()
    expect(settings.llmRetryStatusCodes).toEqual([408])
    await store.set(settings)
    const store2 = await freshStore()
    expect((await store2.get()).llmRetryStatusCodes).toEqual([408])
  })
})

// ── 3. 端到端：performLlmStream 按配置重试 ──

interface SeenRequest { path: string; body: string }
const seen: SeenRequest[] = []
let responses: Array<{ status: number; body?: string }> = []
let server: Server | null = null
let base = ''

let clockTick = 0
function writeFixture(extra: Record<string, unknown> = {}): void {
  const settings = {
    activeProfileId: 'model_x',
    providers: [{ ...BASE_PROVIDER, baseURL: base }],
    ...extra,
  }
  writeRawSettings(settings)
  // store 按 mtime 缓存——每次写完拨动 mtime，下一次请求才能读到新值
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(SETTINGS_PATH, stamp, stamp)
}

interface StreamResult { chunks: string[]; errors: string[]; retryMessages: string[]; done: boolean }

function runStream(requestId: string): Promise<StreamResult> {
  return new Promise((resolve) => {
    const acc: StreamResult = { chunks: [], errors: [], retryMessages: [], done: false }
    const settle = (): void => resolve(acc)
    performLlmStream(requestId, `${base}/chat/completions`, { headers: { authorization: 'Bearer test' } }, {
      onError: (m) => { acc.errors.push(m); settle() },
      onRetry: (_attempt, _maxRetries, _delay, message) => acc.retryMessages.push(message),
      onChunk: (t) => acc.chunks.push(t),
      onDone: () => { acc.done = true; settle() },
    }, new AbortController())
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

const SSE_OK = 'data: {"ok":true}\n\ndata: [DONE]\n\n'

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body })
      const r = responses.shift() ?? { status: 500 }
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body ?? '')
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

describe('performLlmStream honors the configured retry codes', () => {
  beforeEach(() => {
    seen.length = 0 // `seen` is module-level; each case counts only its own requests
  })

  // 非配置的 4xx 保持致命：一次请求、错误直出（快，无退避等待）
  it('a non-configured 404 stays fatal — exactly one request, no retry', async () => {
    responses = [{ status: 404, body: '{"error":"nope"}' }]
    writeFixture()
    const result = await withTimeout(runStream('req-404'), 15_000, '404 case')
    expect(seen).toHaveLength(1)
    expect(result.done).toBe(false)
    expect(result.retryMessages).toHaveLength(0)
    expect(result.errors[0]).toContain('HTTP 404')
  })

  // 追加语义的反面钉子：没有配置时，408 与 404 一样致命（默认行为零变化）
  it('a 408 without the config does NOT retry (additive, default off)', async () => {
    responses = [{ status: 408, body: '{"error":"timeout"}' }]
    writeFixture()
    const result = await withTimeout(runStream('req-408-plain'), 15_000, '408-plain case')
    expect(seen).toHaveLength(1)
    expect(result.done).toBe(false)
    expect(result.retryMessages).toHaveLength(0)
    expect(result.errors[0]).toContain('HTTP 408')
  })

  // 正例：配置里的码触发真实重试——第一拍 408、第二拍 200 流式完成。
  // 吃一次真实的 5s 首次退避（fetchWithRetry 的 (attempt+5)*1000），不做假时钟。
  it('a configured 408 retries once and the stream completes', { timeout: 30_000 }, async () => {
    responses = [{ status: 408, body: '{"error":"slow down"}' }, { status: 200, body: SSE_OK }]
    writeFixture({ llmRetryStatusCodes: [408] })
    const result = await withTimeout(runStream('req-408-configured'), 25_000, '408-configured case')
    expect(seen).toHaveLength(2)
    expect(result.done).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.retryMessages.length).toBeGreaterThanOrEqual(1)
    expect(result.retryMessages[0]).toContain('HTTP 408')
    expect(result.retryMessages[0]).toContain('1/20')
    expect(result.chunks.join('')).toContain('[DONE]')
  })
})
