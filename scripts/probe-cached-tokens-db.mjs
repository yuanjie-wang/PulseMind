/**
 * cached_tokens persistence probe (real SQLite, real main-process modules, no
 * Electron window) — the DB-layer companion of tests/cached-tokens-persistence.test.ts.
 *
 * Why a probe: vitest cannot open the database at all (better-sqlite3 here is
 * built for Electron's ABI, and `npm test` runs under plain Node), and this
 * change is exactly the kind the wiring test cannot see — whether the two
 * prepared statements actually carry the column, whether the migration ALTERs
 * a legacy database without losing rows, and whether getConversation hands the
 * value back. The motivation was the 410-request translation task of
 * 2026-10-24: 83% real cache hit, none of it reconstructable afterwards
 * because the dumps prune at 60 files and the DB dropped the dimension.
 *
 * How it gets a real database: the same recipe as probe-project-color-db —
 * main-process modules bundled with esbuild (`platform: node`, `electron`
 * aliased to a stub) and executed by the Electron binary in
 * `ELECTRON_RUN_AS_NODE` mode; `$HOME` points at a temp dir so the run never
 * touches the user's `~/.pulsemind`.
 *
 * Two phases, two processes, one database:
 *
 *   1. `legacy` — seeds messages/token_usage in their pre-change shape (no
 *      cached_tokens) with live rows, runs the real `initializeDatabase`, and
 *      asserts the ALTERs land, the rows survive, and legacy rows read as
 *      NULL/0 rather than crashing the read path.
 *   2. `persist` — fresh process, same database. Drives the real
 *      `saveConversation` and `appendConversationMessages` with
 *      promptCacheHitTokens on the messages, then asserts the column values by
 *      raw SQL, the token_usage ledger rows, `getConversation`'s read-back,
 *      and the stats SUM — the full write→read round trip.
 *
 * Usage: node scripts/probe-cached-tokens-db.mjs [--keep]
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

const CONV = 'conv_probe_cached'
const STAMP = '2026-10-24T14:00:00.000Z'

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
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

/** better-sqlite3 is `external` to the bundle and lives in the repo — require
 *  it through a repo-anchored resolver, like probe-project-color-db. */
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

