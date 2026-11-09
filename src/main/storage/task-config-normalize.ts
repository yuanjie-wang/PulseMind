// ── 任务配置的写门归一（对话式任务与工作流共用）──
// 「两种模式在触发与批量上的能力一致」的存储侧一半 (user 2026-11-08)：同一
// 份 RoutineBatchConfig / RoutineTrigger 形态，同一套不变量，同一个写门。
// 归一放在这里而不是各 store 里复制，是因为它的每一条都是安全/预算门：
// webhook token 只能由主进程铸（UI 不发明密钥）、debounce 夹在 1–60s、并发
// 夹在 1–5、超时夹在允许档位——两份拷贝早晚漂移成「一侧能过、另一侧能塞」。

import { randomBytes } from 'node:crypto'
import { normalizeBatchConcurrency, normalizeBatchTimeoutMinutes } from '../../shared/routine/batch'
import type { RoutineBatchConfig, RoutineFileTrigger, RoutineTrigger, RoutineWebhookTrigger } from '../../shared/types/routine'

/** Triggers normalize on EVERY write, so the store is the one place the
 *  invariants live — a webhook trigger always leaves with a token (minted
 *  HERE; the UI never invents secrets), file paths are trimmed/non-empty
 *  (≤20), and the debounce window is clamped. An all-invalid list normalizes
 *  to undefined (field dropped from the JSON). */
export function normalizeTriggers(triggers: unknown): RoutineTrigger[] | undefined {
  if (!Array.isArray(triggers)) return undefined
  const out: RoutineTrigger[] = []
  for (const raw of triggers.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Partial<RoutineFileTrigger> & Partial<RoutineWebhookTrigger> & { type?: unknown }
    if (t.type === 'file') {
      const paths = (t.paths ?? [])
        .map((p) => String(p ?? '').trim())
        .filter((p) => p.length > 0)
        .slice(0, 20)
      if (paths.length === 0) continue
      const debounceMs = Number.isFinite(t.debounceMs) ? Math.min(60_000, Math.max(1_000, Number(t.debounceMs))) : undefined
      out.push({ type: 'file', paths, ...(debounceMs !== undefined ? { debounceMs } : {}) })
    } else if (t.type === 'webhook') {
      const token = typeof t.token === 'string' && t.token.trim() ? t.token.trim() : randomBytes(16).toString('hex')
      out.push({ type: 'webhook', token })
    }
  }
  return out.length > 0 ? out : undefined
}

/** The batch config passes through the same door: a garbage concurrency would
 *  widen the run pool at run time, and a garbage timeout would fire late or
 *  never; only the shape (non-empty csvPath, integer 1–5 concurrency,
 *  integer 1–120 timeoutMinutes, boolean applyToSchedule) is checked here —
 *  the file itself is validated when it is read (preview / batch start).
 *
 *  Workflow 侧只用到 csvPath / applyToSchedule（实例串行 FIFO，并发选择在
 *  向导里锁住），存下来的是同一份形态：换执行策略时不必迁移数据。 */
export function normalizeBatchConfig(input?: Partial<RoutineBatchConfig>): RoutineBatchConfig | undefined {
  const csvPath = input?.csvPath?.trim()
  if (!csvPath) return undefined
  return {
    csvPath,
    concurrency: normalizeBatchConcurrency(input?.concurrency),
    timeoutMinutes: normalizeBatchTimeoutMinutes(input?.timeoutMinutes),
    applyToSchedule: input?.applyToSchedule === true,
  }
}
