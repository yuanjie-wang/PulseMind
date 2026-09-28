import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProfileHeaders, urlMatchesProfileBaseURL } from '../src/main/ipc/api-proxy.handler'

// Same HOME sandbox as tests/setup.ts (process-level); settings.json lives in it.
const HOME = process.env.HOME as string
const SETTINGS_PATH = join(HOME, '.pulsemind', 'settings.json')

// settings-store serves an mtime cache — bump the stamp on every write so a
// same-millisecond rewrite is never served stale.
let clockTick = 0
function writeProvidersFixture(): void {
  const settings = {
    // 全局默认指向 Default 供应商 —— conv_20260927170026 的真实形态：
    // 会话用 Zen（OpenCode），全局默认是另一家。
    activeProfileId: 'model_default',
    providers: [
      {
        name: 'Default',
        apiFormat: 'openai',
        baseURL: 'https://api.default.example/v1',
        apiKey: 'sk-default',
        headers: { 'x-default-provider': 'yes' },
        models: [{ id: 'model_default', model: 'default-model', name: 'default-model' }]
      },
      {
        name: 'Zen',
        apiFormat: 'openai',
        baseURL: 'https://zen.example/go/v1',
        apiKey: 'sk-zen',
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

beforeEach(writeProvidersFixture)
afterEach(() => {
  delete process.env.ZEN_SECRET
})

describe('urlMatchesProfileBaseURL', () => {
  it('matches at the path boundary, ignoring trailing slashes', () => {
    expect(urlMatchesProfileBaseURL('https://zen.example/go/v1/chat/completions', 'https://zen.example/go/v1')).toBe(true)
    expect(urlMatchesProfileBaseURL('https://zen.example/go/v1/', 'https://zen.example/go/v1')).toBe(true)
    expect(urlMatchesProfileBaseURL('https://zen.example/go/v1', 'https://zen.example/go/v1/')).toBe(true)
    expect(urlMatchesProfileBaseURL('https://zen.example/go/v11/chat', 'https://zen.example/go/v1')).toBe(false)
    expect(urlMatchesProfileBaseURL('https://other.example/go/v1/chat', 'https://zen.example/go/v1')).toBe(false)
    expect(urlMatchesProfileBaseURL('https://zen.example/go/v1/chat', '')).toBe(false)
  })
})

describe('applyProfileHeaders resolves the provider the URL actually posts to', () => {
  it('a one-shot call (no profileId) gets the URL-matched provider headers', async () => {
    // conv_20260927170026: the history summarizer posted to the OpenCode
    // gateway while the global default was another provider — it received the
    // DEFAULT provider's headers (no x-opencode-session) and the gateway 400'd
    // `MissingSessionID` on every one-shot call all day.
    const merged = await applyProfileHeaders(
      { 'Content-Type': 'application/json', Authorization: 'Bearer sk-zen' },
      { url: 'https://zen.example/go/v1/chat/completions' }
    )
    expect(merged?.['x-opencode-session']).toBe('sess-123')
    expect(merged?.['x-default-provider']).toBeUndefined()
  })

  it('a URL on the default provider resolves there without a profileId', async () => {
    const merged = await applyProfileHeaders(
      { Authorization: 'Bearer sk-default' },
      { url: 'https://api.default.example/v1/chat/completions' }
    )
    expect(merged?.['x-default-provider']).toBe('yes')
    expect(merged?.['x-opencode-session']).toBeUndefined()
  })

  it('an explicit profileId still wins over the URL match', async () => {
    const merged = await applyProfileHeaders(
      { Authorization: 'Bearer sk-zen' },
      { profileId: 'model_default', url: 'https://zen.example/go/v1/chat/completions' }
    )
    expect(merged?.['x-default-provider']).toBe('yes')
    expect(merged?.['x-opencode-session']).toBeUndefined()
  })

  it('a URL no provider claims falls back to the active profile', async () => {
    const merged = await applyProfileHeaders(
      { Authorization: 'Bearer sk-x' },
      { url: 'https://unclaimed.example/v1/chat/completions' }
    )
    expect(merged?.['x-default-provider']).toBe('yes')
  })

  it('URL-matched header values still resolve ${ENV} placeholders', async () => {
    process.env.ZEN_SECRET = 'sess-env'
    const raw = {
      activeProfileId: 'model_default',
      providers: [{
        name: 'Zen', apiFormat: 'openai', baseURL: 'https://zen.example/go/v1', apiKey: 'sk-zen',
        headers: { 'x-opencode-session': '${ZEN_SECRET}' },
        models: [{ id: 'model_zen', model: 'zen-model', name: 'zen-model' }]
      }]
    }
    mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(raw), 'utf-8')
    const stamp = new Date(Date.now() + ++clockTick * 1000)
    utimesSync(SETTINGS_PATH, stamp, stamp)

    const merged = await applyProfileHeaders(
      { Authorization: 'Bearer sk-zen' },
      { url: 'https://zen.example/go/v1/chat/completions' }
    )
    expect(merged?.['x-opencode-session']).toBe('sess-env')
  })
})
