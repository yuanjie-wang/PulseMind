import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR, KNOWLEDGE_RAW_DIR } from './index'

const DB_PATH = join(DATA_DIR, 'db', 'pulsemind.db')

let db: Database.Database

function openDb(): Database.Database {
  console.log(`[DB] Opening database at ${DB_PATH}`)
  const conn = new Database(DB_PATH)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000')
  console.log('[DB] Database opened successfully')
  return conn
}

/** Get the current DB connection. Throws if not yet initialized. */
export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initializeDatabase() first.')
  return db
}

/** Verify the database connection is alive with a simple query. */
export function isDbHealthy(): boolean {
  if (!db) return false
  try {
    db.prepare('SELECT 1').get()
    return true
  } catch {
    return false
  }
}

/** Reconnect if the connection is unhealthy. Returns true after recovery or if already healthy. */
export function ensureDbHealthy(): boolean {
  if (isDbHealthy()) return true
  console.warn('[DB] Connection unhealthy, reinitializing...')
  reinitializeDb()
  return isDbHealthy()
}

export function reinitializeDb(): void {
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = undefined as any
  }
  db = openDb()
  console.log('[DB] Database connection reinitialized')
}

// ── Schema ──

function createTables(): void {
  const database = getDb()

  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL DEFAULT '新对话',
      type      TEXT NOT NULL DEFAULT 'normal',
      rect_id   TEXT,
      summary   TEXT,
      keywords  TEXT,
      pinned    INTEGER NOT NULL DEFAULT 0,
      plan_json TEXT,
      extracted_msg_count INTEGER NOT NULL DEFAULT 0,
      experience_extracted_count INTEGER NOT NULL DEFAULT 0,
      history_summary TEXT,
      history_summary_frontier TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content         TEXT NOT NULL DEFAULT '',
      content_blocks  TEXT,
      liked           INTEGER NOT NULL DEFAULT 0,
      favorited       INTEGER NOT NULL DEFAULT 0,
      processing_ms   INTEGER,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      auto_summary    INTEGER NOT NULL DEFAULT 0,
      compressed_ids  TEXT,
      created_at      TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);
    CREATE INDEX IF NOT EXISTS idx_conversations_rect_id ON conversations(rect_id);

    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'auto'
                    CHECK(type IN ('auto', 'manual', 'decision', 'fact', 'preference', 'experience')),
      category    TEXT NOT NULL DEFAULT 'general'
                    CHECK(category IN ('code', 'architecture', 'user_pref', 'decision', 'general', 'experience')),
      source      TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

    CREATE TABLE IF NOT EXISTS favorites (
      id                TEXT PRIMARY KEY,
      message_id        TEXT NOT NULL,
      conversation_id   TEXT NOT NULL,
      conversation_title TEXT NOT NULL DEFAULT '',
      role              TEXT NOT NULL DEFAULT 'assistant',
      content           TEXT NOT NULL DEFAULT '',
      content_blocks    TEXT,
      created_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_favorites_created_at ON favorites(created_at);
    CREATE INDEX IF NOT EXISTS idx_favorites_message_id ON favorites(message_id);

    CREATE TABLE IF NOT EXISTS token_usage (
      id             TEXT PRIMARY KEY,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);

    CREATE TABLE IF NOT EXISTS knowledge_files (
      id            TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      source_type   TEXT NOT NULL DEFAULT 'file'
                      CHECK(source_type IN ('file', 'url', 'experience')),
      source_url    TEXT,
      source_path   TEXT,
      conv_id       TEXT,
      content_hash  TEXT,
      status        TEXT NOT NULL DEFAULT 'raw'
                      CHECK(status IN ('raw', 'compiled')),
      wiki_outputs  TEXT,
      created_at    TEXT NOT NULL,
      compiled_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_files(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source_type ON knowledge_files(source_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_files(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_list_query ON knowledge_files(source_type, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_file_path ON knowledge_files(file_path);

    CREATE TABLE IF NOT EXISTS tool_results (
      ref_id          TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      block_index     INTEGER NOT NULL,
      tool_use_id     TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      is_error        INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tool_results_conv ON tool_results(conversation_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content, tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS tool_preferences (
      tool_name TEXT PRIMARY KEY,
      enabled   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS skill_preferences (
      id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
      enabled_skills          TEXT NOT NULL DEFAULT '[]',
      skill_keywords           TEXT NOT NULL DEFAULT '{}',
      processed_conversations TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS subagent_profiles (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      base_prompt         TEXT NOT NULL DEFAULT '',
      allowed_tools       TEXT NOT NULL DEFAULT '[]',
      allowed_mcp_servers TEXT NOT NULL DEFAULT '[]',
      allowed_skills      TEXT NOT NULL DEFAULT '[]',
      profile_id          TEXT,
      max_tokens          INTEGER,
      max_loop_iterations INTEGER,
      is_built_in         INTEGER NOT NULL DEFAULT 0,
      enabled             INTEGER NOT NULL DEFAULT 1
    );
  `)

  // ── Schema migrations for existing databases ──
  // ALTER TABLE will fail if column already exists, so we catch and ignore.
  try { database.exec('ALTER TABLE conversations ADD COLUMN summary TEXT') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN keywords TEXT') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN plan_json TEXT') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN extracted_msg_count INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN experience_extracted_count INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN history_summary TEXT') } catch (e) {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN history_summary_frontier TEXT') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN liked INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN processing_ms INTEGER') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN auto_summary INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE messages ADD COLUMN compressed_ids TEXT') } catch (e) {}
  // Ensure tool_results has the is_error column
  try { database.exec('ALTER TABLE tool_results ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0') } catch (e) {}
  try { database.exec('ALTER TABLE knowledge_files ADD COLUMN wiki_outputs TEXT') } catch (e) {}
}

// ── FTS5 helpers ──

function createMemoryFts(database: Database.Database): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, content=memories, content_rowid=rowid
    );
  `)
  database.exec('INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories;')
  console.log('[DB] Created memories_fts FTS5 table')
}

export function withFtsRecovery<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error: any) {
    if ((error as any)?.code === 'SQLITE_CORRUPT_VTAB') {
      console.warn('[DB] FTS corruption detected, rebuilding index and retrying...')
      const database = getDb()
      database.exec('DROP TABLE IF EXISTS memories_fts')
      createMemoryFts(database)
      return fn()
    }
    throw error
  }
}

// ── Init ──

export async function initializeDatabase(): Promise<void> {
  console.log('[DB] Initializing database...')
  db = openDb()
  try {
    createTables()
    createMemoryFts(getDb())
    console.log('[DB] Tables created/verified')

    try {
      getDb().prepare('SELECT rowid FROM memories_fts LIMIT 1').get()
    } catch (ftsError: any) {
      if (ftsError?.code === 'SQLITE_CORRUPT_VTAB') {
        console.warn('[DB] FTS corruption detected at startup, rebuilding...')
        const database = getDb()
        database.exec('DROP TABLE IF EXISTS memories_fts')
        createMemoryFts(database)
      } else throw ftsError
    }

    console.log('[DB] Database initialized')

    const ftsCount = (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_fts').get() as { c: number }).c
    if (ftsCount === 0) {
      const kfCount = (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_files').get() as { c: number }).c
      if (kfCount > 0) { console.log('[DB] Rebuilding knowledge_fts index...'); rebuildKnowledgeFts(KNOWLEDGE_RAW_DIR) }
    }

    // Sweep orphaned tool_results: tool_results.message_id has no FK, so message
    // deletion (replaceMessagesAtomic, crash-mid-save) leaves dead rows behind.
    // Idempotent — second run deletes 0 rows; keeps the table lean.
    const orphanCount = (getDb().prepare(
      `SELECT COUNT(*) as c FROM tool_results
       WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = tool_results.message_id)`
    ).get() as { c: number }).c
    if (orphanCount > 0) {
      getDb().prepare(
        `DELETE FROM tool_results
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = tool_results.message_id)`
      ).run()
      console.log(`[DB] Cleaned ${orphanCount} orphaned tool_result rows`)
    }

    const count = (getDb().prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number }).c
    console.log(`[DB] ${count} conversations in database`)
  } catch (e) {
    console.error('[DB] Initialization failed:', e)
    if (existsSync(DB_PATH) && db) {
      try { db.close() } catch { /* ignore */ }
      db = undefined as any
      console.warn('[DB] Deleting corrupt database and recreating...')
      await unlink(DB_PATH).catch(() => {})
      try { createTables(); createMemoryFts(getDb()); console.log('[DB] Database recreated successfully') } catch (e2) { console.error('[DB] Fatal: could not recreate database:', e2) }
    }
  }
}

// Circular-safe import: rebuildKnowledgeFts is called from initializeDatabase
// but lives in knowledge.db.ts. We import it lazily after init.
let _rebuildKnowledgeFts: ((rawDir: string) => void) | null = null
function rebuildKnowledgeFts(rawDir: string): void {
  if (!_rebuildKnowledgeFts) {
    _rebuildKnowledgeFts = require('./knowledge.db').rebuildKnowledgeFts
  }
  _rebuildKnowledgeFts(rawDir)
}
