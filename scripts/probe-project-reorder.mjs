/**
 * Project drag-order persistence probe (real SQLite, real main-process
 * modules, no Electron window).
 *
 * The sidebar's drag-to-reorder writes `projects.sort_order` through
 * `projectStore.reorder`. vitest cannot open the database at all
 * (better-sqlite3 is built for Electron's ABI — the repo's "DB-layer coverage
 * is a known gap"), and a static source scan can read the UPDATE but cannot
 * prove the SQL runs: the named `@`-binding shape, the `json_each` NULL-reset
 * for rows left out of the submitted list, and the column's guarded ALTER are
 * all runtime facts. This is `probe-project-color-db.mjs`'s recipe applied to
 * that migration: main-process modules bundled with esbuild (`platform:
 * node`, `electron` aliased to a stub) and executed by the Electron binary in
 * `ELECTRON_RUN_AS_NODE` mode, every run sandboxed into a fresh temp `HOME`
 * (`guardHome` refuses anything outside it), so the user's real `~/.pulsemind`
 * is never opened.
 *
 * One phase, one process — unlike the color backfill, `reorder` has no
 * module-level once-flag that would let a same-process call prove nothing.
 *
 * Usage: node scripts/probe-project-reorder.mjs [--keep]   (repo root; needs npx electron)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

// ── reporting (same shape as the color probe's) ────────────────────────────
const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  return !!pass
}

/** Never let a phase touch anything but its own temp HOME. */
function guardHome(dataDir) {
  const home = process.env.PM_HOME
  if (!home) throw new Error('PM_HOME is not set — refusing to run against the real ~/.pulsemind')
  if (!dataDir.startsWith(home)) throw new Error(`DATA_DIR ${dataDir} is outside PM_HOME ${home} — refusing to touch it`)
}

const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

// ── the phase ──────────────────────────────────────────────────────────────
async function phaseReorder() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  const dbPath = join(DATA_DIR, 'db', 'pulsemind.db')

  // The table as an upgrade-era install has it: projects WITHOUT sort_order
  // (the column ships with this change; the guarded ALTER is what adds it).
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
  const seed = new Database(dbPath)
  seed.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL,
    icon TEXT,
    color_hue INTEGER,
    sandbox_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const stamp = '2026-09-01T00:00:00.000Z'
  const LEGACY = [
    { id: 'proj_a', name: 'Alpha' },
    { id: 'proj_b', name: 'Beta' },
    { id: 'proj_c', name: 'Gamma' },
  ]
  const insert = seed.prepare(
    'INSERT INTO projects (id, name, workspace_dir, icon, color_hue, sandbox_json, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)'
  )
  for (const p of LEGACY) insert.run(p.id, p.name, join(DATA_DIR, 'ws', p.id), '{}', stamp, stamp)
  seed.close()
  check('fixture: the pre-upgrade table has no sort_order', !new Database(dbPath).prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'sort_order'))

  // The real startup sequence (main/index.ts): ensureDataDir → initializeDatabase.
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  check('the guarded ALTER adds sort_order to the existing table', db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'sort_order'))
  const survivors = db.prepare('SELECT COUNT(*) AS n FROM projects').get()
  check('the rows survive the migration', survivors.n === LEGACY.length, String(survivors.n))

  const { projectStore } = await import('../src/main/storage/project-store')

  // ── the drop: the renderer submits the FULL display order ──
  const order1 = ['proj_c', 'proj_a', 'proj_b']
  await projectStore.reorder(order1)
  const raw = db.prepare('SELECT id, sort_order FROM projects ORDER BY sort_order').all()
  check('the drag order is on the rows, positions 0..n-1', JSON.stringify(raw.map((r) => r.id)) === JSON.stringify(order1) && raw.every((r) => typeof r.sort_order === 'number'), JSON.stringify(raw))
  const listed = await projectStore.list()
  const fromList = Object.fromEntries(listed.filter((p) => p.id !== 'default').map((p) => [p.id, p.sortOrder]))
  check('list() carries sortOrder off the row (the renderer never reads SQL)', fromList.proj_c === 0 && fromList.proj_a === 1 && fromList.proj_b === 2, JSON.stringify(fromList))
  check('the synthesized default project has no row, hence no order', listed[0].id === 'default' && listed[0].sortOrder === undefined)

  // ── a later drag that submits fewer ids: the omitted row must not keep a
  // stale position — it resets to NULL and rides created_at again. ──
  await projectStore.reorder(['proj_b'])
  const afterPartial = Object.fromEntries((await projectStore.list()).filter((p) => p.id !== 'default').map((p) => [p.id, p.sortOrder]))
  check('a row left out of the submitted list loses its position', afterPartial.proj_b === 0 && afterPartial.proj_a === undefined && afterPartial.proj_c === undefined, JSON.stringify(afterPartial))

  // ── the new-project case: born without sort_order, then a full-list drag
  // that includes it (the json_each NULL-reset must not touch listed rows) ──
  const created = await projectStore.create({ name: 'Delta', workspaceDir: join(DATA_DIR, 'ws', 'delta') })
  check('a new project is born without a manual position', created.sortOrder === undefined, String(created.sortOrder))
  const order2 = [created.id, 'proj_b', 'proj_a', 'proj_c']
  await projectStore.reorder(order2)
  const afterFull = Object.fromEntries((await projectStore.list()).filter((p) => p.id !== 'default').map((p) => [p.id, p.sortOrder]))
  check('a four-row drag persists every position', order2.every((id, i) => afterFull[id] === i), JSON.stringify(afterFull))

  // ── input validation: the handler passes straight through ──
  for (const bad of [undefined, null, 'proj_a', [42], [null]]) {
    let threw = false
    try { await projectStore.reorder(bad) } catch { threw = true }
    check(`garbage input is rejected: ${JSON.stringify(bad)}`, threw)
  }
  const unchanged = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE sort_order IS NOT NULL').get()
  check('the rejected calls wrote nothing', unchanged.n === order2.length, String(unchanged.n))

  // ── the named-binding trap, behaviorally: a positional-bind rewrite of the
  // UPDATE would bind (order, id) as (?, ?) and — the exact failure shape that
  // poisoned conversation project bindings — write the id into sort_order. ──
  const swapped = db.prepare('SELECT id, typeof(sort_order) AS t FROM projects WHERE id = ?').get(created.id)
  check('sort_order stays numeric, not the id string', swapped.t === 'integer' || swapped.t === 'real', swapped.t)
}

// ── runner (the color probe's recipe) ──────────────────────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-project-reorder-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild'],
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-reorder-'))
  const report = join(work, 'reorder.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'reorder',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  const failed = payload.checks.filter((c) => !c.pass).length + (res.status !== 0 ? 1 : 0)
  if (res.status !== 0) console.log(`  ✗ phase exited with ${res.status}`)

  if (KEEP) console.log(`\nkept: ${home}`)
  else rmSync(home, { recursive: true, force: true })

  console.log(`\n${payload.checks.length - failed}/${payload.checks.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  phaseReorder()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase threw: ${err?.stack || err}`)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
