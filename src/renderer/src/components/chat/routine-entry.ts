// ── The chat toolbar's 存为任务 entry ──
// Pure gating logic, importable from tests: which segment carries the button
// and which engine statuses may show it. The button itself lives in
// MessageGroup's action row; ChatView decides the one segment that gets it.

import type { AgentStatus } from '../../types/agent'
import type { Segment } from './message-segments'

/** Engine statuses in which a turn is settled and the whole conversation is a
 *  fair thing to distill. Everything else — streaming, executing, retrying,
 *  the awaiting_* parks — is a turn in motion or a decision in waiting: the
 *  transcript would read as a half-told story, and the parks have their own
 *  UI the entry must not compete with. */
export function routineEntryAllowed(status: AgentStatus['status']): boolean {
  return status === 'idle' || status === 'completed' || status === 'error'
}

/** Index of the segment the entry rides on, or null. Only the conversation's
 *  LAST segment qualifies, and only when it is a settled assistant message —
 *  the same one the action row shows on (an execution-segment tail renders no
 *  row at all, so there is nothing to ride). Distilling is conversation-scoped;
 *  on an earlier message the button would read as 「提炼到这里为止」. */
export function routineEntryTargetIndex(segments: readonly Segment[]): number | null {
  const last = segments[segments.length - 1]
  // 2026-11-13 step 2：流式尾段现在也是 `single`，类型不再能区分「还在写」和
  // 「已落地」——必须靠 `live` 标志跳过它，否则按钮会随每一次流式尾段闪一下。
  if (!last || last.type !== 'single' || last.live !== undefined || last.msg.role !== 'assistant') return null
  return segments.length - 1
}
