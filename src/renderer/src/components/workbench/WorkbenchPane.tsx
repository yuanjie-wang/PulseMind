// ── Right-side workbench (PLAN-workbench) ──
// One docked pane, three tool tabs: 文件 (per-conversation preview) /
// 浏览器 (in-app browser) / 计划 (plan DAG). Owns the geometry the three
// views used to each carry separately: absolute right edge, one shared
// width with a left-edge drag handle, one paddingRight reserve upstream.
// The browser tab keeps its native-WebView contract — while it is frontmost
// the renderer reports browserActive=true so the main-process dock shows.

import React, { useRef } from 'react'
import { X } from 'lucide-react'
import { clampPaneWidth, PANE_DRAG_HANDLE_WIDTH, type BrowserPaneAction, type BrowserPaneUpdate } from '../../../../shared/browser/pane'
import { useWorkbenchStore, type WorkbenchTab } from '../../stores/workbenchStore'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { PreviewPane } from '../preview/PreviewPane'
import { BrowserPaneChrome } from '../browser/BrowserPaneChrome'
import { PlanGraphView } from './PlanGraphView'
import type { Plan } from '../../types/agent'

const TAB_STRIP_HEIGHT = 32

interface Props {
  conversationId: string | undefined
  /** Measured chat-column width — the clamp input for the drag handle. */
  chatAreaWidth: number
  plan: Plan | null
  onPlanJump?: (msgId: string) => void
  browserPane: BrowserPaneUpdate
  onBrowserAction: (action: BrowserPaneAction) => void
  /** While the browser tab is frontmost, width drags must reach the
   *  main-process dock so the native WebView keeps aligned. */
  onBrowserWidth: (width: number) => void
}

export function WorkbenchPane({ conversationId, chatAreaWidth, plan, onPlanJump = () => {}, browserPane, onBrowserAction, onBrowserWidth }: Props): React.ReactElement {
  const open = useWorkbenchStore((s) => s.open)
  const width = useWorkbenchStore((s) => s.width)
  const activeTab = useWorkbenchStore((s) => s.activeTab)
  const setWidth = useWorkbenchStore((s) => s.setWidth)
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab)
  const setOpen = useWorkbenchStore((s) => s.setOpen)
  const drag = useRef<{ startX: number; startWidth: number; lastSent: number } | null>(null)

  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const fileTabs = usePreviewPaneStore((s) => s.tabsByConversation[key]?.length ?? 0)
  const settled = plan ? plan.nodes.filter((n) => n.status !== 'pending').length : 0
  const total = plan?.nodes.length ?? 0

  if (!open) return <></>

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: width, lastSent: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const next = clampPaneWidth(d.startWidth + (d.startX - e.clientX), chatAreaWidth)
    const now = Date.now()
    if (now - d.lastSent > 40) {
      d.lastSent = now
      setWidth(next)
      if (activeTab === 'browser') onBrowserWidth(next)
    }
  }
  const onDragEnd = () => {
    drag.current = null
  }

  const tabs: Array<{ id: WorkbenchTab; label: string; badge?: string }> = [
    ...(fileTabs > 0 ? [{ id: 'files' as const, label: '文件', badge: String(fileTabs) }] : [{ id: 'files' as const, label: '文件' }]),
    ...(browserPane.tabs.length > 0
      ? [{ id: 'browser' as const, label: '浏览器', badge: String(browserPane.tabs.length) }]
      : [{ id: 'browser' as const, label: '浏览器' }]),
    ...(total > 0 ? [{ id: 'plan' as const, label: '计划', badge: `${settled}/${total}` }] : [{ id: 'plan' as const, label: '计划' }]),
  ]

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        background: '#fff',
        borderLeft: '1px solid #e5e6eb',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 30,
      }}
    >
      {/* Drag handle (left edge) */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
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
          borderBottom: '1px solid #ececf0',
          background: '#f0f1f4',
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
                  cursor: 'pointer',
                  background: active ? '#fff' : 'transparent',
                  boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                  color: active ? '#333' : '#888',
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
                      background: tab.id === 'plan' ? '#1677ff' : '#b9bdc7',
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
          onClick={() => setOpen(false)}
          title="收起工作台"
          style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, color: '#888', cursor: 'pointer', flexShrink: 0 }}
        >
          <X size={13} />
        </div>
      </div>

      {/* Active tool view */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'files' && <PreviewPane conversationId={conversationId} />}
        {activeTab === 'browser' && <BrowserPaneChrome pane={browserPane} onAction={onBrowserAction} />}
        {activeTab === 'plan' && <PlanGraphView plan={plan} onJumpToStep={onPlanJump} />}
      </div>
    </div>
  )
}
