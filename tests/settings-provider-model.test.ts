import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── 两层模型配置（供应商 → 模型）──
// settings.json 的权威形态是 providers[]（连接层：apiFormat/baseURL/apiKey/
// headers 被名下模型共享）+ 嵌套 models[]（模型层）。这里钉四件事：
//  1. 旧扁平 profiles 在读取时按 (接口规范, baseURL, apiKey, headers) 归组成
//     供应商，模型条目继承旧 profile id —— conversations.profile_id、
//     lastUsedProfileId 等引用零迁移继续解析。
//  2. get() 物化合并视图：每个模型一条 LlmProfile，连接字段从供应商填入。
//  3. set() 只认 providers：派生的 profiles 被丢弃重算；模型条目上误带的
//     连接字段剥离；改一处供应商连接，名下所有模型的合并视图同步。
//  4. 快照缺 providers（陈旧渲染端快照）时按旧 profiles 归组救回，不丢数据。

const HOME = process.env.HOME as string
const DATA_DIR = join(HOME, '.pulsemind')
const SETTINGS_PATH = join(DATA_DIR, 'settings.json')

// p1/p2 同供应商（同规范+URL+密钥），p3 独立（不同密钥/规范）。
const LEGACY_BASE = {
  activeProfileId: 'p2',
  profiles: [
    { id: 'p1', name: 'DeepSeek Chat', provider: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 8192, apiKey: 'sk-ds' },
    { id: 'p2', name: 'DeepSeek Reasoner', provider: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-reasoner', maxTokens: 16384, contextLength: 65536, apiKey: 'sk-ds' },
    { id: 'p3', name: 'Claude', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', maxTokens: 32768, apiKey: 'sk-anthropic' },
  ],
  theme: 'dark',
}

function writeRaw(content: unknown): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(content, null, 2), 'utf-8')
}

function readRaw(): Record<string, any> {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
}

async function freshStore() {
  vi.resetModules()
  const mod = await import('../src/main/storage/settings-store')
  return mod.settingsStore
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true })
  writeRaw(LEGACY_BASE)
})

