// Routine batch mode end-to-end — against a REAL database.
//
// The batch runner's semantics are claims about rows: one parent + one child
// per CSV row, a child that failed its parameter pre-check never reaches the
// engine, a stopped batch settles queued rows as skipped and in-flight rows as
// failed, and deleting a parent takes its children (and their transcripts) with
// it. PLAN-batch-resume adds three claims on top: a stopped batch CONTINUES
// under its same parent as a new attempt wave (six refusals, all before the
// reopen), a workbook runs as the batch's table (xlsx → the same {headers,
// rows} the CSV parser yields), and the start dialog's per-run concurrency
// override reaches the pool without touching the saved config, and a row's
// 单次超时 both fires (settling the row failed with 运行超时) and threads from
// config/override to the parent's meta. vitest covers
// the pure halves (CSV parsing, mapping, the worker queue, the resume folds) —
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
//
// The bundle lands INSIDE node_modules/, not in the temp dir: with
// `packages: 'external'`, batch-source's `await import('exceljs')` stays a
// native dynamic import, and the ESM loader takes no NODE_PATH fallback —
// measured: from a tmpdir bundle it dies ERR_MODULE_NOT_FOUND, from
// node_modules/.pm-routine-batch-probe.cjs it resolves. Cleaned in finally.
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
  const { decodeCsvBytes, previewCsv } = await import('./src/main/routine/batch-source')
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
  let parent = await routineBatchRunner.start(routineA, 'manual')
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
  await routineBatchRunner.start(routineB, 'manual')
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
  const parentC = await routineBatchRunner.start(routineStore.get(routineC.id), 'manual')
  await until(() => childrenOf(parentC.id).length === 1, 'first row dispatched')
  // start() is async now (the xlsx source has no sync load), so its refusals
  // REJECT — asserted before check(), whose callback contract stays sync.
  await assert.rejects(() => routineBatchRunner.start(routineStore.get(routineC.id), 'manual'), /已有批量运行在进行/)
  check('a second batch for the same task is refused while one is active', () => {})
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
  const again = await routineBatchRunner.start(routineStore.get(routineC.id), 'manual')
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
  const parentD = await routineBatchRunner.start(routineStore.get(routineD.id), 'manual')
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
  const parentE = await routineBatchRunner.start(routineStore.get(routineE.id), 'manual')
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

  // ── 10. 断点续跑: same parent, new attempt wave (PLAN-batch-resume) ──
  // Shape: a stopped batch (1 in-flight row failed WITH a conversation +
  // snapshot, 3 queued rows skipped) continues under its OWN parent. Every
  // refusal must fire BEFORE the reopen — observable as the parent still
  // reading 'partial' — and the happy path appends attempts while values
  // follow the snapshot rule: a row that RAN freezes to its snapshot, a row
  // that never ran reads the (edited) CSV.
  const csvF = writeCsv('f.csv', 'repo,branch\\nr1,b1\\nr2,b2\\nr3,b3\\nr4,b4\\n')
  const routineF = makeRoutine('巡检 F', csvF)
  routineStore.update(routineF.id, { batch: { csvPath: csvF, concurrency: 1 } })
  askBehavior = 'hang'
  const parentF = await routineBatchRunner.start(routineStore.get(routineF.id), 'manual')
  await until(() => childrenOf(parentF.id).length === 1, 'batch F row 1 dispatched')
  routineBatchRunner.stop(parentF.id)
  await until(() => routineStore.getRun(parentF.id)?.status !== 'running', 'batch F settles after stop')
  askBehavior = 'complete'
  check('stop leaves the parent partial: 1 failed (reached the engine), 3 skipped', () => {
    const kids = childrenOf(parentF.id)
    assert.equal(kids.length, 4)
    assert.equal(kids[0].status, 'failed')
    assert.match(kids[0].error, /用户停止/)
    assert.ok(kids[0].conversationId, 'the failed row has a conversation')
    assert.ok(kids[0].paramsSnapshot, 'and the values it ran with')
    assert.deepEqual(kids.slice(1).map((c) => c.status), ['skipped', 'skipped', 'skipped'])
    assert.equal(routineStore.getRun(parentF.id).status, 'partial')
  })

  await assert.rejects(() => routineBatchRunner.resume('run_does_not_exist'), /未找到该批量运行记录/)
  check('refusal: no such batch record', () => {})

  // A fresh ACTIVE batch of the same task, hung so it cannot settle early:
  // resuming its OWN parent hits the status refusal, resuming the settled one
  // hits the active-map refusal.
  askBehavior = 'hang'
  const freshF = await routineBatchRunner.start(routineStore.get(routineF.id), 'manual')
  await until(() => childrenOf(freshF.id).length === 1, 'fresh F dispatched')
  await assert.rejects(() => routineBatchRunner.resume(freshF.id), /该批量运行仍在进行中/)
  check('refusal: a batch that is still running cannot be resumed', () => {})
  await assert.rejects(() => routineBatchRunner.resume(parentF.id), /已有批量运行在进行/)
  check('refusal: another batch of the task is active — and the settled parent stays partial (refused BEFORE the reopen)', () => {
    assert.equal(routineStore.getRun(parentF.id).status, 'partial')
  })
  routineBatchRunner.stop(freshF.id)
  await until(() => routineStore.getRun(freshF.id)?.status !== 'running', 'fresh F settles')
  askBehavior = 'complete'

  // All rows succeeded → nothing to continue; then the routine itself is
  // deleted (remove() unlinks the JSON, run rows survive) → different refusal.
  const csvG = writeCsv('g.csv', 'repo\\nrg\\n')
  const routineG = makeRoutine('巡检 G', csvG)
  const parentG = await routineBatchRunner.start(routineStore.get(routineG.id), 'manual')
  await until(() => routineStore.getRun(parentG.id)?.status !== 'running', 'batch G settles')
  await assert.rejects(() => routineBatchRunner.resume(parentG.id), /每一行都已成功/)
  check('refusal: every row already succeeded', () => {})
  routineStore.remove(routineG.id)
  await assert.rejects(() => routineBatchRunner.resume(parentG.id), /原任务已被删除/)
  check('refusal: the routine was deleted (its run rows survive the unlink)', () => {
    assert.ok(routineStore.getRun(parentG.id), 'the orphaned parent still exists')
  })

  // Row-count guard: reshape the file → refuse; the parent must still read
  // partial (the reopen happens after every refusal).
  writeCsv('f.csv', 'repo,branch\\nr1,b1\\nr2,b2\\nr3,b3\\n') // 4 → 3 rows
  await assert.rejects(() => routineBatchRunner.resume(parentF.id), /批量数据行数已变化/)
  check('refusal: reshaped CSV — and the parent stays partial (reopen comes last)', () => {
    assert.equal(routineStore.getRun(parentF.id).status, 'partial')
  })

  // The happy path, with BOTH halves of the snapshot rule made observable:
  // row 0's CSV value now differs from what it ran with (freeze must win), row
  // 1 never reached an engine (live CSV must win).
  writeCsv('f.csv', 'repo,branch\\nr0edited,b1\\nCHANGED,b2\\nr3,b3\\nr4,b4\\n') // still 4 rows
  const resumed = await routineBatchRunner.resume(parentF.id)
  assert.equal(resumed.id, parentF.id, 'resume continues under the SAME parent')
  await until(() => routineStore.getRun(parentF.id)?.status !== 'running', 'resumed batch F settles')
  check('resume appends a second attempt wave under the same parent; progress folds to the rows', () => {
    const kids = childrenOf(parentF.id)
    assert.equal(kids.length, 4, 'folded: one entry per CSV row')
    assert.deepEqual(kids.map((c) => c.rowIndex), [0, 1, 2, 3])
    assert.ok(kids.every((c) => c.attempts === 2), 'every row ran exactly twice: ' + kids.map((c) => c.attempts).join(','))
    assert.ok(kids.every((c) => c.status === 'success'), 'the second wave completed every row')
    const parent = routineStore.getRun(parentF.id)
    assert.equal(parent.status, 'success')
    // getRun returns the raw row; batchProgress is a computed-at-read field
    // (listRuns / this accessor both attach it — getRun deliberately does not).
    const progress = routineStore.batchProgress(parentF.id)
    assert.deepEqual(
      { total: progress.total, success: progress.success, failed: progress.failed, skipped: progress.skipped },
      { total: 4, success: 4, failed: 0, skipped: 0 },
    )
  })
  check('the snapshot rule: the RAN row froze to its snapshot, the skipped row took the edited CSV', () => {
    const kids = childrenOf(parentF.id)
    assert.equal(kids[0].paramsSnapshot.repo, 'r1', 'row 0 ran and failed → frozen at its snapshot, not the edited r0edited')
    assert.equal(kids[1].paramsSnapshot.repo, 'CHANGED', 'row 1 never reached an engine → live CSV wins')
  })

  // ── 11. xlsx data source end-to-end: a workbook IS the batch's table ──
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('data')
  ws.getCell('A1').value = ' repo ' // header trim, like the CSV contract
  ws.getCell('B1').value = 'branch'
  ws.getCell('A2').value = 'X1'
  ws.getCell('B2').value = 'bx'
  ws.getRow(3).values = [null, '', ''] // blank sheet row drops like a blank CSV line
  ws.getCell('A4').value = 'X2'
  ws.getCell('B4').value = { text: 'b-link', hyperlink: 'https://example.test' } // → its display text
  const xlsxPath = join(${JSON.stringify(work)}, 'book.xlsx')
  writeFileSync(xlsxPath, Buffer.from(await wb.xlsx.writeBuffer()))
  const routineH = makeRoutine('巡检 H', xlsxPath)
  const parentH = await routineBatchRunner.start(routineStore.get(routineH.id), 'manual')
  await until(() => routineStore.getRun(parentH.id)?.status !== 'running', 'xlsx batch settles')
  check('an xlsx workbook runs as the table: name recorded, blank row dropped, all rows succeed', () => {
    const parent = routineStore.getRun(parentH.id)
    assert.equal(parent.batch.csvName, 'book.xlsx')
    assert.equal(parent.batch.totalRows, 2)
    assert.equal(routineStore.batchProgress(parentH.id).success, 2)
  })
  check('xlsx values reached the engine (typed cell flattened: hyperlink → display text)', () => {
    const kids = childrenOf(parentH.id)
    assert.deepEqual(kids.map((c) => c.paramsSnapshot.repo), ['X1', 'X2'])
    assert.equal(kids[1].paramsSnapshot.branch, 'b-link')
    for (const c of kids) {
      const session = sessions.find((s) => s.id === c.conversationId)
      assert.ok(session && session.prompt.includes(c.paramsSnapshot.repo), 'prompt carries the workbook value')
    }
  })
  writeFileSync(join(${JSON.stringify(work)}, 'legacy.xls'), 'not really an ole file')
  await assert.rejects(() => previewCsv(join(${JSON.stringify(work)}, 'legacy.xls')), /暂不支持 \\.xls 老格式/)
  check('legacy .xls refuses with a save-as hint (before any parse)', () => {})

  // ── 12. Per-run concurrency override (L2): the dialog's choice, not the config ──
  const csvI = writeCsv('i.csv', 'repo\\nri1\\nri2\\ni3\\n')
  const routineI = makeRoutine('巡检 I', csvI) // saved config: concurrency 2
  await assert.rejects(() => routineBatchRunner.start(routineStore.get(routineI.id), 'manual', { concurrency: 99 }), /无效的批量并发数/)
  check('an out-of-range override refuses before any row is written', () => {
    assert.equal(routineStore.listRuns(routineI.id, 10).length, 0, 'no parent row was created')
  })
  const parentI = await routineBatchRunner.start(routineStore.get(routineI.id), 'manual', { concurrency: 1 })
  assert.equal(parentI.batch.concurrency, 1, 'the override rides THIS run')
  await until(() => routineStore.getRun(parentI.id)?.status !== 'running', 'override batch settles')
  check('override 1 applies for this run only; the saved config keeps 2', () => {
    assert.equal(routineStore.getRun(parentI.id).status, 'success')
    assert.equal(routineStore.get(routineI.id).batch.concurrency, 2)
  })

  // ── 13. Per-row timeout (单次超时, user 2026-09-23): a hanging row settles
  // failed with 运行超时 at the configured ceiling, and the config/override
  // reach it. The FIRING half drives executeUnattended directly with a
  // sub-minute timeoutMs — normalizeBatchTimeoutMinutes floors a start at one
  // whole minute, and a 60s sleep is not a probe. The WIRING half runs the
  // real start() and reads the parent's recorded meta. ──
  const csvJ = writeCsv('j.csv', 'repo\\nrj1\\n')
  const routineJ = makeRoutine('巡检 J', csvJ, { batch: { csvPath: csvJ, concurrency: 2, timeoutMinutes: 30 } })
  const { executeUnattended } = await import('./src/main/routine/routine-runner')
  askBehavior = 'hang'
  const runJ = routineStore.startRun(routineJ.id, 'manual', 'routine_timeout_probe')
  executeUnattended({ runId: runJ.id, routine: routineJ, convId: 'routine_timeout_probe', timeoutMs: 250 })
  await until(() => routineStore.getRun(runJ.id)?.status === 'failed', 'timeout settle')
  check('a row past its ceiling settles failed with 运行超时 (the timeout fired, the engine was stopped)', () => {
    assert.match(routineStore.getRun(runJ.id).error, /运行超时/)
  })
  askBehavior = 'complete'

  const csvK = writeCsv('k.csv', 'repo\\nrk1\\nrk2\\n')
  const routineK = makeRoutine('巡检 K', csvK) // saved config: concurrency 2, no timeout → default at run time
  await assert.rejects(() => routineBatchRunner.start(routineStore.get(routineK.id), 'manual', { concurrency: 1, timeoutMinutes: 0 }), /无效的单次超时/)
  check('an out-of-range 单次超时 refuses before any row is written', () => {
    assert.equal(routineStore.listRuns(routineK.id, 10).length, 0, 'no parent row was created')
  })
  const parentK = await routineBatchRunner.start(routineStore.get(routineK.id), 'manual', { timeoutMinutes: 45 })
  assert.equal(parentK.batch.timeoutMinutes, 45, 'the override rides THIS run')
  await until(() => routineStore.getRun(parentK.id)?.status !== 'running', 'override-timeout batch settles')
  check('override 45 reaches the parent meta; the saved config stays unset', () => {
    const parent = routineStore.getRun(parentK.id)
    assert.equal(parent.status, 'success')
    assert.equal(parent.batch.timeoutMinutes, 45)
    assert.equal(routineStore.get(routineK.id).batch.timeoutMinutes, undefined)
  })
  const parentJ2 = await routineBatchRunner.start(routineStore.get(routineJ.id), 'manual')
  assert.equal(parentJ2.batch.timeoutMinutes, 30, 'the saved config flows without an override')
  await until(() => routineStore.getRun(parentJ2.id)?.status !== 'running', 'config-timeout batch settles')
  check('a saved timeoutMinutes reaches the parent meta without an override', () => {
    assert.equal(routineStore.getRun(parentJ2.id).batch.timeoutMinutes, 30)
  })

  // ── 14. Resume inherits the parent's per-run values (review0924 M4) ──
  // The wave is the SAME batch as its parent: start() records the effective
  // per-run values in the parent meta and resume() must read THOSE first —
  // a config edit between the waves must not change what the remaining rows
  // run under (the workspace header reads the parent meta too, so this is
  // also what keeps the header truthful). Observable through the pool: a
  // batch started with override concurrency 1, stopped mid-wave, config
  // widened to 3, resumed — the parked createSession gate holds the wave's
  // first row inside the mint window, and the next row must stay queued (the
  // buggy resume read the config's 3 and dispatched two rows together).
  const csvR = writeCsv('r.csv', 'repo\\nrr1\\nrr2\\nrr3\\n')
  const routineR = makeRoutine('巡检 R', csvR) // saved config: concurrency 2
  const parentR = await routineBatchRunner.start(routineStore.get(routineR.id), 'manual', { concurrency: 1 })
  assert.equal(parentR.batch.concurrency, 1, 'this run starts serially (override)')
  askBehavior = 'hang'
  await until(() => childrenOf(parentR.id).length === 1, 'batch R row 1 dispatched')
  routineBatchRunner.stop(parentR.id)
  await until(() => routineStore.getRun(parentR.id)?.status !== 'running', 'batch R settles after stop')
  askBehavior = 'complete'
  check('resume-source setup: stop leaves 1 failed + 2 skipped under override 1', () => {
    assert.deepEqual(childrenOf(parentR.id).map((c) => c.status), ['failed', 'skipped', 'skipped'])
    assert.equal(routineStore.getRun(parentR.id).status, 'partial')
  })
  routineStore.update(routineR.id, { batch: { csvPath: csvR, concurrency: 3 } })
  // The stub pushes the session only AFTER the gate releases, so counting the
  // sessions array while parked sees nothing — wrap createSession and count
  // ENTRIES (the stub still owns the gate wait and the push).
  let gateEntries = 0
  const baseCreate = agentSessionManager.createSession
  agentSessionManager.createSession = async (id, opts) => {
    gateEntries++
    return baseCreate(id, opts)
  }
  createSessionGate = (() => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } })()
  await routineBatchRunner.resume(parentR.id)
  await until(() => gateEntries >= 1, 'resumed wave row dispatched into the gate')
  await new Promise((r) => setTimeout(r, 50))
  check('the resumed wave runs the PARENT serially: config now says 3, the next row stays queued', () => {
    assert.equal(gateEntries, 1, 'a second concurrent dispatch — resume read the config, not the parent meta')
    assert.equal(routineStore.getRun(parentR.id).batch.concurrency, 1)
  })
  createSessionGate.resolve()
  createSessionGate = null
  await until(() => routineStore.getRun(parentR.id)?.status !== 'running', 'batch R wave 2 settles')
  check('releasing the gate lets the resumed wave finish every unfinished row', () => {
    assert.equal(routineStore.getRun(parentR.id).status, 'success')
  })

  console.log('PASS: ' + checks + ' checks — batch runs row-by-row through the real store, runner and cleanup, resume/xlsx/override/timeout/resume-inherit included')
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
`
try {
  // Inside node_modules — see the header: the native import('exceljs') in the
  // bundle resolves only by walking up to a real node_modules.
  const bundle = join(root, 'node_modules', '.pm-routine-batch-probe.cjs')
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
  rmSync(join(root, 'node_modules', '.pm-routine-batch-probe.cjs'), { force: true })
  rmSync(work, { recursive: true, force: true })
}
