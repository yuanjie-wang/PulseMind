/**
 * 记忆池的尺寸预算（user 2026-10-10 常驻区瘦身裁定）。
 *
 * 单条上限：每条记忆 ≤100 字、一个短句说结论。三条写路径（SessionReviewAgent
 * 主提取、extractMemoriesFromOldToolPairs 打捞、MemoryCompressionAgent 合并）
 * 的提示词都按它写规则；主提取与打捞另有结构性兜底——超限条目直接不入库
 * （长内容的家是经验记录，不是记忆）。合并产物例外：合并的删除账按产物哈希
 * 记，跳过超限产物会让它的输入行被当作「已消费」删掉——丢内容，所以合并
 * 产物照存，超限条目由渲染过滤挡在常驻区外、留在库里给 memory_search。
 *
 * 常驻帽：`## Extracted Memories` 只渲染最新的 20 条（且仅限 ≤100 字的条目），
 * 其余留在库里。常驻区 rides 全局 3h 快照，字节稳定性不受影响。
 */
export const MEMORY_ENTRY_MAX_CHARS = 100
export const MEMORY_RESIDENT_CAP = 20
