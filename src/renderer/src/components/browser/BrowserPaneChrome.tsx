// ── Browser pane chrome (A-M5; PLAN-workbench W1) ──
// The in-app browser's user-facing controls: tab strip and address bar with
// back/forward/reload + open-external. The actual page is the native
// WebContentsView positioned by the main-process dock BELOW this chrome —
// heights must stay in sync via PANE_CHROME_HEIGHT (which includes the
// workbench's own tool-tab strip). Positioning and the width drag handle
// belong to WorkbenchPane; this component fills its parent. The tab strip's two
// edges fade while a tab sits beyond them — the same affordance the file tab
// strip carries (common/StripEdgeFades, 2026-10-30 用户裁定).

import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, Plus, X, Clock, Trash2, Star, StarOff } from 'lucide-react'
import { StripEdgeFades, useStripFades } from '../common/StripEdgeFades'
import {
  hostLabel,
  isFreshTabUrl,
  mergeSuggestions,
  normalizeAddressBarInput,
  normalizeFavoriteUrl,
  rankHistorySuggestions,
  type BrowserPaneAction,
  type BrowserPaneUpdate,
  type HistorySuggestionRow,
  type MergedSuggestion,
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
  color: 'var(--pm-text-secondary)',
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
  const [suggestions, setSuggestions] = useState<MergedSuggestion[]>([])
  // 星标态（PLAN-browser-favorites M2）：当前地址是否已收藏，随导航/切 tab 刷新。
  const [starred, setStarred] = useState(false)
  const [starTick, setStarTick] = useState(0)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const activeUrl = activeTab?.url ?? ''
  useEffect(() => {
    if (!activeUrl || isFreshTabUrl(activeUrl)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the previous URL's star while this URL's favorite status is fetched below
      setStarred(false)
      return
    }
    let alive = true
    window.electronAPI.browserFavoriteHas(normalizeFavoriteUrl(activeUrl))
      .then((has) => { if (alive) setStarred(!!has) })
      .catch(() => { if (alive) setStarred(false) })
    return () => { alive = false }
  }, [activeUrl, starTick])
  const toggleStar = () => {
    const url = normalizeFavoriteUrl(activeUrl)
    if (!url) return
    if (starred) {
      window.electronAPI.browserFavoriteRemove(url).then(() => { setStarred(false); setStarTick((t) => t + 1) }).catch(() => {})
    } else {
      const title = activeTab?.title || activeUrl
      window.electronAPI.browserFavoriteAdd(url, title)
        .then((r) => {
          if (r?.ok) setStarred(true)
          setStarTick((t) => t + 1)
        })
        .catch(() => {})
    }
  }
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const inputWrapRef = useRef<HTMLDivElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const suggestSeq = useRef(0)
  const lastQueryRef = useRef('')

  // ── Empty state (PLAN-browser-pane-ux T4) ──
  // Zero tabs OR a fresh (never-navigated) about:blank tab — main folds the
  // webview for both (isFreshTabUrl, T4.3), so this DOM is fully visible in
  // each; a navigated tab hands the area to the native view.
  const showEmpty = pane.tabs.length === 0 || !activeTab || isFreshTabUrl(activeTab.url)
  const [recents, setRecents] = useState<HistorySuggestionRow[]>([])
  const [recentsTick, setRecentsTick] = useState(0)
  // 空态收藏区（PLAN-browser-favorites M2）：空收藏整区不渲染——不出现
  // 「去收藏吧」的占位营销文案。
  const [favorites, setFavorites] = useState<Array<{ url: string; title: string | null; createdAt: number; updatedAt: number }>>([])
  const [hoverFav, setHoverFav] = useState<string | null>(null)
  useEffect(() => {
    if (!showEmpty) return
    let alive = true
    window.electronAPI.browserHistoryQuery('')
      .then((rows) => {
        if (alive) setRecents((rows ?? []).slice(0, 6))
      })
      .catch(() => { /* history is best-effort — the guidance copy still shows */ })
    window.electronAPI.browserFavoriteList()
      .then((rows) => {
        if (alive) setFavorites(rows ?? [])
      })
      .catch(() => { /* favorites are best-effort too */ })
    return () => {
      alive = false
    }
  }, [showEmpty, recentsTick])

  const refreshSuggestions = (text: string, open: boolean) => {
    const query = text.trim()
    lastQueryRef.current = query
    if (!query) {
      setSuggestions([])
      setSelectedIdx(-1)
      setDropdownOpen(false)
      return
    }
    const seq = ++suggestSeq.current
    // 收藏先于历史（PLAN-browser-favorites M2）：两个来源并发查，mergeSuggestions
    // 置顶收藏（去重），历史按原 rank 填满 limit。
    Promise.all([
      window.electronAPI.browserFavoriteQuery(query, 8).catch(() => []),
      window.electronAPI.browserHistoryQuery(query).catch(() => []),
    ])
      .then(([favRows, histRows]) => {
        if (seq !== suggestSeq.current) return // a newer draft superseded this
        const ranked = rankHistorySuggestions(query, histRows ?? [], 8)
        const merged = mergeSuggestions(query, favRows ?? [], ranked, 8)
        setSuggestions(merged)
        setSelectedIdx(-1)
        if (open) setDropdownOpen(merged.length > 0)
      })
      .catch(() => { /* history is best-effort — the typed text still navigates */ })
  }

  // 收藏行的删除入口（PLAN-browser-favorites M2 review 补）：下拉行与空态行
  // hover 显形同一个按钮；两个视图各自收敛自己渲染的部分。
  const removeFavoriteUrl = (url: string) => {
    const key = normalizeFavoriteUrl(url)
    if (!key) return
    window.electronAPI.browserFavoriteRemove(key)
      .then(() => {
        setStarTick((t) => t + 1)
        setFavorites((rows) => rows.filter((r) => normalizeFavoriteUrl(r.url) !== key))
        refreshSuggestions(lastQueryRef.current, true)
      })
      .catch(() => { /* favorites are best-effort — the row stays until reload */ })
  }

  const closeDropdown = () => {
    setDropdownOpen(false)
    setSelectedIdx(-1)
    setConfirmingClear(false)
  }

  const navigateTo = (url: string) => {
    const target = normalizeAddressBarInput(url)
    onAction(activeTab ? { op: 'navigate', tabId: activeTab.id, url: target } : { op: 'navigate', url: target })
    setDraft({ tabId: activeId, text: null })
  }

  const openSuggestion = (s: MergedSuggestion) => {
    closeDropdown()
    navigateTo(s.url)
  }

  const clearHistory = () => {
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setConfirmingClear(false)
    closeDropdown()
    void window.electronAPI.browserHistoryClear?.().catch(() => {})
    setRecentsTick((t) => t + 1) // the empty state's 最近访问 list reads the same table
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
  // Both edges fade while a tab sits beyond them — the visible half of "a mouse
  // can scroll this strip too" (see StripEdgeFades; the file tab strip in the
  // 工作区 pane carries the same affordance, 2026-10-30 用户裁定).
  const fades = useStripFades(stripRef, pane.tabs.map((t) => t.id).join('|') + (activeId ?? ''))

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
      data-pm-pane
      style={{
        height: '100%',
        // 面板底色统一为白（用户裁定 2026-09-17）：两条 chrome 行本就 #fff，
        // 这里原来是 #f7f8fa，只在折叠态（空态/无页面）露出来。
        background: 'var(--pm-bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 滚动条隐藏写不了内联伪元素——组件自带一小段 style（Composer 先例）。 */}
      <style>{`.pm-pane-tabstrip { scrollbar-width: none; } .pm-pane-tabstrip::-webkit-scrollbar { display: none; } .pm-pane-empty-item:hover { background: var(--pm-separator-faint); }`}</style>
      {/* Tab strip (32px) */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 6px 0 12px',
          borderBottom: '1px solid var(--pm-separator-faint)',
          background: 'var(--pm-bg)',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
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
                  background: tab.id === activeId ? 'var(--pm-tile-soft)' : 'transparent',
                  boxShadow: tab.id === activeId ? 'var(--pm-shadow-chip)' : 'none',
                  color: tab.id === activeId ? 'var(--pm-text-strong)' : 'var(--pm-text-quiet)',
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
        <StripEdgeFades fades={fades} />
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
          borderBottom: '1px solid var(--pm-separator-faint)',
          background: 'var(--pm-bg)',
        }}
      >
        <div style={{ ...ICON_BUTTON, opacity: activeTab ? 1 : 0.35 }} onClick={() => activeTab && onAction({ op: 'back', tabId: activeTab.id })} title="后退">
          <ArrowLeft size={13} />
        </div>
        <div style={{ ...ICON_BUTTON, opacity: activeTab ? 1 : 0.35 }} onClick={() => activeTab && onAction({ op: 'forward', tabId: activeTab.id })} title="前进">
          <ArrowRight size={13} />
        </div>
        {activeUrl && !isFreshTabUrl(activeUrl) && (
          <div
            style={{ ...ICON_BUTTON, color: starred ? 'var(--pm-accent, #4b7bec)' : undefined }}
            onClick={toggleStar}
            title={starred ? '取消收藏' : '收藏此页'}
          >
            <Star size={12} fill={starred ? 'currentColor' : 'none'} />
          </div>
        )}
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
              border: '1px solid var(--pm-pop-border)',
              outline: 'none',
              color: 'var(--pm-text-strong)',
              background: 'var(--pm-wash-cool)',
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
                background: 'var(--pm-elevated)',
                border: '1px solid var(--pm-pop-border)',
                borderRadius: 10,
                boxShadow: 'var(--pm-shadow-dropdown)',
                overflow: 'hidden',
                zIndex: 40,
              }}
            >
              <div style={{ maxHeight: 232, overflowY: 'auto' }}>
                {suggestions.map((s, i) => (
                  <div
                    key={s.url}
                    data-pm-fav-row={s.favorite ? '1' : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openSuggestion(s)}
                    onMouseEnter={() => setSelectedIdx(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      cursor: 'pointer',
                      background: i === selectedIdx ? 'var(--pm-tile-soft)' : 'transparent',
                    }}
                  >
                    {s.favorite
                      ? <Star size={12} style={{ flexShrink: 0, color: 'var(--pm-accent, #4b7bec)' }} fill="currentColor" />
                      : <Clock size={12} style={{ flexShrink: 0, color: 'var(--pm-text-muted)' }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--pm-text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.url}</div>
                    </div>
                    {s.favorite && i === selectedIdx && (
                      <div
                        data-pm-fav-del
                        title="取消收藏"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          removeFavoriteUrl(s.url)
                        }}
                        style={{ flexShrink: 0, display: 'flex', padding: 2, color: 'var(--pm-text-muted)', cursor: 'pointer' }}
                      >
                        <StarOff size={12} />
                      </div>
                    )}
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
                  borderTop: '1px solid var(--pm-separator-faint)',
                  fontSize: 11,
                  color: confirmingClear ? 'var(--pm-graph-ink-live)' : 'var(--pm-text-quiet)',
                  cursor: 'pointer',
                  background: 'var(--pm-wash)',
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

      {/* 空态（T4）：零页签或未导航的 about:blank 页签——两种状态主进程都把
          webview 折叠了，这块 DOM 才完整可见；历史为空时列表整块隐藏。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {showEmpty ? (
          <div
            data-pm-empty
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 18,
              padding: '24px 20px',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'var(--pm-separator-faint)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Globe size={20} color="var(--pm-text-muted)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--pm-text-strong)' }}>打开一个网页，或让 AI 帮你查资料</div>
              <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', marginTop: 4 }}>在上方输入网址回车，也可以在对话里直接吩咐</div>
            </div>
            {recents.length > 0 && (
              <div
                data-pm-empty-recents
                style={{
                  width: '100%',
                  maxWidth: 280,
                  // 边框盒，否则 6px 内边距会把卡片整体撑到 292 宽。
                  boxSizing: 'border-box',
                  // 近白浅灰（沿用面板转白前那档底色）：白底上刚好读出一层卡，
                  // 再深就成了灰块——用户裁定 2026-09-17「再浅一些」。
                  background: 'var(--pm-wash-cool)',
                  borderRadius: 10,
                  padding: 6,
                }}
              >
                {favorites.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', margin: '2px 0 6px 10px' }}>收藏</div>
                    <div
                      style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}
                      onMouseLeave={() => setHoverFav(null)}
                    >
                      {favorites.slice(0, 4).map((f) => (
                        <div
                          key={f.url}
                          data-pm-empty-item
                          data-pm-fav-row="1"
                          className="pm-pane-empty-item"
                          onClick={() => navigateTo(f.url)}
                          onMouseEnter={() => setHoverFav(f.url)}
                          style={{ padding: '5px 10px', borderRadius: 6, cursor: 'pointer', minWidth: 0 }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Star size={10} style={{ flexShrink: 0, color: 'var(--pm-accent, #4b7bec)' }} fill="currentColor" />
                            <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--pm-text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {f.title || hostLabel(f.url)}
                            </div>
                            {hoverFav === f.url && (
                              <div
                                data-pm-fav-del
                                title="取消收藏"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeFavoriteUrl(f.url)
                                }}
                                style={{ flexShrink: 0, display: 'flex', padding: 2, color: 'var(--pm-text-muted)', cursor: 'pointer' }}
                              >
                                <StarOff size={11} />
                              </div>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {hostLabel(f.url)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {/* 11px + 10px 缩进 = 行内文字左沿（6 + 10），标签与列表共一条左边线。 */}
                <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', margin: '2px 0 6px 10px' }}>最近访问</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {recents.slice(0, 6).map((r) => (
                    <div
                      key={r.url}
                      data-pm-empty-item
                      className="pm-pane-empty-item"
                      onClick={() => navigateTo(r.url)}
                      style={{ padding: '5px 10px', borderRadius: 6, cursor: 'pointer', minWidth: 0 }}
                    >
                      <div style={{ fontSize: 12, color: 'var(--pm-text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.title || hostLabel(r.url)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {hostLabel(r.url)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
