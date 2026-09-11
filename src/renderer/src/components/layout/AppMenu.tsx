// ── Top-left app menu ──
// PLAN-0.4.0 M1.3: the menu-driven entry point for the six primary destinations
// plus settings/about. Entries come from the navigation registry; actions are
// wired here. Lives in the header's left cluster, next to the sidebar toggle.

import React from 'react'
import { Button, Popover, Tooltip } from 'antd'
import { MenuOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { MENU_GROUPS, type MenuItem } from '../../navigation/registry'
import { useNavigationStore } from '../../stores/navigationStore'

interface AppMenuProps {
  onCreateNew: () => void
  onOpenSettings: () => void
  onOpenAbout: () => void
}

function MenuRow({ item, active, onPick }: {
  item: MenuItem
  active: boolean
  onPick: () => void
}): React.ReactElement {
  const Icon = item.icon
  const { t } = useTranslation()
  return (
    <div
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
        fontSize: 13, fontWeight: 500, color: '#333', transition: 'background 0.15s',
        background: active ? 'rgba(0, 0, 0, 0.06)' : 'transparent'
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = active ? 'rgba(0, 0, 0, 0.06)' : 'transparent' }}
    >
      <Icon />
      <span>{t(item.labelKey)}</span>
    </div>
  )
}

export function AppMenu({ onCreateNew, onOpenSettings, onOpenAbout }: AppMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const view = useNavigationStore((s) => s.view)
  const menuOpen = useNavigationStore((s) => s.menuOpen)
  const navigate = useNavigationStore((s) => s.navigate)
  const setMenuOpen = useNavigationStore((s) => s.setMenuOpen)

  const pick = (item: MenuItem): void => {
    switch (item.type) {
      case 'action':
        if (item.id === 'new-chat') {
          navigate({ kind: 'chat' })
          onCreateNew()
        } else {
          // 新建项目 lands in the project view; M3 adds the create flow there.
          navigate({ kind: 'project' })
        }
        break
      case 'view':
        navigate({ kind: item.view })
        break
      case 'modal':
        setMenuOpen(false)
        if (item.id === 'settings') onOpenSettings()
        else onOpenAbout()
        break
    }
  }

  const content = (
    <div style={{ width: 200, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {MENU_GROUPS.map((group, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div style={{ height: 1, background: '#f0f0f0', margin: '6px 4px' }} />}
          {group.map((item) => (
            <MenuRow
              key={item.type === 'view' ? item.view : item.id}
              item={item}
              active={item.type === 'view' && item.view === view.kind}
              onPick={() => pick(item)}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      open={menuOpen}
      onOpenChange={setMenuOpen}
      placement="bottomLeft"
      arrow={false}
    >
      <Tooltip title={t('menu.title')}>
        <Button
          type="text"
          icon={<MenuOutlined style={{ fontSize: 18 }} />}
          aria-label={t('menu.title')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
      </Tooltip>
    </Popover>
  )
}
