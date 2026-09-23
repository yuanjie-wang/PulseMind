// ── Routine store (PLAN-0.4.0 M4.1 / M4.2) ──
// Definitions live as one JSON file per routine in ~/.pulsemind/routines/ —
// user-editable artifacts, mirroring the skills directory convention. Run
// history is relational and goes to the SQLite `routine_runs` table.

import { prefixedId } from '../utils/id'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './database'
import { DATA_DIR } from './index'
import { latestAttemptsByIndex, progressFromAttempts } from '../../shared/routine/batch'
import type { Routine, RoutineBatchProgress, RoutineRun } from '../../shared/types/routine'

export const ROUTINES_DIR = join(DATA_DIR, 'routines')

function routinePath(id: string): string {
  return join(ROUTINES_DIR, `${id}.json`)
}

function readRoutine(id: string): Routine | null {
  try {
    const raw = readFileSync(routinePath(id), 'utf-8')
    const parsed = JSON.parse(raw) as Routine
    if (!parsed || typeof parsed !== 'object' || parsed.id !== id) return null
    return parsed
  } catch {
    return null
  }
}

function writeRoutine(routine: Routine): void {
  mkdirSync(ROUTINES_DIR, { recursive: true })
  writeFileSync(routinePath(routine.id), JSON.stringify(routine, null, 2), 'utf-8')
}

interface RoutineRunRow {
  id: string
  routine_id: string
  conversation_id: string | null
  status: string
  trigger: string
  started_at: string
  finished_at: string | null
  error: string | null
  parent_run_id: string | null
  row_index: number | null
  params_json: string | null
  batch_json: string | null
}

function rowToRun(r: RoutineRunRow): RoutineRun {
  const run: RoutineRun = {
    id: r.id,
    routineId: r.routine_id,
    conversationId: r.conversation_id || undefined,
    status: r.status as RoutineRun['status'],
    trigger: r.trigger as RoutineRun['trigger'],
    startedAt: r.started_at,
    finishedAt: r.finished_at || undefined,
    error: r.error || undefined,
  }
  if (r.parent_run_id) run.parentRunId = r.parent_run_id
  if (r.row_index != null) run.rowIndex = r.row_index
  if (r.params_json) {
    try { run.paramsSnapshot = JSON.parse(r.params_json) as Record<string, string> } catch { /* a hand-edited row must not break listing */ }
  }
  if (r.batch_json) {
    try { run.batch = JSON.parse(r.batch_json) as RoutineRun['batch'] } catch { /* ditto */ }
  }
  return run
}

