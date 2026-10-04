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

// ── office_read (PLAN-office-read) ── paged, structure-faithful reads in the
// file's own address space. One input shape, three format views: the fields a
// format ignores stay absent. Coordinates (paragraph index / cell address /
// shape id) are the SAME ones the edit tools consume — that consistency is
// the tool's reason to exist; `read` (markitdown) serves the human view.

export interface OfficeReadInput {
  filePath: string
  /** docx: 1-based first paragraph of the page; xlsx: 1-based first row. */
  offset?: number
  /** docx: paragraphs per page; xlsx: rows per page. */
  limit?: number
  /** docx only: also return body-level tables with per-cell text. */
  tables?: boolean
  /** xlsx only: sheet name; absent → the sheet inventory is returned. */
  sheet?: string
  /** xlsx only: explicit range "A1:J50" or single cell "B3" (overrides
   *  offset/limit). */
  range?: string
  /** pptx only: 1-based slide (presentation order); absent → every slide. */
  slide?: number
}

export interface OfficeReadResult {
  success: boolean
  format: 'docx' | 'xlsx' | 'pptx' | 'unknown'
  summary: string
  details: {
    /** docx — FULL paragraph text in the replace/format match space (gap
     *  chars rendered as spaces), paged. `nextOffset` is present when more
     *  paragraphs remain. */
    paragraphs?: Array<{ index: number; style: string | null; text: string }>
    paragraphCount?: number
    nextOffset?: number
    /** docx — body-level tables; `cells` (present when the call asked for
     *  tables) holds per-cell text, row-major. */
    tables?: Array<{ index: number; rows: number; cols: number; cells?: string[][] }>
    /** xlsx — the inventory returned when `sheet` was omitted. */
    sheets?: Array<{ name: string; rowCount: number; columnCount: number }>
    /** xlsx — a cell window: the sheet it came from, the 1-based first row,
     *  the rendered cells, and the column span actually read. */
    sheet?: string
    startRow?: number
    cells?: string[][]
    columnCount?: number
    /** pptx — shapes with FULL text (paragraphs joined by \n), presentation
     *  order (sldIdLst — the same order pptx_edit's `slide` counts). */
    slides?: Array<{ index: number; shapes: Array<{ shapeId: string; name: string; phType?: string; text: string }> }>
    error?: string
  }
}

// ── office_inspect outcome (PLAN-office-editing §P1) ──

export interface OfficeInspectResult {
  success: boolean
  format: 'docx' | 'xlsx' | 'pptx' | 'unknown'
  summary: string
  details: {
    /** docx — one entry per outline paragraph (capped). `text` is the
     *  first-80-chars preview (outlineOf's slice); `textLength` is the FULL
     *  paragraph length, consistent with the summary's total.
     *  `paragraphCount` is the REAL document total (outlineOf caps the list
     *  itself at 200) — the formatter reports THIS as 共 N 段. */
    paragraphs?: Array<{ index: number; style: string | null; textLength: number; text?: string }>
    paragraphCount?: number
    textBudget?: number
    /** xlsx — `head` is the leading rows × cols of the sheet as raw cell
     *  text (formula cells report their cached result), absent when empty. */
    sheets?: Array<{ name: string; usedRange: string; rowCount: number; columnCount: number; head?: string[][] }>
    formulas?: string[]
    charts?: number
    slides?: Array<{ index: number; text: string; shapeCount: number }>
    images?: number
  }
  error?: string
}
