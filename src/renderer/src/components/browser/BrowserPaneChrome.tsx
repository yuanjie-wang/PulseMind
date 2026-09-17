// ── Browser pane chrome (A-M5; PLAN-workbench W1) ──
// The in-app browser's user-facing controls: tab strip and address bar with
// back/forward/reload + open-external. The actual page is the native
// WebContentsView positioned by the main-process dock BELOW this chrome —
// heights must stay in sync via PANE_CHROME_HEIGHT (which includes the
// workbench's own tool-tab strip). Positioning and the width drag handle
// belong to WorkbenchPane; this component fills its parent.

import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Plus, X, Clock, Trash2 } from 'lucide-react'
import {
  normalizeAddressBarInput,
  rankHistorySuggestions,
  type BrowserPaneAction,
  type BrowserPaneUpdate,
  type RankedSuggestion,
} from '../../../../shared/browser/pane'
import { useBrowserPaneStore } from '../../stores/browserPaneStore'

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
  // 乐观激活（PLAN-browser-pane-ux T1.1）：点击当帧生效，主进程快照到达即清
  // （main 是事实源）。目标页签的 url/title 从 pane.tabs 按 id 直接取，乐观 id
  // 对应的页签已被快照删除时自动回落到权威激活——地址栏、前进/后退/刷新、
  // 外开按钮全部读它，点击的视觉反馈不再等一个 IPC 往返。
  const optimisticActiveId = useBrowserPaneStore((s) => s.optimisticActiveId)
  const setOptimisticActive = useBrowserPaneStore((s) => s.setOptimisticActive)
  const activeId =
    optimisticActiveId && pane.tabs.some((t) => t.id === optimisticActiveId)
      ? optimisticActiveId
      : (active?.id ?? '')
  const activeTab = activeId ? (pane.tabs.find((t) => t.id === activeId) ?? null) : null
  // Address-bar draft, scoped to the tab it was typed in — switching tabs
  // naturally shows the new tab's URL without a reset effect.
  const [draft, setDraft] = useState<{ tabId: string; text: string | null }>({ tabId: '', text: null })
  // A pane with no tab yet is a real state (the workbench's 浏览器 tab can be
  // opened before anything created one), and it is the SAME bucket as "the
  // active tab is gone": the field must still take keystrokes — it is the only
  // way to say where to go — so an absent tab reads as an empty id rather than
  // gating every handler.
  // A just-opened tab sits on about:blank, and showing it in the field is a
  // trap: typing appends ("about:blank" + "mail.163.com"), the scheme passes
  // the whitelist untouched, and the navigation dies silently. A fresh tab is
  // an empty field, exactly like a real browser's new-tab page.
  const shownTabUrl = activeTab && activeTab.url !== '' && activeTab.url !== 'about:blank' ? activeTab.url : ''
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
    onAction(activeTab ? { op: 'navigate', tabId: activeTab.id, url } : { op: 'navigate', url })
    setDraft({ tabId: activeId, text: activeTab ? null : typed })
  }

  // ── Address-bar history dropdown (PLAN-browser-pane-ux T3.5) ──
  // Focused + non-empty draft → suggestions from the GLOBAL history (manual
  // navigation only). The dropdown overhangs the webview area, and a
  // WebContentsView paints above all DOM — so its measured height rides the
  // pane-state push and the main-process dock shifts the webview down while
  // it is open.
  const [suggestions, setSuggestions] = useState<RankedSuggestion[]>([])
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const inputWrapRef = useRef<HTMLDivElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const suggestSeq = useRef(0)

  const refreshSuggestions = (text: string, open: boolean) => {
    const query = text.trim()
    if (!query) {
      setSuggestions([])
      setSelectedIdx(-1)
      setDropdownOpen(false)
      return
    }
    const seq = ++suggestSeq.current
    window.electronAPI.browserHistoryQuery(query)
      .then((rows) => {
        if (seq !== suggestSeq.current) return // a newer draft superseded this
        const ranked = rankHistorySuggestions(query, rows ?? [], 8)
        setSuggestions(ranked)
        setSelectedIdx(-1)
        if (open) setDropdownOpen(ranked.length > 0)
      })
      .catch(() => { /* history is best-effort — the typed text still navigates */ })
  }

  const closeDropdown = () => {
    setDropdownOpen(false)
    setSelectedIdx(-1)
    setConfirmingClear(false)
  }

  const openSuggestion = (s: RankedSuggestion) => {
    closeDropdown()
    const url = normalizeAddressBarInput(s.url)
    onAction(activeTab ? { op: 'navigate', tabId: activeTab.id, url } : { op: 'navigate', url })
    // The chosen suggestion becomes the field's address (it IS where we're going).
    setDraft({ tabId: activeId, text: null })
  }

  const clearHistory = () => {
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    closeDropdown()
    void window.electronAPI.browserHistoryClear?.().catch(() => {})
  }

  // Report the dropdown's actual height so the dock can make room for it.
  useEffect(() => {
    const el = dropdownRef.current
    if (!dropdownOpen || !el) {
      useBrowserPaneStore.getState().setChromeOverlayHeight(0)
      return
    }
    const report = () => useBrowserPaneStore.getState().setChromeOverlayHeight(el.getBoundingClientRect().height + 4)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dropdownOpen, suggestions, confirmingClear])

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!dropdownOpen) return
    const onDown = (e: MouseEvent) => {
      if (inputWrapRef.current?.contains(e.target as Node)) return
      closeDropdown()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dropdownOpen])

  // ── Tab-strip overflow (PLAN-browser-pane-ux T2) ──
  // Tabs shrink to a floor before the strip scrolls (Chrome-style); no arrow
  // buttons (裁定 L5). Heights stay exactly 32/36 — PANE_CHROME_HEIGHT is a
  // pixel contract with the main-process dock.
  const stripRef = useRef<HTMLDivElement | null>(null)

  // 滚轮横滑：竖向滚轮手势换算成横向滚动。passive: false 才能 preventDefault，
  // 否则外层滚动容器（工作台）会跟着滚。
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 激活页签自动露出（乐观切换也触发）。手动写 scrollLeft，禁用
  // scrollIntoView —— 它会连滚外层滚动容器（probe-panel-scroll 的老教训）。
  useEffect(() => {
    const el = stripRef.current
    if (!el || !activeId) return
    const tab = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`)
    if (!tab) return
    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }, [activeId, pane.tabs.length])

  return (
    <div
      style={{
        height: '100%',
        background: '#f7f8fa',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 滚动条隐藏写不了内联伪元素——组件自带一小段 style（Composer 先例）。 */}
      <style>{`.pm-pane-tabstrip { scrollbar-width: none; } .pm-pane-tabstrip::-webkit-scrollbar { display: none; }`}</style>
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
        <div
          ref={stripRef}
          className="pm-pane-tabstrip"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
        >
          {pane.tabs.map((tab) => (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => {
                if (tab.id === activeId) return
                setOptimisticActive(tab.id)
                onAction({ op: 'selectTab', tabId: tab.id })
              }}
              title={tab.title || tab.url}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 140,
                minWidth: 64,
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: tab.id === activeId ? 600 : 400,
                cursor: 'pointer',
                background: tab.id === activeId ? '#f0f1f4' : 'transparent',
                boxShadow: tab.id === activeId ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                color: tab.id === activeId ? '#333' : '#888',
                flexShrink: 1,
                flexBasis: 'auto',
                overflow: 'hidden',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title || tab.url || '新标签页'}</span>
              <X
                size={11}
                onClick={(e) => {
                  e.stopPropagation()
                  if (tab.id === activeId) setOptimisticActive(null)
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
        <div style={{ ...ICON_BUTTON, opacity: activeTab ? 1 : 0.35 }} onClick={() => activeTab && onAction({ op: 'back', tabId: activeTab.id })} title="后退">
          <ArrowLeft size={13} />
        </div>
        <div style={{ ...ICON_BUTTON, opacity: activeTab ? 1 : 0.35 }} onClick={() => activeTab && onAction({ op: 'forward', tabId: activeTab.id })} title="前进">
          <ArrowRight size={13} />
        </div>
        <div style={{ ...ICON_BUTTON, opacity: activeTab ? 1 : 0.35 }} onClick={() => activeTab && onAction({ op: 'reload', tabId: activeTab.id })} title="刷新">
          <RotateCw size={12} />
        </div>
        <div ref={inputWrapRef} style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', alignItems: 'center', alignSelf: 'stretch' }}>
          <input
            value={shownUrl}
            placeholder="输入网址，回车打开"
            onChange={(e) => {
              setDraft({ tabId: activeId, text: e.target.value })
              refreshSuggestions(e.target.value, true)
            }}
            onFocus={(e) => {
              e.currentTarget.select()
              if ((draft.tabId === activeId ? draft.text : null)?.trim()) refreshSuggestions(draft.text ?? '', true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && dropdownOpen && suggestions.length > 0) {
                e.preventDefault()
                setSelectedIdx((i) => (i + 1) % suggestions.length)
                return
              }
              if (e.key === 'ArrowUp' && dropdownOpen && suggestions.length > 0) {
                e.preventDefault()
                setSelectedIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
                return
              }
              if (e.key === 'Enter') {
                if (dropdownOpen && selectedIdx >= 0 && suggestions[selectedIdx]) {
                  openSuggestion(suggestions[selectedIdx])
                  return
                }
                navigateDraft()
                closeDropdown()
                return
              }
              if (e.key === 'Escape') {
                // Esc 先关下拉，再按才清空输入——两段语义（裁定 T3.5）。
                if (dropdownOpen) closeDropdown()
                else setDraft({ tabId: activeId, text: null })
              }
            }}
            onBlur={() => {
              // Suggestion clicks run on mousedown-prevented items, so blur
              // closing immediately is safe; the timeout only covers focus
              // juggling inside the row.
              window.setTimeout(() => {
                if (!inputWrapRef.current?.contains(document.activeElement)) setDropdownOpen(false)
              }, 120)
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
          {dropdownOpen && (
            <div
              ref={dropdownRef}
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                background: '#fff',
                border: '1px solid #e5e6eb',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                overflow: 'hidden',
                zIndex: 40,
              }}
            >
              <div style={{ maxHeight: 232, overflowY: 'auto' }}>
                {suggestions.map((s, i) => (
                  <div
                    key={s.url}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openSuggestion(s)}
                    onMouseEnter={() => setSelectedIdx(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      cursor: 'pointer',
                      background: i === selectedIdx ? '#f0f1f4' : 'transparent',
                    }}
                  >
                    <Clock size={12} style={{ flexShrink: 0, color: '#999' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: '#333', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
                      <div style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.url}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div
                onClick={clearHistory}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderTop: '1px solid #ececf0',
                  fontSize: 11,
                  color: confirmingClear ? '#b4453c' : '#888',
                  cursor: 'pointer',
                  background: '#fafafa',
                }}
              >
                <Trash2 size={12} />
                {confirmingClear ? '确认清除全部浏览记录？' : '清除浏览记录'}
              </div>
            </div>
          )}
        </div>
        <div
          style={{ ...ICON_BUTTON, opacity: activeTab?.url ? 1 : 0.35 }}
          onClick={() => activeTab?.url && onAction({ op: 'openExternal', url: activeTab.url })}
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
