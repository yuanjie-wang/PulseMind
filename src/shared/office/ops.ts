// ── Shared office-edit op types (PLAN-office-editing §四.3) ──
// One source of truth for the tool input schema (renderer) and the engines
// (main). Pure types + validation — both processes import this.

export type DocxToolOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; paragraph?: number; track_changes?: boolean }
  | { op: 'insert_paragraph'; paragraph: number; position: 'before' | 'after'; text: string; style?: string }
  | { op: 'delete_paragraph'; paragraph: number }
  | { op: 'set_paragraph_style'; paragraph: number; style: string }
  | { op: 'format_text'; find: string; paragraph?: number; expected_count?: number; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; font_size?: number }
  | { op: 'insert_image'; paragraph: number; position: 'before' | 'after'; image: string; width_px?: number; height_px?: number }
  | { op: 'insert_table_row'; table: number; after_row: number; position?: 'before' | 'after'; cells?: string[] }
  | { op: 'delete_table_row'; table: number; row: number }

export type XlsxToolOp =
  | { op: 'inspect'; sheet?: string }
  | { op: 'set_cell'; sheet?: string; cell: string; value?: string | number | boolean | null; formula?: string; number_format?: string }
  | { op: 'find_replace'; find: string; replace: string; sheet?: string; include_formulas?: boolean; expected_count?: number }
  | { op: 'add_row'; sheet?: string; after_row: number; values?: Array<string | number | boolean | null> }
  | { op: 'set_style'; sheet?: string; cells: string; bold?: boolean; italic?: boolean; font_size?: number; color?: string; fill?: string; font?: string; align?: 'left' | 'center' | 'right'; wrap_text?: boolean }
  | { op: 'set_column_width'; sheet?: string; columns: string; width: number }
  | { op: 'freeze_panes'; sheet?: string; cell: string }

export type PptxToolOp =
  | { op: 'outline' }
  | { op: 'replace_text'; find: string; replace: string; expected_count?: number; slide?: number }
  | { op: 'set_shape_text'; slide: number; shape_id: string; text: string }
  | { op: 'format_text'; find: string; slide?: number; shape_id?: string; expected_count?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; font_size?: number; font?: string }
  | { op: 'set_shape_fill'; slide: number; shape_id: string; color: string; line_color?: string }
  | { op: 'set_slide_background'; slide: number; color: string }
  | { op: 'set_shape_geometry'; slide: number; shape_id: string; x?: number; y?: number; w?: number; h?: number }

export type OfficeToolOp = DocxToolOp | XlsxToolOp | PptxToolOp

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
  /** Body-level tables (M4): the executor prints 表 N：R 行 × C 列. */
  tables?: Array<{ index: number; rows: number; cols: number }>
  warnings: string[]
}

export interface PptxEditOutcome {
  results: OfficeOpResult[]
  outline: Array<{ slide: number; shapes: Array<{ shapeId: string; name: string; phType?: string; text: string }> }>
  warnings: string[]
}

export interface XlsxEditOutcome {
  buffer: Buffer
  results: OfficeOpResult[]
  outline: Array<{ sheet: string; usedRange: string }>
  warnings: string[]
}

// ── office_inspect outcome (PLAN-office-editing §P1) ──

export interface OfficeInspectResult {
  success: boolean
  format: 'docx' | 'xlsx' | 'pptx' | 'unknown'
  summary: string
  details: {
    paragraphs?: Array<{ index: number; style: string | null; textLength: number }>
    textBudget?: number
    sheets?: Array<{ name: string; usedRange: string; rowCount: number; columnCount: number }>
    formulas?: string[]
    charts?: number
    slides?: Array<{ index: number; text: string; shapeCount: number }>
    images?: number
  }
  error?: string
}
