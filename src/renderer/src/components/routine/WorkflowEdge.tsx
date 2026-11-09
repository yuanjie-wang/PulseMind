// ── 工作流连线（自定义边：吃 route.ts 算好的正交折线）──
// 画布上所有边都是这一种：路径不再由 React Flow 的 bezier/smoothstep 生成器
// 猜，而是 shared/workflow/route.ts 按「最短 + 不穿卡 + 横平竖直 + 不叠线」
// 算出来的 `path` 字符串（user 2026-11-09）。
//
// 承重细节：标签必须交回 BaseEdge 的 labelX/labelY（它内部就是 EdgeText 走
// EdgeLabelRenderer 的那条渲染路径），**不要**自己拿 EdgeLabelRenderer 摆一
// 个 div——BaseEdge 顺带画的 20px 透明命中条（react-flow__edge-interaction）
// 是「点连线选中」与探针 elementFromPoint 找边主的唯一依据，缺了就只有 1.5px
// 的线可以点。

import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react'

/** 自定义边的注册名（WorkflowCanvas 的 edgeTypes 与 buildFlowEdges 的 type 共用）。 */
export const WORKFLOW_EDGE_TYPE = 'workflowOrtho'

/** 边的 data：路由结果里画布要用的三个数（path 与标签锚点）。 */
export interface WorkflowEdgeData extends Record<string, unknown> {
  path: string
  labelX: number
  labelY: number
}

export type WorkflowFlowEdge = Edge<WorkflowEdgeData, typeof WORKFLOW_EDGE_TYPE>

/** 折线 + 标签。style / markerEnd / label 一组都来自边对象本身（画布按
 *  def 重建边时写进去的），这里只负责把 route 的几何接上去。
 *  data 缺席（这一帧的端点矩形还没测量到位，见 route.ts 的契约）时整条边不
 *  画：宁可空一帧，也不要画一条从卡片里穿过去的假线。 */
export function WorkflowEdge(props: EdgeProps<WorkflowFlowEdge>): React.ReactElement | null {
  const route = props.data
  if (!route?.path) return null
  return (
    <BaseEdge
      id={props.id}
      path={route.path}
      label={props.label}
      labelX={route.labelX}
      labelY={route.labelY}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
      style={props.style}
      markerStart={props.markerStart}
      markerEnd={props.markerEnd}
      interactionWidth={props.interactionWidth}
    />
  )
}

export const workflowEdgeTypes = { [WORKFLOW_EDGE_TYPE]: WorkflowEdge }
