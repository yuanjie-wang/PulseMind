// ── Placeholder for views whose milestone hasn't landed yet ──
// PLAN-0.4.0 M1: each new center starts as a placeholder so the menu is
// complete from day one; later milestones replace the body in place.

import React from 'react'
import { Empty } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'

export function PlaceholderView({ labelKey }: { labelKey: string }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
      <Empty description={t(labelKey)} image={Empty.PRESENTED_IMAGE_SIMPLE} />
    </div>
  )
}
