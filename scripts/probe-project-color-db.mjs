/**
 * Project identity-color persistence probe (real SQLite, real main-process
 * modules, no Electron window).
 *
 * A project's color used to be derived at paint time — `stringToHue(name)` in
 * the renderer, on every render — and the consequence was written into the
 * feature: renaming a project moved its color, and two surfaces had to agree on
 * the hashing to agree on the color. Since 2026-09-16 it is a stored field
 * (`projects.color_hue`), assigned once at creation, and this probe is the only
 * place that can see whether the *storage* half of that actually holds:
 * vitest cannot open the database at all (better-sqlite3 here is built for
 * Electron's ABI, and `npm test` runs under plain Node — the repo's "DB-layer
 * coverage is a known gap"), and the renderer probes never touch SQL.
 *
 * How it gets a real database without an Electron app: the main-process modules
 * are bundled with esbuild (`platform: node`, `electron` aliased to a four-line
 * stub, because `require('electron')` outside a running app returns a *string*,
 * not the module) and the bundle is executed by the Electron binary itself in
 * `ELECTRON_RUN_AS_NODE` mode — same V8, same ABI, so the native module loads.
 * `DATA_DIR` is `homedir()/.pulsemind` and `homedir()` honours `$HOME`, so every
 * run is sandboxed into a fresh temp directory; the phases refuse to start
 * unless `DATA_DIR` is provably inside it. The user's real `~/.pulsemind` is
 * never opened.
 *
 * Three phases, three processes, one database:
 *
 *   1. `legacy` — seeds the projects table *without* `color_hue` (the shape a
 *      pre-upgrade install has on disk), then runs the real `initializeDatabase`
 *      and `backfillProjectColors`. Asserts the ALTER adds the column, the rows
 *      survive, and each one gets exactly the hue the renderer already painted
 *      it with — i.e. no existing project changes color.
 *   2. `rerun` — the same database, a fresh process. Asserts the second backfill
 *      (the one every subsequent app start performs) is a no-op for rows that
 *      have a color and still reaches rows that do not. This is why the phase
 *      needs its own process: the backfill's early return is a module-level flag,
 *      so a same-process second call would prove nothing about the SQL predicate.
 *   3. `fresh` — an empty data dir. Asserts a new project is *born* with a stored
 *      hue, that reading it back comes off the row, that renaming it keeps that
 *      hue (the point of storing it), and that the renderer's `projectHue`
 *      prefers the stored value over the hash of the current name.
 *
 * Usage: node scripts/probe-project-color-db.mjs [--keep]
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

// ── the fixture, shared by every phase (they must agree on it verbatim) ──
// `Gamma` carries a color before the backfill runs — the one state the
// backfill's `WHERE color_hue IS NULL` predicate has to respect. The value is
// derived from the name's own hash and offset by half the circle so it cannot
// coincidentally equal what the backfill would write.
const LEGACY = [
  { id: 'proj_legacy_research', name: '研究项目' },
  { id: 'proj_legacy_alpha', name: 'Alpha' },
  { id: 'proj_legacy_gamma', name: 'Gamma' },
]
const FILLED_BY_BACKFILL = ['proj_legacy_research', 'proj_legacy_alpha']
/** A row that arrives after a backfill already ran (any insert path that does
 *  not set the column) — phase `rerun` proves the next startup reaches it. */
const LATE = { id: 'proj_legacy_late', name: '后来的项目' }

// ── reporting ──────────────────────────────────────────────────────────────
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

const dbPath = (dataDir) => join(dataDir, 'db', 'pulsemind.db')
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

/** better-sqlite3 is `external` to the bundle, and the bundle lives in a temp
 *  directory — so it has to be required through a repo-anchored resolver rather
 *  than an import the bundle would resolve from its own location. */
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

