// ── Project window's explorer region (2026-10-30) ──
// The immersive project window's left-hand surface: a WorkspacePane (directory
// tree | file preview) docked beside the conversation, which is passed in as
// `children`. Since 2026-10-31 (用户裁定「去掉地址栏那一行」) the pane runs in
// its immersive form: the file tab strip sits atop the preview column and the
// address bar is gone (the preview actions live in the strip's ⋯).
//
// Deliberately a thin composition rather than a new file surface: the project
// window must show the SAME tree/preview the main window's workbench shows
// (change inks, search, diff panel, edit/save) — reusing WorkspacePane is what
// makes that automatic. The only thing this file owns is the explorer↔chat
// divider, clamped at every consumption against the live row (the workbench
// pane's clamp-every-consumption lesson).

import React, { useEffect, useRef, useState } from 'react'
import { clampExplorerWidth, COLUMN_DRAG_HANDLE_WIDTH, IMMERSIVE_CARD_GAP } from '../../../shared/ui/layout-widths'
import { useSecondaryLayoutStore } from '../stores/secondaryLayoutStore'
import { useColumnDrag } from '../hooks/useColumnDrag'
import { WorkspacePane } from '../components/workbench/WorkspacePane'

/** 对话卡的圆角（2026-10-31 用户裁定「三列各用圆角矩形包裹」）；树/预览两卡
 *  在 WorkspacePane 的 immersive 分支里用同一个值。 */
const CARD_RADIUS = 8

/** clamp 的可用行宽扣减：getBoundingClientRect 含四周 padding（内容盒 = 矩形
 *  − 2×gap），explorer↔chat 之间还有一个 gap —— 共 3×IMMERSIVE_CARD_GAP。 */
const CARD_ROW_INSET = IMMERSIVE_CARD_GAP * 3

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
  // 卡片化的行宽口径（2026-10-31）：两处调用同扣 3×gap——手柄拖拽与渲染 clamp
  // 必须同一把尺，否则拖拽起点和渲染终值会打架。
  const clampRow = (w: number): number =>
    clampExplorerWidth(w, (rowRef.current?.getBoundingClientRect().width ?? 0) - CARD_ROW_INSET)
  const drag = useColumnDrag({
    getStartWidth: () => clampRow(useSecondaryLayoutStore.getState().explorerWidth),
    // The explorer is LEFT-aligned in the row and the handle rides its right
    // edge — the border must FOLLOW the pointer (rightward travel widens the
    // explorer). The mirrored direction belongs to right-docked panes only.
    direction: 1,
    clamp: clampRow,
    apply: setExplorerWidth,
  })
  // rowWidth 来自 contentRect（不含 padding），只扣 explorer↔chat 的一个 gap。
  const effExplorerWidth = clampExplorerWidth(rawExplorerWidth, rowWidth - IMMERSIVE_CARD_GAP)

  return (
    <div
      ref={rowRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'stretch',
        position: 'relative',
        // 卡片化（2026-10-31 用户裁定）：三列各自圆角矩形，四周与列间一律 5px
        // ——padding 给窗口边缘，gap 给 explorer↔chat（树↔预览的 gap 在
        // WorkspacePane 的 immersive 行里）。
        padding: IMMERSIVE_CARD_GAP,
        gap: IMMERSIVE_CARD_GAP,
      }}
    >
      {/* 输入区宽度帽（2026-10-30 用户裁定「新建会话时输入区的宽度太大」）：
          沉浸窗口的对话列可以很宽（explorer 被 clamp 后余量全给对话），composer
          的 952px 帽顶满整列，与窄窄的提示文字失衡。640 让输入卡在宽列里也保持
          对话应用的体量（margin auto 居中是 Composer 自带的）；窄于 640 的列不受
          影响。min(…, 100%) 是硬约束：帽必须落到容器宽，卡才不可能越界。
          第二条修「卡推出窗口右缘」（2026-10-31 用户实测）：欢迎态的 composer
          wrapper（data-welcome-shake="composer"）是 width:100% + 左右 24px
          padding，应用没有全局 border-box reset —— content-box 下 wrapper 总宽
          = 列宽 + 48，天生越列 24px；主窗里两侧各溢 24 不可见，沉浸窗口右缘
          就是窗口边，卡在越界的内容盒里居中即被裁。border-box + min(…, 100%)
          让 wrapper 与卡都封死在列内。特异性 (0,2,0) 压过 Composer 内联表的
          `.ant-sender` (0,1,0)。 */}
      <style>{`[data-pm-chat-column] .ant-sender { max-width: min(640px, 100%); }
        [data-pm-chat-column] [data-welcome-shake='composer'] { box-sizing: border-box; max-width: min(1048px, 100%); }`}</style>
      <div
        data-pm-explorer-column
        style={{
          width: effExplorerWidth,
          flexShrink: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          // 卡片化后 explorer 列只是树/预览两卡的承载盒——分隔由列间 gap 与
          // 两卡自带的圆角边框承担，borderRight 退场。
        }}
      >
        {/* 沉浸形态（2026-10-31 用户裁定）：页签条收进预览列、地址栏退场。 */}
        <WorkspacePane conversationId={conversationId} immersive />
      </div>
      {/* 对话卡（2026-10-31 用户裁定「三列各用圆角矩形包裹」）：border-box 让
          flex 分配的宽度含边框；裁切防内容溢出圆角。 */}
      <div
        data-pm-chat-column
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          background: 'var(--pm-bg)',
          border: '1px solid var(--pm-separator-faint)',
          borderRadius: CARD_RADIUS,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
      {/* Drag handle, straddling the gap between the two cards — a sibling of
          both columns (the explorer column's overflow:hidden would clip it).
          卡片化后手柄对准列间 gap 的正中：padding(5) + explorer 宽 + gap/2。 */}
      <div
        data-pm-explorer-drag-handle
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
        style={{
          position: 'absolute',
          left:
            IMMERSIVE_CARD_GAP +
            effExplorerWidth +
            IMMERSIVE_CARD_GAP / 2 -
            COLUMN_DRAG_HANDLE_WIDTH / 2,
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
