// Reproduces the 执行状态未知 report on conv_20260917214933: a plan turn
// dispatches a batch of spawn_agent calls, the user presses 停止 mid-batch
// (children are aborted while running), then the model re-dispatches and
// finishes. Every final status must be on BOTH the live mirror and the
// reloaded database rows.
//
// Same recipe as probe-message-result-roundtrip.mjs: real main-side modules +
// a real database under ELECTRON_RUN_AS_NODE with a throwaway HOME. No LLM is
// called — children are fake engines and continueLoop is stubbed.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-spawn-stop-'))
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
  const { saveConversation, getConversation, deleteConversation } = await import('./src/main/storage/conversation.db')
  const { AgentSessionManagerImpl } = await import('./src/main/agent/session-manager')
  const { AgentEngine } = await import('./src/renderer/src/agent/AgentEngine')
  const { setHost } = await import('./src/renderer/src/agent/host')
  const { applySessionEvent, freshSessionState } = await import('./src/shared/agent-session/mirror')
  const { storedMessagesToAgentMessages, agentMessagesToConversation } = await import('./src/renderer/src/utils/message-utils')

  setHost(new Proxy({}, { get: (_t, key) => () => Promise.resolve(key === 'getConversationPlan' ? null : []) }))
  let checks = 0
  const ok = (name, cond) => { if (!cond) throw new Error('FAILED: ' + name); checks++; console.log('  ok ' + name) }
  const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))

  const convId = 'conv_probe_stop'
  deleteConversation(convId)
  const manager = new AgentSessionManagerImpl()
  const state = freshSessionState()
  manager.onEvent((_id, data) => applySessionEvent(state, structuredClone(data)))
  const engine = new AgentEngine({ conversationId: convId, hooks: {} }, {
    onMessagesChanged: messages => manager.emitMessages(convId, messages),
  })
  engine.isAutoExecuting = true
  engine.continueLoop = () => {} // no LLM in this probe

  // Fake children: real limiter slots, controlled completion.
  const completions = new Map()
  const handleById = new Map()
  engine.spawnSubAgent = (config) => {
    const block = engine.messages.flatMap(m => m.contentBlocks)
      .find(b => b.type === 'tool_use' && b.name === 'spawn_agent' && !handleById.has(b.id))
    const handle = {
      subConvId: 'sub_' + block.id,
      completionPromise: new Promise(resolve => completions.set(block.id, resolve)),
      waitForCompletion() {
        return handle.completionPromise.then(status => ({ status, messages: [{ role: 'assistant', contentBlocks: [{ type: 'text', text: 'output of ' + block.id }] }] }))
      },
    }
    handleById.set(block.id, handle)
    engine.activeSubAgents.set(handle.subConvId, {
      cancelLoop() {}, resumeExecution() {},
      activeSubAgents: { values: () => [], clear() {} },
      turnClock: { resume() {}, pause() {}, stop() {} },
      resolveCompletionIfSpawned(status) { completions.get(block.id)?.(status) },
    })
    return handle
  }

  // Turn 1: THREE spawn calls. A completes on its own; the user stops while
  // B and C are still running; their envelopes must land aborted.
  const spawns = ['A', 'B', 'C'].map(k => ({
    type: 'tool_use', id: 'call_' + k, name: 'spawn_agent', status: 'running', exitCode: 0,
    input: { subAgentId: 'expert-x', task: 'task ' + k },
  }))
  engine.messages = [{ id: 'assistant_1', role: 'assistant', createdAt: new Date().toISOString(), contentBlocks: spawns }]
  engine.toolUseBlocks = spawns
  engine.pendingToolIds = new Set(spawns.map(s => s.id))
  engine.notify()
  const dispatch = engine.executionFlow.handleToolUseResponse(spawns)
  await settle()
  ok('three children running', engine.activeSubAgents.size === 3)

  completions.get('call_A')('completed')
  await settle()
  engine.executionFlow.stopExecution()
  await settle(50)

  const live = id => state.messages.flatMap(m => m.contentBlocks).find(b => b.id === id)
  ok('live A completed exit=0', live('call_A')?.status === 'completed' && live('call_A')?.exitCode === 0)
  ok('live B aborted -> completed exit=1', live('call_B')?.status === 'completed' && live('call_B')?.exitCode === 1)
  ok('live C aborted -> completed exit=1', live('call_C')?.status === 'completed' && live('call_C')?.exitCode === 1)
  ok('mirror holds B abort envelope', JSON.stringify(state.messages).includes('Sub-Agent Result (aborted)'))

  // Persist the way the hook does and read the row back.
  saveConversation(agentMessagesToConversation(state.messages, convId, 'probe'))
  const loadedBlock = id => storedMessagesToAgentMessages(getConversation(convId).messages)
    .flatMap(m => m.contentBlocks).find(b => b.id === id)
  ok('loaded A derived completed', loadedBlock('call_A')?.status === 'completed')
  ok('loaded B derived completed', loadedBlock('call_B')?.status === 'completed')
  ok('loaded C derived completed', loadedBlock('call_C')?.status === 'completed')

  // ── The 继续 turn: the aborted task is re-dispatched and completes. ──
  const spawns2 = [{ type: 'tool_use', id: 'call_A2', name: 'spawn_agent', status: 'running', exitCode: 0, input: { subAgentId: 'expert-x', task: 'task A again' } }]
  engine.messages = [...engine.messages, { id: 'assistant_2', role: 'assistant', createdAt: new Date().toISOString(), contentBlocks: spawns2 }]
  engine.toolUseBlocks = spawns2
  engine.pendingToolIds = new Set(spawns2.map(s => s.id))
  engine.isCancelled = false
  engine.notify()
  const dispatch2 = engine.executionFlow.handleToolUseResponse(spawns2)
  await settle()
  completions.get('call_A2')?.('completed')
  await Promise.allSettled([dispatch, dispatch2])
  await settle()
  ok('live A2 completed exit=0', live('call_A2')?.status === 'completed' && live('call_A2')?.exitCode === 0)

  saveConversation(agentMessagesToConversation(state.messages, convId, 'probe'))
  const loaded2Block = id => storedMessagesToAgentMessages(getConversation(convId).messages)
    .flatMap(m => m.contentBlocks).find(b => b.id === id)
  ok('loaded A2 derived completed', loaded2Block('call_A2')?.status === 'completed')

  console.log('PASS: ' + checks + ' checks — stop-mid-batch keeps every final status on the mirror and in the DB')
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
