// ── Text/code renderer for the preview pane (PLAN-preview-pane §设计3) ──
//
// Memoized: the workbench pane's width drag re-renders this subtree's parents
// every 40ms tick, and both props are stable strings — without the memo the
// SyntaxHighlighter below re-tokenizes the whole file per tick (the 2026-09-19
// 「预览 python 文件时拖动侧边窗口非常卡顿」 report; measured by
// probe-preview-drag.mjs).
//
// Line numbers are on for highlighted files (PLAN-ide-linkage 1a): read prints
// absolute line numbers and edit errors cite them — the preview is the last leg
// of that coordinate system. Unknown-extension files fall to PlainCode, which
// has no gutter (an honest gap, recorded in the plan) — so do files above
// HIGHLIGHT_MAX_CHARS (view-cap.ts): skipping the tokenizer is worth more than
// the gutter at that size.

import React from 'react'
import { CodeHighlight, PlainCode, resolveCodeLang } from '../common/CodeHighlight'
import { extensionOf } from '../../../../shared/preview/file-kind'
import { shouldSkipHighlight } from '../../../../shared/preview/view-cap'

export const TextPreview = React.memo(function TextPreview({ text, path, revealLine }: { text: string; path: string; revealLine?: number }): React.ReactElement {
  const lang = resolveCodeLang(extensionOf(path))
  // Perf (2026-10-30): the tokenizer, not the DOM, is the multi-second cost —
  // above HIGHLIGHT_MAX_CHARS the file renders as a plain <pre>, which scrolls
  // fine at several times that size. Line numbers and reveal are lost there:
  // the coordinate system matters for files small enough to edit, and a
  // >200KB file landing mid-reveal is the rare shape this trades away.
  if (!lang || shouldSkipHighlight(text)) return <PlainCode code={text} />
  return <CodeHighlight code={text} lang={lang} lineNumbers revealLine={revealLine} />
})
