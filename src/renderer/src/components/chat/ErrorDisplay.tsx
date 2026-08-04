import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'

export function ErrorDisplay({
  message,
  onDismiss,
  onRetry
}: {
  message: string
  onDismiss: () => void
  onRetry?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        margin: '16px 0',
        padding: 12,
        background: '#fff2f0',
        border: '1px solid #ffccc7',
        borderRadius: 6,
        color: '#cf1322',
        fontSize: 13
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('chatView.errorDisplay.title')}</div>
      <div>{message}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          onClick={onDismiss}
          style={{
            padding: '4px 12px',
            background: '#cf1322',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12
          }}
        >
          {t('chatView.errorDisplay.dismiss')}
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              padding: '4px 12px',
              background: '#fff',
              color: '#cf1322',
              border: '1px solid #cf1322',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            {t('chatView.errorDisplay.retry')}
          </button>
        )}
      </div>
    </div>
  )
}
