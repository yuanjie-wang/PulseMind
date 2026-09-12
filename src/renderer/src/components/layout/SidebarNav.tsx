// ── Sidebar navigation column ──
// The app's primary navigation (PLAN-0.4.0 D4a): one button per top-level view,
// rendered from navigation/registry.ts. An entry that declares a `submenu` behaves
// as a split button — hovering reveals its sub-entries (新建任务 → 对话 / 项目) while
// clicking the entry runs its own default, so the most frequent path stays one click.

import React from 'react'
import { Button, Dropdown, type MenuProps } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import { SIDEBAR_NAV, type SidebarNavItem } from '../../navigation/registry'
import { useNavigationStore } from '../../stores/navigationStore'

interface SidebarNavProps {
  /** False once the session cap is reached with auto-cleanup off. */
  canCreateNew: boolean
  /** Create and open a fresh conversation. */
  onCreateNew: () => void
}

// Submenus fly out to the right of the entry, top-aligned, 4px clear of it.
// Dropdown's `placement` only accepts the top/bottom variants, so the side placement
// comes from `align`, whose points pair is [popup point, trigger point] — the same
// pair antd's own `rightTop` placement is built from.
const SUBMENU_ALIGN = { points: ['tl', 'tr'], offset: [4, 0] }

function SidebarNav({ canCreateNew, onCreateNew }: SidebarNavProps): React.ReactElement {
  const { t } = useTranslation()
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)

  const activate = (item: SidebarNavItem): void => {
    navigate({ kind: item.view })
    if (item.isAction && canCreateNew) onCreateNew()
  }

  // A split entry highlights for its own view and for every view it can reach.
  const isActive = (item: SidebarNavItem): boolean => view.kind === item.view || !!item.submenu?.some((sub) => sub.view === view.kind)

  // A split entry is never disabled itself: its submenu has to stay reachable even
  // when starting a conversation is not (creating a project has no such cap), so the
  // cap is applied to the 对话 sub-entry alone.
  const isDisabled = (item: SidebarNavItem): boolean => !!item.isAction && !canCreateNew && !item.submenu?.length

  return (
    <div style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {SIDEBAR_NAV.map((item) => {
        const Icon = item.icon
        const button = (
          <Button
            className={`new-chat-btn${isActive(item) ? ' active-mode-btn' : ''}`}
            onClick={() => activate(item)}
            icon={<Icon style={{ fontSize: 18 }} />}
            disabled={isDisabled(item)}
          >
            {t(item.labelKey)}
          </Button>
        )

        if (!item.submenu?.length) return <React.Fragment key={item.view}>{button}</React.Fragment>

        const items: MenuProps['items'] = item.submenu.map((sub) => {
          const SubIcon = sub.icon
          return {
            key: sub.view,
            icon: <SubIcon style={{ fontSize: 16 }} />,
            label: t(sub.labelKey),
            disabled: isDisabled(sub),
            onClick: () => activate(sub),
          }
        })

        return (
          <Dropdown key={item.view} menu={{ items }} trigger={['hover']} align={SUBMENU_ALIGN}>
            {button}
          </Dropdown>
        )
      })}
    </div>
  )
}

export default SidebarNav
