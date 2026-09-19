// ── Markdown renderer for the preview pane (PLAN-preview-pane §设计3) ──
// Same XMarkdown stack as the chat (CodeBlock highlighting, LocalImage with
// the lightbox, latex), plus the FileRefChip pipeline so [file:...] refs
// inside previewed documents render as chips like they do in messages.

import React from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { CodeBlock } from '../chat/CodeBlock'
import { LocalImage } from '../chat/LocalImage'
import { FileChipComponent, preprocessText } from '../chat/FileRefChip'

const COMPONENTS: Record<string, React.ComponentType<any>> = {
  code: CodeBlock,
  img: LocalImage,
  'file-chip': FileChipComponent,
  'local-image': LocalImage,
}

const CONFIG = { extensions: Latex() }

// `text` is a stable string across the pane-width drag's re-renders; without
// the memo every 40ms tick re-runs preprocessText and re-parses the whole
// document (same jank class as the python highlighter — probe-preview-drag.mjs).
export const MarkdownPreview = React.memo(function MarkdownPreview({ text }: { text: string }): React.ReactElement {
  return (
    <div className="x-markdown-light" style={{ padding: '12px 16px', fontSize: 13, lineHeight: 1.7 }}>
      <XMarkdown content={preprocessText(text)} components={COMPONENTS} config={CONFIG} />
    </div>
  )
})
