import { existsSync, readdirSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { memoryContentHash } from '../../shared/memory/content-hash'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DATA_DIR, KNOWLEDGE_RAW_DIR, KNOWLEDGE_WIKI_DIR, getBaseRawDir, getBaseWikiDir } from './index'

const DB_PATH = join(DATA_DIR, 'db', 'pulsemind.db')

let db: Database.Database

function openDb(): Database.Database {
  console.log(`[DB] Opening database at ${DB_PATH}`)
  const conn = new Database(DB_PATH)
  // journal_mode persists in the file; every setting below it is per-connection,
  // which is why this function is the single choke point (reinitializeDb too).
  conn.pragma('journal_mode = WAL')
  // WAL + FULL fsyncs on every commit, and a message save is one commit — the
  // agent streams them by the dozen. NORMAL keeps WAL durability (a crash can
  // lose the last commits, not corrupt the file) at a fraction of the writes.
  conn.pragma('synchronous = NORMAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000')
  // Page cache, negative = KiB. Default is 2 MiB — a conversation-list scan
  // plus an FTS query already blows through it.
  conn.pragma('cache_size = -32768')
  // Read-only mmap: turns the hot scans (listConversations, FTS) into page-table
  // lookups instead of read() syscalls.
  conn.pragma('mmap_size = 268435456')
  // Otherwise sorting/grouping spills to a temp file — the stats aggregates sort
  // by an expression, so they always spill.
  conn.pragma('temp_store = MEMORY')
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
      project_id TEXT,
      workspace_dir TEXT,
      plan_json TEXT,
      extracted_msg_count INTEGER NOT NULL DEFAULT 0,
      experience_extracted_count INTEGER NOT NULL DEFAULT 0,
      history_summary TEXT,
      history_summary_frontier TEXT,
      tab_key TEXT,
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
      cached_tokens   INTEGER,
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
      updated_at  TEXT NOT NULL,
      content_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

    CREATE TABLE IF NOT EXISTS token_usage (
      id             TEXT PRIMARY KEY,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cached_tokens  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);

    CREATE TABLE IF NOT EXISTS knowledge_files (
      id            TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      source_type   TEXT NOT NULL DEFAULT 'file'
                      CHECK(source_type IN ('file', 'url', 'experience', 'favorite')),
      source_url    TEXT,
      source_path   TEXT,
      conv_id       TEXT,
      content_hash  TEXT,
      status        TEXT NOT NULL DEFAULT 'raw'
                      CHECK(status IN ('raw', 'compiled')),
      wiki_outputs  TEXT,
      created_at    TEXT NOT NULL,
      compiled_at   TEXT,
      base_id       TEXT NOT NULL DEFAULT 'default'
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_files(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_source_type ON knowledge_files(source_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_files(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_list_query ON knowledge_files(source_type, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_file_path ON knowledge_files(file_path);

    -- Knowledge bases: each base has physical file isolation (raw/ + wiki/).
    -- The 'default' base is implicit and cannot be deleted.
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      color_hue  INTEGER,
      created_at TEXT NOT NULL
    );

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
      content, file_rowid UNINDEXED, chunk_offset UNINDEXED, tokenize='trigram'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_wiki_fts USING fts5(
      title, content, path UNINDEXED, base_id UNINDEXED, tokenize='trigram'
    );

    CREATE TABLE IF NOT EXISTS tool_preferences (
      tool_name TEXT PRIMARY KEY,
      enabled   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS skill_preferences (
      id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
      -- enabled_skills is a legacy snapshot kept for read-back/diagnostics only;
      -- the authoritative switch is disabled_skills (empty = all skills on).
      enabled_skills          TEXT NOT NULL DEFAULT '[]',
      disabled_skills         TEXT NOT NULL DEFAULT '[]',
      skill_keywords           TEXT NOT NULL DEFAULT '{}',
      processed_conversations TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS experiences (
      id                    TEXT PRIMARY KEY,
      name                  TEXT UNIQUE NOT NULL,
      title                 TEXT NOT NULL,
      description           TEXT NOT NULL DEFAULT '',
      category              TEXT NOT NULL DEFAULT 'general',
      source_conversation_id TEXT,
      created_at            TEXT NOT NULL,
      last_used_at          TEXT,
      use_count             INTEGER NOT NULL DEFAULT 0,
      triggers              TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_experiences_created_at ON experiences(created_at);
    CREATE INDEX IF NOT EXISTS idx_experiences_last_used ON experiences(last_used_at);

    -- 记忆页（PLAN-memory-wiki，2026-10-25）：记忆 wiki 化的统一存储，记忆与经验
    -- （type='experience'）同库同协议。title 与 alias 共用一个 NOCASE 命名空间，
    -- 唯一性由写路径（memory-pages-store 的冲突判定）保证——title 上不放 UNIQUE
    -- 是因为 COLLATE NOCASE 的 UNIQUE 与迁移期大小写变体兼容性由显式判定更可控。
    -- FTS 独立表（无 content=）：memories_fts 的 external content + 手工同步是
    -- 已付过学费的坑；trigram 是中文子串的正解（knowledge_fts 同款）。
    CREATE TABLE IF NOT EXISTS memory_pages (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      type                  TEXT NOT NULL CHECK(type IN ('preference', 'decision', 'fact', 'experience')),
      body                  TEXT NOT NULL,
      aliases               TEXT NOT NULL DEFAULT '[]',
      links                 TEXT NOT NULL DEFAULT '[]',
      superseded_by         TEXT,
      source_conversation_id TEXT,
      files_json            TEXT,
      maturity              TEXT NOT NULL DEFAULT 'clue',
      recurrence            INTEGER NOT NULL DEFAULT 0,
      last_reinforced_at    TEXT,
      sop_attempts          INTEGER NOT NULL DEFAULT 0,
      sop_last_attempt_at   TEXT,
      enabled               INTEGER NOT NULL DEFAULT 1,
      use_count             INTEGER NOT NULL DEFAULT 0,
      last_used_at          TEXT,
      content_hash          TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_pages_type ON memory_pages(type);
    CREATE INDEX IF NOT EXISTS idx_memory_pages_updated ON memory_pages(updated_at DESC);

    -- 技能使用计数（2026-10-27）：pick_skill 选中已注册技能时 +1（经验页的对应物是
    -- memory_pages.use_count）。按技能名键控——内置技能不在任何表里，这是它们唯一的
    -- 持久化落点；技能被删除时行留着无害（重装同名即续计）。
    CREATE TABLE IF NOT EXISTS skill_uses (
      name          TEXT PRIMARY KEY,
      use_count     INTEGER NOT NULL DEFAULT 0,
      last_used_at  TEXT
    );
    -- E3（PLAN-capability-followups）：一句话结论，recall/卡片描述消费；旧行 NULL。

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_pages_fts USING fts5(
      title, aliases_text, body, page_id UNINDEXED, tokenize='trigram'
    );

    -- 专家配置包：只描述身份 + 绑定知识 + 托管参数。旧的 allowed_tools /
    -- allowed_mcp_servers / allowed_skills / is_built_in / summonable 已废弃
    -- （能力与全局保持一致）；老库里的这些列原样留着不删，见下方迁移说明。
    CREATE TABLE IF NOT EXISTS subagent_profiles (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      base_prompt         TEXT NOT NULL DEFAULT '',
      description         TEXT NOT NULL DEFAULT '',
      icon                TEXT,
      methodology         TEXT NOT NULL DEFAULT '',
      output_spec         TEXT NOT NULL DEFAULT '',
      constraints         TEXT NOT NULL DEFAULT '',
      knowledge_file_ids  TEXT NOT NULL DEFAULT '[]',
      profile_id          TEXT,
      max_tokens          INTEGER,
      max_loop_iterations INTEGER,
      enabled             INTEGER NOT NULL DEFAULT 1
    );
  `)

  // ── Schema migrations for existing databases ──
  // ALTER TABLE will fail if column already exists, so we catch and ignore.
  try { database.exec('ALTER TABLE conversations ADD COLUMN summary TEXT') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN keywords TEXT') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN plan_json TEXT') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN origin TEXT') } catch {}
  // 2026-11-03 扩展面板按 Chrome 页签隔离历史：tab_key 与 origin 同由
  // updateConversationOrigin 盖章（NULL = 未归属，由第一个打开的页签收养）。
  try { database.exec('ALTER TABLE conversations ADD COLUMN tab_key TEXT') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN extracted_msg_count INTEGER NOT NULL DEFAULT 0') } catch {}
  // P0 (PLAN-memory-extraction-dedup): memories carry a normalized-content hash for
  // the save-layer dedup gate; existing rows are backfilled once here.
  try { database.exec('ALTER TABLE memories ADD COLUMN content_hash TEXT') } catch {}
  // The index must come AFTER the ALTER: createTables' blanket exec runs on
  // every startup, and on an existing database the column only exists once
  // this ALTER has run — an index there failed with SQLITE_ERROR, which the
  // init catch used to treat as corruption (database deleted). Never add a
  // new-column index to that exec.
  try { database.exec('CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash)') } catch {}
  try { database.exec('ALTER TABLE experiences ADD COLUMN files_json TEXT') } catch {}
  // E3（PLAN-capability-followups）：记忆页一句话结论（recall 信封/卡片描述）。
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN summary TEXT') } catch {}
  // PLAN-experience-sop 刀一：经验页成熟度（files ⇒ 'sop' 派生，存储层执法）+
  // reinforce 重现记账（二阶段自动固化的资格信号）。
  try { database.exec("ALTER TABLE memory_pages ADD COLUMN maturity TEXT NOT NULL DEFAULT 'clue'") } catch {}
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN recurrence INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN last_reinforced_at TEXT') } catch {}
  // PLAN-experience-sop 刀四：自动固化的失败记账（24h 退避 + 3 次退役）。
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN sop_attempts INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN sop_last_attempt_at TEXT') } catch {}
  // 2026-10-27 经验卡开关（经验也是技能）：停用 = 不进候选/提示/自动固化；旧行默认启用。
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1') } catch {}
  // 2026-10-27 退役软态（compile pass 的 retire op）：过时页退出活页池，行保留、
  // 理由留档、UI 可恢复；旧行 NULL = 活页。
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN retired_at TEXT') } catch {}
  try { database.exec('ALTER TABLE memory_pages ADD COLUMN retire_reason TEXT') } catch {}
  try {
    const missing = database.prepare('SELECT id, content FROM memories WHERE content_hash IS NULL').all() as Array<{ id: string; content: string }>
    if (missing.length > 0) {
      const upd = database.prepare('UPDATE memories SET content_hash = ? WHERE id = ?')
      const backfill = database.transaction(() => {
        for (const row of missing) upd.run(memoryContentHash(row.content), row.id)
      })
      backfill()
      console.log(`[DB] backfilled ${missing.length} memory content hash(es)`)
    }
  } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN experience_extracted_count INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN history_summary TEXT') } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN history_summary_frontier TEXT') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN liked INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN processing_ms INTEGER') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN cached_tokens INTEGER') } catch {}
  // cached_tokens (2026-10-24): the provider-reported prefix-cache hit share of
  // input_tokens. Without it the DB cannot answer "what did this task actually
  // cost" once the llm-requests dumps are pruned — a 410-request translation
  // task left only its last 60 dumps, and its true 83% hit rate had to be
  // reconstructed by hand from those.
  try { database.exec('ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN auto_summary INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE messages ADD COLUMN compressed_ids TEXT') } catch {}
  // Ensure tool_results has the is_error column
  try { database.exec('ALTER TABLE tool_results ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0') } catch {}
  try { database.exec('ALTER TABLE knowledge_files ADD COLUMN wiki_outputs TEXT') } catch {}
  try { database.exec("ALTER TABLE experiences ADD COLUMN triggers TEXT NOT NULL DEFAULT '[]'") } catch {}
  // PLAN-experience-iteration: `updated_at` marks a record as iterated (set only
  // when a targetName save lands with a changed content hash), `content_hash`
  // is the save-layer gate that skips a no-op SKILL.md rewrite.
  try { database.exec('ALTER TABLE experiences ADD COLUMN updated_at TEXT') } catch {}
  try { database.exec('ALTER TABLE experiences ADD COLUMN content_hash TEXT') } catch {}
  // PLAN-experience-outcome M1: real-execution outcome counters {ok, fail,
  // lastOutcomeAt} — written by the exec settlement's static script matcher,
  // read by the envelope tail / panel. Never touched by save() (the upsert's
  // column list omits it, so revisions preserve the counters).
  try { database.exec('ALTER TABLE experiences ADD COLUMN outcome_json TEXT') } catch {}
  // 2026-11-04: skills default to ON (user ruling 「把缺省当作打开就行」). The
  // old `enabled_skills` list stops driving state — an imported/template skill
  // missing from it used to come up disabled on every fresh install. The new
  // authoritative column is the explicit opt-OUT list; absent/NULL = all on.
  try { database.exec("ALTER TABLE skill_preferences ADD COLUMN disabled_skills TEXT NOT NULL DEFAULT '[]'") } catch {}

  // ── PLAN-0.4.0 M3/M6: projects, routine-run history, audit log ──
  // Projects are named fixed workspaces picked on the welcome page (the
  // management UI is gone). `sandbox_json` is a leftover of the removed
  // sandbox-policy era: fresh schemas get a DEFAULT, project-store.create
  // always writes '{}', nothing reads it.
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      overview      TEXT,
      icon          TEXT,
      color_hue     INTEGER,
      sandbox_json  TEXT NOT NULL DEFAULT '{}',
      sort_order    INTEGER,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routine_runs (
      id              TEXT PRIMARY KEY,
      routine_id      TEXT NOT NULL,
      conversation_id TEXT,
      status          TEXT NOT NULL,
      trigger         TEXT NOT NULL,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id              TEXT PRIMARY KEY,
      workflow_id     TEXT NOT NULL,
      workflow_name   TEXT NOT NULL,
      objective       TEXT,
      baseline_commit TEXT,
      workspace_dir   TEXT,
      status          TEXT NOT NULL,
      current_node    TEXT,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS pipeline_stage_runs (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      node_id         TEXT NOT NULL,
      verdict         TEXT,
      continues       INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      error           TEXT,
      artifacts_json  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pipeline_stage_runs_run ON pipeline_stage_runs(run_id, started_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      scope       TEXT NOT NULL,
      actor       TEXT,
      action      TEXT NOT NULL,
      target      TEXT,
      decision    TEXT NOT NULL,
      policy_json TEXT,
      meta_json   TEXT
    );

    CREATE TABLE IF NOT EXISTS browser_history (
      url           TEXT PRIMARY KEY,
      title         TEXT,
      visit_count   INTEGER NOT NULL DEFAULT 1,
      last_visit_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_favorites (
      url        TEXT PRIMARY KEY,
      title      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

  `)
  // Conversations keep their project binding (welcome page picker); existing
  // databases get the column here.
  try { database.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT') } catch {}
  // The project's identity hue moved from "hashed at render" to a stored field
  // (2026-09-16); rows created before it keep NULL until the startup backfill
  // fills them from their name — which is exactly what the renderer derived.
  try { database.exec('ALTER TABLE projects ADD COLUMN color_hue INTEGER') } catch { /* column may already exist */ }
  // Manual order from the sidebar's drag-to-reorder (2026-09-17). NULL = never
  // dragged: those rows keep their created_at order in the 'manual' sort mode,
  // so a project created after the last drag still appears newest-first.
  try { database.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER') } catch { /* column may already exist */ }
  // ≤50 字的项目概述 (2026-09-18). NULL/空 = 用户没写：会话提示词的 `## Project`
  // 小节整个不出现，而不是拼一行空的。
  try { database.exec('ALTER TABLE projects ADD COLUMN overview TEXT') } catch { /* column may already exist */ }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `)
  // ── PLAN-0.4.0 M8: per-conversation working directory ──
  // Backfill for existing rows happens in conversation-workspace.ts at startup
  // (it needs settings.workspaceDir, which is not readable synchronously here).
  try { database.exec('ALTER TABLE conversations ADD COLUMN workspace_dir TEXT') } catch { /* column may already exist */ }
  // Every conversation not explicitly bound to a project belongs to the
  // synthesized default project.
  try { database.exec("UPDATE conversations SET project_id = 'default' WHERE project_id IS NULL") } catch {}
  // ── PLAN-routine-batch: batch bookkeeping on routine_runs ──
  // parent_run_id is what makes a row a batch CHILD (parents and single runs
  // leave it NULL — the flat run history filters on that); row_index locates
  // the CSV data row, params_json snapshots the values the row ran with (the
  // retry path reads the snapshot, not the file — it may have changed), and
  // batch_json on the PARENT row records what the batch launched with. The
  // index must come after the ALTERs: on a database from before this version
  // the column does not exist until the line above adds it.
  try { database.exec('ALTER TABLE routine_runs ADD COLUMN parent_run_id TEXT') } catch { /* column may already exist */ }
  try { database.exec('ALTER TABLE routine_runs ADD COLUMN row_index INTEGER') } catch { /* column may already exist */ }
  try { database.exec('ALTER TABLE routine_runs ADD COLUMN params_json TEXT') } catch { /* column may already exist */ }
  try { database.exec('ALTER TABLE routine_runs ADD COLUMN batch_json TEXT') } catch { /* column may already exist */ }
  database.exec('CREATE INDEX IF NOT EXISTS idx_routine_runs_parent ON routine_runs(parent_run_id)')
  // ── 专家配置包 (expert config packs): extended subagent_profiles + per-conversation binding ──
  for (const col of ['description TEXT', 'methodology TEXT', 'output_spec TEXT', 'constraints TEXT', 'knowledge_file_ids TEXT']) {
    try { database.exec(`ALTER TABLE subagent_profiles ADD COLUMN ${col}`) } catch {}
  }
  try { database.exec('ALTER TABLE subagent_profiles ADD COLUMN icon TEXT') } catch {}
  // 引用关系（技能名 / 连接器 id）：专家点名自己常用的技能与连接器，随指令注入，
  // 但不是权限白名单 —— 能力仍然与全局一致。
  for (const col of ['skill_names TEXT', 'mcp_server_ids TEXT']) {
    try { database.exec(`ALTER TABLE subagent_profiles ADD COLUMN ${col}`) } catch {}
  }
  try { database.exec("UPDATE subagent_profiles SET description = '' WHERE description IS NULL") } catch {}
  try { database.exec("UPDATE subagent_profiles SET knowledge_file_ids = '[]' WHERE knowledge_file_ids IS NULL") } catch {}
  try { database.exec('ALTER TABLE conversations ADD COLUMN expert_id TEXT') } catch {}
  // 授权档位按会话存储；缺失 = 从未选择（按 'auto' 处理）。
  try { database.exec('ALTER TABLE conversations ADD COLUMN approval_mode TEXT') } catch {}
  // 会话级模型按会话存储；缺失 = 从未选择（跟随全局默认 activeProfileId）。
  try { database.exec('ALTER TABLE conversations ADD COLUMN profile_id TEXT') } catch {}
  // ── 专家去内置化：能力收敛交给全局，专家只描述身份 + 私有知识 ──
  // 两个内置基础设施子代理（通用/画布）连同「内置锁定工具」概念一起退场：
  // 画布有自己的硬编码人设与工具白名单，spawn 无档案时走通用子代理人设。
  // 存量行必须删掉，否则旧库里它们仍会出现在专家列表里。
  // 旧的 allowed_* / is_built_in / summonable 列保留不动（新代码不读不写）：
  // 保留空列让回滚到旧版本仍然可用，代价只是表里几列不再被使用。
  try {
    database.exec("DELETE FROM subagent_profiles WHERE id IN ('subagent-general','subagent-canvas')")
  } catch {}
  // ── M5R: retype legacy tool-studio conversations ──
  // They used to derive as 'normal' and leak into the chat list; upsert's
  // ON CONFLICT never updates type, so existing rows need this one-time sweep.
  try { database.exec("UPDATE conversations SET type='tool' WHERE id LIKE 'toolstudio_%'") } catch {}

  // ── PLAN-settings-restructure P2: knowledge favorite source + favorites removal ──
  migrateKnowledgeFavoriteSource(database)
}

/**
 * SQLite cannot ALTER a CHECK constraint, so an existing knowledge_files table
 * (built with `source_type IN ('file','url','experience')`) must be rebuilt to
 * accept the new 'favorite' source. The full 12-step table-rebuild procedure
 * is trimmed: this table has no foreign keys, no triggers and no views.
 *
 * The rebuild, the one-time reset of the legacy favorites markers, and the
 * favorites drop (user-ruled discard, D2) run in ONE transaction: the marker
 * reset and the table that justified it are retired together, so an interrupted
 * startup can never leave a database where favorited was cleared while the old
 * data still existed (or vice versa). Idempotent: after it runs once, the
 * CREATE TABLE in createTables() already matches the rebuilt shape and every
 * probe here short-circuits.
 */
function migrateKnowledgeFavoriteSource(database: Database.Database): void {
  const rebuild = database.transaction(() => {
    // 1) Probe the CREATE statement — PRAGMA table_info cannot see a CHECK.
    const table = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_files'")
      .get() as { sql: string } | undefined
    if (!table?.sql) return

    const needsRebuild = !table.sql.includes("'favorite'")
    const hasLegacyFavorites = !!database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites'"
    ).get()
    // The old CHECK or favorites table is the migration sentinel. Fresh and
    // already-migrated databases must never clear newly captured markers.
    if (!needsRebuild && !hasLegacyFavorites) return
    database.exec('UPDATE messages SET favorited = 0 WHERE favorited <> 0')
    database.exec('DROP TABLE IF EXISTS favorites')
    if (!needsRebuild) return

    // Preserve every explicit index, including indexes added by older installs.
    const indexes = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge_files' AND sql IS NOT NULL"
    ).all() as { sql: string }[]
    database.exec(`
      CREATE TABLE knowledge_files_new (
        id            TEXT PRIMARY KEY,
        file_path     TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        source_type   TEXT NOT NULL DEFAULT 'file'
                        CHECK(source_type IN ('file', 'url', 'experience', 'favorite')),
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
      INSERT INTO knowledge_files_new
        (rowid, id, file_path, title, source_type, source_url, source_path, conv_id, content_hash, status, wiki_outputs, created_at, compiled_at)
      SELECT rowid, id, file_path, title, source_type, source_url, source_path, conv_id, content_hash, status, wiki_outputs, created_at, compiled_at
        FROM knowledge_files;
      DROP TABLE knowledge_files;
      ALTER TABLE knowledge_files_new RENAME TO knowledge_files;
    `)
    // FTS addresses rows by rowid (preserved above), not by id.
    for (const index of indexes) database.exec(index.sql)
    console.log('[DB] knowledge_files rebuilt with the favorite source type; legacy favorites table dropped')
  })
  rebuild()
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

/** Move one directory's entries into a target directory (creating it), entry
 *  by entry so a partially-migrated install resumes cleanly. rename first,
 *  copy+delete fallback for cross-device mounts. */
function migrateDirEntries(fromDir: string, toDir: string): number {
  if (!existsSync(fromDir)) return 0
  let moved = 0
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir)) {
    const src = join(fromDir, entry)
    const dest = join(toDir, entry)
    if (existsSync(dest)) continue // already migrated — never overwrite
    try {
      renameSync(src, dest)
    } catch {
      try {
        copyFileSync(src, dest)
        rmSync(src, { force: true })
      } catch (err) {
        console.warn(`[DB] Failed to migrate legacy knowledge entry ${src}:`, err)
        continue
      }
    }
    moved++
  }
  try { rmSync(fromDir, { recursive: true, force: true }) } catch { /* emptied above; ignore */ }
  return moved
}

/** H1: carry pre-bases files into the default base's directories. Runs before
 *  the FTS rebuilds below so they index the files at their NEW paths. */
function migrateLegacyKnowledgeDirs(): void {
  try {
    const rawMoved = migrateDirEntries(KNOWLEDGE_RAW_DIR, getBaseRawDir('default'))
    const wikiMoved = migrateDirEntries(KNOWLEDGE_WIKI_DIR, getBaseWikiDir('default'))
    if (rawMoved > 0 || wikiMoved > 0) {
      console.log(`[DB] Migrated legacy knowledge dirs into bases/default: ${rawMoved} raw, ${wikiMoved} wiki entries`)
    }
  } catch (err) {
    console.warn('[DB] Legacy knowledge migration failed (will retry next start):', err)
  }
}

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

    // Knowledge bases migration: migrate from group_id → base_id.
    // On fresh DBs the CREATE TABLE already has base_id; on old DBs we:
    // 1. Ensure knowledge_bases table exists
    // 2. Insert default base row
    // 3. Add base_id column if missing, backfill from group_id
    // 4. Drop old group_id column and knowledge_groups table
    //
    // This MUST run before any knowledge_fts/wiki rebuild below: those read
    // `knowledge_files.base_id` (PLAN-knowledge-bases), which does not exist on
    // a pre-migration database.
    const kbCols = getDb().prepare('PRAGMA table_info(knowledge_bases)').all() as { name: string }[]
    if (kbCols.length === 0) {
      getDb().exec("CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_hue INTEGER, created_at TEXT NOT NULL)")
    }
    // Ensure default base exists
    const defaultBase = getDb().prepare("SELECT id FROM knowledge_bases WHERE id = 'default'").get()
    if (!defaultBase) {
      getDb().prepare("INSERT INTO knowledge_bases (id, name, color_hue, created_at) VALUES ('default', '默认知识库', NULL, ?)").run(new Date().toISOString())
    }

    const kfCols = getDb().prepare('PRAGMA table_info(knowledge_files)').all() as { name: string }[]
    const hasBaseId = kfCols.some((c) => c.name === 'base_id')
    const hasGroupId = kfCols.some((c) => c.name === 'group_id')

    if (!hasBaseId && hasGroupId) {
      // Old schema: migrate group_id → base_id
      console.log('[DB] Migrating knowledge_files: group_id → base_id...')
      getDb().exec("ALTER TABLE knowledge_files ADD COLUMN base_id TEXT NOT NULL DEFAULT 'default'")
      // Backfill: files in a known group keep their mapping; NULL group_id → default
      getDb().exec(`
        UPDATE knowledge_files SET base_id = group_id
        WHERE group_id IS NOT NULL AND EXISTS (SELECT 1 FROM knowledge_groups WHERE knowledge_groups.id = knowledge_files.group_id)
      `)
      getDb().exec("DELETE FROM knowledge_files WHERE group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM knowledge_groups WHERE knowledge_groups.id = knowledge_files.group_id)")
      getDb().exec('ALTER TABLE knowledge_files DROP COLUMN group_id')
      getDb().exec('DROP TABLE IF EXISTS knowledge_groups')
      console.log('[DB] Migration complete: group_id → base_id')
    } else if (!hasBaseId && !hasGroupId) {
      // Very old schema without either column
      getDb().exec("ALTER TABLE knowledge_files ADD COLUMN base_id TEXT NOT NULL DEFAULT 'default'")
    }

    if (kfCols.length > 0 || hasBaseId) {
      getDb().exec('CREATE INDEX IF NOT EXISTS idx_knowledge_base ON knowledge_files(base_id)')
    }

    // knowledge-bases physical migration (H1): pre-bases installs kept raw and
    // wiki files in the flat knowledge/raw|wiki dirs while every reader now
    // resolves through bases/<id>/raw|wiki — without moving the bytes, every
    // preview/compile/delete of an upgraded file threw, and the wiki rebuild
    // comparison (0 pages on disk === 0 FTS rows) silently skipped reindexing
    // a wiki whose pages were all still in the old location. One-time,
    // idempotent: the legacy dirs are renamed away entry by entry, so the
    // second run finds nothing.
    migrateLegacyKnowledgeDirs()

    // PLAN-knowledge-base K4/K5 migration: the pre-chunking knowledge_fts had
    // no file_rowid column and a unicode61 tokenizer. Detect by shape (CREATE
    // IF NOT EXISTS would silently keep the old table), drop, recreate in the
    // new shape, and rebuild from disk — idempotent, second run is a no-op.
    const kfColumns = getDb().prepare("PRAGMA table_info(knowledge_fts)").all() as { name: string }[]
    if (kfColumns.length > 0 && !kfColumns.some((c) => c.name === 'file_rowid')) {
      console.log('[DB] knowledge_fts is pre-chunking (unicode61, file-level) — migrating to chunked trigram...')
      getDb().exec('DROP TABLE knowledge_fts')
      getDb().exec("CREATE VIRTUAL TABLE knowledge_fts USING fts5(content, file_rowid UNINDEXED, chunk_offset UNINDEXED, tokenize='trigram')")
      rebuildKnowledgeFts()
    }

    const ftsCount = (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_fts').get() as { c: number }).c
    if (ftsCount === 0) {
      const kfCount = (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_files').get() as { c: number }).c
      if (kfCount > 0) { console.log('[DB] Rebuilding knowledge_fts index...'); rebuildKnowledgeFts() }
    }

    // knowledge-bases migration: the wiki FTS used to carry an unused `groups`
    // column. Per-base scoping needs the owning base instead, so detect the old
    // shape, drop, recreate with `base_id` and let the sync check below
    // repopulate it from disk (the emptied table is out of sync by definition).
    const wikiCols = getDb().prepare('PRAGMA table_info(knowledge_wiki_fts)').all() as { name: string }[]
    if (wikiCols.length > 0 && !wikiCols.some((c) => c.name === 'base_id')) {
      console.log('[DB] knowledge_wiki_fts is pre-bases (groups column) — migrating to base_id...')
      getDb().exec('DROP TABLE knowledge_wiki_fts')
      getDb().exec("CREATE VIRTUAL TABLE knowledge_wiki_fts USING fts5(title, content, path UNINDEXED, base_id UNINDEXED, tokenize='trigram')")
    }

    // Wiki pages: rebuild when the FTS row count diverges from the page files
    // (K4) — deletion bugs or manual edits leave ghosts; a rebuild is cheap.
    try {
      const wikiFtsCount = (getDb().prepare('SELECT COUNT(*) as c FROM knowledge_wiki_fts').get() as { c: number }).c
      const onPage = countWikiPageFiles()
      if (wikiFtsCount !== onPage) {
        console.log(`[DB] knowledge_wiki_fts (${wikiFtsCount}) out of sync with ${onPage} page files — rebuilding`)
        rebuildWikiFts()
      }
    } catch (err) { console.warn('[DB] wiki FTS sync check failed:', err) }

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
    // Only a GENUINELY corrupt file may take the recreate path — and even then
    // it is RENAMED aside (pulsemind.db.corrupt-<ts>), never unlinked: this
    // branch once fired on a plain migration-ordering SQLITE_ERROR and deleted
    // the user's live database (2026-09-25). A schema/migration error must
    // fail the startup loudly instead — an app that cannot migrate must not
    // take the data with it.
    const code = (e as { code?: string }).code ?? ''
    const genuinelyCorrupt = code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT'
    if (genuinelyCorrupt && existsSync(DB_PATH) && db) {
      try { db.close() } catch { /* ignore */ }
      db = undefined as any
      const aside = `${DB_PATH}.corrupt-${Date.now()}`
      console.warn(`[DB] Database is genuinely corrupt — renaming to ${aside} and recreating...`)
      try { renameSync(DB_PATH, aside) } catch { /* best-effort */ }
      try { createTables(); createMemoryFts(getDb()); console.log('[DB] Database recreated successfully') } catch (e2) { console.error('[DB] Fatal: could not recreate database:', e2) }
    } else if (!genuinelyCorrupt) {
      throw e
    }
  }
}

// Circular-safe import: rebuildKnowledgeFts is called from initializeDatabase
// but lives in knowledge.db.ts. We import it lazily after init.
let _rebuildKnowledgeFts: (() => void) | null = null
function rebuildKnowledgeFts(): void {
  if (!_rebuildKnowledgeFts) {
    _rebuildKnowledgeFts = require('./knowledge.db').rebuildKnowledgeFts
  }
  _rebuildKnowledgeFts!()
}

/** Wiki page files across every base (K4's sync baseline). Lazy require keeps
 *  the storage module graph acyclic at load. */
function countWikiPageFiles(): number {
  const fn = require('./knowledge-store').countWikiPageFiles as () => number
  return fn()
}

let _rebuildWikiFts: (() => void) | null = null
function rebuildWikiFts(): void {
  if (!_rebuildWikiFts) {
    _rebuildWikiFts = require('./knowledge-store').rebuildWikiFts
  }
  _rebuildWikiFts!()
}
