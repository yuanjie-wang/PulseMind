// SOP 自动清扫资格门（PLAN-experience-sop 刀四，2026-10-26）——纯逻辑：
// 候选资格判定 + 优先排序。DB/调度接线在主进程（session-manager 的提取清扫尾部），
// 手动「固化为 SOP」按钮不走这里（门只管自动派发，手动是用户的逃生面）。
//
// 资格语义：一阶段经验线索（maturity='clue'）要被自动固化，得先证明自己值得一个
// 完整的代理运行——recurrence（reinforce 重现计数）是提取侧资格，use_count（pick/
// recall 记账）是使用侧优先级；失败有 24h 退避，累计 3 次失败退役（手动仍可跑，
// 但自动不再碰）。
export const SOP_RECURRENCE_MIN = 2
export const SOP_RETRY_MS = 24 * 60 * 60_000
export const SOP_MAX_ATTEMPTS = 3
export const SOP_SWEEP_BATCH = 2

export type SopVerdict = 'distill' | 'skip-maturity' | 'skip-recurrence' | 'skip-backoff' | 'skip-retired'

export interface SopCandidate {
  /** 派生成熟度：只有 'clue' 可自动固化（'sop' 已是产物）。 */
  maturity: string
  /** reinforce 重现计数。 */
  recurrence: number
  /** 累计失败尝试数（成功的尝试会 supersede 掉页面，不留在候选里）。 */
  attempts: number
  /** 上次失败尝试的 epoch ms；null = 从未尝试。 */
  lastAttemptAt: number | null
}

export function judgeSopCandidate(
  c: SopCandidate,
  now: number,
  opts: { recurrenceMin?: number; retryMs?: number; maxAttempts?: number } = {}
): SopVerdict {
  const recurrenceMin = opts.recurrenceMin ?? SOP_RECURRENCE_MIN
  const retryMs = opts.retryMs ?? SOP_RETRY_MS
  const maxAttempts = opts.maxAttempts ?? SOP_MAX_ATTEMPTS
  if (c.maturity !== 'clue') return 'skip-maturity'
  if (c.attempts >= maxAttempts) return 'skip-retired'
  if (c.recurrence < recurrenceMin) return 'skip-recurrence'
  if (c.lastAttemptAt !== null && now - c.lastAttemptAt < retryMs) return 'skip-backoff'
  return 'distill'
}

/** 使用侧优先排序：use_count 降序，平手时 recurrence 降序再 updated_at 新者先。
 *  返回新数组，不改输入。 */
export function sortBySopPriority<T extends { useCount: number; recurrence: number; updatedAt: string }>(pages: readonly T[]): T[] {
  return [...pages].sort((a, b) => {
    if (a.useCount !== b.useCount) return b.useCount - a.useCount
    if (a.recurrence !== b.recurrence) return b.recurrence - a.recurrence
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}
