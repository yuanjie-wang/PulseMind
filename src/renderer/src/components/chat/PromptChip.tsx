/**
 * A starter-prompt chip. One click hands the prompt to whatever the caller does
 * with it — the welcome page drops it into the composer, the expert editor's
 * form filler sends it — so every "try this" affordance in the app reads the
 * same instead of each site inventing its own button.
 *
 * shape（user 2026-11-09「示例任务模版按钮，不要用胶囊形状，而是圆角矩形」）：
 * welcome/浏览器的「试试」仍走胶囊；助手栏里的示例任务模板走圆角矩形。
 */
import React from 'react'

export function PromptChip({ label, onClick, shape = 'pill' }: { label: string; onClick: () => void; shape?: 'pill' | 'rounded' }): React.ReactElement {
  return (
    <span
      onClick={onClick}
      style={{
        padding: '6px 16px',
        borderRadius: shape === 'pill' ? 999 : 8,
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
