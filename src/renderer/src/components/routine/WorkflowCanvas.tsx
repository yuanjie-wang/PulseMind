// ── 工作流画布（可嵌入组件，P3 任务中心拆分）──
// 画布体：React Flow + 属性面板（左侧工具箱已撤，添加/整理走画布左缘的
// 图标悬浮窗 WorkflowCanvasDock）。def 的所有权在向导
// （TaskWizardPage）：画布只收 def + mutate（写回调，dirty 由向导记账）。
// 三类节点模型 / 循环边视觉 / normalize+autoWorkflowLayout 全部原地保留；
// 顶栏/保存/运行设置各段已上收到向导步骤。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as AntdApp, Button, Collapse, Dropdown, Input, Modal, Switch } from 'antd'
import type { MenuProps } from 'antd'
import { DeleteOutlined, DownOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from '../../i18n/useTranslation'
import { useThemeMode } from '../../theme/mode'
import { autoWorkflowLayout, isLoopEdge, loopEdgeKeys } from '../../../../shared/workflow/layout'
import { routeEdges, type RouteEdgeSpec, type RouteRect, type RouteResult, type RouteSide } from '../../../../shared/workflow/route'
import { STAGE_PLACEHOLDER_GROUPS, type RenderVars } from '../../../../shared/workflow/render'
import { composeStagePrompt, type EnvelopeContext, type EnvelopeUpstream } from '../../../../shared/workflow/envelope'
import { resolveWorkflowHandoff } from '../../../../shared/workflow/handoff'
import { runNodeStates, runTakenEdges, runVisitCounts } from '../../../../shared/workflow/run-view'
import { VERDICT_PALETTE_SIZE, resolveVerdictColorIndex, verdictColorVar } from '../../../../shared/workflow/verdict-colors'
import { WORKFLOW_RESERVED_TARGETS, type WorkflowDefinition, type WorkflowNode, type PipelineStageRun } from '../../../../shared/workflow/types'
import {
  workflowNodeTypes,
  STAGE_NODE_TYPE,
  TERMINAL_NODE_TYPE,
  stageOutHandleId,
  verdictOfOutHandle,
  type WorkflowStageFlowNode,
  type WorkflowTerminalFlowNode,
  type WorkflowStageNodeData,
  type WorkflowTerminalNodeData,
} from './WorkflowNodeCard'
import { WORKFLOW_EDGE_TYPE, workflowEdgeTypes, type WorkflowEdgeData, type WorkflowFlowEdge } from './WorkflowEdge'
import { WorkflowCanvasDock } from './WorkflowCanvasDock'
import { InsertVariableSelect, insertTokenAtCaret, type InsertVariableGroup } from './insert-variable'

type FlowNode = WorkflowStageFlowNode | WorkflowTerminalFlowNode
type FlowEdge = WorkflowFlowEdge

const stageNodeId = (id: string): string => `node:${id}`
const terminalNodeId = (kind: string): string => `terminal:${kind}`
/** 编辑态（runView 缺席）的次数表占位：全部节点 0 次 → 无徽标、不吃 idle 类的分支也不必判 undefined。 */
const EMPTY_VISIT_COUNTS: Map<string, number> = new Map()
const edgeIdOf = (e: { from: string; when: string; to: string }): string => `edge:${e.from}|${e.when}|${e.to}`

const parseEdgeId = (id: string): { from: string; when: string; to: string } | null => {
  const m = /^edge:(.+)\|(.+)\|(.+)$/.exec(id)
  return m ? { from: m[1], when: m[2], to: m[3] } : null
}

const stripStage = (flowId: string): string | null => (flowId.startsWith('node:') ? flowId.slice('node:'.length) : null)

/** 状态名是 verdictDefs / verdictKinds 两张表的键：改名时值要跟着搬（改名的
 *  唯一级联点），否则那句说明/那个语义会变成孤儿键、保存时被 simplify 裁掉。
 *  名字被清空的中间态先原样挂到空键上（不要丢），归一在保存侧做。 */
const moveRecordKey = <T,>(table: Record<string, T>, prev: string, next: string): Record<string, T> => {
  const out = { ...table }
  const value = out[prev]
  delete out[prev]
  if (value !== undefined) out[next] = value
  return out
}

/** i18n 键尾：占位符键/分组名首字母大写（prevSummary → PrevSummary）。 */
const capFirst = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`

/** 侧向判定门槛：横向差压过纵向差 1.2 倍才走左右入线，否则走顶入——同一列
 *  上下游排布的两卡（垂直布局的主线）不该被画成从侧面横插一脚。 */
const SIDE_RATIO = 1.2

/** 任务卡宽 / 终态芯片宽（px）：垂直布局里芯片要正压在入口卡与最深层的
 *  中轴线上，连线才是竖的，所以这里需要两者的宽度差（芯片半宽 + 卡片半宽的
 *  差）。数值与 CANVAS_STYLES 同源——那里直接插值这两颗常量，改一处即可。 */
const STAGE_CARD_W = 240
const TERMINAL_CHIP_W = 104
const CHIP_INSET_X = (STAGE_CARD_W - TERMINAL_CHIP_W) / 2

/** **外框**宽度：上面两颗是 CSS 里的内容盒宽度，节点盒还要吃 padding（任务卡
 *  的 12×2、芯片的 18×2）与 1px 边框——实测 266 / 142，与 `flowRectOf` 拿到
 *  的 RF `measured` 逐像素一致。选边要判「两卡横向是否重叠」，拿内容盒去判会
 *  把 26px 的重叠当成有缝：目标卡的侧端口连它的 stub 落点一起被邻居卡埋住，
 *  A* 只能无解 → 兜底折线从两张卡里穿过去（2026-11-09 探针 §8 实锤：卡宽
 *  266、夹具把两卡摆成重叠 6px，端口落点落在邻居卡内部）。 */
const STAGE_CARD_BOX_W = 266
const TERMINAL_CHIP_BOX_W = 142

/** 终态芯片位置：用户拖过（terminalLayout）就照用，否则派生——开始在入口
 *  卡**上方**、结束在最深一层**下方**（user 2026-11-09「工作流默认用垂直布局」：
 *  出口恒在卡的下缘、入口在上/左/右，芯片得顺着这条主线落位；横向分层的
 *  「左起右终」会让每条边从下缘绕回顶部）。buildFlowNodes 与入线选边共用一份。 */
function terminalPositions(def: WorkflowDefinition): { start: { x: number; y: number }; done: { x: number; y: number } } {
  const laid = def.nodes.filter((n) => n.layout != null)
  const ys = laid.map((n) => n.layout!.y)
  const maxY = ys.length > 0 ? Math.max(...ys) : 0
  const minY = ys.length > 0 ? Math.min(...ys) : 0
  // DONE 的 x 锚 = 最深一层的左端（线性链里就是最后一环本身）。
  const deepest = laid.filter((n) => n.layout!.y === maxY).map((n) => n.layout!.x)
  const doneX = deepest.length > 0 ? Math.min(...deepest) : 0
  const entryNode = def.nodes.find((n) => n.id === def.entry)
  return {
    // 垂直留白 90 / 140 与水平布局的 260 / 380 同量级：连线要有可见长度。
    start: def.terminalLayout?.start ?? { x: (entryNode?.layout?.x ?? 0) + CHIP_INSET_X, y: minY - 90 },
    done: def.terminalLayout?.done ?? { x: doneX + CHIP_INSET_X, y: maxY + 140 },
  }
}

/** 画布节点左上角坐标（任务卡 layout、终态芯片 terminalLayout/派生）。 */
function nodeOriginOf(def: WorkflowDefinition, id: string): { x: number; y: number } | null {
  if (id === 'START') return terminalPositions(def).start
  if (id === 'DONE') return terminalPositions(def).done
  return def.nodes.find((n) => n.id === id)?.layout ?? null
}

/** 节点盒横向占位（起点/终点哪个种类用哪个宽度）。 */
function boxWidthOf(id: string): number {
  return id === 'START' || id === 'DONE' ? TERMINAL_CHIP_BOX_W : STAGE_CARD_BOX_W
}

/** 入线落点（user 2026-11-09：普通节点的入线头在上/左/右三边，可接多条入边）：
 *  按两卡的几何中心选边——目标在右 → 从左侧进（in-left），在左 → 从右侧进
 *  （in-right），上下占优 → 从顶进（in-top）。起点/目标没落位（新建未布局）
 *  回落 in-top。DONE 芯片不参与（它只有一个顶入线头）。
 *
 *  **两卡横向重叠时一律 in-top**：左右入口的端口落在侧边中点、先要沿法线外推
 *  一个 stub，横向重叠意味着这两点都在对方卡的覆盖范围里，侧向入口根本没有
 *  路可走。宁可走顶入绕一圈（路由会绕过整张卡），也不选一个物理上被埋住的
 *  端口——选错了 A* 就无解，兜底折线会从卡里穿过去。 */
export function inputSideOf(def: WorkflowDefinition, fromId: string, toId: string): 'in-top' | 'in-left' | 'in-right' {
  const from = nodeOriginOf(def, fromId)
  const to = nodeOriginOf(def, toId)
  if (!from || !to) return 'in-top'
  if (from.x < to.x + boxWidthOf(toId) && to.x < from.x + boxWidthOf(fromId)) return 'in-top'
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) > Math.abs(dy) * SIDE_RATIO) return dx > 0 ? 'in-left' : 'in-right'
  return 'in-top'
}

/** 备选入口边（user 2026-11-09：「从左侧走路径短，但是会形成交叉，此时可以从
 *  右侧绕行」）：主侧之外还能试的两侧，**只在主侧真的撞上已路由线时**才被
 *  route.ts 采用（主侧干净 → 零额外搜索、结果与不给备选逐字节一致）。
 *
 *  横向重叠的卡对不给备选：左右端口都落在对方卡的覆盖里，换过去只是换一个
 *  同样被埋住的端口（与 inputSideOf 的判据同源）。顺序即并列时的偏好，也是
 *  结果确定性的来源（主侧是左右 → 对侧优先；主侧是顶 → 朝向源的侧边优先）。 */
export function altSidesOf(def: WorkflowDefinition, fromId: string, toId: string): Array<'in-top' | 'in-left' | 'in-right'> {
  const from = nodeOriginOf(def, fromId)
  const to = nodeOriginOf(def, toId)
  if (!from || !to) return []
  if (from.x < to.x + boxWidthOf(toId) && to.x < from.x + boxWidthOf(fromId)) return []
  const primary = inputSideOf(def, fromId, toId)
  // 主侧是左右之一 → 先试对侧（「从右侧绕行」就是这一支），再试顶入；
  // 主侧本就是顶入 → 先试朝向源的那一侧（离得近），再试另一侧。
  if (primary === 'in-left' || primary === 'in-right') return [primary === 'in-left' ? 'in-right' : 'in-left', 'in-top']
  const dx = to.x - from.x
  return dx > 0 ? ['in-left', 'in-right'] : ['in-right', 'in-left']
}

/** def → RF nodes。简化模型三类节点：任务卡 + 开始芯片（上）+ 结束芯片
 *  （下）。开始/结束常驻各一、不可拖不可删。
 *  任务卡不再有「入口」徽标（user 2026-11-09）——开始芯片的派生边已经指过去
 *  了；编辑/删除两个入口改成卡内右上角的悬停钮，回调由画布给（面板与二次确认
 *  都归画布，卡片只管把 id 交回去）。 */
function buildFlowNodes(
  def: WorkflowDefinition,
  t: (k: string, p?: Record<string, string | number>) => string,
  onEdit: (id: string) => void,
  onDelete: (id: string) => void,
  runView?: { status: 'running' | 'success' | 'failed'; stages: PipelineStageRun[] },
  /** 选中节点（user 2026-11-20 二刀「选中时变为蓝色边框」）：导航步与画布
   *  点选都落到它，只有它挂蓝色聚焦描边。 */
  highlightNodeId?: string,
  /** 选中的终态芯片（user 2026-11-20 三刀「开始和结束节点也设为灰色」）：
   *  芯片也在灰边族里，选中时同样亮蓝边（sel 的 start/done 两臂）。 */
  highlightTerminal?: 'start' | 'done',
): FlowNode[] {
  // 运行视图（user 2026-11-20 二刀裁定「所有节点都是灰色边框，选中时变蓝色；
  // 右上角不再展示执行状态——节点可能执行多次、每次结果不一样，改展示执行
  // 次数」）：卡面不再吃任何状态色/状态词（绿红蓝的单值状态对多次执行的
  // 节点是误导），唯一信息 = 执行次数徽标（没跑过的节点保持 idle 弱化）。
  // 成功/失败的辨读全部收敛到右栏详情（verdictKindOf 只活在面板）。
  const visitCounts = runView ? runVisitCounts(runView.stages) : EMPTY_VISIT_COUNTS
  // 未接线结果状态（user 2026-11-18：「没连出口线的状态，在画布上要能看见」）：
  // 引擎跑到这个状态时 outEdges 为空 → 整实例失败，但编辑器里那颗出口线头
  // 和别的线头长得一模一样，用户只有真跑一次才知道漏了。判定与运行视图
  // verdictKindOf 的「无出边 = 失败」同一条规则——画布与引擎必须说同一句话。
  const unwiredOf = (n: WorkflowNode): string[] => {
    const verdicts = n.verdicts && n.verdicts.length > 0 ? n.verdicts : ['pass']
    return verdicts.filter((v) => !def.edges.some((e) => e.from === n.id && e.when === v))
  }
  const stageNodes: FlowNode[] = def.nodes.map((n) => {
    const unwired = unwiredOf(n)
    return {
      id: stageNodeId(n.id),
      type: STAGE_NODE_TYPE,
      position: { x: n.layout?.x ?? 0, y: n.layout?.y ?? 0 },
      data: {
        node: n,
        onEdit,
        editLabel: t('workflow.canvasEditNode'),
        onDelete,
        deleteLabel: t('workflow.canvasDeleteNode'),
        ...(unwired.length > 0
          ? {
              unwired,
              unwiredHint: t('workflow.canvasUnwiredHint'),
              unwiredTitle: t('workflow.canvasUnwiredTitle', { states: unwired.join(' / ') }),
            }
          : {}),
        ...(runView
          ? {
              runMode: true,
              runCount: visitCounts.get(n.id) ?? 0,
              runCountLabel: (visitCounts.get(n.id) ?? 0) > 0 ? t('workflow.runBadgeCount', { count: visitCounts.get(n.id) ?? 0 }) : undefined,
              focused: n.id === highlightNodeId,
            }
          : {}),
      },
    }
  })
  // 终态芯片可拖动（user 2026-11-08）：落点持久在 def.terminalLayout，缺席
  // 时派生（开始在入口上方、结束在最深一层下方）——首次打开即有合理位置，
  // 拖过之后用户坐标赢。selectable 保持 false：芯片不吃 RF 的选中态（它的
  // 蓝边由运行视图的 focused 自己画，见 WorkflowTerminalCard）。
  // 运行视图芯片同灰（user 2026-11-20 三刀「开始和结束节点也设为灰色」）：
  // 实例终态色（wf-terminal--run-*）退役——画布上只剩一种节点外观，成败
  // 辨读在右栏；这里只多下发 selected（开始/结束各自的选中蓝边）。
  const terminals = terminalPositions(def)
  const terminalNodes: FlowNode[] = [
    {
      id: terminalNodeId('START'),
      type: TERMINAL_NODE_TYPE,
      position: terminals.start,
      selectable: false,
      data: { kind: 'START', label: t('workflow.canvasStart'), ...(runView ? { focused: highlightTerminal === 'start' } : {}) },
    },
    {
      id: terminalNodeId('DONE'),
      type: TERMINAL_NODE_TYPE,
      position: terminals.done,
      selectable: false,
      data: { kind: 'DONE', label: t('workflow.canvasEnd'), ...(runView ? { focused: highlightTerminal === 'done' } : {}) },
    },
  ]
  return [...stageNodes, ...terminalNodes]
}

/** 路由结果 → 边的 data（WorkflowEdge 只认这三个数）。 */
const edgeRouteData = (r: RouteResult | undefined): WorkflowEdgeData | undefined => (r ? { path: r.path, labelX: r.label.x, labelY: r.label.y } : undefined)

/** 入线头 id → 路由侧的边（端口落在矩形的哪一边）。 */
const portSideOfHandle = (handle: string | undefined): RouteSide => (handle === 'in-left' ? 'left' : handle === 'in-right' ? 'right' : 'top')

/** 路由侧 → 入线头 id（portSideOfHandle 的反向）。实际采用的入口可能来自
 *  `altSides`（绕行换侧）：`targetHandle` 必须跟着路由结果的 `toSide` 走，
 *  否则线的端点与它挂的线头不是同一个——视觉上线从卡侧面一个空处钻进去，
 *  拖拽命中面也错位。`side` 缺席（这一帧还没路由）才回落到几何主侧。 */
const handleOfSide = (side: RouteSide | undefined, fallback: string): string =>
  side === 'left' ? 'in-left' : side === 'right' ? 'in-right' : side === 'top' ? 'in-top' : fallback

/** 分支/循环的画布语言（user 2026-11-08 二期视觉 + 三期简化 + 2026-11-09
 *  多出口 + 自定义结果状态）：
 *  - 任务节点**每个结果状态一个出口线头**（`out:<verdict>`，下缘并排），出边
 *    的 sourceHandle 由 `when` 决定，同一状态也可以分叉多条；
 *  - 多状态节点的出边带状态名标签（单状态不标：一条线挂个 pass 只是噪音），
 *    回边（isLoopEdge：闭合成环的边，含自环）画成虚线并标「循环」；
 *  - 开始芯片到入口任务的边是派生面（entry 的可视化），不进 def.edges。
 *
 *  路径本身不在这里算：`data` 装的是 shared/workflow/route.ts 给出的折线与标签
 *  锚点（user 2026-11-09：最短 / 不穿卡 / 横平竖直 / 好看），由 WorkflowEdge
 *  渲染。端点矩形还没测量到位的边这一帧没有 data —— 那条边不画，也不退回到
 *  smoothstep 画一条穿卡的假线。 */
function buildFlowEdges(
  def: WorkflowDefinition,
  t: (k: string, p?: Record<string, string | number>) => string,
  routes: Map<string, RouteResult>,
  runView?: { status: 'running' | 'success' | 'failed'; stages: PipelineStageRun[] },
): FlowEdge[] {
  const loopKeys = loopEdgeKeys(def)
  // 运行视图：走过的边按结算状态的**语义**上色（success 绿 / failure 红 /
  // neutral 原色但全亮），没走过的弱化——「过程」在读图语言里就是哪些边亮了。
  // 用户裁定（2026-11-18「运行视图也跟状态色」）：运行视图的边不再按 pass/fail
  // 语义换色——颜色维度归状态类（wf-edge-verdict-N），运行类只控强度（走过
  // 全亮、没走弱化）；2026-11-20 二刀后节点卡也不吃状态色（一律灰边），
  // 成功/失败的辨读只剩右栏详情一处（verdictKindOf 只活在面板）。
  const taken = runView ? runTakenEdges(def.edges, runView.stages) : undefined
  const runClassOf = (id: string): string | undefined => {
    if (!taken) return undefined
    return taken.has(id) ? 'wf-edge-taken' : 'wf-edge-idle'
  }
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]))
  const nodeEdges: FlowEdge[] = def.edges.map((e) => {
    const id = edgeIdOf(e)
    const loop = isLoopEdge(loopKeys, e)
    // 状态词不再上边（user 2026-11-16「连接线进入节点的时候，不用展示状态
    // 类型，已经在出去的时候展示了」）：出口线头本来就按状态分列、卡面也画
    // 了状态名，边上的状态词是第二遍重复。只保留回边的「循环」标记。
    const labels = loop ? [t('workflow.edgeLoopSuffix')] : []
    return {
      id,
      source: stageNodeId(e.from),
      sourceHandle: stageOutHandleId(e.when),
      target: e.to === 'DONE' ? terminalNodeId('DONE') : stageNodeId(e.to),
      // 任务目标的落点由几何选边（上/左/右），DONE 只有一个顶入线头不设 id。
      // 路由换侧（altSides）时实际入口可能与几何主侧不同，以路由结果为准。
      targetHandle: e.to === 'DONE' ? undefined : handleOfSide(routes.get(id)?.toSide, inputSideOf(def, e.from, e.to)),
      type: WORKFLOW_EDGE_TYPE,
      data: edgeRouteData(routes.get(id)),
      // 连线颜色 = 起点状态所选的调色板色（user 2026-11-18「选择后需要同步
      // 改变画布中对应连接端点的颜色，以及连接线的颜色」）。状态色类落 edge
      // 的 <g>，颜色由 CANVAS_STYLES 的 --xy-edge-stroke 覆盖——七条
      // wf-edge-verdict-N 规则声明在 wf-edge-done/failed 之后（同特异性按声明
      // 序，状态色一律获胜；终态的语义绿红只留在芯片上）。选中态的蓝仍归 RF
      // 自己的 .selected 规则（特异性更高），不需要 !important。运行视图的
      // taken/idle 类缀在最后：只控强度，与颜色维度正交。
      className: [
        `wf-edge-verdict-${resolveVerdictColorIndex(nodeById.get(e.from) ?? {}, e.when)}`,
        e.to === 'DONE' ? 'wf-edge-done' : e.to === 'FAILED' ? 'wf-edge-failed' : undefined,
        runClassOf(id),
      ]
        .filter(Boolean)
        .join(' ') || undefined,
      label: labels.length > 0 ? labels.join(' · ') : undefined,
      // 线宽/颜色一律交给 CSS（CANVAS_STYLES 里的 --xy-edge-stroke-* 变量），
      // 这里只留虚线。内联 style 会落在 <path> 上、盖过样式表，写死 strokeWidth
      // 就等于让「选中变粗」永远失效。
      style: loop ? { strokeDasharray: '6 3' } : undefined,
      labelStyle: { fill: 'var(--pm-text-muted)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--pm-elevated)', fillOpacity: 0.9 },
      // 箭头颜色跟着线走：context-stroke 让 marker 取引用元素的 stroke，
      // 于是灰线配灰箭头、选中的蓝线配蓝箭头，不用为选中态再定义 marker。
      // RF 自己的 CSS 给箭头留了 var(--xy-edge-stroke) 兜底，万一支架不认
      // context-stroke 也只是回落成今天的灰色，不会隐形。
      markerEnd: { type: MarkerType.ArrowClosed, color: 'context-stroke' },
    }
  })
  const startEdge: FlowEdge = {
    id: 'start-entry',
    source: terminalNodeId('START'),
    target: stageNodeId(def.entry),
    targetHandle: handleOfSide(routes.get('start-entry')?.toSide, inputSideOf(def, 'START', def.entry)),
    type: WORKFLOW_EDGE_TYPE,
    data: edgeRouteData(routes.get('start-entry')),
    selectable: false,
    // 运行视图：入口启动过（有任何 stage 行）= 派生边亮起，否则弱化。
    className: runView ? (runNodeStates(runView.stages).has(def.entry) ? 'wf-edge-taken' : 'wf-edge-idle') : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'context-stroke' },
  }
  return [startEdge, ...nodeEdges]
}

/** def → 路由规格。端口位置必须与画布的线头逐像素同源，否则线会从卡片里
 *  钻出来：
 *  - 出口恒在卡下缘，`at` = 该结果状态在 verdicts 里的序号
 *    （`(i+0.5)/n` 与卡片 CSS 的 left:% 同一公式；单状态 = 0.5 居中）；
 *  - 入口按 inputSideOf 选边（in-top/in-left/in-right），线头都在所在边的
 *    中点，at 取默认 0.5；
 *  - DONE 芯片只有一个顶入线头。
 *  边 id 与 buildFlowEdges 同一套（含派生边 start-entry），路由结果按 id 取。 */
function routeSpecsOf(def: WorkflowDefinition): RouteEdgeSpec[] {
  const specs: RouteEdgeSpec[] = [
    {
      id: 'start-entry',
      from: { nodeId: terminalNodeId('START'), side: 'bottom' },
      to: { nodeId: stageNodeId(def.entry), side: portSideOfHandle(inputSideOf(def, 'START', def.entry)) },
    },
  ]
  for (const e of def.edges) {
    const verdicts = def.nodes.find((n) => n.id === e.from)?.verdicts ?? []
    const index = verdicts.indexOf(e.when)
    specs.push({
      id: edgeIdOf(e),
      from: {
        nodeId: stageNodeId(e.from),
        side: 'bottom',
        // 状态被删/改过名（连线是级联改的，正常不会走到这里）→ 线头位置未知，取中点。
        at: index >= 0 ? (index + 0.5) / verdicts.length : undefined,
      },
      to:
        e.to === 'DONE'
          ? { nodeId: terminalNodeId('DONE'), side: 'top' }
          : { nodeId: stageNodeId(e.to), side: portSideOfHandle(inputSideOf(def, e.from, e.to)) },
      // 主侧撞上已路由线时允许绕行换侧（「从右侧绕行」）。派生边 start-entry
      // 不给备选：芯片正压在入口卡上方，绕不到侧面去。
      altSides: e.to === 'DONE' ? undefined : altSidesOf(def, e.from, e.to).map(portSideOfHandle),
    })
  }
  return specs
}

/** 画布节点 → 路由用的矩形。位置用**活体**坐标（拖动中就是当帧的位置），
 *  尺寸用 RF 量出来的 measured；首帧还没量到就用卡片常量兜底（下一帧测量结果
 *  一回来就重算）。芯片与任务卡的兜底尺寸不同：宽度就是 CSS 里那两个常量，
 *  高度是常见值，只影响首帧。 */
const FALLBACK_STAGE_H = 82
const FALLBACK_CHIP_H = 40
function flowRectOf(node: FlowNode): RouteRect {
  const chip = node.type === TERMINAL_NODE_TYPE
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? (chip ? TERMINAL_CHIP_W : STAGE_CARD_W),
    height: node.measured?.height ?? (chip ? FALLBACK_CHIP_H : FALLBACK_STAGE_H),
  }
}

/** 新建工作流的空白底稿：单入口节点，名称留空（保存门会拦）。
 *  objective 字段保留（类型 / render 解析 / 运行级覆盖都不动），但向导不再
 *  提供编辑面（user 2026-11-09：「去掉【全局目标（可空）】栏位」）——运行级
 *  目标在启动表单里填。脚手架 prompt 是**示范写法**（PLAN-workflow-context）：
 *  只写本阶段任务 + 完成标准的占位，全局目标/上游交接由引擎的信封注入——
 *  它同时是任务助手每轮快照里的第一份样本，旧写法会教坏助手。 */
export function blankWorkflow(t: (k: string) => string): WorkflowDefinition {
  return {
    id: `flow-${Date.now()}`,
    name: '',
    description: '',
    objective: '',
    entry: 'step1',
    nodes: [{ id: 'step1', title: t('workflow.canvasNewNodeTitle'), prompt: t('workflow.canvasNewPrompt'), verdicts: ['pass'] }],
    edges: [],
  }
}

/** 自动节点 id：step1/step2… 避让既有节点与保留字。 */
function mintNodeId(def: WorkflowDefinition): string {
  let i = def.nodes.length + 1
  while (def.nodes.some((n) => n.id === `step${i}`) || (WORKFLOW_RESERVED_TARGETS as readonly string[]).includes(`step${i}`)) i += 1
  return `step${i}`
}

export interface WorkflowCanvasProps {
  def: WorkflowDefinition
  /** 画布写回调（向导传入；dirty 记账在向导）。第二个参数是合并键（2026-11-18）：
   *  同一个 key 在 700ms 内的连续改动合成一步撤销（逐字符输入不该留一串帧）。 */
  mutate: (fn: (d: WorkflowDefinition) => WorkflowDefinition, coalesceKey?: string) => void
  /** 撤销/重做（2026-11-18）：历史住在向导（它与助手的补丁共用一条栈），画布
   *  只负责快捷键与 dock 两颗钮。缺席 = 该画布没有历史（运行视图）。 */
  onUndo?: () => boolean
  onRedo?: () => boolean
  canUndo?: boolean
  canRedo?: boolean
  /** 运行视图（PLAN-workflow-run-view，user 2026-11-15「执行过程预览」）：在场
   *  = 画布切到**运行查看态**——节点按 stage 着色、走过的边高亮、编辑面全体
   *  退场（dock/悬停钮/键删/连线/属性面板）；缺席 = 定义编辑态，行为逐字节不变。 */
  runView?: { status: 'running' | 'success' | 'failed'; stages: PipelineStageRun[] }
  /** 运行查看态的节点点击（user 2026-11-17「点谁看谁」）：点任务节点看它的
   *  处理详情，点开始/结束芯片看初始要求/最终结果。编辑态不触发。 */
  onRunNodeClick?: (target: { kind: 'stage'; nodeId: string } | { kind: 'start' } | { kind: 'done' }) => void
  /** 运行查看态的**节点定位**（user 2026-11-20「右栏前进/后退顺着执行链路走」）：
   *  nonce 一变就把视口对到该节点（同节点连续导航也要再动）。编辑态不触发。 */
  runFocus?: { nodeId: string; nonce: number }
  /** 运行查看态的**选中节点**（user 2026-11-20 二刀「选中时变为蓝色边框」）：
   *  导航步与画布点选都落到它——只有它挂蓝色聚焦描边；定位（视口移动）归
   *  runFocus，两者分离：点选不动视口（用户已经在看它）。 */
  runSelectedNodeId?: string
  /** 运行查看态的**选中芯片**（user 2026-11-20 三刀）：开始/结束芯片与任务卡
   *  同一灰边族，点选它们（sel 的 start/done 两臂）同样亮蓝边。 */
  runSelectedTerminal?: 'start' | 'done'
}

const CanvasBody: React.FC<WorkflowCanvasProps> = ({ def, mutate, onUndo, onRedo, canUndo, canRedo, runView, onRunNodeClick, runFocus, runSelectedNodeId, runSelectedTerminal }) => {
  const runMode = runView !== undefined
  const { t } = useTranslation()
  const { modal } = AntdApp.useApp()
  const mode = useThemeMode()
  const { screenToFlowPosition, fitView: rfFitView } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([])
  /** 属性面板的**唯一**主体：被编辑的任务节点。连线不再开面板（user
   *  2026-11-09「点击连接线不要弹模态框」）——选中一条线只是选中，删它走
   *  Delete 键，见下面的 keydown。 */
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  /** 运行查看态的首屏取景（user 2026-11-17「进入页面后流程图未居中，另外可适当
   *  缩小，现在有点大」）。默认 fitView 的 padding 只有 0.1 且**没有放大上限**，
   *  少节点图会被放大到 ~1.3 倍并贴着边；这里统一口径：四周留 20%、最多 100%
   *  （只缩小不放大）。 */
  const runFitOptions = useMemo(() => ({ padding: 0.2, maxZoom: 1 }), [])
  /** 用户一旦自己平移/缩放过，就永不再自动取景——「只刷新内容，不要改变位置和
   *  比例」（2026-11-15 裁定）在容器 resize（拖分隔条）时同样成立。 */
  const userMovedViewport = useRef(false)
  const fitRunView = useCallback(() => {
    if (!runMode || userMovedViewport.current) return
    void rfFitView(runFitOptions)
  }, [runMode, rfFitView, runFitOptions])

  // 首屏取景。两个触发面缺一不可：
  // ① 节点测量完成——RF 挂载时的 fitView 可能早于这一帧，量到的包围盒是空的；
  // ② 容器尺寸变化——运行页的面板宽度是 mount 后才按 60% 落位的，画布先窄后
  //    宽，RF 那次一次性 fitView 量到的是旧尺寸，图于是偏在一角。resize 防抖
  //    250ms 再取景（拖分隔条的每一帧不重算）。
  // 用户自己平移/缩放过之后两条都跳过（见 userMovedViewport）。
  const nodesMeasured = nodes.length > 0 && nodes.every((n) => !!n.measured?.width)
  useEffect(() => {
    if (!runMode || !nodesMeasured) return
    const raf = requestAnimationFrame(fitRunView)
    return () => cancelAnimationFrame(raf)
  }, [runMode, nodesMeasured, fitRunView])
  useEffect(() => {
    if (!runMode) return
    const el = wrapperRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(fitRunView, 250)
    })
    ro.observe(el)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [runMode, fitRunView])

  // ── 节点定位（user 2026-11-20「右栏前进/后退顺着执行链路走」）──
  // nonce 是唯一触发源（同节点连续导航也要再动），nodes 在 deps 里只为等
  // 目标节点的测量落地——首帧导航时 RF 还没量出尺寸，fitView(nodes) 会空转；
  // appliedFocusNonce 记账保证同一 nonce 只拍一次，轮询重建 nodes 不会把视口
  // 反复拽回。聚焦是显式用户动作，赢过自动取景：落定后标记视口已被接管，
  // resize 的全图 fitView 不再把视口拽回去。节点不在画布上（定义运行后被改）
  // 就静默跳过。
  const appliedFocusNonce = useRef(0)
  const runFocusNodeId = runFocus?.nodeId
  const runFocusNonce = runFocus?.nonce
  useEffect(() => {
    if (!runMode || !runFocusNonce || !runFocusNodeId) return
    if (runFocusNonce === appliedFocusNonce.current) return
    const id = stageNodeId(runFocusNodeId)
    const target = nodes.find((n) => n.id === id)
    if (!target?.measured?.width) return // 测量未落：nodes 下一拍重建时这里会再进来
    appliedFocusNonce.current = runFocusNonce
    userMovedViewport.current = true
    void rfFitView({ nodes: [{ id }], duration: 300, padding: 0.2, maxZoom: 1 })
  }, [runMode, runFocusNonce, runFocusNodeId, nodes, rfFitView])

  /** 卡片右上角编辑钮的回调（user 2026-11-09：点节点本体不再开面板，只有这颗
   *  钮能开）。setEditingNodeId 是稳定引用，给 buildFlowNodes 传下去不引起重排。 */
  const openNode = useCallback((id: string) => setEditingNodeId(id), [])

  /** 真删。悬停删除钮、属性面板脚注与 Delete 键共用这一处：删节点连带删它的
   *  所有连线（留着悬空的边会让 validate 拦死保存，而这条删除用户已确认/明确
   *  按键表达过），入口被删则回落第一个剩余节点（validate 会拦空图）。 */
  const deleteNode = useCallback(
    (id: string) => {
      mutate((d) => {
        const nodes = d.nodes.filter((n) => n.id !== id)
        const edges = d.edges.filter((e) => e.from !== id && e.to !== id)
        const entry = d.entry === id ? (nodes[0]?.id ?? d.entry) : d.entry
        return { ...d, nodes, edges, entry }
      })
      setEditingNodeId(null)
    },
    [mutate],
  )

  /** 带二次确认的删除入口：悬停钮与面板脚注都先走它（一颗钮直接把节点连同
   *  连线抹掉太廉价，而 entry 被删还会顺带改入口——二次确认是这两条后果的最小
   *  交代）。**Delete 键不走这里**：那是一次显式的键盘操作，再弹一个框等于把
   *  一次操作拆成两次，见下面的 keydown。 */
  const requestDeleteNode = useCallback(
    (id: string) => {
      const name = def.nodes.find((n) => n.id === id)?.title || id
      modal.confirm({
        title: t('workflow.canvasDeleteNodeConfirm', { name }),
        okButtonProps: { danger: true },
        onOk: () => deleteNode(id),
      })
    },
    [def, modal, t, deleteNode],
  )

  // ── 连线路径（user 2026-11-09：最短 / 不穿卡 / 横平竖直 / 好看）──
  // 规格来自 def（端口 = 线头），矩形来自**活体节点**（拖动中的当帧坐标 +
  // RF 量出来的尺寸）。所以拖动时线会跟着卡走，而不是原地等松手。
  const routeSpecs = useMemo(() => routeSpecsOf(def), [def])
  // 几何指纹：只有位置/尺寸变了才重算路由——选中态、回调绑定的变化与几何无关，
  // 却会让 nodes 数组换引用。
  const geometryKey = useMemo(
    () => nodes.map((n) => `${n.id}@${n.position.x},${n.position.y},${n.measured?.width ?? 0}x${n.measured?.height ?? 0}`).join('|'),
    [nodes],
  )
  const routes = useMemo(
    () =>
      routeEdges(nodes.map(flowRectOf), routeSpecs, {
        fast: dragging,
        // 运行视图不画端口圆点：末段不回缩，箭头尖直接落在节点边框上
        // （user 2026-11-16「箭头需要能够连接上节点边框」）。
        tailGap: runMode ? 0 : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometryKey 就是节点的几何指纹
    [geometryKey, routeSpecs, dragging, runMode],
  )

  // def → flow 的单向同步（节点）。selected 的壳由 RF 的 selected 标志驱动，
  // 重建时保留；measured 也要带过去——重建会丢掉 RF 量出来的尺寸，路由于是退回
  // 到兜底高度，敲一个字连线就闪一下。
  useEffect(() => {
    setNodes((prev) => {
      const selectedIds = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      const measured = new Map(prev.map((n) => [n.id, n.measured]))
      return buildFlowNodes(def, t, openNode, requestDeleteNode, runView, runSelectedNodeId, runSelectedTerminal).map((n) => {
        const sized = measured.has(n.id) ? { ...n, measured: measured.get(n.id) } : n
        return selectedIds.has(n.id) ? { ...sized, selected: true } : sized
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t 只在 def 重建时取用；定位归 runFocus 的 nonce effect 管
  }, [def, setNodes, openNode, requestDeleteNode, runView, runSelectedNodeId, runSelectedTerminal])

  // 线头 id 的指纹（节点 id + 结果状态名）。改名会换掉出口线头的 id
  // （`out:<verdict>`），而 RF 的 handleBounds **只在节点尺寸变化时重测**——Handle
  // 组件自己不调 updateNodeInternals。旧 bounds 里没有新 id，引用它的边在
  // getEdgePosition 里查不到线头，整条边从 DOM 上消失（2026-11-09 探针实测：
  // plan 的 done→成功 之后 plan 的那条出边不见了，节点与 def 都是对的）。所以
  // 指纹一变就强制重测一次；只看 id+verdicts，编辑指令不会触发（那是每键一次
  // 全量重测）。
  //
  // `runMode` 进指纹：运行态换的是节点卡的另一套 DOM（编辑钮退场、状态徽标、
  // 单列出口），同尺寸下 handleBounds 也可能与编辑态不同，切态后必须重测。
  //
  // `measuredHandlesKey` 初值是 **null 而不是当前指纹**（2026-11-17）：等于指纹
  // 时首挂载那个 effect 直接早退，于是挂载期一次重测都没有——RF 只在节点尺寸
  // 变化的提交里量线头，首帧量在 Handle 子元素落地之前就量出空 bounds 的话，
  // 之后没有任何东西再触发重测，**全部边永久不渲染**（用户「连接线又没了」
  // 的一次实锤形态：节点、def、路由全对，DOM 里一条 `.react-flow__edge` 都
  // 没有）。初值 null 让每次挂载（含运行视图挂载）都补一次 rAF 重测，代价是
  // 一次 rAF。
  const handlesKey = useMemo(
    () =>
      `${runMode ? 'run' : 'edit'}|` +
      def.nodes.map((n) => `${n.id}:${(n.verdicts ?? []).join(',')}`).join('|'),
    [def, runMode],
  )
  const handleNodeIds = useMemo(() => def.nodes.map((n) => stageNodeId(n.id)), [def])
  const updateNodeInternals = useUpdateNodeInternals()
  const measuredHandlesKey = useRef<string | null>(null)
  useEffect(() => {
    if (measuredHandlesKey.current === handlesKey) return
    // 等 setNodes 那次提交把新线头 id 写进 DOM 之后再测；同一帧测会量到旧 id。
    // 记账必须发生在 rAF **跑过之后**：StrictMode 的挂载是 run→cleanup→run，
    // 若在这里先写 ref，cleanup 取消掉第一次的 rAF 后第二次就早退了，挂载期
    // 那一次重测正好丢掉（dev 下用户看到的正是「连接线又没了」）。
    const raf = requestAnimationFrame(() => {
      measuredHandlesKey.current = handlesKey
      updateNodeInternals(handleNodeIds)
    })
    return () => cancelAnimationFrame(raf)
  }, [handlesKey, handleNodeIds, updateNodeInternals])

  // 边的同步挂在路由结果上（不在节点同步里）：尺寸/位置一变就重画，不必重建
  // 节点；首帧节点还没测量到（routes 为空）就跳过这一帧，别把边清空。
  useEffect(() => {
    if (routes.size === 0) return
    setEdges((prev) => {
      const selectedIds = new Set(prev.filter((e) => e.selected).map((e) => e.id))
      return buildFlowEdges(def, t, routes, runView).map((e) => (selectedIds.has(e.id) ? { ...e, selected: true } : e))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t 只在 def 重建时取用
  }, [def, routes, setEdges, runView])

  // ── 聚焦淡化（user 2026-11-09：「连接线交叉太多」）──
  // 选中节点 → 只看与它相连的线；选中连线 → 只看那一条（并把两个端点留下）。
  // 其余连线降到 15%，选边的场合连无关节点也压到一半，于是「这条线从哪来、
  // 到哪去」一眼可读。
  //
  // 放成**一条生成的样式**而不是烘进边对象：edges 的重建只在 [def, routes] 变
  // 时发生（那正是 selected 得以保留的机制），把淡化写进边对象就得为每次点选
  // 再跑一遍 buildFlowEdges；样式串天然跟着选中态走，且不碰几何与路由。
  // 选择器打在 RF 挂在节点/边 <g> 上的 data-id 上：边 id 含 `|`/`:`，在引号里
  // 安全，只有引号本身与反斜杠要转义。
  const focusDimCss = useMemo(() => {
    const selNodes = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
    const selEdges = new Set(edges.filter((e) => e.selected).map((e) => e.id))
    if (selNodes.size === 0 && selEdges.size === 0) return ''
    const keepEdges = new Set(selEdges)
    const focusNodes = new Set(selNodes)
    for (const e of edges) {
      if (selNodes.has(e.source) || selNodes.has(e.target)) keepEdges.add(e.id)
      if (selEdges.has(e.id)) {
        focusNodes.add(e.source)
        focusNodes.add(e.target)
      }
    }
    const notList = (ids: Set<string>): string =>
      ids.size === 0 ? '' : `:not(${[...ids].map((id) => `[data-id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join(', ')})`
    const rules = [`.react-flow__edge${notList(keepEdges)} { opacity: 0.15; }`]
    // 只选节点时不压暗别的节点：它们正是这条线的上下文；选线时才需要一个
    // 干净的背景去读两个端点。
    if (selEdges.size > 0) rules.push(`.react-flow__node${notList(focusNodes)} { opacity: 0.5; }`)
    return rules.join('\n')
  }, [nodes, edges])

  // ── 画布交互 ──
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.target) return
      // 开始芯片的连线 = 改写入口（entry 的画布表达，不进边表）。
      if (conn.source === terminalNodeId('START')) {
        const to = stripStage(conn.target)
        if (to) mutate((d) => ({ ...d, entry: to }))
        return
      }
      const from = conn.source ? stripStage(conn.source) : null
      if (!from) return
      const to = conn.target === terminalNodeId('DONE') ? 'DONE' : stripStage(conn.target)
      if (!to) return
      // 调度键 = 从哪个出口线头拖出来的（user 2026-11-09：结果状态决定流程
      // 走向）。线头 id 是 `out:<verdict>`；拖的是旧形态的无 id 出口则回落 pass
      // （单状态卡的线头本来就只有一个）。
      const when = verdictOfOutHandle(conn.sourceHandle) ?? 'pass'
      // 一条新线是**追加**，不再顶掉已有出边；只有完全同形的线
      // （from+when+to 三元组一致）才视作重复跳过。
      mutate((d) => (d.edges.some((e) => e.from === from && e.when === when && e.to === to) ? d : { ...d, edges: [...d.edges, { from, when, to }] }))
    },
    [mutate],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      setDragging(false)
      const pos = { x: Math.round(node.position.x), y: Math.round(node.position.y) }
      // 终态芯片：落点写 def.terminalLayout（随保存落盘）。
      if (node.id.startsWith('terminal:')) {
        const kind = node.id.slice('terminal:'.length) as 'START' | 'DONE'
        const cur = def.terminalLayout?.[kind === 'START' ? 'start' : 'done']
        // 原地松手不留撤销帧（2026-11-18）：坐标没动 = 这次拖拽什么都没发生。
        if (cur && cur.x === pos.x && cur.y === pos.y) return
        mutate((d) => ({ ...d, terminalLayout: { ...d.terminalLayout, [kind === 'START' ? 'start' : 'done']: pos } }))
        return
      }
      const id = stripStage(node.id)
      if (!id) return
      const cur = def.nodes.find((n) => n.id === id)?.layout
      if (cur && cur.x === pos.x && cur.y === pos.y) return
      mutate((d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id ? { ...n, layout: pos } : n)),
      }))
    },
    [mutate, def],
  )

  /** 加空白任务节点（落点 = 当前视口中心；探索拖动落点时再给它加参数）。 */
  const addNode = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect()
    const position = rect ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 3 }) : { x: 200, y: 200 }
    const id = mintNodeId(def)
    const node: WorkflowNode = {
      id,
      title: t('workflow.canvasNewNodeTitle'),
      prompt: t('workflow.canvasNewPrompt'),
      verdicts: ['pass'],
      layout: { x: Math.round(position.x), y: Math.round(position.y) },
    }
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }))
    // 加完就地开面板改名/写指令（既有行为，刻意不动）——注意面板是模态框，
    // 遮罩会挡住画布的后续动作，探针里每次加节点后都要先关它。
    setEditingNodeId(id)
  }, [def, mutate, screenToFlowPosition, t])

  const tidyLayout = useCallback(() => {
    mutate((d) => autoWorkflowLayout(d, { force: true }))
  }, [mutate])

  // ── 属性面板的节点编辑 ──
  const selectedNode = editingNodeId ? (def.nodes.find((n) => n.id === editingNodeId) ?? null) : null

  // 环节指令的「插入变量」（user 2026-11-09：与任务式对话同一套插入变量，
  // 不再用静态提示行罗列占位符）。ref 指向 antd TextArea 底下的原生 textarea，
  // caret 读写在 insert-variable.tsx（routine 侧同一份）。
  const promptAreaRef = useRef<React.ComponentRef<typeof Input.TextArea> | null>(null)

  const patchNode = useCallback(
    (id: string, patch: Partial<WorkflowNode>, coalesceKey?: string) => {
      mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), coalesceKey)
    },
    [mutate],
  )

  const insertPromptVar = useCallback(
    (key: string) => {
      if (!selectedNode) return
      insertTokenAtCaret(promptAreaRef, selectedNode.prompt, key, (next) =>
        patchNode(selectedNode.id, { prompt: next }, `wf:prompt:${selectedNode.id}`),
      )
    },
    [selectedNode, patchNode],
  )

  // ── 上下文 · 自动注入（PLAN-workflow-context）──
  // 信封默认全开（整个 context 字段缺席 = 全开，存量工作流零迁移）；面板里只
  // 放逃生舱（按节点关闭某个块）+「精确控制」插变量 + 预览，且默认收起——
  // 隐式上下文的主路径不该逼用户读它。三个开关全开时把字段剥回 undefined，
  // 落盘 JSON 与存量工作流同形。
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null)

  const patchContext = useCallback(
    (key: 'objective' | 'upstream' | 'inputs', value: boolean) => {
      if (!selectedNode) return
      const next = { ...(selectedNode.context ?? {}), [key]: value }
      if (next.objective !== false && next.upstream !== false && next.inputs !== false) {
        patchNode(selectedNode.id, { context: undefined })
      } else {
        patchNode(selectedNode.id, { context: next })
      }
    },
    [selectedNode, patchNode],
  )

  // 「预览完整提示词」：与主进程的 runStage 共用 composeStagePrompt（同一份
  // 拼装代码，预览不可能是假的）。预览没有 live run——用真实连线合成示例
  // 上游（verdict 取边自己的 when：「如果上游报这个状态就会走到这」）、输入
  // 取声明里的 default 值，并明确标注「示例」。
  const previewPrompt = useMemo(() => {
    if (!selectedNode) return ''
    const handoff = resolveWorkflowHandoff('（工作区）', 'run_preview')
    const idx = Math.max(0, def.nodes.findIndex((n) => n.id === selectedNode.id))
    const upstreams: EnvelopeUpstream[] = []
    const seenSrc = new Set<string>()
    for (const e of def.edges) {
      if (e.to !== selectedNode.id || seenSrc.has(e.from)) continue
      const src = def.nodes.find((n) => n.id === e.from)
      if (!src) continue
      seenSrc.add(e.from)
      upstreams.push({
        title: src.title || e.from,
        verdict: e.when,
        verdictDef: src.verdictDefs?.[e.when],
        handoffRel: handoff.relative(e.from),
      })
    }
    const vars: RenderVars = {
      workflowObjective: def.objective,
      visit: 1,
      workspace: '（工作区）',
      vars: Object.fromEntries((def.inputs ?? []).map((i) => [i.key, i.default ?? ''])),
    }
    const ctx: EnvelopeContext = {
      workflowName: def.name || '（未命名工作流）',
      stageIndex: idx + 1,
      stageTotal: def.nodes.length,
      inputs: def.inputs,
      upstreams: upstreams.length > 0 ? upstreams : undefined,
      handoff,
      envelopeCapChars: def.params?.envelopeCapChars,
    }
    return composeStagePrompt(selectedNode, vars, ctx)
  }, [selectedNode, def])

  const previewOpen = previewNodeId !== null && previewNodeId === selectedNode?.id

  // ── 结果状态（user 2026-11-09：「让用户自定义成功、失败等结果状态，因为这会
  //    涉及到流程调度」）──
  // 状态名 = 出边的 when（调度键），所以**改名字必须级联到连线**，否则线还指
  // 着旧状态、运行时就再也走不到。行的 key 用下标而不是状态值：以值为 key 时
  // 每敲一个字都会重挂输入框、光标每键跳回开头。
  const addVerdict = useCallback(() => {
    if (!selectedNode) return
    let i = selectedNode.verdicts.length + 1
    while (selectedNode.verdicts.includes(`state${i}`)) i += 1
    // 新状态的缺省色 = 节点里还没被占用的最小调色板下标（全占则 0）：七种
    // 颜色尽量摊开，别一加状态就全蓝（user 2026-11-18 颜色化）。
    const used = new Set(selectedNode.verdicts.map((v) => resolveVerdictColorIndex(selectedNode, v)))
    let color = 0
    while (used.has(color) && color < VERDICT_PALETTE_SIZE - 1) color += 1
    const colors = { ...(selectedNode.verdictColors ?? {}) }
    colors[`state${i}`] = color
    patchNode(selectedNode.id, { verdicts: [...selectedNode.verdicts, `state${i}`], verdictColors: colors })
  }, [selectedNode, patchNode])

  const renameVerdict = useCallback(
    (index: number, next: string) => {
      if (!selectedNode) return
      const prev = selectedNode.verdicts[index]
      if (prev === undefined || prev === next) return
      const nodeId = selectedNode.id
      const verdicts = selectedNode.verdicts.map((v, i) => (i === index ? next : v))
      // 定义/语义/颜色跟着名字搬家（三张表的键都是状态名）：只改词表不改它们
      // 的话，改个名字就会让那句说明/那个语义/那个颜色变成孤儿键、被 simplify
      // 在保存时裁掉。
      const defs = selectedNode.verdictDefs
      const movedDefs = defs && defs[prev] !== undefined ? moveRecordKey(defs, prev, next) : defs
      const kinds = selectedNode.verdictKinds
      const movedKinds = kinds && kinds[prev] !== undefined ? moveRecordKey(kinds, prev, next) : kinds
      const colors = selectedNode.verdictColors
      const movedColors = colors && colors[prev] !== undefined ? moveRecordKey(colors, prev, next) : colors
      mutate(
        (d) => ({
          ...d,
          nodes: d.nodes.map((n) => (n.id === nodeId ? { ...n, verdicts, verdictDefs: movedDefs, verdictKinds: movedKinds, verdictColors: movedColors } : n)),
          edges: d.edges.map((e) => (e.from === nodeId && e.when === prev ? { ...e, when: next } : e)),
        }),
        // 逐字符改名合成一步（状态名是键盘输入的最典型连打）。
        `wf:verdictName:${nodeId}:${index}`,
      )
    },
    [selectedNode, mutate],
  )

  /** 状态定义（user 2026-11-09）：写进节点的 `verdictDefs`，空串 = 删掉这条
   *  说明（不留空值，保存时也就不用先归一）。**编辑期不 trim**——`一般` 后面
   *  再敲一个字不该让中间态被改写，归一交给 simplify。 */
  const setVerdictDef = useCallback(
    (index: number, next: string) => {
      if (!selectedNode) return
      const name = selectedNode.verdicts[index]
      if (name === undefined) return
      const defs = { ...(selectedNode.verdictDefs ?? {}) }
      if (next.trim().length === 0) delete defs[name]
      else defs[name] = next
      patchNode(selectedNode.id, { verdictDefs: Object.keys(defs).length > 0 ? defs : undefined }, `wf:verdictDef:${selectedNode.id}:${name}`)
    },
    [selectedNode, patchNode],
  )

  /** 状态颜色（user 2026-11-19 再裁定：**颜色不带语义定义**——绿≠成功、红≠失败，
   *  菜单没有「自动」档，未选色默认蓝）：只写 `verdictColors`，与 verdictKinds
   *  互不相干（语义只剩拓扑推导一条来路，见 run-view.ts 的 verdictKindOf）。 */
  const setVerdictColor = useCallback(
    (index: number, color: number) => {
      if (!selectedNode) return
      const name = selectedNode.verdicts[index]
      if (name === undefined) return
      const colors = { ...(selectedNode.verdictColors ?? {}) }
      colors[name] = color
      patchNode(selectedNode.id, { verdictColors: colors }, `wf:verdictColor:${selectedNode.id}:${name}`)
    },
    [selectedNode, patchNode],
  )

  /** 颜色菜单（收进菜单、不平铺，user 2026-11-19）：7 色，无「自动」档、无
   *  语义后缀（user 2026-11-19「不要对颜色进行定义」）；默认选中蓝（显式色
   *  缺席 = resolve 回落 0）。 */
  const verdictColorMenu = (index: number, name: string): MenuProps => {
    const active = resolveVerdictColorIndex(selectedNode ?? {}, name)
    return {
      items: Array.from({ length: VERDICT_PALETTE_SIZE }, (_, c) => ({
        key: String(c),
        label: (
          <span className="wf-verdict-menu-item">
            <span className="wf-verdict-dot" style={{ background: verdictColorVar(c) }} />
            {t(`workflow.verdictColor${c}`)}
          </span>
        ),
      })),
      selectable: true,
      selectedKeys: [String(active)],
      onClick: ({ key }) => setVerdictColor(index, Number(key)),
    }
  }

  const removeVerdict = useCallback(
    (index: number) => {
      if (!selectedNode || selectedNode.verdicts.length <= 1) return
      const nodeId = selectedNode.id
      const verdict = selectedNode.verdicts[index]
      const drop = (d: WorkflowDefinition): WorkflowDefinition => ({
        ...d,
        nodes: d.nodes.map((n) => {
          if (n.id !== nodeId) return n
          const next: WorkflowNode = { ...n, verdicts: n.verdicts.filter((_, i) => i !== index) }
          // 状态没了，它的定义与语义也没有主语（simplify 本来也会在保存时裁掉，
          // 这里当场删干净，避免面板上残留一条无主的说明）。
          if (n.verdictDefs && verdict !== undefined) {
            const defs = { ...n.verdictDefs }
            delete defs[verdict]
            if (Object.keys(defs).length > 0) next.verdictDefs = defs
            else delete next.verdictDefs
          }
          if (n.verdictKinds && verdict !== undefined) {
            const kinds = { ...n.verdictKinds }
            delete kinds[verdict]
            if (Object.keys(kinds).length > 0) next.verdictKinds = kinds
            else delete next.verdictKinds
          }
          if (n.verdictColors && verdict !== undefined) {
            const colors = { ...n.verdictColors }
            delete colors[verdict]
            if (Object.keys(colors).length > 0) next.verdictColors = colors
            else delete next.verdictColors
          }
          return next
        }),
        // 该状态上的连线一并删：留着悬空的 when 会让 validate 拦死保存，而这条
        // 删除用户已明确确认过。
        edges: d.edges.filter((e) => !(e.from === nodeId && e.when === verdict)),
      })
      const wired = verdict !== undefined && def.edges.some((e) => e.from === nodeId && e.when === verdict)
      if (wired) {
        modal.confirm({
          title: t('workflow.canvasVerdictRemoveConfirm', { name: verdict, count: def.edges.filter((e) => e.from === nodeId && e.when === verdict).length }),
          okButtonProps: { danger: true },
          onOk: () => mutate(drop),
        })
        return
      }
      mutate(drop)
    },
    [selectedNode, def, mutate, modal, t],
  )

  // 变量菜单的分组：阶段变量/运行上下文/内置变量来自 shared 的单一真源
  // （STAGE_PLACEHOLDER_GROUPS，与 renderNodePrompt 的词汇表同源），末组是
  // 本工作流声明的输入变量（def.inputs，运行时由 vars 注入）。
  const promptVarGroups: InsertVariableGroup[] = [
    ...STAGE_PLACEHOLDER_GROUPS.map((g) => ({
      label: t(`workflow.varGroup${capFirst(g.group)}`),
      options: g.keys.map((k) => ({ value: k, label: `${t(`workflow.var${capFirst(k)}`)} {{${k}}}` })),
    })),
    {
      label: t('workflow.varGroupInput'),
      options: (def.inputs ?? []).filter((i) => i.key.trim()).map((i) => ({ value: i.key, label: `${i.label || i.key} {{${i.key}}}` })),
    },
  ]

  const deleteEdge = useCallback(
    (e: { from: string; when: string; to: string }) => {
      mutate((d) => ({ ...d, edges: d.edges.filter((x) => !(x.from === e.from && x.when === e.when && x.to === e.to)) }))
    },
    [mutate],
  )

  /** 选中态（键删的唯一依据）。RF 的 selected 标志写在我们自己的 nodes/edges
   *  状态里，所以这份快照必须是**最新一帧**的；而拖拽会让这两个数组每帧换引用，
   *  把监听器绑在它们身上等于每帧重绑一次——用 ref 读，监听器只装一次。 */
  const liveSelectionRef = useRef<{ nodeIds: string[]; edges: Array<{ from: string; when: string; to: string }> }>({
    nodeIds: [],
    edges: [],
  })
  useEffect(() => {
    liveSelectionRef.current = {
      // 终态芯片是 selectable:false（进不来），这里再按 id 前缀兜一道。
      nodeIds: nodes.filter((n) => n.selected && n.id.startsWith('node:')).map((n) => n.id.slice('node:'.length)),
      // start-entry 是派生边、selectable:false；parseEdgeId 对它是 null，滤掉。
      edges: edges
        .filter((e) => e.selected)
        .map((e) => parseEdgeId(e.id))
        .filter((e): e is { from: string; when: string; to: string } => e !== null),
    }
  }, [nodes, edges])

  /** 选中节点/连线后按 Delete（或 mac 的 delete 键，它发的是 Backspace）删除
   *  （user 2026-11-09：「选中线和节点，都可以通过delete键删除」）。
   *
   *  **不要**把 RF 自己的 `deleteKeyCode` 打开：RF 的删除直接改它内部的
   *  nodes/edges，而 def 是唯一真源（所有权在向导）——两边一岔，保存出去的就是
   *  另一张图。所以键删走 def 的写回调，与悬停删除钮同一条路。
   *
   *  同一个监听器还收撤销/重做（2026-11-18，⌘Z / ⇧⌘Z / Ctrl+Y）：历史在向导
   *  手里（与助手补丁共用一条栈），画布只把按键转过去。门与删除同款：焦点在
   *  输入框里时 ⌘Z 归浏览器（文本框自己的撤销栈）、有可见 antd 模态框时不动
   *  画布。 */
  useEffect(() => {
    if (runMode) return // 运行查看态没有「删」也没有「撤销」（定义是死的）
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const inField = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const modalOpen = (): boolean => [...document.querySelectorAll('.ant-modal-wrap')].some((w) => getComputedStyle(w).display !== 'none')

      // 撤销/重做
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.isComposing) {
        const key = e.key.toLowerCase()
        const isUndo = key === 'z' && !e.shiftKey
        const isRedo = (key === 'z' && e.shiftKey) || key === 'y'
        if (!isUndo && !isRedo) return
        if (inField || modalOpen()) return
        const done = isUndo ? onUndo?.() : onRedo?.()
        if (done) e.preventDefault()
        return
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (inField) return
      if (modalOpen()) return
      const sel = liveSelectionRef.current
      if (sel.nodeIds.length === 0 && sel.edges.length === 0) return
      e.preventDefault()
      // 节点先删（连带它的连线），剩下的边再删——mutate 以 defRef 为基准
      // eager 求值，同一次按键里串着改不会有谁盖掉谁（历史帧也因此完整：
      // 整次按键只留一帧「删除前」）；已被连带删掉的边在这里是 no-op。
      for (const id of sel.nodeIds) deleteNode(id)
      for (const edge of sel.edges) deleteEdge(edge)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [deleteNode, deleteEdge, runMode, onUndo, onRedo])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)', overflow: 'hidden' }}>
      <style>
        {CANVAS_STYLES}
        {focusDimCss}
      </style>

      {/* ── 主体：画布吃满整行（左缘浮着添加/整理图标窗）──
          属性面板已改成模态框（user 2026-11-09：不固定占用工作区面积），
          原来的 320px 常驻 aside 会永久从画布里切掉一条。 */}
      <div ref={wrapperRef} data-workflow-canvas className={runMode ? 'wf-runmode' : undefined} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* 运行查看态没有「添加/整理/撤销」——dock 是编辑面的东西 */}
        {!runMode && (
          <WorkflowCanvasDock
            onAddNode={() => addNode()}
            onTidy={tidyLayout}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={canUndo}
            canRedo={canRedo}
          />
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          // 运行查看态：图是死的——不可拖、不可连、不可选（pan/zoom 保留，看图要平移缩放）；
          // 节点点击仍触发（onNodeClick 与 selectable 分离）→ 右栏「点谁看谁」。
          nodesDraggable={!runMode}
          nodesConnectable={!runMode}
          elementsSelectable={!runMode}
          onNodeClick={(_, node) => {
            if (!runMode || !onRunNodeClick) return
            if (node.type === TERMINAL_NODE_TYPE) {
              const kind = (node.data as WorkflowTerminalNodeData).kind
              onRunNodeClick(kind === 'START' ? { kind: 'start' } : { kind: 'done' })
              return
            }
            onRunNodeClick({ kind: 'stage', nodeId: (node.data as WorkflowStageNodeData).node.id })
          }}
          onNodeDragStart={() => setDragging(true)}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={workflowNodeTypes}
          edgeTypes={workflowEdgeTypes}
          colorMode={mode}
          fitView
          // 运行查看态统一取景口径（padding 20% / 不放大）；编辑态维持 RF 默认。
          fitViewOptions={runMode ? runFitOptions : undefined}
          // 高图要缩得下去：RF 默认 minZoom 0.5 会把「fit 到底」夹在半路，图依旧
          // 装不下（user 2026-11-17「可适当缩小」）。运行态放宽到 0.25，编辑态
          // 不动。
          minZoom={runMode ? 0.25 : undefined}
          // 只有用户真的拖/滚过才记「用户接管了视口」——程序性变换的 sourceEvent
          // 是 null（RF 把 d3-zoom 的 event.sourceEvent 原样传出）。
          onMoveStart={(event) => {
            if (event) userMovedViewport.current = true
          }}
          proOptions={{ hideAttribution: true }}
          // RF 自己的删除键必须关着：它删的是 RF 内部的 nodes/edges，而 def 是
          // 唯一真源（所有权在向导）——两边一岔，保存出去就是另一张图。键删由
          // 下面那个 document keydown 走 def 的写回调（见 liveSelectionRef）。
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* 属性面板 = 模态框。**只承载任务节点**：点连线不再开面板（user 2026-11-09
          「点击连接线不要弹模态框」）——选中一条线只是选中（蓝色高亮），删它走
          Delete 键。编辑是即时的（直接写 def），所以没有「确定/取消」的草稿语义：
          关闭即关闭，改动早已落地；删除仍有二次确认（modal.confirm）。
          destroyOnHidden 是承重的：antd 默认把关闭后的弹窗 DOM 留在原处（只把外层
          wrap 设成 display:none），不销毁会让「面板已经没了」在 DOM 上常年判成假。 */}
      <Modal
        open={!!selectedNode && !runMode}
        onCancel={() => setEditingNodeId(null)}
        title={selectedNode ? selectedNode.title || selectedNode.id : ''}
        width={620}
        centered
        destroyOnHidden
        styles={{ body: { maxHeight: '62vh', overflowY: 'auto' } }}
        footer={
          selectedNode ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Button danger icon={<DeleteOutlined />} onClick={() => requestDeleteNode(selectedNode.id)}>
                {t('workflow.canvasDeleteNode')}
              </Button>
              <Button onClick={() => setEditingNodeId(null)}>{t('workflow.canvasPanelClose')}</Button>
            </div>
          ) : null
        }
      >
        {/* 面板体仍只在选中态挂载：关闭动画期间不留一份旧内容给读屏/探针读。 */}
        {selectedNode ? (
          <div data-workflow-node-panel style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 11.5, color: 'var(--pm-text-muted)', fontFamily: 'monospace' }}>{selectedNode.id}</div>
            <label style={LABEL_STYLES}>
              {t('workflow.canvasTitleLabel')}
              <Input
                value={selectedNode.title}
                onChange={(e) => patchNode(selectedNode.id, { title: e.target.value }, `wf:title:${selectedNode.id}`)}
              />
            </label>
            <div style={LABEL_STYLES} data-workflow-field="prompt">
              <span>{t('workflow.canvasPromptLabel')}</span>
              <Input.TextArea
                ref={promptAreaRef}
                aria-label={t('workflow.canvasPromptLabel')}
                value={selectedNode.prompt}
                onChange={(e) => patchNode(selectedNode.id, { prompt: e.target.value }, `wf:prompt:${selectedNode.id}`)}
                autoSize={{ minRows: 6, maxRows: 14 }}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
            {/* 上下文 · 自动注入（PLAN-workflow-context）：信封默认全开——你在
                工作流里的位置 / 全局目标 / 运行输入 / 上游交接由引擎拼到每个阶段
                prompt 开头，这里只放逃生舱（按节点关块）+「精确控制」（手动引用
                占位符，被引用的块不再自动注入）+ 预览。默认收起：隐式上下文的
                主路径不该逼用户读它。插入变量是动作不是状态（value 恒 null），
                与任务式对话同一个控件、同一份 caret 实现。 */}
            <div data-workflow-context-section>
              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'context',
                    label: <span data-workflow-context-label>{t('workflow.canvasContextSection')}</span>,
                    children: (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <span style={{ fontSize: 11.5, color: 'var(--pm-text-muted)', lineHeight: 1.5 }}>
                          {t('workflow.canvasContextHint')}
                        </span>
                        {(['objective', 'upstream', 'inputs'] as const).map((k) => (
                          <div
                            key={k}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                            data-workflow-context-toggle={k}
                          >
                            <span>{t(`workflow.canvasContext${capFirst(k)}`)}</span>
                            <Switch size="small" checked={selectedNode.context?.[k] !== false} onChange={(checked) => patchContext(k, checked)} />
                          </div>
                        ))}
                        <div
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                          data-workflow-precise-row
                        >
                          <span style={{ fontSize: 11.5, color: 'var(--pm-text-muted)', lineHeight: 1.5 }}>
                            {t('workflow.canvasPreciseHint')}
                          </span>
                          <span data-workflow-var-insert style={{ flexShrink: 0 }}>
                            <InsertVariableSelect placeholder={t('workflow.insertVariable')} groups={promptVarGroups} onInsert={insertPromptVar} />
                          </span>
                        </div>
                        <div>
                          <Button
                            size="small"
                            data-workflow-preview-toggle
                            onClick={() => setPreviewNodeId(previewOpen ? null : selectedNode.id)}
                          >
                            {t('workflow.canvasPreview')}
                          </Button>
                          {previewOpen ? (
                            <>
                              <pre
                                data-workflow-preview
                                style={{
                                  marginTop: 8,
                                  padding: 10,
                                  maxHeight: 260,
                                  overflow: 'auto',
                                  fontSize: 11.5,
                                  lineHeight: 1.6,
                                  background: 'var(--pm-fill, rgba(127,127,127,0.08))',
                                  borderRadius: 8,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                  fontFamily: 'monospace',
                                }}
                              >
                                {previewPrompt}
                              </pre>
                              <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', marginTop: 4 }}>
                                {t('workflow.canvasPreviewNote')}
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ),
                  },
                ]}
              />
            </div>
            {/* 结果状态 = 卡片下缘的出口数（一状态一根线头），也是出边的
                调度键。至少留一项：没有状态就等于没有出口。
                每个状态**一行**（user 2026-11-09「状态类型本身应该是简短的，状态
                定义是必填的，表单放到同一行中」）：窄的状态名输入 + 占满剩余宽度
                的定义输入 + 删除钮。名字是调度键（线头 id 尾段），必须短；定义是
                必填的——空着时输入框当场标红，保存门（TaskWizardPage 的
                `requireVerdictDefs`）逐条拦下，因为只有名字的话 success/failed 的
                边界全靠模型猜，而这条出口决定下一跳走哪根线。定义会逐字注进阶段
                prompt 的出口说明（pipeline-engine 的 stageContractNote），卡面悬停
                也能看到。 */}
            <div style={LABEL_STYLES} data-workflow-field="verdicts">
              <span>{t('workflow.canvasVerdictsLabel')}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-workflow-verdicts>
                {selectedNode.verdicts.map((v, i) => {
                  const def = selectedNode.verdictDefs?.[v] ?? ''
                  const activeColor = resolveVerdictColorIndex(selectedNode, v)
                  return (
                    <div key={i} data-workflow-verdict-row style={VERDICT_ROW_STYLES}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Input
                          size="small"
                          value={v}
                          maxLength={24}
                          data-workflow-verdict-name
                          placeholder={t('workflow.canvasVerdictNamePlaceholder')}
                          aria-label={t('workflow.canvasVerdictNamePlaceholder')}
                          style={VERDICT_NAME_STYLES}
                          onChange={(e) => renameVerdict(i, e.target.value)}
                        />
                        <Input
                          size="small"
                          value={def}
                          maxLength={200}
                          data-workflow-verdict-def
                          // 空定义 = 必填项未填：红框是当下可见的唯一提示（保存门
                          // 会把这一行拦下来，但用户不该等到点保存才知道）。
                          status={def.trim() ? undefined : 'error'}
                          aria-required
                          placeholder={t('workflow.canvasVerdictDefPlaceholder')}
                          aria-label={t('workflow.canvasVerdictDefLabel', { name: v })}
                          style={VERDICT_DEF_STYLES}
                          onChange={(e) => setVerdictDef(i, e.target.value)}
                        />
                        {/* 状态类型 = 颜色（user 2026-11-19「颜色圆圈用来替代自动、
                            成功、失败等状态类型；不要平铺开，收到菜单里」）：圆圈
                            显示当前生效色（无显式色时 = 按语义推导），点开菜单
                            选色即选类型——绿=成功、红=失败、其余中性；「自动」
                            清掉显式声明回到按连线推导。选色同步改画布线头与连线
                            颜色（resolve 同一份，见 buildFlowEdges/WorkflowNodeCard）。 */}
                        <Dropdown trigger={['click']} menu={verdictColorMenu(i, v)}>
                          <button
                            type="button"
                            data-workflow-verdict-color
                            className="wf-verdict-color-btn"
                            title={t('workflow.verdictColorHint')}
                            aria-label={`${t('workflow.verdictColor')}：${t(`workflow.verdictColor${activeColor}`)}`}
                            style={VERDICT_COLOR_STYLES}
                          >
                            <span className="wf-color-swatch" style={{ background: verdictColorVar(activeColor) }} />
                            <DownOutlined />
                          </button>
                        </Dropdown>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<MinusCircleOutlined />}
                          aria-label={t('workflow.canvasVerdictRemove')}
                          title={t('workflow.canvasVerdictRemove')}
                          disabled={selectedNode.verdicts.length <= 1}
                          onClick={() => removeVerdict(i)}
                        />
                      </div>
                    </div>
                  )
                })}
                <Button type="dashed" icon={<PlusOutlined />} data-workflow-verdict-add onClick={addVerdict}>
                  {t('workflow.canvasVerdictAdd')}
                </Button>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--pm-text-muted)', lineHeight: 1.5 }}>{t('workflow.canvasVerdictsHint')}</span>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

