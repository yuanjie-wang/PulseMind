/**
 * Per-install conversation origins (real SQLite, real main-process modules) —
 * the DB-layer companion of the per-install identity tests in
 * tests/agent-protocol-ws.test.ts.
 *
 * Why a probe: vitest cannot open the database (better-sqlite3 here is built
 * for Electron's ABI), so the unit tests can only pin the SQL text and drive a
 * fake store. The promises that actually move a user's history need a real
 * database:
 *   - pre-instance rows under the bare `pulsemind-extension` origin are
 *     claimed by the install that opens the panel (unscoped rows, and rows of
 *     scopes that install holds live);
 *   - another browser's live scopes and dead scopes are NOT stolen;
 *   - message-less stubs are not claimed (they are not history);
 *   - after the claim the new origin lists the rows and the desktop's
 *     list/search exclusions cover the whole `base:instanceId` family without
 *     swallowing a sibling origin that merely shares the prefix.
 *
 * Recipe copied from probe-tab-key-db / probe-cached-tokens-db: main-process
 * modules bundled by esbuild with `electron` stubbed and run by the Electron
 * binary in `ELECTRON_RUN_AS_NODE` mode; `$HOME` (and PM_HOME) point at a temp
 * dir so the user's real `~/.pulsemind` is never touched.
 *
 * Usage: node scripts/probe-instance-origin-db.mjs [--keep]
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

const BASE = 'pulsemind-extension'
const INST = 'inst_chrome0001'
const NEW_ORIGIN = `${BASE}:${INST}`
const STAMP = '2026-11-05T00:00:00.000Z'

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

// ── phase · claim legacy rows + real list/search exclusions ────────────────
async function phaseClaim() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const {
    claimLegacyScopeConversations,
    adoptUnscopedConversations,
    listConversationsByOrigin,
    listConversations,
    searchConversationsByKeyword,
    updateConversationOrigin,
  } = await import('../src/main/storage/conversation.db')

  const db = getDb()
  db.exec('DELETE FROM messages; DELETE FROM conversations;')

  const conv = db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at, origin, tab_key) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const msg = db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
  const seed = (id, title, origin, tabKey, withMessage = true) => {
    conv.run(id, title, STAMP, STAMP, origin, tabKey)
    if (withMessage) msg.run(`m_${id}`, id, 'user', '正文', STAMP)
  }

  // The upgrade's world: every row predates instance ids, so all of them sit
  // under the bare base origin. They differ in scope provenance.
  seed('conv_unscoped', '升级前的无 scope 会话', BASE, null)
  seed('conv_mine', '属于本机活页签的会话', BASE, 'tab_live')
  seed('conv_other_live', '另一浏览器活页签的会话', BASE, 'tab_other')
  seed('conv_dead', '死浏览器会话留下的会话', BASE, 'tab_dead')
  seed('conv_stub', '', BASE, null, false) // session.create UPSERT stub
  seed('conv_desktop', '桌面会话', 'local', null)
  // A hypothetical other client whose id merely starts with the same text —
  // the prefix guard must require the colon.
  seed('conv_sibling', '前缀相邻的其他客户端会话', `${BASE}ish`, null)

  const originOf = (id) => db.prepare('SELECT origin FROM conversations WHERE id = ?').get(id)?.origin ?? null
  const tabOf = (id) => db.prepare('SELECT tab_key FROM conversations WHERE id = ?').get(id)?.tab_key ?? null

  // ── claim: unscoped + rows of THIS install's live scopes ──
  claimLegacyScopeConversations(BASE, NEW_ORIGIN, ['tab_live'])
  check(
    'the unscoped legacy row follows the install that opened the panel',
    originOf('conv_unscoped') === NEW_ORIGIN,
    originOf('conv_unscoped'),
  )
  check('the row of this install’s live scope is claimed too', originOf('conv_mine') === NEW_ORIGIN, originOf('conv_mine'))
  check(
    'another browser’s live-scope row is NOT stolen',
    originOf('conv_other_live') === BASE,
    originOf('conv_other_live'),
  )
  check('a dead-scope row stays on the legacy origin (conservative)', originOf('conv_dead') === BASE, originOf('conv_dead'))
  check('the message-less stub is not history and is not claimed', originOf('conv_stub') === BASE, originOf('conv_stub'))
  check('the desktop conversation is untouched', originOf('conv_desktop') === 'local', originOf('conv_desktop'))

  // The claim must not disturb scopes.
  check(
    'claimed rows keep their tab stamps (live ones unchanged, unscoped still NULL)',
    tabOf('conv_mine') === 'tab_live' && tabOf('conv_unscoped') === null,
    `${tabOf('conv_mine')} / ${tabOf('conv_unscoped')}`,
  )

  // ── adoption, in the same order session.list runs it ──
  adoptUnscopedConversations(NEW_ORIGIN, 'tab_live')
  check('the claimed unscoped row is adopted by the listing tab', tabOf('conv_unscoped') === 'tab_live', tabOf('conv_unscoped'))
  const mineList = listConversationsByOrigin(NEW_ORIGIN, 50, 'tab_live').map((r) => r.id).sort()
  check(
    'the new origin lists the claimed history in that tab',
    JSON.stringify(mineList) === JSON.stringify(['conv_mine', 'conv_unscoped']),
    JSON.stringify(mineList),
  )
  const bareList = listConversationsByOrigin(BASE, 50, 'tab_other').map((r) => r.id)
  check(
    'the legacy origin keeps exactly the rows that were not claimed',
    JSON.stringify(bareList) === JSON.stringify(['conv_other_live']),
    JSON.stringify(bareList),
  )

  // ── idempotence and guards ──
  const before = ['conv_unscoped', 'conv_mine', 'conv_other_live', 'conv_dead', 'conv_stub'].map((id) => originOf(id))
  claimLegacyScopeConversations(BASE, NEW_ORIGIN, ['tab_live'])
  const after = ['conv_unscoped', 'conv_mine', 'conv_other_live', 'conv_dead', 'conv_stub'].map((id) => originOf(id))
  check('a second session.list claim changes nothing', JSON.stringify(before) === JSON.stringify(after))

  updateConversationOrigin('conv_dead', BASE, 'tab_dead')
  claimLegacyScopeConversations(BASE, NEW_ORIGIN, [])
  check('an empty liveScopes set claims only unscoped rows (here: none left)', originOf('conv_dead') === BASE)
  claimLegacyScopeConversations(BASE, BASE, ['tab_live'])
  check('from === to is a no-op', originOf('conv_other_live') === BASE)

  // ── desktop surfaces: the whole suffix family excluded, prefix sibling kept ──
  const desktop = listConversations().map((r) => r.id)
  check(
    'the desktop list drops bare AND per-install hosted origins, keeps the sibling',
    !desktop.includes('conv_unscoped') &&
      !desktop.includes('conv_mine') &&
      !desktop.includes('conv_other_live') &&
      desktop.includes('conv_desktop') &&
      desktop.includes('conv_sibling'),
    JSON.stringify(desktop),
  )
  check('the zero-message stub is absent from the desktop list as before', !desktop.includes('conv_stub'))

  const search = searchConversationsByKeyword('会话').map((r) => r.id)
  check(
    'keyword search applies the same family exclusion (params still line up)',
    search.includes('conv_desktop') && search.includes('conv_sibling') && !search.includes('conv_mine'),
    JSON.stringify(search),
  )

  // ── the real wire shape: the base-origin row is unreachable by scoped list ──
  check(
    'a row left on the legacy origin is invisible to the per-install scoped list',
    !listConversationsByOrigin(BASE, 50, 'tab_live').some((r) => r.id === 'conv_mine'),
  )
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

  const work = mkdtempSync(join(tmpdir(), 'pm-instance-origin-db-'))
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-instance-origin-'))
  mkdirSync(join(home, '.pulsemind'), { recursive: true })
  const report = join(work, 'claim.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'claim',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home,
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  if (res.error) throw res.error
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))

  let failed = payload.checks.filter((c) => !c.pass).length
  let total = payload.checks.length
  if (res.status !== 0) {
    failed++
    console.log(`\n  ✗ phase claim exited with ${res.status}`)
  }
  if (KEEP) console.log(`\nkept: ${work} ${home}`)
  else rmSync(work, { recursive: true, force: true })
  if (!KEEP) rmSync(home, { recursive: true, force: true })

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  if (PHASE === 'claim') return phaseClaim()
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
