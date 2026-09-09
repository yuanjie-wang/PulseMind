import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type AppSettings = Record<string, unknown> & { profiles: Array<Record<string, unknown>> }

const HOME = process.env.HOME as string
const DATA_DIR = join(HOME, '.pulsemind')
const SETTINGS_PATH = join(DATA_DIR, 'settings.json')

const RAW_BASE: AppSettings = {
  activeProfileId: 'p1',
  profiles: [{
    id: 'p1',
    name: 'test-profile',
    baseURL: 'https://api.example.com',
    model: 'test-model',
    maxTokens: 1024,
    apiKey: '${PULSE_TEST_KEY}',
    headers: { 'x-custom': '${PULSE_TEST_KEY}' },
  }],
  theme: 'light',
  myName: 'tester',
  locale: 'zh',
}

function writeRaw(content: unknown): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(content, null, 2), 'utf-8')
}

function readRaw(): AppSettings {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
}

// settings-store caches by mtime in module state; a fresh module registry per
// test keeps tests independent of cache-ordering side effects.
async function freshStore() {
  vi.resetModules()
  const mod = await import('../src/main/storage/settings-store')
  return mod.settingsStore
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true })
  writeRaw(RAW_BASE)
})

afterEach(() => {
  delete process.env.PULSE_TEST_KEY
  delete process.env.PULSE_TEST_NAME
})

describe('SettingsStore.get', () => {
  it('keeps apiKey and headers raw while resolving other fields', async () => {
    process.env.PULSE_TEST_KEY = 'sk-resolved'
    process.env.PULSE_TEST_NAME = 'resolved-name'
    const raw = { ...RAW_BASE, myName: '${PULSE_TEST_NAME}' }
    writeRaw(raw)

    const store = await freshStore()
    const s = await store.get()

    expect(s.profiles[0].apiKey).toBe('${PULSE_TEST_KEY}') // skip-key: raw even when env IS set
    expect((s.profiles[0].headers as Record<string, string>)['x-custom']).toBe('${PULSE_TEST_KEY}')
    expect(s.myName).toBe('resolved-name') // non-skipped fields still resolve
  })

  it('migrates legacy single-profile format into a profiles array', async () => {
    writeRaw({ baseURL: 'https://legacy.example.com', apiKey: 'legacy-key', theme: 'dark' })
    const store = await freshStore()
    const s = await store.get()
    expect(s.profiles).toHaveLength(1)
    expect(s.profiles[0].id).toBe('default')
    expect(s.profiles[0].apiKey).toBe('legacy-key')
    expect(s.theme).toBe('dark')
  })

  it('serves a cached copy until the file mtime changes', async () => {
    const store = await freshStore()
    const first = await store.get()
    const second = await store.get()
    expect(second).toEqual(first)

    writeRaw({ ...RAW_BASE, theme: 'dark' })
    const third = await store.get()
    expect(third.theme).toBe('dark')
  })
})

describe('SettingsStore.set — placeholder preservation', () => {
  it('renderer round-trip of resolved values never rewrites the apiKey placeholder', async () => {
    // Env set before the read, as happens when app-start hooks completed first.
    process.env.PULSE_TEST_KEY = 'sk-resolved'
    const store = await freshStore()
    const rendererCopy = await store.get()
    expect(rendererCopy.profiles[0].apiKey).toBe('${PULSE_TEST_KEY}') // raw after the fix

    // Any settings save (theme toggle etc.) round-trips the renderer copy.
    await store.set({ ...rendererCopy, theme: 'dark' } as AppSettings)
    expect(readRaw().profiles[0].apiKey).toBe('${PULSE_TEST_KEY}')
    expect(readRaw().theme).toBe('dark')
  })

  it('placeholder survives even when env changes between read and save', async () => {
    const store = await freshStore()
    const rendererCopy = await store.get() // env unset here
    process.env.PULSE_TEST_KEY = 'sk-late' // hook sets it afterwards
    await store.set({ ...rendererCopy, theme: 'dark' } as AppSettings)
    expect(readRaw().profiles[0].apiKey).toBe('${PULSE_TEST_KEY}')
  })

  it('keeps a non-skipped placeholder whose resolution round-trips unchanged', async () => {
    process.env.PULSE_TEST_NAME = 'resolved-name'
    writeRaw({ ...RAW_BASE, myName: '${PULSE_TEST_NAME}' })
    const store = await freshStore()
    const rendererCopy = await store.get()
    expect(rendererCopy.myName).toBe('resolved-name')
    await store.set({ ...rendererCopy } as AppSettings)
    expect(readRaw().myName).toBe('${PULSE_TEST_NAME}')
  })

  it('persists genuine edits (value differs from the placeholder resolution)', async () => {
    process.env.PULSE_TEST_KEY = 'sk-resolved'
    const store = await freshStore()
    const rendererCopy = await store.get()
    await store.set({
      ...rendererCopy,
      profiles: [{ ...rendererCopy.profiles[0], apiKey: 'sk-brand-new' }],
    } as AppSettings)
    expect(readRaw().profiles[0].apiKey).toBe('sk-brand-new')
  })
})
