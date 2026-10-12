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
//   · saveConversation derives the conversation type from the id, so the promote
//     must land on the entity's SLOT: a bare entity id derives 'normal' and puts
//     the thread in the chat list (the report 「用助手创建专家的对话出现在了历史
//     对话列表中，而且内容不可见」), and the thread's own rows cannot follow it
//     there — see promoteAssistDraftToEntity.

import type { AgentMessage } from '../../types/agent'
import { formAssistConversationId } from './form-assist'
import { agentMessagesToConversation } from '../../utils/message-utils'

/** Discard a form-assist conversation: dispose the live main-side session
 *  first, then delete the row — which takes the thread's rows with it.
 *  deleteWorkspace rides along (review 2026-10-12 中2): a discarded assist
 *  thread is lifecycle cleanup, not a chat-list delete — the row-only shape
 *  would orphan its minted folder forever. The main-side guard still refuses
 *  project-bound and backfill rows. Idempotent — safe on ids that never had
 *  a session or a row. */
export async function discardAssistConversation(convId: string): Promise<void> {
  await window.electronAPI.agentSessionEngineCall(convId, 'dispose', []).catch(() => {})
  await window.electronAPI.deleteConversation(convId, { deleteWorkspace: true }).catch(() => {})
}

/** A create-flow's draft thread becomes the saved entity's own conversation:
 *  the mirror's messages are re-persisted under the entity's slot, then the
 *  draft slot is discarded. The caller re-binds to the entity id afterwards —
 *  the convId switch makes the session hook re-restore from the new slot, so
 *  the thread continues seamlessly and the「draft bucket」ceases to exist.
 *  With an empty mirror there is nothing to promote; the discard still runs
 *  so a stale draft row cannot outlive its create flow. */
export async function promoteAssistDraftToEntity(
  messages: AgentMessage[],
  conversationPrefix: string,
  draftId: string,
  entityId: string,
  title: string,
): Promise<void> {
  if (messages.length > 0) {
    // The target is DERIVED, never handed in: passing a raw entity id here is
    // what filed these threads as ordinary chats.
    const convId = formAssistConversationId(conversationPrefix, entityId)
    // The row the thread lands on cannot keep its message ids: `messages.id` is
    // a global key and the upsert behind saveConversation never rewrites
    // `conversation_id`, so re-saving the very same ids would leave every row
    // owned by the DRAFT slot — the promoted conversation would insert with
    // zero messages (「内容不可见」) and the only rows holding the text would be
    // the draft's. Re-keying writes the thread under its new owner; the ids it
    // had belong to a slot that is about to be discarded anyway, and nothing
    // outside the row key refers to them.
    const rekeyed = messages.map((m) => ({ ...m, id: `msg_${convId}_${crypto.randomUUID()}` }))
    await window.electronAPI.saveConversation(agentMessagesToConversation(rekeyed, convId, title))
  }
  await discardAssistConversation(draftId)
}
