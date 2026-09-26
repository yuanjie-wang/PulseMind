/** Batch IPC wiring (PLAN-routine-batch M4; resume + xlsx per PLAN-batch-resume).
 *
 * vitest here is node-env: the handler module cannot be registered and the
 * renderer cannot be mounted, so the three-layer surface (channels → handler →
 * preload → bridge types) is asserted against the sources the way
 * tests/pending-approval.test.ts does. Each layer must carry ALL FIVE batch
 * members (start / stop / resume / items / preview) — a channel declared but
 * never handled answers methodNotFound to the user, which is exactly the class
 * of bug this scan exists for.
 *
 * Non-vacuity: every scan asserts an exact or minimum marker count, so a
 * broken regex or a renamed set of members fails loudly instead of matching
 * nothing. The B2 describe below pins the shapes no count can see (argument
 * pass-through, format dispatch, resume ordering); the BEHAVIOUR of each is
 * driven end-to-end by scripts/probe-routine-batch.mjs. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

const MEMBERS = ['ROUTINE_BATCH_RUN', 'ROUTINE_BATCH_STOP', 'ROUTINE_BATCH_RESUME', 'ROUTINE_BATCH_ITEMS', 'ROUTINE_CSV_PREVIEW'] as const
const MIN = MEMBERS.length

describe('routine batch IPC wiring', () => {
  it('declares all five batch channels', () => {
    const src = source('src/shared/ipc-channels.ts')
    expect(src.match(/ROUTINE_(BATCH_RUN|BATCH_STOP|BATCH_RESUME|BATCH_ITEMS|CSV_PREVIEW):/g)?.length).toBeGreaterThanOrEqual(MIN)
  })

  it('handles all five channels in the routine handler', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src.match(/ipcMain\.handle\(IPC_CHANNELS\.ROUTINE_(BATCH_RUN|BATCH_STOP|BATCH_RESUME|BATCH_ITEMS|CSV_PREVIEW)/g)?.length).toBe(MIN)
  })

  it('exposes all five methods on the preload bridge', () => {
    const src = source('src/preload/index.ts')
    expect(src.match(/routine(BatchRun|BatchStop|BatchResume|BatchItems|CsvPreview):/g)?.length).toBe(MIN)
  })

  it('types all five methods in the shared bridge contract', () => {
    const src = source('src/shared/types/electron-bridge.ts')
    expect(src.match(/routine(BatchRun|BatchStop|BatchResume|BatchItems|CsvPreview):/g)?.length).toBe(MIN)
  })

  it('the preview result type lives in shared (renderer cannot import main)', () => {
    const src = source('src/shared/types/electron-bridge.ts')
    expect(src).toContain("from '../routine/batch'")
  })

  it('normalizeInput carries the batch config through the save door', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    // Both halves are load-bearing: the normalizer (which validates the shape)
    // and its wiring into the payload (without it a saved batch is dropped).
    expect(src).toContain('function normalizeBatchConfig')
    expect(src).toContain('batch: normalizeBatchConfig(input.batch)')
  })

  it('the batch start handler refuses a routine with no batch config', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src).toContain('没有配置批量数据文件')
  })
})

/** review_20260922 M1/M2. vitest cannot mount either fix (one is SQL against
 *  better-sqlite3, the other lives in main-process code importing electron),
 *  so the shape is pinned by source scan and the BEHAVIOUR by
 *  scripts/probe-routine-batch.mjs sections 8–9 — reverting either fix fails
 *  the probe there, and these scans catch a silent regression between runs. */
