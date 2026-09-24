import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RawSettings = Record<string, unknown> & { profiles?: Array<Record<string, unknown>> }

const HOME = process.env.HOME as string
const DATA_DIR = join(HOME, '.pulsemind')
const SETTINGS_PATH = join(DATA_DIR, 'settings.json')
const ENC_PREFIX = 'enc:v1:'

const RAW_BASE: RawSettings = {
  activeProfileId: 'p1',
  profiles: [
    {
      id: 'p1',
      name: 'test-profile',
      baseURL: 'https://api.example.com',
      model: 'test-model',
      maxTokens: 1024,
      apiKey: 'sk-live-secret-123',
      headers: { 'x-api-token': 'bearer-token-xyz' },
    },
    {
      id: 'p2',
      name: 'placeholder-profile',
      baseURL: 'https://api.example.com',
      model: 'test-model',
      maxTokens: 1024,
      apiKey: '${PULSE_TEST_KEY}',
      headers: { 'x-custom': '${PULSE_TEST_KEY}' },
    },
  ],
  theme: 'light',
  myName: 'tester',
  locale: 'zh',
  encryptSecrets: true, // these tests exercise the ON path; the OFF path has its own describe
  soul: 'a plain string that must never be touched by the secret walk',
}

function writeRaw(content: unknown): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(content, null, 2), 'utf-8')
}

function readRaw(): RawSettings {
  return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
}

async function freshStore() {
  vi.resetModules()
  const mod = await import('../src/main/storage/settings-store')
  return mod.settingsStore
}

async function freshStoreModule() {
  vi.resetModules()
  return import('../src/main/storage/settings-store')
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true })
  writeRaw(RAW_BASE)
})

afterEach(async () => {
  const stub = await import('../tests/stubs/electron')
  stub.setStubEncryptionAvailable(true)
  stub.setStubKeychainDenied(false)
  delete process.env.PULSE_TEST_KEY
})

describe('secrets at rest (enc:v1:)', () => {
  it('serves plaintext in memory while the disk bytes are ciphertext', async () => {
    const store = await freshStore()
    // Encryption happens on WRITE: a bare get() of a pre-hardening file
    // neither rewrites it nor crashes. One round-trip puts ciphertext on disk.
    const snapshot = await store.get()
    expect(snapshot.profiles[0].apiKey).toBe('sk-live-secret-123')
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
    await store.set(snapshot)

    const s = await store.get()
    expect(s.profiles[0].apiKey).toBe('sk-live-secret-123')
    expect(s.profiles[0].headers).toMatchObject({ 'x-api-token': 'bearer-token-xyz' })

    const disk = readRaw()
    const apiKey = disk.profiles![0].apiKey as string
    expect(apiKey.startsWith(ENC_PREFIX)).toBe(true)
    expect(apiKey).not.toContain('sk-live-secret-123')
    expect((disk.profiles![0].headers as Record<string, string>)['x-api-token'].startsWith(ENC_PREFIX)).toBe(true)
  })

  it('keeps ${VAR} placeholders byte-identical on disk (they are designed to be readable)', async () => {
    await freshStore().then((s) => s.get())
    const disk = readRaw()
    expect(disk.profiles![1].apiKey).toBe('${PULSE_TEST_KEY}')
    expect((disk.profiles![1].headers as Record<string, string>)['x-custom']).toBe('${PULSE_TEST_KEY}')
  })

  it('reads a pre-hardening plaintext file untouched (compat) — only a WRITE encrypts', async () => {
    // RAW_BASE is already the pre-hardening shape; a bare read must not rewrite.
    const store = await freshStore()
    const s = await store.get()
    expect(s.profiles[0].apiKey).toBe('sk-live-secret-123')
    expect((readRaw().profiles![0].apiKey as string)).toBe('sk-live-secret-123')
  })

  it('round-trips a renderer save: resolved value re-encrypts, placeholder survives byte-identical', async () => {
    const store = await freshStore()
    // The renderer edits from the RESOLVED snapshot it received.
    const snapshot = await store.get()
    const edited = JSON.parse(JSON.stringify(snapshot))
    edited.profiles[0].apiKey = 'sk-brand-new-key'
    edited.profiles[1].apiKey = '${PULSE_TEST_KEY}'
    await store.set(edited)

    const s = await store.get()
    expect(s.profiles[0].apiKey).toBe('sk-brand-new-key')
    expect(s.profiles[1].apiKey).toBe('${PULSE_TEST_KEY}')

    const disk = readRaw()
    expect((disk.profiles![0].apiKey as string).startsWith(ENC_PREFIX)).toBe(true)
    expect(disk.profiles![0].apiKey).not.toContain('sk-brand-new-key')
    expect(disk.profiles![1].apiKey).toBe('${PULSE_TEST_KEY}')
  })

  it('the secret walk touches ONLY apiKey/headers — no other string field is encrypted', async () => {
    const store = await freshStore()
    const snapshot = await store.get()
    await store.set(snapshot)
    const disk = readRaw()
    expect(disk.soul).toBe(RAW_BASE.soul)
    expect(disk.profiles![0].name).toBe('test-profile')
    expect((disk.profiles![0].headers as Record<string, string>)['x-api-token'].startsWith(ENC_PREFIX)).toBe(true)
  })

  it('restorePlaceholders still works against a ciphertext previous file (decode-first ordering)', async () => {
    const store = await freshStore()
    await store.get() // first write encrypts
    // A renderer sends the SAME plaintext back — the placeholder restore must
    // not misfire, and the value must re-encrypt, not double-encrypt.
    const snapshot = await store.get()
    snapshot.profiles[0].apiKey = 'sk-live-secret-123'
    await store.set(snapshot)
    const s = await store.get()
    expect(s.profiles[0].apiKey).toBe('sk-live-secret-123')
    const disk = readRaw()
    expect(disk.profiles![0].apiKey as string).toBeTruthy()
    expect((disk.profiles![0].apiKey as string).startsWith(ENC_PREFIX)).toBe(true)
    // Exactly one enc layer: unwrapping the base64 yields the plaintext, not
    // another enc:v1: string.
    const b64 = (disk.profiles![0].apiKey as string).slice(ENC_PREFIX.length)
    const stub = await import('../tests/stubs/electron')
    const decoded = stub.safeStorage.decryptString(Buffer.from(b64, 'base64'))
    expect(decoded.startsWith(ENC_PREFIX)).toBe(false)
  })

  it('safeStorage unavailable → plaintext fallback all the way, no crash', async () => {
    const store = await freshStore()
    // Flip AFTER freshStore: resetModules re-imports the stub and would wipe
    // a flag set earlier.
    const stub = await import('../tests/stubs/electron')
    stub.setStubEncryptionAvailable(false)
    const snapshot = await store.get()
    await store.set(snapshot)
    const s = await store.get()
    expect(s.profiles[0].apiKey).toBe('sk-live-secret-123')
    // Disk stays plaintext when encryption never became available.
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
  })

  it('an undecryptable blob is DROPPED, never served as the ciphertext', async () => {
    writeRaw({
      ...RAW_BASE,
      profiles: [{ ...RAW_BASE.profiles![0], apiKey: `${ENC_PREFIX}bm90LWFyZWFsbHktYS1ibG9i` }],
    })
    const store = await freshStore()
    const s = await store.get()
    expect(s.profiles[0].apiKey).toBeUndefined()
  })

  it('migrateEncryptedSecrets rewrites plaintext once, then reports idempotence', async () => {
    const mod = await freshStoreModule()
    // RAW_BASE holds a plaintext secret; the stub is available.
    expect(await mod.migrateEncryptedSecrets()).toBe(true)
    expect((readRaw().profiles![0].apiKey as string).startsWith(ENC_PREFIX)).toBe(true)
    // Second run: nothing left to migrate — no rewrite.
    expect(await mod.migrateEncryptedSecrets()).toBe(false)
    const store = await freshStore()
    expect((await store.get()).profiles[0].apiKey).toBe('sk-live-secret-123')
  })

  it('migrateEncryptedSecrets leaves the file alone when encryption is unavailable', async () => {
    const mod = await freshStoreModule()
    const stub = await import('../tests/stubs/electron')
    stub.setStubEncryptionAvailable(false)
    expect(await mod.migrateEncryptedSecrets()).toBe(false)
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
  })
})

