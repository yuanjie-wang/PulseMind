// 记忆提取定时清扫（PLAN-memory-wiki M2c，2026-10-25）——纯逻辑：会话资格判定。
// 用户裁定（2026-10-25）：主时机 = 定时清扫（默认 6h、可设、0=仅手动），
// afterSession/启动回填两条路径退役。五条资格条件在这里判定，DB/调度接线在
// 主进程 session-manager。
export const SWEEP_MIN_MESSAGES = 5
export const SWEEP_MIN_DELTA = 4
export const SWEEP_ACTIVE_WINDOW_MS = 30 * 60 * 1000
export const SWEEP_BATCH_LIMIT = 10
export const DEFAULT_MEMORY_EXTRACT_INTERVAL_HOURS = 6

export type SweepVerdict = 'extract' | 'skip-current' | 'skip-thin' | 'wait-accumulate' | 'skip-active'

export interface SweepCandidate {
  /** 会话文本消息总数（提取游标的同一单位）。 */
  totalTextMessages: number
  /** 已提取到的消息数（游标）。 */
  cursor: number
  /** 会话最近活跃时间（epoch ms）。 */
  lastActiveAt: number
}

export function judgeSweepCandidate(
  c: SweepCandidate,
  now: number,
  opts: { minMessages?: number; minDelta?: number; activeWindowMs?: number } = {}
): SweepVerdict {
  const minMessages = opts.minMessages ?? SWEEP_MIN_MESSAGES
  const minDelta = opts.minDelta ?? SWEEP_MIN_DELTA
  const activeWindowMs = opts.activeWindowMs ?? SWEEP_ACTIVE_WINDOW_MS
  if (c.cursor >= c.totalTextMessages) return 'skip-current' // 近期已提取的不再提取
  if (c.totalTextMessages < minMessages) return 'skip-thin' // 轮数太少的不提取
  if (now - c.lastActiveAt < activeWindowMs) return 'skip-active' // 可能正在使用
  if (c.totalTextMessages - c.cursor < minDelta) return 'wait-accumulate' // 薄增量攒到下轮
  return 'extract'
}

/** 间隔换毫秒；0/负数 = 关闭定时（仅手动）。非法/缺失回落默认 6h。 */
export function sweepIntervalMs(hours: number | undefined | null): number | null {
  if (hours === 0) return null // 用户显式关闭定时：仅手动触发
  const h = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MEMORY_EXTRACT_INTERVAL_HOURS
  return h * 3600_000
}
