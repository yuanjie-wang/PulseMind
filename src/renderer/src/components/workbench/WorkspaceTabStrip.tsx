// ── 工作区文件页签条 (2026-10-30, 用户裁定) ──
// The 工作区 pane's top strip, spanning the WHOLE pane (the tree column sits
// under it too): one chip per open preview file, click to bring it to the
// front, ✕ to close. It takes the position the address bar held from
// 2026-10-25 until today; the address bar moved down into the preview column,
// directly above the preview (WorkspaceAddressBar).
//
// Form follows the strip that lived INSIDE PreviewPane until 0e3cd23
// (2026-10-28, 「工作区地址栏 + 文件 tab 预览重构」): same 32px row, same
// shrink-then-scroll overflow, same wheel-to-horizontal conversion, same
// manual scrollLeft reveal (scrollIntoView would drag the workbench's own
// scroller — the probe-panel-scroll lesson) — plus the two edge fades that make
// the overflow visible to a MOUSE user, whose only gesture is a vertical wheel
// (2026-10-30: the hidden scrollbar told a trackpad user everything and a mouse
// user nothing; see common/StripEdgeFades, shared with the browser tab strip).
// Two things it gains, because the pane's bookkeeping now exists: the
// session-change ink ON THE TAB TEXT (2026-10-30 用户裁定「页签不要圆点，直接改
// 文字颜色」— the tree rows' created/modified inks, unsaved orange wins while
// edits are unsaved) and the ARIA role set the old strip never had.
//
// The ▾ at the far LEFT (2026-10-30, 用户裁定) is the scroll-proof way in: a
// dropdown listing every open file — reachable no matter where the strip is
// scrolled, and the one affordance that works identically for trackpad and
// mouse. Same ledger ink as the chips; picking an item is `setActive`, the
// very call a chip's click makes.
//
// Closing a tab holding unsaved edits asks first (PLAN-preview-edit D10:
// nothing is discarded silently) — the four i18n keys that dialog needs had
// been deleted a day before the strip was; they are back in both locales.

import React, { useEffect, useMemo, useRef } from 'react'
import { Dropdown, Modal } from 'antd'
import type { MenuProps } from 'antd'
import { ChevronDown, X } from 'lucide-react'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { isDirty } from '../../stores/preview-edit'
import { NO_FILE_CHANGES, useSessionFileChangesStore } from '../../stores/sessionFileChangesStore'
import { fileChangeMarks, normalizeChangePath } from '../../../../shared/agent-session/file-changes'
import { StripEdgeFades, useStripFades } from '../common/StripEdgeFades'
import { useTranslation } from '../../i18n/useTranslation'

interface Props {
  conversationId: string | undefined
}

