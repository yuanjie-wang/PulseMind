// ── Undo bar for an auto-applied form patch (user ruling 2026-09-20) ──
// The form assistants write their conclusions straight into the form — there
// is no review card. This bar is the 撤销 affordance that ruling asks for: a
// single quiet row above the form naming what landed, with one 撤销 button
// that calls the host's revert. The host decides bar placement (top of the
// form column's scroll area, where the review card used to sit) and what
// revert means for its own form shape.
//
// There is deliberately no 「重新应用」: once reverted, the content still sits
// verbatim in the assistant transcript above, and asking again (or copy from
// there) brings it back — a redo button would need the revert to be
// non-destructive, which the routine form's schedule/params shape cannot be.

import React from 'react'
import { Button } from 'antd'
import { UndoOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'

export interface AppliedPatchBarProps {
  /** One-line summary of what the assistant wrote, e.g. 已将「每日巡检」填入表单. */
  summary: string
  onUndo: () => void
}

export function AppliedPatchBar({ summary, onUndo }: AppliedPatchBarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        border: '1px dashed var(--pm-border)',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--pm-text-secondary)',
        background: 'var(--pm-fill-ghost)',
      }}
    >
      <span title={summary} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summary}
      </span>
      <Button size="small" icon={<UndoOutlined />} onClick={onUndo}>
        {t('formAssist.undo')}
      </Button>
    </div>
  )
}
