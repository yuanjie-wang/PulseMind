// ── Browser pane chrome (A-M5) ──
// The in-app browser's user-facing controls: tab strip, address bar with
// back/forward/reload, open-external, and the left-edge drag handle. Pure
// DOM overlay — the actual page is the native WebContentsView positioned by
// the main-process dock BELOW this chrome (heights must stay in sync via
// PANE_CHROME_HEIGHT).

import React, { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Plus, X } from 'lucide-react'
import {
  PANE_DRAG_HANDLE_WIDTH,
  PANE_MIN_WIDTH,
  PANE_MAX_CHAT_RATIO,
  normalizeAddressBarInput,
  type BrowserPaneAction,
  type BrowserPaneUpdate,
} from '../../../../shared/browser/pane'

interface Props {
  pane: BrowserPaneUpdate
  chatAreaWidth: number
  onWidth: (width: number, chatAreaWidth: number) => void
  onAction: (action: BrowserPaneAction) => void
}

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

export function BrowserPaneChrome({ pane, chatAreaWidth, onWidth, onAction }: Props) {
  const active = pane.tabs.find((t) => t.active) ?? null
  // Address-bar draft, scoped to the tab it was typed in — switching tabs
  // naturally shows the new tab's URL without a reset effect.
  const [draft, setDraft] = useState<{ tabId: string; text: string | null }>({ tabId: '', text: null })
  const drag = useRef<{ startX: number; startWidth: number; lastSent: number } | null>(null)
  const maxW = Math.max(PANE_MIN_WIDTH, Math.floor(chatAreaWidth * PANE_MAX_CHAT_RATIO))
  const shownUrl = draft.tabId === active?.id ? (draft.text ?? active?.url ?? '') : (active?.url ?? '')

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: pane.width, lastSent: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const next = Math.min(maxW, Math.max(PANE_MIN_WIDTH, d.startWidth + (d.startX - e.clientX)))
    const now = Date.now()
    if (now - d.lastSent > 40) {
      d.lastSent = now
      onWidth(next, chatAreaWidth)
    }
  }
  const onDragEnd = () => {
    if (!drag.current) return
    drag.current = null
    onWidth(pane.width, chatAreaWidth)
  }

  const navigateDraft = () => {
    if (active && draft.tabId === active.id && draft.text && draft.text.trim()) {
      onAction({ op: 'navigate', tabId: active.id, url: normalizeAddressBarInput(draft.text) })
    }
    setDraft({ tabId: active?.id ?? '', text: null })
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: pane.width,
        background: '#f7f8fa',
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
          {pane.tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => !tab.active && onAction({ op: 'selectTab', tabId: tab.id })}
              title={tab.title || tab.url}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 140,
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                background: tab.active ? '#fff' : 'transparent',
                boxShadow: tab.active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                color: tab.active ? '#333' : '#888',
                flexShrink: 0,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title || tab.url || '新标签页'}</span>
              <X
                size={11}
                onClick={(e) => {
                  e.stopPropagation()
                  onAction({ op: 'closeTab', tabId: tab.id })
                }}
                style={{ flexShrink: 0, opacity: 0.6 }}
              />
            </div>
          ))}
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => onAction({ op: 'newTab' })} title="新建标签页">
          <Plus size={13} />
        </div>
      </div>

      {/* Address row (36px) */}
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
        <div style={{ ...ICON_BUTTON, opacity: active ? 1 : 0.35 }} onClick={() => active && onAction({ op: 'back', tabId: active.id })} title="后退">
          <ArrowLeft size={13} />
        </div>
        <div style={{ ...ICON_BUTTON, opacity: active ? 1 : 0.35 }} onClick={() => active && onAction({ op: 'forward', tabId: active.id })} title="前进">
          <ArrowRight size={13} />
        </div>
        <div style={{ ...ICON_BUTTON, opacity: active ? 1 : 0.35 }} onClick={() => active && onAction({ op: 'reload', tabId: active.id })} title="刷新">
          <RotateCw size={12} />
        </div>
        <input
          value={shownUrl}
          placeholder="输入网址，回车打开"
          onChange={(e) => active && setDraft({ tabId: active.id, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigateDraft()
            if (e.key === 'Escape') setDraft({ tabId: active?.id ?? '', text: null })
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            fontSize: 12,
            padding: '0 8px',
            borderRadius: 12,
            border: '1px solid #e5e6eb',
            outline: 'none',
            color: '#333',
            background: '#f7f8fa',
          }}
        />
        <div
          style={{ ...ICON_BUTTON, opacity: active?.url ? 1 : 0.35 }}
          onClick={() => active?.url && onAction({ op: 'openExternal', url: active.url })}
          title="在系统浏览器打开"
        >
          <ExternalLink size={12} />
        </div>
      </div>

      {/* The rest of the pane is transparent — the native WebView sits there
          (16:9, vertically centered; empty letterbox shows the pane bg). */}
      <div style={{ flex: 1 }} />
    </div>
  )
}
