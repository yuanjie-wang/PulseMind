/**
 * The approval area: the 跳过 / 运行 pair for calls the ladder is holding, laid out
 * under a *collapsed* header so answering never needs an expansion. Those two
 * buttons otherwise live only in the tool card — at the bottom of two collapsed
 * layers (the execution segment, then the tool card) — which made 审批 cost two
 * clicks: "需要展开折叠的消息至最里层".
 *
 * It renders only while the layer that owns it is collapsed, and expanding hands
 * the decision back to the card, so the pair is never on screen twice. It is a
 * sibling of the header, not a child: clicking a button must not toggle anything.
 *
 * Shared by the execution segment (one row per held call) and the tool block (a
 * single call) — hence `identity`, since the segment's collapsed header names
 * nothing while the tool block's own header sits directly above the area.
 */
import React from 'react'
import { Button, Space } from 'antd'
import { CloseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons'
import type { ToolUseBlock } from '../../types/agent'
import { useTranslation } from '../../i18n/useTranslation'
import { toolBlockSummary, toolDisplayName } from './tool-summary'

// The amber of the held tool headers (CollapsibleToolBlock's needsAction tint and
// ExecutionSegment's header text), so the area reads as the same state.
const areaStyle: React.CSSProperties = {
  margin: '4px 0',
  padding: '8px 10px',
  background: 'var(--pm-warn-bg)',
  border: '1px solid var(--pm-warn-border)',
  borderRadius: 6
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0
}

const nameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--pm-text-strong)',
  flexShrink: 0
}

const summaryStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--pm-text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1
}

export function ApprovalArea({
  blocks,
  onApproveTool,
  onRejectTool,
  identity = false
}: {
  blocks: ToolUseBlock[]
  onApproveTool: (toolUseId: string) => void
  onRejectTool: (toolUseId: string) => void
  /** Repeat the tool name and its one-line summary in every row: the execution
   *  segment needs it (its collapsed header names nothing), the tool block's own
   *  header sits directly above and already shows both. */
  identity?: boolean
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (blocks.length === 0) return null
  return (
    // data-approval-area: the probe hook (scripts/probe-chat-approval.mjs). The
    // amber background is shared with a held tool header, so counting "amber boxes"
    // cannot tell the two apart — this can.
    <div style={areaStyle} data-approval-area="">
      {blocks.map((block, i) => (
        <div key={block.id} style={{ ...rowStyle, marginTop: i === 0 ? 0 : 6 }}>
          {identity && <span style={nameStyle}>{toolDisplayName(block.name, t)}</span>}
          {identity && (
            // The full description on hover: the summary is one line, truncated.
            <span style={summaryStyle} title={String(block.input?.description ?? '')}>
              {toolBlockSummary(block, t)}
            </span>
          )}
          <Space size="small" style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <Button size="small" icon={<CloseCircleOutlined />} onClick={() => onRejectTool(block.id)}>
              {t('commandCard.skip')}
            </Button>
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => onApproveTool(block.id)}>
              {t('commandCard.run')}
            </Button>
          </Space>
        </div>
      ))}
    </div>
  )
}
