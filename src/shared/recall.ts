// ── recall 联邦检索（PLAN-recall-unification，2026-10-25）──
// memory_search / conversation_search / knowledge_search 三合一的共享纯逻辑：
// 交错合并 + 全局 limit。设计裁定（用户 2026-10-25）：数据源类型对模型无意义，
// 能提供相关信息就行——**没有 sources/type 参数**；源只出现在结果信封的标签里
// （那是后续动作的说明书：knowledge→md 绝对路径（read 直读）、长记忆页→page 指针），
// 不是请求面。每源内部沿用各自后端的排序；跨源 bm25 分不可比，用轮转交错
// （固定源序 memory → knowledge → conversation）保证确定性——某源零命中自然
// 让位，其余源继续填满 limit（帽是上限不是配额）。

export type RecallSource = 'memory' | 'conversation' | 'knowledge'

export const RECALL_SOURCE_ORDER: readonly RecallSource[] = ['memory', 'knowledge', 'conversation'] as const

export const RECALL_DEFAULT_LIMIT = 10

export interface RecallHit {
  source: RecallSource
  title: string
  /** 主文本：memory=页正文（≤内联帽）/ conversation=摘要 / knowledge=片段。 */
  body: string
  /** 后续动作参数：knowledge 的 md 绝对路径、memory 的 page id、
   *  conversation 的会话 id 等（信封渲染消费）。 */
  meta: Record<string, string>
}

/** 轮转交错合并：按 RECALL_SOURCE_ORDER 逐源轮流取一，直到 limit 或耗尽。
 *  输入数组各自已按后端排序（数组序即名次）。确定性：同输入恒同输出。 */
export function interleaveRecallHits<T extends { source: RecallSource }>(
  hits: T[],
  limit: number = RECALL_DEFAULT_LIMIT
): T[] {
  const capped = Math.max(0, Math.floor(limit))
  if (capped === 0) return []
  const queues = new Map<RecallSource, T[]>(
    RECALL_SOURCE_ORDER.map((src) => [src, hits.filter((h) => h.source === src)])
  )
  const out: T[] = []
  let exhausted = false
  while (out.length < capped && !exhausted) {
    exhausted = true
    for (const src of RECALL_SOURCE_ORDER) {
      if (out.length >= capped) break
      const queue = queues.get(src)!
      if (queue.length > 0) {
        out.push(queue.shift()!)
        exhausted = false
      }
    }
  }
  return out
}
