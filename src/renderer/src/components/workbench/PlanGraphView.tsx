// ── Plan DAG view (PLAN-workbench W6) ──
// SVG rendering of the plan graph: waves as columns (time → right), nodes as
// status-colored cards, dependencies from the pure layout in
// shared/plan/layout.ts (adjacent = bezier across the gap; skip-level = the
// top bus, so no line ever crosses a node). Zero graph dependencies — the
// whole point. The graph scales down to fit the pane width (floor 0.55,
// scroll below that).

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AimOutlined } from '@ant-design/icons'
import type { Plan, PlanNodeStatus } from '../../types/agent'
import { layoutPlanGraph, type LayoutNode } from '../../../../shared/plan/layout'
import { blockedNodes, readyNodes } from '../../../../shared/plan/graph'
import { expertLabel } from '../../../../shared/expert-context'
import { getCachedExpertProfiles, subscribeCache } from '../../agent/mcp-cache'

// ── Card vocabulary ──
// White cards with grey borders; status rides a glyph, a dash and the ink
// weight of the words — never hue. The two exceptions are the status glyphs a
// reader has to find at a glance: the completed disc and the failure cross.
// Text follows importance: 编号 (what it is) darker than 执行者 (who), and
// 任务内容 darkest only while the node is the one being worked on (就绪).
const DONE_GREEN = '#34a853'
const FAILED_RED = '#b4453c'

interface CardStyle {
  border: string
  dash?: string
  /** 编号 — the card's identity, at its own importance. */
  num: string
  /** 任务内容 — the words that matter, dimmed as the node settles. */
  desc: string
  icon: IconKind
  iconColor: string
}

const CARD: Record<PlanNodeStatus, CardStyle> = {
  // Live work: content legible (7:1 on white).
  pending: { border: '#e0e0e0', num: '#595959', desc: '#595959', icon: 'circle', iconColor: '#bfbfbf' },
  // Settled: readable but visibly behind the live ones.
  completed: { border: '#e8e8e8', num: '#595959', desc: '#8c8c8c', icon: 'check', iconColor: '#8c8c8c' },
  failed: { border: '#e8e8e8', num: '#262626', desc: '#595959', icon: 'cross', iconColor: FAILED_RED },
  skipped: { border: '#ececec', dash: '5 3', num: '#a6a6a6', desc: '#a6a6a6', icon: 'minus', iconColor: '#bfbfbf' },
}
/** The node in flight: darkest border and darkest words in the graph, and the
 *  only moving thing — the spinner carries it, the card border stays still. */
const READY_CARD: CardStyle = { border: '#8c8c8c', num: '#141414', desc: '#262626', icon: 'spinner', iconColor: '#141414' }
/** Waiting on an upstream failure — readable, but visibly out of play. */
const BLOCKED_CARD: CardStyle = { border: '#e0e0e0', dash: '5 3', num: '#737373', desc: '#737373', icon: 'ban', iconColor: '#8c8c8c' }

const EDGE: Record<PlanNodeStatus, { stroke: string; dash?: string; width: number }> = {
  completed: { stroke: '#c8c8c8', width: 1.5 },
  failed: { stroke: '#d9d9d9', dash: '5 3', width: 1.3 },
  skipped: { stroke: '#e0e0e0', dash: '5 3', width: 1.3 },
  pending: { stroke: '#d9d9d9', width: 1.2 },
}

/** The one place a status is spelled out — the card itself only wears the
 *  glyph, so the word has to be somewhere reachable. */
const STATUS_WORD: Record<PlanNodeStatus, string> = {
  completed: '已完成',
  failed: '失败',
  skipped: '跳过',
  pending: '未就绪',
}

type IconKind = 'spinner' | 'check' | 'cross' | 'minus' | 'circle' | 'ban'

/** Status glyphs, drawn by hand in a 12×12 box: no icon dependency, and no
 *  <text> either — the words on a card stay words, so the probe's
 *  text-containment check keeps measuring what a reader reads. */
const ICON_SIZE = 12

