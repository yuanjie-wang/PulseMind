// ── Routine run-history maintenance ──
// Deleting a run is two-store work: the SQLite row and the conversation that
// run produced (its messages go with it through the FK cascade). Both entry
// points — the workspace's manual cleanup and the startup retention prune —
// go through here, so a transcript can never outlive the run that owns it.

import { routineStore } from '../storage/routine-store'
import { deleteConversation } from '../storage/conversation.db'
import { settingsStore } from '../storage/settings-store'
import type { RoutineRun } from '../../shared/types/routine'

const DAY_MS = 24 * 60 * 60 * 1000

/** Retention cutoff; null = keep everything (no policy / 0 days). */
function cutoffFromDays(days: number | undefined): string | null {
  if (!days || days <= 0) return null
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

/** Drop the transcripts of run rows that were just deleted. */
function dropConversations(runs: RoutineRun[]): void {
  for (const run of runs) {
    if (!run.conversationId) continue
    try {
      deleteConversation(run.conversationId)
    } catch (err) {
      console.warn('[RoutineRunHistory] transcript cleanup failed:', err)
    }
  }
}

export const routineRunHistory = {
  /** 手动清理一条运行记录（连同它的对话）。返回删除条数。 */
  remove(runId: string): number {
    const removed = routineStore.removeRuns([runId])
    dropConversations(removed)
    return removed.length
  },

  /** 清空某个任务的运行记录（默认保留正在运行的那条）。 */
  clearRoutine(routineId: string, includeRunning = false): number {
    const removed = routineStore.removeRunsOfRoutine(routineId, includeRunning)
    dropConversations(removed)
    return removed.length
  },

  /** 按保留策略清理已结束的运行记录。`days` 省略时用设置里的策略。 */
  async prune(days?: number): Promise<number> {
    const policy = days ?? (await settingsStore.get()).routineRunRetentionDays
    const cutoff = cutoffFromDays(policy)
    if (!cutoff) return 0
    const removed = routineStore.removeRunsStartedBefore(cutoff)
    dropConversations(removed)
    return removed.length
  },
}
