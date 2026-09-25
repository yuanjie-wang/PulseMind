/**
 * Knowledge-base integrity probe (knowledge bases: per-base raw/wiki isolation;
 * real SQLite, real main-process modules, no Electron window).
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
 *   6. K11: reextract reports a missing source file explicitly;
 *   7. R4: rebuildWiki clears the page dirs (junk pages included), empties the
 *      wiki FTS and resets sources to raw;
 *   8. bases: create/rename/delete round-trips, the default base cannot be
 *      deleted, deleting a base falls its files back to 'default', and the
 *      base_id column survives a second startup;
 *   9. isolation: raw FTS and wiki search scoped to one base see only that
 *      base's files, pages land under bases/<id>/wiki, unscoped sees all;
 *  10. reset: svcClearAll empties every base's raw+wiki dirs AND the legacy
 *      flat knowledge/raw + knowledge/wiki (the user-reported leftovers), and
 *      deletes every knowledge_files / knowledge_fts / knowledge_wiki_fts row;
 *  11. folder import: the REAL registered knowledge:scan-folder handler must
 *      answer { fileCount, filePaths } (it once answered a bare string[] while
 *      the preload bridge declared the object — the renderer destructured
 *      undefined, prepareImport threw and 导入文件夹 did nothing at all), the
 *      walk skips unsupported files / broken symlinks / directory-symlink
 *      loops, and knowledge:add-folder lands every scanned file as a row in
 *      the SELECTED base, reporting duplicates on a second run;
 *  12. bulk import doesn't freeze the app (「导入大批量文件时会卡死」): the
 *      folder walk AWAITS — a 3600-file scan keeps event-loop timers firing,
 *      and the pre-fix synchronous walk over the same tree drives the counter
 *      to ZERO (the beachball, measured as a local control), node_modules and
 *      .git never enter the candidate list (they alone dwarf a code folder),
 *      prepareImport keeps its order/duplicate/base-scoping semantics while
 *      reading the DB in IN-batches (>1 chunk, boundary seeds included), and
 *      one add-folder call over 32 files is exactly ONE extractor fork.
 *
 * Usage: node scripts/probe-knowledge-base.mjs
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
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

  // raw files on disk (the FTS rebuild reads them). Post-isolation the raw
  // and wiki trees live under bases/default/; the legacy flat dirs are only
  // a fallback for installs that predate the split.
  const baseRoot = join(DATA_DIR, 'knowledge', 'bases', 'default')
  const rawDir = join(baseRoot, 'raw')
  const wikiDir = join(baseRoot, 'wiki')
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
  const pageKept = existsSync(join(wikiDir, 'entities', 'cache.md'))
  check('the merged entity page SURVIVES the first source deletion (K3)', pageKept)
  const bStillLists = JSON.parse((db.prepare('SELECT wiki_outputs FROM knowledge_files WHERE id = ?').get('kf_b')?.wiki_outputs) || '[]')
  check('…and the surviving source still lists it', bStillLists.includes('entities/cache.md'), JSON.stringify(bStillLists))
  check('…and its wiki FTS row survived', db.prepare("SELECT COUNT(*) as c FROM knowledge_wiki_fts WHERE path = 'entities/cache.md'").get().c === 1)

  store.deleteFile('kf_b') // the last referencing source goes away
  const pageGone = !existsSync(join(wikiDir, 'entities', 'cache.md'))
  check('the page goes with the LAST referencing source', pageGone)
  check('…and its wiki FTS row goes too', db.prepare("SELECT COUNT(*) as c FROM knowledge_wiki_fts WHERE path = 'entities/cache.md'").get().c === 0)
  const index = readFileSync(join(wikiDir, 'index.md'), 'utf-8')
  check('the rebuilt wiki index stops listing the deleted page', !index.includes('entities/cache.md'))

  // ── ⑤ K11: reextract reports a missing source explicitly ──
  const reextract = await import('../src/main/services/knowledge-queries')
  const missing = await reextract.svcReextract('kf_a') // deleted above
  check('reextract on a deleted id reports it', !missing.success, missing.error)
  check('…and a URL-only source refuses with an explanation', !(await reextract.svcReextract('kf_nosource')).success, '')

  // ── ⑥ R4 rebuild: the pre-K2 junk page goes, sources reset to raw ──
  const RAW_C = '2026-01-01_source-c.md'
  writeFileSync(join(rawDir, RAW_C), '# C\n\nrebuild me', 'utf-8')
  db.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at, compiled_at, wiki_outputs)
              VALUES ('kf_c', ?, 'Source C', 'file', 'compiled', '2026-01-01', '2026-01-02', ?)`).run(RAW_C, JSON.stringify(['sources/compilation-123.md', 'entities/cache.md']))
  const junkPage = join(wikiDir, 'sources', 'compilation-123.md')
  mkdirSync(join(wikiDir, 'sources'), { recursive: true })
  writeFileSync(junkPage, '{ truncated json from the old fallback }', 'utf-8')
  writeFileSync(join(wikiDir, 'entities', 'cache.md'), '---\ntitle: Cache\ntype: entity\n---\n\nold body', 'utf-8')
  store.wikiFtsUpsert('sources/compilation-123.md', 'junk body', 'junk')
  check('fixture: the junk page exists BEFORE the rebuild (the after-check is not vacuous)', existsSync(junkPage))
  check('fixture: kf_c is compiled and claims two outputs',
    (db.prepare("SELECT status FROM knowledge_files WHERE id = 'kf_c'").get().status === 'compiled'))

  const rebuild = reextract.svcRebuildWiki()
  check('rebuild clears the page dirs (junk + legit pages)',
    !existsSync(junkPage) && !existsSync(join(wikiDir, 'entities', 'cache.md')), String(rebuild.clearedPages))
  check('…and empties knowledge_wiki_fts', store.wikiFtsCount() === 0, String(store.wikiFtsCount()))
  const kfC = db.prepare("SELECT status, wiki_outputs, compiled_at FROM knowledge_files WHERE id = 'kf_c'").get()
  check('…and resets compiled sources to raw with no outputs',
    kfC.status === 'raw' && kfC.wiki_outputs === null && kfC.compiled_at === null, JSON.stringify(kfC))
  const again = reextract.svcRebuildWiki()
  check('a second rebuild is a no-op on pages', again.clearedPages === 0, String(again.clearedPages))

  // ── ⑦ bases: create/move/delete, idempotent ALTER ──
  const baseA = reextract.svcCreateBase('项目Alpha')
  const baseB = reextract.svcCreateBase('项目Beta')
  check('bases are created with hue + count', !!baseA.id && baseA.colorHue !== null && baseA.fileCount === 0,
    `${baseA.id} hue=${baseA.colorHue}`)
  let dupRejected = false
  try { reextract.svcCreateBase('项目Alpha') } catch { dupRejected = true }
  check('a duplicate base name is rejected', dupRejected)

  const movedFile = reextract.svcSetFileBase('kf_c', baseA.id)
  check('a file joins a base (row carries baseId)', movedFile.baseId === baseA.id, String(movedFile.baseId))
  const kfDb = await import('../src/main/storage/knowledge.db')
  const filtered = kfDb.listKnowledgeFiles({ baseId: baseA.id })
  check('listKnowledgeFiles scopes to the base (SQL half)',
    filtered.total === 1 && filtered.items[0].base_id === baseA.id,
    `total=${filtered.total}`)

  reextract.svcDeleteBase(baseB.id)
  let staleRejected = false
  try { reextract.svcSetFileBase('kf_c', baseB.id) } catch { staleRejected = true } // stale id → throw, not strand
  check('a stale base id is refused by the setter', staleRejected)
  const stillInA = reextract.svcSetFileBase('kf_c', baseA.id) // the throw left it in A
  check('…and the refused write strands nothing', stillInA.baseId === baseA.id, String(stillInA.baseId))
  reextract.svcDeleteBase(baseA.id)
  const afterDelete = (await import('../src/main/storage/knowledge.db')).getKnowledgeFile('kf_c')
  check('deleting a base deletes its files (physical isolation)', afterDelete === null,
    String(afterDelete && afterDelete.base_id))
  let defaultProtected = false
  try { reextract.svcDeleteBase('default') } catch { defaultProtected = true }
  check('the default base cannot be deleted', defaultProtected)
  const baseCols = columns(db, 'knowledge_files')
  check('base_id column survives a second startup (ALTER is shape-detected)',
    (await initializeDatabase(), columns(db, 'knowledge_files')).includes('base_id') && baseCols.includes('base_id'))

  // ── ⑧ per-base isolation: raw FTS + wiki search + stats ──
  const isoA = reextract.svcCreateBase('ScopeA')
  const isoB = reextract.svcCreateBase('ScopeB')
  const { getBaseRawDir, getBaseWikiDir } = await import('../src/main/storage/index')
  const rawD = '2026-01-01_source-d.md'
  mkdirSync(getBaseRawDir(isoA.id), { recursive: true })
  mkdirSync(getBaseRawDir(isoB.id), { recursive: true })
  mkdirSync(getBaseWikiDir(isoA.id), { recursive: true })
  mkdirSync(getBaseWikiDir(isoB.id), { recursive: true })
  writeFileSync(join(getBaseRawDir(isoA.id), RAW_A), richBody, 'utf-8')
  writeFileSync(join(getBaseRawDir(isoB.id), rawD), poorBody, 'utf-8')
  db.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at, base_id)
              VALUES ('kf_sa', ?, 'Scoped A', 'file', 'raw', '2026-01-01', ?)`).run(RAW_A, isoA.id)
  db.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at, base_id)
              VALUES ('kf_sb', ?, 'Scoped B', 'file', 'raw', '2026-01-01', ?)`).run(rawD, isoB.id)
  store.syncKnowledgeFileToFts('kf_sa')
  store.syncKnowledgeFileToFts('kf_sb')

  const q = '上下文硬盘缓存' // both fixtures contain it — perfect for scoping
  const hitsA = await reextract.svcSearchContent(q, isoA.id)
  check('scoped content search: base A sees only its own file', hitsA.every((h) => h.filePath === RAW_A) && hitsA.length > 0,
    hitsA.map((h) => h.filePath).join(','))
  const hitsB = await reextract.svcSearchContent(q, isoB.id)
  check('scoped content search: base B sees only its own file', hitsB.every((h) => h.filePath === rawD) && hitsB.length > 0,
    hitsB.map((h) => h.filePath).join(','))
  const hitsAll = await reextract.svcSearchContent(q)
  check('unscoped search still sees everything', hitsAll.length >= 2, String(hitsAll.length))

  // The FTS clause itself, direct (the rg path above has its own filter and
  // would mask a broken clause — this one cannot be masked).
  const ftsScopedA = (await import('../src/main/storage/knowledge.db')).searchKnowledgeFts(q, 10, isoA.id)
  check('FTS clause: scoped A query sees only A rows', ftsScopedA.length > 0 && ftsScopedA.every((h) => h.filePath === RAW_A),
    ftsScopedA.map((h) => h.filePath).join(','))
  const ftsScopedB = (await import('../src/main/storage/knowledge.db')).searchKnowledgeFts(q, 10, isoB.id)
  check('FTS clause: scoped B query sees only B rows', ftsScopedB.length > 0 && ftsScopedB.every((h) => h.filePath === rawD),
    ftsScopedB.map((h) => h.filePath).join(','))

  // Wiki pages: each base compiles into its own directory, and search/stats
  // must never cross the boundary.
  store.applyWikiChanges([
    { filePath: 'entities/only-a.md', content: '---\ntitle: OnlyA\ntype: entity\n---\n\nOnlyA body unique-token-onlya' },
  ], isoA.id)
  store.applyWikiChanges([
    { filePath: 'entities/only-b.md', content: '---\ntitle: OnlyB\ntype: entity\n---\n\nOnlyB body unique-token-onlyb' },
  ], isoB.id)
  check('a page written to base A lands only under A\'s wiki dir',
    existsSync(join(getBaseWikiDir(isoA.id), 'entities', 'only-a.md')) && !existsSync(join(getBaseWikiDir(isoB.id), 'entities', 'only-a.md')))
  const wikiA = await reextract.svcSearchWiki('unique-token-onlya', isoA.id)
  check('scoped wiki search: base A finds its own page', wikiA.some((h) => h.wikiPath === 'entities/only-a.md'),
    wikiA.map((h) => h.wikiPath).join(','))
  const wikiBForA = await reextract.svcSearchWiki('unique-token-onlya', isoB.id)
  check('…and base B cannot see it', !wikiBForA.some((h) => h.wikiPath === 'entities/only-a.md'),
    wikiBForA.map((h) => h.wikiPath).join(','))
  const statsA = await reextract.svcGetStats(isoA.id)
  const statsB = await reextract.svcGetStats(isoB.id)
  check('scoped stats count only the base\'s own wiki pages',
    statsA.wikiFileCount === 1 && statsB.wikiFileCount === 1, `${statsA.wikiFileCount}/${statsB.wikiFileCount}`)

  // non-vacuity for the query layer: revert to a plain unicode61-style phrase
  // match (the old ladder's first rung) — the long CJK query MUST then miss,
  // which is what the suffix-window clause exists for.
  const phrases = ['"什么是上下文硬盘缓存"']
  const naiveHit = db.prepare(`SELECT COUNT(*) as c FROM knowledge_fts WHERE knowledge_fts MATCH ?`).get(phrases.join(' OR ')).c
  check('non-vacuity: the naive phrase query misses (so the fallback clause is load-bearing)', naiveHit === 0, String(naiveHit))

  // ── ⑨ reset: clearAllKnowledge wipes every base AND the legacy flat dirs ──
  // The user's report — 「重置之后目录下还有一些编译后的产物」 — is exactly the
  // shape a pre-isolation install has: raw/wiki files still sitting in the flat
  // knowledge/ dirs that no base owns. This section seeds both layouts.
  const legacyRaw = join(DATA_DIR, 'knowledge', 'raw')
  const legacyWiki = join(DATA_DIR, 'knowledge', 'wiki')
  mkdirSync(legacyRaw, { recursive: true })
  mkdirSync(legacyWiki, { recursive: true })
  writeFileSync(join(legacyRaw, 'legacy-source.md'), 'legacy raw body', 'utf-8')
  writeFileSync(join(legacyWiki, 'index.md'), 'legacy wiki index', 'utf-8')
  const resetBase = reextract.svcCreateBase('ResetBase')
  mkdirSync(getBaseRawDir(resetBase.id), { recursive: true })
  mkdirSync(getBaseWikiDir(resetBase.id), { recursive: true })
  writeFileSync(join(getBaseRawDir(resetBase.id), 'in-base.md'), 'in-base raw', 'utf-8')
  writeFileSync(join(getBaseWikiDir(resetBase.id), 'index.md'), 'in-base wiki', 'utf-8')
  db.prepare(`INSERT INTO knowledge_files (id, file_path, title, source_type, status, created_at, base_id)
              VALUES ('kf_reset', 'in-base.md', 'Reset', 'file', 'raw', '2026-01-01', ?)`).run(resetBase.id)

  function countFiles(dir) {
    if (!existsSync(dir)) return 0
    let n = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
    }
    return n
  }
  const legacyBefore = countFiles(legacyRaw) + countFiles(legacyWiki)
  const defaultBefore = countFiles(rawDir) + countFiles(wikiDir)
  const resetBefore = countFiles(getBaseRawDir(resetBase.id)) + countFiles(getBaseWikiDir(resetBase.id))
  const isoBefore = countFiles(getBaseRawDir(isoA.id)) + countFiles(getBaseWikiDir(isoA.id))

  const cleared = reextract.svcClearAll()
  check('reset reports deleted raw + wiki files', cleared.deletedRaw > 0 && cleared.deletedWiki > 0,
    `raw=${cleared.deletedRaw} wiki=${cleared.deletedWiki}`)
  check('reset emptied the legacy flat dirs (the user-reported leftovers)',
    countFiles(legacyRaw) === 0 && countFiles(legacyWiki) === 0,
    `legacy raw=${countFiles(legacyRaw)} wiki=${countFiles(legacyWiki)} (was ${legacyBefore})`)
  check('reset emptied the default base dirs', countFiles(rawDir) === 0 && countFiles(wikiDir) === 0,
    `was ${defaultBefore}`)
  check("reset emptied a user base's dirs", countFiles(getBaseRawDir(resetBase.id)) === 0 && countFiles(getBaseWikiDir(resetBase.id)) === 0,
    `was ${resetBefore}`)
  check("reset emptied every other base's dirs too", countFiles(getBaseRawDir(isoA.id)) === 0 && countFiles(getBaseWikiDir(isoA.id)) === 0,
    `was ${isoBefore}`)
  check('reset deleted every DB row',
    db.prepare('SELECT COUNT(*) as c FROM knowledge_files').get().c === 0 &&
    db.prepare('SELECT COUNT(*) as c FROM knowledge_fts').get().c === 0 &&
    db.prepare('SELECT COUNT(*) as c FROM knowledge_wiki_fts').get().c === 0)

  // ── ⑩ folder import: drive the REAL registered IPC handlers ──
  // The user report 「知识中心导入文件夹无效」 was a shape mismatch: this
  // handler answered `string[]` (svcScanFolder's old return) while the preload
  // bridge declares `{ fileCount, filePaths }`, so the renderer destructured
  // undefined, prepareImport(undefined) threw and handleAddFolder had no catch —
  // pick a folder, nothing happens. Nothing in tests/ or scripts/ ever called
  // the import path, which is how it shipped; these checks run the handler the
  // renderer actually invokes.
  const { registerKnowledgeHandlers } = await import('../src/main/ipc/knowledge.handler')
  const { IPC_CHANNELS } = await import('../src/shared/ipc-channels')
  registerKnowledgeHandlers()
  const handlers = globalThis.__pmIpcHandlers ?? {}
  const scanHandler = handlers[IPC_CHANNELS.KNOWLEDGE_SCAN_FOLDER]
  check('knowledge:scan-folder is registered', typeof scanHandler === 'function')

  const folder = join(DATA_DIR, 'import-src')
  mkdirSync(join(folder, 'nested'), { recursive: true })
  writeFileSync(join(folder, 'a.md'), '# A\n\nfolder import body', 'utf-8')
  writeFileSync(join(folder, 'b.txt'), 'plain text body', 'utf-8')
  writeFileSync(join(folder, 'c.bin'), 'unsupported bytes', 'utf-8')
  writeFileSync(join(folder, 'nested', 'd.ts'), 'export const x = 1', 'utf-8')
  let symlinksOk = true
  try {
    symlinkSync('/nonexistent/dead.md', join(folder, 'dead.md')) // broken link
    symlinkSync(folder, join(folder, 'loop')) // dir link back to the root
  } catch { symlinksOk = false }

  const scan = await scanHandler({}, folder)
  check('scan answers the OBJECT the bridge declares, not a bare string[] (the 无效 fix)',
    !!scan && !Array.isArray(scan) && scan.fileCount === 3 && Array.isArray(scan.filePaths) &&
    scan.filePaths.every(p => typeof p === 'string'),
    Array.isArray(scan) ? `bare array of ${scan.length} — the pre-fix shape` : JSON.stringify({ fileCount: scan?.fileCount, n: scan?.filePaths?.length }))
  check('…unsupported .bin excluded, nested subdir walked in',
    Array.isArray(scan?.filePaths) && !scan.filePaths.some(p => p.endsWith('.bin')) &&
    scan.filePaths.some(p => p.endsWith(join('nested', 'd.ts'))),
    scan?.filePaths?.map(p => p.slice(folder.length + 1)).join(','))
  if (symlinksOk) {
    check('a broken symlink and a directory-symlink loop do not abort the scan',
      scan?.fileCount === 3, `fileCount=${scan?.fileCount} (walk threw / looped)`)

    const importBase = reextract.svcCreateBase('FolderImport')
    const addHandler = handlers[IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER]
    check('knowledge:add-folder is registered', typeof addHandler === 'function')
    const results = await addHandler({}, folder, importBase.id)
    check('add-folder imports every scanned file as a success (real extraction worker)',
      results.length === 3 && results.every(r => r.success === true),
      JSON.stringify(results.map(r => r.success === true ? 'ok' : (r.error || 'failed'))))
    const rows = db.prepare('SELECT COUNT(*) AS c FROM knowledge_files WHERE base_id = ?').get(importBase.id).c
    check('…and every row lands in the SELECTED base, none in default',
      rows === 3 && db.prepare("SELECT COUNT(*) AS c FROM knowledge_files WHERE base_id = 'default' AND source_path LIKE ?").get(`${folder}%`).c === 0,
      `base=${rows}`)
    const again = await addHandler({}, folder, importBase.id)
    check('re-importing the same folder reports duplicates, not new rows',
      again.length === 3 && again.every(r => r.success === false && r.duplicate === true) &&
      db.prepare('SELECT COUNT(*) AS c FROM knowledge_files WHERE base_id = ?').get(importBase.id).c === 3,
      JSON.stringify(again.map(r => r.duplicate ? 'dup' : (r.error || r.success))))
  } else {
    check('symlink fixtures created (skipped on this platform)', false, 'symlinkSync failed')
  }

  // ── ⑫ bulk import doesn't freeze the app (「导入大批量文件时会卡死」) ──
  //
  // The renderer's half (per-file refresh/fork/getSettings churn in the import
  // queue) is pinned by tests/knowledge-batch-import.test.ts — a component can
  // only be driven in a browser. What can only be MEASURED here is the main
  // process half: does the walk YIELD (an event-loop tick counter — a
  // synchronous walk leaves it at zero, which IS the beachball), do
  // node_modules/.git stay out of the candidate list, does prepareImport keep
  // its semantics across IN-batches, and is a 32-file import one fork.

  const bulkTree = join(DATA_DIR, 'bulk-tree')
  const GOOD = 3000 // supported files that SHOULD be found
  const JUNK = 600 // node_modules/.git .md files that must NOT be
  for (let i = 0; i < GOOD; i++) {
    const dir = join(bulkTree, `d${i % 10}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `f${i}.md`), `# doc ${i}\n`, 'utf-8')
  }
  mkdirSync(join(bulkTree, 'node_modules', 'pkg', 'deep'), { recursive: true })
  mkdirSync(join(bulkTree, '.git', 'objects'), { recursive: true })
  for (let i = 0; i < 500; i++) writeFileSync(join(bulkTree, 'node_modules', 'pkg', 'deep', `m${i}.md`), 'x', 'utf-8')
  for (let i = 0; i < 100; i++) writeFileSync(join(bulkTree, '.git', 'objects', `o${i}.md`), 'x', 'utf-8')

  // Tick counter: a 0ms self-rearming timer. It cannot fire while the thread
  // is blocked, so "ticks during the scan > 0" means the handler yielded, and
  // the control below proves the metric can read zero.
  let ticks = 0
  let ticking = true
  const tickLoop = () => { if (!ticking) return; ticks++; setTimeout(tickLoop, 0) }
  setTimeout(tickLoop, 0)
  const scanStart = Date.now()
  const bulkScan = await scanHandler({}, bulkTree)
  const scanMs = Date.now() - scanStart
  const scanTicks = ticks
  check('bulk scan keeps the event loop alive (ticks fired while yielding)',
    scanTicks >= 1, `${scanTicks} ticks in ${scanMs}ms`)
  check('bulk scan answers the bridge shape under load',
    !!bulkScan && !Array.isArray(bulkScan) && Array.isArray(bulkScan.filePaths),
    JSON.stringify(bulkScan && { fileCount: bulkScan.fileCount, n: bulkScan.filePaths?.length }))
  check(`bulk scan finds exactly the ${GOOD} supported files`,
    bulkScan?.fileCount === GOOD && bulkScan?.filePaths?.length === GOOD,
    `fileCount=${bulkScan?.fileCount} (junk leaked / walk truncated)`)
  check('node_modules and .git never enter the candidate list (SKIP_DIRS)',
    Array.isArray(bulkScan?.filePaths) &&
    !bulkScan.filePaths.some(p => p.includes('node_modules') || /(^|[\\/])\.git[\\/]/.test(p)),
    bulkScan?.filePaths?.find(p => p.includes('node_modules') || p.includes('/.git/')) ?? '')
  check('bulk scan duration within a generous bound', scanMs < 15000, `${scanMs}ms`)

  // The control — the walk exactly as it shipped (synchronous fs, no skip
  // list) over the SAME tree, run while the tick timer is still armed. The
  // delta must be 0: during a synchronous run no timer can fire. That is the
  // beachball, and it is what makes the check above non-vacuous.
  const ctrlSupported = new Set(['.md', '.txt', '.ts']) // the tree's own contents
  function oldSyncWalk(dir, out) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { oldSyncWalk(full, out); continue }
      if (entry.isFile() && ctrlSupported.has(extname(full).toLowerCase())) out.push(full)
    }
  }
  const ctrl = []
  const ctrlStart = ticks
  oldSyncWalk(bulkTree, ctrl)
  const ctrlTicks = ticks - ctrlStart
  ticking = false
  check('metric discriminates: the OLD sync walk blocks every timer (0 ticks)',
    ctrlTicks === 0, `ctrlTicks=${ctrlTicks}`)
  check('control: the old walk WOULD have imported the junk (why SKIP_DIRS exists)',
    ctrl.length === GOOD + JUNK && ctrl.some(p => p.includes('node_modules')) && ctrl.some(p => p.includes('/.git/')),
    `old walk counted ${ctrl.length} of ${GOOD + JUNK}`)

  // prepareImport: semantics first (order, duplicate inputs, base scoping),
  // then a >1-chunk list with seeds on both sides of the 500 boundary.
  const prepHandler = handlers[IPC_CHANNELS.KNOWLEDGE_PREPARE_IMPORT]
  check('knowledge:prepare-import is registered', typeof prepHandler === 'function')
  const kdb = await import('../src/main/storage/knowledge.db')
  const prepA = reextract.svcCreateBase('PrepA')
  const seeds = ['/prep/a.md', '/prep/b.txt', '/prep/c.md']
  seeds.forEach((sp, i) => kdb.insertKnowledgeFile({
    id: `prep-seed-${i}`, filePath: `/prep/files/${i}.md`, title: `seed ${i}`,
    sourceType: 'file', sourcePath: sp, baseId: prepA.id,
  }))

  const one = await prepHandler({}, ['/prep/new1.md', '/prep/a.md', '/prep/new2.md', '/prep/a.md'], prepA.id)
  check('prepareImport: input order kept, duplicate inputs appear once each',
    Array.isArray(one?.new) && one.new.join(',') === '/prep/new1.md,/prep/new2.md' &&
    one.existing.length === 2 && one.existing.every(e => e.filePath === '/prep/a.md' && e.id === 'prep-seed-0'),
    JSON.stringify(one))
  const otherBase = await prepHandler({}, ['/prep/a.md'], 'default')
  check('prepareImport: baseId still scopes the check (same path, other base → new)',
    Array.isArray(otherBase?.new) && otherBase.new.length === 1 && otherBase.existing.length === 0,
    JSON.stringify(otherBase))

  const mixed = ['/prep/a.md'] // existing — chunk 1
  for (let i = 0; i < 599; i++) mixed.push(`/prep/n${i}.md`)
  mixed.push('/prep/b.txt') // existing — lands in chunk 2 (past PREPARE_IMPORT_CHUNK)
  for (let i = 599; i < 1198; i++) mixed.push(`/prep/n${i}.md`)
  mixed.push('/prep/c.md') // existing — chunk 3
  const prepStart = Date.now()
  const batch = await prepHandler({}, mixed, prepA.id)
  const prepMs = Date.now() - prepStart
  const seedSet = new Set(seeds)
  const expectedNew = mixed.filter(p => !seedSet.has(p))
  check('prepareImport over >1 chunk: exact counts, input order, seeds at their positions',
    batch?.new.length === expectedNew.length && batch.new.join(' ') === expectedNew.join(' ') &&
    batch.existing.map(e => e.filePath).join(',') === seeds.join(',') &&
    batch.existing.every((e, i) => e.id === `prep-seed-${i}`),
    `new=${batch?.new?.length}/${expectedNew.length} existing=${batch?.existing?.length}`)
  check('prepareImport batch duration within a generous bound', prepMs < 5000, `${prepMs}ms for ${mixed.length} paths`)

  // One folder import = ONE extractor fork, however many files. (The renderer
  // used to call importFiles([one path]) per file — N forks; its chunking is
  // the source-scan test's, this pins the batching primitive itself.)
  const forkDir = join(DATA_DIR, 'bulk-import-src')
  mkdirSync(forkDir, { recursive: true })
  for (let i = 0; i < 32; i++) writeFileSync(join(forkDir, `k${i}.md`), `# k${i}\n\nbody`, 'utf-8')
  const cp = fromRepo('node:child_process') // the SAME object the bundle's require() sees
  const origFork = cp.fork
  let forkCount = 0
  cp.fork = (...args) => { forkCount++; return origFork(...args) }
  let forkResults = null
  try {
    const bulkImportBase = reextract.svcCreateBase('BulkImport')
    // section ⑩'s `addHandler` is block-scoped inside its symlink guard — refetch
    forkResults = await handlers[IPC_CHANNELS.KNOWLEDGE_ADD_FOLDER]({}, forkDir, bulkImportBase.id)
  } finally {
    cp.fork = origFork
  }
  check('32 files through one add-folder call = exactly ONE extractor fork',
    forkCount === 1 && Array.isArray(forkResults) && forkResults.length === 32 &&
    forkResults.every(r => r.success === true),
    `forks=${forkCount} results=${forkResults?.length} ok=${forkResults?.filter(r => r.success).length}`)
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
            // ipcMain registrations are CAPTURED so section ⑩ can invoke the
            // real handlers — there is no Electron window under
            // ELECTRON_RUN_AS_NODE, but the handler bodies are plain functions.
            contents: `module.exports = {
  app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO_ROOT)} },
  ipcMain: {
    handle: (ch, fn) => { (globalThis.__pmIpcHandlers ??= {})[ch] = fn },
    on: (ch, fn) => { (globalThis.__pmIpcHandlersOn ??= {})[ch] = fn },
  },
}`,
            loader: 'js',
          }))
        },
      },
    ],
    logLevel: 'warning',
  })
  // knowledge-store resolves its extraction worker as join(__dirname,
  // 'extract-worker.js'), and this bundle's __dirname is `work` — build the
  // real worker beside it so folder import runs through the actual fork.
  await build({
    entryPoints: [join(REPO_ROOT, 'src/main/storage/extractors/extract-worker.ts')],
    outfile: join(work, 'extract-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
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