export function WorkspaceTabStrip({ conversationId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const convArg = conversationId ?? null
  const tabs = usePreviewPaneStore((s) => s.tabsByConversation[key])
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const drafts = usePreviewPaneStore((s) => s.drafts)
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)
  const changes = useSessionFileChangesStore((s) => (conversationId ? s.byConversation[conversationId] : undefined)) ?? NO_FILE_CHANGES

  // One ledger read for the whole strip — the same paint map the tree rows and
  // the address bar build (keyed by the same normalizeChangePath spelling).
  const marks = useMemo(() => (workspaceDir ? fileChangeMarks(changes, workspaceDir) : new Map()), [changes, workspaceDir])

  // ── Overflow (mirrors BrowserPaneChrome) ──
  // Tabs shrink to a floor (minWidth 64) before the strip scrolls, and both
  // edges fade while there is a chip beyond them (see StripEdgeFades — the
  // visible half of "a mouse can scroll here too").
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tabList = tabs ?? []
  const fades = useStripFades(stripRef, tabList.map((t) => t.path).join('|') + (activePath ?? ''))

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
  const list = tabList
  const revealPath = list.length > 0 ? (list.some((tab) => tab.path === activePath) ? activePath : list[list.length - 1].path) : null
  useEffect(() => {
    const el = stripRef.current
    if (!el || !revealPath) return
    const tab = el.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(revealPath)}"]`)
    if (!tab) return
    const left = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft
    const right = left + tab.getBoundingClientRect().width
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }, [revealPath, list.length])

  const requestClose = (path: string): void => {
    const entry = drafts[path]
    if (!(entry && isDirty(entry))) {
      usePreviewPaneStore.getState().closeTab(convArg, path)
      return
    }
    // D10: closing a dirty tab asks — nothing silent, nothing auto-saved.
    Modal.confirm({
      title: t('previewPane.closeDirtyTitle'),
      content: t('previewPane.closeDirtyBody'),
      okText: t('previewPane.closeDiscard'),
      okButtonProps: { danger: true },
      cancelText: t('previewPane.closeCancel'),
      onOk: () => usePreviewPaneStore.getState().closeTab(convArg, path),
    })
  }

  // The ▾ quick-switcher's list: every open file, in open order, wearing the
  // chips' ink (same ledger, same literal orange). `key` is the path, so
  // one menu `onClick` covers every item and `selectedKeys` names the one on
  // screen while the dropdown is open.
  const menuItems: MenuProps['items'] = list.map((tab) => {
    const tabDirty = !!drafts[tab.path] && isDirty(drafts[tab.path])
    const mark = marks.get(normalizeChangePath(tab.path)) ?? null
    const tabInk = tabDirty ? '#fa8c16' : mark ? `var(--pm-ws-${mark})` : undefined
    return {
      key: tab.path,
      label: (
        <span
          title={tab.path}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260, color: tabInk }}
        >
          {tab.title}
        </span>
      ),
    }
  })

  return (
    <div
      data-ws-tabstrip-row
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
      {/* Tab hover/active backgrounds are stylesheet rules — an inline
          declaration would win over :hover, and a pseudo-element cannot be
          written inline (BrowserPaneChrome precedent). The selected tab wears
          the same light grey as its hover state; the shadow is what still tells
          the two apart at rest. */}
      <style>{`.pm-ws-tabstrip { scrollbar-width: none; } .pm-ws-tabstrip::-webkit-scrollbar { display: none; } .pm-ws-tab { background: transparent; } .pm-ws-tab[data-active='true'] { background: var(--pm-tile-soft); box-shadow: var(--pm-shadow-chip); } .pm-ws-tab:hover { background: var(--pm-tile-soft); } .pm-ws-tab-close { width: 14px; height: 14px; padding: 0; border: none; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: inherit; opacity: 0.6; cursor: pointer; flex: none; } .pm-ws-tab-close:hover { opacity: 1; background: var(--pm-hover); } .pm-ws-tab-menu { width: 22px; height: 22px; padding: 0; border: none; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--pm-text-quiet); cursor: pointer; flex: none; } .pm-ws-tab-menu:hover { background: var(--pm-hover); color: var(--pm-graph-ink); }`}</style>
      {/* The ▾ quick-switcher: the strip's far-left button. A real <button> so
          keyboard focus works; antd Dropdown supplies the menu semantics. With
          nothing open it greys out but keeps its 22px — the strip row's
          geometry must not shift when the first file opens (the same ruling
          that keeps the empty row itself). */}
      <Dropdown
        menu={{
          items: menuItems,
          selectedKeys: activePath ? [activePath] : [],
          onClick: ({ key }) => usePreviewPaneStore.getState().setActive(convArg, key),
        }}
        trigger={['click']}
        disabled={list.length === 0}
      >
        <button
          type="button"
          className="pm-ws-tab-menu"
          data-ws-tabstrip-menu
          aria-label={t('previewPane.tabList')}
          title={t('previewPane.tabList')}
          style={{ opacity: list.length === 0 ? 0.35 : 1, cursor: list.length === 0 ? 'default' : 'pointer' }}
        >
          <ChevronDown size={13} />
        </button>
      </Dropdown>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
        <div
          ref={stripRef}
          className="pm-ws-tabstrip"
          data-ws-tabstrip
          role="tablist"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}
        >
          {list.length === 0 ? (
            // The strip keeps its row when nothing is open (user ruling
            // 2026-10-30): opening the first file must not shift the tree column
            // down, and an empty bordered row reads as broken without a word.
            <span data-ws-tabstrip-empty style={{ fontSize: 11, color: 'var(--pm-text-faint)', whiteSpace: 'nowrap' }}>
              {t('previewPane.tabEmptyHint')}
            </span>
          ) : (
            list.map((tab) => {
              const active = tab.path === activePath
              const tabDirty = !!drafts[tab.path] && isDirty(drafts[tab.path])
              const mark = marks.get(normalizeChangePath(tab.path)) ?? null
              // 改动状态直接落在文字上（2026-10-30 用户裁定「页签不要圆点，直接
              // 改文字颜色」）：未保存橙 > 台账 ink —— 脏页签是要行动的状态，
              // 保存之后台账 ink 自然回来。两者都 absent 才回到常规墨色。
              const tabInk = tabDirty ? '#fa8c16' : mark ? `var(--pm-ws-${mark})` : null
              return (
                <div
                  key={tab.path}
                  className="pm-ws-tab"
                  data-tab-path={tab.path}
                  data-active={active}
                  role="tab"
                  aria-selected={active}
                  onClick={() => !active && usePreviewPaneStore.getState().setActive(convArg, tab.path)}
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
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    color: tabInk ?? (active ? 'var(--pm-text-strong)' : 'var(--pm-text-quiet)'),
                    flexShrink: 1,
                    flexBasis: 'auto',
                    overflow: 'hidden',
                  }}
                >
                  {/* flex: 1 so the ✕ rides the chip's right edge and the chip's
                      MIDDLE stays the title — a click there must activate the tab,
                      not close it (the probe caught the collapse: the title and the
                      button were adjacent, and the centre of a narrow chip landed
                      on the button). */}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
                  <button
                    type="button"
                    className="pm-ws-tab-close"
                    title={t('previewPane.closeTab')}
                    aria-label={t('previewPane.closeTab')}
                    onClick={(e) => {
                      e.stopPropagation()
                      requestClose(tab.path)
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            })
          )}
        </div>
        <StripEdgeFades fades={fades} />
      </div>
    </div>
  )
}