describe('batch clear guard and stop-window guard', () => {
  it('清空 keeps a child whose parent run is still going (review0922 M1)', () => {
    const src = source('src/main/storage/routine-store.ts')
    // The keep condition must look at the batch, not just the row's own status.
    expect(src).toContain("parent_run_id NOT IN (SELECT id FROM routine_runs WHERE status = 'running')")
  })

  it('a stop landing in the createSession window never dispatches the prompt (review0922 M2)', () => {
    const src = source('src/main/routine/routine-runner.ts')
    const createIdx = src.indexOf('await agentSessionManager.createSession(')
    const guardIdx = src.indexOf('if (stopRequested) {')
    const askIdx = src.indexOf('await agentSessionManager.ask(')
    // All three present AND in that order: the guard between session creation
    // and the dispatch is the whole fix.
    expect(createIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(createIdx)
    expect(askIdx).toBeGreaterThan(guardIdx)
  })

  it('a stop landing in the mint window is replayed onto the real handle (review0923 M1)', () => {
    const src = source('src/main/routine/batch-runner.ts')
    // The placeholder stop must RECORD the request, and the mint's resolution
    // must REPLAY it onto handle.stop — whose own stopRequested guard then
    // settles the row before any ask. Either half missing and the row runs
    // the whole task out after 停止. (Behaviour's end-to-end shape is probed
    // by scripts/probe-routine-batch.mjs; this scan catches a silent
    // regression of the placeholder between runs.)
    expect(src).toContain('let mintStopRequested = false')
    expect(src).toContain('entry.stop = handle.stop')
    expect(src).toContain('if (mintStopRequested) handle.stop()')
  })
})

/** PLAN-batch-resume (B2): per-run concurrency, the resume channel's shape,
 *  and the xlsx data source. Same source-scan reasoning as above — vitest
 *  cannot register the handler or mount the dialog; the BEHAVIOUR (a resume
 *  wave against a real database, a real workbook through the parser, an
 *  override reaching the pool) rides scripts/probe-routine-batch.mjs.
 *
 *  Non-vacuity: the count scans in the first describe fail when a member is
 *  dropped anywhere; these assert argument FLOWS and ORDERINGS a count cannot
 *  express — each needle is a unique literal, so an empty match is a `toContain`
 *  failure, never a pass. */
describe('batch B2: concurrency override, resume, xlsx source', () => {
  it('the start handler forwards the per-run overrides to the runner', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src).toContain('(_event, id: string, concurrency?: number, timeoutMinutes?: number)')
    expect(src).toContain("routineBatchRunner.start(routine, 'manual', { concurrency, timeoutMinutes })")
  })

  it('concurrency rides every layer: dialog → preload → handler', () => {
    expect(source('src/preload/index.ts')).toContain('routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number)')
    expect(source('src/shared/types/electron-bridge.ts')).toContain('routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number)')
    expect(source('src/renderer/src/components/routine/BatchRunModal.tsx')).toContain('routineBatchRun(routine.id, concurrency, timeoutMinutes)')
  })

  it('the start dialog owns a per-run concurrency state bounded by the shared cap', () => {
    const src = source('src/renderer/src/components/routine/BatchRunModal.tsx')
    expect(src).toContain('useState(DEFAULT_BATCH_CONCURRENCY)')
    // Reset to the SAVED config on every open — a remembered click must not
    // silently become the next run's default.
    expect(src).toContain('setConcurrency(routine.batch?.concurrency ?? DEFAULT_BATCH_CONCURRENCY)')
    // Options derive from MAX_BATCH_CONCURRENCY: a hand-written 1..9 array
    // would offer more than normalizeBatchConcurrency accepts and the start
    // would then refuse at the last step.
    expect(src).toContain('Array.from({ length: MAX_BATCH_CONCURRENCY }')
  })

  it('the scheduled fire cannot crash on a batch refusal (async start)', () => {
    const src = source('src/main/routine/routine-scheduler.ts')
    const idx = src.indexOf("void routineBatchRunner.start(routine, 'schedule')")
    expect(idx).toBeGreaterThan(-1)
    const tail = src.slice(idx, idx + 240)
    // start() now REJECTS (the source read is async) — a bare void would be an
    // unhandled rejection; the catch must notify so the user learns the fire
    // never happened.
    expect(tail).toContain('.catch(')
    expect(tail).toContain('notify(')
  })

  it('the preview handler awaits the now-async parser', () => {
    const handler = source('src/main/ipc/routine.handler.ts')
    expect(handler).toContain('await previewCsv(filePath, params)')
    // And the promise itself: previewCsv is async because xlsx has no sync load.
    expect(source('src/main/routine/batch-source.ts')).toContain('export async function previewCsv')
  })

  it('the data source dispatches .xlsx and refuses legacy .xls', () => {
    const src = source('src/main/routine/batch-source.ts')
    expect(src).toContain("ext === '.xlsx'")
    expect(src).toContain("ext === '.xls'")
    expect(src).toContain('暂不支持 .xls 老格式')
    // Unknown extensions must keep the CSV parser — older configs point at
    // .csv/.txt and a dispatch that throws would orphan them.
    expect(src).toContain(': parseCsv(decodeCsvBytes(readFileSync(path)))')
    // includeEmpty is the density contract: without it a hole stays a sparse
    // cell instead of the CSV parser's '' (behaviour pinned by the hole-row
    // assertion in tests/batch-source-xlsx.test.ts).
    expect(src).toContain('includeEmpty: true')
  })

  it('the editor picker offers xlsx alongside csv/txt', () => {
    const src = source('src/renderer/src/components/routine/RoutineForm.tsx')
    expect(src).toContain("extensions: ['csv', 'txt', 'xlsx']")
  })

  it('the run workspace can resume the parent it is showing', () => {
    const src = source('src/renderer/src/components/routine/RoutineWorkspace.tsx')
    expect(src).toContain('routineBatchResume(run.id)')
    expect(src).toContain('data-batch-resume')
    // Shown only on a settled parent with rows left — a running batch (stop's
    // slot) or a fully-successful one (the main-side refusal) must not offer it.
    expect(src).toContain('!selectedChild && !running && total > 0 && unfinished > 0')
    // The confirm carries the cost note, same as the start dialog.
    expect(src).toContain('将为 ${unfinished} 行各创建一个新会话')
  })

  it('resume re-opens the SAME parent, refusing BEFORE the reopen (six refusals)', () => {
    const src = source('src/main/routine/batch-runner.ts')
    const startIdx = src.indexOf('async resume(parentRunId: string)')
    const bodyStart = startIdx
    const bodyEnd = src.indexOf('private spawn(', startIdx)
    expect(startIdx).toBeGreaterThan(-1)
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    const body = src.slice(bodyStart, bodyEnd)
    const needles = [
      '未找到该批量运行记录',
      '该批量运行仍在进行中',
      '已有批量运行在进行',
      '原任务已被删除',
      '每一行都已成功',
      '批量数据行数已变化',
    ]
    const positions = needles.map((n) => {
      const idx = body.indexOf(n)
      expect(idx, `resume must refuse with: ${n}`).toBeGreaterThan(-1)
      return idx
    })
    const reopen = body.indexOf('reopenBatchRun')
    expect(reopen).toBeGreaterThan(-1)
    // Every refusal must precede the reopen — reopen-then-refuse would flip
    // the parent to running and strand the overlap guard.
    for (const pos of positions) expect(pos).toBeLessThan(reopen)
    // And the plan is computed BEFORE the 全部已成功 refusal — the refusal IS
    // plan.indices.length === 0, so this pins them as the same computation.
    const plan = body.indexOf('planResumeRows')
    expect(plan).toBeGreaterThan(-1)
    expect(plan).toBeLessThan(body.indexOf('每一行都已成功'))
  })

  it('start re-checks the pool AFTER the async source read, before the write', () => {
    const src = source('src/main/routine/batch-runner.ts')
    const startIdx = src.indexOf('async start(')
    const resumeIdx = src.indexOf('async resume(')
    expect(startIdx).toBeGreaterThan(-1)
    expect(resumeIdx).toBeGreaterThan(startIdx)
    const body = src.slice(startIdx, resumeIdx)
    const awaitIdx = body.indexOf('await loadBatchSource(')
    expect(awaitIdx).toBeGreaterThan(-1)
    // Exactly TWO guard sites: the fail-fast check before the read, and the
    // re-check after it. The read yields (xlsx), so without the second site a
    // concurrent start passes its own guard mid-await and two pools run the
    // same routine's rows — first must precede the await, second follow it.
    const guard = '已有批量运行在进行'
    const first = body.indexOf(guard)
    expect(first, 'start must guard before the source read').toBeGreaterThan(-1)
    expect(first).toBeLessThan(awaitIdx)
    const second = body.indexOf(guard, first + 1)
    expect(second, 'start must re-check after the source read').toBeGreaterThan(awaitIdx)
    expect(body.indexOf(guard, second + 1), 'exactly two guard sites').toBe(-1)
    // And the re-check still precedes the first write.
    expect(second).toBeLessThan(body.indexOf('startBatchRun('))
  })

  it('resume re-checks the pool AFTER the async source read, before the reopen', () => {
    const src = source('src/main/routine/batch-runner.ts')
    const startIdx = src.indexOf('async resume(parentRunId: string)')
    const bodyEnd = src.indexOf('private spawn(', startIdx)
    expect(startIdx).toBeGreaterThan(-1)
    expect(bodyEnd).toBeGreaterThan(startIdx)
    const body = src.slice(startIdx, bodyEnd)
    const awaitIdx = body.indexOf('await loadBatchSource(')
    expect(awaitIdx).toBeGreaterThan(-1)
    const guard = '已有批量运行在进行'
    const first = body.indexOf(guard)
    expect(first, 'resume must guard before the source read').toBeGreaterThan(-1)
    expect(first).toBeLessThan(awaitIdx)
    const second = body.indexOf(guard, first + 1)
    expect(second, 'resume must re-check after the source read').toBeGreaterThan(awaitIdx)
    expect(body.indexOf(guard, second + 1), 'exactly two guard sites').toBe(-1)
    // The re-check still sits before the reopen — refusing after it would
    // strand the overlap guard on a running parent.
    expect(second).toBeLessThan(body.indexOf('reopenBatchRun'))
  })

  it('settlement recounts from the store folded to latest attempts', () => {
    const src = source('src/main/routine/batch-runner.ts')
    // maybeSettleParent must not trust its own wave counters for the outcome —
    // a resume wave's success+failed+skipped only covers ITS rows.
    expect(src).toContain('progressFromAttempts(routineStore.listBatchChildren(state.parentRun.id), state.totalRows)')
    const settleIdx = src.indexOf('private maybeSettleParent')
    const countIdx = src.indexOf('const { success, failed, skipped } = state.settled')
    expect(settleIdx).toBeGreaterThan(-1)
    expect(countIdx).toBeGreaterThan(settleIdx)
    // The in-memory counts gate the WHEN (wave drained); the store fold is the WHAT.
    expect(countIdx).toBeLessThan(src.indexOf('progressFromAttempts(routineStore.listBatchChildren'))
  })
})

