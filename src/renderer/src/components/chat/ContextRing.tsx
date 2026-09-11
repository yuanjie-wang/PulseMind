import React from 'react'
import { Tooltip } from 'antd'
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
  if (total <= 0) return null
  const pct = Math.min(used / total, 1)
  // `diameter` asks for the drawn circle's on-screen size, for lining it up with a control
  // of that size. The box does not change, so this never shifts the surrounding layout.
  const r = diameter == null ? DEFAULT_RING_RADIUS : (diameter - RING_STROKE) / 2 - RING_INSET
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)
  // Shared by the ring's own label and the tooltip, so the two never disagree.
  const percent = Math.round(pct * 100)
  const formatNum = (n: number) => n >= 10240 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}k` : n.toLocaleString()

  return (
    <Tooltip title={`${formatNum(used)}/${formatNum(total)}｜${percent}%`}>
      <svg width={RING_BOX} height={RING_BOX} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} style={{ display: 'block' }}>
        <circle cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none" stroke="#d9d9d9" strokeWidth={RING_STROKE} />
        <circle
          cx={RING_CENTER} cy={RING_CENTER} r={r} fill="none"
          stroke="#666" strokeWidth={RING_STROKE} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset}
          transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
        <text
          x={RING_CENTER} y={RING_CENTER} textAnchor="middle" dominantBaseline="central"
          fill="#888" fontSize={7.5} fontWeight={700}
          fontFamily="'SF Mono', 'Menlo', 'Consolas', monospace"
        >
          {percent}
        </text>
      </svg>
    </Tooltip>
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
