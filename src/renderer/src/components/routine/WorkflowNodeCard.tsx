// 工作流画布的自定义节点（React Flow v12）。
// 简化模型（user 2026-11-08 三期裁定）：画布只有三类节点——开始 / 结束 /
// 空白任务，终态 FAILED/RETRY 芯片不画。
// - WorkflowStageCard：任务节点——标题 + prompt 摘要 + 结果状态出口；入口
//   不再有徽标（user 2026-11-09「去掉节点的【入口】标记」：开始芯片本身已经
//   指到它了），编辑按钮**悬停时才在卡片内右上角出现**（同日「点击该按钮才
//   出现编辑悬浮框」），紧挨着它还有一颗删除钮（同日「在悬停出现的编辑旁，
//   再增加删除按钮」）——两颗钮都不进卡片 DOM 流，绝对定位在右上角内；入口
//   是上/左/右三个线头（in-top/in-left/in-right），落点由画布按几何选边。
//   出口 = **每个结果状态一个**（user 2026-11-09「让用户自定义成功、失败等
//   结果状态，因为这会涉及到流程调度」）：verdicts 有几项，下缘就并排几个
//   source 线头，id = `out:<verdict>`；多状态时卡片底部还画一行状态名，让
//   人知道哪根线是哪个状态。
// - WorkflowTerminalCard：开始（source 端口，连线到任务 = 改写 entry）/
//   结束（DONE，target 端口）芯片；不可拖不可删。

import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons'
import type { WorkflowNode } from '../../../../shared/workflow/types'

export const STAGE_NODE_TYPE = 'workflowStage'
export const TERMINAL_NODE_TYPE = 'workflowTerminal'

/** 任务卡三个入线头的 id（画布 buildFlowEdges 的 targetHandle 只认这三个值）。 */
export const STAGE_INPUT_HANDLE_IDS = ['in-top', 'in-left', 'in-right'] as const
export type StageInputHandleId = (typeof STAGE_INPUT_HANDLE_IDS)[number]

/** 出口线头 id 前缀：一个结果状态一个出口，`out:<verdict>`。verdict 的字符
 *  集由 validate 的 VERDICT_RE 收窄（不含空白/竖线/引号/花括号），所以前缀
 *  拼接既能当 DOM 的 data-handleid，也能被 onConnect 原样解出调度键。 */
export const STAGE_OUT_HANDLE_PREFIX = 'out:'
export const stageOutHandleId = (verdict: string): string => `${STAGE_OUT_HANDLE_PREFIX}${verdict}`
export const verdictOfOutHandle = (handleId: string | null | undefined): string | null =>
  handleId && handleId.startsWith(STAGE_OUT_HANDLE_PREFIX) ? handleId.slice(STAGE_OUT_HANDLE_PREFIX.length) : null

export type WorkflowTerminalKind = 'START' | 'DONE'

export interface WorkflowStageNodeData extends Record<string, unknown> {
  node: WorkflowNode
  /** 编辑按钮的落点：胶囊把 id 交回画布，面板由画布开（user 2026-11-09：
   *  点节点本体不再开面板，只有这颗钮能开）。 */
  onEdit: (id: string) => void
  editLabel: string
  /** 删除按钮的落点：画布负责二次确认（会连带删掉该节点的所有连线）。 */
  onDelete: (id: string) => void
  deleteLabel: string
}

export interface WorkflowTerminalNodeData extends Record<string, unknown> {
  kind: WorkflowTerminalKind
  label: string
}

export type WorkflowStageFlowNode = Node<WorkflowStageNodeData, typeof STAGE_NODE_TYPE>
export type WorkflowTerminalFlowNode = Node<WorkflowTerminalNodeData, typeof TERMINAL_NODE_TYPE>