/** 单次超时 (user 2026-09-23): each batch row runs under a configurable
 *  per-row ceiling instead of only the built-in 15. Same source-scan reasoning
 *  as the B2 describe — the BEHAVIOUR (a hanging row settled failed with
 *  运行超时, overrides reaching the parent's meta) rides
 *  scripts/probe-routine-batch.mjs; these scans catch a layer that dropped the
 *  value between runs. */
describe('batch per-row timeout (单次超时)', () => {
  it('rides every layer: dialog → preload → handler', () => {
    expect(source('src/preload/index.ts')).toContain('routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number)')
    expect(source('src/shared/types/electron-bridge.ts')).toContain('routineBatchRun: (id: string, concurrency?: number, timeoutMinutes?: number)')
    expect(source('src/renderer/src/components/routine/BatchRunModal.tsx')).toContain('routineBatchRun(routine.id, concurrency, timeoutMinutes)')
  })

  it('the start dialog owns a per-run timeout state, reset from the saved config', () => {
    const src = source('src/renderer/src/components/routine/BatchRunModal.tsx')
    expect(src).toContain('useState(DEFAULT_BATCH_TIMEOUT_MINUTES)')
    // Reset to the SAVED config on every open, same contract as concurrency.
    expect(src).toContain('setTimeoutMinutes(routine.batch?.timeoutMinutes ?? DEFAULT_BATCH_TIMEOUT_MINUTES)')
    // Options derive from the shared pick list — a hand-written list could
    // offer values the runner's normalize rejects at the last step.
    expect(src).toContain('BATCH_TIMEOUT_MINUTE_OPTIONS.map((m) => ({ value: m, label: `单次超时 ${m} 分钟` }))')
    expect(src).toContain('data-batch-timeout')
  })

  it('the save door normalizes the config shape (normalizeBatchConfig)', () => {
    const src = source('src/main/ipc/routine.handler.ts')
    expect(src).toContain('timeoutMinutes: normalizeBatchTimeoutMinutes(input?.timeoutMinutes)')
  })

  it('the runner resolves override → saved config → default, and records it on the parent', () => {
    const src = source('src/main/routine/batch-runner.ts')
    expect(src).toContain('normalizeBatchTimeoutMinutes(overrides?.timeoutMinutes)')
    // The config → default half is SHARED now (routine-runner resolves the
    // very same function for a single run — see tests/routine-run-stop.test.ts);
    // two inline copies of that tail is exactly how the two shapes drift.
    expect(src).toContain('?? effectiveTimeoutMinutes(routine.batch)')
    expect(src).not.toContain('?? DEFAULT_BATCH_TIMEOUT_MINUTES')
    // The parent's meta is where 续跑 waves and the workspace header read it.
    expect(src).toContain('timeoutMinutes,')
    // resume re-resolves from the routine config (same as concurrency).
    const resumeIdx = src.indexOf('async resume(')
    const spawnIdx = src.indexOf('private spawn(', resumeIdx)
    expect(resumeIdx).toBeGreaterThan(-1)
    expect(spawnIdx).toBeGreaterThan(resumeIdx)
    expect(src.slice(resumeIdx, spawnIdx)).toContain('effectiveTimeoutMinutes(routine.batch)')
  })

  it('each row executes under the recorded ceiling (executeUnattended timeoutMs)', () => {
    const src = source('src/main/routine/batch-runner.ts')
    expect(src).toContain('timeoutMs: state.timeoutMinutes * 60_000')
    const runner = source('src/main/routine/routine-runner.ts')
    // The primitive's fallback stays the single-run ceiling, derived from the
    // shared default so the two constants cannot drift apart.
    expect(runner).toContain('const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS')
    expect(runner).toContain('const RUN_TIMEOUT_MS = DEFAULT_BATCH_TIMEOUT_MINUTES * 60_000')
    // The timeout message must name the ceiling actually in force.
    expect(runner).toContain('`运行超时（${timeoutMs / 60000} 分钟）`')
  })

  it('the editor exposes 单次超时 beside 并发执行', () => {
    const src = source('src/renderer/src/components/routine/RoutineForm.tsx')
    expect(src).toContain('FieldLabel text="单次超时"')
    expect(src).toContain('draft.batch.timeoutMinutes ?? DEFAULT_BATCH_TIMEOUT_MINUTES')
    expect(src).toContain('BATCH_TIMEOUT_MINUTE_OPTIONS.map((m) => ({ value: m, label: `${m} 分钟` }))')
  })
})
