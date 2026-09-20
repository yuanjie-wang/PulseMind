import React, { useState } from 'react'
import { Tag, Typography, Alert } from 'antd'
import {
  BugOutlined,
  CodeOutlined,
  ReadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { SkillState } from '../../skills/types'
import CapabilityCard, {
  CAPABILITY_GRID,
  CapabilityDeleteButton,
  CapabilityEmpty,
  CapabilitySwitch
} from '../common/CapabilityCard'
import SkillBrowser from './SkillBrowser'

const { Paragraph } = Typography

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  engineering: <CodeOutlined />,
  debugging: <BugOutlined />,
  education: <ReadOutlined />
}

interface SkillsPanelProps {
  skills: SkillState[]
  onToggleSkill: (name: string) => void
  onDeleteSkill?: (name: string) => void
}

function SkillsPanel({
  skills,
  onToggleSkill,
  onDeleteSkill,
}: SkillsPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const LS_KEY = 'pulsemind_dismissed_skills_tip'
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem(LS_KEY) === 'true')
  // Non-null = a card was clicked and the three-column browser replaced the grid.
  const [viewing, setViewing] = useState<string | null>(null)
  const dismissTip = () => {
    localStorage.setItem(LS_KEY, 'true')
    setTipDismissed(true)
  }
  const visibleSkills = skills.filter(s => !s.definition.name.startsWith('ex.'))

  if (viewing && visibleSkills.some(s => s.definition.name === viewing)) {
    return (
      <div style={{ height: '100%' }}>
        <SkillBrowser
          skills={visibleSkills}
          activeName={viewing}
          onSelect={setViewing}
          onBack={() => setViewing(null)}
        />
      </div>
    )
  }

  return (
    <div style={{ background: 'transparent' }}>
      {visibleSkills.length === 0 && <CapabilityEmpty title={t('skills.noSkills')} />}

      <div style={CAPABILITY_GRID}>
        {visibleSkills.map((skill) => (
          <SkillCard
            key={skill.definition.name}
            skill={skill}
            onToggle={onToggleSkill}
            onDeleteSkill={onDeleteSkill}
            onOpen={setViewing}
          />
        ))}
      </div>

      {/* ── Internet search tip ── */}
      {!tipDismissed && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={dismissTip}
          title={t('skills.internetSearchTip')}
          style={{ fontSize: 12, marginTop: 16 }}
        />
      )}
    </div>
  )
}

// --- Skill Card ---

interface SkillCardProps {
  skill: SkillState
  onToggle: (name: string) => void
  onDeleteSkill?: (name: string) => void
  onOpen: (name: string) => void
}

function SkillCard({ skill, onToggle, onDeleteSkill, onOpen }: SkillCardProps): React.ReactElement {
  const { t } = useTranslation()
  const { definition, enabled } = skill

  return (
    <CapabilityCard
      icon={CATEGORY_ICONS[definition.category] ?? <ThunderboltOutlined />}
      name={definition.name}
      badge={
        definition.builtIn ? (
          <Tag color="default" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
            {t('common.builtIn')}
          </Tag>
        ) : undefined
      }
      onClick={() => onOpen(definition.name)}
      actions={
        <>
          <CapabilitySwitch checked={enabled} onToggle={() => onToggle(definition.name)} />
          {!definition.builtIn && onDeleteSkill && (
            <CapabilityDeleteButton onClick={() => onDeleteSkill(definition.name)} />
          )}
        </>
      }
    >
      {/* Description — clicking the card opens the file browser instead */}
      <Paragraph
        style={{
          fontSize: 12,
          margin: 0,
          lineHeight: '1.4',
          color: 'var(--pm-text-quiet)'
        }}
        ellipsis={{ rows: 4 }}
      >
        {definition.description}
      </Paragraph>
    </CapabilityCard>
  )
}

export default SkillsPanel
