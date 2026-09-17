/**
 * Conversation project-binding stub probe (real SQLite, real main-process
 * modules, no Electron window).
 *
 * The binding writes (project / expert / approval / workspace) may run before
 * the conversation row exists — the row is materialized by the first save — so
 * each of them stub-inserts a minimal row. `setConversationProject`'s
 * positional stub-insert once bound its parameters in the wrong order: the
 * project id landed in `type` and 'normal' in `project_id`
 * (`conv_20260917084238` on the user's machine is that row: a project-mode
 * first message whose conversation then fell out of every `type = 'normal'`
 * surface — the sidebar's 对话 and 项目 tabs, search, the memory pipeline —
 * and bound to no project). The stubs now bind by name and a startup repair
 * swaps existing poisoned rows back; this probe is the only place that can see
 * whether either half actually holds: vitest cannot open the database at all
 * (better-sqlite3 here is built for Electron's ABI, and `npm test` runs under
 * plain Node — the repo's "DB-layer coverage is a known gap").
 *
 * It runs the real main-process modules against a real database in one child
 * process, bundled with esbuild (`platform: node`, `electron` aliased to a
 * four-line stub, because `require('electron')` outside a running app returns
 * a *string*, not the module) and executed by the Electron binary itself in
 * `ELECTRON_RUN_AS_NODE` mode — same V8, same ABI, so the native module loads.
 * `DATA_DIR` is `homedir()/.pulsemind` and `homedir()` honours `$HOME`, so the
 * run is sandboxed into a fresh temp directory; `guardHome` refuses to start
 * unless `DATA_DIR` is provably inside it. The user's real `~/.pulsemind` is
 * never opened.
 *
 * Usage: node scripts/probe-conversation-project-stub.mjs [--keep]
 *        (run from the repo root; needs `npx electron` to be installed)
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const row = (db, id) => db.prepare('SELECT id, title, type, project_id, expert_id, approval_mode, workspace_dir, created_at, updated_at FROM conversations WHERE id = ?').get(id)

// ── the one phase · the stubs, the save, and the repair ────────────────────
async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  const {
    setConversationProject,
    setConversationExpert,
    setConversationApprovalMode,
    setConversationWorkspaceDir,
    getConversationProjectId,
    listConversations,
    repairSwappedProjectBindings,
    saveConversation
  } = await import('../src/main/storage/conversation.db')

  // ── ① the project stub-insert writes a visible, project-bound row ──
  // Fresh database: the row cannot exist, so the stub path is the one taken.
  setConversationProject('conv_20260917090000', 'proj_alpha')
  const proj = row(db, 'conv_20260917090000')
  check('stub-insert creates the row', !!proj)
  check('type is the conversation type, not the project id', proj?.type === 'normal', proj?.type)
  check('project_id carries the binding', proj?.project_id === 'proj_alpha', proj?.project_id)
  const listed = listConversations().find((c) => c.id === 'conv_20260917090000')
  check('listConversations() lists it (type=normal) under its project', !!listed && listed.projectId === 'proj_alpha', listed ? listed.projectId : 'not listed')
  check('getConversationProjectId resolves the binding', getConversationProjectId('conv_20260917090000') === 'proj_alpha', getConversationProjectId('conv_20260917090000'))

  // ── ② the first save keeps the binding (the stub's whole contract) ──
  saveConversation({
    id: 'conv_20260917090000',
    title: '啦啦啦',
    createdAt: '2026-09-17T00:42:38.825Z',
    messages: [{ id: 'msg_1', role: 'user', content: '啦啦啦', createdAt: '2026-09-17T00:42:38.825Z' }]
  })
  const saved = row(db, 'conv_20260917090000')
  check('the full save does not touch project_id', saved?.project_id === 'proj_alpha', saved?.project_id)
  check('…nor type', saved?.type === 'normal', saved?.type)
  check('…and the title landed on top of the stub row', saved?.title === '啦啦啦', saved?.title)

  // ── ③ the sibling stubs (same helper now) keep type='normal' too ──
  setConversationExpert('conv_expert', 'exp_1')
  const expert = row(db, 'conv_expert')
  check('expert stub: type stays normal, expert_id carries the binding', expert?.type === 'normal' && expert?.expert_id === 'exp_1', `${expert?.type} / ${expert?.expert_id}`)

  setConversationApprovalMode('conv_approval', 'unrestricted')
  const approval = row(db, 'conv_approval')
  check('approval stub: type stays normal, approval_mode carries the choice', approval?.type === 'normal' && approval?.approval_mode === 'unrestricted', `${approval?.type} / ${approval?.approval_mode}`)

  setConversationWorkspaceDir('conv_ws', '/tmp/pm-probe-ws')
  const ws = row(db, 'conv_ws')
  check('workspace stub: type stays normal, workspace_dir carries the path', ws?.type === 'normal' && ws?.workspace_dir === '/tmp/pm-probe-ws', `${ws?.type} / ${ws?.workspace_dir}`)

  // ── ④ the repair swaps poisoned rows back, touching nothing else ──
  // Seeded exactly the shape the positional stub-insert wrote: project id in
  // `type`, 'normal' in `project_id`. The healthy and default-shaped rows are
  // the predicate must leave alone.
  const stamp = '2026-09-17T00:42:38.825Z'
  const seed = db.prepare(
    "INSERT INTO conversations (id, title, type, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
  seed.run('conv_poisoned', '啦啦啦', 'proj_beta', 'normal', stamp, stamp)
  seed.run('conv_healthy', '健康的会话', 'normal', 'proj_ok', stamp, stamp)
  seed.run('conv_chat', '松散会话', 'normal', null, stamp, stamp)

  const before = db.prepare('SELECT id, type, project_id FROM conversations ORDER BY id').all()
  repairSwappedProjectBindings()
  const after = db.prepare('SELECT id, type, project_id FROM conversations ORDER BY id').all()
  const poisoned = row(db, 'conv_poisoned')
  check('the poisoned row gets its columns swapped back', poisoned?.type === 'normal' && poisoned?.project_id === 'proj_beta', `${poisoned?.type} / ${poisoned?.project_id}`)
  check('…with its title and timestamps untouched', poisoned?.title === '啦啦啦' && poisoned?.created_at === stamp, `${poisoned?.title}`)
  check(
    'the healthy project row is left alone',
    JSON.stringify(after.find((r) => r.id === 'conv_healthy')) === JSON.stringify(before.find((r) => r.id === 'conv_healthy')),
    `${after.find((r) => r.id === 'conv_healthy')?.type} / ${after.find((r) => r.id === 'conv_healthy')?.project_id}`
  )
  check(
    'a chat row with no project is left alone',
    JSON.stringify(after.find((r) => r.id === 'conv_chat')) === JSON.stringify(before.find((r) => r.id === 'conv_chat')),
    `${after.find((r) => r.id === 'conv_chat')?.type} / ${String(after.find((r) => r.id === 'conv_chat')?.project_id)}`
  )
  check(
    'the repaired row is listed under its project again (type=normal)',
    (() => {
      const entry = db.prepare("SELECT project_id FROM conversations WHERE id = ? AND type = 'normal'").get('conv_poisoned')
      return entry ? entry.project_id : null
    })() === 'proj_beta'
  )

  const snapshot = JSON.stringify(after)
  repairSwappedProjectBindings()
  check('a second repair run changes nothing (idempotent)', JSON.stringify(db.prepare('SELECT id, type, project_id FROM conversations ORDER BY id').all()) === snapshot)

  // ── ⑤ the stub's default guard: 'default' never stubs a row ──
  setConversationProject('conv_default', 'default')
  check("binding 'default' on a missing row does not stub one", !row(db, 'conv_default'))
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

  const work = mkdtempSync(join(tmpdir(), 'pm-conversation-stub-'))
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-stub-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: 'main',
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home, // the sandbox: DATA_DIR is homedir()/.pulsemind
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let total = payload.checks.length
  let failed = payload.checks.filter((c) => !c.pass).length
  if (res.error || res.status !== 0) { failed++; console.log(`  ✗ phase main exited with ${res.status ?? res.error}`) }

  // The wiring, which the phase above cannot see: it calls the repair itself.
  // If the startup sequence ever stops calling it, nothing breaks loudly —
  // poisoned rows just stay invisible, which looks like the original bug.
  console.log('\n② the startup sequence actually runs the repair')
  const main = readFileSync(join(REPO_ROOT, 'src/main/index.ts'), 'utf-8')
  const dbInit = main.indexOf('await initializeDatabase()')
  const colors = main.indexOf('await backfillProjectColors()')
  const repair = main.indexOf('repairSwappedProjectBindings()')
  const cleanup = main.indexOf('cleanupExpiredConversations()')
  const imported = /import \{[^}]*repairSwappedProjectBindings[^}]*\} from '\.\/storage\/conversation\.db'/.test(main)
  const wired = [
    ['main/index.ts calls repairSwappedProjectBindings()', repair > 0, `at char ${repair}`],
    ['…after the database is open and the color backfill', dbInit > 0 && colors > 0 && repair > colors, `init ${dbInit} < colors ${colors} < repair ${repair}`],
    ['…before the retention cleanup can touch the rows', cleanup > 0 && cleanup > repair, `repair ${repair} < cleanup ${cleanup}`],
    ['and it is imported from conversation.db', imported, ''],
  ]
  for (const [name, ok, detail] of wired) check(name, ok, detail)
  total += wired.length
  failed += wired.filter(([, ok]) => !ok).length

  if (KEEP) console.log(`\nkept: ${home} ${work}`)
  else { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }) }

  console.log(`\n${total - failed}/${total} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

if (PHASE) {
  phaseMain()
    .then(() => {
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(results.every((r) => r.pass) ? 0 : 1)
    })
    .catch((err) => {
      console.error(`\n✗ phase ${PHASE} threw: ${err?.stack || err}`)
      if (process.env.PM_REPORT) writeFileSync(process.env.PM_REPORT, JSON.stringify({ checks: results }))
      process.exit(1)
    })
} else {
  launcher().catch((err) => {
    console.error(`✗ launcher threw: ${err?.stack || err}`)
    process.exit(1)
  })
}
