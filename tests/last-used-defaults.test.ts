import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentSessionCreateOptions } from '../src/shared/agent-protocol'
import type { AppSettings } from '../src/shared/types/settings'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The import chain pulls real stores, so point HOME at a temp dir BEFORE any
// project import — a test must never write into the user's live ~/.pulsemind.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-last-used-'))
mkdirSync(join(process.env.HOME, '.pulsemind'), { recursive: true })
const SETTINGS_PATH = join(process.env.HOME, '.pulsemind', 'settings.json')

// conversation.db is better-sqlite3 (Electron ABI) and cannot load under plain
// node vitest. The seed gate's DB half — that the column writes really land and
// survive — is proven against the real database in
// scripts/probe-last-used-defaults.mjs; what vitest owns is the GATE (which
// writes happen for which create shape) and the REMEMBER (settings round-trip).
vi.mock('../src/main/storage/conversation.db', () => ({
  deriveConvType: (id: string) => (id.startsWith('conv_') ? 'normal' : id.slice(0, id.indexOf('_'))),
  getConversationApprovalMode: vi.fn(),
  getConversationProfileId: vi.fn(),
  setConversationApprovalMode: vi.fn(),
  setConversationProfile: vi.fn(),
}))

const dbMocks = await import('../src/main/storage/conversation.db')
const lastUsed = await import('../src/main/agent/last-used-defaults')

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf-8')

const SETTINGS = {
  activeProfileId: 'p1',
  profiles: [
    { id: 'p1', name: 'one', baseURL: 'https://a.invalid', model: 'm1', maxTokens: 1024 },
    { id: 'p2', name: 'two', baseURL: 'https://b.invalid', model: 'm2', maxTokens: 1024 },
  ],
  theme: 'light',
  myName: '',
  soul: '',
  yourName: '',
} as Record<string, unknown>

const asSettings = (extra: Record<string, unknown>): AppSettings => ({ ...SETTINGS, ...extra } as unknown as AppSettings)

// settings-store caches by file mtime in module state; a fresh module registry
// per test keeps reads honest even when two writes land within one mtime tick
// (same recipe as tests/settings-store.test.ts). Must re-import
// last-used-defaults too, or its captured settingsStore is the stale one.
async function fresh() {
  vi.resetModules()
  const store = await import('../src/main/storage/settings-store')
  const lu = await import('../src/main/agent/last-used-defaults')
  return { settingsStore: store.settingsStore, ...lu }
}

function writeRaw(extra: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ ...SETTINGS, ...extra }, null, 2), 'utf-8')
}

const opts = (over: Partial<AgentSessionCreateOptions> = {}): AgentSessionCreateOptions => ({ ...over })

beforeEach(() => {
  vi.mocked(dbMocks.getConversationApprovalMode).mockReset()
  vi.mocked(dbMocks.getConversationProfileId).mockReset()
  vi.mocked(dbMocks.setConversationApprovalMode).mockClear()
  vi.mocked(dbMocks.setConversationProfile).mockClear()
  vi.mocked(dbMocks.getConversationApprovalMode).mockReturnValue(undefined)
  vi.mocked(dbMocks.getConversationProfileId).mockReturnValue(undefined)
})

// ── settings round-trip: the two keys must survive get()'s field-by-field
// rebuild — the optional-group disease (review 2026-09-18 H1/H2) is the exact
// way a new settings key silently dies: written, unreadable, then erased by
// the next whole-object save. ──
describe('last-used keys survive the settings.json round-trip', () => {
  it('get() parses both keys from the raw file', async () => {
    writeRaw({ lastUsedApprovalMode: 'outside-ask', lastUsedProfileId: 'p2' })
    const { settingsStore } = await fresh()
    const s = await settingsStore.get()
    expect(s.lastUsedApprovalMode).toBe('outside-ask')
    expect(s.lastUsedProfileId).toBe('p2')
  })

  it('an invalid approval value falls back to undefined, not the whole file', async () => {
    writeRaw({ lastUsedApprovalMode: 'yolo' })
    const { settingsStore } = await fresh()
    const s = await settingsStore.get()
    expect(s.lastUsedApprovalMode).toBeUndefined()
    expect(s.activeProfileId).toBe('p1')
  })

  it('remember writes the value into the real file (merge-shaped update)', async () => {
    writeRaw({})
    const { settingsStore, rememberLastUsedApprovalMode, rememberLastUsedProfileId } = await fresh()
    await rememberLastUsedApprovalMode('always-ask')
    await rememberLastUsedProfileId('p2')
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    expect(raw.lastUsedApprovalMode).toBe('always-ask')
    expect(raw.lastUsedProfileId).toBe('p2')
    expect(raw.activeProfileId).toBe('p1')
    const s = await settingsStore.get()
    expect(s.lastUsedApprovalMode).toBe('always-ask')
  })

  it('a file without the keys reads as undefined (fresh install)', async () => {
    writeRaw({})
    const { settingsStore } = await fresh()
    const s = await settingsStore.get()
    expect(s.lastUsedApprovalMode).toBeUndefined()
    expect(s.lastUsedProfileId).toBeUndefined()
  })
})

