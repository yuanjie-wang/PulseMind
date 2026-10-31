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
// The ⋯ menu's items come from the SHARED builder (preview-file-actions,
// 2026-10-31) — the immersive tab strip's right-end ⋯ serves the identical
// actions, so the semantics cannot fork between the two surfaces.

import React from 'react'
import { Dropdown } from 'antd'
import { FolderOpen, MoreHorizontal } from 'lucide-react'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useTranslation } from '../../i18n/useTranslation'
import { usePreviewFileActions } from './preview-file-actions'

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
  // The preview actions come from the shared builder (see the header note);
  // the ⋯ dropdown below only renders them.
  const items = usePreviewFileActions(conversationId)

  // The file on screen — and only it (2026-10-30 裁定). Nothing open = the
  // workspace root, so the row still says where this conversation lives.
  const displayPath = activePath ?? workspaceDir

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
