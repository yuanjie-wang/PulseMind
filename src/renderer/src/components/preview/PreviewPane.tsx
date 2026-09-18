// ── Preview pane body (PLAN-preview-pane §设计3; PLAN-workbench W1;
//    PLAN-preview-edit T2/T3) ──
// The workbench's FILE tab content: file tab strip, toolbar (edit toggle /
// save / refresh / open-in-system), and the per-kind content dispatcher. Positioning and the drag handle belong to WorkbenchPane — this
// component always fills its parent. Pure DOM — no native WebContentsView
// behind it. Editing state (drafts / edit modes / dirty dots) lives in
// previewPaneStore; the save path is owned HERE so ⌘S inside the editor and
// the toolbar button share one write+refresh sequence (they meet at the
// `pulsemind-preview-save` event).

import React, { useEffect, useRef } from 'react'
import { Modal, message } from 'antd'
import { RotateCw, FolderOpen, X, FileText, Eye, PenLine, Save, MousePointerClick } from 'lucide-react'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { useHtmlEditStore } from '../../stores/htmlEditStore'
import { isDirty, serializeDraft } from '../../stores/preview-edit'
import { detectFileKind } from '../../../../shared/preview/file-kind'
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
}

export function PreviewPane({ conversationId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const convArg = conversationId ?? null
  const tabs = usePreviewPaneStore((s) => s.tabsByConversation[key])
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const reloadTicks = usePreviewPaneStore((s) => s.reloadTicks)
  const drafts = usePreviewPaneStore((s) => s.drafts)
  const previewModes = usePreviewPaneStore((s) => s.previewModes)
  const oversized = usePreviewPaneStore((s) => s.oversized)

  // ── The one save path (D5): draft → serialize (EOL/BOM restored) →
  // writeFile → adopt as new baseline → bumpReload. The html iframe's
  // key={reloadTick} remounts it, so no special-casing there. A source-mode
  // save also drops any element-edit session — the session's file text no
  // longer matches the disk, and it would re-initialize from the new text
  // on the next entry. ──
  const saveDraft = async (path: string) => {
    const store = usePreviewPaneStore.getState()
    const entry = store.drafts[path]
    if (!entry) return
    try {
      // expectContent = the draft's baseline: if the disk moved under the
      // draft (terminal / other process / a window the D8 bump missed), the
      // main side refuses the overwrite instead of silently clobbering the
      // external edit (review 2026-09-18 M6). The bumpReload below then
      // re-reads and the normal conflict decision asks the user.
      const res = await window.electronAPI.writeFile({
        filePath: path,
        content: serializeDraft(entry),
        expectContent: entry.baseline,
      })
      if (res && res.success === false) {
        void message.error(res.error || 'Save failed')
        store.bumpReload(path)
        return
      }
      store.setDraft(path, { ...entry, baseline: entry.content })
      store.clearExternalChange(path)
      useHtmlEditStore.getState().forgetFile(path)
      store.bumpReload(path)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : 'Save failed')
    }
  }

  useEffect(() => {
    const onSaveRequest = (e: Event) => {
      const path = (e as CustomEvent<string>).detail
      void saveDraft(path)
    }
    window.addEventListener('pulsemind-preview-save', onSaveRequest)
    return () => window.removeEventListener('pulsemind-preview-save', onSaveRequest)
  }, [])

  // ── Tab-strip overflow (mirrors BrowserPaneChrome) ──
  // Tabs shrink to a floor (minWidth 64) before the strip scrolls; heights stay
  // exactly 32/36 — that is a pixel contract with the main-process workbench.
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

  // 激活页签自动露出。手动写 scrollLeft，禁用 scrollIntoView —— 它会连滚外层
  // 滚动容器（probe-panel-scroll 的老教训）。坐标一律用 bounding rect 换算成
  // 滚动内容坐标：这棵子树里页签的 offsetParent 是 body（没有定位祖先），
  // offsetLeft 会把滚动容器自己的 12px 左边距算进去，照抄会多滚一格边距。
  const revealPath =
    tabs && tabs.length > 0
      ? tabs.some((tab) => tab.path === activePath)
        ? activePath
        : tabs[tabs.length - 1].path
      : null
  useEffect(() => {
    const el = stripRef.current
    if (!el || !revealPath) return
    const tab = el.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(revealPath)}"]`)
    if (!tab) return
    const left = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft
    const right = left + tab.getBoundingClientRect().width
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }, [revealPath, tabs?.length])

  if (!tabs || tabs.length === 0) {
    return (
      <div style={{ padding: 24, fontSize: 12, color: '#999', textAlign: 'center' }}>
        <FileText size={20} style={{ display: 'block', margin: '0 auto 8px', color: '#d9d9d9' }} />
        暂无打开的文件
        <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>AI 写入的文件会在这里实时预览</div>
      </div>
    )
  }

  const active = tabs.find((tab) => tab.path === activePath) ?? tabs[tabs.length - 1]
  const store = usePreviewPaneStore.getState()
  const activeKind = detectFileKind(active.path)
  const editableKind = activeKind === 'markdown' || activeKind === 'text' || activeKind === 'csv' || activeKind === 'html'
  const mode = previewModes[active.path] ?? 'view'
  const editOn = mode === 'source'
  const oversizedActive = !!oversized[active.path]
  // 元素模式与源码模式共用同一个大小闸（review 2026-09-18 M10）：超限 HTML
  // 不再进入元素模式——每步编辑都会解析并全量回写整份文件。
  const elementOn = mode === 'element' && activeKind === 'html' && !oversizedActive
  const dirty = !!drafts[active.path] && isDirty(drafts[active.path])
  const editDisabled = !editableKind || oversizedActive

  const toggleSource = () => {
    if (editDisabled) return
    store.setPreviewMode(active.path, editOn ? 'view' : 'source')
  }

  const toggleElement = () => {
    if (activeKind !== 'html') return
    if (oversizedActive) {
      void message.info(t('previewPane.tooLarge'))
      return
    }
    store.setPreviewMode(active.path, elementOn || mode === 'element' ? 'view' : 'element')
  }

  const requestCloseTab = (path: string) => {
    const entry = drafts[path]
    if (!(entry && isDirty(entry))) {
      store.closeTab(convArg, path)
      return
    }
    // D10: closing a dirty tab asks — nothing silent, nothing auto-saved.
    Modal.confirm({
      title: t('previewPane.closeDirtyTitle'),
      content: t('previewPane.closeDirtyBody'),
      okText: t('previewPane.closeDiscard'),
      okButtonProps: { danger: true },
      cancelText: t('previewPane.closeCancel'),
      onOk: () => store.closeTab(convArg, path),
    })
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      {/* Tab hover is a stylesheet rule, so it cannot ride the tab's inline
          style (inline declarations win). The scrollbar is hidden the same way
          — a pseudo-element cannot be written inline (Composer precedent).
          The selected tab wears the same light grey as its hover state (the
          in-app browser pane does the same); the shadow is what still tells
          the two apart at rest. */}
      <style>{`.pm-preview-tabstrip { scrollbar-width: none; } .pm-preview-tabstrip::-webkit-scrollbar { display: none; } .pm-preview-tab { background: transparent; } .pm-preview-tab[data-active='true'] { background: #f0f1f4; box-shadow: 0 1px 2px rgba(0,0,0,0.08); } .pm-preview-tab:hover { background: #f0f1f4; }`}</style>
      {/* File tab strip (32px) */}
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
          className="pm-preview-tabstrip"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
        >
          {tabs.map((tab) => {
            const tabDirty = !!drafts[tab.path] && isDirty(drafts[tab.path])
            return (
              <div
                key={tab.path}
                data-tab-path={tab.path}
                data-active={tab.path === active.path}
                className="pm-preview-tab"
                onClick={() => tab.path !== active.path && store.setActive(convArg, tab.path)}
                title={tab.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  maxWidth: 140,
                  minWidth: 64,
                  padding: '3px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: 'pointer',
                  color: tab.path === active.path ? '#333' : '#888',
                  flexShrink: 1,
                  flexBasis: 'auto',
                  overflow: 'hidden',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
                {tabDirty && (
                  <span
                    title={t('previewPane.dirtyDot')}
                    style={{ width: 6, height: 6, borderRadius: '50%', background: '#fa8c16', flexShrink: 0 }}
                  />
                )}
                <X
                  size={11}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestCloseTab(tab.path)
                  }}
                  style={{ flexShrink: 0, opacity: 0.6 }}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Toolbar row (36px): edit toggle / save / refresh / path / open-in-system */}
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
        {/* Element-edit toggle (html only): the PRIMARY entry per the
            element-edit plan; source stays as the advanced escape hatch. */}
        {activeKind === 'html' && (
          <div
            style={{
              ...ICON_BUTTON,
              opacity: oversizedActive && !elementOn ? 0.35 : 1,
              background: elementOn ? '#fff7e6' : 'transparent',
              color: elementOn ? '#d46b08' : '#666',
            }}
            onClick={toggleElement}
            title={oversizedActive && !elementOn ? t('previewPane.tooLarge') : t('htmlEdit.modeToggle')}
          >
            <MousePointerClick size={13} />
          </div>
        )}
        <div
          style={{
            ...ICON_BUTTON,
            opacity: editDisabled ? 0.35 : 1,
            background: editOn ? '#e6f4ff' : 'transparent',
            color: editOn ? '#1677ff' : '#666',
          }}
          onClick={toggleSource}
          title={editDisabled ? t('previewPane.editNotAvailable') : editOn ? t('previewPane.view') : t('previewPane.edit')}
        >
          {editOn ? <Eye size={13} /> : <PenLine size={12} />}
        </div>
        <div
          style={{ ...ICON_BUTTON, opacity: dirty ? 1 : 0.35, color: dirty ? '#1677ff' : '#666' }}
          onClick={() => void saveDraft(active.path)}
          title={t('previewPane.save')}
        >
          <Save size={13} />
        </div>
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
          {/* The box is `direction: rtl` so the ellipsis eats the path's head
              and the file name stays readable — but an RTL paragraph reorders
              the path's leading `/` (a neutral) to the visual END, so the path
              read `…/report.docx/`. `unicode-bidi: embed` + LTR on an inner
              span restores the natural order without touching the truncation. */}
          <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{active.path}</span>
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => void window.electronAPI.openFolder(active.path).catch(() => {})} title={t('previewPane.openInOs')}>
          <FolderOpen size={13} />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: editOn || elementOn ? 'hidden' : 'auto' }}>
        <PreviewContent key={active.path} path={active.path} reloadTick={reloadTicks[active.path] ?? 0} />
      </div>
    </div>
  )
}
