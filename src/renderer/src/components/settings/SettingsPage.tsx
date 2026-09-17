// ── Settings page ──
// PLAN-0.4.0: the settings modal promoted to a standard view (rendered by
// ViewHost). The five sections keep their drawer-era contract (inline/open/
// onClose) — `inline` renders the bare body, which is what a page wants.

import React from 'react'
import { BookOutlined, DesktopOutlined, ExperimentOutlined, SettingOutlined, StarOutlined, UserOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { PAGE_COLUMN_MAX_WIDTH } from '../layout/CenteredPage'
import type { AppView } from '../../navigation/types'
import type { MemoryManager } from '../../memory/MemoryManager'
import AgentSettings from './AgentSettings'
import EnvironmentSettings from './EnvironmentSettings'
import ExperiencePanel from './ExperiencePanel'
import FavoritesSettings from './FavoritesSettings'
import LlmSettings from './LlmSettings'
import MemorySettings from './MemorySettings'

type SettingsTab = NonNullable<AppView['settingsTab']>

const MENU: { key: SettingsTab; icon: React.ReactElement; labelKey: string }[] = [
  { key: 'environment', icon: <DesktopOutlined />, labelKey: 'appLayout.environment' },
  { key: 'settings', icon: <SettingOutlined />, labelKey: 'appLayout.settings' },
  { key: 'assistant', icon: <UserOutlined />, labelKey: 'appLayout.assistant' },
  { key: 'memory', icon: <BookOutlined />, labelKey: 'appLayout.memory' },
  { key: 'experiences', icon: <ExperimentOutlined />, labelKey: 'appLayout.experiences' },
  { key: 'favorites', icon: <StarOutlined />, labelKey: 'appLayout.favorites' },
]

interface SettingsPageProps {
  memoryManager?: MemoryManager
}

function SettingsPage({ memoryManager }: SettingsPageProps): React.ReactElement {
  const { t } = useTranslation()
  const view = useNavigationStore((s) => s.view)
  const navigate = useNavigationStore((s) => s.navigate)
  // The section IS the view param: jump entries (search → 记忆) and the remembered
  // last view (navigateKind) land on the same tab, and local switches update the
  // store so the two never disagree. Absent param = default section.
  const paramTab = view.kind === 'settings' ? view.settingsTab : undefined
  const tab: SettingsTab = paramTab ?? 'environment'
  const selectTab = (next: SettingsTab): void => {
    navigate({ kind: 'settings', settingsTab: next })
  }

  const renderSection = (): React.ReactNode => {
    // onClose is drawer-era: inline sections never render the close affordance.
    switch (tab) {
      case 'favorites':
        return <FavoritesSettings inline open onClose={() => {}} />
      case 'memory':
        return memoryManager ? <MemorySettings inline open onClose={() => {}} memoryManager={memoryManager} /> : null
      case 'experiences':
        return <ExperiencePanel />
      case 'assistant':
        return <AgentSettings inline open onClose={() => {}} />
      case 'settings':
        return <LlmSettings inline open onClose={() => {}} />
      case 'environment':
        return <EnvironmentSettings inline open onClose={() => {}} />
      default:
        return null
    }
  }

  return (
    // Same centered treatment as 用量统计 / 关于: the menu + body block is
    // capped and centered instead of stretching to the window edges, so wide
    // windows grow margins. The panes keep their independent scrolling, which
    // is why this page composes around PAGE_COLUMN_MAX_WIDTH rather than
    // reusing the CenteredPage shell.
    <div style={{ display: 'flex', justifyContent: 'center', height: '100%', overflow: 'hidden', background: '#fff' }}>
      <div style={{ width: '100%', maxWidth: 160 + PAGE_COLUMN_MAX_WIDTH, minWidth: 0, display: 'flex' }}>
        {/* Left menu */}
        <div
          style={{
            width: 160,
            flexShrink: 0,
            borderRight: '1px solid #f0f0f0',
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 8px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
            {MENU.map((item) => (
              <div
                key={item.key}
                onClick={() => selectTab(item.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: '#333',
                  transition: 'background 0.15s',
                  background: tab === item.key ? '#f0f0f0' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (tab !== item.key) e.currentTarget.style.background = '#f5f5f5'
                }}
                onMouseLeave={(e) => {
                  if (tab !== item.key) e.currentTarget.style.background = 'transparent'
                }}
              >
                <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>
                <span>{t(item.labelKey)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Section body — width-capped so forms and card grids stay readable on wide windows */}
        <div style={{ flex: 1, overflow: 'auto' }} className="settings-scroll">
          <div style={{ padding: '8px 24px 24px', maxWidth: PAGE_COLUMN_MAX_WIDTH }}>{renderSection()}</div>
        </div>
      </div>
    </div>
  )
}

export default SettingsPage
