// ── 工作区 merged view (2026-10-25, 用户裁定「工作区和文件预览合并」) ──
// Top-bottom, then left-right: the address bar spans the pane (selected
// file/folder's absolute path + 打开 + a 更多 menu holding the preview
// actions), below it the tree (left, with its own search + refresh) sits
// beside the preview area (right), which is ALWAYS visible — the empty hint
// when no file is open. Selection lives here: the tree writes it, the address
// bar mirrors it, and an agent-opened preview (openFile without a click)
// highlights itself through the same state.
//
// The tree↔preview divider is draggable (2026-10-26): the tree column used
// to be a fixed 40% share of the row; it is now a persisted px width
// (workbenchStore.treeWidth) with a 6px handle straddling the separator.
// The stored value is clamped at EVERY consumption against the row the
// ResizeObserver measures — a width dragged under one pane size survives
// onto a smaller one (the workbench pane's same lesson).

import React, { useEffect, useRef, useState } from 'react'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { clampTreeWidth, COLUMN_DRAG_HANDLE_WIDTH } from '../../../../shared/ui/layout-widths'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { PreviewPane } from '../preview/PreviewPane'
import { WorkspaceAddressBar } from './WorkspaceAddressBar'
import { WorkspaceTree } from './WorkspaceTree'

interface Props {
  conversationId: string | undefined
}

export function WorkspacePane({ conversationId }: Props): React.ReactElement {
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

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

  const rawTreeWidth = useWorkbenchStore((s) => s.treeWidth)
  const setTreeWidth = useWorkbenchStore((s) => s.setTreeWidth)
  const drag = useColumnDrag({
    getStartWidth: () => clampTreeWidth(useWorkbenchStore.getState().treeWidth, rowRef.current?.getBoundingClientRect().width ?? 0),
    // The tree column is LEFT-aligned in the row and the handle rides its
    // right edge — the border must FOLLOW the pointer (rightward travel
    // widens the tree). The mirrored direction belongs to right-docked
    // panes only (WorkbenchPane's own handle, which grows leftward).
    direction: 1,
    clamp: (w) => clampTreeWidth(w, rowRef.current?.getBoundingClientRect().width ?? 0),
    apply: setTreeWidth,
  })
  const effTreeWidth = clampTreeWidth(rawTreeWidth, rowWidth)

  // A preview opened without a click (agent write auto-preview, chat file
  // chips) must still name itself in the address bar and highlight its row.
  useEffect(() => {
    if (activePath) setSelectedPath(activePath)
  }, [activePath])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <WorkspaceAddressBar conversationId={conversationId} selectedPath={selectedPath} />
      <div ref={rowRef} style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch', position: 'relative' }}>
        <div
          data-pm-tree-column
          style={{
            width: effTreeWidth,
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid var(--pm-separator-faint)',
          }}
        >
          <WorkspaceTree conversationId={conversationId} selectedPath={selectedPath} onSelectPath={setSelectedPath} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <PreviewPane conversationId={conversationId} />
        </div>
        {/* Drag handle, straddling the separator between the two columns —
            a sibling of both (the tree column's overflow:hidden would clip
            it), positioned and stacked above the static preview content. */}
        <div
          data-pm-tree-drag-handle
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
          style={{
            position: 'absolute',
            left: effTreeWidth - COLUMN_DRAG_HANDLE_WIDTH / 2,
            top: 0,
            bottom: 0,
            width: COLUMN_DRAG_HANDLE_WIDTH,
            cursor: 'col-resize',
            zIndex: 2,
            background: 'transparent',
          }}
        />
      </div>
    </div>
  )
}
