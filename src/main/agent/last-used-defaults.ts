// ── 上次使用的授权级别 / 模型（「新建会话沿用上次选择」，用户 2026-09-24）──
// 一个持久的全局变量：用户在任何一个会话上做了交互式的授权/模型修改（桌面
// composer、welcome 页、插件面板、设置面板的默认模型），这里就跟着变；新建
// 会话以它为初始值，落成自己的列，之后每个会话各持各的配置，不再跟随。
// 持久化在 settings.json（跨重启仍成立），经 settingsStore.update 的 merge
// 形状写入 —— mutator 只携带自己的字段，不会用陈旧快照回滚并发的其他写入者
// （整存只属于设置编辑器的 set，见 settings.handler 的保底透传）。

import { settingsStore } from '../storage/settings-store'
import {
  setConversationApprovalMode,
  setConversationProfile,
  getConversationApprovalMode,
  getConversationProfileId,
  deriveConvType,
} from '../storage/conversation.db'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'
import type { AppSettings } from '../../shared/types/settings'
import type { AgentSessionCreateOptions } from '../../shared/agent-protocol'

/** 记下一次授权修改。所有调用方都已被调用方语义保证是「用户的选择」——
 *  工具工作室的首建种子走 IPC 时必须带 source:'derived'（见 conversation.handler）。
 *  返回落盘 promise（已 catch 成 resolve），调用方 fire-and-forget，测试可等待。 */
export function rememberLastUsedApprovalMode(mode: SandboxApprovalMode): Promise<void> {
  return settingsStore
    .update((s) => ({ ...s, lastUsedApprovalMode: mode }))
    .catch((err) => console.warn('[LastUsed] approval persist failed:', err))
}

/** 记下一次模型选择。null（解除绑定、回到默认）不是选择，不改 last-used。 */
export function rememberLastUsedProfileId(profileId: string): Promise<void> {
  return settingsStore
    .update((s) => ({ ...s, lastUsedProfileId: profileId }))
    .catch((err) => console.warn('[LastUsed] profile persist failed:', err))
}

/** 新建会话的初始值：把 last-used 落成这个会话自己的列。只作用于「用户自己的
 *  普通会话」—— 任何创建期 pin（routine 的授权/模型、派生会话的 prompt/工具/
 *  专家包）都意味着创建方已经表达过配置，尊重它；列已有值的旧会话也不动
 *  （重启后重新 createSession 的老对话必须维持自己原来的配置，而不是漂到新的
 *  last-used）。写在 doCreateSession 的 profile/approvalMode 解析之前，本次
 *  创建就直接用播种值。settings 由调用方传入（doCreateSession 反正要读）。 */
export function seedLastUsedDefaults(sessionId: string, opts: AgentSessionCreateOptions, settings: AppSettings): void {
  if (deriveConvType(sessionId) !== 'normal') return
  if (opts.approvalMode || opts.profileId || opts.systemPromptOverride || opts.expertProfile || opts.allowedTools) return

  if (getConversationApprovalMode(sessionId) === undefined && settings.lastUsedApprovalMode) {
    setConversationApprovalMode(sessionId, settings.lastUsedApprovalMode)
  }
  const lastProfile = settings.lastUsedProfileId
  if (getConversationProfileId(sessionId) === undefined && lastProfile && settings.profiles.some((p) => p.id === lastProfile)) {
    setConversationProfile(sessionId, lastProfile)
  }
}
