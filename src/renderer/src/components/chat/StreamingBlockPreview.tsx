import React from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import type { ContentBlock, ToolUseBlock } from '../../../../shared/types/agent'
import { CodeBlock } from './CodeBlock'
import { LocalImage } from './LocalImage'
import { useMarkdownThemeClass } from '../../theme/mode'

const assistantBubbleStyle: React.CSSProperties = {
  borderRadius: 12,
  padding: '4px 0',
  width: '100%',
  fontSize: 14,
  lineHeight: 1.6
}

export function StreamingBlockPreview({
  blocks
}: {
  blocks: ContentBlock[]
}): React.ReactElement | null {
  // Show text + tool name badges during streaming — full tool details go to committed ExecutionSegment
  const displayBlocks = blocks.filter((b) => b.type === 'text' || b.type === 'tool_use')
  const mdClass = useMarkdownThemeClass()
  if (displayBlocks.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        marginBottom: 12
      }}
    >
      <div
        style={{
          ...assistantBubbleStyle,
          paddingLeft: 12
        }}
      >
        {displayBlocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className={mdClass} style={{ color: 'var(--pm-text-strong)', lineHeight: 1.6 }}>
                <XMarkdown content={block.text} components={{ code: CodeBlock, img: LocalImage }} config={{ extensions: Latex() }} />
              </div>
            )
          }
          // Tool use entry — shown as plain text during streaming, replaced by ExecutionSegment on commit
          if (block.type === 'tool_use') {
            const tb = block as ToolUseBlock
            return (
              <div key={i} style={{ color: 'var(--pm-text-body)', fontSize: 14, lineHeight: 1.6, padding: '4px 0' }}>
                {tb.name} 指令生成中...
              </div>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