// ── phase 1 · an existing install upgrades in place ───────────────────────
async function phaseLegacy() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  const { stringToHue } = await import('../src/shared/hash-color')
  const handSet = (stringToHue('Gamma') + 180) % 360

  // The table as it exists on disk before this change: no color_hue.
  mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
  const seed = new Database(dbPath(DATA_DIR))
  seed.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL,
    icon TEXT,
    sandbox_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const insert = seed.prepare(
    'INSERT INTO projects (id, name, workspace_dir, icon, sandbox_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  )
  const stamp = '2026-09-01T00:00:00.000Z'
  for (const p of LEGACY) insert.run(p.id, p.name, join(DATA_DIR, 'legacy-ws', p.id), '{}', stamp, stamp)
  check('fixture: the pre-upgrade table has no color_hue', !columns(seed, 'projects').includes('color_hue'))
  seed.close()

  // The real startup sequence (main/index.ts): ensureDataDir → initializeDatabase.
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  check('migration adds color_hue to a table that already existed', columns(db, 'projects').includes('color_hue'))
  const afterMigrate = db.prepare('SELECT id, name, color_hue FROM projects ORDER BY id').all()
  check('the pre-existing rows survive the migration', afterMigrate.length === LEGACY.length, `${afterMigrate.length} row(s)`)
  check(
    'their color_hue is NULL until the backfill runs',
    afterMigrate.every((r) => r.color_hue === null),
    afterMigrate.map((r) => r.color_hue).join(',')
  )

  db.prepare('UPDATE projects SET color_hue = ? WHERE id = ?').run(handSet, 'proj_legacy_gamma')

  const { backfillProjectColors, hueForProjectName } = await import('../src/main/storage/project-store')
  check(
    'hueForProjectName is the renderer’s own hash (so no project changes color)',
    LEGACY.every((p) => hueForProjectName(p.name) === stringToHue(p.name)),
    LEGACY.map((p) => `${p.name}=${hueForProjectName(p.name)}`).join(' ')
  )

  await backfillProjectColors()
  const filled = db.prepare('SELECT id, name, color_hue FROM projects ORDER BY id').all()
  const byName = new Map(LEGACY.map((p) => [p.id, p.name]))
  check('every legacy row now carries a color', filled.every((r) => r.color_hue !== null))
  check(
    'each one got exactly the hue the renderer painted it with',
    filled.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).every((r) => r.color_hue === stringToHue(byName.get(r.id))),
    filled.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).map((r) => `${byName.get(r.id)}=${r.color_hue}`).join(' ')
  )
  check(
    'non-vacuity: it did not write one constant hue to every row',
    new Set(filled.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).map((r) => r.color_hue)).size === FILLED_BY_BACKFILL.length,
    `${new Set(filled.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).map((r) => r.color_hue)).size} distinct of ${FILLED_BY_BACKFILL.length}`
  )
  check(
    'a row that already had a color is left alone',
    filled.find((r) => r.id === 'proj_legacy_gamma').color_hue === handSet,
    `${handSet} vs hash ${stringToHue('Gamma')}`
  )

  // Leave a NULL row behind so phase `rerun` can exercise the predicate in a
  // process whose flag is still false.
  db.prepare(
    'INSERT INTO projects (id, name, workspace_dir, icon, sandbox_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  ).run(LATE.id, LATE.name, join(DATA_DIR, 'legacy-ws', LATE.id), '{}', stamp, stamp)

  return { handSet }
}

