// ── CodeMirror mount for the preview pane — BOTH modes (2026-10-31 CM batch:
//    edit; 2026-11-01 PLAN-codemirror-view: view) ──
//
// Thin shell over the lazy CodeMirror editor — the CM chunk stays out of the
// entry bundle (same split the LazyDocxPreview rides). Since the view
// unification, text files render through this component in BOTH modes: view
// (readOnly, no onChange — see CodeMirrorEditor header note 3) and edit
// (value/onChange/onSave). Switching modes reconfigures the editor in place;
// the props contract for the edit half is unchanged from the textarea era:
// EOL/BOM handling in stores/preview-edit.ts, ⌘S/Ctrl+S asks the parent to
// save, Tab indents via indentUnit ('  ', the old textarea's two spaces).

import React, { Suspense } from 'react'

interface Props {
  value: string
  /** Edit half only (guard: undefined in view — a live listener would feed
   *  the adopted disk text back into the draft setter). */
  onChange?: (next: string) => void
  /** Edit half only: ⌘S / Ctrl+S. */
  onSave?: () => void
  /** Drives the CM grammar via the shared language table; absent/unknown =
   *  rendered without highlighting (honest gap, carried from PlainCode). */
  path?: string
  /** View half (default false). */
  readOnly?: boolean
  /** 1-based reveal line + flash; null drops the decoration. */
  revealLine?: number | null
  /** Agent-change review diff base (view half only，2026-11-01); null = no diff. */
  viewDiffBase?: string | null
}

const CodeMirrorEditor = React.lazy(() => import('./CodeMirrorEditor'))

export function FileEditor({ value, onChange, onSave, path, readOnly, revealLine, viewDiffBase }: Props): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>…</div>
      }
    >
      <CodeMirrorEditor
        value={value}
        onChange={onChange}
        onSave={onSave}
        path={path}
        readOnly={readOnly}
        revealLine={revealLine}
        viewDiffBase={viewDiffBase}
      />
    </Suspense>
  )
}
