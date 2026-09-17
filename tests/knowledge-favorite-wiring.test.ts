// ── Knowledge favorite wiring (PLAN-settings-restructure P2) ──
// The favorites surface is DELETED and the capture channel that replaced it is
// wired across five layers by hand — channel constant, main handler, preload
// method, bridge type, and the renderer's ambient re-export. Nothing else can
// see that wiring: vitest is node-env (no ipcMain, no preload) and the real IPC
// path is the probe's job. So the five hops are asserted as source, plus the
// two shapes that must NOT come back (the old favorites API, a title+date path)
// and the schema facts the migration depends on.
// Non-vacuity for every assertion is noted inline (what breaks when it goes).

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

/** Every .ts/.tsx under a directory, for the "nothing still references it" walks. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(rel))
    else if (/\.tsx?$/.test(entry.name)) out.push(rel)
  }
  return out
}

describe('knowledge favorite channel — five layers', () => {
  it('declares the channel constant', () => {
    expect(read('src/shared/ipc-channels.ts')).toMatch(/KNOWLEDGE_WRITE_FAVORITE: 'knowledge:write-favorite'/)
  })

  it('registers the main handler with withRawResponse (failures must reject)', () => {
    const handler = read('src/main/ipc/knowledge.handler.ts')
    expect(handler).toMatch(/ipcMain\.handle\(IPC_CHANNELS\.KNOWLEDGE_WRITE_FAVORITE, withRawResponse/)
    // A success envelope would make a failed capture look saved — the renderer
    // flips its marker on resolve, so the throw IS the contract.
    expect(handler).not.toMatch(/success: false/)
  })

  it('exposes the preload method', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toMatch(/knowledgeWriteFavorite: \(data: \{[^}]*\}\)[\s\S]{0,80}IPC_CHANNELS\.KNOWLEDGE_WRITE_FAVORITE/)
  })

  it('declares the bridge type and re-exports it to the renderer', () => {
    const bridge = read('src/shared/types/electron-bridge.ts')
    expect(bridge).toMatch(/knowledgeWriteFavorite: \(data: \{ content: string; messageId: string; conversationId: string; title\?: string \}\) => Promise<KnowledgeFile>/)
    expect(read('src/renderer/src/types/electron.d.ts')).toMatch(/export \* from '\.\.\/\.\.\/\.\.\/shared\/types\/electron-bridge'/)
  })
})

describe('the old favorites surface is gone', () => {
  it('the three implementation files are deleted', () => {
    for (const p of [
      'src/main/ipc/favorites.handler.ts',
      'src/main/storage/favorites.db.ts',
      'src/renderer/src/components/settings/FavoritesSettings.tsx'
    ]) {
      expect(existsSync(join(ROOT, p)), `${p} is back`).toBe(false)
    }
  })

  it('nothing under src/ calls the removed API or channel', () => {
    const stale = /addFavorite|removeFavorite|listFavorites|FAVORITE_ADD|FAVORITE_LIST|FAVORITE_REMOVE|FavoritesSettings|favoritesDrawer|favorites\.db|appLayout\.favorites/
    const files = walk('src')
    expect(files.length).toBeGreaterThan(100) // non-vacuity: the walk really walked
    for (const f of files) {
      expect(read(f), `${f} still references the deleted favorites surface`).not.toMatch(stale)
    }
  })

  it('no ipcMain handle registers a favorites channel any more', () => {
    const ipcIndex = read('src/main/ipc/index.ts')
    expect(ipcIndex).not.toMatch(/registerFavoriteHandlers|favorites\.handler/)
    expect(ipcIndex).toMatch(/registerKnowledgeHandlers\(\)/)
  })

  it('the favorites table is dropped once and never created again', () => {
    const db = read('src/main/storage/database.ts')
    expect(db).toMatch(/DROP TABLE IF EXISTS favorites/)
    // Non-vacuity: a re-added CREATE would make the DROP a no-op every start.
    expect(db).not.toMatch(/CREATE TABLE IF NOT EXISTS favorites/)
  })
})

describe('the capture is idempotent by identity, not by title+date', () => {
  const store = read('src/main/storage/knowledge-store.ts')

  it('the raw filename is hashed over conversation+message', () => {
    expect(store).toMatch(/export function favoriteRawFileName\(conversationId: string, messageId: string\)/)
    const fn = store.slice(store.indexOf('export function favoriteRawFileName'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/createHash\('sha256'\)/)
    expect(body).toMatch(/`\$\{conversationId\}\\u0000\$\{messageId\}`/)
    // The experience dedup comment records what title+date costs (same title,
    // same day → overwrite a file, insert a second row, orphan the path).
    expect(body).not.toMatch(/title|Date/)
  })

  it('frontmatter carries the message-level source fields', () => {
    const fn = store.slice(store.indexOf('export function buildFavoriteFrontmatter'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/source_type: 'favorite'/)
    expect(body).toMatch(/source_msg_id: input\.messageId/)
    expect(body).toMatch(/source_conv_id: input\.conversationId/)
  })

  it('the CHECK constraint admits the favorite source and is probed for a rebuild', () => {
    const db = read('src/main/storage/database.ts')
    expect(db).toMatch(/CHECK\(source_type IN \('file', 'url', 'experience', 'favorite'\)\)/)
    // PRAGMA table_info cannot see a CHECK, so the probe must read sqlite_master.
    const migration = db.slice(db.indexOf('function migrateKnowledgeFavoriteSource'))
    expect(migration).toMatch(/SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_files'/)
    expect(migration).toMatch(/includes\("'favorite'"\)/)
    // rowid is what FTS addresses rows by — inserting without it breaks search.
    expect(migration).toMatch(/INSERT INTO knowledge_files_new\n?\s*\(rowid,/)
    expect(migration).toMatch(/SELECT rowid, id, file_path/)
  })
})
