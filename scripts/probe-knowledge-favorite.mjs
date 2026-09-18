/** Real main-side capture + migration probe. Run from repo root with Node.
 * Adapted from probe-conversation-project-stub.mjs: Electron ABI, temp HOME,
 * bundled production modules, stubbed Electron transport only. No user data.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.PM_REPO ?? process.cwd()
let checks = 0
function check(name, value) {
  assert.ok(value, name)
  checks++
  console.log(`PASS ${name}`)
}
async function phase() {
  const { DATA_DIR, getBaseRawDir, ensureDataDir } = await import('../src/main/storage/index')
  const home = process.env.PM_HOME
  if (!home || resolve(DATA_DIR) !== join(resolve(home), '.pulsemind') || resolve(process.env.HOME) !== resolve(home)) {
    throw new Error('Refusing to touch data outside isolated HOME')
  }
  ensureDataDir()
  const RAW_ROOT = getBaseRawDir('default')
  const { initializeDatabase, getDb } = await import('../src/main/storage/database')
  await initializeDatabase()
  const db = getDb()
  const stamp = '2026-09-17T00:00:00.000Z'
  const seedMessage = (id, conv = 'conv') => {
    db.prepare('INSERT OR IGNORE INTO conversations(id, created_at, updated_at) VALUES (?, ?, ?)').run(conv, stamp, stamp)
    db.prepare("INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'capture', ?)").run(id, conv, stamp)
  }
  const mark = id => db.prepare('SELECT favorited FROM messages WHERE id = ?').get(id)?.favorited
  if (process.env.PM_PHASE === 'seed') {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_files'").get().sql
    db.exec('DROP TABLE knowledge_files')
    db.exec(sql.replace(", 'favorite'", ''))
    db.exec('CREATE INDEX custom_knowledge_title ON knowledge_files(title)')
    for (const [rowid, id, word] of [[7, 'old_a', 'quartz'], [42, 'old_b', 'sapphire']]) {
      db.prepare("INSERT INTO knowledge_files(rowid,id,file_path,title,source_type,status,wiki_outputs,created_at) VALUES (?,?,?,?, 'file','compiled','[\"sources/old.md\"]',?)")
        .run(rowid, id, `${id}.md`, word, stamp)
      db.prepare('INSERT INTO knowledge_fts(rowid,content) VALUES (?,?)').run(rowid, word)
    }
    db.exec('CREATE TABLE favorites(id TEXT PRIMARY KEY, content TEXT)')
    db.exec("INSERT INTO favorites VALUES ('legacy','discard approved')")
    seedMessage('legacy')
    db.exec("UPDATE messages SET favorited = 1 WHERE id = 'legacy'")
    check('legacy fixture has old CHECK and sparse FTS rowids', !sql.replace(", 'favorite'", '').includes("'favorite'"))
    db.close()
    return
  }

  if (process.env.PM_PHASE !== 'fresh') {
    check('legacy favorites table removed', !db.prepare("SELECT 1 FROM sqlite_master WHERE name='favorites'").get())
    check('legacy marker reset', mark('legacy') === 0)
    check('knowledge records and sparse rowids preserved', JSON.stringify(db.prepare('SELECT rowid FROM knowledge_files WHERE id LIKE ? ORDER BY rowid').all('old_%')) === '[{"rowid":7},{"rowid":42}]')
    check('compiled knowledge metadata preserved', db.prepare("SELECT wiki_outputs FROM knowledge_files WHERE id='old_b'").get().wiki_outputs === '["sources/old.md"]')
    check('custom index preserved', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='custom_knowledge_title'").get())
    check('all five production indexes present', db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name IN ('idx_knowledge_status','idx_knowledge_source_type','idx_knowledge_created_at','idx_knowledge_list_query','idx_knowledge_file_path')").get().n === 5)
    check('FTS still maps to original knowledge row', db.prepare("SELECT k.id FROM knowledge_fts f JOIN knowledge_files k ON k.rowid=f.rowid WHERE knowledge_fts MATCH 'sapphire'").get()?.id === 'old_b')
  }
  const { registerKnowledgeHandlers } = await import('../src/main/ipc/knowledge.handler')
  const { IPC_CHANNELS } = await import('../src/shared/ipc-channels')
  const { favoriteRawFileName } = await import('../src/main/storage/knowledge-store')
  registerKnowledgeHandlers()
  const handler = globalThis.__pmHandlers.get(IPC_CHANNELS.KNOWLEDGE_WRITE_FAVORITE)
  check('real IPC handler registered', typeof handler === 'function')
  const capture = (messageId, content = 'nebula favorite body', conversationId = 'conv') => handler({}, { messageId, conversationId, content, title: 'Captured title' })

  if (process.env.PM_PHASE === 'restart') {
    check('new capture marker survives process restart', mark('saved') === 1)
    const before = db.prepare("SELECT id FROM knowledge_files WHERE source_type='favorite' AND file_path=?").get(favoriteRawFileName('conv', 'saved'))
    check('restart replay returns original identity', (await capture('saved')).id === before.id)
    db.close()
    return
  }
  seedMessage('saved')
  const file = await capture('saved')
  check('IPC returns KnowledgeFile, not envelope', file.id && file.sourceType === 'favorite' && file.status === 'raw' && !('success' in file))
  const raw = readFileSync(join(RAW_ROOT, file.filePath), 'utf8')
  check('raw has source IDs and full body', raw.includes('source_conv_id: "conv"') && raw.includes('source_msg_id: "saved"') && raw.includes('nebula favorite body'))
  check('marker set after successful capture', mark('saved') === 1)
  const { saveConversation, appendConversationMessages } = await import('../src/main/storage/conversation.db')
  const stale = { id: 'saved', role: 'assistant', content: 'stale save', createdAt: stamp, favorited: false }
  saveConversation({ id: 'conv', title: 'probe', createdAt: stamp, messages: [stale] })
  check('full save preserves backend marker despite stale false', mark('saved') === 1)
  appendConversationMessages('conv', 'probe', [{ ...stale, content: 'stale append' }])
  check('append preserves backend marker despite stale false', mark('saved') === 1)
  check('upsert still updates message content', db.prepare("SELECT content FROM messages WHERE id='saved'").get().content === 'stale append')
  check('FTS contains capture', !!db.prepare("SELECT k.id FROM knowledge_fts f JOIN knowledge_files k ON k.rowid=f.rowid WHERE knowledge_fts MATCH 'nebula' AND k.id=?").get(file.id))
  const replay = await Promise.all([capture('saved', 'changed'), capture('saved', 'changed')])
  check('duplicate requests reuse identity', replay.every(f => f.id === file.id))
  check('duplicate does not overwrite raw', readFileSync(join(RAW_ROOT, file.filePath), 'utf8') === raw)
  check('exactly one row for pair', db.prepare('SELECT count(*) n FROM knowledge_files WHERE file_path=?').get(file.filePath).n === 1)
  check('filename includes conversation identity', favoriteRawFileName('other', 'saved') !== file.filePath)
  await assert.rejects(capture('saved', 'body', 'wrong-conversation'))
  check('cross-conversation request rejected', true)
  await assert.rejects(capture('saved', '  '))
  await assert.rejects(handler({}, null))
  check('invalid requests reject through IPC', true)

  // Inject each failure at the real storage boundary, then retry the same pair.
  for (const failure of ['file', 'row', 'fts', 'marker']) {
    const id = `fail_${failure}`
    seedMessage(id)
    const path = join(RAW_ROOT, favoriteRawFileName('conv', id))
    const counts = () => JSON.stringify([
      db.prepare('SELECT count(*) n FROM knowledge_files').get().n,
      db.prepare('SELECT count(*) n FROM knowledge_fts').get().n
    ])
    const before = counts()
    if (failure === 'file') {
      renameSync(RAW_ROOT, RAW_ROOT + '.backup')
      writeFileSync(RAW_ROOT, 'not a directory')
    } else if (failure === 'row') {
      db.exec("CREATE TRIGGER reject_capture BEFORE INSERT ON knowledge_files BEGIN SELECT RAISE(ABORT,'probe row failure'); END")
    } else if (failure === 'fts') {
      db.exec('ALTER TABLE knowledge_fts RENAME TO knowledge_fts_backup')
    } else {
      db.exec("CREATE TRIGGER reject_capture BEFORE UPDATE OF favorited ON messages BEGIN SELECT RAISE(ABORT,'probe marker failure'); END")
    }
    try {
      await assert.rejects(capture(id))
      check(`${failure} failure rejects, marker stays retryable`, mark(id) === 0)
      check(`${failure} failure leaves no raw file`, !existsSync(path))
    } finally {
      if (failure === 'file') {
        rmSync(RAW_ROOT)
        renameSync(RAW_ROOT + '.backup', RAW_ROOT)
      } else if (failure === 'fts') db.exec('ALTER TABLE knowledge_fts_backup RENAME TO knowledge_fts')
      else db.exec('DROP TRIGGER reject_capture')
    }
    check(`${failure} failure rolls back DB row and FTS`, counts() === before)
    const retry = await capture(id)
    check(`${failure} failure retries successfully`, retry.id && mark(id) === 1 && existsSync(path))
  }
  db.close()
}

async function launch() {
  const require = createRequire(join(REPO, 'package.json'))
  const work = mkdtempSync(join(tmpdir(), 'pm-favorite-probe-'))
  const bundle = join(work, 'harness.cjs')
  const { build } = await import('esbuild')
  try {
    await build({
      entryPoints: [process.argv[1]], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
      packages: 'external',
      plugins: [{ name: 'electron-stub', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents:
          `globalThis.__pmHandlers ||= new Map(); module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(REPO)} }, ipcMain: { handle: (name, fn) => globalThis.__pmHandlers.set(name, fn), on: () => {} } };`
        }))
      } }], logLevel: 'warning'
    })
    for (const phaseName of ['seed', 'migrate', 'restart', 'fresh']) {
      const home = join(work, phaseName === 'fresh' ? 'fresh-home' : 'legacy-home')
      mkdirSync(home, { recursive: true })
      const result = spawnSync(require('electron'), [bundle], {
        cwd: REPO, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
          PM_REPO: REPO, PM_PHASE: phaseName, PM_HOME: home, HOME: home, NODE_PATH: join(REPO, 'node_modules') }
      })
      assert.equal(result.status, 0, `${phaseName} failed: ${result.error ?? ''}`)
    }
    console.log('PASS all four isolated Electron phases')
  } finally { rmSync(work, { recursive: true, force: true }) }
}
if (process.env.PM_PHASE) {
  phase().then(() => console.log(`PASS ${process.env.PM_PHASE}: ${checks} checks`)).catch(error => { console.error(error); process.exitCode = 1 })
} else {
  launch().catch(error => { console.error(error); process.exitCode = 1 })
}
