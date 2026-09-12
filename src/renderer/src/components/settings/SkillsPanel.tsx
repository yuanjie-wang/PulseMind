import React, { useState } from 'react'
import {
  Button,
  Card,
  Switch,
  Tag,
  Typography,
  Alert
} from 'antd'
import {
  BugOutlined,
  CodeOutlined,
  DeleteOutlined,
  ReadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { SkillState } from '../../skills/types'

const { Text, Paragraph } = Typography

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
  const dismissTip = () => {
    localStorage.setItem(LS_KEY, 'true')
    setTipDismissed(true)
  }
  const visibleSkills = skills.filter(s => !s.definition.name.startsWith('ex.'))

  return (
    <div style={{ background: 'transparent' }}>
      {visibleSkills.length === 0 && <Text type="secondary">{t('skills.noSkills')}</Text>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, padding: '4px 0 0' }}>
        {visibleSkills.map((skill) => (
          <SkillCard
            key={skill.definition.name}
            skill={skill}
            onToggle={onToggleSkill}
            onDeleteSkill={onDeleteSkill}
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
}

function SkillCard({ skill, onToggle, onDeleteSkill }: SkillCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()
  const { definition, enabled } = skill

  return (
    <Card
      size="small"
      hoverable
      style={{ borderRadius: 10, opacity: enabled ? undefined : 0.65 }}
      onClick={() => setExpanded(!expanded)}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ flexShrink: 0, display: 'inline-flex' }}>{CATEGORY_ICONS[definition.category] || <ThunderboltOutlined />}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: enabled ? undefined : '#bbb' }}>
            {definition.name}
          </span>
          {definition.builtIn && (
            <Tag color='default' style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
              {t('common.builtIn')}
            </Tag>
          )}
        </span>
      }
      extra={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {!definition.builtIn && onDeleteSkill && (
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined style={{ color: '#bbb' }} />}
              onClick={(e) => {
                e.stopPropagation()
                onDeleteSkill(definition.name)
              }}
            />
          )}
          <Switch
            size='small'
            checked={enabled}
            onClick={(checked, e) => {
              e.stopPropagation()
              onToggle(definition.name)
            }}
          />
        </span>
      }
    >
      {/* Description — click the card to expand the full prompt preview */}
      <Paragraph
        style={{
          fontSize: 12,
          margin: 0,
          lineHeight: '1.4',
          color: '#888'
        }}
        ellipsis={!expanded ? { rows: 2 } : false}
      >
        {definition.description}
      </Paragraph>

      {/* Expanded: full prompt preview */}
      {expanded && definition.systemPrompt && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: '#fafafa',
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            lineHeight: '1.5'
          }}
        >
          {definition.systemPrompt}
        </div>
      )}
    </Card>
  )
}

export default SkillsPanel
