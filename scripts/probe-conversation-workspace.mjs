// Lazy conversation workspaces — against a REAL database and a REAL spawn.
//
// The user report (2026-09-20): `~/.pulsemind/workspace` filled with empty
// `yyyyMMddHHmmss` folders, one per idle chat. The claim to verify is about
// effects, not code shape: resolution must MINT the path (named + persisted)
// without creating it, the first write must materialize it (nested parents
// included), a shell cwd inside it must materialize it, a cwd OUTSIDE it must
// stay un-created, and the workbench listing must read the missing directory
// as empty rather than broken. Only the real fs answers those.
//
// Recipe: as probe-conversation-teardown.mjs — main-side modules bundled with
// esbuild and run by the Electron binary under ELECTRON_RUN_AS_NODE
// (better-sqlite3 is Electron-ABI), `electron` aliased to a stub, temp HOME
// guarding DATA_DIR. svcExecuteCommand needs a real child process, which
// ELECTRON_RUN_AS_NODE (plain Node runtime) provides.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-ws-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase, getDb } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { saveConversation } = await import('./src/main/storage/conversation.db')
  const { resolveConversationWorkspace } = await import('./src/main/storage/conversation-workspace')
  const { svcWriteFile, svcListDir } = await import('./src/main/services/file-ops')
  const { svcExecuteCommand } = await import('./src/main/services/terminal')
  const { sessionSandbox } = await import('./src/main/sandbox/session-context')
  const { agentMessagesToConversation } = await import('./src/renderer/src/utils/message-utils')

  // Materialize the conversation row the way the first message does —
  // resolveConversationWorkspace SELECTs the row before minting.
  const materialize = (id) => saveConversation(agentMessagesToConversation(
    [{ id: id + '_m1', role: 'user', createdAt: '2026-09-20T00:00:00Z', contentBlocks: [{ type: 'text', text: 'hi' }] }],
    id, 'probe',
  ))
  const storedDir = (id) => getDb()
    .prepare('SELECT workspace_dir FROM conversations WHERE id = ?')
    .get(id)?.workspace_dir

  // ── 1. Resolution mints + persists, but does NOT create ──
  const conv1 = 'conv_20260920120000'
  materialize(conv1)
  const ws1 = await resolveConversationWorkspace(conv1)
  check('resolve: the minted path is NOT created on disk', () => assert.equal(existsSync(ws1), false))
  check('resolve: the path is persisted on conversations.workspace_dir', () => assert.equal(storedDir(conv1), ws1))
  check('resolve: the name is the conversation timestamp shape', () => assert.match(ws1, /20260920120000$/))
  const again = await resolveConversationWorkspace(conv1)
  check('resolve: a second resolution is idempotent (DB, not disk)', () => assert.equal(again, ws1))
  check('resolve: the global workspace root itself still exists (startup layout)', () =>
    assert.equal(existsSync(${JSON.stringify(home)} + '/.pulsemind/workspace'), true))

  // ── 2. The first write materializes the workspace, nested parents included ──
  {
    const target = join(ws1, 'notes', 'deep', 'a.md')
    const result = await sessionSandbox.run({ sessionId: conv1, workspaceDir: ws1 }, () =>
      svcWriteFile({ filePath: target, content: '# hello' }))
    check('write: svcWriteFile succeeds into the un-created workspace', () => assert.equal(result.success, true))
    check('write: the workspace directory now exists', () => assert.equal(existsSync(ws1), true))
    check('write: nested parents were created with the file', () => {
      assert.equal(existsSync(target), true)
      assert.equal(readFileSync(target, 'utf-8'), '# hello')
    })
  }

  // ── 3. A shell cwd inside the workspace materializes it; outside stays alone ──
  const runCommand = (convId, wsDir, command, cwd) => sessionSandbox.run(
    { sessionId: convId, workspaceDir: wsDir },
    () => new Promise((resolve) => {
      const chunks = []
      svcExecuteCommand(command, cwd, 15000, {
        output: (_pid, _type, data) => chunks.push(data),
        exit: () => resolve(chunks.join('')),
        error: (_pid, message) => resolve('SPAWN_ERROR: ' + message),
      })
    }))

  {
    const conv2 = 'conv_20260920120100'
    materialize(conv2)
    const ws2 = await resolveConversationWorkspace(conv2)
    assert.equal(existsSync(ws2), false, 'precondition: ws2 not created yet')
    const out = await runCommand(conv2, ws2, process.platform === 'win32' ? 'cd' : 'pwd')
    check('exec: the default cwd (the workspace) was materialized by the spawn', () => assert.equal(existsSync(ws2), true))
    check('exec: the command actually ran inside the workspace', () => assert.equal(out.includes(ws2), true, out))

    // An explicit nested cwd inside the workspace is materialized too.
    const nested = join(ws2, 'sub', 'dir')
    const out2 = await runCommand(conv2, ws2, process.platform === 'win32' ? 'cd' : 'pwd', nested)
    check('exec: an explicit cwd inside the workspace is created as well', () =>
      assert.equal(out2.includes(nested), true, out2))
  }

  {
    // Scoping control: a MISSING cwd outside the workspace is not this
    // service's call — it keeps the spawn failure and stays un-created.
    const conv3 = 'conv_20260920120200'
    materialize(conv3)
    const ws3 = await resolveConversationWorkspace(conv3)
    const outside = join(${JSON.stringify(home)}, 'not-a-workspace', 'deep')
    const out = await runCommand(conv3, ws3, process.platform === 'win32' ? 'cd' : 'pwd', outside)
    check('exec: a missing cwd OUTSIDE the workspace still fails the spawn', () =>
      assert.match(out, /^SPAWN_ERROR:/))
    check('exec: and that outside path was NOT created', () => assert.equal(existsSync(outside), false))
  }

  // ── 4. The workbench listing reads the missing workspace as empty ──
  {
    const conv4 = 'conv_20260920120300'
    materialize(conv4)
    const ws4 = await resolveConversationWorkspace(conv4)
    const missing = await svcListDir(ws4)
    check('listDir: a not-yet-created workspace reads as an empty listing', () =>
      assert.deepEqual(missing, { entries: [] }))
    // And a real listing still works — the ENOENT branch must not swallow it.
    mkdirSync(ws4, { recursive: true })
    writeFileSync(join(ws4, 'x.txt'), 'x')
    const listed = await svcListDir(ws4)
    check('listDir: an existing workspace still lists its entries', () =>
      assert.equal(listed.entries.length, 1))
  }

  console.log('PASS: ' + checks + ' checks — workspaces are minted at resolve, materialized at first use')
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
