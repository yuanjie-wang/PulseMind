/**
 * Tool-result persistence (PLAN-0.3.5 split): extracted from AgentEngine.
 * Functions take the engine back-reference.
 *
 * 记忆提取不在这个模块了：抢救式提取（turn-end salvage）已按 user 2026-11-12 的
 * 裁定整体移除，只留「定时清扫（默认 6h）/ 手动立即提取」与手动记忆面板。压缩只裁
 * 请求副本、不删 DB 行，清扫的游标照样覆盖那些 tool pairs，故落库内容不丢。
 */
import type { EngineCore } from './engine-core'
import { getHost } from '../host'
import type { ToolResultBlock } from '../../types/agent'

export async function persistUnsavedToolResults(engine: EngineCore): Promise<void> {
    const entries: Array<{
      ref_id: string; message_id: string; block_index: number;
      tool_use_id: string; content: string; is_error: number
    }> = []
    // Incremental by the engine's persisted-id set: the old shape re-bound the
    // WHOLE history's result bodies on every request build only for the DB to
    // discard them via INSERT OR IGNORE — O(accumulated bytes) per request on
    // a marathon tool session (better-sqlite3 copies every bound content
    // buffer before the conflict check). ref ids are UUIDs minted once per
    // block, so a remembered id is permanently done.
    const seen = engine.persistedToolResultIds
    for (const msg of engine.messages) {
      if (msg.role !== 'user') continue
      for (let bi = 0; bi < msg.contentBlocks.length; bi++) {
        const block = msg.contentBlocks[bi]
        if (block.type !== 'tool_result') continue
        const tr = block as ToolResultBlock
        if (tr.tool_result_id && tr.content && !seen.has(tr.tool_result_id) && !tr.content.startsWith('[tool_result_id:') && !tr.content.startsWith('[Tool Result:')) {
          entries.push({
            ref_id: tr.tool_result_id,
            message_id: msg.id,
            block_index: bi,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error ? 1 : 0
          })
        }
      }
    }
    if (entries.length === 0) return
    try {
      await getHost().persistToolResults(engine.opts.conversationId!, entries)
      for (const e of entries) seen.add(e.ref_id)
    } catch (err) {
      console.warn('[AgentEngine] persistUnsavedToolResults failed:', err)
    }
  }
