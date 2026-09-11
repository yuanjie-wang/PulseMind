// ── Capability center ──
// PLAN-0.4.0 M2.1: one first-class home for everything the agent can draw on —
// MCP servers, skills, sub-agents and experiences. This is a pure re-host: the
// four panels are the exact components that used to live in the settings modal,
// re-embedded as tabs with no logic changes.

import React, { useState } from 'react'
import { Tabs } from 'antd'
import { ApiOutlined, ThunderboltOutlined, ApartmentOutlined, ExperimentOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import MCPSettings from '../settings/MCPSettings'
import SkillsSettings from '../settings/SkillSettings'
import SubAgentSettings from '../settings/SubAgentSettings'
import ExperiencePanel from '../settings/ExperiencePanel'
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

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '12px 24px 24px', background: '#fff' }}>
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as CapabilityTab)}
        items={[
          {
            key: 'mcp',
            label: (
              <span><ApiOutlined style={{ marginInlineEnd: 6 }} />{t('appLayout.mcp')}</span>
            ),
            children: <MCPSettings inline open onClose={() => {}} />
          },
          {
            key: 'skills',
            label: (
              <span><ThunderboltOutlined style={{ marginInlineEnd: 6 }} />{t('appLayout.skills')}</span>
            ),
            children: (
              <SkillsSettings
                inline
                open
                onClose={() => {}}
                skills={skills || []}
                onToggleSkill={onToggleSkill || (() => {})}
                onImportSkill={onImportSkill}
                onRefreshSkills={onRefreshSkills}
                onDeleteSkill={onDeleteSkill}
                importError={importError}
              />
            )
          },
          {
            key: 'subagent',
            label: (
              <span><ApartmentOutlined style={{ marginInlineEnd: 6 }} />子代理</span>
            ),
            children: <SubAgentSettings inline open onClose={() => {}} tools={tools} skills={skills} />
          },
          {
            key: 'experiences',
            label: (
              <span><ExperimentOutlined style={{ marginInlineEnd: 6 }} />经验</span>
            ),
            children: <ExperiencePanel inline open onClose={() => {}} />
          }
        ]}
      />
    </div>
  )
}
