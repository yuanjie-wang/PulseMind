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
import { imageDims, displaySize } from '../../shared/office/image-dims'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
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
// ── fontSize (export_document, 磅) ── Word's default body size is the
// baseline the built-in Heading1–3 sizes (16/13/12pt) and the 9pt code block
// are proportioned against: a caller-set fontSize rescales all of them by
// fontSize / BODY_BASE_PT, so a 四号 (14pt) body never outgrows its own
// headings (Heading2 would otherwise sit at 13pt, BELOW the body).
const BODY_BASE_PT = 11
const CODE_HALF_BASE = 18 // code block + degradation note at the base body
const HEADING_HALF_BASE = [32, 26, 24] // Heading1–3 at the base body, half-points
const HEADING_COLOR = ['2E74B5', '2E74B5', '1F4D78'] // the docx lib's defaults — re-stated in fontStyles()
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

/** Everything that got downgraded, for the closing honesty note.
 *  `noteSize` (half-points) rides the document's fontSize like the code block does. */
class Degradations {
  private readonly kinds = new Set<string>()
  constructor(private readonly noteSize: number = CODE_HALF_BASE) {}
  add(kind: string): void {
    this.kinds.add(kind)
  }
  note(): Paragraph | null {
    if (this.kinds.size === 0) return null
    const names = [...this.kinds].join('、')
    return new Paragraph({
      children: [new TextRun({ text: `注：${names}在 Word 导出中不支持，已以原文本呈现。`, italics: true, color: '808080', size: this.noteSize })],
      spacing: { before: 240 },
    })
  }
}

/** Flatten an inline token tree to its plain text (styles dropped). */
function plainText(tokens?: MarkedToken[]): string {
  if (!tokens) return ''
  return tokens.map((t) => (t.tokens && t.tokens.length > 0 ? plainText(t.tokens) : t.text ?? '')).join('')
}

function inlineRuns(tokens: MarkedToken[] | undefined, degrade: Degradations, images: Map<string, Buffer> | undefined, bold = false): InlineChild[] {
  if (!tokens) return []
  const out: InlineChild[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.tokens && token.tokens.length > 0) out.push(...inlineRuns(token.tokens, degrade, images, bold))
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
        // M2 (PLAN-office-expressiveness): a resolvable WORKSPACE href embeds
        // the real image; http(s)/data:/unreadable keeps today's degradation —
        // never silent, never fetched over the network.
        const href = decodeURI(String(token.raw ?? '').match(/!\[.*?\]\(\s*([^)\s]+)/)?.[1] ?? '').replace(/^['"]|['"]$/g, '')
        const buf = images?.get(href)
        if (buf) {
          const dims = imageDims(buf)
          const ext = href.split('.').pop()?.toLowerCase() ?? ''
          const type = ext === 'png' ? 'png' : ext === 'gif' ? 'gif' : 'jpg'
          if (dims) {
            const size = displaySize(dims)
            out.push(new ImageRun({ type, data: buf, transformation: { width: size.width, height: size.height } }))
            break
          }
        }
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

function blockChildren(tokens: MarkedToken[], degrade: Degradations, images: Map<string, Buffer> | undefined, codeSize: number): DocxChild[] {
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
        out.push(new Paragraph({ children: inlineRuns(token.tokens, degrade, images) }))
        break
      case 'blockquote': {
        for (const child of token.tokens ?? []) {
          // The quote's own shape (缩进 + 左边框) wraps each quoted paragraph;
          // a quoted table renders as itself — quoting a grid is not a Word
          // concept.
          if (child.type === 'table') {
            out.push(tableChild(child, degrade, images))
            continue
          }
          out.push(new Paragraph({
            indent: { left: 480 },
            border: BLOCKQUOTE_BORDER,
            spacing: { before: 80, after: 80 },
            children: inlineRuns(child.tokens ?? [child], degrade, images),
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
            children: [new TextRun({ text: line === '' ? ' ' : line, font: CODE_FONT, size: codeSize })],
          }))
        }
        break
      }
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CBD1', space: 1 } }, spacing: { before: 120, after: 120 } }))
        break
      case 'list':
        out.push(...listChildren(token, 0, degrade, images))
        break
      case 'table':
        out.push(tableChild(token, degrade, images))
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

function listChildren(token: MarkedToken, level: number, degrade: Degradations, images: Map<string, Buffer> | undefined): Paragraph[] {
  const capped = Math.min(level, 2) // 嵌套 ≤3 层（0..2），更深拍平到第三层
  const out: Paragraph[] = []
  for (const item of token.items ?? []) {
    const runs: InlineChild[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        out.push(...listChildren(child, level + 1, degrade, images))
        continue
      }
      runs.push(...inlineRuns([child], degrade, images))
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

function tableChild(token: MarkedToken, degrade: Degradations, images: Map<string, Buffer> | undefined): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: (token.header ?? []).map((cell) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: 'F2F3F5' },
      margins: CELL_MARGIN,
      children: [new Paragraph({ children: inlineRuns(cell.tokens, degrade, images, true) })],
    })),
  })
  const bodyRows = (token.rows ?? []).map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      margins: CELL_MARGIN,
      children: [new Paragraph({ children: inlineRuns(cell.tokens, degrade, images) })],
    })),
  }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] })
}

