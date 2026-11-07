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

/** 已过期时的补跑延迟（2026-11-01）：重启/重排只能提前、不能推迟既定期限。
 *  不取 0——总开关全关/无可用 profile 的早退轮不落 memoryLastSweepAt（面板
 *  语义），0 延迟会让锚过期的空转退化成紧循环。 */
export const SWEEP_CATCHUP_DELAY_MS = 5 * 60 * 1000

/** 下一次定时清扫的等待时长：以「上次真实提取时刻 + 间隔」为锚的剩余时间。
 *  锚缺失（首装/旧档/垃圾值）回落完整间隔；已过期回落补跑延迟。此前纯内存
 *  setTimeout 每次重启、每次任意 settings 保存都重挂满间隔，频繁重启的机器
 *  上 sweep 永远到不了点（实测 16h 未提取，2026-11-01）。 */
export function nextSweepDelayMs(intervalMs: number, lastSweepAtMs: number, now: number): number {
  if (!(lastSweepAtMs > 0)) return intervalMs
  const remaining = lastSweepAtMs + intervalMs - now
  return remaining > 0 ? remaining : SWEEP_CATCHUP_DELAY_MS
}
