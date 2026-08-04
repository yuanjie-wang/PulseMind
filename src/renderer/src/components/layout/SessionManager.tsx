import React, { useState } from 'react'
import { Typography, Button, Switch, Space, Modal, Progress, Tooltip, App } from 'antd'
import {
  DeleteOutlined,
  BarChartOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'

const { Text } = Typography
const MAX_SESSIONS = 100

interface SessionManagerProps {
  totalSessions: number
  autoCleanup: boolean
  onClearAll: () => Promise<void>
  onToggleAutoCleanup: (checked: boolean) => void
  onOpenStatistics: () => void
}

function SessionManager({
  totalSessions,
  autoCleanup,
  onClearAll,
  onToggleAutoCleanup,
  onOpenStatistics
}: SessionManagerProps): React.ReactElement {
  const [clearLoading, setClearLoading] = useState(false)
  const [modalApi, modalContextHolder] = Modal.useModal()
  const { message } = App.useApp()
  const { t } = useTranslation()

  const percent = Math.min(Math.round((totalSessions / MAX_SESSIONS) * 100), 100)
  const c = Math.max(0, 200 - totalSessions * 2)
  const barColor = `rgb(${c}, ${c}, ${c})`

  const handleClearAll = () => {
    modalApi.confirm({
      title: t('sessionManager.clearTitle'),
      content: t('sessionManager.clearContent', { count: totalSessions }),
      okText: t('sessionManager.clearAll'),
      okType: 'danger',
      cancelText: t('sessionManager.cancel'),
      onOk: async () => {
        setClearLoading(true)
        try {
          await onClearAll()
          message.success(t('sessionManager.clearSuccess'))
        } catch {
          message.error(t('sessionManager.clearError'))
        } finally {
          setClearLoading(false)
        }
      }
    })
  }

  return (
    <>
      {modalContextHolder}
      <div
        style={{
          borderTop: '1px solid var(--ant-color-border-secondary, #e8e8e8)',
          padding: '10px 12px',
          flexShrink: 0,
          background: 'transparent'
        }}
      >
        {/* Session count + progress */}
        <div style={{ marginBottom: 6 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 2
            }}
          >
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('sessionManager.sessions')}
            </Text>
            <Text
              strong
              style={{
                fontSize: 12
              }}
            >
              {totalSessions} / {MAX_SESSIONS}
            </Text>
          </div>
          <Progress
            percent={percent}
            size="small"
            showInfo={false}
            strokeColor={barColor}
            style={{ marginBottom: 0 }}
          />
        </div>

        {/* Controls row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <Space size={4} align="center">
            <ThunderboltOutlined style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }} />
            <Text type="secondary" style={{ fontSize: 11 }}>{t('sessionManager.autoCleanup')}</Text>
            <Switch size="small" checked={autoCleanup} onChange={onToggleAutoCleanup} style={{ backgroundColor: autoCleanup ? '#000' : undefined }} />
          </Space>

          <Space size={2}>
            <Tooltip title={t('sessionManager.clearTooltip')}>
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                loading={clearLoading}
                disabled={totalSessions === 0}
                onClick={handleClearAll}
              />
            </Tooltip>
            <Tooltip title={t('sessionManager.statsTooltip')}>
              <Button
                type="text"
                size="small"
                icon={<BarChartOutlined />}
                onClick={onOpenStatistics}
              />
            </Tooltip>
          </Space>
        </div>
      </div>
    </>
  )
}

export default SessionManager
