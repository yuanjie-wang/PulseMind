// ── CSV parsing for the preview pane (PLAN-preview-pane §设计3) ──
// RFC4180-style parser: quoted fields, "" escapes, newlines inside quotes,
// CRLF. Pure and IO-free so vitest can cover it directly. The pane caps the
// rendered row count; rows beyond the cap are parsed lazily (we stop early
// and report `truncated` instead of materializing the whole file).

export interface ParsedCsv {
  rows: string[][]
  /** True when parsing stopped at the row cap (file has more rows). */
  truncated: boolean
}

export const CSV_PREVIEW_ROW_LIMIT = 500

export function parseCsv(text: string, options?: { maxRows?: number; delimiter?: string }): ParsedCsv {
  const maxRows = options?.maxRows ?? CSV_PREVIEW_ROW_LIMIT
  const delimiter = options?.delimiter ?? ','

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnyField = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
    sawAnyField = true
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
    sawAnyField = false
  }

  while (i < text.length) {
    if (rows.length >= maxRows) return { rows, truncated: true }

    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i += 1
        }
      } else {
        field += ch
        i += 1
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      endField()
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      // A lone trailing newline terminates the last row — don't emit an
      // empty phantom row for it.
      if (sawAnyField || field !== '' || row.length > 0 || text[i + 1] !== undefined) endRow()
      i += 1
      continue
    }
    field += ch
    i += 1
  }

  if (field !== '' || row.length > 0 || sawAnyField) endRow()
  return { rows, truncated: false }
}
