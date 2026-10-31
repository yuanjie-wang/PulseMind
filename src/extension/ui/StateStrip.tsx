/** The panel's status strip between transcript and composer (2026-10-31
 *  PLAN-extension-panel-state-surface 交付物3): the three states the shared
 *  mirror has been folding since their events landed — plan, file-change
 *  ledger, last compaction — finally rendered. The data was always here; this
 *  file is only the missing presentation surface.
 *
 * Deliberate honesty boundaries (the plan's 诚实边界 section):
 *  - the plan renders as a LINEAR CHECKLIST, never the desktop's hand-drawn
 *    DAG (PlanGraphView is a 37KB SVG surface that cannot ride a content
 *    script), and nodes do not jump anywhere — the panel has no conversation
 *    navigation;
 *  - the file list is read-only ink — the panel has no workspace, no preview
 *    pane, no diff view;
 *  - colors are the light-theme literal resolutions of the desktop tokens
 *    (palette.ts --pm-ws-created #587c0c / --pm-ws-modified #895503, the
 *    VS Code light-modified pair), same rule as every other panel surface. */

import { useState } from 'react'
import type { Plan, PlanNode, PlanNodeStatus } from '../../shared/types/plan'
import type { CompactionEvent, SessionFileChange } from '../../shared/agent-protocol'
import { Icon } from './icons'

/** Light-theme ink for the change kinds — the desktop's own tokens resolved to
 *  literals (the panel is hardcoded light by ruling). */
const INK_CREATED = '#587c0c'
const INK_MODIFIED = '#895503'

/** k-formatted token count, same shape as the desktop action row's stats. */
function fmtTokens(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`
  return String(n)
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.round((Date.now() - then) / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

// ── 计划 ─────────────────────────────────────────────────────────────

const PLAN_GLYPHS: Record<PlanNodeStatus, { glyph: string; color: string; label: string }> = {
  pending: { glyph: '○', color: '#bfbfbf', label: '待处理' },
  blocked: { glyph: '⊘', color: '#d46b08', label: '受阻' },
  completed: { glyph: '✓', color: '#52c41a', label: '已完成' },
  failed: { glyph: '✕', color: '#ff4d4f', label: '失败' },
  skipped: { glyph: '↷', color: '#999', label: '已跳过' },
  split: { glyph: '⤳', color: '#1677ff', label: '已拆分' },
}

function PlanNodeRow({ node, current }: { node: PlanNode; current: boolean }): React.JSX.Element {
  const state = PLAN_GLYPHS[node.status] ?? PLAN_GLYPHS.pending
  const running = node.execution?.status === 'running'
  const queued = node.execution?.status === 'queued'
  return (
    <div className={`pm-plan-node${current ? ' pm-plan-node-current' : ''}`} data-plan-node={node.id}>
      <span className="pm-plan-node-glyph" style={{ color: running || queued ? '#1677ff' : state.color }}>
        {running ? <Icon name="loading" spin /> : queued ? <Icon name="hourglass" /> : state.glyph}
      </span>
      <span className="pm-plan-node-text" title={node.summary}>
        {node.description}
        {node.assignee ? <span className="pm-plan-node-assignee"> · {node.assignee}</span> : null}
      </span>
    </div>
  )
}

function PlanStrip({ plan }: { plan: Plan }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const settled = plan.nodes.filter((n) => n.status !== 'pending').length
  const pct = plan.nodes.length > 0 ? Math.round((settled / plan.nodes.length) * 100) : 0
  const running = plan.nodes.find((n) => n.execution?.status === 'running')
  return (
    <div className="pm-state-section" data-state-plan="">
      <button className="pm-state-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'caretDown' : 'caretRight'} />
        <span className="pm-state-title">计划</span>
        <span className="pm-state-objective">{plan.objective}</span>
        <span className="pm-state-meta">
          {running ? <span className="pm-plan-running">执行中</span> : null}
          {settled}/{plan.nodes.length}
        </span>
      </button>
      <div className="pm-plan-bar">
        <div className="pm-plan-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {open ? (
        <div className="pm-state-body">
          {plan.nodes.map((node) => (
            <PlanNodeRow key={node.id} node={node} current={plan.currentNodeId === node.id} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── 文件改动 ─────────────────────────────────────────────────────────

function FileChangesStrip({ changes }: { changes: SessionFileChange[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="pm-state-section" data-state-files="">
      <button className="pm-state-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'caretDown' : 'caretRight'} />
        <span className="pm-state-title">本会话改动</span>
        <span className="pm-state-meta">{changes.length} 个文件</span>
      </button>
      {open ? (
        <div className="pm-state-body">
          {changes.map((c, i) => (
            <div key={`${c.path}-${i}`} className="pm-filechange-row" title={c.path}>
              <span className="pm-filechange-kind" style={{ color: c.kind === 'created' ? INK_CREATED : INK_MODIFIED }}>
                {c.kind === 'created' ? '新建' : '修改'}
              </span>
              <span className="pm-filechange-path">{c.path}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── 已压缩 ───────────────────────────────────────────────────────────

function CompactionChip({ event }: { event: CompactionEvent }): React.JSX.Element {
  const freed = Math.max(0, event.tokensBefore - event.tokensAfter)
  // request = the drop already landed in the outgoing copy; the prewarm shapes
  // (post-turn/manual/tool) warm the summary now and drop on the NEXT request.
  const landed = event.source === 'request'
  const title = `策略: ${event.strategies.join(' → ')} · ${event.tokensBefore} → ${event.tokensAfter} tokens`
  return (
    <div className="pm-state-section" data-state-compaction="">
      <span className="pm-compaction-chip" title={title}>
        已压缩 · 丢弃{event.droppedMessages} · 释放{fmtTokens(freed)}
        <span className="pm-compaction-landed">{landed ? '已生效' : '下次请求生效'}</span>
      </span>
    </div>
  )
}

// ── 出口 ─────────────────────────────────────────────────────────────

export function StateStrip({ plan, fileChanges, lastCompaction }: {
  plan: Plan | null
  fileChanges: SessionFileChange[]
  lastCompaction: CompactionEvent | null
}): React.JSX.Element | null {
  const hasPlan = !!plan && plan.nodes.length > 0
  const hasFiles = fileChanges.length > 0
  if (!hasPlan && !hasFiles && !lastCompaction) return null
  return (
    <div className="pm-state-strip" data-state-strip="">
      {hasPlan ? <PlanStrip plan={plan!} /> : null}
      {hasFiles ? <FileChangesStrip changes={fileChanges} /> : null}
      {lastCompaction ? <CompactionChip event={lastCompaction} /> : null}
    </div>
  )
}

export { relativeTime }
