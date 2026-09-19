// ── Sidebar conversation list ──
// The sidebar's history area for the 对话 tab (loose conversations only — the
// project tab has its own list): grouped 置顶 / 今天 / 昨天 / 更早 by the LOCAL
// calendar day of each conversation's last update. Rows come from the shared
// ConversationRows with `groupByDate` on.

import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import ConversationRows from './ConversationRows'
import type { ConversationListItem } from '../../types/conversation'

interface ConversationSidebarProps {
  conversations: ConversationListItem[]
  activeKey: string | undefined
  onSelect: (key: string) => void
  onDelete: (key: string) => void
  onRename: (key: string, newLabel: string) => void
  onTogglePin: (key: string, pinned: boolean) => void
  activeLoopConvIds?: string[]
  retryingConvIds?: string[]
}

function ConversationSidebar({
  conversations,
  activeKey,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  activeLoopConvIds,
  retryingConvIds
}: ConversationSidebarProps): React.ReactElement {
  const { t } = useTranslation()

  if (conversations.length === 0) {
    return (
      <div style={{ padding: '16px 0', color: '#999', fontSize: 12, textAlign: 'center' }}>
        {t('appLayout.noConversations')}
      </div>
    )
  }

  return (
    <div style={{ padding: '2px 8px 8px' }}>
      <ConversationRows
        conversations={conversations}
        activeKey={activeKey}
        activeLoopConvIds={activeLoopConvIds}
        retryingConvIds={retryingConvIds}
        groupByDate
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        onTogglePin={onTogglePin}
      />
    </div>
  )
}

export default ConversationSidebar
