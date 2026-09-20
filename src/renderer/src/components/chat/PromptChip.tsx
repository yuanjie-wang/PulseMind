/**
 * A starter-prompt pill. One click hands the prompt to whatever the caller does
 * with it — the welcome page drops it into the composer, the expert editor's
 * form filler sends it — so every "try this" affordance in the app reads the
 * same instead of each site inventing its own button.
 */
import React from 'react'

export function PromptChip({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <span
      onClick={onClick}
      style={{
        padding: '6px 16px',
        borderRadius: 999,
        border: '1px solid var(--pm-prompt-pill-border)',
        fontSize: 13,
        color: 'var(--pm-text-body)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'border-color 0.15s, color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--pm-ink)'
        e.currentTarget.style.color = 'var(--pm-ink)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--pm-prompt-pill-border)'
        e.currentTarget.style.color = 'var(--pm-text-body)'
      }}
    >
      {label}
    </span>
  )
}