export const routineStore = {
  list(): Routine[] {
    if (!existsSync(ROUTINES_DIR)) return []
    const out: Routine[] = []
    for (const file of readdirSync(ROUTINES_DIR)) {
      if (!file.endsWith('.json')) continue
      const routine = readRoutine(file.slice(0, -'.json'.length))
      if (routine) out.push(routine)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  get(id: string): Routine | null {
    return readRoutine(id)
  },

  create(input: Omit<Routine, 'id' | 'createdAt' | 'updatedAt'>): Routine {
    const now = new Date().toISOString()
    const routine: Routine = { ...input, id: prefixedId('routine'), createdAt: now, updatedAt: now }
    writeRoutine(routine)
    return routine
  },

  update(id: string, patch: Partial<Omit<Routine, 'id' | 'createdAt'>>): Routine | null {
    const existing = readRoutine(id)
    if (!existing) return null
    const next: Routine = { ...existing, ...patch, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }
    writeRoutine(next)
    return next
  },

  remove(id: string): void {
    try { unlinkSync(routinePath(id)) } catch { /* already gone */ }
  },

  // ── Run history (SQLite) ──

  /** conversationId is decided by the caller and persisted up front so a
   *  running run is already attached to its (live) conversation for
   *  run-history click-through. */
  startRun(routineId: string, trigger: RoutineRun['trigger'], conversationId: string): RoutineRun {
    const run: RoutineRun = {
      id: prefixedId('run', 12),
      routineId,
      conversationId,
      status: 'running',
      trigger,
      startedAt: new Date().toISOString(),
    }
    getDb()
      .prepare("INSERT INTO routine_runs (id, routine_id, conversation_id, status, trigger, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(run.id, run.routineId, conversationId, run.status, run.trigger, run.startedAt)
    return run
  },

  finishRun(id: string, patch: { status: RoutineRun['status']; conversationId?: string; error?: string }): void {
    getDb()
      .prepare('UPDATE routine_runs SET status = ?, conversation_id = COALESCE(?, conversation_id), finished_at = ?, error = ? WHERE id = ?')
      .run(patch.status, patch.conversationId ?? null, new Date().toISOString(), patch.error ?? null, id)
  },

  // ── Batch runs (PLAN-routine-batch) ──
  // One batch = a PARENT row (no conversation of its own) + one CHILD row per
  // CSV row. Children are real run rows: hasRunningRun/overlap, failStaleRuns
  // crash recovery and run-history click-through all work on them unchanged.

  startBatchRun(routineId: string, trigger: RoutineRun['trigger'], meta: { csvName: string; totalRows: number; concurrency: number; timeoutMinutes: number }): RoutineRun {
    const run: RoutineRun = {
      id: prefixedId('run', 12),
      routineId,
      status: 'running',
      trigger,
      startedAt: new Date().toISOString(),
      batch: meta,
    }
    getDb()
      .prepare("INSERT INTO routine_runs (id, routine_id, conversation_id, status, trigger, started_at, finished_at, error, parent_run_id, row_index, params_json, batch_json) VALUES (?, ?, NULL, 'running', ?, ?, NULL, NULL, NULL, NULL, NULL, ?)")
      .run(run.id, routineId, trigger, run.startedAt, JSON.stringify(meta))
    return run
  },

  /** conversationId may be null for a row that failed its parameter pre-check
   *  (it never got a session, so it has nothing to click through to). */
  startBatchChildRun(parent: RoutineRun, rowIndex: number, paramsSnapshot: Record<string, string>, conversationId: string | null): RoutineRun {
    const run: RoutineRun = {
      id: prefixedId('run', 12),
      routineId: parent.routineId,
      conversationId: conversationId ?? undefined,
      status: 'running',
      trigger: parent.trigger,
      startedAt: new Date().toISOString(),
      parentRunId: parent.id,
      rowIndex,
      paramsSnapshot,
    }
    getDb()
      .prepare("INSERT INTO routine_runs (id, routine_id, conversation_id, status, trigger, started_at, finished_at, error, parent_run_id, row_index, params_json, batch_json) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, ?, ?, ?, NULL)")
      .run(run.id, run.routineId, conversationId, run.trigger, run.startedAt, parent.id, rowIndex, JSON.stringify(paramsSnapshot))
    return run
  },

  listBatchChildren(parentRunId: string): RoutineRun[] {
    // A resumed batch carries several attempt rows per CSV row; the item table
    // speaks in ROWS, not attempts — one entry per row_index carrying the
    // latest attempt's outcome, plus how many attempts the row has had.
    const perRow = new Map<number, { run: RoutineRun; count: number }>()
    for (const row of childRows(parentRunId)) {
      if (row.row_index == null) continue
      const seen = perRow.get(row.row_index)
      perRow.set(row.row_index, { run: rowToRun(row), count: (seen?.count ?? 0) + 1 })
    }
    return [...perRow.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, { run, count }]) => (count > 1 ? { ...run, attempts: count } : run))
  },

  getRun(id: string): RoutineRun | null {
    const row = getDb().prepare('SELECT * FROM routine_runs WHERE id = ?').get(id) as RoutineRunRow | undefined
    return row ? rowToRun(row) : null
  },

  /** Re-open a settled batch parent for a resume wave: back to 'running' with
   *  the old outcome summary cleared — settlement overwrites it once every
   *  row holds a terminal outcome again. */
  reopenBatchRun(id: string): void {
    getDb()
      .prepare("UPDATE routine_runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?")
      .run(id)
  },

  batchProgress(parentRunId: string): RoutineBatchProgress {
    const parent = this.getRun(parentRunId)
    const children = childRows(parentRunId).map(rowToRun)
    return progressFromAttempts(children, parent?.batch?.totalRows ?? latestAttemptsByIndex(children).size)
  },

  /** Whether the routine's previous run is still going (overlap guard). Child
   *  rows count — a batch keeps the guard closed until its parent settles. */
  hasRunningRun(routineId: string): boolean {
    const row = getDb()
      .prepare("SELECT id FROM routine_runs WHERE routine_id = ? AND status = 'running' LIMIT 1")
      .get(routineId)
    return row != null
  },

  /** Startup recovery: a run left 'running' by a previous process (quit or
   *  crash mid-run) never gets finishRun, so its overlap guard would block
   *  every future scheduled fire of that routine. Only rows started before
   *  `bootedAt` are settled, so runs already started by this process survive.
   *  Call once at app start, before the scheduler's first tick. Batch parents
   *  and children are settled by the same stroke — a crashed batch reads as
   *  a failed one instead of hanging its guard open forever. */
  failStaleRuns(bootedAt: string): void {
    getDb()
      .prepare("UPDATE routine_runs SET status = 'failed', finished_at = ?, error = COALESCE(error, '应用退出，运行被中断') WHERE status = 'running' AND started_at < ?")
      .run(new Date().toISOString(), bootedAt)
  },

  listRuns(routineId?: string, limit = 50): RoutineRun[] {
    const rows = routineId
      ? getDb().prepare('SELECT * FROM routine_runs WHERE routine_id = ? AND parent_run_id IS NULL ORDER BY started_at DESC LIMIT ?').all(routineId, limit) as RoutineRunRow[]
      : getDb().prepare('SELECT * FROM routine_runs WHERE parent_run_id IS NULL ORDER BY started_at DESC LIMIT ?').all(limit) as RoutineRunRow[]
    const runs = rows.map(rowToRun)
    // A batch parent is one line in a flat list; live progress is what makes
    // the line readable (「批量 · 成功 8/10」). Children never appear here.
    for (const run of runs) {
      if (run.batch) run.batchProgress = batchProgressOf(run.id, run.batch)
    }
    return runs
  },

  /** Delete run rows by id — batch children go WITH their parent, and the
   *  full delete set is returned so the caller can also dispose of every
   *  conversation involved (see routine-run-history). */
  removeRuns(runIds: string[]): RoutineRun[] {
    if (runIds.length === 0) return []
    const db = getDb()
    const select = db.prepare('SELECT * FROM routine_runs WHERE id = ?')
    const rows = runIds
      .map((id) => select.get(id) as RoutineRunRow | undefined)
      .filter((row): row is RoutineRunRow => row != null)
    return deleteRowsWithChildren(rows)
  },

  /** Delete a task's runs and return them. A run still in flight keeps its row
   *  unless `includeRunning` — task deletion drops everything, the workspace's
   *  清空 leaves the live row so the run stays visible and settle-able. The
   *  keep condition is the live BATCH, not just its live rows: a batch's
   *  substance is its children, so a settled child whose parent row is still
   *  running is kept too — a mid-batch 清空 that deleted it would make the
   *  finished row table (and the parent's progress counts) miss rows that did
   *  run (review_20260922 M1). Once the parent settles, its children clear as
   *  before. */
  removeRunsOfRoutine(routineId: string, includeRunning = false): RoutineRun[] {
    const where = includeRunning
      ? 'routine_id = ?'
      : "routine_id = ? AND status <> 'running' AND (parent_run_id IS NULL OR parent_run_id NOT IN (SELECT id FROM routine_runs WHERE status = 'running'))"
    const rows = getDb().prepare(`SELECT * FROM routine_runs WHERE ${where}`).all(routineId) as RoutineRunRow[]
    return deleteRowsWithChildren(rows)
  },

  /** Retention prune: delete settled runs started before `cutoffIso`, plus
   *  every child of a pruned parent regardless of its own timestamp (the
   *  parent's decision — otherwise a pruned batch leaves orphans whose
   *  transcripts outlive the row that owned them). In-flight rows are never
   *  pruned — their row still owes the overlap guard a settle. */
  removeRunsStartedBefore(cutoffIso: string): RoutineRun[] {
    const stale = "started_at < ? AND status <> 'running'"
    const rows = getDb().prepare(`SELECT * FROM routine_runs WHERE ${stale}`).all(cutoffIso) as RoutineRunRow[]
    return deleteRowsWithChildren(rows)
  },
}

// ── Batch-aware deletion helpers ──
// Every removal funnel goes through deleteRowsWithChildren so a parent can
// never be deleted out from under its children (and the caller learns the
// FULL conversation set to drop). Chunked because a months-old retention
// prune can select thousands of ids and SQLite binds parameters one by one.

const ID_CHUNK = 400

function selectChildrenOf(ids: string[]): RoutineRunRow[] {
  if (ids.length === 0) return []
  const db = getDb()
  const out: RoutineRunRow[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    out.push(...db.prepare(`SELECT * FROM routine_runs WHERE parent_run_id IN (${placeholders})`).all(...chunk) as RoutineRunRow[])
  }
  return out
}

function deleteRowsWithChildren(rows: RoutineRunRow[]): RoutineRun[] {
  if (rows.length === 0) return []
  const children = selectChildrenOf(rows.map((r) => r.id))
  // removeRunsOfRoutine / removeRunsStartedBefore select children too (they
  // carry routine_id / their own started_at), so the child set can overlap
  // `rows` — dedupe by id or the returned delete count (the caller's 清理 N
  // 条 toast) double-counts every batch row.
  const seen = new Set<string>()
  const all: RoutineRunRow[] = []
  for (const row of [...rows, ...children]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    all.push(row)
  }
  const db = getDb()
  const del = db.prepare('DELETE FROM routine_runs WHERE id = ?')
  db.transaction(() => { for (const row of all) del.run(row.id) })()
  return all.map(rowToRun)
}

// ── Batch read helpers ──
// Progress is folded to the LATEST attempt per CSV row (a resumed batch appends
// new attempt rows for unfinished indices), against the row count the batch was
// launched with — the honest denominator before every row is dispatched and the
// stable one once resumed waves outnumber the rows.

function childRows(parentRunId: string): RoutineRunRow[] {
  // started_at then rowid: the later attempt of a row must come after its
  // earlier ones so "last occurrence wins" folds correctly.
  return getDb()
    .prepare('SELECT * FROM routine_runs WHERE parent_run_id = ? ORDER BY started_at, rowid')
    .all(parentRunId) as RoutineRunRow[]
}

function batchProgressOf(parentId: string, meta: RoutineRun['batch']): RoutineBatchProgress {
  const children = childRows(parentId).map(rowToRun)
  return progressFromAttempts(children, meta?.totalRows ?? latestAttemptsByIndex(children).size)
}
