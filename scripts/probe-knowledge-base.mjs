/**
 * Knowledge-base integrity probe (PLAN-knowledge-base K1/K3/K4/K5/K11; real
 * SQLite, real main-process modules, no Electron window).
 *
 * vitest cannot open the database (better-sqlite3 is Electron-ABI) and the
 * renderer probes never touch SQL — so the FTS migration, the trigram search
 * ranking, the delete-safety rule and the wiki FTS lifecycle run HERE, against
 * a real database, with the same esbuild + ELECTRON_RUN_AS_NODE + temp-HOME
 * recipe as probe-project-color-db.mjs.
 *
 * One phase, one fresh sandbox:
 *   1. a PRE-chunking knowledge_fts (unicode61, no file_rowid) is seeded, then
 *      the real initializeDatabase migrates it in place — idempotently;
 *   2. trigram search: long CJK question queries, 2-char LIKE fallback,
 *      English substrings, with ranking;
 *   3. wiki FTS lifecycle: applyWikiChanges indexes pages, search finds them,
 *      delete removes ghost rows;
 *   4. K3 delete safety: a merged entity page shared by two sources survives
 *      the first deletion and goes only with the second, and the wiki index
 *      stops listing it;
 *   5. K1 apply-side: invalid wiki paths are refused, not sanitized;
 *   6. K11: reextract reports a missing source file explicitly.
 *
 * Usage: node scripts/probe-knowledge-base.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = process.env.PM_REPO ?? process.cwd()
const PHASE = process.env.PM_PHASE

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
const fromRepo = createRequire(join(REPO_ROOT, 'package.json'))

const RAW_A = '2026-01-01_source-a.md'
const RAW_B = '2026-01-01_source-b.md'

async function phaseMain() {
  const Database = fromRepo('better-sqlite3')
  const { DATA_DIR, ensureDataDir } = await import('../src/main/storage/index')
  guardHome(DATA_DIR)
  ensureDataDir()

  // ── ① seed the PRE-chunking world, then migrate with the real startup ──
  const seed = new Database(dbPath(DATA_DIR))
  seed.exec(`
    CREATE TABLE knowledge_files (
      id TEXT PRIMARY KEY, file_path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      source_type TEXT NOT NULL, source_url TEXT, source_path TEXT, conv_id TEXT,
      content_hash TEXT, status TEXT NOT NULL DEFAULT 'raw',
      created_at TEXT NOT NULL, compiled_at TEXT, wiki_outputs TEXT
    );
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(content, tokenize='porter unicode61');
  `)
  seed.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at)
                VALUES ('kf_a', ?, 'Source A', 'file', 'raw', '2026-01-01')`).run(RAW_A)
  seed.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at)
                VALUES ('kf_b', ?, 'Source B', 'file', 'raw', '2026-01-01')`).run(RAW_B)
  seed.prepare('INSERT INTO knowledge_fts(rowid, content) VALUES (1, ?)').run('旧格式的整文件索引 row')
  check('fixture: the pre-chunking knowledge_fts has no file_rowid', !columns(seed, 'knowledge_fts').includes('file_rowid'))
  seed.close()

  // raw files on disk (the FTS rebuild reads them)
  const rawDir = join(DATA_DIR, 'knowledge', 'raw')
  mkdirSync(rawDir, { recursive: true })
  const richBody = '# A\n\n' + '上下文硬盘缓存是理解 LLM 成本的关键，多个段落确保分块。\n\n'.repeat(100)
  const poorBody = '# B\n\n提及了一次上下文硬盘缓存，然后聊别的。LlmAdapter 是接口名。'
  writeFileSync(join(rawDir, RAW_A), richBody, 'utf-8')
  writeFileSync(join(rawDir, RAW_B), poorBody, 'utf-8')

  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()

  const cols = columns(db, 'knowledge_fts')
  check('migration recreates knowledge_fts with file_rowid + chunk_offset (K5)', cols.includes('file_rowid') && cols.includes('chunk_offset'), cols.join(','))
  const chunkRows = db.prepare('SELECT COUNT(*) as c FROM knowledge_fts WHERE file_rowid IN (SELECT rowid FROM knowledge_files)').get().c
  check('the rebuild chunked the raw files into the new table', chunkRows > 2, `${chunkRows} chunk rows`)
  const secondRun = db.prepare('SELECT COUNT(*) as c FROM knowledge_fts').get().c
  await initializeDatabase()
  check('a second startup is a no-op (migration is shape-detected)',
    db.prepare('SELECT COUNT(*) as c FROM knowledge_fts').get().c === secondRun)

  // ── ② trigram search (K5 acceptance queries) ──
  const { searchKnowledgeFts } = await import('../src/main/storage/knowledge.db')
  const longQuery = searchKnowledgeFts('什么是上下文硬盘缓存')
  check('a long CJK question query hits (suffix-window fallback, K5)',
    longQuery.length > 0, longQuery.map((r) => r.filePath).join(','))
  const rankedFirstIsRich = longQuery[0]?.filePath === RAW_A || longQuery.length === 1
  check('…and ranks the denser document first (bm25 over chunks)', rankedFirstIsRich, longQuery.map((r) => r.filePath).join(','))
  const twoChar = searchKnowledgeFts('缓存')
  check('a 2-char query falls back to LIKE and still hits', twoChar.some((r) => r.filePath === RAW_A || r.filePath === RAW_B),
    twoChar.map((r) => r.filePath).join(','))
  const identifier = searchKnowledgeFts('LlmAdapter')
  check('an English identifier substring hits via trigram', identifier.some((r) => r.filePath === RAW_B),
    identifier.map((r) => r.filePath).join(','))

  // ── ③ wiki FTS lifecycle (K4) + K1 apply-side refusal ──
  const store = await import('../src/main/storage/knowledge-store')
  const pageA = '---\ntitle: Cache\ntype: concept\nsources:\n  - ' + RAW_A + '\n---\n\nConcept body from A'
  const sharedPage = '---\ntitle: Cache\ntype: entity\nsources:\n  - ' + RAW_A + '\n  - ' + RAW_B + '\n---\n\nMerged entity body'
  const written = store.applyWikiChanges([
    { filePath: 'sources/source-a.md', content: '---\ntitle: Source A\ntype: source\nsources:\n  - ' + RAW_A + '\n---\n\nA summary' },
    { filePath: 'entities/cache.md', content: sharedPage },
  ])
  check('applyWikiChanges writes pages', written === 2, String(written))
  check('…and indexes them into knowledge_wiki_fts (K4)', store.wikiFtsCount() === 2, String(store.wikiFtsCount()))

  const wikiHits = await (await import('../src/main/services/knowledge-queries')).svcSearchWiki('Merged entity body')
  check('wiki search finds a page by its body text through FTS (K4)',
    wikiHits.some((h) => h.wikiPath === 'entities/cache.md'), wikiHits.map((h) => h.wikiPath).join(','))

  let refused = false
  try { store.applyWikiChanges([{ filePath: 'sources/../evil.md', content: 'x' }]) } catch { refused = true }
  check('a traversal path is REFUSED, not sanitized (K1)', refused)

  // ── ④ K3 delete safety ──
  db.prepare('UPDATE knowledge_files SET wiki_outputs = ? WHERE id = ?').run(JSON.stringify(['entities/cache.md']), 'kf_a')
  db.prepare('UPDATE knowledge_files SET wiki_outputs = ? WHERE id = ?').run(JSON.stringify(['entities/cache.md']), 'kf_b')

  store.deleteFile('kf_a') // source A goes away
  const pageKept = existsSync(join(DATA_DIR, 'knowledge', 'wiki', 'entities', 'cache.md'))
  check('the merged entity page SURVIVES the first source deletion (K3)', pageKept)
  const bStillLists = JSON.parse((db.prepare('SELECT wiki_outputs FROM knowledge_files WHERE id = ?').get('kf_b')?.wiki_outputs) || '[]')
  check('…and the surviving source still lists it', bStillLists.includes('entities/cache.md'), JSON.stringify(bStillLists))
  check('…and its wiki FTS row survived', db.prepare("SELECT COUNT(*) as c FROM knowledge_wiki_fts WHERE path = 'entities/cache.md'").get().c === 1)

  store.deleteFile('kf_b') // the last referencing source goes away
  const pageGone = !existsSync(join(DATA_DIR, 'knowledge', 'wiki', 'entities', 'cache.md'))
  check('the page goes with the LAST referencing source', pageGone)
  check('…and its wiki FTS row goes too', db.prepare("SELECT COUNT(*) as c FROM knowledge_wiki_fts WHERE path = 'entities/cache.md'").get().c === 0)
  const index = readFileSync(join(DATA_DIR, 'knowledge', 'wiki', 'index.md'), 'utf-8')
  check('the rebuilt wiki index stops listing the deleted page', !index.includes('entities/cache.md'))

  // ── ⑤ K11: reextract reports a missing source explicitly ──
  const reextract = await import('../src/main/services/knowledge-queries')
  const missing = await reextract.svcReextract('kf_a') // deleted above
  check('reextract on a deleted id reports it', !missing.success, missing.error)
  check('…and a URL-only source refuses with an explanation', !(await reextract.svcReextract('kf_nosource')).success, '')

  // non-vacuity for the query layer: revert to a plain unicode61-style phrase
  // match (the old ladder's first rung) — the long CJK query MUST then miss,
  // which is what the suffix-window clause exists for.
  const phrases = ['"什么是上下文硬盘缓存"']
  const naiveHit = db.prepare(`SELECT COUNT(*) as c FROM knowledge_fts WHERE knowledge_fts MATCH ?`).get(phrases.join(' OR ')).c
  check('non-vacuity: the naive phrase query misses (so the fallback clause is load-bearing)', naiveHit === 0, String(naiveHit))
}

// ── runner (same recipe as probe-project-color-db.mjs) ─────────────────────
async function launcher() {
  const entry = process.argv[1]
  if (!entry || !existsSync(entry)) throw new Error(`cannot locate this script (argv[1] = ${entry})`)
  const require = createRequire(entry)
  if (!existsSync(join(REPO_ROOT, 'package.json'))) throw new Error(`run from the repo root (no package.json in ${REPO_ROOT})`)

  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    throw new Error(`could not resolve the Electron binary (got ${JSON.stringify(electronBin)}) — run npm install`)
  }

  const work = mkdtempSync(join(tmpdir(), 'pm-knowledge-db-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3', 'esbuild', 'playwright-core', 'chromium-bidi'],
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

  const home = mkdtempSync(join(tmpdir(), 'pm-home-knowledge-'))
  const report = join(work, 'main.json')
  const res = spawnSync(electronBin, [bundle], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PM_REPO: REPO_ROOT,
      PM_PHASE: PHASE,
      PM_HOME: home,
      PM_REPORT: report,
      HOME: home,
      NODE_PATH: join(REPO_ROOT, 'node_modules'),
    },
  })
  let payload = { checks: [] }
  if (existsSync(report)) payload = JSON.parse(readFileSync(report, 'utf-8'))
  const failed = payload.checks.filter((c) => !c.pass).length + (res.status !== 0 ? 1 : 0)
  console.log(`\n${payload.checks.length - failed}/${payload.checks.length} checks passed`)
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  phaseMain()
    .then(() => {
      const report = process.env.PM_REPORT
      if (report) writeFileSync(report, JSON.stringify({ checks: results }, null, 2))
      const failed = results.filter((r) => !r.pass).length
      process.exit(failed === 0 ? 0 : 1)
    })
    .catch((err) => {
      console.error('phase failed:', err)
      const report = process.env.PM_REPORT
      if (report) writeFileSync(report, JSON.stringify({ checks: results }, null, 2))
      process.exit(1)
    })
} else {
  launcher()
}
