// ── CSV parsing (PLAN-routine-batch M1) ──
// RFC 4180 parser behind the routine batch mode. Hand-rolled on purpose: the
// file is read in the main process, the header→param mapping is shared with
// the renderer's preview, and the three features batch actually needs (quoted
// fields, embedded newlines/commas, delimiter detection) are a ~70-line pure
// function with tests — not a new dependency.
//
// Lenient where RFC 4180 is silent: a quote appearing mid-field is literal
// text, text after a closing quote is appended, and a lone \r is a record
// separator (old-Mac files) — but \r\n INSIDE a quoted field stays verbatim,
// because that is what a multi-line Excel cell is made of and normalizing it
// would corrupt the cell.

export interface CsvTable {
  headers: string[]
  /** Data rows (headers row excluded); fully-blank rows are dropped. */
  rows: string[][]
}

/** Delimiters worth detecting, by how likely a spreadsheet produced them. */
const DELIMITERS = [',', ';', '\t'] as const

/** Count each candidate in the first line (outside quotes) and take the most
 *  frequent; ties go to the comma. Scanning past a quote's contents matters:
 *  a sentence full of commas inside the first quoted cell must not outvote the
 *  real separator on the header line. */
export function detectDelimiter(text: string): (typeof DELIMITERS)[number] {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch in counts) counts[ch] += 1
    else if (!inQuotes && ch === '\n') break
  }
  let best: (typeof DELIMITERS)[number] = ','
  for (const d of DELIMITERS) {
    if (counts[d] > counts[best]) best = d
  }
  return best
}

export function parseCsv(text: string, opts?: { delimiter?: string }): CsvTable {
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text
  const delim = opts?.delimiter ?? detectDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldOpen = false // a delimiter/line-end only closes a field that exists
  const endField = (): void => {
    row.push(field)
    field = ''
    fieldOpen = false
  }
  const endRecord = (): void => {
    endField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"' && !fieldOpen) {
      inQuotes = true
      fieldOpen = true
    } else if (ch === delim) {
      endField()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRecord()
    } else {
      field += ch
      fieldOpen = true
    }
  }
  if (fieldOpen || row.length > 0) endRecord() // no trailing newline
  const dataRows = rows.filter((r) => !r.every((cell) => cell === ''))
  const [headerRow, ...rest] = dataRows
  return { headers: (headerRow ?? []).map((h) => h.trim()), rows: rest }
}
