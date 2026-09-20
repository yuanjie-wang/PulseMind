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
        background: 'var(--pm-error-bg)',
        border: '1px solid var(--pm-error-border)',
        borderRadius: 6,
        color: 'var(--pm-error)',
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
            background: 'var(--pm-error)',
            color: 'var(--pm-ink-contrast)',
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
              background: 'var(--pm-elevated)',
              color: 'var(--pm-error)',
              border: '1px solid var(--pm-error)',
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
