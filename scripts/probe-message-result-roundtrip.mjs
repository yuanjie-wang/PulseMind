import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-result-roundtrip-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { saveConversation, getConversation } = await import('./src/main/storage/conversation.db')
  const { AgentSessionManagerImpl } = await import('./src/main/agent/session-manager')
  const { AgentEngine } = await import('./src/renderer/src/agent/AgentEngine')
  const { setHost } = await import('./src/renderer/src/agent/host')
  const { applySessionEvent, freshSessionState } = await import('./src/shared/agent-session/mirror')
  const { agentMessagesToConversation, storedMessagesToAgentMessages } = await import('./src/renderer/src/utils/message-utils')
  setHost(new Proxy({}, { get: (_target, key) => () => Promise.resolve(key === 'getConversationPlan' ? null : []) }))
  const resultIds = messages => messages.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result').map(b => b.tool_use_id)
  for (const [total, finished] of [[2, 2], [6, 5]]) {
    const id = 'conv_probe_' + total
    const manager = new AgentSessionManagerImpl()
    const state = freshSessionState()
    manager.onEvent((_id, data) => applySessionEvent(state, structuredClone(data)))
    const engine = new AgentEngine({ conversationId: id, hooks: {} }, {
      onMessagesChanged: messages => manager.emitMessages(id, messages),
    })
    engine.isAutoExecuting = true
    const tools = Array.from({length: total}, (_, i) => ({ type: 'tool_use', id: 'tool_' + i, name: 'read', input: {}, status: 'running', exitCode: 0 }))
    engine.messages = [{ id: 'assistant_' + total, role: 'assistant', createdAt: '2026-09-17T00:00:00Z', contentBlocks: tools }]
    engine.toolUseBlocks = tools
    engine.pendingToolIds = new Set(tools.map(t => t.id))
    engine.notify()
    for (let i = 0; i < finished; i++) {
      engine.addToolResult(tools[i].id, 'result ' + i, false)
      engine.notify()
      // Full save after every result: no end-of-batch or model round is required.
      saveConversation(agentMessagesToConversation(state.messages, id, 'probe'))
    }
    const expected = tools.slice(0, finished).map(t => t.id)
    assert.deepEqual(resultIds(state.messages), expected)
    const loaded = storedMessagesToAgentMessages(getConversation(id).messages)
    assert.deepEqual(resultIds(loaded), expected)
    assert.equal(loaded[0].contentBlocks.filter(b => b.status === 'completed').length, finished)
    const restoredManager = new AgentSessionManagerImpl()
    const resumed = new AgentEngine({ conversationId: id, hooks: {} }, {
      onMessagesChanged: messages => restoredManager.emitMessages(id, messages),
    })
    restoredManager.ensureEntry = async () => ({ engine: resumed })
    const restoredState = freshSessionState()
    restoredManager.onEvent((_id, data) => applySessionEvent(restoredState, structuredClone(data)))
    await restoredManager.hydrate(id, loaded)
    restoredManager.emitMessages(id, resumed.messages)
    assert.deepEqual(resultIds(resumed.messages), expected)
    assert.deepEqual(resultIds(restoredState.messages), expected)
    console.log('PASS: ' + finished + '/' + total + ' results survive engine → IPC clone → mirror → SQLite → hydrate')
  }
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
