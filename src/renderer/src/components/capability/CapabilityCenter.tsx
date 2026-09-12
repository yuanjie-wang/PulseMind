// ── Capability center ──
// PLAN-0.4.0 M2.1: one first-class home for everything the agent can draw on —
// MCP servers, skills, sub-agents and experiences. The four panels are the exact
// components that used to live in the settings modal, re-embedded below a pill
// tab row. Their own section titles were dropped (the pills already name the
// tab) and their title-row actions moved up beside the pills, exposed via the
// panels' imperative handles.

import React, { useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import {
  ApiOutlined,
  ThunderboltOutlined,
  ApartmentOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import MCPSettings from '../settings/MCPSettings'
import SkillsSettings from '../settings/SkillSettings'
import SubAgentSettings from '../settings/SubAgentSettings'
import ExperiencePanel from '../settings/ExperiencePanel'
import type { MCPSettingsHandle } from '../settings/MCPSettings'
import type { SubAgentSettingsHandle } from '../settings/SubAgentSettings'
import type { ExperiencePanelHandle } from '../settings/ExperiencePanel'
import type { ToolState } from '../../tools/types'
import type { SkillState } from '../../skills/types'

export type CapabilityTab = 'mcp' | 'skills' | 'subagent' | 'experiences'

export interface CapabilityCenterProps {
  /** Pre-select a tab (used by jump-to-capability entries, e.g. after `install`). */
  initialTab?: CapabilityTab
  tools?: ToolState[]
  onToggleTool?: (name: string) => void
  skills?: SkillState[]
  onToggleSkill?: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
}

export default function CapabilityCenter({
  initialTab,
  tools,
  skills,
  onToggleSkill,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError
}: CapabilityCenterProps): React.ReactElement {
  const { t } = useTranslation()
  const [tab, setTab] = useState<CapabilityTab>(initialTab ?? 'mcp')
  // The old antd Tabs kept every visited pane mounted, so panel state (open
  // add/edit drawers, expanded tool lists) survives tab switches — the visited
  // set below reproduces that; unvisited panes stay lazily unmounted.
  const [visited, setVisited] = useState<ReadonlySet<CapabilityTab>>(() => new Set([initialTab ?? 'mcp']))
  const mcpRef = useRef<MCPSettingsHandle>(null)
  const subAgentRef = useRef<SubAgentSettingsHandle>(null)
  const experiencesRef = useRef<ExperiencePanelHandle>(null)

  const tabs: Array<{ key: CapabilityTab; icon: React.ReactNode; label: string }> = [
    { key: 'mcp', icon: <ApiOutlined />, label: t('appLayout.mcp') },
    { key: 'skills', icon: <ThunderboltOutlined />, label: t('appLayout.skills') },
    { key: 'subagent', icon: <ApartmentOutlined />, label: '专家' },
    { key: 'experiences', icon: <ExperimentOutlined />, label: '经验' }
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
    subagent: (
      <>
        <Button size="small" icon={<PlusOutlined />} onClick={() => subAgentRef.current?.openAddModal()}>
          新建专家
        </Button>
        <Tooltip title="重置默认配置">
          <Button size="small" icon={<UndoOutlined />} onClick={() => subAgentRef.current?.resetToDefaults()}>
            重置默认
          </Button>
        </Tooltip>
      </>
    ),
    experiences: (
      <Button size="small" icon={<ExperimentOutlined />} onClick={() => experiencesRef.current?.refresh()}>
        刷新
      </Button>
    )
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
    subagent: <SubAgentSettings ref={subAgentRef} tools={tools} skills={skills} />,
    experiences: <ExperiencePanel ref={experiencesRef} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
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
              style={{
                height: 30,
                padding: '0 14px',
                borderRadius: 999,
                fontWeight: 600,
                background: tab === key ? 'rgba(0, 0, 0, 0.08)' : 'transparent',
                color: tab === key ? '#000' : '#333'
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
                padding: '0 24px 24px',
                boxSizing: 'border-box'
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
