/**
 * Project overview persistence probe (real SQLite, real main-process modules,
 * no Electron window) — the `scripts/probe-project-color-db.mjs` recipe applied
 * to 项目概述 (2026-09-18).
 *
 * The overview is a stored field (`projects.overview`, ≤50 chars, optional)
 * that rides the conversation prompt's `## Project` state-block section. The
 * prompt half is pinned by tests/project-overview.test.ts (pure logic, no DB);
 * what ONLY this probe can see is the storage half, because vitest cannot open
 * the database (better-sqlite3 here is built for Electron's ABI and `npm test`
 * runs under plain Node).
 *
 * The same bundling trick as the color probe: main-process modules are bundled
 * with esbuild (`electron` aliased to a stub) and executed by the Electron
 * binary in ELECTRON_RUN_AS_NODE mode — same ABI, so the native module loads.
 * `HOME` points at a throwaway temp dir, and every phase refuses to start
 * unless DATA_DIR is provably inside it; the user's real ~/.pulsemind is never
 * opened.
 *
 * Two phases:
 *   1. `legacy` — seeds the projects table *without* `overview` (the shape an
 *      install upgraded from pre-0.4.0 has on disk), runs the real
 *      `initializeDatabase`, and asserts the ALTER adds the column with the
 *      rows intact.
 *   2. `fresh` — a new database. Asserts the store's whole overview contract:
 *      born-with on create (capped at 50), absent-by-default, editable, and
 *      clearable — an empty-string patch must land as NULL on disk, not '' —
 *      while a patch that omits overview keeps the stored value.
 *
 * Usage: node scripts/probe-project-overview.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE
const KEEP = process.argv.includes('--keep')

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

/** better-sqlite3 is `external` to the bundle and resolved from the repo. */
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

// ── phase 1 · an existing install upgrades in place ───────────────────────
async function phaseLegacy() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)

  // The table as it exists on disk before this change: no overview column.
  mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
  const seed = new Database(dbPath(DATA_DIR))
  seed.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL,
    icon TEXT,
    color_hue INTEGER,
    sandbox_json TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const stamp = '2026-09-01T00:00:00.000Z'
  const insert = seed.prepare(
    'INSERT INTO projects (id, name, workspace_dir, icon, color_hue, sandbox_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)'
  )
  insert.run('proj_legacy_a', '升级前的项目', join(DATA_DIR, 'ws-a'), null, 42, '{}', stamp, stamp)
  insert.run('proj_legacy_b', '另一个项目', join(DATA_DIR, 'ws-b'), null, null, '{}', stamp, stamp)
  check('fixture: the pre-upgrade table has no overview', !columns(seed, 'projects').includes('overview'))
  seed.close()

  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  check('migration adds overview to a table that already existed', columns(db, 'projects').includes('overview'))
  const rows = db.prepare('SELECT id, name, overview FROM projects ORDER BY id').all()
  check('the pre-existing rows survive the migration', rows.length === 2, `${rows.length} row(s)`)
  check('their overview is NULL — 无概述就是无概述，不是空字符串', rows.every((r) => r.overview === null))
}

