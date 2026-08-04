import React from 'react'
import { Drawer, Typography } from 'antd'
import { ToolOutlined } from '@ant-design/icons'
import ToolsPanel from './ToolsPanel'
import { useTranslation } from '../../i18n/useTranslation'
import type { ToolState } from '../../tools/types'

const { Text } = Typography

interface ToolSettingsProps {
  open: boolean
  onClose: () => void
  tools: ToolState[]
  onToggleTool: (name: string) => void
  inline?: boolean
}

function ToolSettings({
  open,
  onClose,
  tools,
  onToggleTool,
  inline
}: ToolSettingsProps): React.ReactElement {
  const { t } = useTranslation()

  const content = (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>{t('tools.title')}</Text>
      <Text
        type="secondary"
        style={{ display: 'block', marginBottom: 16, fontSize: 12 }}
      >
        {t('tools.description')}
      </Text>
      <ToolsPanel tools={tools} onToggleTool={onToggleTool} />
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
  }

  return (
    <Drawer
      title={
        <span>
          <ToolOutlined style={{ marginRight: 8 }} />
          {t('tools.title')}
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

export default ToolSettings
