// ── 工作区 merged view (2026-10-25 「工作区和文件预览合并」; 2026-10-30 布局二次裁定;
//    2026-10-31 immersive 形态) ──
// Workbench form (default): top-bottom, then left-right — the FILE TAB STRIP
// spans the pane (2026-10-30, 用户裁定 — it took the row the address bar used
// to occupy), below it the tree (left, with its own search + refresh) sits
// beside the preview column (right) = the address bar (the on-screen file's
// absolute path + 打开 + a 更多 menu holding the preview actions) directly
// above the preview body, which is ALWAYS visible — the empty hint when no
// file is open. The address bar follows the ACTIVE PREVIEW FILE, not the tree
// selection (the tab strip names the open files; the bar names the one on
// screen).
// Immersive form (`immersive`, 2026-10-31 用户裁定「去掉地址栏那一行」): the
// tab strip moves INTO the preview column (it no longer spans the tree), the
// address bar row is gone, and the preview actions live in the strip's
// right-end ⋯ (shared builder, preview-file-actions). Same day, 用户裁定
// 「三列各用圆角矩形包裹，与边缘、互相之间都留 5px」: the tree and preview
// columns become rounded cards (IMMERSIVE_CARD) with a 5px gap between them;
// the window-edge insets and the explorer↔chat gap live in ProjectExplorer.
// Same day again, 用户裁定「左侧目录树升级：目录树 | 全文检索 两面板切换」:
// the immersive tree card grows a switcher row; 全文检索 fills the card via
// SearchPanel. 2026-11-01 用户裁定「只有沉浸模式提供全量的编辑和操作能力，
// 普通模式保持简洁」: the main window's 全文搜索 toolbar button is gone in
// BOTH forms (so is SearchPanel's strip variant — no consumers left); the
// immersive left card is the feature's only surface, and the tree toolbar's
// 新建 dropdown renders in the immersive form only.
// Selection lives here: the tree writes it, the tree rows paint it, and an
// agent-opened preview (openFile without a click) highlights itself through
// the same state.
//
// The tree↔preview divider is draggable (2026-10-26): the tree column used
// to be a fixed 40% share of the row; it is now a persisted px width
// (workbenchStore.treeWidth) with a 6px handle straddling the separator.
// The stored value is clamped at EVERY consumption against the row the
// ResizeObserver measures — a width dragged under one pane size survives
// onto a smaller one (the workbench pane's same lesson).

import React, { useEffect, useRef, useState } from 'react'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useSecondaryLayoutStore } from '../../stores/secondaryLayoutStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { clampTreeWidth, COLUMN_DRAG_HANDLE_WIDTH, IMMERSIVE_CARD_GAP, IMMERSIVE_CARD_RADIUS } from '../../../../shared/ui/layout-widths'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { PreviewPane } from '../preview/PreviewPane'
import { SearchPanel } from './SearchPanel'
import { WorkspaceAddressBar } from './WorkspaceAddressBar'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import { WorkspaceTree } from './WorkspaceTree'

/** 沉浸卡的公共盒（圆角 = shared 的 IMMERSIVE_CARD_RADIUS）：border-box
 *  （width 含边框，clamp 数学不被 +2 打破）+ 圆角边框 + 裁切 + 实底（浮在
 *  窗口底色上读作一张卡）。 */
const IMMERSIVE_CARD: React.CSSProperties = {
  boxSizing: 'border-box',
  background: 'var(--pm-bg)',
  border: '1px solid var(--pm-separator-faint)',
  borderRadius: IMMERSIVE_CARD_RADIUS,
  overflow: 'hidden',
}

interface Props {
  conversationId: string | undefined
  /** 沉浸窗口形态（2026-10-31 用户裁定）：页签条收进预览列（不再跨树列）、
   *  地址栏整行退场——预览动作由页签条右端的 ⋯（withFileActions）承接。
   *  工作台形态（缺省）保持 2026-10-30 的布局原样。 */
  immersive?: boolean
}

