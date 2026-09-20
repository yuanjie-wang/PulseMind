/**
 * The deliverable row list, shared by both surfaces that show one (2026-09-19):
 * the per-turn inline card in the chat (capped height, scrolls inside) and the
 * workbench 产物 tab's aggregate panel (fills its pane). Extracted verbatim
 * from the retired chat-tail DeliverablesCard — row click still opens the file
 * through the REAL previewPaneStore.openFile, which flips the workbench to the
 * 文件预览 tab itself. Pure presentation: the caller owns the derivation.
 */
import React from 'react'
import type { Deliverable, DeliverableRow } from './deliverables'
import { baseName, detectFileKind, resolvePreviewPath } from '../../../../shared/preview/file-kind'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useTranslation } from '../../i18n/useTranslation'
import { toolDisplayName } from './tool-summary'

/** Rows visible before the list scrolls — a summary, not a transcript. */
export const VISIBLE_ROWS = 8
export const ROW_HEIGHT = 28

export const KIND_GLYPH: Record<string, string> = {
  markdown: 'M↓',
  text: 'TXT',
  csv: 'CSV',
  image: 'IMG',
  html: 'WEB',
  office: 'DOC',
  binary: 'BIN'
}

/** docx/xlsx rows carry the office badge the preview pane's own renderer
 *  names them by (OfficePreview's conversions); other kinds are covered by the
 *  kind glyph and get none. */
export function officeBadge(path: string): string | null {
  const ext = baseName(path).split('.').pop()?.toLowerCase()
  if (ext === 'docx' || ext === 'doc') return 'Word'
  if (ext === 'xlsx' || ext === 'xls') return 'Excel'
  return null
}

/** The display path: workspace-relative when inside the workspace, the bare
 *  name when outside it (an absolute path the workspace doesn't own reads as a
 *  foreign absolute path); a relative tool input passes through. The tooltip
 *  always carries the resolved absolute — locating the file beats pretty. */
export function displayPath(row: DeliverableRow, workspaceDir: string | undefined): { display: string; absolute: string } {
  const absolute = resolvePreviewPath(row.path, workspaceDir ?? null)
  const root = (workspaceDir ?? '').replace(/[\\/]+$/, '')
  if (root !== '' && absolute.startsWith(root + '/')) {
    return { display: absolute.slice(root.length + 1), absolute }
  }
  if (/^([A-Za-z]:[\\/]|\/|~)/.test(row.path)) {
    return { display: baseName(absolute), absolute }
  }
  return { display: row.path, absolute }
}

export function DeliverableRows({
  deliverable,
  conversationId,
  workspaceDir,
  rowTestid = 'deliverables-row',
  visibleRows = VISIBLE_ROWS,
  fill = false
}: {
  deliverable: Deliverable
  conversationId?: string
  workspaceDir?: string
  /** Row probe hook: the two surfaces scope their queries per card, so the
   *  turn card names its own. */
  rowTestid?: string
  visibleRows?: number
  /** Workbench mode: fill the pane (flex) instead of capping at a row count. */
  fill?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const openRow = (row: DeliverableRow): void => {
    usePreviewPaneStore
      .getState()
      .openFile(conversationId ?? null, resolvePreviewPath(row.path, workspaceDir ?? null))
  }
  const titleByConv = new Map(deliverable.sources.map((s) => [s.convId, s.title]))

  return (
    <div
      data-testid="deliverables-rows"
      style={{
        ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: ROW_HEIGHT * visibleRows }),
        overflowY: 'auto',
        padding: '0 6px 4px',
        borderTop: '1px solid var(--pm-tile-soft)'
      }}
    >
      {deliverable.rows.map((row) => {
        const { display, absolute } = displayPath(row, workspaceDir)
        const opCounts = new Map<string, number>()
        for (const op of row.ops) opCounts.set(op.tool, (opCounts.get(op.tool) ?? 0) + 1)
        const badge = officeBadge(row.path)
        const fromChild = row.fromConvIds.length > 0
        return (
          <div
            key={row.path}
            data-testid={rowTestid}
            data-dl-path={row.path}
            title={absolute}
            onClick={() => openRow(row)}
            className="pm-dl-row"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: ROW_HEIGHT - 4,
              padding: '0 8px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--pm-row-ink)'
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 30,
                height: 16,
                borderRadius: 4,
                background: 'var(--pm-tile-soft)',
                color: 'var(--pm-text-dim)',
                fontSize: 9,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                letterSpacing: 0.2
              }}
            >
              {KIND_GLYPH[detectFileKind(row.path)] ?? 'BIN'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
            {badge && (
              <span
                style={{
                  flexShrink: 0,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--pm-tag-success-bg)',
                  color: 'var(--pm-tag-success-ink)',
                  fontSize: 10,
                  fontWeight: 600
                }}
              >
                {badge}
              </span>
            )}
            <span style={{ flexShrink: 0, color: 'var(--pm-text-muted)', fontSize: 11, display: 'inline-flex', gap: 6 }}>
              {[...opCounts].map(([tool, count]) => (
                <span key={tool}>
                  {toolDisplayName(tool, t)} ×{count}
                </span>
              ))}
            </span>
            <span style={{ flex: 1 }} />
            {fromChild && (
              <span style={{ flexShrink: 0, color: 'var(--pm-text-muted)', fontSize: 11 }}>
                {t('deliverables.from', {
                  name: titleByConv.get(row.fromConvIds[0]) ?? row.fromConvIds[0]
                })}
              </span>
            )}
            <span className="pm-dl-preview" style={{ flexShrink: 0, color: 'var(--pm-link-preview)', fontSize: 11, visibility: 'hidden' }}>
              {t('deliverables.preview')}
            </span>
          </div>
        )
      })}
      <style>{`
        .pm-dl-row:hover { background: var(--pm-tile-hover); }
        .pm-dl-row:hover .pm-dl-preview { visibility: visible !important; }
      `}</style>
    </div>
  )
}
