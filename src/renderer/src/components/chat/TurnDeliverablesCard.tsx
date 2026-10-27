/**
 * The per-turn deliverables card (2026-09-19): a turn's delivered files. The
 * card has TWO mount points, both chosen by ChatView: inside the turn's last
 * message (between the bubble and its 对话工具条, via MessageGroup's
 * aboveActions slot) when the turn ends with assistant text, or as a sibling
 * block after the turn's last segment otherwise. It scrolls with the content —
 * the whole-conversation aggregate panel this once lived beside in the
 * workbench was removed the same day; these cards are the only surface. Rows
 * come from the turn-scoped derivation (collectTurnDeliverables) —
 * main-session writes live as their tool_results land, direct-child rows join
 * when the terminal scan settles the spawn tree; grandchildren deliberately
 * have no turn to attach to and are not shown. Empty derivation renders
 * nothing at all, not even a placeholder.
 *
 * TIMING (2026-10-25 用户裁定): the card waits for its turn to SETTLE. The
 * derivation still folds rows in live, but ChatView suppresses the live
 * turn's card until the engine reaches a turn-ending status (idle / completed
 * / error — routine-entry's rule) — mid-turn the card used to ride the
 * streaming tail, dropping frame by frame and changing row count while the
 * turn was still producing. Earlier turns are settled history and always
 * render.
 *
 * Renders the CARD BOX only (the caller owns any column padding): the margins
 * are the spacing contract — 8 above, 16 inside the column, 12 below, because
 * assistant messages and execution segments carry no bottom margin of their
 * own and the next turn's user bubble has no top margin: without the 12 the
 * card's border sits flush against the next bubble.
 */
import React from 'react'
import type { Deliverable } from './deliverables'
import { DeliverableRows } from './DeliverableRows'
import { useTranslation } from '../../i18n/useTranslation'

/** A turn rarely writes more than a handful of files; past four the card
 *  scrolls instead of stretching the transcript. */
const TURN_VISIBLE_ROWS = 4

export function TurnDeliverablesCard({
  deliverable,
  conversationId,
  workspaceDir
}: {
  deliverable: Deliverable
  conversationId?: string
  workspaceDir?: string
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (deliverable.rows.length === 0) return null

  return (
    <div
      data-testid="turn-deliverables"
      title={t('deliverables.honestBoundary')}
      // calc(100% - 32px), never '100%': the 16px side margins ride OUTSIDE a
      // percentage width in BOTH mounts (the slot's flex column with
      // alignItems flex-start, and the sibling block wrapper), so width:100%
      // + margins rendered the card full-column but pushed 16px right — left
      // edge inset 16 from the bubble while the right edge stuck 16px past
      // it, off the composer's centerline (user report: 产物框和消息输入框
      // 没有垂直居中对齐). Subtracting the margins keeps the documented 16px
      // inset and both mounts on one centered footprint. align-items
      // flex-start still rules out plain 'auto': it would shrink the slotted
      // card to its content.
      style={{ width: 'calc(100% - 32px)', margin: '8px 16px 12px', border: '1px solid var(--pm-tile-border)', borderRadius: 10, background: 'var(--pm-tile-bg)' }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', userSelect: 'none' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, stroke: 'var(--pm-text-secondary)' }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M12 18v-6" />
          <path d="m9 15 3 3 3-3" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('deliverables.turnTitle')}</span>
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            background: 'var(--pm-tile-soft)',
            color: 'var(--pm-text-body)',
            fontSize: 10,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {deliverable.rows.length}
        </span>
        <span style={{ flex: 1 }} />
      </div>
      <DeliverableRows
        deliverable={deliverable}
        conversationId={conversationId}
        workspaceDir={workspaceDir}
        rowTestid="turn-deliverables-row"
        visibleRows={TURN_VISIBLE_ROWS}
      />
    </div>
  )
}
