// ── Shared office-edit op types (PLAN-office-editing §四.3) ──
// One source of truth for the tool input schema (renderer) and the engines
// (main). Pure types + validation — both processes import this.

export type DocxToolOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; paragraph?: number }
  | { op: 'insert_paragraph'; paragraph: number; position: 'before' | 'after'; text: string; style?: string }
  | { op: 'delete_paragraph'; paragraph: number }
  | { op: 'set_paragraph_style'; paragraph: number; style: string }
  | { op: 'format_text'; find: string; paragraph?: number; expected_count?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; font_size?: number }

export type XlsxToolOp =
  | { op: 'inspect'; sheet?: string }
  | { op: 'set_cell'; sheet?: string; cell: string; value?: string | number | boolean | null; formula?: string; number_format?: string }
  | { op: 'find_replace'; find: string; replace: string; sheet?: string; include_formulas?: boolean; expected_count?: number }

export type OfficeToolOp = DocxToolOp | XlsxToolOp

export interface OfficeOpResult {
  index: number
  op: string
  ok: boolean
  detail: string
}

/** Engine-shaped outcome; the services wrap it in a success/error envelope. */
export interface DocxEditOutcome {
  results: OfficeOpResult[]
  outline: Array<{ index: number; style: string | null; text: string }>
  warnings: string[]
}

export interface XlsxEditOutcome {
  buffer: Buffer
  results: OfficeOpResult[]
  outline: Array<{ sheet: string; usedRange: string }>
  warnings: string[]
}
