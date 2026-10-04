// ── Plan DAG view (PLAN-workbench W6; PLAN-plan-graph-canvas M2/M3) ──
// SVG rendering of the plan graph: waves as columns (time → right), nodes as
// status-colored cards, dependencies from the pure layout in
// shared/plan/layout.ts (adjacent = bezier across the gap; skip-level = the
// top bus, so no line ever crosses a node). Zero graph dependencies — the
// whole point. The graph NEVER scales below 100% (D1): a too-narrow pane
// pans instead — native scroll plus drag-to-scroll (D2), so text stays at
// its native size and the compositor never resamples it.

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AimOutlined } from '@ant-design/icons'
import type { Plan, PlanNodeStatus } from '../../types/agent'
import { layoutPlanGraph, type LayoutNode } from '../../../../shared/plan/layout'
import { blockedNodes, planNodeDeclaredLabel, planNodeExecutionLabel } from '../../../../shared/plan/graph'
import { DRAG_THRESHOLD_PX, planTopologySignature, viewScale } from '../../../../shared/plan/view'
import { expertLabel } from '../../../../shared/expert-context'
import { getCachedExpertProfiles, subscribeCache } from '../../agent/mcp-cache'

// ── Card vocabulary ──
// White cards with grey borders; status rides a glyph, a dash and the ink
// weight of the words — never hue. The two exceptions are the status glyphs a
// reader has to find at a glance: the completed disc and the failure cross.
// Text follows importance: 编号 (what it is) darker than 执行者 (who), and
// 任务内容 darkest only while the node is the one being worked on (就绪).
// The two status hues stay literals on purpose: they are the glyphs a reader
// finds at a glance, and both carry enough contrast on a dark ground as-is —
// the migration moved the NEUTRAL ladder onto the sheet, not the status hues.
const DONE_GREEN = '#34a853'
const FAILED_RED = '#b4453c'
/** 声明「部分成功」的警示琥珀 — the app-wide warn ink (InputArea's
 *  UNRESTRICTED_COLOR, the panel's --pm-warn), a literal like the two status
 *  hues above: it is the third color a reader has to find at a glance. */
const PARTIAL_AMBER = '#d46b08'

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
  pending: { border: 'var(--pm-frame)', num: 'var(--pm-graph-ink)', desc: 'var(--pm-graph-ink)', icon: 'circle', iconColor: 'var(--pm-graph-ink-faint)' },
  // Settled: readable but visibly behind the live ones.
  completed: { border: 'var(--pm-border-soft)', num: 'var(--pm-graph-ink)', desc: 'var(--pm-graph-ink-dim)', icon: 'check', iconColor: 'var(--pm-graph-ink-dim)' },
  failed: { border: 'var(--pm-border-soft)', num: 'var(--pm-text)', desc: 'var(--pm-graph-ink)', icon: 'cross', iconColor: FAILED_RED },
  skipped: { border: 'var(--pm-graph-border-skip)', dash: '5 3', num: 'var(--pm-graph-ink-hollow)', desc: 'var(--pm-graph-ink-hollow)', icon: 'minus', iconColor: 'var(--pm-graph-ink-faint)' },
  // Split (PLAN-plan-split): the work moved INTO the graph (its children sit
  // downstream), so the node stays legible — no strikethrough, no hollow ink;
  // only the fork glyph and the 已拆分 word tell it apart from completed.
  split: { border: 'var(--pm-border-soft)', num: 'var(--pm-graph-ink)', desc: 'var(--pm-graph-ink-dim)', icon: 'fork', iconColor: 'var(--pm-graph-ink-dim)' },
}
/** The node in flight: darkest border and darkest words in the graph, and the
 *  only moving thing — the spinner carries it, the card border stays still. */