// ── the seed gate: which create shapes take last-used as their initial value ──
describe('seedLastUsedDefaults — new conversations start at last-used', () => {
  it('a plain conversation with nothing pinned seeds BOTH columns', () => {
    const settings = asSettings({ lastUsedApprovalMode: 'auto', lastUsedProfileId: 'p2' })
    lastUsed.seedLastUsedDefaults('conv_probe_a', opts(), settings)
    expect(dbMocks.setConversationApprovalMode).toHaveBeenCalledWith('conv_probe_a', 'auto')
    expect(dbMocks.setConversationProfile).toHaveBeenCalledWith('conv_probe_a', 'p2')
  })

  it('no last-used yet (fresh install) → no writes, old rules stand', () => {
    lastUsed.seedLastUsedDefaults('conv_probe_b', opts(), asSettings({ }))
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })

  it('a create-time approval pin (a routine run) is respected, not overwritten', () => {
    const settings = asSettings({ lastUsedApprovalMode: 'auto' })
    lastUsed.seedLastUsedDefaults('conv_probe_c', opts({ approvalMode: 'always-ask' }), settings)
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })

  it('a create-time model pin or a derived session (prompt/tool/expert) opts out entirely', () => {
    const settings = asSettings({ lastUsedApprovalMode: 'auto', lastUsedProfileId: 'p2' })
    lastUsed.seedLastUsedDefaults('conv_probe_d', opts({ profileId: 'p1' }), settings)
    lastUsed.seedLastUsedDefaults('conv_probe_d', opts({ systemPromptOverride: 'x' }), settings)
    lastUsed.seedLastUsedDefaults('conv_probe_d', opts({ allowedTools: ['read'] }), settings)
    lastUsed.seedLastUsedDefaults('conv_probe_d', opts({ expertProfile: { id: 'e', name: 'E', basePrompt: 'b' } }), settings)
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })

  it('a conversation that already carries its own choice is never touched (old conversations keep their config)', () => {
    vi.mocked(dbMocks.getConversationApprovalMode).mockReturnValue('outside-ask')
    vi.mocked(dbMocks.getConversationProfileId).mockReturnValue('p1')
    const settings = asSettings({ lastUsedApprovalMode: 'auto', lastUsedProfileId: 'p2' })
    lastUsed.seedLastUsedDefaults('conv_probe_e', opts(), settings)
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })

  it('a half-chosen conversation only gets its missing half', () => {
    vi.mocked(dbMocks.getConversationApprovalMode).mockReturnValue('outside-ask')
    const settings = asSettings({ lastUsedApprovalMode: 'auto', lastUsedProfileId: 'p2' })
    lastUsed.seedLastUsedDefaults('conv_probe_f', opts(), settings)
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).toHaveBeenCalledWith('conv_probe_f', 'p2')
  })

  it('a dangling lastUsedProfileId (profile deleted) is not seeded', () => {
    const settings = asSettings({ lastUsedProfileId: 'gone' })
    lastUsed.seedLastUsedDefaults('conv_probe_g', opts(), settings)
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })

  it('canvas/spawn ids (non-normal type) are out of scope', () => {
    const settings = asSettings({ lastUsedApprovalMode: 'auto', lastUsedProfileId: 'p2' })
    lastUsed.seedLastUsedDefaults('rect_abc', opts(), settings)
    lastUsed.seedLastUsedDefaults('sub_abc', opts(), settings)
    expect(dbMocks.setConversationApprovalMode).not.toHaveBeenCalled()
    expect(dbMocks.setConversationProfile).not.toHaveBeenCalled()
  })
})

