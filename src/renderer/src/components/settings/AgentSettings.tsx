// ── Agent persona settings (灵魂/名字/人设) ──
// Edits the persona fields of settings.json via SettingsContext; supports
// drawer and inline (settings page section) mounting.
import React, { useState, useEffect } from 'react'
import {Drawer, Input, Button, Typography, Space } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'

const { TextArea } = Input
const { Text } = Typography

interface AgentSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

function AgentSettings({ open, onClose, inline }: AgentSettingsProps): React.ReactElement {
  const { settings, saving, saveSettings } = useSettings()
  const { t } = useTranslation()
  const [localSettings, setLocalSettings] = useState(settings)

  useEffect(() => {
    if (open) {
      setLocalSettings(settings)
    }
  }, [open, settings])

  const handleSave = async () => {
    try {
      await saveSettings(localSettings)
      notify.success(t('agentDrawer.saved'))
    } catch {
      notify.error(t('agentDrawer.saveFailed'))
    }
  }

  const formContent = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>{t('agentDrawer.title')}</Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      {/* My Name */}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>
          {t('agentDrawer.myName')}
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('agentDrawer.myNameHelp')}
        </Text>
        <Input
          placeholder={t('agentDrawer.myNamePlaceholder')}
          value={localSettings.myName}
          onChange={(e) => setLocalSettings(prev => ({ ...prev, myName: e.target.value }))}
        />
      </div>

      {/* Your Name */}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>
          {t('agentDrawer.yourName')}
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('agentDrawer.yourNameHelp')}
        </Text>
        <Input
          placeholder={t('agentDrawer.yourNamePlaceholder')}
          value={localSettings.yourName}
          onChange={(e) => setLocalSettings(prev => ({ ...prev, yourName: e.target.value }))}
        />
      </div>

      {/* Soul */}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 4 }}>
          {t('agentDrawer.soul')}
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('agentDrawer.soulHelp')}
        </Text>
        <TextArea
          rows={6}
          placeholder={t('agentDrawer.soulPlaceholder')}
          value={localSettings.soul}
          onChange={(e) => setLocalSettings(prev => ({ ...prev, soul: e.target.value }))}
        />
      </div>

      {/* Save Button */}
      <Button
        type="primary"
        block
        icon={<SaveOutlined />}
        loading={saving}
        onClick={handleSave}
      >
        {t('agentDrawer.save')}
      </Button>
    </Space>
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{formContent}</div>
  }

  return (
    <>
      <Drawer title={t('agentDrawer.title')} open={open} onClose={onClose} size={400}>
        {formContent}
      </Drawer>
    </>
  )
}

export default AgentSettings