const READY_CARD: CardStyle = { border: 'var(--pm-graph-ink-dim)', num: 'var(--pm-graph-ink-live)', desc: 'var(--pm-text)', icon: 'spinner', iconColor: 'var(--pm-graph-ink-live)' }
/** Waiting on an upstream failure — readable, but visibly out of play. */
const BLOCKED_CARD: CardStyle = { border: 'var(--pm-frame)', dash: '5 3', num: 'var(--pm-graph-ink-blocked)', desc: 'var(--pm-graph-ink-blocked)', icon: 'ban', iconColor: 'var(--pm-graph-ink-dim)' }

const EDGE: Record<PlanNodeStatus, { stroke: string; dash?: string; width: number }> = {
  completed: { stroke: 'var(--pm-text-ghost)', width: 1.5 },
  failed: { stroke: 'var(--pm-border)', dash: '5 3', width: 1.3 },
  skipped: { stroke: 'var(--pm-frame)', dash: '5 3', width: 1.3 },
  pending: { stroke: 'var(--pm-border)', width: 1.2 },
  // A split node's own incoming edges read like completed ones — its work
  // continues in the children downstream, not in this card.
  split: { stroke: 'var(--pm-text-ghost)', width: 1.5 },
}

type IconKind = 'spinner' | 'check' | 'cross' | 'minus' | 'circle' | 'ban' | 'fork'

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
      {kind === 'fork' && (
        // One stem forking into two branches — the split node's work became
        // two (or more) downstream nodes.
        <path d="M3 6 H5.6 M5.6 6 V3.4 H8.6 M5.6 6 V8.6 H8.6" {...line} />
      )}
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
  /** Open the node's delivered report file (PLAN-plan-exchange 表达面). The
   *  caller owns the opener (preview pane, the same channel as the deliverable
   *  rows); the card advertises 「查看报告」 only when it carries a reportPath,
   *  so a node the report never reached says nothing. */
  onOpenNodeReport?: (nodeId: string) => void
}

