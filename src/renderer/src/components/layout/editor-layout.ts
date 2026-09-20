// ── Editor layout primitives ──
// The design language shared by the app's "list · form · assistant" editors
// (the capability center's expert editor, the routine editor page): the form
// and the assistant share ONE gray rounded surface, and the assistant sits
// inside it as a white rounded card — an accessory of the form rather than a
// peer column. Kept as shared constants so the two editors cannot drift.

import type React from 'react'

/** Column title row — a muted caption sitting above the column's body. */
export const EDITOR_COLUMN_HEADER: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--pm-text-muted)',
  padding: '0 0 8px 2px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
}

/** Width of an editor's list column (the switcher column, not a pane). */
export const EDITOR_LIST_WIDTH = 216

/** The gray surface the form and the assistant share. */
export const EDITOR_SURFACE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--pm-fill)',
  borderRadius: 12,
  padding: 12,
  display: 'flex',
  gap: 12,
  minHeight: 0,
}

/** The assistant column inside EDITOR_SURFACE. */
export const EDITOR_CHAT_CARD: React.CSSProperties = {
  flex: '0 1 460px',
  minWidth: 300,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--pm-card)',
  borderRadius: 10,
  padding: '6px 12px 12px',
}
