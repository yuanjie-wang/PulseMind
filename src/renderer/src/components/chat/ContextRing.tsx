import React from 'react'
import { Tooltip } from 'antd'
import type { AgentMessage, ToolUseBlock, ToolResultBlock } from '../../types/agent'

// ── Context usage ring ────────────────────────────────────────────────

export function ContextRing({ used, total }: { used: number; total: number }): React.ReactElement | null {
  if (total <= 0) return null
  const pct = Math.min(used / total, 1)
  const r = 9
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)
  const formatNum = (n: number) => n >= 10240 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}k` : n.toLocaleString()

  return (
    <Tooltip title={`${formatNum(used)} / ${formatNum(total)}`}>
      <svg width={24} height={24} viewBox="0 0 24 24" style={{ display: 'block' }}>
        <circle cx={12} cy={12} r={r} fill="none" stroke="#d9d9d9" strokeWidth={2.5} />
        <circle
          cx={12} cy={12} r={r} fill="none"
          stroke="#666" strokeWidth={2.5} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset}
          transform="rotate(-90 12 12)"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
        <text
          x={12} y={12} textAnchor="middle" dominantBaseline="central"
          fill="#888" fontSize={7.5} fontWeight={700}
          fontFamily="'SF Mono', 'Menlo', 'Consolas', monospace"
        >
          {Math.round(pct * 100)}
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