function StatusIcon({ kind, x, y, color }: { kind: IconKind; x: number; y: number; color: string }): React.ReactElement {
  const line = { stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' as const, fill: 'none' }
  return (
    <g data-icon={kind} transform={`translate(${x} ${y})`}>
      {kind === 'spinner' && (
        // Drawn around the box centre (6,6) with the track and the arc in the
        // SAME rotating group: the circle makes the group's bbox symmetric, so
        // `transform-origin: center` in .pm-spin turns about the true centre
        // (and a spinning circle looks the same at every angle).
        <g transform="translate(6 6)">
          <g className="pm-spin">
            <circle cx="0" cy="0" r="4.4" {...line} opacity={0.22} />
            <path d="M0 -4.4 A4.4 4.4 0 0 1 4.4 0" {...line} />
          </g>
        </g>
      )}
      {kind === 'check' && (
        <>
          <circle cx="6" cy="6" r="5.6" fill={DONE_GREEN} stroke="none" />
          <polyline points="3.5,6.2 5.2,7.9 8.5,4.3" stroke="#ffffff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}
      {kind === 'cross' && (
        <>
          <line x1="3.4" y1="3.4" x2="8.6" y2="8.6" {...line} />
          <line x1="8.6" y1="3.4" x2="3.4" y2="8.6" {...line} />
        </>
      )}
      {kind === 'minus' && <line x1="3" y1="6" x2="9" y2="6" {...line} />}
      {kind === 'circle' && <circle cx="6" cy="6" r="3.4" {...line} strokeDasharray="2.2 2.2" />}
      {kind === 'ban' && (
        <>
          <circle cx="6" cy="6" r="3.4" {...line} />
          <line x1="3.6" y1="8.4" x2="8.4" y2="3.6" {...line} />
        </>
      )}
    </g>
  )
}

/** Card row baselines, measured from the card's top edge (NODE_H = 72). */
const ROW_NUM = 15
const ROW_ASSIGNEE = 30
const ROW_DESC = 47
const DESC_STEP = 15

/** The objective shows this many lines before it needs 展开. The explicit
 *  line-height is what makes the overflow measurement exact. */
const OBJECTIVE_LINES = 2
const OBJECTIVE_LINE_H = 18

/** Text metrics for the wrap — must match the font sizes below (11.5px desc)
 *  and the inner width of the card (NODE_W − 20). */
const DESC_CJK = 13
const DESC_LATIN = 25

function wrapDescription(text: string): string[] {
  const clean = text.trim()
  const max = /[\u4e00-\u9fff]/.test(clean) ? DESC_CJK : DESC_LATIN
  if (clean.length <= max) return [clean]
  const first = clean.slice(0, max)
  const rest = clean.slice(max)
  return [first, rest.length > max ? `${rest.slice(0, max - 1)}…` : rest]
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

interface Props {
  plan: Plan | null
  onJumpToStep: (msgId: string) => void
  /** Node click with a linked sub-agent session (PLAN-workbench: 点击模块进入
   *  子代理会话). When provided it takes precedence over the msgId jump — the
   *  caller decides whether the node resolves to a session or falls back. */
  onOpenPlanNode?: (nodeId: string) => void
  /** Which nodes actually open something. The caller owns that resolution
   *  (agent/plan-node-target.ts), so without it a node is assumed openable and
   *  every card is dressed as a link — including the ones whose click the caller
   *  silently drops. */
  canOpenNode?: (nodeId: string) => boolean
}

export function PlanGraphView({ plan, onJumpToStep, onOpenPlanNode, canOpenNode }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [availWidth, setAvailWidth] = useState(0)
  const [availHeight, setAvailHeight] = useState(0)
  // Expert ID → name. The cache fetch lands after the first paint, so this has
  // to be a subscription: without it the cards would keep showing raw ids.
  const experts = useSyncExternalStore(subscribeCache, getCachedExpertProfiles)

  // The graph must fit the pane, not fight it: scale to the measured box
  // (floor 0.55 — below that, scroll instead of shrinking into mush).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) setAvailWidth(el.clientWidth)
      if (el.clientHeight > 0) setAvailHeight(el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The objective defaults to two lines; anything longer gets a 展开 toggle.
  // scrollHeight reports the full text even while line-clamp hides it, so the
  // same measurement works in both states — that is what keeps 收起 around
  // once expanded (an overflow test that only runs while clamped would make
  // the toggle vanish the moment it was needed).
  const objectiveRef = useRef<HTMLDivElement | null>(null)
  const [objectiveExpanded, setObjectiveExpanded] = useState(false)
  const [objectiveOverflows, setObjectiveOverflows] = useState(false)
  useEffect(() => {
    const el = objectiveRef.current
    if (!el) return
    setObjectiveOverflows(el.scrollHeight > OBJECTIVE_LINES * OBJECTIVE_LINE_H + 1)
  }, [plan?.objective, availWidth, objectiveExpanded])

  // Direction is the graph's call (PLAN-workbench W11): lay the plan out both
  // ways and keep whichever fits the measured viewport at a larger scale —
  // deep chains flow top-to-bottom, broad parallel plans left-to-right.
  const layoutH = useMemo(() => (plan ? layoutPlanGraph(plan, 'horizontal') : null), [plan])
  const layoutV = useMemo(() => (plan ? layoutPlanGraph(plan, 'vertical') : null), [plan])
  const fitRatio = (l: { width: number; height: number } | null): number =>
    !l || availWidth === 0 ? 0 : Math.min(availWidth / l.width, availHeight / (l.height || 1), 1)
  // plan is non-null past the empty-state return, so both layouts exist.
  const layout = fitRatio(layoutV) > fitRatio(layoutH) ? layoutV! : layoutH!

  if (!plan || plan.nodes.length === 0) {
    return (
      <div style={{ padding: 24, fontSize: 12, color: '#999', textAlign: 'center' }}>
        <AimOutlined style={{ fontSize: 20, display: 'block', marginBottom: 8, color: '#d9d9d9' }} />
        暂无进行中的计划
        <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>让 AI 用 create_plan 拆解任务后，依赖图会显示在这里</div>
      </div>
    )
  }

  const readyIds = new Set(plan && readyNodes(plan).map(n => n.id))
  const blockedIds = new Set(plan && blockedNodes(plan).map(n => n.id))
  const settled = plan ? plan.nodes.filter(n => n.status !== 'pending').length : 0
  const pct = plan && plan.nodes.length > 0 ? Math.round((settled / plan.nodes.length) * 100) : 0

  const scale = layout && availWidth > 0 ? Math.max(0.55, Math.min(1, fitRatio(layout))) : 1

  const nodeElement = (n: LayoutNode) => {
    // ── 开始 / 结束 anchor pills (PLAN-workbench: 起点/终点) ──
    // Neutral scaffolding throughout: they darken in ink as their end of the
    // plan comes alive (开始 once anything settles, 结束 when it closes).
    if (n.terminal) {
      const done = n.terminal === 'start' ? settled > 0 : plan.completed
      return (
        <g key={n.id} data-node={n.id}>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={13} fill={done ? '#f5f5f5' : '#ffffff'} stroke={done ? '#8c8c8c' : '#d9d9d9'} strokeWidth={1.2} />
          <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 3.5} fontSize={10.5} fontWeight={600} fill={done ? '#262626' : '#8c8c8c'} textAnchor="middle">
            {n.description}
          </text>
        </g>
      )
    }
    const isReady = n.status === 'pending' && readyIds.has(n.id)
    const isBlocked = n.status === 'pending' && blockedIds.has(n.id)
    const card = isReady ? READY_CARD : isBlocked ? BLOCKED_CARD : CARD[n.status]
    const lines = wrapDescription(n.description)
    const statusWord = isReady ? '就绪' : isBlocked ? '阻塞' : STATUS_WORD[n.status]
    // The plan stores the expert ID, a person reads the name (expertLabel).
    const who = n.assignee ? expertLabel(experts, n.assignee) : '通用子代理'
    const tooltip = [statusWord, n.summary, `负责人 ${who}`].filter(Boolean).join(' · ')
    // Click affordance in the tooltip: a node that can be opened names what it
    // opens, so the drill-down is discoverable without a legend — and a node
    // that opens nothing says nothing, instead of promising a jump it drops.
    const openable = canOpenNode ? canOpenNode(n.id) : (!!n.subConvId || !!n.msgId || !!onOpenPlanNode)
    const hint = !openable
      ? undefined
      : onOpenPlanNode || n.subConvId
        ? '点击查看子代理会话'
        : '点击定位到对话'
    const title = [tooltip, hint].filter(Boolean).join('\n')
    return (
      <g key={n.id} data-node={n.id} onClick={() => {
        if (onOpenPlanNode) { onOpenPlanNode(n.id); return }
        if (n.msgId) onJumpToStep(n.msgId)
      }} style={{ cursor: openable ? 'pointer' : 'default' }}>
        <title>{title}</title>
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h} rx={9}
          fill="#ffffff"
          stroke={card.border}
          strokeDasharray={card.dash}
          strokeWidth={isReady ? 1.6 : 1.2}
        />
        {/* Row 1: 编号 left, status glyph right — the glyph replaces the word,
            so the word moves into the tooltip. */}
        <text x={n.x + 10} y={n.y + ROW_NUM} fontSize={10} fontWeight={600} fill={card.num}>
          {`n${n.num}`}
        </text>
        <StatusIcon
          kind={card.icon} x={n.x + n.w - 10 - ICON_SIZE} y={n.y + ROW_NUM - 7.5}
          color={card.iconColor}
        />
        {/* Row 2: 执行者 — who runs it, lighter than the 编号 that names it. */}
        <text
          x={n.x + 10} y={n.y + ROW_ASSIGNEE} fontSize={10}
          fill={n.assignee ? '#737373' : '#a6a6a6'}
        >
          {clip(n.assignee ? `@${who}` : who, 15)}
        </text>
        {/* Rows 3+: 任务内容, up to two wrapped lines */}
        {lines.map((line, li) => (
          <text
            key={li}
            x={n.x + 10}
            y={n.y + ROW_DESC + li * DESC_STEP}
            fontSize={11.5}
            fontWeight={isReady ? 500 : 400}
            fill={card.desc}
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
      {/* Header: objective (two lines, expandable) + progress bar */}
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div
            ref={objectiveRef}
            data-objective
            title={plan.objective}
            style={{
              flex: 1, minWidth: 0,
              fontSize: 12.5, color: '#262626', fontWeight: 600, lineHeight: `${OBJECTIVE_LINE_H}px`,
              overflow: 'hidden',
              display: objectiveExpanded ? 'block' : '-webkit-box',
              WebkitLineClamp: objectiveExpanded ? undefined : OBJECTIVE_LINES,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {plan.objective}
          </div>
          {objectiveOverflows && (
            <button
              type="button"
              data-objective-toggle
              onClick={() => setObjectiveExpanded((v) => !v)}
              style={{
                flexShrink: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 11, lineHeight: `${OBJECTIVE_LINE_H}px`, color: '#595959',
              }}
            >
              {objectiveExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#f0f0f0', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: '#262626', transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontSize: 11, color: '#8c8c8c', flexShrink: 0 }}>
            {plan.completed ? '已完成' : `${settled}/${plan.nodes.length}`}
          </span>
        </div>
      </div>

      {/* Graph — scales down to the pane width; scrolls when even the 0.55
          floor cannot fit (very wide graphs). */}
      <div ref={containerRef} data-graph-viewport style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa' }}>
        <svg
          width={layout.width * scale}
          height={layout.height * scale}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          // 水平居中（用户反馈 2026-09-16）：图比面板窄时不能贴左、右边空一片。
          // 用 auto 外边距而不是 flex：面板是滚动容器，图比面板宽时 auto 会收成 0，
          // 左边距不会被推到可视区外（开始锚点必须看得见）。
          style={{ display: 'block', margin: '0 auto' }}
        >
          {/* The spinner on the in-flight node — the graph's only motion (the
              card border deliberately stays still). Honors reduced-motion. */}
          <style>{`
            @keyframes pm-spin { to { transform: rotate(360deg); } }
            .pm-spin {
              animation: pm-spin 0.9s linear infinite;
              transform-box: fill-box;
              transform-origin: center;
            }
            @media (prefers-reduced-motion: reduce) { .pm-spin { animation: none; } }
          `}</style>
          <defs>
            {(['pending', 'completed', 'failed', 'skipped'] as PlanNodeStatus[]).map((s) => (
              <marker key={s} id={`pm-arrow-${s}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" fill={EDGE[s].stroke} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e) => (
            <path
              key={`${e.from}->${e.to}`}
              d={e.path}
              fill="none"
              stroke={EDGE[e.fromStatus].stroke}
              strokeWidth={EDGE[e.fromStatus].width}
              strokeDasharray={EDGE[e.fromStatus].dash}
              strokeLinejoin="round"
              opacity={e.kind === 'over' ? 0.85 : 1}
              markerEnd={`url(#pm-arrow-${e.fromStatus})`}
            />
          ))}
          {layout.nodes.map(nodeElement)}
        </svg>
      </div>
    </div>
  )
}