describe('keychain DENIED (available but encryptString throws)', () => {
  it('falls back to plaintext and the save never fails', async () => {
    const store = await freshStore()
    const stub = await import('../tests/stubs/electron')
    stub.setStubKeychainDenied(true)
    const snapshot = await store.get()
    await expect(store.set(snapshot)).resolves.toBeUndefined()
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
    expect((await store.get()).profiles![0].apiKey).toBe('sk-live-secret-123')
  })

  it('migrateEncryptedSecrets on denial rewrites plaintext harmlessly (no ciphertext, no throw)', async () => {
    const mod = await freshStoreModule()
    const stub = await import('../tests/stubs/electron')
    stub.setStubKeychainDenied(true)
    // The rewrite runs and lands plaintext (the deny fallback) — idempotent,
    // since the next scan finds the same plaintext and declines again.
    expect(await mod.migrateEncryptedSecrets()).toBe(true)
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
    expect(await mod.migrateEncryptedSecrets()).toBe(true) // still harmless
  })
})

describe('encryptSecrets OFF (2026-09-25 opt-in ruling) — the keychain is never touched', () => {
  function writeOff(): void {
    const raw = readRaw()
    delete raw.encryptSecrets
    writeRaw(raw)
  }

  it('a save keeps plaintext on disk even with safeStorage available', async () => {
    const store = await freshStore()
    writeOff()
    const snapshot = await store.get()
    await store.set(snapshot)
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
    expect((await store.get()).profiles![0].apiKey).toBe('sk-live-secret-123')
  })

  it('existing ciphertext still reads (compat) and the next save converts back to plaintext', async () => {
    // First produce ciphertext with the flag ON.
    const store = await freshStore()
    await store.set(await store.get())
    expect(readRaw().profiles![0].apiKey as string).toContain(ENC_PREFIX)
    // Switch OFF: reads still decode, the next save lands plaintext.
    const off = readRaw()
    off.encryptSecrets = false
    writeRaw(off)
    expect((await store.get()).profiles![0].apiKey).toBe('sk-live-secret-123')
    await store.set(await store.get())
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
  })

  it('migrateEncryptedSecrets declines when the flag is off', async () => {
    const mod = await freshStoreModule()
    writeOff()
    expect(await mod.migrateEncryptedSecrets()).toBe(false)
    expect(readRaw().profiles![0].apiKey).toBe('sk-live-secret-123')
  })
})

