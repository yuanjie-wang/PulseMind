// ── Right-side workbench (PLAN-workbench) ──
// One docked pane, three tool tabs: 工作区 (file tree + file preview side by
// side — the standalone 文件预览 tab was merged into it, 2026-10-25) /
// 浏览器 (in-app browser) / 工作计划 (plan DAG). Owns the geometry the views
// used to each carry separately: absolute right edge, one shared width with a
// left-edge drag handle, one paddingRight reserve upstream. The browser tab
// keeps its native-WebView contract — while it is frontmost the renderer
// reports browserActive=true so the main-process dock shows.
//
// 视图模式（PLAN-layout-modes 2026-11-03）：tab 集合按主视图模式走
// （sideTabsFor）——文件/浏览器优先时对话降级为侧栏 tab，其内容由 ChatView
// 构造好经 chatSlot 注入（WorkbenchPane 不反向依赖 ChatView，避免环）。

import React, { useRef } from 'react'
import { X } from 'lucide-react'
import { WORKBENCH_CARD_MARGIN, clampPaneWidth, PANE_DRAG_HANDLE_WIDTH, type BrowserPaneAction, type BrowserPaneUpdate } from '../../../../shared/browser/pane'
import { IMMERSIVE_CARD_RADIUS } from '../../../../shared/ui/layout-widths'
import { useWorkbenchStore, useWorkbenchWidth, useConversationPrimary, reconcileActiveTab, sideTabsFor, type WorkbenchTab } from '../../stores/workbenchStore'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { BrowserPaneChrome } from '../browser/BrowserPaneChrome'
import { PlanGraphView } from './PlanGraphView'
import { WorkspacePane } from './WorkspacePane'
import type { Plan } from '../../types/agent'

const TAB_STRIP_HEIGHT = 32

interface Props {
  conversationId: string | undefined
  /** Measured chat-column width — the clamp input for the drag handle. */
  chatAreaWidth: number
  /** 卡片形态（2026-11-03 主窗裁定，参考沉浸卡片语言）：面板收成圆角卡——
   *  四周 5px 窗口边距（top/right/bottom 各让 5）、1px separator-faint 全边框
   *  接管旧的 borderLeft、圆角 8 + 裁切 + border-box（clamp 数学不被 +2 打破，
   *  沉浸卡同款）。主窗 App.tsx 与会话弹出窗口 PopoutApp 都传（2026-11-04
   *  用户裁定两窗统一）；缺省 false = 项目沉浸窗口的贴边 dock 几何逐字节
   *  不变。主窗侧 ChatView 的
   *  对话卡 reserve 已按「卡边距 + 列间 gap」加宽，原生浏览器 view 的对位由
   *  ChatView 经 useBrowserPaneBinding 携带的 WORKBENCH_CARD_*_INSET 承担。 */
  card?: boolean
  plan: Plan | null
  onPlanJump?: (msgId: string) => void
  /** Node click → the host opens the node's linked sub-agent session (or
   *  falls back to the msgId jump itself). */
  onOpenPlanNode?: (nodeId: string) => void
  /** Which nodes open something (cursor + tooltip affordance). */
  canOpenNode?: (nodeId: string) => boolean
  /** Open the node's delivered report file (PLAN-plan-exchange 表达面). */
  onOpenNodeReport?: (nodeId: string) => void
  /** The node whose sub-agent session is open in the drill-in — PlanGraphView
   *  highlights its card. Null = no drill-in, or the session belongs to no
   *  node. */
  highlightPlanNodeId?: string | null
  browserPane: BrowserPaneUpdate
  onBrowserAction: (action: BrowserPaneAction) => void
  /** While the browser tab is frontmost, width drags must reach the
   *  main-process dock so the native WebView keeps aligned. */
  onBrowserWidth: (width: number) => void
  /** 对话 tab 的内容（视图模式 ≠ chat 时由 ChatView 注入的 ChatBody 节点）。
   *  chat-primary 的侧栏集合没有对话 tab，永远不渲染它。 */
  chatSlot?: React.ReactNode
}

