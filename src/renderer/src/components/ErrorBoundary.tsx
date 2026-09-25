import React from 'react'
import { useTranslation } from '../i18n/useTranslation'

function ErrorBoundaryFallback({ error }: { error: Error | null }): React.ReactElement {
  const { t } = useTranslation()

  return (
    // The fallback replaces the whole app (AppLayout included), so its ground is
    // the page's own --pm-bg and its ink has to say so: the UA's canvastext stays
    // black in dark mode, which would paint the heading black on near-black. The
    // reload <button> deliberately keeps its UA face — buttonface/buttontext is a
    // pair the browser guarantees, and --pm-ink (#e6e6e6) on a light button plate
    // would not be legible.
    <div style={{ padding: 24, fontFamily: 'monospace', color: 'var(--pm-ink)' }}>
      <h2>{t('errorBoundary.title')}</h2>
      <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--pm-error-bright)', background: 'var(--pm-fill)', padding: 12, borderRadius: 6 }}>
        {error?.message}
      </pre>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--pm-text-secondary)', background: 'var(--pm-fill)', padding: 12, borderRadius: 6 }}>
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
