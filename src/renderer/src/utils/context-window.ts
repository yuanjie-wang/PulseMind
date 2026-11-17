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
  return resolveProfileEntry(profiles, effectiveProfileId, activeProfileId)?.contextLength || 128_000
}

/** 上面那条解析链的**唯一实现**：窗口与输出预留必须命中同一个条目。
 *  拆开写两份就会漂移 —— 会话钉在 A、A 没设 maxTokens 时，用 B 的预留去
 *  算 A 的预算，正是这个文件开头记的那类错（2026-10-18）。 */
function resolveProfileEntry<T extends { id: string }>(
  profiles: T[],
  effectiveProfileId: string | undefined,
  activeProfileId: string | undefined,
): T | undefined {
  return (effectiveProfileId ? profiles.find((p) => p.id === effectiveProfileId) : undefined)
    ?? (activeProfileId ? profiles.find((p) => p.id === activeProfileId) : undefined)
    ?? profiles[0]
}

/** 命中模型的输出预留（max_tokens），镜像主进程 `profile.maxTokens ?? 32_768`
 *  （session-manager.ts 的 options 装配处）。圆环的「输入预算」刻度线要用它
 *  反推 provider 真正留给输入的窗口 —— 没有这个值，刻度只能按默认 32K 画。
 *  用 `??` 而不是 `||`，与主进程同型：0 是显式值，不该被当成缺省吞掉。 */
export function resolveMaxTokens(
  profiles: Array<{ id: string; maxTokens?: number }>,
  effectiveProfileId: string | undefined,
  activeProfileId: string | undefined,
): number | undefined {
  return resolveProfileEntry(profiles, effectiveProfileId, activeProfileId)?.maxTokens
}

// ── 溢出重瞄准的会话窗口（2026-10-24 harness review B8）──
// 服务商用带数字的 400 拒绝纠正了 profile 的窗口后，引擎把重瞄准值随
// retrying 状态捎过来（types/agent.ts → statusSnapshotOf → mirror 全链透传）。
// 状态本身是瞬态的，这里按「会话 × 模型」钉住最近一次收到的值，供圆环分母
// 取 min(profile 解析值, 会话实报值)。放 zustand 而非组件内 ref/state：
// 渲染期要读它算分母（react-hooks/refs 禁止渲染期读 ref），而它由 effect
// 观察 agentStatus 写入（lint 同样禁止 effect 内同步 setState）——外部
// store 两边都合法，与 pendingProfileStore 同款。
//
// 键必须带 profileId（review_20261025 中1）：重瞄准属于「产生它的那个模型」
// ——引擎侧换 profile 即丢弃（AgentEngine.updateOptions 的 profileId 分支），
// 渲染端键失配后分母自然回落 profile 解析值，与引擎两侧同型。但单靠键失配
// 拦不住 P1→P2→P1 的往返——回来时旧键重新命中，而引擎在两跳里早已各自丢弃
// 过重瞄准——所以换 profile 的消费点（App 的 changeProfile/resetProfile）
// 必须显式 clearConv。多会话各占一键，交替切换不再互相覆盖（旧单槽形态的
// 问题）。换会话不失效是刻意的：引擎的 reaim 本就随会话存续。
import { create } from 'zustand'

/** pin 键的唯一拼装点：convKey 与 profileId 都来自 app 内部 id，`::` 分隔
 *  足够；测试与 App 共用本函数，键格式漂移会在 read 侧立刻失配。 */
export const sessionWindowKeyOf = (convKey: string, profileId: string): string => `${convKey}::${profileId}`

interface SessionContextWindowState {
  /** 溢出重瞄准：`${convKey}::${profileId}` → 重瞄准后的窗口。 */
  pinned: Record<string, number>
  pin: (convKey: string, profileId: string, window: number) => void
  /** 清掉该会话名下的全部 pin（换 profile 时调用——往返切换的旧键失配
   *  拦不住，见上）。其他会话的 pin 不动。 */
  clearConv: (convKey: string) => void
}

export const useSessionContextWindowStore = create<SessionContextWindowState>((set) => ({
  pinned: {},
  pin: (convKey, profileId, window) => set((s) => ({ pinned: { ...s.pinned, [sessionWindowKeyOf(convKey, profileId)]: window } })),
  clearConv: (convKey) =>
    set((s) => {
      const prefix = `${convKey}::`
      const next: Record<string, number> = {}
      for (const key of Object.keys(s.pinned)) {
        if (!key.startsWith(prefix)) next[key] = s.pinned[key]
      }
      return { pinned: next }
    }),
}))
