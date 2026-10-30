// ── Project window's explorer region (2026-10-30) ──
// The immersive project window's left-hand surface: a WorkspacePane (directory
// tree | file preview, with its own address bar and tree↔preview divider)
// docked beside the conversation, which is passed in as `children`.
//
// Deliberately a thin composition rather than a new file surface: the project
// window must show the SAME tree/preview the main window's workbench shows
// (change inks, search, diff panel, edit/save) — reusing WorkspacePane is what
// makes that automatic. The only thing this file owns is the explorer↔chat
// divider, clamped at every consumption against the live row (the workbench
// pane's clamp-every-consumption lesson).

import React, { useEffect, useRef, useState } from 'react'
import { clampExplorerWidth, COLUMN_DRAG_HANDLE_WIDTH } from '../../../shared/ui/layout-widths'
import { useSecondaryLayoutStore } from '../stores/secondaryLayoutStore'
import { useColumnDrag } from '../hooks/useColumnDrag'
import { WorkspacePane } from '../components/workbench/WorkspacePane'

interface Props {
  conversationId: string | undefined
  /** The conversation column, rendered right of the divider. */
  children: React.ReactNode
}

export function ProjectExplorer({ conversationId, children }: Props): React.ReactElement {
  // The row's live width — the clamp input for both the drag and the render.
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [rowWidth, setRowWidth] = useState(0)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => setRowWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rawExplorerWidth = useSecondaryLayoutStore((s) => s.explorerWidth)
  const setExplorerWidth = useSecondaryLayoutStore((s) => s.setExplorerWidth)
  const drag = useColumnDrag({
    getStartWidth: () =>
      clampExplorerWidth(
        useSecondaryLayoutStore.getState().explorerWidth,
        rowRef.current?.getBoundingClientRect().width ?? 0,
      ),
    // The explorer is LEFT-aligned in the row and the handle rides its right
    // edge — the border must FOLLOW the pointer (rightward travel widens the
    // explorer). The mirrored direction belongs to right-docked panes only.
    direction: 1,
    clamp: (w) => clampExplorerWidth(w, rowRef.current?.getBoundingClientRect().width ?? 0),
    apply: setExplorerWidth,
  })
  const effExplorerWidth = clampExplorerWidth(rawExplorerWidth, rowWidth)

  return (
    <div
      ref={rowRef}
      style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch', position: 'relative' }}
    >
      <div
        data-pm-explorer-column
        style={{
          width: effExplorerWidth,
          flexShrink: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--pm-separator-faint)',
        }}
      >
        <WorkspacePane conversationId={conversationId} />
      </div>
      <div data-pm-chat-column style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
      {/* Drag handle, straddling the separator — a sibling of both columns
          (the explorer column's overflow:hidden would clip it). */}
      <div
        data-pm-explorer-drag-handle
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        style={{
          position: 'absolute',
          left: effExplorerWidth - COLUMN_DRAG_HANDLE_WIDTH / 2,
          top: 0,
          bottom: 0,
          width: COLUMN_DRAG_HANDLE_WIDTH,
          cursor: 'col-resize',
          zIndex: 2,
          background: 'transparent',
        }}
      />
    </div>
  )
}