// ── wiring scans — vitest here is node-env (no React mount), so the four
// write doors and the renderer fallbacks are asserted as source, with exact
// substrings so a revert fails the scan instead of passing vacuously. ──
describe('last-used wiring', () => {
  it('the desktop IPC doors remember user picks but not the studio seed', () => {
    const handler = read('../src/main/ipc/conversation.handler.ts')
    expect(handler).toContain("if (source !== 'derived') rememberLastUsedApprovalMode(mode)")
    expect(handler).toContain("if (profileId && source !== 'derived') rememberLastUsedProfileId(profileId)")
    const studio = read('../src/renderer/src/tool-studio/useStudioSession.ts')
    expect(studio).toContain("setConversationApprovalMode(convId, 'auto', 'derived')")
    const bridge = read('../src/shared/types/electron-bridge.ts')
    expect(bridge).toContain("source?: 'user' | 'derived'")
    const preload = read('../src/preload/index.ts')
    expect(preload).toContain('CONVERSATION_SET_APPROVAL_MODE, id, mode, source')
    expect(preload).toContain('CONVERSATION_SET_PROFILE, id, profileId, source')
  })

  it('the panel doors remember in session-manager', () => {
    const sm = read('../src/main/agent/session-manager.ts')
    expect(sm).toContain('rememberLastUsedApprovalMode(mode)')
    expect(sm).toContain('rememberLastUsedProfileId(profileId)')
    // Changing the DEFAULT model is a model expression too — setActiveProfile
    // must remember it, or a default switch stops reaching new conversations.
    expect(sm).toContain('rememberLastUsedProfileId(profile.id)')
  })

  it('doCreateSession seeds, and the seed precedes the resolution it feeds', () => {
    const sm = read('../src/main/agent/session-manager.ts')
    const seed = sm.indexOf('seedLastUsedDefaults(sessionId, opts, settings)')
    const resolve = sm.indexOf('resolveProfile(opts.profileId')
    expect(seed).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(-1)
    expect(seed).toBeLessThan(resolve)
  })

  it('the settings editor save carries main-side last-used forward and remembers a default-model change', () => {
    const handler = read('../src/main/ipc/settings.handler.ts')
    expect(handler).toContain('settings.lastUsedApprovalMode = current.lastUsedApprovalMode')
    expect(handler).toContain('settings.lastUsedProfileId = current.lastUsedProfileId')
    expect(handler).toContain('settings.lastUsedProfileId = settings.activeProfileId')
  })

  it('the welcome composer resolves its fallback through last-used, and only the welcome branch does', () => {
    const app = read('../src/renderer/src/App.tsx')
    expect(app).toContain('pendingApprovalMode ?? settings.lastUsedApprovalMode ?? DEFAULT_APPROVAL_MODE')
    expect(app).toContain('pendingProfileId ?? settings.lastUsedProfileId ?? settings.activeProfileId')
    // An EXISTING conversation with no column still falls back to the shared
    // default — that is what the engine resolves for it. Seeding last-used
    // into new conversations at creation is what keeps this asymmetry honest.
    expect(app).toContain('activeConvProfileId ?? settings.activeProfileId')
    // The controller gets the values for materialization seeding.
    expect(app).toContain('lastUsedApprovalMode: settings.lastUsedApprovalMode')
    expect(app).toContain('lastUsedProfileId: settings.lastUsedProfileId')
    // Entering welcome re-reads settings — panel-side changes land in main only.
    expect(app).toContain('if (!activeConvKey) void reloadSettings()')
  })

  it('the materialization seeds the new conversation before startLoop', () => {
    const ctrl = read('../src/renderer/src/hooks/useChatController.ts')
    const approvalSeed = ctrl.indexOf('const approvalSeed = takePendingApprovalMode() ?? options.lastUsedApprovalMode')
    const profileSeed = ctrl.indexOf('const profileSeed = takePendingProfileId() ?? options.lastUsedProfileId')
    const loop = ctrl.indexOf('startLoop(content, knowledgeBase, forcedSkills)')
    expect(approvalSeed).toBeGreaterThan(-1)
    expect(profileSeed).toBeGreaterThan(approvalSeed)
    expect(loop).toBeGreaterThan(-1)
    expect(profileSeed).toBeLessThan(loop)
  })
})
