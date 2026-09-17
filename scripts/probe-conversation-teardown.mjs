// Deletion vs the background save tick — against a REAL database.
//
// The resurrection claim is a claim about SQL: `saveConversation` and
// `appendConversationMessages` both UPSERT, so any write that reaches them for
// a deleted id re-creates the row. That is why this probe exists — a queue test
// with a recording writer can show that no write is DISPATCHED, but only the
// real upsert can show what a dispatched write does to a deleted row.
//
// Recipe: the main-side modules are bundled with esbuild (`platform: node`)
// and executed by the Electron binary in ELECTRON_RUN_AS_NODE, because
// better-sqlite3 here is built for Electron's ABI; `electron` is aliased to a
// stub and DATA_DIR is redirected with a temp HOME, guarded before use. The
// renderer's `ConversationSaveQueue` / `teardownConversation` are pure (no DOM),
// so the two halves run in one bundle and the probe drives the production pair.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-teardown-'))
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
  const { saveConversation, appendConversationMessages, getConversation, deleteConversation } =
    await import('./src/main/storage/conversation.db')
  const { ConversationSaveQueue, teardownConversation } = await import('./src/renderer/src/utils/incremental-save')
  const { agentMessagesToConversation } = await import('./src/renderer/src/utils/message-utils')

  // Message ids are a GLOBAL primary key and the upsert never rewrites
  // conversation_id, so every conversation needs its own ids — reusing one
  // would bind the row to the first conversation and read back empty here.
  const snapshot = (id, text) => agentMessagesToConversation(
    [{ id: id + '_m1', role: 'user', createdAt: '2026-09-17T00:00:00Z', contentBlocks: [{ type: 'text', text }] }],
    id, 'probe',
  )
  const exists = id => getConversation(id) !== null
  const fakeEngine = snap => ({
    messages: snap.messages,
    disposed: false,
    dispose() { this.disposed = true },
  })
  // The two renderer write channels, wired exactly as the hook wires them.
  const write = async (convId, snap, plan) => {
    if (plan.mode === 'full') saveConversation(snap)
    else appendConversationMessages(convId, snap.title, plan.indices.map(i => snap.messages[i]))
  }
  // The hook's periodic sweep body, verbatim in shape: iterate the ENGINE MAP.
  const sweep = async (engines, queue, channel = write) => {
    for (const id of [...engines.keys()]) {
      await queue.save(id, () => engines.get(id) && { messages: engines.get(id).messages }, (snap, plan) => channel(id, snap, plan))
    }
  }
  const settle = async (times = 6) => { for (let i = 0; i < times; i++) await Promise.resolve() }

  // ── 1. Non-vacuity: the pre-fix eviction resurrects through the real upsert ──
  {
    const id = 'conv_probe_prefix'
    const engines = new Map()
    const queue = new ConversationSaveQueue()
    const v1 = snapshot(id, 'v1')
    saveConversation(v1)
    queue.seed(id, v1)
    const engine = fakeEngine(snapshot(id, 'v2 — new turn'))
    engines.set(id, engine)

    // Pre-fix cleanup: the row is deleted, the engine stays cached, the queue
    // is untouched (no teardown, no forget).
    deleteConversation(id)
    check('pre-fix: the row is gone after the bare delete', () => assert.equal(exists(id), false))

    await sweep(engines, queue)
    check('pre-fix: the next sweep tick writes the live conversation back', () => assert.equal(exists(id), true))
    check('pre-fix: the resurrected row carries the post-delete content', () => {
      const row = getConversation(id)
      assert.match(JSON.stringify(row.messages), /new turn/)
    })
  }

  // ── 2. The fix: eviction through teardownConversation stays deleted ──
  {
    const id = 'conv_probe_fixed'
    const engines = new Map()
    const queue = new ConversationSaveQueue()
    const v1 = snapshot(id, 'v1')
    saveConversation(v1)
    queue.seed(id, v1)
    const engine = fakeEngine(snapshot(id, 'v2 — unsaved'))
    engines.set(id, engine)

    await teardownConversation(id, engines, queue, deleteConversation)
    check('fix: the row is gone after teardown', () => assert.equal(exists(id), false))
    check('fix: the engine was disposed and dropped from the map', () => {
      assert.equal(engine.disposed, true)
      assert.equal(engines.has(id), false)
    })

    // A late tool result lands on the disposed engine — the exact shape that
    // used to come back — then the sweep runs three times.
    engine.messages.push({ id: 'm_late', role: 'user', createdAt: '2026-09-17T00:01:00Z', contentBlocks: [{ type: 'text', text: 'late tool result' }] })
    for (let i = 0; i < 3; i++) await sweep(engines, queue)
    await settle()
    check('fix: three sweep ticks later the row is still deleted', () => assert.equal(exists(id), false))

    // The flush createNewConversation issues for the conversation being left —
    // with the engine gone there is nothing to read, so no write is dispatched.
    await queue.save(id, () => engines.get(id) && { messages: engines.get(id).messages }, write, true)
    check('fix: the old-conversation full flush cannot bring it back', () => assert.equal(exists(id), false))
  }

  // ── 3. An in-flight save lands BEFORE the delete, never after ──
  {
    const id = 'conv_probe_inflight'
    const engines = new Map()
    const queue = new ConversationSaveQueue()
    const v1 = snapshot(id, 'v1')
    saveConversation(v1)
    queue.seed(id, v1)
    engines.set(id, fakeEngine(snapshot(id, 'v2 — in flight')))

    let release
    const gate = new Promise(resolve => { release = resolve })
    // The queue's write callback is (snapshot, plan) — the id is the caller's
    // closure, exactly as the hook binds it.
    const gated = async (snap, plan) => { await gate; await write(id, snap, plan) }
    const dispatched = queue.save(id, () => ({ messages: engines.get(id).messages }), gated)
    await settle(2)
    check('inflight: the write is parked at the transport, row still the old content', () => {
      assert.equal(exists(id), true)
      assert.match(JSON.stringify(getConversation(id).messages), /v1/)
    })

    const teardown = teardownConversation(id, engines, queue, deleteConversation)
    await settle(4)
    check('inflight: teardown waits on the parked write instead of deleting under it', () => assert.equal(exists(id), true))

    release()
    await dispatched
    await teardown
    check('inflight: the delete is the last write to the row', () => assert.equal(exists(id), false))

    let writesAfter = 0
    const counting = async (...args) => { writesAfter++; await write(...args) }
    await sweep(new Map([['other', fakeEngine(snapshot('conv_probe_other', 'x'))]]), queue, counting)
    await settle()
    check('inflight: a later sweep mentions only the surviving conversation', () => assert.equal(writesAfter, 1))
    check('inflight: the deleted row is still gone at the end', () => assert.equal(exists(id), false))
  }

  console.log('PASS: ' + checks + ' checks — a deleted conversation stays deleted against a real database')
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
