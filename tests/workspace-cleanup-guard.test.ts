import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The guard decides which workspace folders a conversation delete may take
// with it. The exclusions are the two shapes that point somewhere else:
// project jail roots (user-picked, shared by the whole project — and they
// COULD live inside the global workspace by the user's choice) and the
// startup backfill rows, which carry the global workspace dir ITSELF.

vi.mock('../src/main/storage/database', () => ({
  getDb: vi.fn(),
}))
vi.mock('../src/main/storage/settings-store', () => ({
  settingsStore: { get: vi.fn(async () => ({ workspaceDir: undefined })) },
}))
vi.mock('../src/main/storage/project-store', () => ({
  projectStore: { get: vi.fn(async () => null) },
}))
vi.mock('../src/main/storage/conversation.db', () => ({
  setConversationWorkspaceDir: vi.fn(),
}))
vi.mock('../src/main/storage/index', () => ({
  WORKSPACE_DIR: '/data/pulsemind/workspace',
  DATA_DIR: '/data/pulsemind',
  KNOWLEDGE_RAW_DIR: '/data/pulsemind/knowledge/raw',
  KNOWLEDGE_WIKI_DIR: '/data/pulsemind/knowledge/wiki',
  getBaseRawDir: () => '/data/pulsemind/knowledge/raw',
  getBaseWikiDir: () => '/data/pulsemind/knowledge/wiki',
}))

const { isDeletableConversationWorkspace, deleteConversationWorkspace } = await import('../src/main/storage/conversation-workspace')
const { getDb } = await import('../src/main/storage/database')

const BASE = '/home/user/pulsemind-workspace'

describe('workspace deletion guard (isDeletableConversationWorkspace)', () => {
  it('a minted per-conversation folder under the global base is deletable', () => {
    expect(isDeletableConversationWorkspace(`${BASE}/20261011120000`, null, BASE)).toBe(true)
    expect(isDeletableConversationWorkspace(`${BASE}/20261011120000`, 'default', BASE)).toBe(true)
  })

  it('a project-bound row is NEVER deletable — the dir is the project jail root', () => {
    // Even when the project dir sits INSIDE the global workspace by the
    // user's choice: the project check is the load-bearing one.
    expect(isDeletableConversationWorkspace(`${BASE}/my-project`, 'proj_1', BASE)).toBe(false)
  })

  it('a backfill row pointing at the global root itself is never deletable', () => {
    expect(isDeletableConversationWorkspace(BASE, null, BASE)).toBe(false)
  })

  it('a folder outside the current base is refused (the base moved via settings)', () => {
    expect(isDeletableConversationWorkspace('/old/base/20261011120000', null, BASE)).toBe(false)
  })

  it('no stored dir means nothing to delete', () => {
    expect(isDeletableConversationWorkspace(null, null, BASE)).toBe(false)
    expect(isDeletableConversationWorkspace(undefined, null, BASE)).toBe(false)
    expect(isDeletableConversationWorkspace('', null, BASE)).toBe(false)
  })
})

describe('deleteConversationWorkspace (best-effort by contract)', () => {
  const home = mkdtempSync(join(tmpdir(), 'pulsemind-ws-guard-'))

  function stubRow(row: { workspace_dir: string | null; project_id: string | null } | undefined) {
    ;(getDb as ReturnType<typeof vi.fn>).mockReturnValue({
      prepare: () => ({ get: () => row }),
    })
  }

  beforeEach(() => {
    vi.mocked(getDb).mockReset()
    delete (globalThis as { __wsBase?: string }).__wsBase
  })

  it('removes a real minted folder, recursively', async () => {
    const base = join(home, 'ws-root')
    const dir = join(base, '20261011120000')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'artifact.txt'), 'x')
    stubRow({ workspace_dir: dir, project_id: null })
    // Point the guard's base at the temp root: settingsStore.get is mocked to
    // return workspaceDir undefined → the module falls back to WORKSPACE_DIR,
    // so patch via the settings mock instead.
    const { settingsStore } = await import('../src/main/storage/settings-store')
    ;(settingsStore.get as ReturnType<typeof vi.fn>).mockResolvedValue({ workspaceDir: base })
    await expect(deleteConversationWorkspace('conv_1')).resolves.toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses (false, no IO) for a project-bound row', async () => {
    const base = join(home, 'ws-root2')
    const dir = join(base, 'project-dir')
    mkdirSync(dir, { recursive: true })
    stubRow({ workspace_dir: dir, project_id: 'proj_9' })
    const { settingsStore } = await import('../src/main/storage/settings-store')
    ;(settingsStore.get as ReturnType<typeof vi.fn>).mockResolvedValue({ workspaceDir: base })
    await expect(deleteConversationWorkspace('conv_2')).resolves.toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('false on a missing row — never throws', async () => {
    stubRow(undefined)
    await expect(deleteConversationWorkspace('conv_missing')).resolves.toBe(false)
  })
})
