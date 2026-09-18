/**
 * The deliverables card (PLAN-deliverables M3): a turn's delivered files, one
 * row per file, sitting in the chat tail next to ErrorDisplay /
 * SubAgentStopPrompt / ExtensionPrompt — the same family container, the fifth
 * sibling. Row click opens the file in the workbench's preview tab
 * (previewPaneStore.openFile flips the pane itself). Derived, never persisted:
 * an empty derivation renders nothing at all, not even a placeholder.
 */
import React, { useState } from 'react'
import type { Deliverable, DeliverableRow } from './deliverables'
import { baseName, detectFileKind, resolvePreviewPath } from '../../../../shared/preview/file-kind'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useTranslation } from '../../i18n/useTranslation'
import { toolDisplayName } from './tool-summary'

/** Rows visible before the list scrolls — a summary, not a transcript. */
const VISIBLE_ROWS = 8
const ROW_HEIGHT = 28

const KIND_GLYPH: Record<string, string> = {
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
function officeBadge(path: string): string | null {
  const ext = baseName(path).split('.').pop()?.toLowerCase()
  if (ext === 'docx' || ext === 'doc') return 'Word'
  if (ext === 'xlsx' || ext === 'xls') return 'Excel'
  return null
}

/** The display path: workspace-relative when inside the workspace, the bare
 *  name when outside it (an absolute path the workspace doesn't own reads as a
 *  foreign absolute path); a relative tool input passes through. The tooltip
 *  always carries the resolved absolute — locating the file beats pretty. */
function displayPath(row: DeliverableRow, workspaceDir: string | undefined): { display: string; absolute: string } {
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

export function DeliverablesCard({
  deliverable,
  conversationId,
  workspaceDir
}: {
  deliverable: Deliverable
  conversationId?: string
  workspaceDir?: string
}): React.ReactElement | null {
  const { t } = useTranslation()
  const convKey = conversationId ?? ''
  // Collapse is component state keyed by conversation (a one-shot closing
  // summary is not store material); the render-time reset is the same pattern
  // SubAgentSessionView and useDeliverables use.
  const [state, setState] = useState({ convKey, collapsed: false })
  if (state.convKey !== convKey) setState({ convKey, collapsed: false })

  if (deliverable.rows.length === 0) return null
  const collapsed = state.convKey === convKey ? state.collapsed : false

  const openRow = (row: DeliverableRow): void => {
    usePreviewPaneStore
      .getState()
      .openFile(conversationId ?? null, resolvePreviewPath(row.path, workspaceDir ?? null))
  }
  const openWorkspace = (): void => {
    useWorkbenchStore.getState().openTab(convKey, 'files')
  }

  const titleByConv = new Map(deliverable.sources.map((s) => [s.convId, s.title]))

  return (
    <div className="pm-deliverables-card" style={{ margin: '8px 16px 0', border: '1px solid #e8e9ed', borderRadius: 10, background: '#fff' }}>
      <div
        data-testid="deliverables-head"
        onClick={() => setState({ convKey, collapsed: !collapsed })}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', cursor: 'pointer', userSelect: 'none' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M12 18v-6" />
          <path d="m9 15 3 3 3-3" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#333' }}>{t('deliverables.title')}</span>
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            background: '#f0f1f4',
            color: '#555',
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
        <span style={{ fontSize: 11, color: '#bbb', transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.15s' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </span>
      </div>

      {!collapsed && (
        <>
          <div
            data-testid="deliverables-rows"
            style={{
              maxHeight: ROW_HEIGHT * VISIBLE_ROWS,
              overflowY: 'auto',
              padding: '0 6px 4px',
              borderTop: '1px solid #f0f1f4'
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
                  data-testid="deliverables-row"
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
                    color: '#444'
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      width: 30,
                      height: 16,
                      borderRadius: 4,
                      background: '#f0f1f4',
                      color: '#777',
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
                        background: '#e8f0e8',
                        color: '#2e7d32',
                        fontSize: 10,
                        fontWeight: 600
                      }}
                    >
                      {badge}
                    </span>
                  )}
                  <span style={{ flexShrink: 0, color: '#999', fontSize: 11, display: 'inline-flex', gap: 6 }}>
                    {[...opCounts].map(([tool, count]) => (
                      <span key={tool}>
                        {toolDisplayName(tool, t)} ×{count}
                      </span>
                    ))}
                  </span>
                  <span style={{ flex: 1 }} />
                  {fromChild && (
                    <span style={{ flexShrink: 0, color: '#999', fontSize: 11 }}>
                      {t('deliverables.from', {
                        name: titleByConv.get(row.fromConvIds[0]) ?? row.fromConvIds[0]
                      })}
                    </span>
                  )}
                  <span className="pm-dl-preview" style={{ flexShrink: 0, color: '#1a73e8', fontSize: 11, visibility: 'hidden' }}>
                    {t('deliverables.preview')}
                  </span>
                </div>
              )
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 14px',
              borderTop: '1px solid #f0f1f4',
              fontSize: 11,
              color: '#999'
            }}
          >
            <span>{t('deliverables.total', { n: deliverable.rows.length })}</span>
            <span
              data-testid="deliverables-open-workspace"
              onClick={(e) => {
                e.stopPropagation()
                openWorkspace()
              }}
              className="pm-dl-workspace"
              style={{ color: '#1a73e8', cursor: 'pointer' }}
            >
              {t('deliverables.openWorkspace')}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: '#bbb' }}>{t('deliverables.honestBoundary')}</span>
          </div>
        </>
      )}
      <style>{`
        .pm-dl-row:hover { background: #f5f6f8; }
        .pm-dl-row:hover .pm-dl-preview { visibility: visible !important; }
        .pm-dl-workspace:hover { text-decoration: underline; }
      `}</style>
    </div>
  )
}
