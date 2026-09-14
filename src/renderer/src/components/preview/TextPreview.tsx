// ── Text/code renderer for the preview pane (PLAN-preview-pane §设计3) ──

import React from 'react'
import { CodeHighlight, PlainCode, resolveCodeLang } from '../common/CodeHighlight'
import { extensionOf } from '../../../../shared/preview/file-kind'

export function TextPreview({ text, path }: { text: string; path: string }): React.ReactElement {
  const lang = resolveCodeLang(extensionOf(path))
  return lang ? <CodeHighlight code={text} lang={lang} /> : <PlainCode code={text} />
}
