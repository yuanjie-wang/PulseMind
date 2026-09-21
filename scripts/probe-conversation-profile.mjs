// The per-conversation 模型 column — against a REAL database.
//
// The claim is a claim about SQL: `conversations.profile_id` must survive the
// same lifecycle the 授权 column already survives — a write issued before the
// row exists (the welcome composer's model picker) stub-inserts a row, later
// message upserts (`saveConversation` / `appendConversationMessages`) never
// touch the column, `listConversations` carries it back to the sidebar, and an
// unpin (null) resets the conversation to following the global default. None
// of that is visible to vitest (better-sqlite3 is Electron-ABI), so this probe
// drives the production functions the way `probe-conversation-teardown.mjs`
// does: the main-side modules are bundled with esbuild and executed by the
// Electron binary in ELECTRON_RUN_AS_NODE, `electron` is aliased to a stub and
// DATA_DIR is redirected with a temp HOME, guarded before use.
//
// It also exercises the empty-id guard (the '' sentinel must not stub a junk
// row) and the upsert neutrality of BOTH write channels — the exact trap that
// once dropped approval bindings.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-profile-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const {
    setConversationProfile, getConversationProfileId,
    setConversationApprovalMode, getConversationApprovalMode,
    setConversationProject, getConversationProjectId,
    saveConversation, appendConversationMessages,
    listConversations, getConversation,
  } = await import('./src/main/storage/conversation.db')

  // ── 1. The welcome-page shape: write BEFORE the row exists ──
  {
    const id = 'conv_probe_profile_1'
    setConversationProfile(id, 'prof_writer')
    check('pre-row write stub-inserts a row carrying the profile', () => {
      assert.equal(getConversationProfileId(id), 'prof_writer')
    })
    check('the stub row is listable (type normal, no origin)', () => {
      assert.ok(listConversations().some((c) => c.id === id && c.profileId === 'prof_writer'))
    })

    // The first message materializes the row through the REAL write channel.
    appendConversationMessages(id, 'probe', [
      { id: id + '_m1', role: 'user', createdAt: '2026-09-21T00:00:00Z', contentBlocks: [{ type: 'text', text: 'hello' }] },
    ])
    check('the first message upsert does not touch profile_id', () => {
      assert.equal(getConversationProfileId(id), 'prof_writer')
    })
    check('the first message upsert does not touch the other bindings either', () => {
      assert.equal(getConversationProjectId(id), 'default')
    })
  }

  // ── 2. Full-save neutrality + unpin ──
  {
    const id = 'conv_probe_profile_2'
    setConversationProfile(id, 'prof_a')
    saveConversation({
      id, title: 'probe', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z',
      messages: [{ id: id + '_m1', role: 'user', createdAt: '2026-09-21T00:00:00Z', contentBlocks: [{ type: 'text', text: 'x' }] }],
    })
    check('saveConversation (full upsert) keeps the pinned profile', () => {
      assert.equal(getConversationProfileId(id), 'prof_a')
    })
    check('saveConversation keeps the sibling approval column', () => {
      setConversationApprovalMode(id, 'auto')
      saveConversation(JSON.parse(JSON.stringify({
        id, title: 'probe', createdAt: '2026-09-21T00:00:00Z', updatedAt: '2026-09-21T00:00:00Z',
        messages: [{ id: id + '_m2', role: 'user', createdAt: '2026-09-21T00:01:00Z', contentBlocks: [{ type: 'text', text: 'y' }] }],
      })))
      assert.equal(getConversationApprovalMode(id), 'auto')
    })

    setConversationProfile(id, null)
    check('unpin (null) clears the column', () => {
      assert.equal(getConversationProfileId(id), undefined)
    })
    check('unpin on a row that exists does not re-create anything', () => {
      assert.ok(getConversation(id) !== null)
    })
  }

  // ── 3. The unpin of a never-materialized row is a silent no-op ──
  {
    setConversationProfile('conv_probe_profile_absent', null)
    check('unpin before the row exists inserts nothing', () => {
      assert.equal(getConversation('conv_probe_profile_absent'), null)
    })
  }

  // ── 4. The empty-id guard ('' is the "nothing is open" sentinel) ──
  {
    const before = listConversations().length
    setConversationProfile('', 'prof_ghost')
    setConversationProfile('   ', 'prof_ghost')
    check('empty/blank ids are refused before any write', () => {
      assert.equal(getConversationProfileId(''), undefined)
      assert.equal(listConversations().length, before)
    })
    check('no junk row with an empty id exists', () => {
      assert.equal(getConversation(''), null)
    })
  }

  // ── 5. getConversation carries the column for the hydrate path ──
  {
    const id = 'conv_probe_profile_3'
    setConversationProfile(id, 'prof_b')
    check('getConversation maps profile_id to profileId', () => {
      assert.equal(getConversation(id).profileId, 'prof_b')
    })
    check('an unpinned conversation reads as undefined, not null', () => {
      setConversationProfile(id, null)
      assert.equal(getConversation(id).profileId, undefined)
    })
  }

  console.log('PASS: ' + checks + ' checks — conversations.profile_id survives the real write channels')
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
