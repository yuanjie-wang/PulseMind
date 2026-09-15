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
        border: '1px solid #e5e5e7',
        fontSize: 13,
        color: '#555',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'border-color 0.15s, color 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#000'
        e.currentTarget.style.color = '#000'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#e5e5e7'
        e.currentTarget.style.color = '#555'
      }}
    >
      {label}
    </span>
  )
}
