// ── XLSX preview (PLAN-xlsx-preview) ── Renders a workbook in-app with the
// same exceljs build the edit engine uses (its `browser` field resolves to the
// self-contained dist bundle; parsed HERE in the renderer, like DocxPreview
// parses with docx-preview) — deliberately not the markitdown text the other
// office formats still fall back to, which flattens every style.
//
// Fidelity is the read-side twin of xlsx_edit's honest posture: values,
// formulas (cached result, else the formula text), number formats of the
// common families, fonts / fills / borders / alignment, merges, column and
// row dimensions. No recalculation, no chart/drawing rendering (those
// workbooks still open — the chart area is simply not part of the grid).
//
// exceljs loads through a dynamic import so the 2.8MB bundle stays in its own
// chunk that only an xlsx preview fetches. The grid caps at
// XLSX_PREVIEW_ROW/COL_LIMIT with a note, like the CSV renderer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Worksheet } from 'exceljs'
import type { FileKind } from '../../../../shared/preview/file-kind'
import {
  buildSheetGrid,
  columnLetter,
  XLSX_PREVIEW_COL_LIMIT,
  XLSX_PREVIEW_ROW_LIMIT,
  type XlsxCellInput,
  type XlsxCellValue,
  type XlsxSheetVM,
} from '../../../../shared/preview/xlsx'
import { FallbackCard } from './FallbackCard'
import { FileInfoBar } from './FileInfoBar'
import { ZoomControls, MIN_ZOOM, ZOOM_STEP_FACTOR, zoomByFactor } from './ZoomControls'
import { useWheelZoom, anchoredScroll, type ZoomAnchor } from './useWheelZoom'
import { useTranslation } from '../../i18n/useTranslation'

/** Width of the row-number gutter column, in px (fits "888").
 *  The grid face follows the theme (M4/T1): header/lines/ink ride the sheet —
 *  while every value that comes from the WORKBOOK (cell.bg, cell.color, the
 *  kind tints for formula/error below) stays a literal, because it is the
 *  file's own content, not UI. probe-xlsx-preview pins those data colors. */
const GUTTER_WIDTH = 36
const GRID_LINE = 'var(--pm-border-soft)'
const HEADER_BG = 'var(--pm-wash-cool)'
const HEADER_INK = 'var(--pm-text-muted)'

/** Adapt an exceljs worksheet to the pure grid builder's input. Only the
 *  capped window is materialised — getCell/getRow on a huge sheet never
 *  walks past it. The exceljs style objects are structurally compatible with
 *  the shared XlsxCellInput shape; the casts live here, at the boundary. */
function sheetInputOf(ws: Worksheet): Parameters<typeof buildSheetGrid>[0] {
  const rows = Math.min(ws.rowCount, XLSX_PREVIEW_ROW_LIMIT)
  const cols = Math.min(ws.columnCount, XLSX_PREVIEW_COL_LIMIT)
  const colWidths: Array<number | undefined> = []
  for (let c = 1; c <= cols; c++) colWidths.push(ws.getColumn(c).width)
  const rowHeights: Array<number | undefined> = []
  for (let r = 1; r <= rows; r++) rowHeights.push(ws.getRow(r).height)
  const model = ws.model as { merges?: string[] } | undefined
  return {
    name: ws.name,
    rowCount: ws.rowCount,
    columnCount: ws.columnCount,
    merges: model?.merges ?? [],
    colWidths,
    rowHeights,
    getCell(r, c) {
      const cell = ws.getRow(r)?.getCell(c)
      if (!cell) return undefined
      const input: XlsxCellInput = {
        value: cell.value as XlsxCellValue,
        numFmt: cell.numFmt,
        font: cell.font as XlsxCellInput['font'],
        fill: cell.fill as XlsxCellInput['fill'],
        alignment: cell.alignment as XlsxCellInput['alignment'],
        border: cell.border as XlsxCellInput['border'],
      }
      return input
    },
  }
}

