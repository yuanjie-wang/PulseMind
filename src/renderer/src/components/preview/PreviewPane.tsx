// ── Preview pane chrome (PLAN-preview-pane §设计3) ──
// The right-hand file preview panel of the chat view: tab strip, toolbar
// (refresh / open-in-system / save-as / collapse), and the per-kind content
// dispatcher. Pure DOM overlay — unlike the browser pane there is no native
// WebContentsView behind it, so layout math stays renderer-local. Geometry
// mirrors BrowserPaneChrome: absolute right edge, 6px left drag handle,
// width clamped against the chat area via the shared clampPaneWidth.

import React, { useRef } from 'react'
import { RotateCw, ExternalLink, Download, X } from 'lucide-react'
import { clampPaneWidth, PANE_DRAG_HANDLE_WIDTH, PANE_MIN_WIDTH, PANE_MAX_CHAT_RATIO } from '../../../../shared/browser/pane'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { PreviewContent } from './PreviewContent'
import { useTranslation } from '../../i18n/useTranslation'

const ICON_BUTTON: React.CSSProperties = {
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: '#666',
  flexShrink: 0,
  cursor: 'pointer',
}

interface Props {
  conversationId: string | undefined
  /** Measured chat-column width — the clamp input. */
  chatAreaWidth: number
  /** Width of the browser pane when it is docked (this panel stacks to its
   *  left); 0 when the right edge is free. */
  rightOffset: number
}

export function PreviewPane({ conversationId, chatAreaWidth, rightOffset }: Props): React.ReactElement | null {
  const { t } = useTranslation()
  const open = usePreviewPaneStore((s) => s.open)
  const width = usePreviewPaneStore((s) => s.width)
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const convArg = conversationId ?? null
  const tabs = usePreviewPaneStore((s) => s.tabsByConversation[key])
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const reloadTicks = usePreviewPaneStore((s) => s.reloadTicks)
  const drag = useRef<{ startX: number; startWidth: number; lastSent: number } | null>(null)
  const maxW = Math.max(PANE_MIN_WIDTH, Math.floor(chatAreaWidth * PANE_MAX_CHAT_RATIO))

  if (!open || !tabs || tabs.length === 0) return null

  const active = tabs.find((tab) => tab.path === activePath) ?? tabs[tabs.length - 1]
  const store = usePreviewPaneStore.getState()

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
      store.setWidth(next)
    }
  }
  const onDragEnd = () => {
    drag.current = null
  }

  const saveAs = async () => {
    try {
      const { filePath, canceled } = await window.electronAPI.showSaveDialog({ defaultName: active.title })
      if (canceled || !filePath) return
      await window.electronAPI.copyFile({ source: active.path, destination: filePath })
    } catch (err) {
      console.warn('[preview-pane] save-as failed:', err)
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: rightOffset,
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

      {/* Tab strip (32px) */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 6px 0 12px',
          borderBottom: '1px solid #ececf0',
          background: '#f0f1f4',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, overflow: 'hidden' }}>
          {tabs.map((tab) => (
            <div
              key={tab.path}
              onClick={() => tab.path !== active.path && store.setActive(convArg, tab.path)}
              title={tab.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 140,
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                background: tab.path === active.path ? '#fff' : 'transparent',
                boxShadow: tab.path === active.path ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                color: tab.path === active.path ? '#333' : '#888',
                flexShrink: 0,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
              <X
                size={11}
                onClick={(e) => {
                  e.stopPropagation()
                  store.closeTab(convArg, tab.path)
                }}
                style={{ flexShrink: 0, opacity: 0.6 }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Toolbar row (36px): refresh / path / open-in-system / save-as / collapse */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 8px',
          borderBottom: '1px solid #ececf0',
          background: '#fff',
        }}
      >
        <div style={{ ...ICON_BUTTON }} onClick={() => store.bumpReload(active.path)} title={t('previewPane.refresh')}>
          <RotateCw size={12} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: '#999',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
          title={active.path}
        >
          {active.path}
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => void window.electronAPI.openFolder(active.path).catch(() => {})} title={t('previewPane.openInOs')}>
          <ExternalLink size={12} />
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => void saveAs()} title={t('previewPane.saveAs')}>
          <Download size={12} />
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => store.setOpen(false)} title={t('previewPane.closePanel')}>
          <X size={13} />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <PreviewContent key={active.path} path={active.path} reloadTick={reloadTicks[active.path] ?? 0} />
      </div>
    </div>
  )
}