// ── phase 2 · the next app start (fresh process, same database) ────────────
async function phaseRerun({ handSet }) {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  const { stringToHue } = await import('../src/shared/hash-color')
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  check('a later start re-runs the migration without incident', columns(db, 'projects').includes('color_hue'))
  const before = db.prepare('SELECT id, color_hue FROM projects ORDER BY id').all()
  check(
    'the database still holds every row the first run left',
    before.length === LEGACY.length + 1,
    `${before.length} row(s), expected ${LEGACY.length + 1}`
  )
  check(
    'the database still holds the colors the first run wrote',
    before.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).every((r) => r.color_hue === stringToHue(LEGACY.find((p) => p.id === r.id).name)),
    before.filter((r) => FILLED_BY_BACKFILL.includes(r.id)).map((r) => `${r.id}=${r.color_hue}`).join(' ')
  )
  check(
    'the late row starts out NULL',
    before.find((r) => r.id === LATE.id).color_hue === null,
    String(before.find((r) => r.id === LATE.id).color_hue)
  )

  const { backfillProjectColors } = await import('../src/main/storage/project-store')
  await backfillProjectColors()
  const after = db.prepare('SELECT id, color_hue FROM projects ORDER BY id').all()
  check(
    'the backfill reaches a row that appeared after the previous one',
    after.find((r) => r.id === LATE.id).color_hue === stringToHue(LATE.name),
    `${after.find((r) => r.id === LATE.id).color_hue} = hash(${LATE.name})`
  )
  check(
    'and it still does not touch a row that has a color',
    after.find((r) => r.id === 'proj_legacy_gamma').color_hue === handSet,
    `${after.find((r) => r.id === 'proj_legacy_gamma').color_hue} vs ${handSet}`
  )
  check(
    'the rows it did fill are byte-identical to the previous run',
    JSON.stringify(after.filter((r) => FILLED_BY_BACKFILL.includes(r.id))) ===
      JSON.stringify(before.filter((r) => FILLED_BY_BACKFILL.includes(r.id)))
  )
}

// ── phase 3 · a new project is born with its color on the row ──────────────
async function phaseFresh() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  const { stringToHue } = await import('../src/shared/hash-color')
  const { DEFAULT_PROJECT_ID } = await import('../src/shared/types/project')
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { projectStore } = await import('../src/main/storage/project-store')

  check('a brand-new schema ships the column with the table', columns(getDb(), 'projects').includes('color_hue'))

  const created = await projectStore.create({ name: '设计系统', workspaceDir: join(DATA_DIR, 'ws-design') })
  check('create() gives the project its identity hue', created.colorHue === stringToHue('设计系统'), String(created.colorHue))
  const raw = getDb().prepare('SELECT color_hue FROM projects WHERE id = ?').get(created.id)
  check('the hue is on the row, not just in the return value', raw.color_hue === created.colorHue, String(raw.color_hue))
  check('get() reads it back from the row', (await projectStore.get(created.id)).colorHue === created.colorHue)

  const renamed = '设计系统 v2'
  check(
    'non-vacuity: the new name would hash to a different hue',
    stringToHue(renamed) !== created.colorHue,
    `${stringToHue(renamed)} vs ${created.colorHue}`
  )
  const updated = await projectStore.update(created.id, { name: renamed })
  check('renaming keeps the color the project was born with', updated.colorHue === created.colorHue, String(updated.colorHue))
  const reread = await projectStore.get(created.id)
  check('…on disk too, not only in the returned object', reread.colorHue === created.colorHue && reread.name === renamed, `${reread.name} / ${reread.colorHue}`)

  // The behavioral form of "the UPDATE statement does not write color_hue":
  // hand the row a color no name could hash to, rename it, and see whether it
  // survives. A statement that wrote the hue alongside the name would clobber it.
  const foreign = (created.colorHue + 180) % 360
  getDb().prepare('UPDATE projects SET color_hue = ? WHERE id = ?').run(foreign, created.id)
  await projectStore.update(created.id, { name: '设计系统 v3' })
  check(
    'renaming does not write color_hue at all',
    (await projectStore.get(created.id)).colorHue === foreign,
    `${(await projectStore.get(created.id)).colorHue} vs ${foreign}`
  )

  const list = await projectStore.list()
  check(
    'list() carries the hue off the row, so the renderer never hashes',
    list.find((p) => p.id === created.id).colorHue === foreign,
    `${list.find((p) => p.id === created.id).colorHue} vs row ${foreign}`
  )
  check(
    'the synthesized default project has no row, hence no hue to carry',
    list[0].id === DEFAULT_PROJECT_ID && list[0].colorHue === undefined,
    `${list[0].id} / ${String(list[0].colorHue)}`
  )

  // The renderer contract the stored field exists for.
  const { projectHue } = await import('../src/renderer/src/stores/projectStore')
  check('projectHue prefers the stored hue over the current name', projectHue({ name: renamed, colorHue: 200 }) === 200)
  check(
    'projectHue falls back to the name hash when nothing is stored',
    projectHue({ name: 'Alpha' }) === stringToHue('Alpha'),
    String(projectHue({ name: 'Alpha' }))
  )
}

