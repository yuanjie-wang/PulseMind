import React, { useState } from 'react'
import {
  Button,
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

  return (
    <div style={{ background: 'transparent' }}>
      {skills.filter(s => !s.definition.name.startsWith('ex.')).length === 0 && (
        <Text type="secondary">{t('skills.noSkills')}</Text>
      )}

      {skills.filter(s => !s.definition.name.startsWith('ex.')).map((skill) => (
        <SkillCard
          key={skill.definition.name}
          skill={skill}
          onToggle={onToggleSkill}
          onDeleteSkill={onDeleteSkill}
        />
      ))}

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
  const { definition, enabled } = skill
  const { t } = useTranslation()

  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid #f0f0f0'
      }}
    >
      {/* Header row: icon + name + badges + actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: 'pointer'
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0
          }}
        >
          {CATEGORY_ICONS[definition.category] || <ThunderboltOutlined />}
          <Text strong style={{ fontSize: 14, color: enabled ? undefined : '#bbb' }} ellipsis>
            {definition.name}
          </Text>
          {definition.builtIn && (
            <Tag color='default' style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
              {t('common.builtIn')}
            </Tag>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
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
        </div>
      </div>

      {/* Description */}
      <Paragraph
        style={{
          fontSize: 12,
          margin: '4px 0 0 0',
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
    </div>
  )
}

export default SkillsPanel
