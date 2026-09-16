// ── Browser pane chrome (A-M5; PLAN-workbench W1) ──
// The in-app browser's user-facing controls: tab strip and address bar with
// back/forward/reload + open-external. The actual page is the native
// WebContentsView positioned by the main-process dock BELOW this chrome —
// heights must stay in sync via PANE_CHROME_HEIGHT (which includes the
// workbench's own tool-tab strip). Positioning and the width drag handle
// belong to WorkbenchPane; this component fills its parent.

import React, { useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Plus, X } from 'lucide-react'
import {
  normalizeAddressBarInput,
  type BrowserPaneAction,
  type BrowserPaneUpdate,
} from '../../../../shared/browser/pane'

interface Props {
  pane: BrowserPaneUpdate
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

export function BrowserPaneChrome({ pane, onAction }: Props) {
  const active = pane.tabs.find((t) => t.active) ?? null
  // Address-bar draft, scoped to the tab it was typed in — switching tabs
  // naturally shows the new tab's URL without a reset effect.
  const [draft, setDraft] = useState<{ tabId: string; text: string | null }>({ tabId: '', text: null })
  // A pane with no tab yet is a real state (the workbench's 浏览器 tab can be
  // opened before anything created one), and it is the SAME bucket as "the
  // active tab is gone": the field must still take keystrokes — it is the only
  // way to say where to go — so an absent tab reads as an empty id rather than
  // gating every handler.
  const activeId = active?.id ?? ''
  // A just-opened tab sits on about:blank, and showing it in the field is a
  // trap: typing appends ("about:blank" + "mail.163.com"), the scheme passes
  // the whitelist untouched, and the navigation dies silently. A fresh tab is
  // an empty field, exactly like a real browser's new-tab page.
  const shownTabUrl = active && active.url !== '' && active.url !== 'about:blank' ? active.url : ''
  const shownUrl = draft.tabId === activeId ? (draft.text ?? shownTabUrl) : shownTabUrl

  const navigateDraft = () => {
    const typed = draft.tabId === activeId ? draft.text?.trim() : undefined
    if (!typed) {
      setDraft({ tabId: activeId, text: null })
      return
    }
    const url = normalizeAddressBarInput(typed)
    // With a tab open the address means "go there"; with none it means "open
    // one and go there" — main mints the tab (it owns the ids), so the action
    // carries no tabId and the chrome keeps showing what was typed until the
    // new tab reports its own URL.
    onAction(active ? { op: 'navigate', tabId: active.id, url } : { op: 'navigate', url })
    setDraft({ tabId: activeId, text: active ? null : typed })
  }

  return (
    <div
      style={{
        height: '100%',
        background: '#f7f8fa',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
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
          background: '#fff',
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
                fontWeight: tab.active ? 600 : 400,
                cursor: 'pointer',
                background: tab.active ? '#f0f1f4' : 'transparent',
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
          onChange={(e) => setDraft({ tabId: activeId, text: e.target.value })}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigateDraft()
            if (e.key === 'Escape') setDraft({ tabId: activeId, text: null })
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
