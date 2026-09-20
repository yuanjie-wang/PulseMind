import React from 'react'
import { Tooltip } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import type { AgentMessage, ToolUseBlock, ToolResultBlock } from '../../types/agent'

// ── Context usage ring ────────────────────────────────────────────────

// The ring is drawn inside a fixed box, and the drawn circle is inset within it, so the
// box is both the layout size and the largest circle that fits.
const RING_BOX = 24
const RING_CENTER = RING_BOX / 2
const RING_STROKE = 2.5
const DEFAULT_RING_RADIUS = 9
// Keeps the stroke's outer edge off the box edge, where it would be antialiased away.
const RING_INSET = 0.25

export function ContextRing({ used, total, diameter }: { used: number; total: number; diameter?: number }): React.ReactElement | null {
  // Leads the body so the hook still runs on the bail-out path below.
  const { t } = useTranslation()
  if (total <= 0) return null
  const pct = Math.min(used / total, 1)
  // `diameter` asks for the drawn circle's on-screen size, for lining it up with a control
  // of that size. The box does not change, so this never shifts the surrounding layout.
  const r = diameter == null ? DEFAULT_RING_RADIUS : (diameter - RING_STROKE) / 2 - RING_INSET
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)
  // The arc carries no label of its own; the tooltip is where the numbers are read out.
  const percent = Math.round(pct * 100)
  // Both figures read in thousands, the unit the label is written in.
  const inK = (n: number) => `${(n / 1024).toFixed(1)}K`

  return (
    <>
      {/* The hover disc is a CSS rule rather than mouse handlers: Tooltip clones its child
          and attaches its own hover props, which a plain `:hover` rule can't be clobbered by. */}
      <style>{`
        .pm-context-ring { display: inline-flex; border-radius: 50%; }
        .pm-context-ring:hover { background-color: var(--pm-hover-faint); }
      `}</style>
      <Tooltip title={t('chatView.contextRing.tooltip', { percent, used: inK(used), total: inK(total) })}>
        <span className="pm-context-ring">
          <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} style={{ display: 'block' }}>
            {/* The two strokes ride `style` rather than the presentation attributes:
                a `stroke="var(--x)"` attribute is not a CSS declaration everywhere,
                a `style` value always is. */}
            <circle cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none" strokeWidth={RING_STROKE} style={{ stroke: 'var(--pm-border)' }} />
            <circle
              cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none"
              strokeWidth={RING_STROKE} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={offset}
              transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
              style={{ transition: 'stroke-dashoffset 0.3s ease', stroke: 'var(--pm-text-secondary)' }}
            />
          </svg>
        </span>
      </Tooltip>
    </>
  )
}

/**
 * Estimate context usage for a message list: prefer the latest message's real
 * inputTokens (cumulative across the whole conversation), otherwise estimate
 * from character counts. Shared by the main header and sub-agent preview.
 */
export function estimateContextUsed(messages: AgentMessage[]): number {
  if (!messages.length) return 0
  const lastWithTokens = [...messages].reverse().find(m => m.inputTokens != null)
  if (lastWithTokens && lastWithTokens.inputTokens != null) {
    return lastWithTokens.inputTokens
  }
  let total = 0
  const est = (text: string) => Math.ceil(text.length / 2)
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text') total += est(block.text)
      else if (block.type === 'tool_use') total += est(JSON.stringify((block as ToolUseBlock).input || {}))
      else if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock
        if (tr.content) total += est(tr.content)
        if (tr.imageData) total += 500
      }
    }
  }
  return total
}
