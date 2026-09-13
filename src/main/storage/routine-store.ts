// ── Routine store (PLAN-0.4.0 M4.1 / M4.2) ──
// Definitions live as one JSON file per routine in ~/.pulsemind/routines/ —
// user-editable artifacts, mirroring the skills directory convention. Run
// history is relational and goes to the SQLite `routine_runs` table.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './database'
import { DATA_DIR } from './index'
import type { Routine, RoutineRun } from '../../shared/types/routine'

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
}

function rowToRun(r: RoutineRunRow): RoutineRun {
  return {
    id: r.id,
    routineId: r.routine_id,
    conversationId: r.conversation_id || undefined,
    status: r.status as RoutineRun['status'],
    trigger: r.trigger as RoutineRun['trigger'],
    startedAt: r.started_at,
    finishedAt: r.finished_at || undefined,
    error: r.error || undefined,
  }
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
    const routine: Routine = { ...input, id: `routine_${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now }
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

  startRun(routineId: string, trigger: RoutineRun['trigger']): RoutineRun {
    const run: RoutineRun = {
      id: `run_${randomUUID().slice(0, 12)}`,
      routineId,
      status: 'running',
      trigger,
      startedAt: new Date().toISOString(),
    }
    getDb()
      .prepare("INSERT INTO routine_runs (id, routine_id, conversation_id, status, trigger, started_at, finished_at, error) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)")
      .run(run.id, run.routineId, run.status, run.trigger, run.startedAt)
    return run
  },

  finishRun(id: string, patch: { status: RoutineRun['status']; conversationId?: string; error?: string }): void {
    getDb()
      .prepare('UPDATE routine_runs SET status = ?, conversation_id = COALESCE(?, conversation_id), finished_at = ?, error = ? WHERE id = ?')
      .run(patch.status, patch.conversationId ?? null, new Date().toISOString(), patch.error ?? null, id)
  },

  /** Whether the routine's previous run is still going (overlap guard). */
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
   *  Call once at app start, before the scheduler's first tick. */
  failStaleRuns(bootedAt: string): void {
    getDb()
      .prepare("UPDATE routine_runs SET status = 'failed', finished_at = ?, error = COALESCE(error, '应用退出，运行被中断') WHERE status = 'running' AND started_at < ?")
      .run(new Date().toISOString(), bootedAt)
  },

  listRuns(routineId?: string, limit = 50): RoutineRun[] {
    const rows = routineId
      ? getDb().prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?').all(routineId, limit) as RoutineRunRow[]
      : getDb().prepare('SELECT * FROM routine_runs ORDER BY started_at DESC LIMIT ?').all(limit) as RoutineRunRow[]
    return rows.map(rowToRun)
  },
}
