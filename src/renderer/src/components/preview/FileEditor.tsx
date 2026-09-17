// ── File editor for the preview pane (PLAN-preview-edit T2, D2) ──
// Zero-dependency monospace <textarea> filling the pane. Deliberately not
// CodeMirror/Monaco: a 380px pane and the repo's zero-dep baseline; the
// CodeMirror upgrade (line numbers / highlight / large files) is phase 2.
// Tab inserts two spaces instead of moving focus; ⌘S/Ctrl+S asks the parent
// to save. EOL/BOM handling lives in stores/preview-edit.ts, not here — the
// textarea hands back LF text and the store restores the file's shape on save.

import React from 'react'

interface Props {
  value: string
  onChange: (next: string) => void
  onSave: () => void
}

const MONO_STACK = "'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace"

export function FileEditor({ value, onChange, onSave }: Props): React.ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart, selectionEnd } = el
      const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
      onChange(next)
      // Restore the caret after the controlled re-render.
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + 2
      })
    }
  }

  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      wrap="off"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        minHeight: 200,
        resize: 'none',
        border: 'none',
        outline: 'none',
        padding: 12,
        fontFamily: MONO_STACK,
        fontSize: 12,
        lineHeight: 1.6,
        color: '#333',
        background: '#fff',
        whiteSpace: 'pre',
        overflow: 'auto',
        tabSize: 2,
      }}
    />
  )
}
