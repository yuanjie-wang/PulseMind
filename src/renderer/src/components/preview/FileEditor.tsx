// ── File editor for the preview pane (2026-10-31 CM batch: phase 2 landed) ──
//
// Thin shell over the lazy CodeMirror editor — the CM chunk stays out of the
// entry bundle (same split the LazyDocxPreview rides). The props contract is
// unchanged from the textarea era: value/onChange/onSave, EOL/BOM handling in
// stores/preview-edit.ts, ⌘S/Ctrl+S asks the parent to save. Tab indents via
// indentUnit ('  ', the old textarea's two spaces).

import React, { Suspense } from 'react'

interface Props {
  value: string
  onChange: (next: string) => void
  onSave: () => void
  /** Drives the CM grammar via the shared language table; absent/unknown =
   *  editable without highlighting (PlainCode's honest gap). */
  path?: string
}

const CodeMirrorEditor = React.lazy(() => import('./CodeMirrorEditor'))

export function FileEditor({ value, onChange, onSave, path }: Props): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>…</div>
      }
    >
      <CodeMirrorEditor value={value} onChange={onChange} onSave={onSave} path={path} />
    </Suspense>
  )
}
