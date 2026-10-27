/**
 * Memory-pages SOP/reinforce storage probe (PLAN-experience-sop 刀一) — real
 * SQLite, real main-process store modules, no Electron window.
 *
 * vitest cannot open the database (better-sqlite3 is Electron-ABI; `npm test`
 * runs plain Node), so the store-side behaviour of the 刀一 changes is proven
 * here: esbuild-bundle the main modules, run the bundle under the Electron
 * binary in ELECTRON_RUN_AS_NODE mode (same V8, same ABI), sandboxed into a
 * fresh temp HOME so the user's real ~/.pulsemind is never opened — the same
 * recipe as scripts/probe-project-color-db.mjs.
 *
 * What only a real database can prove:
 *   - the ALTER migrations land on a pre-upgrade table AND a fresh CREATE;
 *   - reinforce bumps recurrence/last_reinforced_at and appends the 重现记录
 *     section (FIFO ≤10) on the live row;
 *   - reinforce refuses non-experience targets;
 *   - create/supersede derive maturity from files; the 脚本保全 guard rejects a
 *     supersede that would drop scripts, and a files-carrying supersede hands
 *     maturity over;
 *   - alias/update leave an SOP page's files untouched;
 *   - touchMemoryPage books use_count/last_used_at;
 *   - the FTS row tracks a reinforce-extended body;
 *   - (2026-10-27) the `enabled` switch column: migration default, toggle
 *     persistence without an updated_at bump, inheritance across supersede;
 *   - (2026-10-27) skill_uses per-name upsert counting (技能卡「使用 N 次」);
 *   - (2026-10-27) the retire soft state: audit reason mandatory, updated_at
 *     untouched, live index/count/search all exclude, restore clears back.
 *
 * Usage: node scripts/probe-memory-pages-sop.mjs [--keep]
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

const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))
const dbPath = (dataDir) => join(dataDir, 'db', 'pulsemind.db')
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
const SCRIPT = { path: 'scripts/deploy.mjs', content: 'console.log("deploy")\n' }

async function phaseMain() {
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)

  // Simulate a pre-upgrade install: memory_pages exists WITHOUT the three new
  // columns (the 2026-10-25 wiki schema), with one live experience row.
  const Database = fromRepo('better-sqlite3')
  mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
  const seed = new Database(dbPath(DATA_DIR))
  seed.exec(`CREATE TABLE memory_pages (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('preference','decision','fact','experience')),
    body TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]',
    superseded_by TEXT, source_conversation_id TEXT, files_json TEXT,
    use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
    content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  seed.prepare(`INSERT INTO memory_pages (id, title, type, body, aliases, links, content_hash, created_at, updated_at)
    VALUES ('page_legacy', '手工部署八步', 'experience', '## 背景\n每次发布都手动走八步。', '[]', '[]', 'seed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`)
    .run()
  check('fixture: the pre-upgrade table has no maturity/recurrence columns',
    !columns(seed, 'memory_pages').includes('maturity') && !columns(seed, 'memory_pages').includes('recurrence'))
  seed.close()

  ensureDataDir()
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  check('migration adds maturity with clue default on an existing table', columns(db, 'memory_pages').includes('maturity'))
  check('migration adds recurrence + last_reinforced_at', columns(db, 'memory_pages').includes('recurrence') && columns(db, 'memory_pages').includes('last_reinforced_at'))
  check('legacy row survives with maturity=clue',
    db.prepare("SELECT maturity, recurrence FROM memory_pages WHERE id = 'page_legacy'").get()?.maturity === 'clue')

  const store = await import('../src/main/storage/memory-pages-store')

  // ── reinforce on a clue page ──
  const r1 = store.applyPageOps([{ action: 'reinforce', target: '手工部署八步', note: '这次发布又手动走了八步' }])
  check('reinforce on a clue page succeeds', r1[0].ok, r1[0].error)
  let legacy = store.getMemoryPageById('page_legacy')
  check('recurrence bumped to 1, last_reinforced_at set', legacy.recurrence === 1 && !!legacy.lastReinforcedAt)
  check('body grew a 重现记录 section with the note', legacy.body.includes('## 重现记录') && legacy.body.includes('- ') && legacy.body.includes('又手动走了八步'))
  check('maturity stays clue (reinforce adds no scripts)', legacy.maturity === 'clue')

  for (let i = 2; i <= 13; i++) {
    store.applyPageOps([{ action: 'reinforce', target: '手工部署八步', note: `第 ${i} 次重现` }])
  }
  legacy = store.getMemoryPageById('page_legacy')
  const noteLines = legacy.body.split('## 重现记录')[1].split('\n').filter((l) => l.trim().startsWith('- '))
  check(`13 reinforces → recurrence 13, FIFO capped at 10 note lines`, legacy.recurrence === 13 && noteLines.length === 10, `${noteLines.length} lines`)
  check('newest note on top', noteLines[0].includes('第 13 次重现'))

  // ── reinforce discipline ──
  store.applyPageOps([{ action: 'create', title: '用户称呼', type: 'preference', content: '称呼老大' }])
  const wrongType = store.applyPageOps([{ action: 'reinforce', target: '用户称呼', note: 'x' }])
  check('reinforce refuses a non-experience page', !wrongType[0].ok, wrongType[0].error)
  const noNote = store.applyPageOps([{ action: 'reinforce', target: '手工部署八步', note: '  ' }])
  check('reinforce refuses an empty note', !noNote[0].ok, noNote[0].error)
  const ghost = store.applyPageOps([{ action: 'reinforce', target: '不存在的页', note: 'x' }])
  check('reinforce on a hallucinated target fails clean (TARGET_NOT_FOUND)', !ghost[0].ok, ghost[0].error)

  // ── maturity derivation on write paths ──
  const sop = store.applyPageOps([{
    action: 'create', title: '验证过的部署SOP', type: 'experience',
    content: '## 背景\n部署流程。', files: [SCRIPT],
  }])
  check('create with files derives maturity=sop', sop[0].ok && store.getMemoryPageById(sop[0].pageId).maturity === 'sop')
  const plain = store.applyPageOps([{ action: 'create', title: '普通经验', type: 'experience', content: '## 背景\nx' }])
  check('create without files stays clue', store.getMemoryPageById(plain[0].pageId).maturity === 'clue')

  // ── 脚本保全护栏 ──
  const dropped = store.applyPageOps([{
    action: 'supersede', target: '验证过的部署SOP', title: '部署SOP v2', type: 'experience', content: '无脚本的改写',
  }])
  check('supersede that would drop scripts is REJECTED', !dropped[0].ok, dropped[0].error)
  check('…and the SOP page still stands (lineage untouched)',
    store.getMemoryPageById(sop[0].pageId).supersededBy === null)
  const carried = store.applyPageOps([{
    action: 'supersede', target: '验证过的部署SOP', title: '部署SOP v2', type: 'experience',
    content: '## 背景\n部署流程 v2。', files: [SCRIPT, { path: 'scripts/verify.mjs', content: 'console.log(2)\n' }],
  }])
  const v2 = carried[0].ok ? store.getMemoryPageById(carried[0].pageId) : null
  check('files-carrying supersede passes and hands maturity over', !!v2 && v2.maturity === 'sop' && v2.files.length === 2)
  check('the old SOP page is superseded by the new one', store.getMemoryPageById(sop[0].pageId).supersededBy === carried[0].pageId)

  // ── alias/update leave an SOP page's scripts untouched ──
  const aliased = store.applyPageOps([{ action: 'alias', target: '部署SOP v2', aliases: ['部署'] }])
  check('alias on an SOP page keeps files', aliased[0].ok && store.getMemoryPageById(carried[0].pageId).files.length === 2)
  const updated = store.applyPageOps([{ action: 'update', target: '部署SOP v2', content: '## 背景\n部署流程 v2 修订。' }])
  check('update on an SOP page keeps files', updated[0].ok && store.getMemoryPageById(carried[0].pageId).files.length === 2)

  // ── touch 记账 ──
  const before = store.getMemoryPageById(carried[0].pageId).useCount
  store.touchMemoryPage(carried[0].pageId)
  const after = store.getMemoryPageById(carried[0].pageId)
  check('touchMemoryPage bumps use_count and stamps last_used_at', after.useCount === before + 1 && !!after.lastUsedAt)

  // ── FTS 跟手：reinforce 扩写过的正文可被检索 ──
  const hits = store.searchMemoryPages({ query: '八步', type: 'experience' })
  check('FTS finds the reinforced body', hits.some((h) => h.record.id === 'page_legacy'), `${hits.length} hit(s)`)
  const sopHits = store.searchMemoryPages({ query: '部署流程' })
  check('search resolves a superseded hit to the live SOP page',
    sopHits.some((h) => h.record.title === '部署SOP v2') && sopHits.every((h) => h.record.title !== '验证过的部署SOP'),
    sopHits.map((h) => h.record.title).join(' | '))

  // ── upsert 幂等（迁移路径）带 maturity ──
  const one = store.upsertMemoryPage({ id: 'page_up', title: '迁移页', type: 'experience', body: 'b', files: [SCRIPT] })
  const two = store.upsertMemoryPage({ id: 'page_up', title: '迁移页', type: 'experience', body: 'b', files: [SCRIPT] })
  check('upsert with files derives sop and is idempotent (same updatedAt)',
    one.maturity === 'sop' && two.updatedAt === one.updatedAt)

  // ── 经验卡开关（2026-10-27，经验也是技能）：迁移默认启用、停用不动 updated_at、
  //    supersede 继任页继承开关态（用户停用过的经验不该被 merge 悄悄复活）──
  check('migration adds enabled (default 1) on the legacy table', columns(db, 'memory_pages').includes('enabled'))
  check('legacy row reads enabled=true', store.getMemoryPageById('page_legacy').enabled === true)
  const beforeToggle = store.getMemoryPageById(plain[0].pageId)
  store.setMemoryPageEnabled(plain[0].pageId, false)
  const off = store.getMemoryPageById(plain[0].pageId)
  check('setMemoryPageEnabled(false) persists without bumping updated_at (card keeps its list position)',
    off.enabled === false && off.updatedAt === beforeToggle.updatedAt)
  const inherited = store.applyPageOps([{ action: 'supersede', target: '普通经验', title: '普通经验 v2', type: 'experience', content: '## 适用场景\n改写。' }])
  check('supersede successor inherits the switch (disabled stays disabled)',
    inherited[0].ok && store.getMemoryPageById(inherited[0].pageId).enabled === false, inherited[0].error)
  store.setMemoryPageEnabled(inherited[0].pageId, true)
  check('setMemoryPageEnabled(true) flips back', store.getMemoryPageById(inherited[0].pageId).enabled === true)
  check('a fresh create is enabled by default', store.getMemoryPageById(sop[0].pageId).enabled === true)

  // ── 技能使用计数（2026-10-27）：skill_uses 按名 upsert，+1 并盖 last_used_at ──
  const su = await import('../src/main/storage/skill-use-store')
  su.recordSkillUse('deployer'); su.recordSkillUse('deployer'); su.recordSkillUse('other')
  const uses = Object.fromEntries(su.listSkillUses().map((r) => [r.name, r]))
  check('skill_uses: per-name upsert counts (+1 each) and stamps last_used_at',
    uses.deployer?.useCount === 2 && uses.other?.useCount === 1 && !!uses.deployer?.lastUsedAt,
    JSON.stringify(uses))

  // ── 退役软态（2026-10-27，compile pass retire op）：行保留、理由留档、UI 可恢复；
  //    全消费面（索引/计数/检索）排除，updated_at 不动（与开关同纪律）──
  check('migration adds retired_at + retire_reason on the legacy table',
    columns(db, 'memory_pages').includes('retired_at') && columns(db, 'memory_pages').includes('retire_reason'))
  const liveBeforeRetire = store.countMemoryPages()
  const retiredPage = store.applyPageOps([{ action: 'create', title: '过时事实页', type: 'fact', content: 'V1 时代的事实，已被取代。' }])
  check('fresh create is live (count +1)', store.countMemoryPages() === liveBeforeRetire + 1)
  const preRetire = store.getMemoryPageById(retiredPage[0].pageId)
  const ret = store.applyPageOps([{ action: 'retire', target: '过时事实页', reason: '该事实已失效，源已下线' }])
  const retiredRow = store.getMemoryPageById(retiredPage[0].pageId)
  check('retire applies on a live clue page', ret[0].ok, ret[0].error)
  check('retire stamps retired_at (soft state, row kept)', !!retiredRow.retiredAt, String(retiredRow.retiredAt))
  check('retire records the audit reason', retiredRow.retireReason === '该事实已失效，源已下线')
  check('retire does not bump updated_at (gardener exits never reorder the list)',
    retiredRow.updatedAt === preRetire.updatedAt, `${preRetire.updatedAt} → ${retiredRow.updatedAt}`)
  check('retired page leaves the live index (target resolution loses the name)',
    !store.listPageIndex().some((p) => p.id === retiredRow.id) && store.listPageIndex().every((p) => p.title !== '过时事实页'))
  check('countMemoryPages excludes retired', store.countMemoryPages() === liveBeforeRetire)
  const retHits = store.searchMemoryPages({ query: 'V1 时代的事实' })
  check('searchMemoryPages drops a hit resolving to a retired page (no fallback to chain history)',
    !retHits.some((h) => h.record.id === retiredRow.id), retHits.map((h) => h.record.title).join(' | '))
  const noReason = store.applyPageOps([{ action: 'retire', target: '普通经验 v2', reason: '   ' }])
  check('retire without a reason is REJECTED (audit surface mandatory)', !noReason[0].ok, noReason[0].error)
  const sopRetire = store.applyPageOps([{ action: 'retire', target: '部署SOP v2', reason: 'x' }])
  check('retire on an SOP (files-carrying) page is REJECTED (脚本保全同款护栏)', !sopRetire[0].ok, sopRetire[0].error)
  store.setMemoryPageRetired(retiredRow.id, false)
  const restored = store.getMemoryPageById(retiredRow.id)
  check('restore (setMemoryPageRetired false) clears the soft state back into the live pool',
    restored.retiredAt === null && restored.retireReason === null && store.listPageIndex().some((p) => p.id === retiredRow.id))
}

// ── runner (same harness shape as probe-project-color-db.mjs, single phase) ──
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-memory-pages-sop-'))
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-pages-'))
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
      HOME: home,
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  let failed = payload.checks.filter((c) => !c.pass).length
  let total = payload.checks.length
  if (res.status !== 0) { failed++; console.log(`✗ phase main exited with ${res.status}`) }

  if (KEEP) console.log(`\nkept: ${join(work)} ${home}`)
  else { rmSync(work, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) }

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
    console.error(`\n✗ ${err?.stack || err}`)
    process.exit(1)
  })
}