export function WorkspacePane({ conversationId, immersive }: Props): React.ReactElement {
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // 左卡面板（2026-10-31 三面板裁定）：目录树 | 全文检索。订阅对工作台形态
  // 无害——结果只在 immersive 分支消费。
  const leftPanel = useSecondaryLayoutStore((s) => s.leftPanel)
  const setLeftPanel = useSecondaryLayoutStore((s) => s.setLeftPanel)
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)

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
  // 沉浸形态的树↔预览之间有一个 CARD_GAP（卡片化裁定 2026-10-31），预览列的
  // 最低保留要把它算进去；工作台形态没有 gap，行宽原样进 clamp。
  const clampRowWidth = (w: number): number => w - (immersive ? IMMERSIVE_CARD_GAP : 0)
  const drag = useColumnDrag({
    getStartWidth: () => clampTreeWidth(useWorkbenchStore.getState().treeWidth, clampRowWidth(rowRef.current?.getBoundingClientRect().width ?? 0)),
    // The tree column is LEFT-aligned in the row and the handle rides its
    // right edge — the border must FOLLOW the pointer (rightward travel
    // widens the tree). The mirrored direction belongs to right-docked
    // panes only (WorkbenchPane's own handle, which grows leftward).
    direction: 1,
    clamp: (w) => clampTreeWidth(w, clampRowWidth(rowRef.current?.getBoundingClientRect().width ?? 0)),
    apply: setTreeWidth,
  })
  const effTreeWidth = clampTreeWidth(rawTreeWidth, clampRowWidth(rowWidth))

  // A preview opened without a click (agent write auto-preview, chat file
  // chips) must still highlight its row in the tree.
  useEffect(() => {
    if (activePath) setSelectedPath(activePath)
  }, [activePath])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 工作台形态：页签条跨整面板宽（列首行）。沉浸形态不渲染这一处——
          它的页签条在下面预览列的顶部。 */}
      {!immersive && <WorkspaceTabStrip conversationId={conversationId} />}
      <div
        ref={rowRef}
        data-pm-workspace-row
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'stretch',
          position: 'relative',
          // 卡片化（2026-10-31 用户裁定）：沉浸形态树↔预览之间留 5px；工作台
          // 形态无 gap（分隔仍是树列的 borderRight）。
          gap: immersive ? IMMERSIVE_CARD_GAP : undefined,
        }}
      >
        <div
          data-pm-tree-column
          style={{
            width: effTreeWidth,
            flexShrink: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            // 工作台形态保持 2026-10-30 的右边框分隔；沉浸形态整卡圆角
            // （border-box：width 含边框，clamp 数学不被 +2 打破）。
            ...(immersive ? IMMERSIVE_CARD : { borderRight: '1px solid var(--pm-separator-faint)' }),
          }}
        >
          {/* 左卡面板切换器（2026-10-31 用户裁定「目录树 | 全文检索」）：
              仅沉浸形态渲染，chips 与右卡切换器/工作台页签同款。 */}
          {immersive && (
            <div
              data-pm-left-panel-switcher
              style={{
                height: 32,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '0 8px',
                borderBottom: '1px solid var(--pm-separator-faint)',
                background: 'var(--pm-bg)',
              }}
            >
              {(
                [
                  ['tree', '文件'],
                  ['search', '搜索'],
                ] as const
              ).map(([id, label]) => {
                const active = leftPanel === id
                return (
                  <div
                    key={id}
                    data-panel-id={id}
                    onClick={() => !active && setLeftPanel(id)}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      cursor: active ? 'default' : 'pointer',
                      background: active ? 'var(--pm-tile-soft)' : 'transparent',
                      boxShadow: active ? 'var(--pm-shadow-chip)' : 'none',
                      color: active ? 'var(--pm-text-strong)' : 'var(--pm-text-quiet)',
                      flexShrink: 0,
                    }}
                  >
                    {label}
                  </div>
                )
              })}
            </div>
          )}
          {/* 全文检索面板态：整卡填充，命中点击 → 中卡预览打开（同窗口
              store，联动免费）。无工作目录时诚实提示（rg 无处可搜）。
              工作台形态与树态照旧渲染 WorkspaceTree（immersive 传递下去，
              决定树工具条是否带「新建」）。 */}
          {immersive && leftPanel === 'search' ? (
            workspaceDir ? (
              <SearchPanel workspaceDir={workspaceDir} />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 12, color: 'var(--pm-text-muted)' }}>
                当前会话暂无工作目录
              </div>
            )
          ) : (
            <WorkspaceTree conversationId={conversationId} selectedPath={selectedPath} onSelectPath={setSelectedPath} immersive={immersive} />
          )}
        </div>
        <div
          data-pm-preview-column
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            ...(immersive ? IMMERSIVE_CARD : {}),
          }}
        >
          {/* 沉浸形态：页签条（带右端 ⋯ 预览动作）顶替地址栏的位置；工作台
              形态保持地址栏。两者都直接贴着预览体。 */}
          {immersive ? <WorkspaceTabStrip conversationId={conversationId} withFileActions /> : <WorkspaceAddressBar conversationId={conversationId} />}
          <PreviewPane conversationId={conversationId} />
        </div>
        {/* Drag handle, straddling the separator between the two columns —
            a sibling of both (the tree column's overflow:hidden would clip
            it), positioned and stacked above the static preview content.
            沉浸形态对准列间 gap 的正中（+gap/2），工作台形态对准树列右缘。 */}
        <div
          data-pm-tree-drag-handle
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
          style={{
            position: 'absolute',
            left: effTreeWidth + (immersive ? IMMERSIVE_CARD_GAP / 2 : 0) - COLUMN_DRAG_HANDLE_WIDTH / 2,
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
