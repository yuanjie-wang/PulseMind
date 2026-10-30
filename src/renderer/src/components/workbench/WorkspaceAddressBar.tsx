// ── 工作区地址栏 (2026-10-25; 2026-10-30 移入预览列并改语义) ──
// The preview COLUMN's top strip (2026-10-30, 用户裁定: it moved down out of the
// pane's top row — the file tab strip lives there now): the ACTIVE PREVIEW
// FILE's absolute path on the left (the workspace root when nothing is open),
// and on the right 打开 (shell-open that file — folders land in Finder, files
// in their default app, both through the same executable-gated IPC) plus a ⋯
// 更多 dropdown holding the preview actions: 编辑 / 元素编辑 / 保存 / 刷新.
// It names the file ON SCREEN, not the tree selection (the ruling that moved
// it): the tree's own rows paint what is selected, and a folder opened in
// Finder now rides the row's hover action (WorkspaceTree) — the bar no longer
// speaks for a folder the preview is not showing.
// No change/dirty dots (2026-10-30 用户裁定): the session-change inks live on
// the tree rows and the tab TEXT, and the dirty state is the ⋯ menu's 保存
// enablement — the bar is a nameplate, not a status row. Height is the tree
// toolbar's 32px (4 + 24 + 4), so the two columns' first strips line up.

import React from 'react'
import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import { Check, Eye, FolderOpen, MoreHorizontal, PenLine, RotateCw, Save } from 'lucide-react'
import { detectFileKind } from '../../../../shared/preview/file-kind'
import { isDirty } from '../../stores/preview-edit'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useTranslation } from '../../i18n/useTranslation'

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

interface Props {
  conversationId: string | undefined
}

export function WorkspaceAddressBar({ conversationId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const workspaceDir = usePreviewPaneStore((s) => s.workspaceDir)
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const drafts = usePreviewPaneStore((s) => s.drafts)
  const previewModes = usePreviewPaneStore((s) => s.previewModes)
  const oversized = usePreviewPaneStore((s) => s.oversized)

  // The file on screen — and only it (2026-10-30 裁定). Nothing open = the
  // workspace root, so the row still says where this conversation lives.
  const displayPath = activePath ?? workspaceDir
  // The menu targets the file ON SCREEN, like the path beside it.
  const activeKind = activePath ? detectFileKind(activePath) : null
  const editableKind = activeKind === 'markdown' || activeKind === 'text' || activeKind === 'csv' || activeKind === 'html'
  const mode = activePath ? (previewModes[activePath] ?? 'view') : 'view'
  const editOn = mode === 'source'
  const elementOn = mode === 'element' && activeKind === 'html'
  const dirty = !!activePath && !!drafts[activePath] && isDirty(drafts[activePath])
  const oversizedActive = !!activePath && !!oversized[activePath]
  const editDisabled = !activePath || !editableKind || oversizedActive

  const toggleSource = () => {
    if (!activePath || editDisabled) return
    usePreviewPaneStore.getState().setPreviewMode(activePath, editOn ? 'view' : 'source')
  }

  const toggleElement = () => {
    if (!activePath || activeKind !== 'html') return
    if (oversizedActive) {
      void message.info(t('previewPane.tooLarge'))
      return
    }
    usePreviewPaneStore.getState().setPreviewMode(activePath, elementOn ? 'view' : 'element')
  }

  const saveActive = () => {
    if (!activePath) return
    // The one save seam: PreviewPane owns the write sequence and both ⌘S in
    // the editor and this menu item meet at the event.
    window.dispatchEvent(new CustomEvent('pulsemind-preview-save', { detail: activePath }))
  }

  const items: MenuProps['items'] = [
    {
      key: 'edit',
      icon: editOn ? <Eye size={13} /> : <PenLine size={13} />,
      label: editDisabled ? t('previewPane.editNotAvailable') : editOn ? t('previewPane.view') : t('previewPane.edit'),
      disabled: editDisabled,
      onClick: toggleSource,
    },
    ...(activeKind === 'html'
      ? [
          {
            key: 'element',
            icon: <Check size={13} style={{ visibility: elementOn ? 'visible' : 'hidden' }} />,
            label: t('htmlEdit.modeToggle'),
            onClick: toggleElement,
          },
        ]
      : []),
    { type: 'divider' as const },
    {
      key: 'save',
      icon: <Save size={13} />,
      label: t('previewPane.save'),
      disabled: !dirty,
      onClick: saveActive,
    },
    {
      key: 'refresh',
      icon: <RotateCw size={12} />,
      label: t('previewPane.refresh'),
      disabled: !activePath,
      onClick: () => activePath && usePreviewPaneStore.getState().bumpReload(activePath),
    },
  ]

  return (
    <div
      data-ws-address
      style={{
        height: 32,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 8px 0 12px',
        borderBottom: '1px solid var(--pm-separator-faint)',
        background: 'var(--pm-bg)',
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          color: 'var(--pm-text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          direction: 'rtl',
          textAlign: 'left',
        }}
        title={displayPath ?? undefined}
      >
        {/* The box is `direction: rtl` so the ellipsis eats the path's head
            and the file name stays readable — but an RTL paragraph reorders
            the path's leading `/` (a neutral) to the visual END, so the path
            read `…/report.docx/`. `unicode-bidi: embed` + LTR on an inner
            span restores the natural order without touching the truncation. */}
        <span style={{ direction: 'ltr', unicodeBidi: 'embed' }} data-ws-address-path>
          {displayPath ?? '当前会话暂无工作目录'}
        </span>
      </div>
      <div
        data-ws-open
        style={{ ...ICON_BUTTON, opacity: displayPath ? 1 : 0.35, cursor: displayPath ? 'pointer' : 'default' }}
        title={t('previewPane.openInOs')}
        onClick={() => displayPath && void window.electronAPI.openFolder(displayPath).catch(() => {})}
      >
        <FolderOpen size={13} />
      </div>
      <Dropdown menu={{ items }} trigger={['click']}>
        <div data-ws-more style={ICON_BUTTON} title="更多">
          <MoreHorizontal size={14} />
        </div>
      </Dropdown>
    </div>
  )
}
