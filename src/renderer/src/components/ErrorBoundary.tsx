import React, { useState } from 'react'
import { useTranslation } from '../i18n/useTranslation'

function ErrorBoundaryFallback({ error }: { error: Error | null }): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div style={{ padding: 24, fontFamily: 'monospace' }}>
      <h2>{t('errorBoundary.title')}</h2>
      <pre style={{ whiteSpace: 'pre-wrap', color: 'red', background: '#f5f5f5', padding: 12, borderRadius: 6 }}>
        {error?.message}
      </pre>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#666', background: '#f5f5f5', padding: 12, borderRadius: 6 }}>
        {error?.stack}
      </pre>
      <button onClick={() => window.location.reload()} style={{ marginTop: 12, padding: '8px 16px' }}>
        {t('errorBoundary.reload')}
      </button>
    </div>
  )
}

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('PulseMind Error:', error, errorInfo)
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return <ErrorBoundaryFallback error={this.state.error} />
    }
    return this.props.children
  }
}

export default ErrorBoundary