// ── runner ─────────────────────────────────────────────────────────────────
async function launcher() {
  // `process.argv[1]` rather than `import.meta.url`: the phases are spawned from
  // a CJS bundle, where import.meta is empty (and esbuild warns about it).
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-project-color-db-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    // better-sqlite3 is resolved at runtime from the repo (NODE_PATH) so its
    // native binding keeps working; esbuild is the bundler itself.
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

  const run = (phase, home, extra = {}) => {
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
        HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    })
    if (res.error) throw res.error
    let payload = { checks: [] }
    if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
    return { status: res.status, ...payload }
  }

  const legacyHome = mkdtempSync(join(tmpdir(), 'pm-home-legacy-'))
  const freshHome = mkdtempSync(join(tmpdir(), 'pm-home-fresh-'))
  const homes = [work, legacyHome, freshHome]
  let failed = 0
  let total = 0

  console.log(`① an existing install upgrades in place        HOME=${legacyHome}`)
  const one = run('legacy', legacyHome)
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) { failed++; console.log(`  ✗ phase legacy exited with ${one.status}`) }

  console.log(`\n② the next app start backfills only what is missing`)
  const two = run('rerun', legacyHome, { handSet: one.handSet })
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) { failed++; console.log(`  ✗ phase rerun exited with ${two.status}`) }

  console.log(`\n③ a new project is born with its color        HOME=${freshHome}`)
  const three = run('fresh', freshHome)
  total += three.checks.length
  failed += three.checks.filter((c) => !c.pass).length
  if (three.status !== 0) { failed++; console.log(`  ✗ phase fresh exited with ${three.status}`) }

  // ④ The wiring, which no phase above can see: they call the backfill
  // themselves. If the startup sequence ever stops calling it, nothing breaks
  // loudly — old projects just keep being painted from the name hash, which
  // looks identical until someone renames one.
  console.log('\n④ the startup sequence actually runs it')
  const main = readFileSync(join(REPO_ROOT, 'src/main/index.ts'), 'utf-8')
  const after = main.indexOf('backfillConversationWorkspaces()')
  const call = main.indexOf('await backfillProjectColors()')
  const imported = /import \{[^}]*backfillProjectColors[^}]*\} from '\.\/storage\/project-store'/.test(main)
  const wired = [
    ['main/index.ts awaits backfillProjectColors()', call > 0, `at char ${call}`],
    ['…after the workspace backfill, with the database already open', after > 0 && call > after, `workspaces ${after} < colors ${call}`],
    ['and it is imported from the project store', imported, ''],
  ]
  for (const [name, ok, detail] of wired) check(name, ok, detail)
  total += wired.length
  failed += wired.filter(([, ok]) => !ok).length

  if (KEEP) console.log(`\nkept: ${homes.join(' ')}`)
  else for (const h of homes) rmSync(h, { recursive: true, force: true })

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

async function phaseMain() {
  const fixture = JSON.parse(process.env.PM_FIXTURE || '{}')
  if (PHASE === 'legacy') return phaseLegacy()
  if (PHASE === 'rerun') return phaseRerun(fixture)
  if (PHASE === 'fresh') return phaseFresh()
  throw new Error(`unknown PM_PHASE ${PHASE}`)
}

if (PHASE) {
  phaseMain()
    .then((extra) => {
      const payload = { checks: results, ...(extra || {}) }
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify(payload))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
