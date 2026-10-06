/**
 * 「定位我的消息」导航的纯逻辑层（PLAN-message-navigator，2026-10-04；
 * 交互第二轮用户裁定：第一轮的搜索浮层否决，改为悬浮按钮组——回到底部 +
 * 上/下一条用户消息步进对）。
 *
 * 本模块只剩一件事：把消息数组派生成**有序的用户消息锚点列表**，供步进
 * 按钮在点击时按视口实测选目标。哪些消息算「我发送的」：role === 'user'、
 * 不携带 tool_result（那是执行段内部回传结果的伪用户消息）、非 autoSummary
 * （历史摘要注入的伪用户消息）、至少有一个非空 text 块。
 */
import type { AgentMessage } from '../../types/agent'

export interface UserPromptAnchor {
  /** AgentMessage.id 原样——跳转请求用它（__后缀 的剥离由 ChatView 的
   *  msgIdToAnchorRef 锚点映射负责，与本层无关）。 */
  id: string
  /** DOM 锚 id（chat-msg-*）：剥离 __后缀 的消息 id，视口实测用它。 */
  anchorId: string
}

/** 哪些消息算「我发送的」——listUserPrompts 的谓词。单独导出：宿主
 * （ChatView）用它做锚点列表的廉价 ids 签名（memo key），两处共用一份
 * 判据，不会漂移。 */
export function isUserPromptMessage(msg: AgentMessage): boolean {
  if (msg.role !== 'user') return false
  if (msg.contentBlocks.some((b) => b.type === 'tool_result')) return false
  if (msg.autoSummary) return false
  return msg.contentBlocks.some((b) => b.type === 'text' && b.text.trim() !== '')
}

export function listUserPrompts(messages: AgentMessage[]): UserPromptAnchor[] {
  const anchors: UserPromptAnchor[] = []
  for (const msg of messages) {
    if (!isUserPromptMessage(msg)) continue
    anchors.push({ id: msg.id, anchorId: msg.id.replace(/__\w+$/, '') })
  }
  return anchors
}