export function PlanGraphView({ plan, onJumpToStep, onOpenPlanNode, canOpenNode, onOpenNodeReport }: Props): React.ReactElement {
  // The viewport div renders only past the empty-state return, so the observed
  // element arrives (and leaves) with the plan itself. Holding it in state —
  // via the callback ref — is what re-runs the observer effect on that
  // transition: a one-shot mount effect read `containerRef.current` before the
  // div existed and never re-ran, pinning scale to 1 and direction to
  // horizontal for that whole mount order.
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null)
  const [availWidth, setAvailWidth] = useState(0)
  const [availHeight, setAvailHeight] = useState(0)
  // Expert ID → name. The cache fetch lands after the first paint, so this has
  // to be a subscription: without it the cards would keep showing raw ids.
  const experts = useSyncExternalStore(subscribeCache, getCachedExpertProfiles)

  // ── Canvas pan state (PLAN-plan-graph-canvas D2/D3/D4) ──
  // Drag-to-scroll writes scrollLeft/scrollTop straight through a ref — zero
  // re-renders, native scrolling keeps text crisp. The pan offset is NOT
  // persisted and NOT in the store (same deliberate call as the workbench's
  // open state); the view resets on a TOPOLOGY change (D4), never on object
  // identity, because every status flip mints a new plan object mid-run.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean } | null>(null)
  // Swallow flag for the click that follows a real drag. Cleared on the NEXT
  // pointerdown, not only in the click handler — a drag whose click never
  // arrives (tree remount mid-gesture) must not leave a permanently dead
  // button (the launcher's consumeDragClick lesson).
  const swallowClickRef = useRef(false)
  const [panning, setPanning] = useState(false)
  // D4: reset only when the topology signature changes.
  const lastSignatureRef = useRef<string | null>(null)

  // ONE stable ref callback for both consumers (the imperative pan handle and
  // the ResizeObserver's element state). An inline arrow here re-identifies
  // every render → React detaches and reattaches it every commit → infinite
  // re-render (the probe caught it: half the page never settled).
  const viewportRefCb = React.useCallback((el: HTMLDivElement | null) => {
    viewportRef.current = el
    setViewportEl(el)
  }, [])

  const resetView = () => {
    const el = viewportRef.current
    if (!el) return
    el.scrollLeft = 0
    el.scrollTop = 0
  }

  useEffect(() => {
    const signature = plan ? planTopologySignature(plan) : null
    if (signature !== lastSignatureRef.current) {
      lastSignatureRef.current = signature
      resetView()
    }
  }, [plan])

  // The graph must fit the pane, not fight it: scale to the measured box
  // (floor 0.55 — below that, scroll instead of shrinking into mush).
  useEffect(() => {
    if (!viewportEl || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (viewportEl.clientWidth > 0) setAvailWidth(viewportEl.clientWidth)
      if (viewportEl.clientHeight > 0) setAvailHeight(viewportEl.clientHeight)
    })
    ro.observe(viewportEl)
    return () => ro.disconnect()
  }, [viewportEl])

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
      <div style={{ padding: 24, fontSize: 12, color: 'var(--pm-text-muted)', textAlign: 'center' }}>
        <AimOutlined style={{ fontSize: 20, display: 'block', marginBottom: 8, color: 'var(--pm-border)' }} />
        暂无进行中的计划
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pm-text-faint)' }}>让 AI 用 create_plan 拆解任务后，依赖图会显示在这里</div>
      </div>
    )
  }

  const blockedIds = new Set(plan && blockedNodes(plan).map(n => n.id))
  const settled = plan ? plan.nodes.filter(n => n.status !== 'pending').length : 0
  const pct = plan && plan.nodes.length > 0 ? Math.round((settled / plan.nodes.length) * 100) : 0

  const scale = layout ? viewScale(fitRatio(layout)) : 1
  // The reset button answers "I panned and I'm lost" — a graph that fits the
  // viewport cannot be lost, so the button only exists when it overflows (D5).
  const overflows =
    !!layout && availWidth > 0 && (layout.width * scale > availWidth + 1 || layout.height * scale > availHeight + 1)

  const nodeElement = (n: LayoutNode) => {
    // ── 开始 / 结束 anchor pills (PLAN-workbench: 起点/终点) ──
    // Neutral scaffolding throughout: they darken in ink as their end of the
    // plan comes alive (开始 once anything settles, 结束 when it closes).
    if (n.terminal) {
      const done = n.terminal === 'start' ? settled > 0 : plan.completed
      return (
        <g key={n.id} data-node={n.id}>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={13} fill={done ? 'var(--pm-fill)' : 'var(--pm-elevated)'} stroke={done ? 'var(--pm-graph-ink-dim)' : 'var(--pm-border)'} strokeWidth={1.2} />
          <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 3.5} fontSize={10.5} fontWeight={600} fill={done ? 'var(--pm-text)' : 'var(--pm-graph-ink-dim)'} textAnchor="middle">
            {n.description}
          </text>
        </g>
      )
    }
    const node = plan.nodes.find(node => node.id === n.id)!
    const isReady = n.status === 'pending' && node.execution?.status === 'running'
    const isBlocked = n.status === 'pending' && blockedIds.has(n.id)
    const card = n.status !== 'pending' ? CARD[n.status]
      : isReady ? READY_CARD
      : node.execution?.status === 'failed' ? CARD.failed
      : node.execution?.status === 'stopped' ? CARD.skipped
      : !node.execution && isBlocked ? BLOCKED_CARD : CARD.pending
    const lines = wrapDescription(n.description)
    const statusWord = planNodeExecutionLabel(node)
    // The plan stores the expert ID, a person reads the name (expertLabel).
    const who = n.assignee ? expertLabel(experts, n.assignee) : '通用子代理'
    // 声明状态可对照（PLAN-plan-exchange 表达面）：declaredStatus 是子代理自己
    // 申报的结果，row 1 右侧的词是主对话的验收裁定——两者可以不一致，卡片只
    // 在这段落差读得出来的地方补一个词：completed/delivered 卡上 partial →
    // 部分成功（琥珀）、failed → 声明失败（红）。failed/skipped 卡的验收词本
    // 身就是失败，再画一遍只是重复。
    const declared = planNodeDeclaredLabel(node)
    const declaredChip =
      !node.declaredStatus || node.declaredStatus === 'success' || n.status === 'failed' || n.status === 'skipped'
        ? null
        : node.declaredStatus === 'failed' ? `声明${declared}` : declared
    const tooltip = [
      statusWord,
      declared ? `声明 ${declared}` : null,
      n.summary,
      `负责人 ${who}`,
    ].filter(Boolean).join(' · ')
    // Click affordance in the tooltip: a node that can be opened names what it
    // opens, so the drill-down is discoverable without a legend — and a node
    // that opens nothing says nothing, instead of promising a jump it drops.
    const openable = canOpenNode ? canOpenNode(n.id) : (!!n.subConvId || !!n.msgId || !!onOpenPlanNode)
    // Same honesty for the report link: only a card that carries a reportPath
    // AND a handler names it.
    const reportOpenable = !!node.reportPath && !!onOpenNodeReport
    const hints = [
      openable ? (onOpenPlanNode || n.subConvId ? '点击查看子代理会话' : '点击定位到对话') : null,
      reportOpenable ? '点击「查看报告」打开交付报告' : null,
    ].filter(Boolean)
    const hint = hints.length > 0 ? hints.join('；') : undefined
    const title = [tooltip, hint].filter(Boolean).join('\n')
    return (
      <g key={n.id} data-node={n.id} onClick={() => {
        // A drag that crossed the threshold swallows exactly one click (D3).
        if (swallowClickRef.current) return
        if (onOpenPlanNode) { onOpenPlanNode(n.id); return }
        if (n.msgId) onJumpToStep(n.msgId)
      }} style={{ cursor: openable ? 'pointer' : 'default' }}>
        <title>{title}</title>
        <rect
          x={n.x} y={n.y} width={n.w} height={n.h} rx={9}
          fill="var(--pm-elevated)"
          stroke={card.border}
          strokeDasharray={card.dash}
          strokeWidth={isReady ? 1.6 : 1.2}
        />
        {/* Row 1: 编号 left, execution/acceptance status and glyph right. */}
        <text x={n.x + 10} y={n.y + ROW_NUM} fontSize={10} fontWeight={600} fill={card.num}>
          {`n${n.num}`}
        </text>
        <text x={n.x + n.w - 28} y={n.y + ROW_NUM} fontSize={9} fill={card.num} textAnchor="end">
          {statusWord}
        </text>
        {declaredChip && (
          // Row 1 left, after the 编号: the settled words (已完成/已交付，待验收)
          // end-anchored at n.w−28 leave this slot free at every status the chip
          // can coexist with.
          <text x={n.x + 30} y={n.y + ROW_NUM} fontSize={9} fontWeight={600}
            fill={node.declaredStatus === 'failed' ? FAILED_RED : PARTIAL_AMBER}>
            {declaredChip}
          </text>
        )}
        <StatusIcon
          kind={card.icon} x={n.x + n.w - 10 - ICON_SIZE} y={n.y + ROW_NUM - 7.5}
          color={card.iconColor}
        />
        {/* Row 2: 执行者 — who runs it, lighter than the 编号 that names it. A
            delivered report owns the row's right end, so the clip shortens to
            keep the two from ever touching (NODE_W = 180: 11 CJK glyphs + the
            38px link leave an 12px gap). */}
        <text
          x={n.x + 10} y={n.y + ROW_ASSIGNEE} fontSize={10}
          fill={n.assignee ? 'var(--pm-graph-ink-blocked)' : 'var(--pm-graph-ink-hollow)'}
        >
          {clip(n.assignee ? `@${who}` : who, reportOpenable ? 11 : 15)}
        </text>
        {reportOpenable && (
          <text
            className="pm-node-report"
            x={n.x + n.w - 10} y={n.y + ROW_ASSIGNEE} fontSize={9.5}
            fill="var(--pm-link)" textAnchor="end"
            onClick={(e) => {
              // The link is its own click target inside a clickable card: the
              // stop keeps the session drill-down out of it, and a real drag
              // (pan) swallows it exactly like a card click (D3).
              e.stopPropagation()
              if (swallowClickRef.current) return
              onOpenNodeReport?.(n.id)
            }}
          >
            查看报告
          </text>
        )}
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
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--pm-border-hairline)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div
            ref={objectiveRef}
            data-objective
            title={plan.objective}
            style={{
              flex: 1, minWidth: 0,
              fontSize: 12.5, color: 'var(--pm-text)', fontWeight: 600, lineHeight: `${OBJECTIVE_LINE_H}px`,
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
                fontSize: 11, lineHeight: `${OBJECTIVE_LINE_H}px`, color: 'var(--pm-graph-ink)',
              }}
            >
              {objectiveExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--pm-border-hairline)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: 'var(--pm-text)', transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--pm-graph-ink-dim)', flexShrink: 0 }}>
            {plan.completed ? '已完成' : `${settled}/${plan.nodes.length}`}
          </span>
        </div>
      </div>

      {/* Graph — an infinite-canvas-style viewport (PLAN-plan-graph-canvas):
          the graph renders at 100%+ and PANS; drag anywhere scrolls (D2),
          a >3px drag swallows the click that would follow it (D3). */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--pm-graph-canvas)' }}>
        <div
          ref={viewportRefCb}
          data-graph-viewport
          onPointerDown={(e) => {
            // A fresh press clears a stale swallow first (D3: a drag whose
            // click never arrived must not leave a dead button).
            swallowClickRef.current = false
            if (e.button !== 0) return
            const el = viewportRef.current
            if (!el) return
            dragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX, startY: e.clientY,
              scrollLeft: el.scrollLeft, scrollTop: el.scrollTop,
              moved: false,
            }
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current
            const el = viewportRef.current
            if (!drag || !el || e.pointerId !== drag.pointerId) return
            const dx = e.clientX - drag.startX
            const dy = e.clientY - drag.startY
            if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
              drag.moved = true
              swallowClickRef.current = true
              setPanning(true)
              // Capture so a drag that leaves the element keeps panning.
              el.setPointerCapture(e.pointerId)
            }
            if (drag.moved) {
              el.scrollLeft = drag.scrollLeft - dx
              el.scrollTop = drag.scrollTop - dy
            }
          }}
          onPointerUp={() => {
            if (dragRef.current?.moved) setPanning(false)
            dragRef.current = null
          }}
          onPointerCancel={() => {
            if (dragRef.current?.moved) setPanning(false)
            dragRef.current = null
          }}
          style={{
            height: '100%',
            overflow: 'auto',
            cursor: panning ? 'grabbing' : 'grab',
            // The graph is a diagram: drag-selecting card text is nobody's workflow.
            userSelect: 'none',
          }}
        >
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
              .pm-node-report { cursor: pointer; }
              .pm-node-report:hover { text-decoration: underline; }
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
        {overflows && (
          <button
            type="button"
            data-graph-reset
            title="复位视图"
            onClick={() => {
              swallowClickRef.current = false
              resetView()
            }}
            style={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              border: '1px solid var(--pm-border)',
              borderRadius: 6,
              background: 'var(--pm-elevated)',
              color: 'var(--pm-graph-ink)',
              fontSize: 11,
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: 'var(--pm-graph-shadow)',
            }}
          >
            复位
          </button>
        )}
      </div>
    </div>
  )
}
