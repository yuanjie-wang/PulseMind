// ── Review card for an assistant-proposed form patch (D3/D4/D9) ──
// Replaces the one-line AssistantDraftBanner: a field-level before→after diff
// where `before` is recomputed from the CURRENT form by the host on every
// render (what applying would write right now — a hand edit made after the
// proposal shows up immediately), one checkbox per row so the user applies
// only what they reviewed (D4, default all), and the card pins to the top of
// the form column's scroll container (D3: sticky, no scrollIntoView — an
// auto-scroll would yank the form away from under the user's cursor).
//
// Selection state is keyed to the patch FINGERPRINT: recomputed rows never
// reset the checks; only a genuinely new proposal does (D4).

import React, { useState } from 'react'
import { Button, Checkbox } from 'antd'
import { CheckOutlined, RobotOutlined, RollbackOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { ProposalDiffRow } from './form-assist'

const ROW_CLAMP: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export interface ProposalReviewCardProps {
  /** One-line summary kept from the old banner, e.g. 对话生成了任务草稿：「每日巡检」. */
  header: string
  rows: ProposalDiffRow[]
  /** Fingerprint of the patch the rows were summarized from — the reset key
   *  for the checkbox state (D4). */
  fingerprint: string
  /** Apply: receives the checked row keys; the host filters its patch. */
  onApply: (selectedKeys: string[]) => void
  onDismiss: () => void
}

export function ProposalReviewCard({ header, rows, fingerprint, onApply, onDismiss }: ProposalReviewCardProps): React.ReactElement {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => r.key)))
  // Reset to all-checked only when the proposal itself changed (render-time
  // adjust, the documented App.tsx pattern) — a diff recomputation from a
  // form edit must not touch the checks.
  const [prevFingerprint, setPrevFingerprint] = useState(fingerprint)
  if (prevFingerprint !== fingerprint) {
    setPrevFingerprint(fingerprint)
    setSelected(new Set(rows.map((r) => r.key)))
  }

  const toggle = (key: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        background: '#fff',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RobotOutlined style={{ color: '#666', flexShrink: 0 }} />
        {/* The summary truncates in place; the full text rides title (D3). */}
        <span title={header} style={{ flex: 1, minWidth: 0, ...ROW_CLAMP, color: '#666' }}>
          {header}
        </span>
        <Button
          size="small"
          type="primary"
          icon={<CheckOutlined />}
          disabled={selected.size === 0}
          onClick={() => onApply(rows.filter((r) => selected.has(r.key)).map((r) => r.key))}
        >
          {t('formAssist.apply')}
        </Button>
        <Button size="small" onClick={onDismiss}>
          {t('formAssist.dismiss')}
        </Button>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((row) => (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Checkbox checked={selected.has(row.key)} onChange={(e) => toggle(row.key, e.target.checked)} aria-label={row.label} />
              <span style={{ width: 76, flexShrink: 0, color: '#333', fontWeight: 600 }}>{row.label}</span>
              <span
                title={row.before || undefined}
                style={{
                  ...ROW_CLAMP,
                  flex: 1,
                  minWidth: 0,
                  color: row.before ? '#999' : '#ccc',
                  textDecoration: row.before ? 'line-through' : 'none',
                }}
              >
                {row.before || t('formAssist.diffEmpty')}
              </span>
              <span style={{ color: '#bbb', flexShrink: 0 }}>→</span>
              <span title={row.after} style={{ ...ROW_CLAMP, flex: 1.4, minWidth: 0, color: '#111', fontWeight: 600 }}>
                {row.after}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The 忽略 recovery chip (D5): a dismissed patch that re-arrives (same
 *  content is the latest proposal again) is no longer a silent disappearance
 *  — this weak chip is the one way back, since stripMessageFences keeps the
 *  original text out of the transcript on purpose. */
export function ProposalRestoreChip({ onRestore }: { onRestore: () => void }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: '1px dashed #d9d9d9',
        fontSize: 12,
        color: '#999',
        width: 'fit-content',
      }}
    >
      <RollbackOutlined style={{ fontSize: 12 }} />
      <span>{t('formAssist.dismissedSame')}</span>
      <a onClick={onRestore} style={{ color: '#555', cursor: 'pointer' }}>
        {t('formAssist.restore')}
      </a>
    </div>
  )
}