/** href paths referenced by ![...](href) — workspace-relative or absolute,
 *  in document order (the service resolves + reads them, mirroring deckImagePaths). */
export function mdImagePaths(md: string): Array<{ href: string }> {
  const out: Array<{ href: string }> = []
  const seen = new Set<string>()
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const visit = (list: MarkedToken[]): void => {
    for (const t of list) {
      if (t.type === 'image') {
        const href = decodeURI(String(t.raw ?? '').match(/!\[.*?\]\(\s*([^)\s]+)/)?.[1] ?? '').replace(/^['"]|['"]$/g, '')
        if (href && !seen.has(href)) { seen.add(href); out.push({ href }) }
      }
      if (t.tokens) visit(t.tokens as unknown as MarkedToken[])
    }
  }
  visit(tokens)
  return out
}

/** Markdown string → a real .docx buffer. `images` maps workspace hrefs to
 *  resolved bytes (M2): a hit embeds the real image, a miss keeps the
 *  degradation placeholder — the resolver decides, never the network.
 *  `options.fontSize` (磅) sets the document-wide body size; headings and the
 *  code block scale with it (BODY_BASE_PT), and WITHOUT it no styles part is
 *  emitted — the output stays byte-identical to a fontSize-less export. */
export async function markdownToDocxBuffer(
  md: string,
  images?: Map<string, Buffer>,
  options?: { fontSize?: number },
): Promise<Buffer> {
  const fontSize = options?.fontSize
  const scale = fontSize !== undefined ? fontSize / BODY_BASE_PT : 1
  const codeSize = Math.round(CODE_HALF_BASE * scale)
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const degrade = new Degradations(codeSize)
  const children = blockChildren(tokens, degrade, images, codeSize)
  const note = degrade.note()
  if (note) children.push(note)
  const doc = new Document({
    // The docx lib shallow-merges each `default` key over its own `{ run }`,
    // so a heading override must re-state the default color — size alone
    // would silently drop the headings to black.
    ...(fontSize !== undefined
      ? {
          styles: {
            default: {
              document: { run: { size: Math.round(fontSize * 2) } },
              heading1: { run: { color: HEADING_COLOR[0], size: Math.round(HEADING_HALF_BASE[0] * scale) } },
              heading2: { run: { color: HEADING_COLOR[1], size: Math.round(HEADING_HALF_BASE[1] * scale) } },
              heading3: { run: { color: HEADING_COLOR[2], size: Math.round(HEADING_HALF_BASE[2] * scale) } },
            },
          },
        }
      : {}),
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
