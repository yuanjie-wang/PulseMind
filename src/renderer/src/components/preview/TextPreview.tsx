// ── Text/code renderer for the preview pane (PLAN-preview-pane §设计3) ──
//
// Memoized: the workbench pane's width drag re-renders this subtree's parents
// every 40ms tick, and both props are stable strings — without the memo the
// SyntaxHighlighter below re-tokenizes the whole file per tick (the 2026-09-19
// 「预览 python 文件时拖动侧边窗口非常卡顿」 report; measured by
// probe-preview-drag.mjs).

import React from 'react'
import { CodeHighlight, PlainCode, resolveCodeLang } from '../common/CodeHighlight'
import { extensionOf } from '../../../../shared/preview/file-kind'

export const TextPreview = React.memo(function TextPreview({ text, path }: { text: string; path: string }): React.ReactElement {
  const lang = resolveCodeLang(extensionOf(path))
  return lang ? <CodeHighlight code={text} lang={lang} /> : <PlainCode code={text} />
})