export function WorkbenchPane({
  conversationId,
  chatAreaWidth,
  card,
  plan,
  onPlanJump = () => {},
  onOpenPlanNode,
  canOpenNode,
  onOpenNodeReport,
  highlightPlanNodeId,
  browserPane,
  onBrowserAction,
  onBrowserWidth,
  chatSlot,
}: Props): React.ReactElement {
  // 宽度按 tab 取（2026-11-06）：浏览器被拖宽不会再把计划面板一起撑开。
  const width = useWorkbenchWidth()
  // The persisted width predates every window it renders into (a drag under
  // one monitor survives onto a smaller one; this instance also predates the
  // 2026-10-06 zoom fix, whose 3× CSS viewport stored an 1854px drag) — the
  // drag clamp is not enough, every consumption of the stored value clamps.
  const effWidth = clampPaneWidth(width, chatAreaWidth)
  // 视图模式：side tab 集合与 activeTab 调和都跟着 primary 走（次级窗口恒
  // 'chat'）。A persisted activeTab naming a removed tab (the one-day
  // deliverables aggregate, or 'files' before its merge into 工作区) — or one
  // that IS the primary itself — would otherwise render a pane body with no
  // view; reconcileActiveTab falls back per mode.
  const primary = useConversationPrimary(conversationId ?? DRAFT_CONVERSATION_KEY)
  const activeTab = useWorkbenchStore((s) => reconcileActiveTab(primary, s.activeTab))
  const setWidth = useWorkbenchStore((s) => s.setWidth)
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab)
  const setOpen = useWorkbenchStore((s) => s.setOpen)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; lastSent: number } | null>(null)

  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  // This conversation's pane state; a conversation with no entry is closed.
  const open = useWorkbenchStore((s) => s.openByConversation[key] ?? false)
  const fileTabs = usePreviewPaneStore((s) => s.tabsByConversation[key]?.length ?? 0)
  const settled = plan ? plan.nodes.filter((n) => n.status !== 'pending').length : 0
  const total = plan?.nodes.length ?? 0

  if (!open) return <></>

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: effWidth, lastSent: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    // A canceled or silently-decaptured drag (pointercancel fires no
    // pointerup) leaves drag.current set — from then on a plain HOVER over
    // the handle would keep resizing. No button held = the drag is over.
    if (e.buttons === 0) {
      drag.current = null
      return
    }
    const next = clampPaneWidth(d.startWidth + (d.startX - e.clientX), chatAreaWidth)
    const now = Date.now()
    if (now - d.lastSent > 40) {
      d.lastSent = now
      setWidth(next)
      if (activeTab === 'browser') onBrowserWidth(next)
    }
  }
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    // 异指针的 pointerup（第二根手指、拖拽中落下的鼠标键）不能终止活拖拽
    // ——只有发起拖拽的那根指针能（review_20261008 低7；move 臂已有同守卫）。
    if (drag.current && e.pointerId !== drag.current.pointerId) return
    drag.current = null
  }

  // Tab set follows the view mode (= 全集减去主视图自己); badges attach per id
  // — the open-file count rides 工作区's badge now that the preview lives there.
  const labels: Record<WorkbenchTab, string> = { workspace: '工作区', browser: '浏览器', plan: '工作计划', chat: '对话' }
  const badges: Partial<Record<WorkbenchTab, string>> = {
    workspace: fileTabs > 0 ? String(fileTabs) : undefined,
    browser: browserPane.tabs.length > 0 ? String(browserPane.tabs.length) : undefined,
    plan: total > 0 ? `${settled}/${total}` : undefined,
  }
  const tabs: Array<{ id: WorkbenchTab; label: string; badge?: string }> = sideTabsFor(primary).map((id) => ({
    id,
    label: labels[id],
    badge: badges[id],
  }))

  return (
    <div
      style={{
        position: 'absolute',
        top: card ? WORKBENCH_CARD_MARGIN : 0,
        right: card ? WORKBENCH_CARD_MARGIN : 0,
        bottom: card ? WORKBENCH_CARD_MARGIN : 0,
        width: effWidth,
        background: 'var(--pm-bg)',
        ...(card
          ? {
              boxSizing: 'border-box',
              border: '1px solid var(--pm-separator-faint)',
              borderRadius: IMMERSIVE_CARD_RADIUS,
              overflow: 'hidden',
            }
          : { borderLeft: '1px solid var(--pm-pop-border)' }),
        display: 'flex',
        flexDirection: 'column',
        zIndex: 30,
      }}
    >
      {/* Drag handle (left edge) */}
      <div
        data-pm-pane-drag-handle
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: PANE_DRAG_HANDLE_WIDTH,
          cursor: 'col-resize',
          zIndex: 2,
          background: 'transparent',
        }}
      />

      {/* Tool-tab strip (32px) — part of PANE_CHROME_HEIGHT on the dock side */}
      <div
        style={{
          height: TAB_STRIP_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 6px 0 12px',
          borderBottom: '1px solid var(--pm-separator-faint)',
          background: 'var(--pm-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, overflow: 'hidden' }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTab
            return (
              <div
                key={tab.id}
                onClick={() => !active && setActiveTab(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 10px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  background: active ? 'var(--pm-tile-soft)' : 'transparent',
                  boxShadow: active ? 'var(--pm-shadow-chip)' : 'none',
                  color: active ? 'var(--pm-text-strong)' : 'var(--pm-text-quiet)',
                  flexShrink: 0,
                }}
              >
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: '14px',
                      padding: '0 5px',
                      borderRadius: 7,
                      color: '#fff',
                      background: tab.id === 'plan' ? 'var(--pm-link)' : 'var(--pm-badge-muted)',
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div
          onClick={() => setOpen(key, false)}
          title="收起工作台"
          style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 5,
            color: 'var(--pm-text-quiet)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={13} />
        </div>
      </div>

      {/* Active tool view */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'workspace' && <WorkspacePane conversationId={conversationId} />}
        {activeTab === 'browser' && <BrowserPaneChrome pane={browserPane} onAction={onBrowserAction} />}
        {activeTab === 'plan' && (
          <PlanGraphView
            plan={plan}
            onJumpToStep={onPlanJump}
            onOpenPlanNode={onOpenPlanNode}
            canOpenNode={canOpenNode}
            onOpenNodeReport={onOpenNodeReport}
            highlightNodeId={highlightPlanNodeId}
          />
        )}
        {/* 视图模式的对话 tab：内容 = ChatView 注入的 ChatBody 节点（浮动
            Composer 锚 WorkbenchPane 根的 absolute 盒，几何与主卡同构）。 */}
        {activeTab === 'chat' && chatSlot}
      </div>
    </div>
  )
}
