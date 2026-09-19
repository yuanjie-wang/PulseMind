// ── CSV/TSV renderer for the preview pane (PLAN-preview-pane §设计3) ──
// parseCsv caps at CSV_PREVIEW_ROW_LIMIT rows; the tail note tells the user
// the rest is there. First row renders as the header.

import React from 'react'
import { parseCsv, CSV_PREVIEW_ROW_LIMIT } from '../../../../shared/preview/csv'
import { extensionOf } from '../../../../shared/preview/file-kind'
import { useTranslation } from '../../i18n/useTranslation'

const CELL: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid #f0f0f0',
  fontSize: 12,
  whiteSpace: 'nowrap',
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

// Memoized: both props are stable strings across the pane-width drag's
// re-renders — without it every 40ms tick re-runs parseCsv and rebuilds the
// whole table (same jank class as the python highlighter —
// probe-preview-drag.mjs).
export const CsvPreview = React.memo(function CsvPreview({ text, path }: { text: string; path: string }): React.ReactElement {
  const { t } = useTranslation()
  const delimiter = extensionOf(path) === 'tsv' ? '\t' : ','
  const { rows, truncated } = parseCsv(text, { delimiter })
  const [header, ...body] = rows

  if (!header) return <div style={{ padding: 24, textAlign: 'center', color: '#bbb', fontSize: 12 }}>—</div>

  return (
    <div style={{ padding: 12 }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                style={{
                  ...CELL,
                  position: 'sticky',
                  top: 0,
                  background: '#f7f8fa',
                  fontWeight: 600,
                  color: '#333',
                  textAlign: 'left',
                }}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{ ...CELL, color: '#555' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div style={{ padding: '10px 4px', fontSize: 11, color: '#999' }}>
          {t('previewPane.truncatedRows', { count: CSV_PREVIEW_ROW_LIMIT })}
        </div>
      )}
    </div>
  )
})
