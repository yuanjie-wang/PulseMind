/**
 * 「定位我的消息」导航的纯逻辑层（PLAN-message-navigator，2026-10-04；
 * 交互第二轮用户裁定：第一轮的搜索浮层否决，改为悬浮按钮组——回到底部 +
 * 上/下一条用户消息步进对）。
 *
 * 本模块两件事：把消息数组派生成**有序的用户消息锚点列表**，以及步进
 * 按钮的**视口目标测算**（点击与置灰共用同一份；原住 MessageNavigator.tsx，
 * 2026-11-20 迁入纯逻辑层——算法只摸 window/document 两个全局，node 环境
 * 注入桩 rect 即可单测直驱）。哪些消息算「我发送的」：role === 'user'、
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

/**
 * 步进目标测算（视口实测，返回命中下标或 -1）。参照物三种情况：
 * 视口内有可见的用户消息 → 最接近视口中心的那条为「当前」，目标 = 它的
 * 前/后一条（连续点击逐条走；居中那条不会被同方向重复命中——「按同侧
 * 最近选目标」的旧算法在这里会命中当前条自己，点了像没动）；视口内一条
 * 都不可见 → 取刚越过视口边缘最近的那条；边缘也没有（视口在全部已挂载
 * 锚之上——懒加载窗口顶部边界附近，或刚 prepend 的一页里没有用户消息，
 * 2026-11-20 实锤的置灰死态）→ up 取首个已挂载锚的前一条：那是窗口外的
 * 未挂载历史，宿主的扩窗机制负责挂载它再滚动（首条已挂载锚已是
 * prompts[0] 时上面真没有更早的用户消息，置灰是正确行为）。未挂载的锚
 * 对视口实测不可见（getElementById 为 null 跳过）；一条都没挂载时全部
 * 在窗口之上，up 取最后一条，down 无处可去。
 */
export function measureStepTarget(prompts: UserPromptAnchor[], dir: -1 | 1): number {
  if (prompts.length === 0) return -1
  const center = window.innerHeight / 2
  let currentIdx = -1
  let currentDist = Infinity
  let edgeIdx = -1
  let edgeDist = Infinity
  let mountedSeen = false
  let firstMountedIdx = -1
  for (let i = 0; i < prompts.length; i++) {
    const el = document.getElementById(`chat-msg-${prompts[i].anchorId}`)
    if (!el) continue
    if (firstMountedIdx < 0) firstMountedIdx = i
    mountedSeen = true
    const rect = el.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      const d = Math.abs((rect.top + rect.bottom) / 2 - center)
      if (d < currentDist) {
        currentDist = d
        currentIdx = i
      }
    }
    // dir 侧刚越过视口边缘的最近一条：up = 完全在视口顶之上（rect.bottom
    // 越大越近），down = 完全在视口底之下（rect.top 越小越近）。
    const past = dir === -1 ? -rect.bottom : rect.top - window.innerHeight
    if (past >= 0 && past < edgeDist) {
      edgeDist = past
      edgeIdx = i
    }
  }
  let targetIdx = -1
  if (currentIdx >= 0) {
    targetIdx = currentIdx + dir
  } else if (edgeIdx >= 0) {
    targetIdx = edgeIdx
  } else if (dir === -1) {
    // 视口在所有已挂载用户消息之上（含一条都没挂载的老形态）：目标指向
    // 视口上方最近的一条——挂载边界之外就轮到未挂载历史，扩窗兜底。
    // firstMountedIdx === 0 时目标越界判 -1：真的没有更早的用户消息。
    targetIdx = mountedSeen ? firstMountedIdx - 1 : prompts.length - 1
  }
  if (targetIdx < 0 || targetIdx >= prompts.length) return -1
  return targetIdx
}
