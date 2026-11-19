// ── 结果状态的颜色（user 2026-11-18：编辑面板改成 7 色圆圈，线头/连线同步着色；
// user 2026-11-19 收进菜单；同日再裁定：**颜色不带任何语义定义**——绿≠成功、
// 红≠失败，菜单没有「自动」档，未选色默认蓝）──
// 颜色是纯渲染层属性：状态名仍是调度键（模型契约零改动），verdictKinds 与
// 颜色互不相干（语义只剩拓扑推导一条来路，见 run-view.ts 的 verdictKindOf）。
// 落盘形态是状态名 → 调色板下标（0–6），下标在渲染侧才解析成 --pm-verdict-<n>
// （light/dark 两套值在 theme/palette.ts，组件里不写死 hex）。

import type { WorkflowNode } from './types'

export const VERDICT_PALETTE_SIZE = 7

/** 一个状态最终落在哪个调色板下标：显式选色优先（越界 clamp 进 0–6，读面
 *  宽容：手改 JSON 的垃圾值不该让画布抛错），未选色 = 蓝 0（线头的旧观感，
 *  存量定义零迁移）。 */
export function resolveVerdictColorIndex(node: Pick<WorkflowNode, 'verdictColors'>, verdict: string): number {
  const explicit = node.verdictColors?.[verdict]
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.min(VERDICT_PALETTE_SIZE - 1, Math.max(0, Math.round(explicit)))
  }
  return 0
}

/** 下标 → CSS 变量名（palette.ts 的 light/dark 两表各七个）。 */
export const verdictColorVar = (index: number): string => `var(--pm-verdict-${index})`
