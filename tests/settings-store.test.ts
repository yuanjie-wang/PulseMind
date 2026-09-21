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

  // 深色默认 (2026-09-20): a file with NO theme key — a brand-new install or a
  // pre-theme-era write — reads as dark; an explicit `system` still wins.
  it('defaults the theme to dark when the file carries none', async () => {
    const noTheme = await freshStore()
    writeRaw({ profiles: RAW_BASE.profiles, activeProfileId: RAW_BASE.activeProfileId })
    expect((await noTheme.get()).theme).toBe('dark')

    const explicitSystem = await freshStore()
    writeRaw({ ...RAW_BASE, theme: 'system' })
    expect((await explicitSystem.get()).theme).toBe('system')
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

  // 运行历史保留策略 drives a destructive prune at startup, so only a real
  // day count may survive normalization — anything else means 永久保留.
  it('normalizes the run-history retention policy, defaulting to keep-forever', async () => {
    const withPolicy = await freshStore()
    writeRaw({ ...RAW_BASE, routineRunRetentionDays: 30 })
    expect((await withPolicy.get()).routineRunRetentionDays).toBe(30)

    const absent = await freshStore()
    writeRaw({ ...RAW_BASE })
    expect((await absent.get()).routineRunRetentionDays).toBe(0)

    const junk = await freshStore()
    writeRaw({ ...RAW_BASE, routineRunRetentionDays: -5 })
    expect((await junk.get()).routineRunRetentionDays).toBe(0)
  })

  // 助手设置的两项运行上限（循环次数 / 并行专家）直接喂给引擎的边界判断：
  // 合法值原样通过，缺失 / 非法 / 越界一律回落默认（50 / 5），不放行坏值。
  it('normalizes the agent run limits, falling back to 50 / 5', async () => {
    const saved = await freshStore()
    writeRaw({ ...RAW_BASE, maxLoopIterations: 80, maxParallelSubAgents: 3 })
    const s = await saved.get()
    expect(s.maxLoopIterations).toBe(80)
    expect(s.maxParallelSubAgents).toBe(3)

    const absent = await freshStore()
    writeRaw({ ...RAW_BASE })
    const s2 = await absent.get()
    expect(s2.maxLoopIterations).toBe(50)
    expect(s2.maxParallelSubAgents).toBe(5)

    const junk = await freshStore()
    writeRaw({ ...RAW_BASE, maxLoopIterations: 'lots', maxParallelSubAgents: 99 })
    const s3 = await junk.get()
    expect(s3.maxLoopIterations).toBe(50)
    expect(s3.maxParallelSubAgents).toBe(5)

    const bounds = await freshStore()
    writeRaw({ ...RAW_BASE, maxLoopIterations: 501, maxParallelSubAgents: 2.9 })
    const s4 = await bounds.get()
    expect(s4.maxLoopIterations).toBe(50) // over the 500 ceiling → default
    expect(s4.maxParallelSubAgents).toBe(2) // in range → floored
  })

  // 授权档位 is per conversation now (conversations.approval_mode): settings must
  // not carry it any more, even for a file written by an older build.
  it('ignores approvalMode / yoloMode left over in settings.json', async () => {
    const store = await freshStore()
    writeRaw({ ...RAW_BASE, approvalMode: 'always-ask', yoloMode: false })
    const settings = await store.get()
    expect('approvalMode' in settings).toBe(false)
  })

  // H1/H2 (review 2026-09-18): the optional group keys are rebuilt by get()'s
  // field-by-field branch — a fresh module registry is a process restart, so
  // every key below must come back, not revert to its default.
  it('reads back projectSortMode / git / knowledge / browser written to the file', async () => {
    writeRaw({
      ...RAW_BASE,
      projectSortMode: 'manual',
      git: { contextInjection: false },
      knowledge: { autoCompile: true },
      browser: { backend: 'managed', headless: false, timeoutMs: 120000, paneWidth: 720 },
    })
    const store = await freshStore()
    const s = await store.get()
    expect(s.projectSortMode).toBe('manual')
    expect(s.git).toEqual({ contextInjection: false })
    expect(s.knowledge).toEqual({ autoCompile: true })
    expect(s.browser).toEqual({ backend: 'managed', headless: false, timeoutMs: 120000, paneWidth: 720 })
  })

  it('whitelists projectSortMode and normalizes the group keys instead of trusting the file', async () => {
    writeRaw({
      ...RAW_BASE,
      projectSortMode: 'bogus',
      git: { contextInjection: 'no', futureSubKey: 1 },
      browser: { paneWidth: -5, backend: 'hijacked' },
    })
    const store = await freshStore()
    const s = await store.get()
    expect(s.projectSortMode).toBeUndefined()
    expect(s.git).toEqual({ contextInjection: false, futureSubKey: 1 }) // non-true → default off; unknown sub-keys kept
    expect(s.browser).toEqual({}) // junk fields dropped, no crash
  })

  it('a whole-object save of a get() copy keeps the group keys in the file', async () => {
    writeRaw({
      ...RAW_BASE,
      projectSortMode: 'manual',
      git: { contextInjection: false },
      knowledge: { autoCompile: true },
    })
    const store = await freshStore()
    const rendererCopy = await store.get()
    // 改主题这类无关保存曾把 projectSortMode / git 从文件里抹掉（H1/H2）。
    await store.set({ ...rendererCopy, theme: 'dark' } as AppSettings)
    const raw = readRaw()
    expect(raw.projectSortMode).toBe('manual')
    expect(raw.git).toEqual({ contextInjection: false })
    expect(raw.knowledge).toEqual({ autoCompile: true })
    expect(raw.theme).toBe('dark')
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

// fs/promises 的 writeFile 包一层可编程 mock（默认全转发），用于验证写链
// 的容错。node:fs（本文件其余测试用的同步 API）不受影响。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

describe('SettingsStore — concurrent writers (PLAN-parallel-experts T10)', () => {
  it('two concurrent update() calls merge — neither field is lost', async () => {
    const store = await freshStore()
    await Promise.all([
      store.update(s => ({ ...s, theme: 'dark' })),
      store.update(s => ({ ...s, myName: 'other-writer' })),
    ])
    const raw = readRaw()
    expect(raw.theme).toBe('dark')
    expect(raw.myName).toBe('other-writer')
    expect(raw.activeProfileId).toBe('p1') // untouched fields survive too
  })

  it('a whole-file user save racing a small patch merges instead of rolling back', async () => {
    const store = await freshStore()
    const userSnapshot = await store.get()
    // 面板宽度更新与用户整块保存同时入队：链序 = 入队序，且 update 的「读」
    // 发生在自己链位内——宽度落在保存之后的文件上，用户的字段不被回滚。
    await Promise.all([
      store.set({ ...userSnapshot, theme: 'dark' } as AppSettings),
      store.update(s => ({ ...s, browser: { ...s.browser, paneWidth: 777 } })),
    ])
    const raw = readRaw()
    expect(raw.theme).toBe('dark')
    expect((raw as unknown as { browser?: { paneWidth?: number } }).browser?.paneWidth).toBe(777)
  })

  it('a failing write does not poison the chain — later writes still land', async () => {
    const store = await freshStore()
    const fsPromises = await import('node:fs/promises')
    const writeFileMock = vi.mocked(fsPromises.writeFile)
    writeFileMock.mockImplementationOnce(async () => { throw new Error('disk on fire') })
    try {
      await expect(store.set({ ...RAW_BASE, theme: 'dark' } as AppSettings)).rejects.toThrow('disk on fire')
      await store.set({ ...RAW_BASE, myName: 'after-failure' } as AppSettings)
    } finally {
      writeFileMock.mockImplementation(undefined)
    }
    expect(readRaw().myName).toBe('after-failure')
  })
})
