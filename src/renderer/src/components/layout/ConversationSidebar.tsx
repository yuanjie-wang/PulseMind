// ── Sidebar conversation list ──
// The 对话 tab of the sidebar's history area: only the loose (project-less)
// conversations, rendered flat — no grouping. Conversations bound to a project
// live in the 项目 tab (ProjectSidebarList), so the two tabs never duplicate
// each other's content. Rows come from the shared ConversationRows, so both
// tabs render and behave identically.

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

  // Loose conversations only — project-bound ones belong to the 项目 tab.
  const loose = conversations.filter((c) => !c.projectId)
  if (loose.length === 0) {
    return (
      <div style={{ padding: '16px 0', color: '#999', fontSize: 12, textAlign: 'center' }}>
        {t('appLayout.noConversations')}
      </div>
    )
  }

  return (
    <div style={{ padding: '2px 8px 8px' }}>
      <ConversationRows
        conversations={loose}
        activeKey={activeKey}
        activeLoopConvIds={activeLoopConvIds}
        retryingConvIds={retryingConvIds}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        onTogglePin={onTogglePin}
      />
    </div>
  )
}

export default ConversationSidebar