const LABEL_STYLES: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--pm-text-secondary)' }

// 结果状态一行：窄名 + 占满剩余宽度的定义 + 删除钮（user 2026-11-09「状态类型
// 本身应该是简短的…表单放到同一行中」）。名字固定 104px（约 6 个汉字/11 个
// 拉丁字母，够 pass/blocked/需修订 这类调度键），定义吃满剩余宽度并允许压缩到
// 0（minWidth 0，否则长定义会把整行撑出面板）。
// 状态行是两层：外层纵排（输入行 + 色板行），内层横排由 JSX 内联——外层的
// 旧值（单行 flex）随色板行（user 2026-11-18）一起退休。
const VERDICT_ROW_STYLES: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 }
const VERDICT_NAME_STYLES: React.CSSProperties = { flex: '0 0 104px', width: 104 }
const VERDICT_DEF_STYLES: React.CSSProperties = { flex: '1 1 auto', minWidth: 0 }
// 语义选择器（自动/成功/失败/中性）：只占一窄列，定义输入框优先吃宽。
const VERDICT_COLOR_STYLES: React.CSSProperties = { flex: '0 0 48px', width: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }

const CANVAS_STYLES = `
  .wf-stage-card {
    position: relative;
    /* 卡边框宽度单列成变量：下面的线头外移量与它同源（见 .wf-stage-card > .react-flow__handle-*）。 */
    --wf-card-border: 1px;
    width: ${STAGE_CARD_W}px; background: var(--pm-elevated); border: var(--wf-card-border) solid var(--pm-border-hairline);
    border-radius: 12px; padding: 10px 12px 14px; box-shadow: var(--pm-shadow-soft);
    font-family: inherit;
  }
  .react-flow__node.selected .wf-stage-card { border-color: var(--pm-link); box-shadow: 0 0 0 1px var(--pm-link); }
  /* ── 连线配色（user 2026-11-09：「选中线之后，蓝色高亮」）──
     颜色不写在边对象上：RF 的 .react-flow__edge-path 本来就取
     --xy-edge-stroke / --xy-edge-stroke-selected，选中与 :focus 两条规则都在
     它自己的样式表里。于是这里的活只有两件——把变量焊到主题色上（在画布根上
     覆盖，比在 .selected 上打补丁少一场优先级官司），再把选中那档的线宽从 1
     提到 2（RF 只给颜色留了变量，宽度没有）。箭头走 context-stroke 跟着线变，
     见 buildFlowEdges。 */
  .react-flow { --xy-edge-stroke-selected: var(--pm-link); --xy-edge-stroke-width-default: 1.5; }
  .react-flow__edge.selected .react-flow__edge-path,
  .react-flow__edge.selectable:focus .react-flow__edge-path,
  .react-flow__edge.selectable:focus-visible .react-flow__edge-path { stroke-width: 2; }
  /* ── 读图语言（user 2026-11-09：「连接线交叉太多，怎么让图更清晰」）──
     ① 聚焦淡化：选中节点只看与它相连的线、选中连线只看那一条，其余降到 15%
        （选边时无关节点也压到一半）——具体选择器由 CanvasBody 的 focusDimCss
        按选中态生成，这里只提供**过渡**：瞬间跳变比一直挤着更难看；
     ② 连线配色：**状态色**（user 2026-11-18「选择后需要同步改变…连接线的
        颜色」）。每条边带 wf-edge-verdict-<0..6> 类（起点状态的调色板下标，
        resolve 与线头同一份），七条规则声明在 done/failed 之后——同特异性
        (0,2,0) 按声明序，状态色一律获胜；DONE/FAILED 的语义绿红只剩芯片上
        还有（边跟着自己的状态色走）。绑定的是 --xy-edge-stroke（在 <g> 上
        覆盖），选中态的蓝因此照旧由 RF 自己的 .selected 规则赢，不需要
        !important；
     ③ 结果状态标签静止时隐藏，悬停/选中/键盘聚焦才现形——多状态节点每条出边
        都挂一个状态词，静止铺满画布正是「糊成一片」的主因，而卡内
        .wf-stage-verdicts 那一行已经把状态名与出口线头逐列对齐了。 */
  .react-flow__edge, .react-flow__node { transition: opacity 0.15s; }
  .react-flow__edge.wf-edge-done { --xy-edge-stroke: var(--pm-success, #52c41a); }
  .react-flow__edge.wf-edge-failed { --xy-edge-stroke: var(--pm-error); }
  .react-flow__edge.wf-edge-verdict-0 { --xy-edge-stroke: var(--pm-verdict-0); }
  .react-flow__edge.wf-edge-verdict-1 { --xy-edge-stroke: var(--pm-verdict-1); }
  .react-flow__edge.wf-edge-verdict-2 { --xy-edge-stroke: var(--pm-verdict-2); }
  .react-flow__edge.wf-edge-verdict-3 { --xy-edge-stroke: var(--pm-verdict-3); }
  .react-flow__edge.wf-edge-verdict-4 { --xy-edge-stroke: var(--pm-verdict-4); }
  .react-flow__edge.wf-edge-verdict-5 { --xy-edge-stroke: var(--pm-verdict-5); }
  .react-flow__edge.wf-edge-verdict-6 { --xy-edge-stroke: var(--pm-verdict-6); }
  .react-flow__edge .react-flow__edge-textwrapper { opacity: 0; transition: opacity 0.15s; }
  .react-flow__edge:hover .react-flow__edge-textwrapper,
  .react-flow__edge.selected .react-flow__edge-textwrapper,
  .react-flow__edge.selectable:focus .react-flow__edge-textwrapper,
  .react-flow__edge.selectable:focus-visible .react-flow__edge-textwrapper { opacity: 1; }
  .wf-stage-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  /* 卡内右上角的两颗钮（user 2026-11-09：悬停才出现，点编辑才开属性面板；
     同日「在悬停出现的编辑旁，再增加删除按钮」）。静止态 opacity 0 +
     pointer-events none——只做透明会让整块热区吃掉本该落在卡片上的拖拽；
     悬停/选中/键盘聚焦三态才现形。删除钮在编辑钮左侧 4px（22 + 4），两者
     共用一条显形规则，任何一颗单独漏掉都会变成「看得见点不到」或「点得到看不见」。 */
  .wf-node-edit, .wf-node-delete {
    position: absolute; top: 6px; z-index: 2;
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
    background: var(--pm-hover-weak); color: var(--pm-text-secondary);
    font-size: 12px; cursor: pointer; opacity: 0; pointer-events: none;
    transition: opacity 0.15s, color 0.15s;
  }
  .wf-node-edit { right: 6px; }
  .wf-node-delete { right: 32px; }
  .wf-stage-card:hover .wf-node-edit,
  .react-flow__node.selected .wf-node-edit,
  .wf-node-edit:focus-visible,
  .wf-stage-card:hover .wf-node-delete,
  .react-flow__node.selected .wf-node-delete,
  .wf-node-delete:focus-visible { opacity: 1; pointer-events: auto; }
  .wf-node-edit:hover { color: var(--pm-link); }
  .wf-node-delete:hover { color: var(--pm-error); }
  .wf-stage-title { font-weight: 600; font-size: 13px; color: var(--pm-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 44px; }
  .wf-stage-prompt {
    font-size: 11px; color: var(--pm-text-muted); display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 8px; min-height: 28px;
  }
  /* 多结果状态时的状态名行（user 2026-11-09「自定义的输出结果状态文字，距离
     连接端点太远了」——指的是**卡上这行字**，不是连线标签）：每个状态名绝对定位
     在**自己那根出口线头的正上方**，left 用与 Handle 完全同一个 (i+0.5)/n 百分比、
     同一个包含块，所以横向逐像素对齐（旧的均分网格要扣掉卡片左右 padding 与列
     gap，中心与线头差几像素，纵向还差 20px——一行字既没对准也没贴近）。
     负横向外边距把行撑到卡的 padding box（线头的百分比就是按它算的）；多出口卡
     的 padding-bottom 收成 8px，于是文字底边距圆点上缘只留 3px。 */
  .wf-stage-card.has-verdicts { padding-bottom: 8px; }
  .wf-stage-verdicts { position: relative; height: 14px; margin: 0 -12px; }
  .wf-stage-verdict {
    position: absolute; top: 0; transform: translateX(-50%);
    font-size: 10px; line-height: 14px; color: var(--pm-text-muted); text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* 未接线的结果状态（2026-11-18）：卡头一颗琥珀感叹号 + 对应状态名虚线底。
     引擎跑到「没有出边」的状态会直接判实例失败——编辑期必须看得见，否则
     只有真跑一次才知道漏连。颜色只借 --pm-warn，不动卡片本身。 */
  .wf-unwired-flag {
    flex-shrink: 0; display: inline-flex; align-items: center;
    color: var(--pm-warn); font-size: 12px; line-height: 1; cursor: help;
  }
  .wf-stage-verdict--unwired {
    color: var(--pm-warn);
    text-decoration: underline dotted var(--pm-warn);
    text-underline-offset: 2px;
  }
  /* 颜色菜单项的圆点（user 2026-11-19）。卡面状态名**不带**圆点——正下方就是
     同色的出口线头，再画一个是重复（user 2026-11-19 裁定）。 */
  .wf-verdict-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
  /* ── 面板里的状态类型圆圈（user 2026-11-18 七色圆圈 → 2026-11-19 替代
     自动/成功/失败 选择器并收进菜单）：行内只放一颗当前生效色的圆圈 +
     下拉箭头，7 色收进 Dropdown 菜单（.wf-verdict-menu-item 的圆点 + 名字）。
     样式挂全局 CANVAS_STYLES 没问题——面板模态框只在画布挂载时可开，
     <style> 一旦渲染就是全文档生效的；菜单是 antd 门户到 body，同样吃得到。 */
  .wf-verdict-color-btn {
    display: inline-flex; align-items: center; gap: 3px; padding: 2px 5px;
    border: none; border-radius: 6px; background: transparent;
    color: var(--pm-text-muted); font-size: 9px; cursor: pointer;
  }
  .wf-verdict-color-btn:hover { background: var(--pm-hover-weak); color: var(--pm-text-secondary); }
  .wf-verdict-menu-item { display: inline-flex; align-items: center; gap: 8px; }
  .wf-color-swatch {
    width: 16px; height: 16px; padding: 0; border-radius: 50%;
    border: none; cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  }
  /* 线头圆点**外径 12px 是契约值**（route.ts 的 ARROW_GAP 由它推导，改这里必须
     同步改那里）：必须 border-box——Chrome 把 1.5px 边框按设备像素取整，
     content-box 下 9px + 2×1.5 的外径会随 DPR 在 11/12px 之间跳，箭头尖跟着
     忽贴忽离（user 2026-11-09「端点和箭头之间有间隙，期望恰好接住」）。 */
  .wf-handle-target { box-sizing: border-box; width: 12px; height: 12px; background: var(--pm-border); border: 1.5px solid var(--pm-elevated); }
  .wf-handle-source { box-sizing: border-box; width: 12px; height: 12px; background: var(--pm-link); border: 1.5px solid var(--pm-elevated); }
  /* 任务卡的线头必须**落在卡的外缘盒上**：route.ts 的 portGeometry 按
     node.measured 把端口放在矩形边缘，而 RF 量的是 .react-flow__node 包装盒
     = 卡的外缘盒。但 .wf-stage-card 是 position: relative，RF 的手柄定位
     （top/left/right/bottom: 0）以它的**内边距盒**为基准——圆心比外缘内缩一个
     边框宽，箭头尖于是永远差 1px 够不到圆点（user 2026-11-09「期望恰好接住」
     的实际残差：屏幕量 dist 恒比半径大 1 世界 px）。外移一个边框宽把圆心推回
     外缘；量取自 --wf-card-border，改边框宽度不必再改这里。
     芯片（.wf-terminal）**没有** position: relative，手柄的包含块是包装盒，
     本来就贴边——这条规则别写成通配，否则芯片上的箭头会反过来埋进圆点。 */
  .wf-stage-card > .react-flow__handle-top { top: calc(-1 * var(--wf-card-border)); }
  .wf-stage-card > .react-flow__handle-bottom { bottom: calc(-1 * var(--wf-card-border)); }
  .wf-stage-card > .react-flow__handle-left { left: calc(-1 * var(--wf-card-border)); }
  .wf-stage-card > .react-flow__handle-right { right: calc(-1 * var(--wf-card-border)); }
  /* 命中面放大（user 2026-11-09：一个任务卡有上/左/右三个入线头，按原尺寸
     拖不准）：伪元素外扩 6px 接管指针，圆点视觉仍是 12px。 */
  .react-flow__handle::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; }
  /* ── 左缘图标悬浮窗（user 2026-11-09：工具箱整块撤掉，画布吃满宽度）──
     面板浮在画布上而不是占一列：绝对定位贴左缘、垂直居中、竖排、只有图标。
     z-index 压过 react-flow 的 pane/renderer 层（最高到 5），否则被画布吃掉点击。 */
  .wf-canvas-dock {
    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
    z-index: 6; display: flex; flex-direction: column; gap: 2px; padding: 4px;
    border: 1px solid var(--pm-border-hairline); border-radius: 10px;
    background: var(--pm-elevated); box-shadow: var(--pm-shadow-soft);
  }
  .wf-dock-btn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; border: none; border-radius: 7px;
    background: transparent; color: var(--pm-text-secondary); font-size: 15px;
    cursor: pointer; transition: background-color 0.15s, color 0.15s;
  }
  .wf-dock-btn:hover { background: var(--pm-hover-weak); color: var(--pm-link); }
  /* 撤销/重做（2026-11-18）：栈空时置灰——按钮还在，只是没有可退/可进的一步。 */
  .wf-dock-btn:disabled { opacity: 0.35; cursor: default; }
  .wf-dock-btn:disabled:hover { background: transparent; color: var(--pm-text-secondary); }
  /* 终态芯片（user 2026-11-08）：实线边框、白底（elevated，同任务卡）、圆角
     矩形（12，同任务卡）、节点阴影（--pm-shadow-soft）；浅灰提示文字已撤——
     芯片上只有 label，身份色留给边框与文字。
     定宽（min-width 取 TS 的 TERMINAL_CHIP_W）服务垂直布局的居中落位：
     terminalPositions 用「卡宽 − 芯片宽」的一半把芯片压到卡的中轴线上。 */
  .wf-terminal {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    min-width: ${TERMINAL_CHIP_W}px;
    padding: 9px 18px; border-radius: 12px; border: 1px solid var(--pm-border);
    background: var(--pm-elevated); box-shadow: var(--pm-shadow-soft); cursor: default;
  }
  .wf-terminal.done { border-color: var(--pm-success, #52c41a); color: var(--pm-success, #52c41a); }
  .wf-terminal.start { border-color: var(--pm-link); color: var(--pm-link); }
  .wf-terminal-label { font-size: 12px; font-weight: 600; }
  /* controls 配色跟随 --pm 变量（colorMode 只翻 RF 自带的底色）；
      minimap 已按 user 2026-11-15 整体撤除（画布让位给连线） */
  .react-flow__controls { box-shadow: var(--pm-shadow-soft); border-radius: 8px; overflow: hidden; }
  .react-flow__controls-button { background: var(--pm-elevated); border-bottom: 1px solid var(--pm-border-hairline); }
  .react-flow__controls-button svg { fill: var(--pm-text-strong); }
  /* ── 运行视图（PLAN-workflow-run-view；user 2026-11-20 二刀裁定翻案）──
     节点**一律灰边**——描边不再跟着 stage 状态走（running 蓝 / pass 绿 /
     fail 红的口径退役：节点可能执行多次、每次结果不一样，卡面上的单值状态
     是误导）；三刀后开始/结束芯片也并入灰边族。唯一的状态信息 = 右上角的
     执行次数徽标（没跑过的节点保持 idle 弱化），成功/失败的辨读全部收敛到
     右栏详情（verdictKindOf 只活在面板）。选中（导航步/画布点选，含芯片）
     → 蓝色边框（三刀：不再有阴影扩散）。边的**颜色**维度归状态类
     （wf-edge-verdict-N），运行类只控强度（user 2026-11-18「运行视图也跟状态
     色」）：走过的全亮、没走弱化。 */
  /* 未走的边要「弱化」而不是「消失」（user 2026-11-17「连接线看不到了」→ 同日
     「在执行过程中，连线没了」）。历史上用过 muted 灰换色 + 0.8 的口径；现
     状态色方案下改纯透明度弱化。0.5（不是更早的 0.35）：verdict-0 调到了
     链接蓝 #1677ff，0.35 在白底上的合成对比只剩 ~51——探针 §4c 的可见度门
     （合成亮度差 ≥ 70）抓到的正是这个回归；0.5 合成 ~74 过门，且与走过边
     （1.0 全亮）仍拉开明显的层级。 */
  .react-flow__edge.wf-edge-idle { opacity: 0.5; }
  /* 无状态类的边（start-entry 派生边——它不挂 wf-edge-verdict-N）在运行态给
     主墨色描边，不用 RF 默认浅灰 #b1b1b7：默认灰叠 0.5 弱化在白底上合成对比
     只剩 ~39，两主题下 text-strong 合成对比都 >100——「刚开跑全 idle」的
     起始线不能又被可见性修掉（与上面 0.5 口径同一门）。 */
  .wf-runmode .react-flow__edge:not([class*='wf-edge-verdict-']) { --xy-edge-stroke: var(--pm-text-strong); }
  .wf-stage-card--run-idle { opacity: 0.45; }
  /* 选中的蓝色描边（user 2026-11-20 二刀「所有节点都是灰色边框，当选中时变为
     蓝色边框」；三刀「只需要设为蓝色边框，不需要阴影扩散效果」——双环/外晕
     已撤，只剩边框换色）：导航定位与点选共用这一个语义。基底卡边框本来就是
     var(--pm-border-hairline) 灰，无需另立「灰边」规则。 */
  .wf-stage-card--run-focus { border-color: var(--pm-link); }
  /* 执行次数徽标钉在卡右上角（user 2026-11-20 二刀「可以在节点右上角展示执行
     次数」——顶掉了 2026-11-17 的执行状态徽标）：绝对定位、脱离 head 的 flex
     流——标题再长也不会把徽标挤到第二行。编辑态的编辑/删除钮占的是同一个
     角落（top/right 6px），但两套钮与徽标分属编辑/运行两个互斥模式，不会
     同屏。中性灰底：次数无成败语义，不上色。 */
  .wf-run-badge {
    position: absolute; top: 6px; right: 6px; z-index: 2; max-width: 60px;
    overflow: hidden; text-overflow: ellipsis;
    font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px;
    background: var(--pm-hover-weak); color: var(--pm-text-secondary);
    white-space: nowrap;
  }
  /* 运行态的标题给右上角徽标让位（72 > 6 + 60 + 6）：编辑态那句 44px 是给
     两颗悬停钮留的，运行态没有钮，唯一占角的是徽标。 */
  .wf-stage-card--runview .wf-stage-title { padding-right: 72px; }
  /* 开始/结束芯片同灰（user 2026-11-20 三刀「开始和结束节点也设为灰色」）：
     实例终态色（wf-terminal--run-*）与编辑态的身份色在运行视图里一并让位，
     与任务卡同一个 hairline 灰、标签走次级灰。编辑视图的蓝「开始」/绿
     「结束」不动（那是定义视图的芯片身份）。 */
  .wf-runmode .wf-terminal { border-color: var(--pm-border-hairline); color: var(--pm-text-secondary); }
  /* 选中芯片的蓝边（与任务卡同一语义）：选择器特异性必须压过上面那条
     （.wf-runmode .wf-terminal 是 0,2,0；这里 0,3,0），否则点了芯片没有反应。 */
  .wf-runmode .wf-terminal.wf-terminal--run-focus { border-color: var(--pm-link); }
  /* 运行查看态不画端口圆点（user 2026-11-16「不用展示连接端点的灰色圆圈」，
     路由的 tailGap:0 让箭头尖直接贴到节点边框）。**opacity 0 而不是
     display:none**——display 会把 handleBounds 从 RF 的测量里抽掉，
     getEdgePosition 查不到线头，整条边直接不渲染。 */
  .wf-runmode .wf-handle-source, .wf-runmode .wf-handle-target { opacity: 0; pointer-events: none; }
  /* 运行查看态节点/芯片可点（user 2026-11-17「点谁看谁」）：光标给 pointer
     提示可点。悬停不再换色（三刀后蓝边 = 选中语义，悬停变蓝会与选中混淆），
     芯片与任务卡同款：只有 cursor 一个可点线索。 */
  .wf-runmode .wf-stage-card, .wf-runmode .wf-terminal { cursor: pointer; }
`

/** 外层 Provider：useReactFlow 需要（组件自包含，向导无需再包）。 */
export function WorkflowCanvas(props: WorkflowCanvasProps): React.ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasBody {...props} />
    </ReactFlowProvider>
  )
}
