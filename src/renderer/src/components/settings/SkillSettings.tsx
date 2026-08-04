import React from 'react'
import { Drawer, Typography, Button, Alert, Tooltip } from 'antd'
import { ThunderboltOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import SkillsPanel from './SkillsPanel'
import { useTranslation } from '../../i18n/useTranslation'
import type { SkillState } from '../../skills/types'

const { Text } = Typography

interface SkillSettingsProps {
  open: boolean
  onClose: () => void
  skills: SkillState[]
  onToggleSkill: (name: string) => void
  onImportSkill?: () => void
  onRefreshSkills?: () => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
  inline?: boolean
}

function SkillSettings({
  open,
  onClose,
  skills,
  onToggleSkill,
  onImportSkill,
  onRefreshSkills,
  onDeleteSkill,
  importError,
  inline
}: SkillSettingsProps): React.ReactElement {
  const { t } = useTranslation()

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Text strong style={{ fontSize: 16 }}>{t('skills.title')}</Text>
        <div style={{ display: 'flex', gap: 6 }}>
          {onRefreshSkills && (
            <Tooltip title="扫描目录检测新技能">
              <Button size="small" icon={<ReloadOutlined />} onClick={onRefreshSkills} />
            </Tooltip>
          )}
          {onImportSkill && (
            <Tooltip title="导入 .zip 包">
              <Button size="small" icon={<PlusOutlined />} onClick={onImportSkill} />
            </Tooltip>
          )}
        </div>
      </div>
      {importError && (
        <Alert
          title={importError}
          type="error"
          showIcon
          style={{ fontSize: 12, marginBottom: 12 }}
        />
      )}

      <SkillsPanel
        skills={skills}
        onToggleSkill={onToggleSkill}
        onDeleteSkill={onDeleteSkill}
      />
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
  }

  return (
    <Drawer
      title={
        <span>
          <ThunderboltOutlined style={{ marginRight: 8 }} />
          {t('skills.title')}
        </span>
      }
      open={open}
      onClose={onClose}
      size={400}
    >
      {content}
    </Drawer>
  )
}

export default SkillSettings
