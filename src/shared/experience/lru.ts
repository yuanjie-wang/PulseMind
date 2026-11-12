/**
 * 经验池容量与淘汰次序（2026-11-12 用户裁定）。
 *
 * 单独成文件是因为 `memory-pages-store.ts` 顶部会拉进 `better-sqlite3`
 * （Electron-ABI，vitest 的 Node 进程加载不了），而淘汰次序是纯逻辑、
 * 值得被真正断言而不是靠扫源码「看起来对」。
 */

/** 经验池上限：最多 30 条，超出按 LRU 淘汰。 */
export const MAX_EXPERIENCE_PAGES = 30

/** 只取排序需要的字段，避免与存储记录类型耦合。 */
export interface LruCandidate {
  id: string
  useCount: number
  lastUsedAt: string | null
  updatedAt: string
}

/**
 * 淘汰次序：`use_count` 升序 → `last_used_at` 升序 → `updated_at` 升序 → `id` 定序。
 *
 * - `last_used_at` 为 null 视为「从未被用过」，比任何时间戳都久，最先前淘汰。
 * - 末两级只用于**确定性**：同一份数据每次算出的淘汰名单必须一致，否则
 *   一次淘汰就会抖掉不同的经验。
 */
export function compareExperienceLRU(a: LruCandidate, b: LruCandidate): number {
  if (a.useCount !== b.useCount) return a.useCount - b.useCount
  const at = a.lastUsedAt ?? ''
  const bt = b.lastUsedAt ?? ''
  if (at !== bt) return at < bt ? -1 : 1
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}
