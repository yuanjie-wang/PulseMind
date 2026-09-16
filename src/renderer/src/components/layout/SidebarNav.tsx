// ── Sidebar navigation column ──
// The app's primary navigation (PLAN-0.4.0 D4a), rendered from navigation/registry.ts.
// An entry that declares a `submenu` behaves as a split button: hovering reveals its
// sub-entries (新建任务 → 对话 / 项目, 能力 • 知识 • 工具 → 三个中心) while clicking
// the entry opens its own default, so the most frequent path stays one click. Everything
// else is one button per view.

import React from 'react'
import { RightOutlined } from '@ant-design/icons'
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
  const navigateKind = useNavigationStore((s) => s.navigateKind)

  const activate = (item: SidebarNavItem): void => {
    // navigateKind restores the kind's remembered params (e.g. the tool center's
    // selected tool / capability tab) instead of resetting to the bare kind.
    navigateKind(item.view)
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
            {/* A caret on the far edge signals the hover flyout on split entries. */}
            {item.submenu?.length ? (
              <span className="nav-split">
                {t(item.labelKey)}
                <RightOutlined style={{ fontSize: 10, color: 'rgba(0, 0, 0, 0.45)' }} />
              </span>
            ) : (
              t(item.labelKey)
            )}
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
          <Dropdown key={item.view} menu={{ items }} trigger={['hover']} align={SUBMENU_ALIGN} classNames={{ root: 'nav-submenu' }}>
            {button}
          </Dropdown>
        )
      })}
      <style>{`
        /* rc-dropdown stretches its overlay to the trigger's width by default
           (stretch: 'minWidth', applied as an inline style), which made a two-label
           flyout as wide as the 264px nav button. A flyout should hug its labels. */
        .nav-submenu {
          min-width: 0 !important;
        }
        /* .new-chat-btn is a flex row pinned to flex-start; the label wrapper
           flexes to the button's far edge and space-between parks the caret
           there. Degrades to caret-after-label if antd wraps children. */
        .nav-split {
          flex: 1;
          display: inline-flex;
          align-items: center;
          justify-content: space-between;
        }
      `}</style>
    </div>
  )
}

export default SidebarNav
