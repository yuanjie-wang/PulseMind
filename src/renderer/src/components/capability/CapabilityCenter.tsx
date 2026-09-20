// ── Capability center ──
// PLAN-0.4.0 M2.1: one first-class home for everything the agent can draw on —
// MCP servers, skills and sub-agents. The panels are the exact components that
// used to live in the settings modal, re-embedded below a pill tab row. Their
// own section titles were dropped (the pills already name the tab) and their
// title-row actions moved up beside the pills, exposed via the panels'
// imperative handles. 经验 moved to 设置 (its own section + master switch).

import React, { useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import {
  ApiOutlined,
  ThunderboltOutlined,
  ApartmentOutlined,
  ToolOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import MCPSettings from '../settings/MCPSettings'
import SkillsSettings from '../settings/SkillSettings'
import ExpertSettings from '../settings/ExpertSettings'
import ToolsPanel from '../settings/ToolsPanel'
import { CAPABILITY_PANE_PADDING } from '../common/CapabilityCard'
import type { MCPSettingsHandle } from '../settings/MCPSettings'
import type { ExpertSettingsHandle } from '../settings/ExpertSettings'
import type { SkillState } from '../../skills/types'
import type { ToolState } from '../../tools/types'

export type CapabilityTab = 'mcp' | 'skills' | 'expert' | 'tools'

export interface CapabilityCenterProps {
  /** Pre-select a tab (used by jump-to-capability entries, e.g. after `install`). */
  initialTab?: CapabilityTab
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
}

export default function CapabilityCenter({
  initialTab,
  skills,
  onToggleSkill,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError,
  tools,
  onToggleTool
}: CapabilityCenterProps): React.ReactElement {
  const { t } = useTranslation()
  const [tab, setTab] = useState<CapabilityTab>(initialTab ?? 'expert')
  // The old antd Tabs kept every visited pane mounted, so panel state (open
  // add/edit drawers, expanded tool lists) survives tab switches — the visited
  // set below reproduces that; unvisited panes stay lazily unmounted.
  const [visited, setVisited] = useState<ReadonlySet<CapabilityTab>>(() => new Set([initialTab ?? 'expert']))
  const mcpRef = useRef<MCPSettingsHandle>(null)
  const expertRef = useRef<ExpertSettingsHandle>(null)

  const tabs: Array<{ key: CapabilityTab; icon: React.ReactNode; label: string }> = [
    { key: 'expert', icon: <ApartmentOutlined />, label: t('expertCenter.tabLabel') },
    { key: 'skills', icon: <ThunderboltOutlined />, label: t('appLayout.skills') },
    { key: 'mcp', icon: <ApiOutlined />, label: t('appLayout.mcp') },
    { key: 'tools', icon: <ToolOutlined />, label: t('appLayout.tools') }
  ]

  const selectTab = (key: CapabilityTab): void => {
    setTab(key)
    setVisited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }

  // Per-tab actions, hoisted from the panels' removed title rows, rendered as
  // icon+text rounded-rect buttons. Tooltip only where the label loses nuance.
  const actions: Record<CapabilityTab, React.ReactNode> = {
    mcp: (
      <>
        <Tooltip title="从配置文件重新加载">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => mcpRef.current?.reloadFromDisk()}>
            重新加载
          </Button>
        </Tooltip>
        <Button size="small" icon={<PlusOutlined />} onClick={() => mcpRef.current?.openAddModal()}>
          添加连接器
        </Button>
      </>
    ),
    skills: (
      <>
        {onRefreshSkills && (
          <Tooltip title="扫描目录检测新技能">
            <Button size="small" icon={<ReloadOutlined />} onClick={onRefreshSkills}>
              扫描新技能
            </Button>
          </Tooltip>
        )}
        {onImportSkill && (
          <Tooltip title="导入 .zip 包">
            <Button size="small" icon={<PlusOutlined />} onClick={onImportSkill}>
              导入技能
            </Button>
          </Tooltip>
        )}
      </>
    ),
    expert: (
      <>
        <Button size="small" icon={<PlusOutlined />} onClick={() => expertRef.current?.openAddModal()}>
          {t('expertCenter.newExpert')}
        </Button>
        <Tooltip title={t('expertCenter.resetConfirmTitle')}>
          <Button size="small" icon={<UndoOutlined />} onClick={() => expertRef.current?.resetToDefaults()}>
            {t('expertCenter.resetDefaults')}
          </Button>
        </Tooltip>
      </>
    ),
    tools: <></>
  }

  const panes: Record<CapabilityTab, React.ReactNode> = {
    mcp: <MCPSettings ref={mcpRef} />,
    skills: (
      <SkillsSettings
        skills={skills || []}
        onToggleSkill={onToggleSkill || (() => {})}
        onDeleteSkill={onDeleteSkill}
        importError={importError}
      />
    ),
    expert: <ExpertSettings ref={expertRef} />,
    // The settings page's ToolsPanel as-is, minus its ToolSettings title row —
    // the center's panels carry no titles of their own (the pills name the tab).
    tools: <ToolsPanel tools={tools ?? []} onToggleTool={onToggleTool ?? (() => {})} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--pm-bg)' }}>
      {/* The non-active pill's hover wash. antd's text-button hover is rgba(0,0,0,0.02)
          — invisible in practice. A class-scoped rule gives a visible wash that still
          yields to the active pill's 0.08 fill (the active pill sets `background`
          inline, which outranks this by specificity). */}
      <style>{`.pm-cap-pill:not(.pm-cap-pill-active):not(:disabled):hover { background: var(--pm-hover) !important; }`}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 24px 20px',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {tabs.map(({ key, icon, label }) => (
            <Button
              key={key}
              type="text"
              icon={icon}
              onClick={() => selectTab(key)}
              className={`pm-cap-pill${tab === key ? ' pm-cap-pill-active' : ''}`}
              style={{
                height: 30,
                padding: '0 14px',
                borderRadius: 999,
                fontWeight: 600,
                // Only the active pill sets a background — a non-active pill must
                // leave `background` unset so the `.pm-cap-pill:hover` rule above
                // can show. Setting `transparent` inline outranks it by specificity
                // and silently kills the hover (the reported "hover 没了").
                background: tab === key ? 'var(--pm-hover-strong)' : undefined,
                color: tab === key ? 'var(--pm-ink)' : 'var(--pm-text-strong)'
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{actions[tab]}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tabs.map(({ key }) =>
          visited.has(key) ? (
            <div
              key={key}
              style={{
                display: tab === key ? 'block' : 'none',
                height: '100%',
                // This pane — not the panel inside it — is the scroll container: an
                // `overflow: auto` box clips at its own padding box, so an inset
                // applied one level up would leave the outer cards on the clipping
                // edge with their hover shadow sheared off. The bottom half of the
                // inset rides on the grid instead (see CAPABILITY_GRID).
                overflow: 'auto',
                boxSizing: 'border-box',
                padding: CAPABILITY_PANE_PADDING
              }}
            >
              {panes[key]}
            </div>
          ) : null
        )}
      </div>
    </div>
  )
}
