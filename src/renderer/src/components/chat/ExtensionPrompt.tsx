import React from 'react'
import { Button } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'

/** Loop iteration limit reached — ask user to extend or stop */
export function ExtensionPrompt({
  currentCount,
  limit,
  onExtend,
  onStop
}: {
  currentCount: number
  limit: number
  onExtend?: () => void
  onStop?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <PromptBox>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {t('chatView.extensionPrompt.title', { count: currentCount, limit })}
      </div>
      <div style={{ marginBottom: 8 }}>
        {t('chatView.extensionPrompt.description')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          size="small"
          style={{ background: '#d48806', borderColor: '#d48806', color: '#fff' }}
          onClick={() => onExtend?.()}
        >
          {t('chatView.extensionPrompt.continue')}
        </Button>
        <Button size="small" danger onClick={() => onStop?.()}>
          {t('chatView.extensionPrompt.stop')}
        </Button>
      </div>
    </PromptBox>
  )
}

/** Shared visual wrapper (used by ExtensionPrompt only) */
function PromptBox({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        margin: '16px 0',
        padding: 12,
        background: '#fffbe6',
        border: '1px solid #ffe58f',
        borderRadius: 6,
        color: '#ad6f00',
        fontSize: 13
      }}
    >
      {children}
    </div>
  )
}

/** Execution paused — link to resume */
export function SubAgentStopPrompt({
  onConfirm,
  onResume
}: {
  onConfirm?: () => void
  onResume?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ margin: '12px 0 12px 10px', padding: '8px 12px', display: 'inline-block', background: '#f5f5f5', borderRadius: 8, color: '#888', fontSize: 13 }}>
      &gt; {t('chatView.subAgentStopPrompt.title')}
      {' '}
      <a
        href="#"
        style={{ color: '#666', textDecoration: 'underline' }}
        onClick={(e) => { e.preventDefault(); onResume?.() }}
      >
        {t('chatView.subAgentStopPrompt.resume')}
      </a>
      <span style={{ margin: '0 6px', color: '#ccc' }}>/</span>
      <a
        href="#"
        style={{ color: '#999', textDecoration: 'underline' }}
        onClick={(e) => { e.preventDefault(); onConfirm?.() }}
      >
        {t('chatView.subAgentStopPrompt.stop')}
      </a>
    </div>
  )
}