describe('two-layer model config — legacy migration on read', () => {
  it('groups legacy profiles by connection and keeps the model ids', async () => {
    const store = await freshStore()
    const s = await store.get()
    expect(s.providers).toHaveLength(2)

    const ds = s.providers.find((p) => p.models.some((m) => m.id === 'p1'))!
    expect(ds.name).toBe('DeepSeek') // well-known host table
    expect(ds.apiFormat).toBe('openai')
    expect(ds.baseURL).toBe('https://api.deepseek.com')
    expect(ds.apiKey).toBe('sk-ds')
    expect(ds.models.map((m) => m.id).sort()).toEqual(['p1', 'p2'])
    expect(ds.models.find((m) => m.id === 'p2')?.maxTokens).toBe(16384)
    expect(ds.models.find((m) => m.id === 'p2')?.contextLength).toBe(65536)

    const an = s.providers.find((p) => p.models.some((m) => m.id === 'p3'))!
    expect(an.name).toBe('Anthropic')
    expect(an.apiFormat).toBe('anthropic')
    expect(an.models).toHaveLength(1)

    // 引用零迁移：activeProfileId（以及任何 conversations.profile_id）原样可用
    expect(s.activeProfileId).toBe('p2')
  })

  it('materializes the merged profile view (connection fields from the provider)', async () => {
    const store = await freshStore()
    const s = await store.get()
    expect(s.profiles.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    for (const p of s.profiles.filter((p) => p.id !== 'p3')) {
      expect(p.providerId).toBe(s.providers[0].id)
      expect(p.providerName).toBe('DeepSeek')
      expect(p.provider).toBe('openai')
      expect(p.baseURL).toBe('https://api.deepseek.com')
      expect(p.apiKey).toBe('sk-ds')
    }
    // 展示名：条目缺 name 时回落模型名
    expect(s.profiles[0].name).toBe('DeepSeek Chat')
  })

  it('same connection minus the key does NOT share a provider (宁多勿错)', async () => {
    writeRaw({
      activeProfileId: 'a',
      profiles: [
        { id: 'a', name: 'A', provider: 'openai', baseURL: 'https://gw.example.com', model: 'm1', maxTokens: 1024, apiKey: 'key-a' },
        { id: 'b', name: 'B', provider: 'openai', baseURL: 'https://gw.example.com', model: 'm2', maxTokens: 1024, apiKey: 'key-b' },
      ],
    })
    const store = await freshStore()
    const s = await store.get()
    expect(s.providers).toHaveLength(2)
    expect(s.providers.map((p) => p.apiKey).sort()).toEqual(['key-a', 'key-b'])
  })

  it('activeProfileId pointing at a deleted model falls back to the first model', async () => {
    writeRaw({
      activeProfileId: 'gone',
      providers: [{
        id: 'prov_x', name: 'X', apiFormat: 'openai', baseURL: 'https://x.example.com', apiKey: 'k',
        models: [{ id: 'm1', model: 'model-1', maxTokens: 1024 }],
      }],
    })
    const store = await freshStore()
    const s = await store.get()
    expect(s.activeProfileId).toBe('m1')
  })
})

describe('two-layer model config — write path', () => {
  it('set() persists providers only; derived profiles are recomputed, connection fields stripped from model entries', async () => {
    const store = await freshStore()
    const snapshot = await store.get()
    // 改一处供应商连接 —— 名下所有模型同步（共享 baseURL 的本意）
    snapshot.providers.find((p) => p.models.some((m) => m.id === 'p1'))!.baseURL = 'https://api.deepseek.com/v2'
    await store.set(snapshot)

    const raw = readRaw()
    expect(raw.profiles).toBeUndefined() // 派生视图不落盘
    expect(raw.providers).toHaveLength(2)
    for (const provider of raw.providers) {
      for (const m of provider.models) {
        expect(m.baseURL).toBeUndefined()
        expect(m.apiKey).toBeUndefined()
        expect(m.headers).toBeUndefined()
        expect(m.providerName).toBeUndefined()
        expect(m.providerId).toBeUndefined()
      }
    }

    const s = await store.get()
    for (const p of s.profiles.filter((p) => p.id === 'p1' || p.id === 'p2')) {
      expect(p.baseURL).toBe('https://api.deepseek.com/v2')
    }
    expect(s.profiles.find((p) => p.id === 'p3')!.baseURL).toBe('https://api.anthropic.com')
  })

  it('a stale snapshot without providers is regrouped from its profiles, not dropped', async () => {
    const store = await freshStore()
    const snapshot = await store.get()
    await store.set({ ...snapshot, providers: undefined } as never)
    const raw = readRaw()
    expect(raw.providers).toHaveLength(2)
    const ds = raw.providers.find((p: any) => p.models.some((m: any) => m.id === 'p1'))
    expect(ds.apiKey).toBe('sk-ds')
    expect((await store.get()).profiles.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('editing one model leaves its provider and sibling models untouched', async () => {
    const store = await freshStore()
    const snapshot = await store.get()
    const ds = snapshot.providers.find((p) => p.models.some((m) => m.id === 'p1'))!
    ds.models.find((m) => m.id === 'p1')!.maxTokens = 4096
    ds.models.push({ id: 'p4', model: 'deepseek-v3', name: 'V3', maxTokens: 8192 })
    await store.set(snapshot)

    const s = await store.get()
    const after = s.providers.find((p) => p.models.some((m) => m.id === 'p1'))!
    expect(after.models.map((m) => m.id)).toEqual(['p1', 'p2', 'p4'])
    expect(after.models.find((m) => m.id === 'p1')!.maxTokens).toBe(4096)
    expect(after.models.find((m) => m.id === 'p2')!.maxTokens).toBe(16384)
    // 合并视图随之带上新模型
    expect(s.profiles.find((p) => p.id === 'p4')!.name).toBe('V3')
  })
})