// ── phase 2 · the store's whole overview contract on a fresh database ─────
async function phaseFresh() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const { projectStore } = await import('../src/main/storage/project-store')
  const { PROJECT_OVERVIEW_MAX_LENGTH } = await import('../src/shared/types/project')

  check('a brand-new schema ships the column with the table', columns(getDb(), 'projects').includes('overview'))

  // create(): the overview is normalized (trim + 50-char cap) and lands on the row.
  const longOverview = '这是一个远超五十字限制的概述'.repeat(6) // 84 chars
  const capped = await projectStore.create({
    name: '设计系统',
    workspaceDir: join(DATA_DIR, 'ws-design'),
    overview: longOverview,
  })
  check(`create() caps the overview at ${PROJECT_OVERVIEW_MAX_LENGTH}`, capped.overview?.length === PROJECT_OVERVIEW_MAX_LENGTH, `${capped.overview?.length} chars`)
  const rawRow = getDb().prepare('SELECT overview FROM projects WHERE id = ?').get(capped.id)
  check('the capped overview is on the row, not just in the return value', rawRow.overview === capped.overview, `${rawRow.overview?.length} chars on disk`)
  check('get() reads it back from the row', (await projectStore.get(capped.id)).overview === capped.overview)

  const bare = await projectStore.create({ name: '无概述项目', workspaceDir: join(DATA_DIR, 'ws-bare') })
  check('create() without an overview stores NULL', (await projectStore.get(bare.id)).overview === undefined)
  const whitespace = await projectStore.create({ name: '空白概述项目', workspaceDir: join(DATA_DIR, 'ws-blank'), overview: '   ' })
  check('a whitespace-only overview normalizes to absent', (await projectStore.get(whitespace.id)).overview === undefined)

  // update(): set, keep, and CLEAR.
  const updated = await projectStore.update(capped.id, { overview: '给设计师用的组件库' })
  check('update() writes a new overview', updated.overview === '给设计师用的组件库')
  check('…on disk too', getDb().prepare('SELECT overview FROM projects WHERE id = ?').get(capped.id).overview === '给设计师用的组件库')

  const untouched = await projectStore.update(capped.id, { name: '设计系统 v2' })
  check('a patch without overview keeps the stored value', untouched.overview === '给设计师用的组件库' && untouched.name === '设计系统 v2', untouched.name)

  // The modal's edit save always rides `overview: overview.trim()` — a cleared
  // box sends ''. That must clear the column, not be read as "not in patch".
  const cleared = await projectStore.update(capped.id, { name: '设计系统 v2', overview: '' })
  check('an empty-string patch clears the overview', cleared.overview === undefined)
  check('the cleared column is NULL on disk', getDb().prepare('SELECT overview FROM projects WHERE id = ?').get(capped.id).overview === null)

  const list = await projectStore.list()
  check('list() carries each project\'s overview off its row', list.find((p) => p.id === bare.id).overview === undefined && list.find((p) => p.id === capped.id).overview === undefined)
  check('the synthesized default project has no row, hence no overview', list[0].id === 'default' && list[0].overview === undefined)
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

  const work = mkdtempSync(join(tmpdir(), 'pm-project-overview-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    // better-sqlite3 is resolved at runtime from the repo (NODE_PATH) so its
    // native binding keeps working. jsdom / playwright-core / chromium-bidi
    // ride in through the knowledge-store extractor's import graph and are
    // pure-JS: leaving them external sidesteps esbuild's inability to resolve
    // playwright-core's internal subpaths, and the runtime requires resolve
    // from NODE_PATH (they are never exercised by these phases anyway).
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
        HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
      },
    })
    if (res.error) throw res.error
    let payload = { checks: [] }
    if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
    return { status: res.status, ...payload }
  }

  const legacyHome = mkdtempSync(join(tmpdir(), 'pm-home-overview-legacy-'))
  const freshHome = mkdtempSync(join(tmpdir(), 'pm-home-overview-fresh-'))
  const homes = [work, legacyHome, freshHome]
  let failed = 0
  let total = 0

  console.log(`① an existing install upgrades in place            HOME=${legacyHome}`)
  const one = run('legacy', legacyHome)
  total += one.checks.length
  failed += one.checks.filter((c) => !c.pass).length
  if (one.status !== 0) { failed++; console.log(`  ✗ phase legacy exited with ${one.status}`) }

  console.log(`\n② the store's overview contract on a fresh database HOME=${freshHome}`)
  const two = run('fresh', freshHome)
  total += two.checks.length
  failed += two.checks.filter((c) => !c.pass).length
  if (two.status !== 0) { failed++; console.log(`  ✗ phase fresh exited with ${two.status}`) }

  // ③ The wiring no DB phase can see: which surface writes what.
  console.log('\n③ every surface writes the same field')
  const modal = readFileSync(join(REPO_ROOT, 'src/renderer/src/components/project/ProjectModal.tsx'), 'utf-8')
  const manager = readFileSync(join(REPO_ROOT, 'src/main/agent/session-manager.ts'), 'utf-8')
  const handler = readFileSync(join(REPO_ROOT, 'src/main/ipc/project.handler.ts'), 'utf-8')
  const builder = readFileSync(join(REPO_ROOT, 'src/renderer/src/agent/system-prompt-builder.ts'), 'utf-8')
  const wired = [
    ['the edit save always rides overview (clearing works)', /overview:\s*overview\.trim\(\)/.test(modal), ''],
    ['create() sends the overview too', /overview:\s*overview\.trim\(\) \|\| undefined/.test(modal), ''],
    ['doCreateSession resolves the bound project', /opts\.projectId \?\? getConversationProjectId\(sessionId\)/.test(manager), ''],
    ['refreshOptions re-reads it (overview is not a session pin)', /projectName,\s*\n\s*projectOverview,/.test(manager), ''],
    ['PROJECT_UPDATE sweeps the project\'s live sessions', /refreshProjectSessions\(id\)/.test(handler), ''],
    ['…guarded against the default project (its sessions are everyone\'s)', /id !== DEFAULT_PROJECT_ID/.test(handler), ''],
    ['the state block renders a ## Project section', /buildProjectSection\(/.test(builder), ''],
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
  if (PHASE === 'legacy') return phaseLegacy()
  if (PHASE === 'fresh') return phaseFresh()
  throw new Error(`unknown PM_PHASE ${PHASE}`)
}

if (PHASE) {
  phaseMain()
    .then(() => {
      const payload = { checks: results }
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
