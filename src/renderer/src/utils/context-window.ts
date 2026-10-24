/** 上下文刻度（composer 圆环）的分母：当前会话实际在用的那个模型的窗口。
 *  解析链镜像主进程 resolveProfile —— 会话自己的模型（App 层已把
 *  pin/column/上次使用解析成 effectiveProfileId）→ 默认模型 → 第一个条目；
 *  末级回落 128_000 与引擎一致（AgentEngine 的 `contextLength || 128_000`）。
 *  红线：绝不拿「别的模型」的 contextLength 顶数 —— 命中的条目没设该字段
 *  时回落常量，而不是顺延到 profiles[0]。旧实现直接用 activeProfile（全局
 *  默认）的值画圆环、再用 profiles[0] 回落：钉了别的模型的会话刻度生来就
 *  错，且设置里改默认模型的上下文长度会当场穿透到这些会话的刻度上
 *  （2026-10-18 用户报告「正在用 A，改了默认 B 的参数，错乱」）。 */
export function resolveContextWindow(
  profiles: Array<{ id: string; contextLength?: number }>,
  effectiveProfileId: string | undefined,
  activeProfileId: string | undefined,
): number {
  const resolved = (effectiveProfileId ? profiles.find((p) => p.id === effectiveProfileId) : undefined)
    ?? (activeProfileId ? profiles.find((p) => p.id === activeProfileId) : undefined)
    ?? profiles[0]
  return resolved?.contextLength || 128_000
}

// ── 溢出重瞄准的会话窗口（2026-10-24 harness review B8）──
// 服务商用带数字的 400 拒绝纠正了 profile 的窗口后，引擎把重瞄准值随
// retrying 状态捎过来（types/agent.ts → statusSnapshotOf → mirror 全链透传）。
// 状态本身是瞬态的，这里按会话钉住最近一次收到的值，供圆环分母取
// min(profile 解析值, 会话实报值)。放 zustand 而非组件内 ref/state：
// 渲染期要读它算分母（react-hooks/refs 禁止渲染期读 ref），而它由 effect
// 观察 agentStatus 写入（lint 同样禁止 effect 内同步 setState）——外部
// store 两边都合法，与 pendingProfileStore 同款。
import { create } from 'zustand'

interface SessionContextWindowState {
  /** 最近一次溢出重瞄准：{ conv, window }；null = 本进程还没见过。 */
  pinned: { conv: string | null | undefined; window: number } | null
  pin: (conv: string | null | undefined, window: number) => void
}

export const useSessionContextWindowStore = create<SessionContextWindowState>((set) => ({
  pinned: null,
  pin: (conv, window) => set({ pinned: { conv, window } }),
}))
