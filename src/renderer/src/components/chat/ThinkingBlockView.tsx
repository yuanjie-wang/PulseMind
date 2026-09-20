import React, { useState } from 'react'
import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons'
import type { ThinkingBlock } from '../../../../shared/types/agent'

export function ThinkingBlockView({
  block
}: {
  block: ThinkingBlock
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const lines = block.thinking.split('\n')
  const preview = lines.length > 1
    ? lines[0].slice(0, 80) + `… (${lines.length} lines)`
    : block.thinking.slice(0, 80) + (block.thinking.length > 80 ? '…' : '')

  return (
    <div
      style={{
        margin: '6px 0',
        borderLeft: '2px solid var(--pm-border-strong)',
        paddingLeft: 10,
        cursor: 'pointer',
        userSelect: 'none'
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ color: 'var(--pm-text-quiet)', fontSize: 13, lineHeight: 1.6 }}>
        <span style={{ marginRight: 6, fontSize: 11 }}>{expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}</span>
        <span style={{ fontWeight: 500 }}>Thinking</span>
        {!expanded && (
          <span style={{ marginLeft: 8, color: 'var(--pm-text-soft)', fontSize: 12 }}>{preview}</span>
        )}
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
