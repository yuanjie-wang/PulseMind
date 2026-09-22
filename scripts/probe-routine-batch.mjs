// Routine batch mode end-to-end — against a REAL database.
//
// The batch runner's semantics are claims about rows: one parent + one child
// per CSV row, a child that failed its parameter pre-check never reaches the
// engine, a stopped batch settles queued rows as skipped and in-flight rows as
// failed, and deleting a parent takes its children (and their transcripts) with
// it. vitest covers the pure halves (CSV parsing, mapping, the worker queue) —
// this probe drives the production pair (real routine-store + real
// batch-runner over real SQLite) with the session manager stubbed at the
// module boundary.
//
// Recipe (probe-conversation-teardown's): main-side modules bundled with
// esbuild (platform node) and run by the Electron binary under
// ELECTRON_RUN_AS_NODE (better-sqlite3 is Electron-ABI here); `electron` is
// aliased to a stub — INCLUDING `src/main/agent/session-manager`, whose real
// module graph drags the whole engine stack into the bundle for nothing, and
// whose stub is a plain object the probe re-wires per section.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'pm-routine-batch-'))
const home = join(work, 'home')
const require = createRequire(join(root, 'package.json'))
const source = `
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('  ok  ' + label) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, label) => {
  for (let i = 0; i < 250; i++) { if (fn()) return; await sleep(20) }
  throw new Error('timeout waiting for: ' + label)
}

async function main() {
  if (process.env.HOME !== ${JSON.stringify(home)}) throw new Error('Unsafe HOME')
  const { DATA_DIR, ensureDataDir } = await import('./src/main/storage/index')
  if (!DATA_DIR.startsWith(process.env.HOME + '/')) throw new Error('Unsafe DATA_DIR')
  ensureDataDir()
  const { initializeDatabase } = await import('./src/main/storage/database')
  await initializeDatabase()
  const { routineStore } = await import('./src/main/storage/routine-store')
  const { routineBatchRunner } = await import('./src/main/routine/batch-runner')
  const { decodeCsvBytes } = await import('./src/main/routine/batch-source')
  const { routineRunHistory } = await import('./src/main/routine/routine-run-history')
  const { saveConversation, getConversation } = await import('./src/main/storage/conversation.db')
  const { agentMessagesToConversation } = await import('./src/renderer/src/utils/message-utils')
  const { agentSessionManager } = await import('./src/main/agent/session-manager')

  // ── The stub engine boundary: a plain object, re-wired per section ──
  const sessions = [] // { id, opts, prompt }
  const sinks = new Set()
  agentSessionManager.onEvent = (sink) => { sinks.add(sink); return () => sinks.delete(sink) }
  agentSessionManager.emit = (sessionId, data) => { for (const s of sinks) s(sessionId, data) }
  // A deferred here parks createSession callers — the window where a 停止
  // cannot reach the engine yet (section 9).
  let createSessionGate = null
  agentSessionManager.createSession = async (id, opts) => {
    if (createSessionGate) await createSessionGate.promise
    sessions.push({ id, opts, prompt: null })
  }
  agentSessionManager.history = async () => ({ messages: [] })
  agentSessionManager.releaseApprovalPin = () => {}
  // Production semantics: stopExecution parks the engine at 'idle', and that
  // status is what settles a stopped row (the primitive's listener).
  agentSessionManager.engineCall = async (id, method) => {
    if (method === 'stopExecution') agentSessionManager.emit(id, { type: 'status', status: 'idle' })
  }
  let askBehavior = 'complete' // 'complete' | 'hang'
  let completeAsks = Infinity // first N asks complete; the rest park until releaseHungAsks
  const hungAsks = []
  let askCount = 0
  agentSessionManager.ask = async (id, prompt) => {
    const session = sessions.find((s) => s.id === id)
    if (session) session.prompt = prompt
    if (askBehavior === 'hang') return new Promise(() => {})
    askCount++
    if (askCount > completeAsks) {
      return new Promise((resolve) => hungAsks.push({
        release: () => { agentSessionManager.emit(id, { type: 'status', status: 'completed' }); resolve() },
      }))
    }
    agentSessionManager.emit(id, { type: 'status', status: 'completed' })
  }
  const releaseHungAsks = () => { for (const h of hungAsks.splice(0)) h.release() }

  const writeCsv = (name, content) => {
    const p = join(${JSON.stringify(work)}, name)
    writeFileSync(p, content, 'utf-8')
    return p
  }
  const makeRoutine = (name, csvPath, extra = {}) => {
    const created = routineStore.create({
      name, description: '', prompt: '检查 {{repo}}@{{branch}} 第{{row}}行',
      params: [
        { key: 'repo', label: '仓库', required: true },
        { key: 'branch', label: '分支' },
      ],
      enabled: true,
      batch: { csvPath, concurrency: 2 },
      ...extra,
    })
    // create() fills id/createdAt/updatedAt; read back the stored shape.
    return routineStore.get(created.id)
  }
  const parentOf = (routineId) => routineStore.listRuns(routineId, 10).find((r) => r.batch)
  const childrenOf = (parentId) => routineStore.listBatchChildren(parentId)

  // ── 1. The happy batch: five rows, five independent conversations ──
  const csvA = writeCsv('a.csv', 'repo,branch\\nr1,b1\\nr2,b2\\nr3,b3\\nr4\\nr5,b5\\n')
  const routineA = makeRoutine('巡检 A', csvA)
  let parent = routineBatchRunner.start(routineA, 'manual')
  check('start returns the parent row with the batch meta', () => {
    assert.equal(parent.status, 'running')
    assert.equal(parent.batch.totalRows, 5)
    assert.equal(parent.batch.concurrency, 2)
    assert.equal(parent.batch.csvName, 'a.csv')
    assert.equal(parent.conversationId, undefined)
  })
  await until(() => parentOf(routineA.id)?.status !== 'running', 'batch A settles')
  parent = parentOf(routineA.id)
  check('all rows succeeded; the parent settles success with live progress', () => {
    assert.equal(parent.status, 'success')
    assert.deepEqual(
      { total: parent.batchProgress.total, success: parent.batchProgress.success },
      { total: 5, success: 5 },
    )
  })
  const childrenA = childrenOf(parent.id)
  check('one child row per CSV row, in order, each with its own conversation', () => {
    assert.equal(childrenA.length, 5)
    assert.deepEqual(childrenA.map((c) => c.rowIndex), [0, 1, 2, 3, 4])
    for (const c of childrenA) {
      assert.equal(c.status, 'success')
      assert.match(c.conversationId, /^routine_/)
      assert.equal(c.parentRunId, parent.id)
    }
  })
  check('each row ran its own values, {{row}} substituted, on its own minted workspace', () => {
    const asked = sessions.filter((s) => s.prompt)
    assert.equal(asked.length, 5)
    for (const s of asked) {
      const rowNo = s.prompt.match(/第(\\d+)行/)[1]
      assert.ok(s.prompt.includes('r' + rowNo), 'prompt carries the row repo value: ' + s.prompt)
    }
    const titles = sessions.map((s) => s.opts.title)
    assert.ok(titles.every((t) => t.startsWith('[日常] 巡检 A · 第')), 'per-row transcript labels: ' + titles[0])
    const dirs = sessions.map((s) => s.opts.workspaceDir)
    assert.equal(new Set(dirs).size, 5, 'workspaces are distinct per row (independent sessions)')
  })
  check('the flat run history shows the parent (with progress), never the children', () => {
    const flat = routineStore.listRuns(routineA.id, 50)
    assert.equal(flat.filter((r) => r.parentRunId).length, 0)
    assert.equal(flat.find((r) => r.id === parent.id).batchProgress.success, 5)
  })
  check('the overlap guard closes for the batch and reopens when it settles', () => {
    assert.equal(routineStore.hasRunningRun(routineA.id), false)
  })

  // ── 2. A row with a blank required cell fails without an engine call ──
  const sessionsBefore = sessions.length
  const csvB = writeCsv('b.csv', 'repo,branch\\nr1,b1\\n,b2\\nr3,b3\\n')
  const routineB = makeRoutine('巡检 B', csvB)
  routineBatchRunner.start(routineB, 'manual')
  await until(() => parentOf(routineB.id)?.status !== 'running', 'batch B settles')
  const parentB = parentOf(routineB.id)
  const childrenB = childrenOf(parentB.id)
  check('partial: 2 succeeded, the blank-repo row failed, parent is partial', () => {
    assert.equal(parentB.status, 'partial')
    assert.equal(parentB.batchProgress.success, 2)
    assert.equal(parentB.batchProgress.failed, 1)
    assert.equal(childrenB.length, 3)
  })
  check('the failed row names the missing param and its row; no LLM call was spent', () => {
    const failed = childrenB.find((c) => c.status === 'failed')
    assert.match(failed.error, /repo/)
    assert.match(failed.error, /第 2 行/)
    assert.equal(failed.conversationId, undefined, 'nothing to click through to')
    assert.equal(sessions.length - sessionsBefore, 2, 'only the two valid rows reached the engine')
  })

  // ── 3. 停止: queued rows skip, the in-flight row is interrupted ──
  const csvC = writeCsv('c.csv', 'repo\\nr1\\nr2\\nr3\\nr4\\nr5\\nr6\\n')
  const routineC = makeRoutine('巡检 C', csvC)
  routineC.batch = { ...routineC.batch, concurrency: 1 }
  routineStore.update(routineC.id, { batch: { csvPath: csvC, concurrency: 1 } })
  askBehavior = 'hang'
  const parentC = routineBatchRunner.start(routineStore.get(routineC.id), 'manual')
  await until(() => childrenOf(parentC.id).length === 1, 'first row dispatched')
  check('a second batch for the same task is refused while one is active', () => {
    assert.throws(() => routineBatchRunner.start(routineStore.get(routineC.id), 'manual'), /已有批量运行在进行/)
  })
  routineBatchRunner.stop(parentC.id)
  await until(() => parentOf(routineC.id)?.status !== 'running', 'batch C settles')
  const childrenC = childrenOf(parentC.id)
  check('stop: the in-flight row settles failed(用户停止), queued rows are skipped', () => {
    assert.equal(childrenC.length, 6)
    assert.equal(childrenC[0].status, 'failed')
    assert.match(childrenC[0].error, /用户停止/)
    assert.deepEqual(childrenC.slice(1).map((c) => c.status), Array(5).fill('skipped'))
  })
  check('stop: the parent settles partial and frees the slot', () => {
    assert.equal(parentOf(routineC.id).status, 'partial')
    assert.equal(routineBatchRunner.isActive(parentC.id), false)
  })
  askBehavior = 'complete'
  const again = routineBatchRunner.start(routineStore.get(routineC.id), 'manual')
  await until(() => parentOf(routineC.id)?.id === again.id && parentOf(routineC.id)?.status !== 'running', 'retry batch settles')
  check('after a stop a new batch can start and run to success', () => {
    assert.equal(parentOf(routineC.id).status, 'success')
  })

  // ── 4. Encoding: UTF-8 first, GBK fallback, then a refusal ──
  const gbkYou = Buffer.from([0xc4, 0xe3]) // '你' in GBK — Chinese Excel's encoding
  assert.equal(decodeCsvBytes(gbkYou), '你')
  check('GBK bytes decode (Chinese Excel CSV reality)', () => {})
  assert.throws(() => decodeCsvBytes(Buffer.from([0x81])), /UTF-8/)
  check('bytes that are neither UTF-8 nor GBK refuse with guidance', () => {})

  // ── 5. Deleting a batch parent takes the children and transcripts with it ──
  const childWithConv = childrenA[0]
  saveConversation(agentMessagesToConversation(
    [{ id: childWithConv.conversationId + '_m1', role: 'user', createdAt: '2026-09-21T00:00:00Z', contentBlocks: [{ type: 'text', text: 'row transcript' }] }],
    childWithConv.conversationId, 'probe',
  ))
  const removed = routineRunHistory.remove(parent.id)
  check('remove(parent) cascades: parent + 5 children rows, and the transcript', () => {
    assert.equal(removed, 6)
    assert.equal(childrenOf(parent.id).length, 0)
    assert.equal(getConversation(childWithConv.conversationId), null)
  })

  // ── 6. Crash recovery: leftover running rows settle as failed ──
  const staleParent = routineStore.startBatchRun(routineA.id, 'schedule', { csvName: 'x.csv', totalRows: 2, concurrency: 1 })
  routineStore.startBatchChildRun(staleParent, 0, { repo: 'r' }, 'routine_stale_conv')
  routineStore.startBatchChildRun(staleParent, 1, { repo: 'r' }, null)
  routineStore.failStaleRuns(new Date(Date.now() + 60_000).toISOString())
  check('failStaleRuns settles the parent AND its children after a crash', () => {
    const reread = routineStore.listRuns(routineA.id, 50).find((r) => r.id === staleParent.id)
    assert.equal(reread.status, 'failed')
    assert.ok(childrenOf(staleParent.id).every((c) => c.status === 'failed'))
  })

  // ── 7. Retention prune takes whole batches (parents + children) ──
  const pruned = routineStore.removeRunsStartedBefore(new Date(Date.now() + 60_000).toISOString())
  check('a cutoff in the future prunes every settled run, children included', () => {
    assert.ok(pruned.length >= 9, 'pruned ' + pruned.length)
    assert.equal(childrenOf(staleParent.id).length, 0)
  })

  // ── 8. Mid-batch 清空 keeps the live batch's settled rows (review0922 M1) ──
  // The batch's substance is its children: while the parent is still running,
  // even a SETTLED child must survive the workspace's 清空 — deleting it would
  // make the finished row table and the parent's progress counts miss rows
  // that really ran. Once the parent settles, the same clear takes everything.
  const csvD = writeCsv('d.csv', 'repo\\nr1\\nr2\\nr3\\n')
  const routineD = makeRoutine('巡检 D', csvD)
  routineStore.update(routineD.id, { batch: { csvPath: csvD, concurrency: 1 } })
  completeAsks = 1 // row 1 completes, later rows park — a settled child under a live batch
  askCount = 0 // the counter is global across sections; this batch counts from its own first ask
  const parentD = routineBatchRunner.start(routineStore.get(routineD.id), 'manual')
  await until(() => {
    const c = childrenOf(parentD.id)
    return c.length === 2 && c[0].status === 'success'
  }, 'row 1 settles while row 2 is in flight')
  const childD0 = childrenOf(parentD.id)[0]
  saveConversation(agentMessagesToConversation(
    [{ id: childD0.conversationId + '_m1', role: 'user', createdAt: '2026-09-21T00:00:00Z', contentBlocks: [{ type: 'text', text: 'row 1 transcript' }] }],
    childD0.conversationId, 'probe',
  ))
  const removedMid = routineRunHistory.clearRoutine(routineD.id)
  check('mid-batch 清空 removes nothing of the live batch: settled child, running child, transcript', () => {
    assert.equal(removedMid, 0)
    const kept = childrenOf(parentD.id)
    assert.deepEqual(kept.map((c) => c.status), ['success', 'running'])
    assert.equal(getConversation(childD0.conversationId) !== null, true, 'row 1 transcript survives')
    assert.equal(parentOf(routineD.id).status, 'running')
  })
  completeAsks = Infinity
  releaseHungAsks()
  await until(() => parentOf(routineD.id)?.status !== 'running', 'batch D settles')
  check('the released batch runs to full success — progress counts still account for every row', () => {
    const parent = parentOf(routineD.id)
    assert.equal(parent.status, 'success')
    assert.equal(parent.batchProgress.success, 3)
  })
  check('once the parent has settled, the same 清空 removes the whole batch and the transcript', () => {
    const removed = routineRunHistory.clearRoutine(routineD.id)
    assert.equal(removed, 4) // parent + 3 children
    assert.equal(childrenOf(parentD.id).length, 0)
    assert.equal(getConversation(childD0.conversationId), null)
  })
  const soloRun = routineStore.startRun(routineD.id, 'manual', 'routine_solo_conv')
  routineStore.finishRun(soloRun.id, { status: 'success' })
  check('a settled standalone run still clears — single-run semantics unchanged', () => {
    assert.equal(routineRunHistory.clearRoutine(routineD.id), 1)
  })

  // ── 9. 停止 inside the createSession window never dispatches (review0922 M2) ──
  // A stop pressed while the row's session is still being created cannot reach
  // the engine (engineCall no-ops against a session that does not exist yet).
  // The row must settle 用户停止 WITHOUT the prompt going out — otherwise the
  // task runs to completion in a session the user already wrote off, with the
  // gates torn down by the stop's own settlement.
  const csvE = writeCsv('e.csv', 'repo\\nr1\\nr2\\n')
  const routineE = makeRoutine('巡检 E', csvE)
  routineStore.update(routineE.id, { batch: { csvPath: csvE, concurrency: 1 } })
  createSessionGate = (() => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } })()
  const parentE = routineBatchRunner.start(routineStore.get(routineE.id), 'manual')
  await until(() => childrenOf(parentE.id).length === 1, 'row 1 dispatched into the gate')
  routineBatchRunner.stop(parentE.id)
  check('stop with a row still creating its session: the queued row skips at once', () => {
    assert.equal(childrenOf(parentE.id)[1].status, 'skipped')
  })
  createSessionGate.resolve()
  createSessionGate = null
  await until(() => parentOf(routineE.id)?.status !== 'running', 'row 1 settles and the parent closes')
  check('the stopped-in-window row settles 用户停止 — and ask was never reached', () => {
    const row = childrenOf(parentE.id)[0]
    assert.match(row.error, /用户停止/)
    const session = sessions.find((s) => s.id === row.conversationId)
    assert.equal(session.prompt, null, 'the prompt must not dispatch after a stop')
  })
  check('the parent settles partial without waiting out the 10s net', () => {
    assert.equal(parentOf(routineE.id).status, 'partial')
    assert.equal(routineBatchRunner.isActive(parentE.id), false)
  })

  console.log('PASS: ' + checks + ' checks — batch runs row-by-row through the real store, runner and cleanup')
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
`
try {
  const bundle = join(work, 'probe.cjs')
  await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{
      name: 'electron-and-session-manager-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onResolve({ filter: /agent[\\/]session-manager$/ }, () => ({ path: 'session-manager', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'session-manager') {
            return {
              contents: `
                const sinks = new Set()
                export const agentSessionManager = {
                  onEvent: (sink) => { sinks.add(sink); return () => sinks.delete(sink) },
                  emit: (sessionId, data) => { for (const s of sinks) s(sessionId, data) },
                  createSession: async () => {},
                  ask: async () => {},
                  history: async () => ({ messages: [] }),
                  engineCall: async () => {},
                  releaseApprovalPin: () => {},
                }
              `,
              loader: 'js',
            }
          }
          return {
            contents: `module.exports={app:{isPackaged:false,getAppPath:()=>${JSON.stringify(root)}},Notification:{isSupported:()=>false},BrowserWindow:{getAllWindows:()=>[]}}`,
            loader: 'js',
          }
        })
      },
    }],
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
