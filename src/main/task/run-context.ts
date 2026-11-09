// ── 任务共享内核（P1，user 2026-11-08 裁定「任务抽象一层」）──
// 无人值守任务的运行上下文解析：workspaceDir / approvalMode / profileId。
//
// routine（单 prompt）与 workflow（节点图）的执行底座本就同源
// （agentSessionManager + D13 无人值守口径），这里把声明层的解析统一成一处：
// workspace 三级回落（显式 > 任务配置 > 会话夹具 mint）、会话自有列播种
// （授权档必记、模型仅 pin 时记，先于 createSession——顺序是测试钉死的
// 契约，续聊沿用运行时授权/模型全靠它）、createSession opts 产出。
//
// 红线：一律直调 DB 层 setter，绝不走 setApprovalMode/setSessionProfile
// （无人值守运行不得改写全局 last-used）。

import {
  setConversationApprovalMode,
  setConversationProfile,
} from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import type { SandboxApprovalMode } from '../../shared/sandbox/policy'

/** 任务侧声明的运行上下文（routine / workflow 定义的对应字段子集）。 */
export interface TaskRunContext {
  workspaceDir?: string
  approvalMode?: SandboxApprovalMode
  profileId?: string
}

export interface ResolvedRunContext {
  workspaceDir: string
  approvalMode: SandboxApprovalMode
  /** 仅当任务 pin 了模型时存在（缺席 = 运行时的激活模型，不是会话的选择）。 */
  profileId?: string
}

/** 授权档白名单门（与 routine.handler 的 APPROVAL_MODES 同语义）。 */
export function assertApprovalMode(value: unknown): SandboxApprovalMode {
  if (value !== 'auto' && value !== 'outside-ask' && value !== 'always-ask') {
    throw new Error(`非法授权档位：${String(value)}（auto / outside-ask / always-ask）`)
  }
  return value
}

/**
 * 解析一次无人值守运行的上下文并播种会话自有列。
 *
 * @param explicitWorkspaceDir 调用面显式传入的工作区（启动表单/批量行），
 *   优先于任务配置；两者皆缺时 mint 会话夹具（定时触发的 workflow 实例走这）。
 * @param defaultApproval 任务的缺省授权档（routine='outside-ask'、
 *   workflow='auto'）——写成调用方字面量，不随 UI 默认漂移。
 */
export async function resolveTaskRunContext(
  convId: string,
  ctx: TaskRunContext,
  defaultApproval: SandboxApprovalMode,
  explicitWorkspaceDir?: string,
): Promise<ResolvedRunContext> {
  const workspaceDir = explicitWorkspaceDir?.trim()
    || ctx.workspaceDir?.trim()
    || (await resolveConversationWorkspace(convId))
  const approvalMode = ctx.approvalMode ?? defaultApproval
  const profileId = ctx.profileId?.trim() || undefined
  setConversationApprovalMode(convId, approvalMode)
  if (profileId) setConversationProfile(convId, profileId)
  return { workspaceDir, approvalMode, ...(profileId ? { profileId } : {}) }
}
