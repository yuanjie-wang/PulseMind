// ── 停止 for a running routine run — one transport per shape ──
// A batch parent is stopped through its pool (queued rows settle 已跳过,
// in-flight rows are interrupted); a single run through the runner's own
// handle (the row settles 失败 · 用户停止). Both land in main; the caller owns
// the confirm dialog and the refresh afterwards, because what needs
// re-reading differs per surface (the workspace refetches runs, the batch pane
// its items, the landing page the recent-runs list).

import type { RoutineRun } from '../../../../shared/types/routine'

/** The confirm copy for stopping `run` — shared so the two surfaces cannot
 *  drift into describing different consequences for the same click. */
export function stopRunConfirm(run: RoutineRun): { title: string; content: string } {
  return run.batch
    ? { title: '停止这次批量运行？', content: '未开始的行将标记为已跳过，正在运行的行会被中止。' }
    : { title: '停止这次运行？', content: '正在执行的任务会立即中止，运行记录将保留为失败。' }
}

/** One IPC per shape. A refusal (the run settled between the poll and the
 *  click, a stale row) rejects — callers surface it rather than pretend. */
export async function stopRoutineRun(run: RoutineRun): Promise<void> {
  if (run.batch) await window.electronAPI.routineBatchStop(run.id)
  else await window.electronAPI.routineRunStop(run.id)
}
