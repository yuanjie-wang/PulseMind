// PLAN-security-hardening — P0 / P1 / P3-a / P3-c against REAL fs + REAL SQLite.
//
// Recipe (probe-conversation-teardown 配方): main-side modules are bundled with
// esbuild and run by the Electron binary under ELECTRON_RUN_AS_NODE (the native
// better-sqlite3 is Electron-ABI), `electron` aliased to a stub, HOME pointed
// at a temp dir and GUARDED before use.
//
// P1 note: under ELECTRON_RUN_AS_NODE `require('electron')` yields the binary
// path, so settings-store sees safeStorage === undefined — the probe exercises
// the PLAINTEXT-FALLBACK branch for real. The encrypt-on-write branch is
// covered by tests/settings-secret-encryption.test.ts via the electron stub
// (a real keychain is not reachable from a probe process).
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-security-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir, SETTINGS_PATH, MEMORY_MD_PATH } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const mode = (p) => (statSync(p).mode & 0o777).toString(8)

  // ── P0: the chmod sweep fixes existing 0644/0755, skips symlinks, tolerates holes ──
  {
    const { hardenDataDirPermissions } = await import('./src/main/storage/permissions')
    // Pre-hardening shapes: everything world-readable, like the measured tree.
    writeFileSync(SETTINGS_PATH, '{}')
    writeFileSync(MEMORY_MD_PATH, '# memory')
    writeFileSync(join(DATA_DIR, 'service-token'), 'tok')
    mkdirSync(join(DATA_DIR, 'db'), { recursive: true })
    writeFileSync(join(DATA_DIR, 'db', 'pulsemind.db'), 'db')
    writeFileSync(join(DATA_DIR, 'db', 'pulsemind.db-wal'), 'wal')
    writeFileSync(join(DATA_DIR, 'db', 'pulsemind.backup_20260811_153730.db'), 'old-backup')
    mkdirSync(join(DATA_DIR, 'logs', 'llm-requests'), { recursive: true })
    writeFileSync(join(DATA_DIR, 'logs', 'llm-requests', '2026.json'), '{}')
    const outside = join(${JSON.stringify(work)}, 'outside-target.txt')
    writeFileSync(outside, 'must not be touched')
    const link = join(DATA_DIR, 'logs', 'llm-requests', 'link.json')
    try { rmSync(link) } catch {}
    symlinkSync(outside, link)

    const before = readFileSync(outside, 'utf-8')
    const res = hardenDataDirPermissions()
    check('settings.json → 0600', () => assert.equal(mode(SETTINGS_PATH), '600'))
    check('MEMORY.md → 0600', () => assert.equal(mode(MEMORY_MD_PATH), '600'))
    check('service-token → 0600', () => assert.equal(mode(join(DATA_DIR, 'service-token')), '600'))
    check('db/ → 0700 and its files → 0600', () => {
      assert.equal(mode(join(DATA_DIR, 'db')), '700')
      assert.equal(mode(join(DATA_DIR, 'db', 'pulsemind.db')), '600')
      assert.equal(mode(join(DATA_DIR, 'db', 'pulsemind.db-wal')), '600')
      assert.equal(mode(join(DATA_DIR, 'db', 'pulsemind.backup_20260811_153730.db')), '600')
    })
    check('llm-requests dir 0700, regular files 0600', () => {
      assert.equal(mode(join(DATA_DIR, 'logs', 'llm-requests')), '700')
      assert.equal(mode(join(DATA_DIR, 'logs', 'llm-requests', '2026.json')), '600')
    })
    check('a symlink is skipped, its target untouched', () => {
      assert.equal(lstatSync(link).isSymbolicLink(), true)
      assert.equal(mode(outside), '644')
      assert.equal(readFileSync(outside, 'utf-8'), before)
    })
    check('a second run is idempotent (nothing left to fix)', () => {
      const again = hardenDataDirPermissions()
      assert.equal(again.applied, 0)
    })
    check('missing paths are skipped without error', () => {
      rmSync(join(DATA_DIR, 'service-token'))
      hardenDataDirPermissions() // must not throw
    })
    // The fake db artifacts served the sweep; a REAL database takes their
    // place for the rest of the probe.
    rmSync(join(DATA_DIR, 'db', 'pulsemind.db'))
    rmSync(join(DATA_DIR, 'db', 'pulsemind.db-wal'))
  }

  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()

  // ── P3-a: backup retention — only legal-and-expired goes, audit records it ──
  {
    const dbDir = join(DATA_DIR, 'db')
    const now = Date.now()
    const age = (name, days) => {
      const p = join(dbDir, name)
      const t = new Date(now - days * 86400_000)
      // best-effort mtime backdate; if the fs refuses, the file is fresh —
      // the assertions below tolerate that by never expecting a fresh file gone.
      try { require('node:fs').utimesSync(p, t, t) } catch {}
    }
    writeFileSync(join(dbDir, 'pulsemind.backup_old.db'), 'x'); age('pulsemind.backup_old.db', 40)
    writeFileSync(join(dbDir, 'pulsemind.db.bak_old'), 'x'); age('pulsemind.db.bak_old', 40)
    writeFileSync(join(dbDir, 'pulsemind.backup_new.db'), 'x'); age('pulsemind.backup_new.db', 3)

    const { expireOldBackups } = await import('./src/main/services/backup-retention')
    const removed = expireOldBackups(30)
    check('only legal-and-expired backups are deleted', () => {
      assert.ok(removed >= 1, 'at least the legal expired backup goes')
      assert.equal(existsSync(join(dbDir, 'pulsemind.backup_old.db')), false)
      assert.equal(existsSync(join(dbDir, 'pulsemind.backup_new.db')), true)
      assert.equal(existsSync(join(dbDir, 'pulsemind.db')), true)
    })
    check('explicit 0 keeps everything', () => {
      writeFileSync(join(dbDir, 'pulsemind.backup_keep.db'), 'x')
      expireOldBackups(0)
      assert.equal(existsSync(join(dbDir, 'pulsemind.backup_keep.db')), true)
    })
    const auditRows = (await import('./src/main/storage/audit-store')).auditStore
      .list(500).filter((r) => r.action === 'backup.expire')
    check('each deletion lands one audit row naming the file', () => {
      assert.ok(auditRows.some((r) => r.target === 'pulsemind.backup_old.db'))
    })
  }

  // ── P3-c: full-save reconciliation DELETE (with the id-hoist trap) ──
  {
    const { saveConversation, appendConversationMessages, getConversation, deleteConversation } =
      await import('./src/main/storage/conversation.db')
    const conv = (id) => ({
      id, title: 'probe', createdAt: '2026-09-25T00:00:00Z',
      messages: [
        { id: id + '_m1', role: 'user', content: 'q1', createdAt: '2026-09-25T00:00:01Z',
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result one' }] },
        { id: id + '_m2', role: 'assistant', content: 'a1', createdAt: '2026-09-25T00:00:02Z' },
        { id: id + '_m3', role: 'user', content: 'q2', createdAt: '2026-09-25T00:00:03Z',
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'result three' }] },
        { id: id + '_m4', role: 'assistant', content: 'a2', createdAt: '2026-09-25T00:00:04Z' },
        { id: id + '_m5', role: 'user', content: 'q3', createdAt: '2026-09-25T00:00:05Z',
          contentBlocks: [{ type: 'tool_result', tool_use_id: 'tu5', content: 'result five' }] },
      ],
    })
    const db = (await import('./src/main/storage/database')).getDb()
    const counts = (convId) => ({
      messages: db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(convId).n,
      toolResults: db.prepare('SELECT COUNT(*) n FROM tool_results WHERE conversation_id = ?').get(convId).n,
      tokenUsage: db.prepare('SELECT COUNT(*) n FROM token_usage WHERE id LIKE ?').get('tu_' + convId + '%').n,
    })

    // 5 messages, 3 carrying tool_results (rows exist for tu1/tu3/tu5).
    const id = 'conv_probe_p3c'
    saveConversation(conv(id))
    check('baseline: 5 messages, 3 tool_results', () => {
      assert.deepEqual(counts(id), { messages: 5, toolResults: 3, tokenUsage: 0 })
    })

    // Compaction truncation: the full list now holds only 3 messages — the
    // residue (m4/m5 and tu5) must go, token_usage is deliberately untouched.
    const truncated = conv(id)
    truncated.messages = truncated.messages.slice(0, 3)
    truncated.messages[2].inputTokens = 11; truncated.messages[2].outputTokens = 7
    saveConversation(truncated)
    check('full save of 3 → messages 3, dropped tool_result gone, token_usage stays', () => {
      assert.deepEqual(counts(id), { messages: 3, toolResults: 2, tokenUsage: 1 })
    })

    // Append is append-only: a partial save must NOT reconcile.
    const id2 = 'conv_probe_append'
    saveConversation(conv(id2))
    appendConversationMessages(id2, 'probe', [conv(id2).messages[0]])
    check('appendConversationMessages partial save leaves all 5 rows', () => {
      assert.equal(counts(id2).messages, 5)
    })

    // Generated-id trap: messages WITHOUT ids get minted ids — those must be
    // in the reconciliation list, or the save deletes what it just wrote.
    const id3 = 'conv_probe_genid'
    saveConversation({ id: id3, title: 'probe', createdAt: '2026-09-25T00:00:00Z', messages: [
      { role: 'user', content: 'no id 1', createdAt: '2026-09-25T00:00:01Z' },
      { role: 'assistant', content: 'no id 2', createdAt: '2026-09-25T00:00:02Z' },
    ] })
    check('id-less messages survive their own save (generated ids are reconciled-in)', () => {
      assert.equal(counts(id3).messages, 2)
    })

    // Id reuse after deletion (the residue-swallows-ids hazard): free an id,
    // full-save without it, then append under that id — it must land.
    const id4 = 'conv_probe_reuse'
    saveConversation(conv(id4))
    deleteConversation(id4)
    saveConversation({ ...conv(id4), messages: conv(id4).messages.slice(0, 2) })
    appendConversationMessages(id4, 'probe', [{ id: id4 + '_m2', role: 'assistant', content: 'reused', createdAt: '2026-09-25T00:00:09Z' }])
    check('a freed message id can be reused and is not swallowed by residue', () => {
      const row = getConversation(id4).messages.find((m) => m.id === id4 + '_m2')
      assert.equal(row.content, 'reused')
    })
  }

  // ── P1: ELECTRON_RUN_AS_NODE → safeStorage undefined → plaintext fallback ──
  {
    const { settingsStore } = await import('./src/main/storage/settings-store')
    await settingsStore.set({
      activeProfileId: 'p1',
      profiles: [{ id: 'p1', name: 'n', baseURL: 'https://x', model: 'm', apiKey: 'sk-plain-fallback' }],
      theme: 'light', locale: 'zh',
    })
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
    check('no safeStorage → the disk bytes are plaintext (fallback, not corruption)', () => {
      assert.equal(raw.profiles[0].apiKey, 'sk-plain-fallback')
    })
    const reread = await settingsStore.get()
    check('get() returns the plaintext key', () => {
      assert.equal(reread.profiles[0].apiKey, 'sk-plain-fallback')
    })
  }

  console.log('PASS: ' + checks + ' checks — permissions, backup retention, reconciliation delete and the encryption fallback hold on real fs/sqlite')
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
`
try {
  const bundle = join(work, 'probe.cjs')
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `module.exports={app:{isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}}`, loader: 'js',
      }))
    } }],
  })
  const run = spawnSync(require('electron'), [bundle], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules') },
  })
  if (run.error) throw run.error
  process.exitCode = run.status === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
