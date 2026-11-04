/**
 * conversations.tab_key probe (real SQLite, real main-process modules) — the
 * DB-layer companion of the tabKey tests in tests/agent-protocol-ws.test.ts.
 *
 * Why a probe: vitest cannot open the database (better-sqlite3 here is built
 * for Electron's ABI), so the only thing a unit test can pin is the SQL text.
 * What this change actually promises — a legacy database gains the column,
 * existing extension conversations are adopted by the first tab instead of
 * disappearing, a scope-less stamp never erases an existing scope, and one
 * scope's list never shows another's rows — needs a real database.
 *
 * Recipe copied from probe-cached-tokens-db / probe-project-color-db:
 * main-process modules bundled by esbuild with `electron` stubbed and run by
 * the Electron binary in `ELECTRON_RUN_AS_NODE` mode; `$HOME` (and PM_HOME)
 * point at a temp dir so the user's real `~/.pulsemind` is never touched.
 *
 * Three phases, three processes, one database:
 *   1. `legacy` — seeds the pre-change conversations table (no tab_key) with
 *      two extension conversations, one of them message-less, plus a desktop
 *      conversation; runs the real `initializeDatabase`; then drives
 *      `adoptUnscopedConversations` + the scoped/unscoped list and the
 *      COALESCE upsert rules.
 *   2. `persist` — fresh process: the stamps survive a restart, the desktop
 *      (unscoped) query still sees everything, and the message-less stub was
 *      neither adopted nor listed.
 *   3. `restart` — fresh process: a browser restart killed chrome.storage.
 *      session, so every old scope is dead; `releaseDeadScopeConversations`
 *      + adoption must reclaim the whole batch into the first listing tab,
 *      leaving live-scope rows and empty-set calls untouched.
 *
 * Usage: node scripts/probe-tab-key-db.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

const ORIGIN = 'pulsemind-extension'
const CONV_A = 'conv_20261101000001'
const CONV_B = 'conv_20261101000002'
const CONV_EMPTY = 'conv_20261101000003'
const CONV_DESKTOP = 'conv_20261101000004'
const STAMP = '2026-11-01T00:00:00.000Z'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing to touch it`)
}

const dbPath = (dataDir) => join(dataDir, 'db', 'pulsemind.db')
const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)

const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

/** Same shape an existing install has: no tab_key anywhere. */
function seedLegacy(Database, dataDir) {
  mkdirSync(join(dataDir, 'db'), { recursive: true })
  const seed = new Database(dbPath(dataDir))
  seed.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
      type TEXT NOT NULL DEFAULT 'normal', rect_id TEXT, summary TEXT, keywords TEXT,
      pinned INTEGER NOT NULL DEFAULT 0, project_id TEXT, workspace_dir TEXT, plan_json TEXT,
      extracted_msg_count INTEGER NOT NULL DEFAULT 0, experience_extracted_count INTEGER NOT NULL DEFAULT 0,
      history_summary TEXT, history_summary_frontier TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL DEFAULT '', content_blocks TEXT,
      liked INTEGER NOT NULL DEFAULT 0, favorited INTEGER NOT NULL DEFAULT 0,
      processing_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      auto_summary INTEGER NOT NULL DEFAULT 0, compressed_ids TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
  `)
  const conv = seed.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
  conv.run(CONV_A, 'A 的旧会话', STAMP, '2026-11-01T01:00:00.000Z')
  conv.run(CONV_B, 'B 的旧会话', STAMP, '2026-11-01T02:00:00.000Z')
  conv.run(CONV_EMPTY, '', STAMP, STAMP) // session.create upsert stub: no messages
  conv.run(CONV_DESKTOP, '桌面会话', STAMP, '2026-11-01T03:00:00.000Z')
  const msg = seed.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
  msg.run('m_a1', CONV_A, 'user', 'A 的第一句', STAMP)
  msg.run('m_b1', CONV_B, 'user', 'B 的第一句', STAMP)
  msg.run('m_d1', CONV_DESKTOP, 'user', '桌面', STAMP)
  // origin is stamped by the current code path already (the column predates this
  // change); a pre-change install has it, just not tab_key.
  try {
    seed.exec("ALTER TABLE conversations ADD COLUMN origin TEXT")
    seed.prepare("UPDATE conversations SET origin = ? WHERE id IN (?, ?, ?)").run(ORIGIN, CONV_A, CONV_B, CONV_EMPTY)
    seed.prepare("UPDATE conversations SET origin = 'local' WHERE id = ?").run(CONV_DESKTOP)
  } catch (err) {
    console.warn('fixture: origin column seeding failed', err.message)
  }
  seed.close()
}

// ── phase 1 · upgrade + adoption + scoped listing ─────────────────────────
async function phaseLegacy() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  seedLegacy(Database, DATA_DIR)

  const probe = new Database(dbPath(DATA_DIR), { readonly: true })
  check('fixture: the pre-upgrade conversations table has no tab_key', !columns(probe, 'conversations').includes('tab_key'))
  probe.close()

  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  check('migration adds tab_key to the existing conversations table', columns(db, 'conversations').includes('tab_key'))

  const stampOf = (id) => db.prepare('SELECT tab_key FROM conversations WHERE id = ?').get(id).tab_key
  check('legacy rows survive with tab_key NULL', stampOf(CONV_A) === null && stampOf(CONV_B) === null)

  const { listConversationsByOrigin, adoptUnscopedConversations, updateConversationOrigin } = await import(
    '../src/main/storage/conversation.db'
  )
  const ids = (rows) => rows.map((r) => r.id).sort()

  check(
    'the desktop (unscoped) query still sees the extension history',
    JSON.stringify(ids(listConversationsByOrigin(ORIGIN))) === JSON.stringify([CONV_A, CONV_B]),
    JSON.stringify(ids(listConversationsByOrigin(ORIGIN))),
  )
  // Nobody has opened a tab yet: a scoped query must not claim them for itself.
  check('a scoped list before any adoption is empty (no tab owns them yet)', listConversationsByOrigin(ORIGIN, 50, 'tab_a').length === 0)

  adoptUnscopedConversations(ORIGIN, 'tab_a')
  check(
    'adoption stamps the origin\u2019s message-carrying conversations',
    stampOf(CONV_A) === 'tab_a' && stampOf(CONV_B) === 'tab_a',
    `${stampOf(CONV_A)} / ${stampOf(CONV_B)}`,
  )
  // The empty stub is what made the 历史会话 list full of 未命名会话 rows; it must
  // stay unadopted (the list's EXISTS(messages) already hides it, but a stamp
  // would make a later real conversation of that id invisible to other tabs).
  check('the message-less stub was NOT adopted', stampOf(CONV_EMPTY) === null)
  check('…and the desktop conversation was not touched', stampOf(CONV_DESKTOP) === null)

  check(
    'the adopting tab now lists them',
    JSON.stringify(ids(listConversationsByOrigin(ORIGIN, 50, 'tab_a'))) === JSON.stringify([CONV_A, CONV_B]),
  )
  check('a sibling tab lists none of them', listConversationsByOrigin(ORIGIN, 50, 'tab_b').length === 0)
  check('the desktop query is unaffected by scoping', listConversationsByOrigin(ORIGIN).length === 2)

  // Idempotency: a second tab opening later must not steal the first tab's rows.
  adoptUnscopedConversations(ORIGIN, 'tab_c')
  check('a later adoption is a no-op (stamps are sticky)', stampOf(CONV_A) === 'tab_a' && listConversationsByOrigin(ORIGIN, 50, 'tab_c').length === 0)

  // The resume path stamps again on every session.create. A desktop-side create
  // carries no scope; COALESCE must keep what is there.
  updateConversationOrigin(CONV_A, ORIGIN)
  check('a scope-less stamp keeps the existing tab_key', stampOf(CONV_A) === 'tab_a', String(stampOf(CONV_A)))

  // Re-scoping a conversation (its session resumed in another tab) moves it.
  updateConversationOrigin(CONV_A, ORIGIN, 'tab_b')
  check('an explicit scope re-stamps the row', stampOf(CONV_A) === 'tab_b')
  check('…so it now lists under the new scope only', JSON.stringify(ids(listConversationsByOrigin(ORIGIN, 50, 'tab_b'))) === JSON.stringify([CONV_A]))
  check('…and disappears from the old one', JSON.stringify(ids(listConversationsByOrigin(ORIGIN, 50, 'tab_a'))) === JSON.stringify([CONV_B]))

  // A brand-new session is stamped at creation, before any message exists.
  const fresh = 'conv_20261101000005'
  updateConversationOrigin(fresh, ORIGIN, 'tab_b')
  check('a new scope-stamped session is not listed until it has a message', !listConversationsByOrigin(ORIGIN, 50, 'tab_b').some((r) => r.id === fresh))
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run('m_f1', fresh, 'user', '你好', STAMP)
  check('…and appears once one is written', listConversationsByOrigin(ORIGIN, 50, 'tab_b').some((r) => r.id === fresh))
}

// ── phase 2 · the stamps survive a restart ────────────────────────────────
async function phasePersist() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { listConversationsByOrigin } = await import('../src/main/storage/conversation.db')

  const db = getDb()
  const stampOf = (id) => db.prepare('SELECT tab_key FROM conversations WHERE id = ?').get(id).tab_key
  check('the stamps persisted across the process boundary', stampOf(CONV_A) === 'tab_b' && stampOf(CONV_B) === 'tab_a')
  check(
    'the scoped lists are unchanged after a restart',
    JSON.stringify(listConversationsByOrigin(ORIGIN, 50, 'tab_a').map((r) => r.id)) === JSON.stringify([CONV_B]) &&
      JSON.stringify(listConversationsByOrigin(ORIGIN, 50, 'tab_b').map((r) => r.id).sort()) ===
        JSON.stringify([CONV_A, 'conv_20261101000005']),
    JSON.stringify(listConversationsByOrigin(ORIGIN, 50, 'tab_b').map((r) => r.id)),
  )
  check('the desktop query still returns every extension conversation', listConversationsByOrigin(ORIGIN).length === 3)
}

// ── phase 3 · a browser restart releases dead scopes back into adoption ───
// review_20261104 中3: chrome.storage.session cleared on browser exit, so
// every stamp from the previous session is dead — the scoped lists match
// nothing, adoption only touches NULL, and the hosted-origin exclusion hides
// the rows from the desktop. The extension sends its LIVE scope set with
// session.list; the release must reclaim the dead batch into the first tab
// that opens, without touching live-scope rows or firing on an empty set.
async function phaseRestart() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { listConversationsByOrigin, adoptUnscopedConversations, releaseDeadScopeConversations, updateConversationOrigin } =
    await import('../src/main/storage/conversation.db')

  const db = getDb()
  const stampOf = (id) => db.prepare('SELECT tab_key FROM conversations WHERE id = ?').get(id)?.tab_key ?? null
  const liveId = 'conv_20261101000006'
  // The post-restart world: tab_new is the only scope minted so far, and it
  // already owns one conversation of its own.
  updateConversationOrigin(liveId, ORIGIN, 'tab_new')
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run('m_l1', liveId, 'user', '重启后的新对话', STAMP)
  check(
    'pre-state: the old stamps are still in place (scoped lists work)',
    stampOf(CONV_A) === 'tab_b' && stampOf(CONV_B) === 'tab_a',
    `${stampOf(CONV_A)} / ${stampOf(CONV_B)}`,
  )

  // The restart itself: every pre-restart scope is dead now.
  releaseDeadScopeConversations(ORIGIN, ['tab_new'])
  check('dead stamps are released (tab_key NULL again)', stampOf(CONV_A) === null && stampOf(CONV_B) === null && stampOf('conv_20261101000005') === null)
  check('the live scope row is untouched', stampOf(liveId) === 'tab_new')

  // The release is followed by adoption in the same session.list call: the
  // whole batch lands in the first tab that opens.
  adoptUnscopedConversations(ORIGIN, 'tab_new')
  const adopted = listConversationsByOrigin(ORIGIN, 50, 'tab_new').map((r) => r.id)
  check(
    'the released history is adopted into the first listing tab',
    JSON.stringify(adopted) === JSON.stringify([liveId, 'conv_20261101000005', CONV_B, CONV_A]),
    JSON.stringify(adopted),
  )
  check('the message-less stub stays unadopted', stampOf(CONV_EMPTY) === null)

  // Guard rails: an empty live set must not mass-unscope (nothing can be told
  // dead from alive), and the desktop query is unaffected by any of it.
  updateConversationOrigin('conv_20261101000007', ORIGIN, 'tab_stray')
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run('m_s1', 'conv_20261101000007', 'user', 'x', STAMP)
  releaseDeadScopeConversations(ORIGIN, [])
  check('an empty liveScopes set is a no-op', stampOf('conv_20261101000007') === 'tab_stray')
  check('the desktop (unscoped) query still sees every extension row', listConversationsByOrigin(ORIGIN).length === 5)
}

// ── runner ─────────────────────────────────────────────────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-tab-key-db-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'jsdom', 'playwright-core', 'chromium-bidi'],
    plugins: [
      {
        name: 'electron-stub',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'pm-electron-stub' }))
          b.onLoad({ filter: /.*/, namespace: 'pm-electron-stub' }, () => ({
            contents: `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} } }`,
            loader: 'js',
          }))
        },
      },
    ],
    logLevel: 'warning',
  })
  console.log(`harness: ${bundle}\n`)

  const run = (phase, home) => {
    const report = join(work, `${phase}.json`)
    const res = spawnSync(electronBin, [bundle], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PM_REPO: REPO_ROOT,
        PM_PHASE: phase,
        PM_HOME: home,
        PM_REPORT: report,
        HOME: home,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    })
    if (res.error) throw res.error
    let payload = { checks: [] }
    if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
    return { status: res.status, ...payload }
  }

  const home = mkdtempSync(join(tmpdir(), 'pm-home-tab-key-'))
  const temps = [work, home]
  let failed = 0
  let total = 0

  console.log(`① an existing install gains tab_key; adoption + scoping   HOME=${home}`)
  const one = run('legacy', home)
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) {
    failed++
    console.log(`  ✗ phase legacy exited with ${one.status}`)
  }

  console.log('\n② the stamps survive a restart')
  const two = run('persist', home)
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) {
    failed++
    console.log(`  ✗ phase persist exited with ${two.status}`)
  }

  console.log('\n③ a browser restart releases dead scopes back into adoption')
  const three = run('restart', home)
  total += three.checks.length
  failed += three.checks.filter((c) => !c.pass).length
  if (three.status !== 0) {
    failed++
    console.log(`  ✗ phase restart exited with ${three.status}`)
  }

  if (KEEP) console.log(`\nkept: ${temps.join(' ')}`)
  else for (const h of temps) rmSync(h, { recursive: true, force: true })

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  if (PHASE === 'legacy') return phaseLegacy()
  if (PHASE === 'persist') return phasePersist()
  if (PHASE === 'restart') return phaseRestart()
  throw new Error(`unknown PM_PHASE ${PHASE}`)
}

if (PHASE) {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(err?.stack || err)
    process.exit(1)
  })
}