export function XlsxPreview({
  path,
  kind,
  reloadTick,
}: {
  path: string
  kind: FileKind
  reloadTick: number
}): React.ReactElement {
  const { t } = useTranslation()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  /** Parsed worksheets, kept as adapter inputs — the grid VM is built per
   *  sheet switch, so a 40-column sheet's 20k cells only exist while shown.
   *  The ref mirrors the state so `switchSheet` stays a stable callback
   *  (state feeds the render; the ref is only read from event handlers). */
  const [sheets, setSheets] = useState<Array<Parameters<typeof buildSheetGrid>[0]>>([])
  const sheetsRef = useRef<Array<Parameters<typeof buildSheetGrid>[0]> | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [sheet, setSheet] = useState<XlsxSheetVM | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const manualZoomRef = useRef<number | null>(null)
  const appliedZoomRef = useRef(1)
  const [appliedZoom, setAppliedZoom] = useState(1)

  const applyZoom = useCallback(() => {
    const wrapper = containerRef.current?.querySelector<HTMLElement>('.pm-xlsx-zoom')
    if (!wrapper) return
    const scale = manualZoomRef.current ?? 1
    wrapper.style.zoom = String(scale)
    appliedZoomRef.current = scale
    setAppliedZoom((prev) => (Math.abs(prev - scale) < 0.0001 ? prev : scale))
  }, [])

  /** 适应宽度: the whole used grid (gutter included) fills the pane — shrunk
   *  to fit, never blown past 100%. The scale is measured at zoom 1: with any
   *  other scale applied, scrollWidth is already that scale's width and the
   *  fit would compound. */
  const fitZoom = useCallback((): number => {
    const container = containerRef.current
    const wrapper = container?.querySelector<HTMLElement>('.pm-xlsx-zoom')
    if (!container || !wrapper) return 1
    const prev = wrapper.style.zoom
    wrapper.style.zoom = '1'
    const natural = wrapper.scrollWidth
    wrapper.style.zoom = prev
    if (natural <= 0) return 1
    return Math.min(1, Math.max(MIN_ZOOM, container.clientWidth / natural))
  }, [])

  const zoomTo = useCallback(
    (to: number, anchor?: ZoomAnchor) => {
      const from = appliedZoomRef.current
      const container = containerRef.current
      const target = anchor && container ? anchoredScroll(container, anchor, from > 0 ? to / from : 1) : null
      manualZoomRef.current = to
      applyZoom()
      if (target && container) {
        container.scrollLeft = target.left
        container.scrollTop = target.top
      }
    },
    [applyZoom]
  )

  const zoomBy = useCallback(
    (factor: number, anchor?: ZoomAnchor) => {
      zoomTo(zoomByFactor(appliedZoomRef.current, factor), anchor)
    },
    [zoomTo]
  )

  const resetZoom = useCallback(() => {
    manualZoomRef.current = fitZoom()
    applyZoom()
  }, [applyZoom, fitZoom])

  useWheelZoom(containerRef, zoomBy)

  /** Monotonic load epoch: a parse landing after a newer load began (path
   *  change, reload tick) must not repaint stale sheets over fresh ones. */
  const loadEpochRef = useRef(0)

  // Same shape as DocxPreview's load effect: everything in the effect, deps
  // name the triggers (path change / toolbar refresh).
  useEffect(() => {
    const epoch = ++loadEpochRef.current
    const container = containerRef.current
    if (!container) return
    setState('loading')
    sheetsRef.current = null
    manualZoomRef.current = null
    window.electronAPI
      .readFileBinary(path)
      .then(async (base64) => {
        if (epoch !== loadEpochRef.current) return
        if (!base64) {
          setState('error')
          return
        }
        try {
          const bin = atob(base64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const mod: { Workbook?: unknown } & Record<string, unknown> = await import('exceljs')
          const ExcelJS = (mod.default ?? mod) as { Workbook: { new (): { worksheets: Worksheet[]; xlsx: { load(data: ArrayBuffer): Promise<void> } } } }
          const wb = new ExcelJS.Workbook()
          await wb.xlsx.load(bytes.buffer as ArrayBuffer)
          if (epoch !== loadEpochRef.current) return
          const parsed = wb.worksheets.map(sheetInputOf)
          sheetsRef.current = parsed
          setSheets(parsed)
          setSheet(parsed.length > 0 ? buildSheetGrid(parsed[0]) : null)
          setSheetIndex(0)
          setState('ready')
          applyZoom()
        } catch {
          if (epoch === loadEpochRef.current) setState('error')
        }
      })
      .catch(() => {
        if (epoch === loadEpochRef.current) setState('error')
      })
  }, [path, reloadTick, applyZoom])

  const switchSheet = useCallback(
    (index: number) => {
      const sheets = sheetsRef.current
      if (!sheets || !sheets[index]) return
      setSheetIndex(index)
      setSheet(buildSheetGrid(sheets[index]))
    },
    []
  )

  const notes = useMemo(() => {
    if (!sheet) return []
    const out: string[] = []
    if (sheet.truncatedRows) {
      out.push(t('previewPane.xlsxTruncatedRows', { count: XLSX_PREVIEW_ROW_LIMIT, total: sheet.totalRows }))
    }
    if (sheet.truncatedCols) {
      out.push(t('previewPane.xlsxTruncatedCols', { count: XLSX_PREVIEW_COL_LIMIT, total: sheet.totalCols }))
    }
    return out
  }, [sheet, t])

  if (state === 'error') return <FallbackCard path={path} kind={kind} />

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {notes.length > 0 && (
        <div style={{ flexShrink: 0, padding: '4px 12px', fontSize: 11, color: 'var(--pm-warn)', background: 'var(--pm-warn-bg)', borderBottom: '1px solid var(--pm-warn-border)' }}>
          {notes.join('，')}
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={containerRef}
          className="pm-xlsx-scroll"
          style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
        >
          {sheet && (
            <div className="pm-xlsx-zoom" style={{ zoom: appliedZoom, color: 'var(--pm-sheet-ink)' }}>
              <table
                data-xlsx-grid
                style={{
                  tableLayout: 'fixed',
                  borderCollapse: 'separate',
                  borderSpacing: 0,
                  width: GUTTER_WIDTH + sheet.colWidths.reduce((a, b) => a + b, 0),
                }}
              >
                <colgroup>
                  <col style={{ width: GUTTER_WIDTH }} />
                  {sheet.colWidths.map((w, i) => (
                    <col key={i} style={{ width: w }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th
                      style={{
                        ...HEADER_CELL,
                        left: 0,
                        zIndex: 3,
                        borderRight: `1px solid ${GRID_LINE}`,
                      }}
                    />
                    {sheet.cells[0]?.map((_, c) => (
                      <th key={c} style={{ ...HEADER_CELL, top: 0, zIndex: 2 }}>
                        {columnLetter(c + 1)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.cells.map((row, r) => (
                    <tr key={r} style={{ height: sheet.rowHeights[r] }}>
                      <th style={{ ...HEADER_CELL, left: 0, zIndex: 2, borderRight: `1px solid ${GRID_LINE}` }}>{r + 1}</th>
                      {row.map((cell, c) => {
                        if (cell === null) return null
                        return (
                          <td
                            key={c}
                            colSpan={cell.colSpan}
                            rowSpan={cell.rowSpan}
                            title={cell.kind === 'link' ? cell.link : undefined}
                            style={{
                              padding: '2px 6px',
                              fontSize: cell.fontSizePt ? `${cell.fontSizePt}pt` : '11pt',
                              fontFamily: cell.fontFamily,
                              color:
                                cell.kind === 'error'
                                  ? '#d4380d'
                                  : cell.kind === 'formula'
                                    ? '#722ed1'
                                    : cell.kind === 'link'
                                      ? 'var(--pm-link)'
                                      : cell.color,
                              background: cell.bg,
                              fontWeight: cell.bold ? 600 : undefined,
                              fontStyle: cell.italic ? 'italic' : undefined,
                              textDecoration:
                                cell.underline && cell.strike
                                  ? 'underline line-through'
                                  : cell.underline
                                    ? 'underline'
                                    : cell.strike
                                      ? 'line-through'
                                      : undefined,
                              textAlign: cell.hAlign as React.CSSProperties['textAlign'],
                              verticalAlign: cell.vAlign === 'middle' ? 'middle' : cell.vAlign === 'top' ? 'top' : cell.vAlign === 'bottom' ? 'bottom' : undefined,
                              whiteSpace: cell.wrap ? 'pre-wrap' : 'nowrap',
                              overflow: 'hidden',
                              textOverflow: cell.wrap ? 'clip' : 'ellipsis',
                              borderBottom: cell.borders?.bottom ?? `1px solid ${GRID_LINE}`,
                              borderRight: cell.borders?.right ?? `1px solid ${GRID_LINE}`,
                              borderLeft: cell.borders?.left,
                              borderTop: cell.borders?.top,
                              wordBreak: 'break-all',
                            }}
                          >
                            {cell.text}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!sheet && state === 'ready' && sheets.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>—</div>
          )}
        </div>
        {state === 'loading' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pm-text-faint)', fontSize: 12, background: 'var(--pm-bg)' }}>…</div>
        )}
      </div>
      {/* Sheet tab strip (Excel keeps these at the bottom; so do we). */}
      {sheets.length > 0 && (
        <div
          data-xlsx-sheetbar
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '3px 8px',
            borderTop: '1px solid var(--pm-separator-faint)',
            overflowX: 'auto',
            scrollbarWidth: 'thin',
          }}
        >
          {sheets.map((s, i) => (
            <div
              key={i}
              data-sheet={s.name}
              onClick={() => switchSheet(i)}
              style={{
                flexShrink: 0,
                padding: '2px 10px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                color: i === sheetIndex ? 'var(--pm-link)' : 'var(--pm-text-secondary)',
                background: i === sheetIndex ? 'var(--pm-link-bg-solid)' : 'transparent',
                whiteSpace: 'nowrap',
              }}
            >
              {s.name}
            </div>
          ))}
        </div>
      )}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
        <ZoomControls zoom={appliedZoom} fitKey="fitWidth" onFit={resetZoom} onZoomOut={() => zoomBy(1 / ZOOM_STEP_FACTOR)} onZoomIn={() => zoomBy(ZOOM_STEP_FACTOR)} />
      </div>
    </div>
  )
}

const HEADER_CELL: React.CSSProperties = {
  position: 'sticky',
  background: HEADER_BG,
  color: HEADER_INK,
  fontSize: 10,
  fontWeight: 500,
  textAlign: 'center',
  padding: '2px 4px',
  borderBottom: `1px solid ${GRID_LINE}`,
  userSelect: 'none',
}
