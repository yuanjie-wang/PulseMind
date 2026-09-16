// ── Plan DAG view (PLAN-workbench W6) ──
// SVG rendering of the plan graph: waves as columns (time → right), nodes as
// status-colored cards, dependencies as cubic beziers drawn from the pure
// layout in shared/plan/layout.ts. Zero graph dependencies — the whole point.

import React from 'react'
import { AimOutlined } from '@ant-design/icons'
import type { Plan, PlanNodeStatus } from '../../types/agent'
import { layoutPlanGraph, type LayoutNode } from '../../../../shared/plan/layout'
import { readyNodes } from '../../../../shared/plan/graph'

const PRIMARY = '#1677ff'

const FILL: Record<PlanNodeStatus, string> = {
  completed: '#f6ffed',
  failed: '#fff1f0',
  skipped: '#fafafa',
  pending: '#fff',
}
const STROKE: Record<PlanNodeStatus, string> = {
  completed: '#95de64',
  failed: '#ffa39e',
  skipped: '#d9d9d9',
  pending: '#d9d9d9',
}
const TEXT: Record<PlanNodeStatus, string> = {
  completed: '#389e0d',
  failed: '#cf1322',
  skipped: '#bfbfbf',
  pending: '#333',
}
const EDGE: Record<PlanNodeStatus, { stroke: string; dash?: string }> = {
  completed: { stroke: '#95de64' },
  failed: { stroke: '#ffa39e', dash: '4 3' },
  skipped: { stroke: '#d9d9d9', dash: '4 3' },
  pending: { stroke: '#e5e6eb' },
}

/** Wrap a description into ≤2 SVG text lines (CJK ≈ 9 chars, latin ≈ 18). */
function wrapDescription(text: string): string[] {
  const clean = text.trim()
  const max = /[\u4e00-\u9fff]/.test(clean) ? 9 : 16
  if (clean.length <= max) return [clean]
  const first = clean.slice(0, max)
  const rest = clean.slice(max)
  return [first, rest.length > max ? `${rest.slice(0, max - 1)}…` : rest]
}

interface Props {
  plan: Plan | null
  onJumpToStep: (msgId: string) => void
}

export function PlanGraphView({ plan, onJumpToStep }: Props): React.ReactElement {
  if (!plan || plan.nodes.length === 0) {
    return (
      <div style={{ padding: 24, fontSize: 12, color: '#999', textAlign: 'center' }}>
        <AimOutlined style={{ fontSize: 20, display: 'block', marginBottom: 8, color: '#d9d9d9' }} />
        暂无进行中的计划
        <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>让 AI 用 create_plan 拆解任务后，依赖图会显示在这里</div>
      </div>
    )
  }

  const layout = layoutPlanGraph(plan)
  const readyIds = new Set(readyNodes(plan).map(n => n.id))
  const settled = plan.nodes.filter(n => n.status !== 'pending').length
  const pct = plan.nodes.length > 0 ? Math.round((settled / plan.nodes.length) * 100) : 0

  const nodeElement = (n: LayoutNode) => {
    const isReady = n.status === 'pending' && readyIds.has(n.id)
    const stroke = isReady ? PRIMARY : STROKE[n.status]
    const lines = wrapDescription(n.description)
    const tooltip = [n.summary, n.assignee ? `负责人 ${n.assignee}` : undefined].filter(Boolean).join(' · ')
    return (
      <g
        key={n.id}
        onClick={() => { if (n.msgId) onJumpToStep(n.msgId) }}
        style={{ cursor: n.msgId ? 'pointer' : 'default' }}
      >
        <title>{tooltip || n.description}</title>
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h} rx={8}
          fill={isReady ? '#f0f7ff' : FILL[n.status]}
          stroke={stroke}
          strokeWidth={isReady ? 1.6 : 1}
        />
        <text x={n.x + 8} y={n.y + 15} fontSize={10} fill={isReady ? PRIMARY : TEXT[n.status]} fontWeight={600}>
          {`n${n.num}`}
          {n.status !== 'pending' && (
            <tspan fill={TEXT[n.status]} fontWeight={400} style={{ textDecoration: n.status === 'skipped' ? 'line-through' : undefined }}>
              {` · ${n.status === 'completed' ? '完成' : n.status === 'failed' ? '失败' : '跳过'}`}
            </tspan>
          )}
          {isReady && <tspan fill={PRIMARY} fontWeight={400}> · 就绪</tspan>}
          {n.assignee && <tspan fill="#999" fontWeight={400}>{` · ${n.assignee}`}</tspan>}
        </text>
        {lines.map((line, li) => (
          <text
            key={li}
            x={n.x + 8}
            y={n.y + 30 + li * 13}
            fontSize={11}
            fill={n.status === 'pending' && !isReady ? '#999' : TEXT[n.status]}
            style={{ textDecoration: n.status === 'skipped' ? 'line-through' : undefined }}
          >
            {line}
          </text>
        ))}
      </g>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header: objective + progress bar */}
      <div style={{ padding: '8px 12px 6px', borderBottom: '1px solid #ececf0', flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: '#333', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={plan.objective}>
          {plan.objective}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#f0f0f0', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: pct === 100 ? '#52c41a' : PRIMARY, transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontSize: 11, color: '#999', flexShrink: 0 }}>
            {plan.completed ? '已完成' : `${settled}/${plan.nodes.length}`}
          </span>
        </div>
      </div>

      {/* Graph — scrolls in both directions for wide/deep graphs */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafbfc' }}>
        <svg width={layout.width} height={layout.height} style={{ display: 'block' }}>
          {layout.edges.map((e) => (
            <path
              key={`${e.from}->${e.to}`}
              d={e.path}
              fill="none"
              stroke={EDGE[e.fromStatus].stroke}
              strokeWidth={e.fromStatus === 'completed' ? 1.6 : 1.2}
              strokeDasharray={EDGE[e.fromStatus].dash}
              opacity={0.9}
            />
          ))}
          {layout.nodes.map(nodeElement)}
        </svg>
      </div>
    </div>
  )
}