export function WorkflowStageCard({ data }: NodeProps<WorkflowStageFlowNode>): React.ReactElement {
  const { node, onEdit, editLabel, onDelete, deleteLabel } = data
  const verdicts = node.verdicts.length > 0 ? node.verdicts : ['pass']
  const multi = verdicts.length > 1
  return (
    <div className={multi ? 'wf-stage-card has-verdicts' : 'wf-stage-card'}>
      {/* 三个入线头各带唯一 id：React Flow 的 handle 身份是 (nodeId, type, id)，
          同节点挂三个不带 id 的 target Handle 会被当成同一个、落点判不出来。 */}
      <Handle id="in-top" type="target" position={Position.Top} className="wf-handle-target" />
      <Handle id="in-left" type="target" position={Position.Left} className="wf-handle-target" />
      <Handle id="in-right" type="target" position={Position.Right} className="wf-handle-target" />
      {/* 悬停才露的编辑钮：nodrag/nopan 是 React Flow 的拖拽/平移豁免类（少了
          它们，按下这颗钮会被当成拖节点），stopPropagation 挡住画布的选中。 */}
      <button
        type="button"
        className="wf-node-edit nodrag nopan"
        data-workflow-node-edit
        aria-label={editLabel}
        title={editLabel}
        onClick={(e) => {
          e.stopPropagation()
          onEdit(node.id)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <EditOutlined />
      </button>
      {/* 删除钮紧挨编辑钮（在其左侧 4px）：同一组悬停显形规则、同样 nodrag/nopan
          与 stopPropagation。二次确认归画布（`onDelete` 里先弹 confirm）——这里
          只管把 id 交回去，节点被删时它自己所在的卡片也会随之消失。 */}
      <button
        type="button"
        className="wf-node-delete nodrag nopan"
        data-workflow-node-delete
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={(e) => {
          e.stopPropagation()
          onDelete(node.id)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DeleteOutlined />
      </button>
      <div className="wf-stage-head">
        <span className="wf-stage-title">{node.title || node.id}</span>
      </div>
      <div className="wf-stage-prompt">{node.prompt}</div>
      {multi && (
        <div className="wf-stage-verdicts">
          {verdicts.map((v, i) => {
            // 悬停看定义（user 2026-11-09「定义结果状态时还需要明确状态定义」）：
            // 卡面只放得下状态名，那句「什么时候报这个状态」是面板里的长文本。
            const def = (node.verdictDefs?.[v] ?? '').trim()
            return (
              <span
                key={v}
                className="wf-stage-verdict"
                title={def ? `${v}：${def}` : v}
                // 与下面的出口 Handle 用**同一个 (i+0.5)/n 百分比**（同一个包含块），
                // 状态名才逐像素落在自己那根线头正上方；maxWidth 一条列宽，长名字
                // 走省略号、相邻两条恰好不重叠。
                style={{ left: `${((i + 0.5) / verdicts.length) * 100}%`, maxWidth: `${100 / verdicts.length}%` }}
              >
                {v}
              </span>
            )
          })}
        </div>
      )}
      {/* 出口按状态分叉：多状态时每个线头落在自己那一列的中央（与上面状态名
          对齐），单状态仍是一个居中的底线头。 */}
      {verdicts.map((v, i) => (
        <Handle
          key={v}
          id={stageOutHandleId(v)}
          type="source"
          position={Position.Bottom}
          className="wf-handle-source"
          style={multi ? { left: `${((i + 0.5) / verdicts.length) * 100}%` } : undefined}
        />
      ))}
    </div>
  )
}

const TERMINAL_CLASS: Record<string, string> = {
  START: 'wf-terminal start',
  DONE: 'wf-terminal done',
}

export function WorkflowTerminalCard({ data }: NodeProps<WorkflowTerminalFlowNode>): React.ReactElement {
  // 开始的流出线头在下缘、结束的流入线头在上缘（user 2026-11-08）——
  // 芯片可与任务卡同向连线：自上而下读图。
  // 结束的线头**必须可连**（user 2026-11-09「结束图标连线连不上」）：`type="target"`
  // 已经挡住了从芯片起拖，再给 Handle 加一个 isConnectable 关掉连通性，只会把唯一的
  // 落点判死——任务卡的流出口拖过来会被 React Flow 当非法连接静默丢弃，结束永远连不上。
  return (
    <div className={TERMINAL_CLASS[data.kind] ?? 'wf-terminal'}>
      {data.kind === 'START' ? (
        <Handle type="source" position={Position.Bottom} className="wf-handle-source" />
      ) : (
        <Handle type="target" position={Position.Top} className="wf-handle-target" />
      )}
      <span className="wf-terminal-label">{data.label}</span>
    </div>
  )
}

export const workflowNodeTypes = { [STAGE_NODE_TYPE]: WorkflowStageCard, [TERMINAL_NODE_TYPE]: WorkflowTerminalCard }
