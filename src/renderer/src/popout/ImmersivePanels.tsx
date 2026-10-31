// ── Immersive right-card panels (2026-10-31, 用户裁定「对话 | 浏览器 | 工作计划」) ──
// The immersive window's right card is a THREE-PANEL switcher, not just the
// conversation: 对话 (kept alive — the main-window precedent of ChatView
// staying mounted under display:none, so streaming/composer/bottom-pin all
// survive a panel switch), 浏览器 (BrowserPaneChrome over the per-window
// native view — the same pane contract the main window's workbench uses, with
// the immersive window's own pane-state push carrying card-geometry insets),
// 工作计划 (PlanGraphView — the data and every callback already live in
// PopoutApp, which merely never rendered them).
//
// The switcher chips mirror the main-window workbench tab strip's look. The
// switcher row's height is part of the native view's top inset
// (IMMERSIVE_BROWSER_TOP_INSET) — change one, the other must follow.

import React, { useEffect, useRef } from 'react'
import { BrowserPaneChrome } from '../components/browser/BrowserPaneChrome'
import { PlanGraphView } from '../components/workbench/PlanGraphView'
import { useBrowserPaneActions } from '../hooks/useBrowserPane'
import { useBrowserPaneStore } from '../stores/browserPaneStore'
import { useSecondaryLayoutStore, type ImmersiveRightPanel } from '../stores/secondaryLayoutStore'
import { IMMERSIVE_CARD_GAP } from '../../../shared/ui/layout-widths'
import type { Plan } from '../types/agent'

/** 面板切换器行高——随卡片化与页签条/地址栏同族的 32px 行。 */
export const IMMERSIVE_SWITCHER_HEIGHT = 32

/** 原生 view 顶距补偿：窗口边距 5 + 卡上边框 1 + 切换器行 32。 */
export const IMMERSIVE_BROWSER_TOP_INSET = IMMERSIVE_CARD_GAP + 1 + IMMERSIVE_SWITCHER_HEIGHT
/** 原生 view 右缘收进：窗口边距 5（卡的 1px 右边框由 webviewBox 自身的
 *  「pane − 3」右缝吸收）。 */
export const IMMERSIVE_BROWSER_RIGHT_INSET = IMMERSIVE_CARD_GAP
/** 原生 view 底距收进：窗口边距 5 + 卡下边框 1。 */
export const IMMERSIVE_BROWSER_BOTTOM_INSET = IMMERSIVE_CARD_GAP + 1

interface Props {
  plan?: Plan | null
  onPlanJump?: (msgId: string) => void
  onOpenPlanNode?: (nodeId: string) => void
  canOpenNode?: (nodeId: string) => boolean
  onOpenNodeReport?: (nodeId: string) => void
  highlightPlanNodeId?: string | null
  /** The chat panel's content (ChatView + the sub-agent overlay) — kept
   *  mounted, only ever hidden. */
  children: React.ReactNode
}

export function ImmersivePanels({
  plan,
  onPlanJump,
  onOpenPlanNode,
  canOpenNode,
  onOpenNodeReport,
  highlightPlanNodeId,
  children,
}: Props): React.ReactElement {
  const rightPanel = useSecondaryLayoutStore((s) => s.rightPanel)
  const setRightPanel = useSecondaryLayoutStore((s) => s.setRightPanel)
  const pane = useBrowserPaneStore((s) => s.update)
  // The pane gestures are thin electronAPI wrappers — self-held here, the
  // same pair ChatView's binding returns (without its push effect).
  const { action } = useBrowserPaneActions()

  // Measure the card's content width → the paneWidth pass-through. The
  // binding reads this store field and pushes paneWidth = width + 3 (the two
  // card borders plus webviewBox's own insets — see the binding's comment).
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      useBrowserPaneStore.getState().setImmersiveCardWidth(w > 0 ? w : null)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Leave no stale width behind on unmount (conversation-less teardown).
  useEffect(() => () => useBrowserPaneStore.getState().setImmersiveCardWidth(null), [])

  const settled = plan ? plan.nodes.filter((n) => n.status !== 'pending').length : 0
  const total = plan?.nodes.length ?? 0

  const tabs: Array<{ id: ImmersiveRightPanel; label: string; badge?: string }> = [
    { id: 'chat', label: '对话' },
    { id: 'browser', label: '浏览器', badge: pane.tabs.length > 0 ? String(pane.tabs.length) : undefined },
    { id: 'plan', label: '工作计划', badge: total > 0 ? `${settled}/${total}` : undefined },
  ]

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 面板切换器：右卡顶行，chips 与主窗工作台页签同款。 */}
      <div
        data-pm-right-panel-switcher
        style={{
          height: IMMERSIVE_SWITCHER_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 8px',
          borderBottom: '1px solid var(--pm-separator-faint)',
          background: 'var(--pm-bg)',
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === rightPanel
          return (
            <div
              key={tab.id}
              data-panel-id={tab.id}
              onClick={() => !active && setRightPanel(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
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
      {/* 对话面板：保活（display 切换）——主窗的 ChatView-under-display:none
          同款，流式输出与 composer 草稿跨面板存活。 */}
      <div
        data-pm-panel-chat
        style={{ flex: 1, minHeight: 0, display: rightPanel === 'chat' ? 'flex' : 'none', flexDirection: 'column', position: 'relative' }}
      >
        {children}
      </div>
      {/* 浏览器面板：chrome 渲染在 DOM，原生 view 由 per-window dock 叠加
          （browserActive = 本面板在前的推送已在 useBrowserPaneBinding）。 */}
      {rightPanel === 'browser' && (
        <div data-pm-panel-browser style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <BrowserPaneChrome pane={pane} onAction={action} />
        </div>
      )}
      {/* 工作计划面板：数据与回调 PopoutApp 早已持有。点节点先切回对话面板
          再跳转——否则滚动落在一个看不见的隐藏面板里。 */}
      {rightPanel === 'plan' && (
        <div data-pm-panel-plan style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <PlanGraphView
            plan={plan ?? null}
            onJumpToStep={(msgId) => {
              setRightPanel('chat')
              onPlanJump?.(msgId)
            }}
            onOpenPlanNode={onOpenPlanNode}
            canOpenNode={canOpenNode}
            onOpenNodeReport={onOpenNodeReport}
            highlightNodeId={highlightPlanNodeId}
          />
        </div>
      )}
    </div>
  )
}
