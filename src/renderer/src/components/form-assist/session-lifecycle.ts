// ── Form-assist conversation lifecycle ──
// 每个任务/专家最多关联一个会话（用户裁定 2026-09-20）：会话 id 由实体决定
// （formAssistConversationId 的单槽 —— routine_assist_<id> / expert_assist_<id>
// / *_assist_draft），「新会话」不换 id，而是把旧线程丢弃后原地重来；新建流里
// 聊出来的草稿线程在首次保存时升格为该实体的会话。例程与专家两个表单助手共用
// 这里全部三个入口，协议语义不允许分叉。
//
// The wire facts these helpers rely on:
//   · agentSessionCreate REUSES a live main-side session entry, so deleting the
//     row without disposing the session would resurrect the old thread's
//     context on the next ask — dispose comes first, always;
//   · both dispose and the row delete tolerate absence (a thread nothing was
//     ever sent to has neither);
//   · saveConversation derives the conversation type from the id, so a thread
//     persisted under an *_assist_<entityId> slot keeps its assist type and
//     stays out of every 'normal'-filtered surface.

import type { AgentMessage } from '../../types/agent'
import { agentMessagesToConversation } from '../../utils/message-utils'

/** Discard a form-assist conversation: dispose the live main-side session
 *  first, then delete the row. Idempotent — safe on ids that never had a
 *  session or a row. */
export async function discardAssistConversation(convId: string): Promise<void> {
  await window.electronAPI.agentSessionEngineCall(convId, 'dispose', []).catch(() => {})
  await window.electronAPI.deleteConversation(convId).catch(() => {})
}

/** A create-flow's draft thread becomes the saved entity's own conversation:
 *  the mirror's messages are re-persisted under the entity's slot, then the
 *  draft slot is discarded. The caller re-binds to the entity id afterwards —
 *  the convId switch makes the session hook re-restore from the new slot, so
 *  the thread continues seamlessly and the「draft bucket」ceases to exist.
 *  With an empty mirror there is nothing to promote; the discard still runs
 *  so a stale draft row cannot outlive its create flow. */
export async function promoteAssistDraftToEntity(messages: AgentMessage[], draftId: string, entityId: string, title: string): Promise<void> {
  if (messages.length > 0) {
    await window.electronAPI.saveConversation(agentMessagesToConversation(messages, entityId, title))
  }
  await discardAssistConversation(draftId)
}
