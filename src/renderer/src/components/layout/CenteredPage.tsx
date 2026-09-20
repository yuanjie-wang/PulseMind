// ── Centered page column ──
// Shared shell for the standard views that were once modals/drawers (usage
// statistics, about): a full-bleed white scroll surface holding one centered,
// width-capped content column, so wide windows grow margins instead of
// stretching forms. PAGE_COLUMN_MAX_WIDTH is the unified column width — the
// settings page composes its menu + body block around the same value instead
// of using this shell, because its two panes scroll independently.

import React from 'react'

export const PAGE_COLUMN_MAX_WIDTH = 760

interface CenteredPageProps {
  maxWidth?: number
  children: React.ReactNode
}

function CenteredPage({ maxWidth = PAGE_COLUMN_MAX_WIDTH, children }: CenteredPageProps): React.ReactElement {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--pm-bg)' }} className="settings-scroll">
      <div style={{ maxWidth, margin: '0 auto', padding: '8px 24px 24px' }}>{children}</div>
    </div>
  )
}

export default CenteredPage
