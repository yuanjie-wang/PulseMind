import React, { useState } from 'react'
import { CheckOutlined, LoadingOutlined, LockOutlined, RightOutlined } from '@ant-design/icons'
import type { ThinkingBlock } from '../../../../shared/types/agent'

/** Collapsed one-liner. Settled: the head of the reasoning + a line count.
 *  Streaming: the TAIL — the head is static from the first second, the tail is
 *  what tells the user the stream is alive (the strip may run for minutes).
 *  40 chars: the newest bytes must survive the one-line clamp below on a wide
 *  column, and 80 CJK chars at font-size 12 does not. */
const PREVIEW_CHARS = 40

function previewOf(thinking: string, streaming?: boolean): string {
  if (!streaming) {
    const lines = thinking.split('\n')
    return lines.length > 1
      ? lines[0].slice(0, 80) + `… (${lines.length} lines)`
      : thinking.slice(0, 80) + (thinking.length > 80 ? '…' : '')
  }
  const tail = thinking.slice(-PREVIEW_CHARS).replace(/\s+/g, ' ').trim()
  return `…${tail} (${thinking.length} chars)`
}

/** The completed check's green — the terminal family's own palette, the same
 *  literal the tool blocks settle with (deliberately not a theme var). */
const DONE_GREEN = '#4ec9b0'

/** The row is a sibling of the CollapsibleToolBlock rows inside an expanded
 *  group, so it is built EXACTLY like one (user rulings 2026-10-25: same
 *  chrome, then COMPACT together — margin '2px 0', padding '3px 10px',
 *  lineHeight 1.4 head, lineHeight-1 glyph slot — bold 12px label, muted 12px
 *  summary, transparent resting background with the one-step hover fill. The
 *  only deltas vs a tool row: the chevron on the right edge, and the glyph
 *  slot moves spinner (streaming) → green check (settled). */
const HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  lineHeight: 1.4,
  background: 'transparent',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--pm-text-body)',
  userSelect: 'none',
  border: '1px solid transparent',
  transition: 'background 0.15s',
  overflow: 'hidden'
}
const hover = (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'var(--pm-fill-hover)' }
const unhover = (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'transparent' }
const GLYPH: React.CSSProperties = { fontSize: 14, lineHeight: 1, flexShrink: 0, width: 18, textAlign: 'center' }
const LABEL: React.CSSProperties = { fontWeight: 600, color: 'var(--pm-text-strong)', flexShrink: 0, fontSize: 12 }
const SUMMARY: React.CSSProperties = {
  color: 'var(--pm-text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  fontSize: 12
}
const CHEVRON: React.CSSProperties = {
  color: 'var(--pm-text-faint)',
  fontSize: 11,
  flexShrink: 0,
  marginLeft: 4,
  transition: 'transform 0.2s'
}

export function ThinkingBlockView({
  block,
  streaming
}: {
  block: ThinkingBlock
  /** Live tail: the block is still receiving reasoning deltas. */
  streaming?: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const preview = previewOf(block.thinking, streaming)

  return (
    <div style={{ margin: '2px 0' }}>
      <div
        data-thinking-head=""
        onClick={() => setExpanded(!expanded)}
        style={HEAD}
        onMouseEnter={hover}
        onMouseLeave={unhover}
      >
        <span style={GLYPH}>
          {streaming ? <LoadingOutlined spin /> : <CheckOutlined style={{ color: DONE_GREEN }} />}
        </span>
        <span style={LABEL}>深度思考</span>
        <span style={SUMMARY}>{preview}</span>
        <RightOutlined style={{ ...CHEVRON, transform: expanded ? 'rotate(90deg)' : undefined }} />
      </div>
      {expanded && (
        <pre
          style={{
            margin: '6px 0 0 0',
            padding: 8,
            background: 'var(--pm-fill-soft)',
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--pm-text-body)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 400,
            overflowY: 'auto',
            cursor: 'text',
            userSelect: 'text'
          }}
        >
          {block.thinking}
        </pre>
      )}
    </div>
  )
}

/** The redacted variant — same row construction, lock glyph, nothing to expand. */
export function ThinkingRedactedRow(): React.ReactElement {
  return (
    <div style={{ margin: '2px 0' }}>
      <div style={{ ...HEAD, cursor: 'default' }}>
        <span style={{ ...GLYPH, color: 'var(--pm-text-muted)' }}>
          <LockOutlined />
        </span>
        <span style={LABEL}>深度思考</span>
        <span style={SUMMARY}>（已隐藏）</span>
      </div>
    </div>
  )
}
