// ── Markdown → .docx generation (PLAN-office-export, 附录 A) ──
// marked.lexer locates structure; the docx package writes the bytes. The
// engine is fully in memory (async but IO-free — Packer serializes a zip in
// RAM), so any failure here means zero bytes on disk.
//
// Fidelity contract (v1): supported markdown maps per 附录 A; anything else
// degrades to its raw text PLUS a closing note line naming the degradation —
// never silent loss. Inline styling takes the OUTERMOST token only (no
// bold-italic composition); nesting flattens to plain text inside.

import { marked } from 'marked'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

const NUMBERING_REFERENCE = 'pm-export-ordered'
const CODE_FONT = 'Courier New'
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
]

type MarkedToken = {
  type: string
  depth?: number
  raw?: string
  text?: string
  tokens?: MarkedToken[]
  ordered?: boolean
  items?: Array<{ tokens?: MarkedToken[] }>
  header?: MarkedCell[]
  rows?: MarkedCell[][]
  lang?: string
}
type MarkedCell = { text: string; tokens?: MarkedToken[] }
type DocxChild = Paragraph | Table
type InlineChild = TextRun | ExternalHyperlink

/** Everything that got downgraded, for the closing honesty note. */
class Degradations {
  private readonly kinds = new Set<string>()
  add(kind: string): void {
    this.kinds.add(kind)
  }
  note(): Paragraph | null {
    if (this.kinds.size === 0) return null
    const names = [...this.kinds].join('、')
    return new Paragraph({
      children: [new TextRun({ text: `注：${names}在 Word 导出中不支持，已以原文本呈现。`, italics: true, color: '808080', size: 18 })],
      spacing: { before: 240 },
    })
  }
}

/** Flatten an inline token tree to its plain text (styles dropped). */
function plainText(tokens?: MarkedToken[]): string {
  if (!tokens) return ''
  return tokens.map((t) => (t.tokens && t.tokens.length > 0 ? plainText(t.tokens) : t.text ?? '')).join('')
}

function inlineRuns(tokens: MarkedToken[] | undefined, degrade: Degradations, bold = false): InlineChild[] {
  if (!tokens) return []
  const out: InlineChild[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.tokens && token.tokens.length > 0) out.push(...inlineRuns(token.tokens, degrade, bold))
        else out.push(new TextRun({ text: token.text ?? '', bold }))
        break
      case 'escape':
        out.push(new TextRun({ text: token.text ?? '', bold }))
        break
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }))
        break
      case 'strong':
        out.push(new TextRun({ text: plainText(token.tokens), bold: true }))
        break
      case 'em':
        out.push(new TextRun({ text: plainText(token.tokens), italics: true }))
        break
      case 'del':
        out.push(new TextRun({ text: plainText(token.tokens), strike: true }))
        break
      case 'codespan':
        out.push(new TextRun({ text: token.text ?? '', font: CODE_FONT, shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' } }))
        break
      case 'link': {
        let href = String(token.raw ?? '').match(/\]\(\s*([^)\s]+)/)?.[1] ?? ''
        try { href = decodeURI(href) } catch { /* keep raw */ }
        out.push(new ExternalHyperlink({
          link: href,
          children: [new TextRun({ text: plainText(token.tokens), style: 'Hyperlink' })],
        }))
        break
      }
      case 'image': {
        degrade.add('图片')
        const alt = token.text || plainText(token.tokens) || '图片'
        out.push(new TextRun({ text: `[图片:${alt}，正文不支持]`, color: '808080' }))
        break
      }
      case 'html':
        degrade.add('HTML 片段')
        out.push(new TextRun({ text: token.raw ?? token.text ?? '' }))
        break
      default:
        out.push(new TextRun({ text: token.text ?? token.raw ?? '' }))
    }
  }
  return out
}

const BLOCKQUOTE_BORDER = { left: { style: BorderStyle.SINGLE, size: 18, color: 'C9CBD1', space: 8 } }

function blockChildren(tokens: MarkedToken[], degrade: Degradations): DocxChild[] {
  const out: DocxChild[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const level = Math.min(Math.max(token.depth ?? 1, 1), 6)
        out.push(new Paragraph({
          heading: HEADING_LEVELS[level - 1],
          children: inlineRuns(token.tokens, degrade),
        }))
        break
      }
      case 'paragraph':
        out.push(new Paragraph({ children: inlineRuns(token.tokens, degrade) }))
        break
      case 'blockquote': {
        for (const child of token.tokens ?? []) {
          // The quote's own shape (缩进 + 左边框) wraps each quoted paragraph;
          // a quoted table renders as itself — quoting a grid is not a Word
          // concept.
          if (child.type === 'table') {
            out.push(tableChild(child, degrade))
            continue
          }
          out.push(new Paragraph({
            indent: { left: 480 },
            border: BLOCKQUOTE_BORDER,
            spacing: { before: 80, after: 80 },
            children: inlineRuns(child.tokens ?? [child], degrade),
          }))
        }
        break
      }
      case 'code': {
        const lines = String(token.text ?? '').split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        for (const line of lines) {
          out.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: line === '' ? ' ' : line, font: CODE_FONT, size: 18 })],
          }))
        }
        break
      }
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CBD1', space: 1 } }, spacing: { before: 120, after: 120 } }))
        break
      case 'list':
        out.push(...listChildren(token, 0, degrade))
        break
      case 'table':
        out.push(tableChild(token, degrade))
        break
      case 'space':
        break
      default:
        degrade.add('数学/脚注等元素')
        out.push(new Paragraph({ children: [new TextRun({ text: token.raw ?? token.text ?? '' })] }))
    }
  }
  return out
}

function listChildren(token: MarkedToken, level: number, degrade: Degradations): Paragraph[] {
  const capped = Math.min(level, 2) // 嵌套 ≤3 层（0..2），更深拍平到第三层
  const out: Paragraph[] = []
  for (const item of token.items ?? []) {
    const runs: InlineChild[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        out.push(...listChildren(child, level + 1, degrade))
        continue
      }
      runs.push(...inlineRuns([child], degrade))
    }
    out.push(new Paragraph(
      token.ordered
        ? { numbering: { reference: NUMBERING_REFERENCE, level: capped }, children: runs }
        : { bullet: { level: capped }, children: runs }
    ))
  }
  return out
}

const CELL_MARGIN = { top: 60, bottom: 60, left: 100, right: 100 }

function tableChild(token: MarkedToken, degrade: Degradations): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: (token.header ?? []).map((cell) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: 'F2F3F5' },
      margins: CELL_MARGIN,
      children: [new Paragraph({ children: inlineRuns(cell.tokens, degrade, true) })],
    })),
  })
  const bodyRows = (token.rows ?? []).map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      margins: CELL_MARGIN,
      children: [new Paragraph({ children: inlineRuns(cell.tokens, degrade) })],
    })),
  }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] })
}

/** Markdown string → a real .docx buffer. */
export async function markdownToDocxBuffer(md: string): Promise<Buffer> {
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const degrade = new Degradations()
  const children = blockChildren(tokens, degrade)
  const note = degrade.note()
  if (note) children.push(note)
  const doc = new Document({
    numbering: {
      config: [{
        reference: NUMBERING_REFERENCE,
        levels: [0, 1, 2].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
        })),
      }],
    },
    sections: [{ children }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}
