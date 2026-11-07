/**
 * Hosted-session transcript persistence probe (real SQLite, real main-process
 * modules, no Electron window).
 *
 * Why this exists: on 2026-11-02 the extension's 历史会话 menu listed nothing at
 * all, and the root cause was not the menu's filter — every extension
 * conversation in the dev machine's database had ZERO messages. Main-hosted
 * sessions have no renderer, and `useConversationPersistence` only writes the
 * desktop's own conversations, so the only row an extension session ever got
 * was the `title=''` stub its origin stamp UPSERTs (G36). The fix is
 * `src/main/agent/hosted-persistence.ts`: at every turn end, write the live
 * transcript through `saveConversation`.
 *
 * The event half (turn-end detection, guards) is pinned by vitest
 * (tests/agent-protocol-ws.test.ts). THIS probe is the storage half, which
 * vitest structurally cannot reach: better-sqlite3 is Electron-ABI, and
 * `npm test` runs under plain Node.
 *
 * Mechanics copied from probe-project-color-db.mjs: bundle the main-process
 * modules with esbuild (`electron` aliased to a stub — `require('electron')`
 * outside a running app returns a string), run the bundle under
 * ELECTRON_RUN_AS_NODE so the native module loads, and sandbox every phase in
 * a fresh temp HOME (`DATA_DIR` is `homedir()/.pulsemind`).
 *
 * Two phases, two processes, one database:
 *
 *   1. `turn` — a session is stamped (the stub), then a turn-end persist is
 *      driven with a real `saveConversation`. Asserts the stub is invisible
 *      before the write, visible after it, titled from the first message, and
 *      that a second turn appends instead of duplicating.
 *   2. `restart` — the same database in a fresh process: the row still lists,
 *      its transcript still loads (the panel's resume path), and a rename
 *      survives the next turn-end rewrite.
 *
 * Usage: node scripts/probe-hosted-persistence.mjs [--keep]
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

const EXT = 'pulsemind-extension'
const SESSION_A = 'ws_1793634410829_aaaa1111'
const SESSION_B = 'ws_1793634392802_bbbb2222'
const SESSION_LOCAL = 'conv_1793634410829_cccc3333'

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

const msg = (id, role, text, at) => ({ id, role, contentBlocks: [{ type: 'text', text }], createdAt: at })
const TURN_1 = [
  msg('m_a1', 'user', '帮我看看这个页面', '2026-11-02T10:00:00.000Z'),
  msg('m_a2', 'assistant', '这个页面是一个搜索框。', '2026-11-02T10:00:05.000Z'),
]
const TURN_2_EXTRA = [msg('m_a3', 'user', '它支持哪些运营商？', '2026-11-02T10:01:00.000Z')]

function makeDeps(mod, live) {
  return {
    onEvent: () => () => {},
    snapshot: async (id) => (live.has(id) ? { messages: live.get(id) } : null),
    origin: (id) => mod.getConversationOrigin(id),
    title: (id) => mod.getConversationTitle(id),
    // review_20261103 中2: the engine's summary cache rides the save — the
    // probe models the ws-server wiring (engineCall('getHistorySummary')) with
    // a static value; assertions below read the persisted column.
    historySummary: async () => ({ text: '探针摘要：早前轮次', firstKeptId: 'm_a2' }),
    save: (conversation) => mod.saveConversation(conversation),
    warn: (message, err) => console.log(`  [warn] ${message} ${err && err.message ? err.message : err}`),
  }
}

// ── phase 1 · a stub is invisible; a turn end makes it a conversation ──────
async function phaseTurn() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()

  const db = await import('../src/main/storage/conversation.db')
  const { persistHostedTranscript } = await import('../src/main/agent/hosted-persistence')
  const live = new Map()

  // session.create for two extension sessions (one will get a turn, one 新会话
  // the user just clicked) and one desktop conversation for the guard.
  db.updateConversationOrigin(SESSION_A, EXT)
  db.updateConversationOrigin(SESSION_B, EXT)
  db.updateConversationOrigin(SESSION_LOCAL, 'local')

  const raw = getDb()
  const rowsInTable = raw.prepare('SELECT COUNT(*) AS n FROM conversations').get().n
  check('session.create leaves a stub row behind (the G36 UPSERT)', rowsInTable === 3, `${rowsInTable} row(s)`)
  check('…with its origin stamped so the list can be scoped', db.getConversationOrigin(SESSION_A) === EXT)
  check(
    'but the list shows nothing yet — a stub is not a conversation',
    db.listConversationsByOrigin(EXT).length === 0,
    `${db.listConversationsByOrigin(EXT).length} listed`
  )

  live.set(SESSION_A, TURN_1)
  const wrote = await persistHostedTranscript(makeDeps(db, live), SESSION_A)
  check('a turn-end persist reports a write', wrote === true)

  const listed = db.listConversationsByOrigin(EXT)
  check('the session now lists', listed.length === 1 && listed[0].id === SESSION_A, listed.map((r) => r.id).join(','))
  check(
    'titled from the first message text (the desktop title rule)',
    listed[0]?.title === '帮我看看这个页面',
    JSON.stringify(listed[0]?.title)
  )

  const stored = db.getConversation(SESSION_A)
  check('the transcript is on disk', stored?.messages.length === 2, `${stored?.messages.length} message(s)`)
  check(
    '…with the assistant reply intact, not only the user line',
    stored?.messages[1]?.content === '这个页面是一个搜索框。',
    JSON.stringify(stored?.messages[1]?.content)
  )
  check(
    'the stub kept its origin (saveConversation does not write the column)',
    db.getConversationOrigin(SESSION_A) === EXT
  )
  // review_20261103 中2: the upsert writes history_summary unconditionally, so
  // a save without the engine's cache NULLed the column every turn. The dep
  // rides it now; the persisted row must carry it across a restart.
  check(
    'the history summary rode the turn-end save (not NULLed by the upsert)',
    db.getConversation(SESSION_A)?.historySummary === '探针摘要：早前轮次',
    JSON.stringify(db.getConversation(SESSION_A)?.historySummary)
  )

  // Idempotence: the writer runs on EVERY turn end, so the same transcript must
  // not duplicate. `saveConversation` is a full-set reconciliation (it deletes
  // rows the payload omits), so the count is the assertion.
  await persistHostedTranscript(makeDeps(db, live), SESSION_A)
  check(
    're-persisting the same turn does not duplicate messages',
    db.getConversation(SESSION_A)?.messages.length === 2,
    `${db.getConversation(SESSION_A)?.messages.length}`
  )

  // Turn 2 appends; the title must not drift to the newer user line.
  live.set(SESSION_A, [...TURN_1, ...TURN_2_EXTRA])
  await persistHostedTranscript(makeDeps(db, live), SESSION_A)
  const afterTurn2 = db.getConversation(SESSION_A)
  check('a second turn appends', afterTurn2?.messages.length === 3, `${afterTurn2?.messages.length} message(s)`)
  check(
    'the title is stable across turns',
    db.getConversationTitle(SESSION_A) === '帮我看看这个页面',
    JSON.stringify(db.getConversationTitle(SESSION_A))
  )

  // A session with nothing said yet: the writer refuses (no messages), and the
  // list keeps hiding it — the user's second 新建会话 does not appear until it
  // has something in it.
  live.set(SESSION_B, [])
  const wroteB = await persistHostedTranscript(makeDeps(db, live), SESSION_B)
  check('an empty session writes nothing', wroteB === false)
  check('…and stays out of the list', db.listConversationsByOrigin(EXT).length === 1)

  // The G84 guard: the desktop's renderer is its writer. A hosted write must
  // not touch a 'local' conversation even if the caller asks.
  live.set(SESSION_LOCAL, [msg('m_l1', 'user', '桌面端的一句话', '2026-11-02T10:02:00.000Z')])
  const wroteLocal = await persistHostedTranscript(makeDeps(db, live), SESSION_LOCAL)
  check('a non-hosted origin is refused', wroteLocal === false)
  check(
    '…leaving the desktop conversation without rows from this path',
    (raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(SESSION_LOCAL).n) === 0
  )

  // Deleted mid-turn: the service no longer holds it, so snapshot answers null
  // and nothing is written (the resurrection guard).
  live.delete(SESSION_A)
  const wroteGone = await persistHostedTranscript(makeDeps(db, live), SESSION_A)
  check('a session the service no longer holds writes nothing', wroteGone === false)
  live.set(SESSION_A, [...TURN_1, ...TURN_2_EXTRA])

  // The list is ordered newest-first, which is what the menu shows.
  live.set(SESSION_B, [msg('m_b1', 'user', '第二个会话', '2026-11-02T10:05:00.000Z')])
  await persistHostedTranscript(makeDeps(db, live), SESSION_B)
  const ordered = db.listConversationsByOrigin(EXT)
  check('both conversations list', ordered.length === 2, ordered.map((r) => r.id).join(','))
  check('newest first', ordered[0]?.id === SESSION_B, ordered.map((r) => r.id).join(','))

  return { countA: afterTurn2?.messages.length }
}

// ── phase 2 · a fresh process reads what phase 1 wrote ─────────────────────
async function phaseRestart({ countA }) {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase } = await import('../src/main/storage/database')
  await initializeDatabase()

  const db = await import('../src/main/storage/conversation.db')
  const { persistHostedTranscript } = await import('../src/main/agent/hosted-persistence')
  const live = new Map()

  const listed = db.listConversationsByOrigin(EXT)
  check('the conversation survives a desktop restart', listed.length === 2, `${listed.length} listed`)
  check(
    'with the title the first turn gave it',
    listed.find((r) => r.id === SESSION_A)?.title === '帮我看看这个页面',
    JSON.stringify(listed.find((r) => r.id === SESSION_A)?.title)
  )

  const reloaded = db.getConversation(SESSION_A)
  check(
    'and its transcript (the resume path: agent.history -> getConversation)',
    reloaded?.messages.length === countA,
    `${reloaded?.messages.length} vs ${countA}`
  )

  // A user rename (the panel/desktop writes the column) must survive the next
  // turn-end rewrite — the writer only replaces the placeholder.
  db.updateConversationTitle(SESSION_A, '页面分析（改名后）')
  live.set(SESSION_A, reloaded.messages.map((m) => ({ id: m.id, role: m.role, contentBlocks: m.contentBlocks, createdAt: m.createdAt })))
  await persistHostedTranscript(makeDeps(db, live), SESSION_A)
  check(
    'a rename survives the next turn-end rewrite',
    db.getConversationTitle(SESSION_A) === '页面分析（改名后）',
    JSON.stringify(db.getConversationTitle(SESSION_A))
  )
}

// ── runner ────────────────────────────────────────────────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-hosted-persistence-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    // better-sqlite3 stays external and is required from the repo's own
    // node_modules (NODE_PATH below) so its native binding keeps working.
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-hosted-'))
  const run = (phase, extra = {}) => {
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
        PM_FIXTURE: JSON.stringify(extra),
        HOME: home,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    })
    if (res.error) throw res.error
    let payload = { checks: [] }
    if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
    return { status: res.status, ...payload }
  }

  let failed = 0
  let total = 0

  console.log(`① a turn end turns the stub into a conversation   HOME=${home}`)
  const one = run('turn')
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) { failed++; console.log(`  ✗ phase turn exited with ${one.status}`) }

  console.log('\n② a desktop restart still sees it (fresh process, same database)')
  const two = run('restart', { countA: one.countA })
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) { failed++; console.log(`  ✗ phase restart exited with ${two.status}`) }

  if (KEEP) console.log(`\nkept: ${work} ${home}`)
  else { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }

  console.log(`\n${total - failed}/${total} checks passed`)
  if (failed > 0) process.exit(1)
}

if (PHASE === 'turn') {
  process.on('exit', () => {
    if (process.env.PM_REPORT) {
      writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results, ...(globalThis.__extra ?? {}) }))
    }
  })
  phaseTurn().then((extra) => { globalThis.__extra = extra }).catch((err) => { console.error(err); process.exit(1) })
} else if (PHASE === 'restart') {
  process.on('exit', () => {
    if (process.env.PM_REPORT) {
      writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
    }
  })
  const extra = JSON.parse(process.env.PM_FIXTURE || '{}')
  phaseRestart(extra).catch((err) => { console.error(err); process.exit(1) })
} else {
  launcher().catch((err) => { console.error(err); process.exit(1) })
}
