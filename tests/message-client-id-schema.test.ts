import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ── B1-a（2026-11-17）：messages.client_message_id 加列铺路 ────────────────────
// The DB layer cannot run under plain Node (better-sqlite3 is Electron-ABI — the
// known coverage gap), so this pins the SCHEMA by source scan, the same
// discipline as cached-tokens-persistence: new databases get the column in
// CREATE TABLE, existing ones get the ALTER in the migration chain, and the
// unique index is built only AFTER that ALTER.
//
// That ordering is the actual regression risk, not the column itself:
// createTables' blanket exec runs on every startup, and on an existing database
// the column does not exist until the ALTER has run — an index placed in the
// earlier index block raises SQLITE_ERROR, which the init catch used to treat as
// corruption (it deleted the database). idx_memories_content_hash carries the
// same warning in-place.
//
// B1-a is deliberately zero-behaviour-change: nothing writes this column yet.
// B1-b lifts the submission uuid from the click through to this row, at which
// point the UNIQUE index becomes the real invariant instead of a second lock.

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('messages.client_message_id schema (B1-a)', () => {
  it('the messages table itself declares the column', () => {
    const src = read('src/main/storage/database.ts')
    const from = src.indexOf('CREATE TABLE IF NOT EXISTS messages (')
    expect(from).toBeGreaterThan(-1)
    const rest = src.slice(from)
    // Slice to this table's closing paren — a bare lazy [\s\S]*? match would
    // happily walk past the table and find the ALTER further down, which is
    // exactly the assertion this test must not let itself be fooled by.
    const table = rest.slice(0, rest.indexOf('\n    );'))
    expect(table).toContain('client_message_id TEXT')
  })

  it('the migration chain adds the column to existing databases', () => {
    const src = read('src/main/storage/database.ts')
    expect(src).toContain('ALTER TABLE messages ADD COLUMN client_message_id TEXT')
  })

  it('the index is UNIQUE, scoped to its conversation, and built AFTER the ALTER', () => {
    const src = read('src/main/storage/database.ts')
    const alter = src.indexOf('ALTER TABLE messages ADD COLUMN client_message_id TEXT')
    expect(alter).toBeGreaterThan(-1)

    const idx = src.search(/CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON messages\(conversation_id, client_message_id\)/)
    expect(idx).toBeGreaterThan(-1)
    // The whole point: an index before this ALTER breaks every existing database.
    expect(idx).toBeGreaterThan(alter)

    // Non-vacuity: a plain index enforces nothing, and a single-column index
    // would let the same id appear in two conversations.
    expect(src).not.toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON messages\(client_message_id\)/)
  })
})
