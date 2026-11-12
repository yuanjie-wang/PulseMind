/**
 * 磁盘经验 → MemoryPageRecord 的读侧适配层。
 *
 * n9 之后 experience 的正文/静态元数据真源是 EXPERIENCE.md，流水在 experience_uses，
 * 而 `listMemoryPages('experience')` / `getMemoryPageById()` 已经会把这些合成成
 * MemoryPageRecord。所以这里只剩一层薄委托 —— 保留函数名与签名，是因为
 * tool-executors、系统提示、SOP 自动化全都消费这一对入口，换真源不该逼它们改调用。
 */
import type { MemoryPageRecord } from '../../shared/memory-pages'
import { getMemoryPageById, listMemoryPages } from './memory-pages-store'

/** 全量经验（含停用/退役）。目录扫不出来或单条坏掉由 store 侧跳过。 */
export async function listExperienceRecords(): Promise<MemoryPageRecord[]> {
  return listMemoryPages('experience')
}

export async function getExperienceRecord(id: string): Promise<MemoryPageRecord | null> {
  const page = getMemoryPageById(id)
  return page && page.type === 'experience' ? page : null
}
