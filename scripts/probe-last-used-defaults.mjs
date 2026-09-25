// 新建会话沿用上次选择的授权/模型（last-used defaults）— against REAL stores.
//
// The vitest half (tests/last-used-defaults.test.ts) owns the seed GATE with a
// recording writer, because better-sqlite3 cannot load under plain node. This
// probe owns what only the real modules can prove: the seeded columns really
// land in SQLite and read back, the remember writes really reach
// settings.json through the merge-shaped update chain, and the REAL
// doCreateSession — ensureManagers, AgentEngine, the whole resolution chain —
// puts a plain conversation on last-used while a pinned one keeps its pins.
//
// Recipe: main-side modules bundled with esbuild (`platform: node`) and run by
// the Electron binary under ELECTRON_RUN_AS_NODE (better-sqlite3 is built for
// Electron's ABI); `electron` aliased to a stub, HOME redirected to a temp dir
// guarded before use (the teardown probe's recipe).
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-last-used-'))
const home = join(work, 'home')
mkdirSync(join(home, '.pulsemind'), { recursive: true })
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }

const SETTINGS_BASE = {
  activeProfileId: 'p1',
  profiles: [
    { id: 'p1', name: 'one', baseURL: 'https://a.invalid', model: 'model-one', maxTokens: 1024 },
    { id: 'p2', name: 'two', baseURL: 'https://b.invalid', model: 'model-two', maxTokens: 1024 },
  ],
  theme: 'light', myName: '', soul: '', yourName: '',
}
const writeSettings = (extra) => writeFileSync(process.env.HOME + '/.pulsemind/settings.json', JSON.stringify({ ...SETTINGS_BASE, ...extra }, null, 2))

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { ensureDataDir } = await import('./src/main/storage/index')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { settingsStore } = await import('./src/main/storage/settings-store')
  const conv = await import('./src/main/storage/conversation.db')
  const lu = await import('./src/main/agent/last-used-defaults')

  // ── 1. Round-trip: a written key is readable, and an unknown value dies alone ──
  writeSettings({ lastUsedApprovalMode: 'always-ask', lastUsedProfileId: 'p2' })
  let s = await settingsStore.get()
  check('roundtrip: both keys parse out of the real file', () => {
    assert.equal(s.lastUsedApprovalMode, 'always-ask')
    assert.equal(s.lastUsedProfileId, 'p2')
  })
  writeSettings({ lastUsedApprovalMode: 'bogus' })
  s = await settingsStore.get()
  check('roundtrip: an invalid approval value reads as undefined', () => assert.equal(s.lastUsedApprovalMode, undefined))

  // ── 2. remember: the merge-shaped update reaches settings.json, two concurrent remembers both land ──
  writeSettings({})
  await Promise.all([lu.rememberLastUsedApprovalMode('auto'), lu.rememberLastUsedProfileId('p2')])
  const raw = JSON.parse(readFileSync(process.env.HOME + '/.pulsemind/settings.json', 'utf-8'))
  check('remember: concurrent approval+profile remembers both land (writeChain serializes)', () => {
    assert.equal(raw.lastUsedApprovalMode, 'auto')
    assert.equal(raw.lastUsedProfileId, 'p2')
    assert.equal(raw.activeProfileId, 'p1')
  })

  // ── 3. The seed gate against the REAL database ──
  writeSettings({ lastUsedApprovalMode: 'always-ask', lastUsedProfileId: 'p2' })
  s = await settingsStore.get()

  lu.seedLastUsedDefaults('conv_lastused_plain', {}, s)
  check('seed: a plain conversation now carries BOTH columns in SQLite', () => {
    assert.equal(conv.getConversationApprovalMode('conv_lastused_plain'), 'always-ask')
    assert.equal(conv.getConversationProfileId('conv_lastused_plain'), 'p2')
  })

  lu.seedLastUsedDefaults('conv_lastused_routine', { approvalMode: 'outside-ask', profileId: 'p1' }, s)
  check('seed: a pinned (routine-shaped) create touches nothing', () => {
    assert.equal(conv.getConversationApprovalMode('conv_lastused_routine'), undefined)
    assert.equal(conv.getConversationProfileId('conv_lastused_routine'), undefined)
  })

  lu.seedLastUsedDefaults('conv_lastused_studio', { systemPromptOverride: 'studio persona' }, s)
  check('seed: a derived session (prompt override) touches nothing', () => {
    assert.equal(conv.getConversationApprovalMode('conv_lastused_studio'), undefined)
  })

  conv.setConversationApprovalMode('conv_lastused_chosen', 'auto')
  lu.seedLastUsedDefaults('conv_lastused_chosen', {}, s)
  check('seed: a conversation with its own choice keeps it', () =>
    assert.equal(conv.getConversationApprovalMode('conv_lastused_chosen'), 'auto'))

  writeSettings({ lastUsedProfileId: 'deleted-profile' })
  lu.seedLastUsedDefaults('conv_lastused_dangling', {}, await settingsStore.get())
  check('seed: a dangling lastUsedProfileId is not seeded', () =>
    assert.equal(conv.getConversationProfileId('conv_lastused_dangling'), undefined))

  // ── 4. The REAL doCreateSession: a plain conversation RUNS at last-used; a pinned one keeps its pins ──
  writeSettings({ lastUsedApprovalMode: 'always-ask', lastUsedProfileId: 'p2' })
  const { agentSessionManager } = await import('./src/main/agent/session-manager')

  await agentSessionManager.createSession('conv_lastused_e2e')
  {
    const entry = agentSessionManager.sessions.get('conv_lastused_e2e')
    check('e2e: a plain session resolves its engine onto the seeded last-used values', () => {
      assert.equal(entry.engine.opts.approvalMode, 'always-ask')
      assert.equal(entry.engine.opts.profileId, 'p2')
      assert.equal(entry.engine.opts.model, 'model-two')
    })
    check('e2e: the session did not acquire a pin — its column is the authority', () => {
      assert.equal(entry.pinned.approvalOverride, undefined)
      assert.equal(entry.pinned.profileId, undefined)
    })
  }

  await agentSessionManager.createSession('conv_lastused_pinned_e2e', { approvalMode: 'outside-ask', profileId: 'p1', workspaceDir: '${JSON.stringify(work)}/ws' })
  {
    const entry = agentSessionManager.sessions.get('conv_lastused_pinned_e2e')
    check('e2e: a pinned session keeps its own approval and model', () => {
      assert.equal(entry.engine.opts.approvalMode, 'outside-ask')
      assert.equal(entry.engine.opts.profileId, 'p1')
      assert.equal(entry.engine.opts.model, 'model-one')
    })
  }

  for (const id of ['conv_lastused_e2e', 'conv_lastused_pinned_e2e']) {
    await agentSessionManager.engineCall(id, 'dispose').catch(() => {})
  }

  console.log('PASS: ' + checks + ' checks — new conversations seed last-used against real SQLite and settings.json')
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