// ── phase 1 · an existing install upgrades in place ───────────────────────
async function phaseLegacy() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)

  // The three tables exactly as a pre-change install has them: messages and
  // token_usage WITHOUT cached_tokens, conversations in its current shape (the
  // migration story under test is the two new columns, not the conv table).
  mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
  const seed = new Database(dbPath(DATA_DIR))
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
    CREATE TABLE token_usage (
      id TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `)
  seed.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, '旧任务', ?, ?)").run(CONV, STAMP, STAMP)
  seed.prepare('INSERT INTO messages (id, conversation_id, role, content, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('msg_legacy_1', CONV, 'assistant', '历史回复', 70, 5, STAMP)
  seed.prepare('INSERT INTO token_usage (id, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?)')
    .run('tu_msg_legacy_1', 70, 5, STAMP)
  check('fixture: the pre-upgrade tables have no cached_tokens', !columns(seed, 'messages').includes('cached_tokens') && !columns(seed, 'token_usage').includes('cached_tokens'))
  seed.close()

  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  check('migration adds cached_tokens to the existing messages table', columns(db, 'messages').includes('cached_tokens'))
  check('migration adds cached_tokens to the existing token_usage table', columns(db, 'token_usage').includes('cached_tokens'))
  const row = db.prepare('SELECT input_tokens, output_tokens, cached_tokens FROM messages WHERE id = ?').get('msg_legacy_1')
  check('the legacy row survives with its tokens and NULL cached', row.input_tokens === 70 && row.output_tokens === 5 && row.cached_tokens === null, JSON.stringify(row))
  const tu = db.prepare('SELECT input_tokens, cached_tokens FROM token_usage WHERE id = ?').get('tu_msg_legacy_1')
  check('the legacy ledger row reads 0 cached (NOT NULL DEFAULT 0)', tu.input_tokens === 70 && tu.cached_tokens === 0, JSON.stringify(tu))

  // The stats SUM must not choke on the legacy 0s.
  const { getHourlyTokenStats } = await import('../src/main/storage/stats.db')
  const hourly = getHourlyTokenStats()
  const stamped = hourly.find((h) => h.inputTokens >= 70)
  check('stats SUM works over a database that mixes legacy and new rows', Array.isArray(hourly) && stamped && stamped.cachedTokens === 0, JSON.stringify(stamped))
}

// ── phase 2 · write→read round trip through the real functions ────────────
async function phasePersist() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()

  const { saveConversation, appendConversationMessages, getConversation } = await import('../src/main/storage/conversation.db')

  const base = {
    id: 'msg_probe_save', role: 'assistant', content: '全量保存', createdAt: STAMP,
    inputTokens: 69643, outputTokens: 922, promptCacheHitTokens: 65412,
  }
  saveConversation({
    id: CONV, title: 'cached 探针', createdAt: STAMP, updatedAt: STAMP,
    messages: [base],
  })
  const db = getDb()
  let row = db.prepare('SELECT input_tokens, cached_tokens FROM messages WHERE id = ?').get('msg_probe_save')
  check('saveConversation writes messages.cached_tokens', row.cached_tokens === 65412, JSON.stringify(row))
  let tu = db.prepare('SELECT input_tokens, output_tokens, cached_tokens FROM token_usage WHERE id = ?').get('tu_msg_probe_save')
  check('saveConversation writes the ledger row with cached_tokens', tu && tu.input_tokens === 69643 && tu.output_tokens === 922 && tu.cached_tokens === 65412, JSON.stringify(tu))

  appendConversationMessages(CONV, 'cached 探针', [
    { id: 'msg_probe_append', role: 'assistant', content: '增量保存', createdAt: STAMP, inputTokens: 40, outputTokens: 5, promptCacheHitTokens: 33 },
  ])
  row = db.prepare('SELECT cached_tokens FROM messages WHERE id = ?').get('msg_probe_append')
  check('appendConversationMessages writes cached_tokens too', row.cached_tokens === 33, JSON.stringify(row))
  tu = db.prepare('SELECT cached_tokens FROM token_usage WHERE id = ?').get('tu_msg_probe_append')
  check('…and its ledger row', tu.cached_tokens === 33, JSON.stringify(tu))

  const conv = getConversation(CONV)
  const read = conv.messages.find((m) => m.id === 'msg_probe_save')
  check('getConversation reads the value back as promptCacheHitTokens', read.promptCacheHitTokens === 65412, JSON.stringify(read.promptCacheHitTokens))

  // A message without the field (user turns, pre-upgrade shapes) must persist NULL, not 0 —
  // NULL says "provider did not report", 0 would say "provider reported zero hits".
  appendConversationMessages(CONV, 'cached 探针', [
    { id: 'msg_probe_nofield', role: 'user', content: '没有缓存数字的消息', createdAt: STAMP },
  ])
  row = db.prepare('SELECT input_tokens, cached_tokens FROM messages WHERE id = ?').get('msg_probe_nofield')
  check('a message without the field persists NULL (not reported ≠ zero hits)', row.cached_tokens === null && row.input_tokens === null, JSON.stringify(row))
  check('…and writes no ledger row for it (same rule as input/output)', db.prepare('SELECT COUNT(*) AS c FROM token_usage WHERE id = ?').get('tu_msg_probe_nofield').c === 0)

  // The audit this whole change exists for: one SQL line answers "what did the
  // task actually cost" without a single dump file.
  const totals = db.prepare('SELECT SUM(input_tokens) AS i, SUM(cached_tokens) AS c FROM token_usage').get()
  check('the retrospective audit query works over the ledger', totals.i === 70 + 69643 + 40 && totals.c === 65412 + 33, JSON.stringify(totals))
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

  const work = mkdtempSync(join(tmpdir(), 'pm-cached-tokens-db-'))
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-cached-'))
  const homes = [work, home]
  let failed = 0
  let total = 0

  console.log(`① an existing install upgrades in place        HOME=${home}`)
  const one = run('legacy', home)
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) { failed++; console.log(`  ✗ phase legacy exited with ${one.status}`) }

  console.log('\n② write→read round trip through the real functions')
  const two = run('persist', home)
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) { failed++; console.log(`  ✗ phase persist exited with ${two.status}`) }

  if (KEEP) console.log(`\nkept: ${homes.join(' ')}`)
  else for (const h of homes) rmSync(h, { recursive: true, force: true })

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  if (PHASE === 'legacy') return phaseLegacy()
  if (PHASE === 'persist') return phasePersist()
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
