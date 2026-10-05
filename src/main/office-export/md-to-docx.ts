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
  LineRuleType,
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
const BULLET_REFERENCE = 'pm-export-bullet'
const CODE_FONT = 'Courier New'
// ── 文档样式系统（2026-10-01 样式移植，取代 docx 库的出厂默认观感）──
// 视觉语言对齐 markdowner 的导出 CSS（墨色标题/浅灰细线表格/蓝边浅底引用/
// 1.5 倍行距），全部走 OOXML 表达——预览、PDF、Word 三端同一份字节。
// 字体：Word 端 Calibri + 微软雅黑；PDF 端 docx-preview 映射 font-family，
// Chromium 对缺失字体回退到系统苹方，CJK 不会开天窗。
const BODY_FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑', cs: 'Calibri' }
const HEADING_INK = '1F2329' // 墨色标题（GitHub ink；不再是 docx 库默认蓝）
const HEADING_HALF_BASE = [44, 32, 28, 24, 22, 22] // Heading1–6 半磅 @ 基准正文：22/16/14/12/11/11pt
// ── fontSize（export_document, 磅）── BODY_BASE_PT 是标题/代码比例的基准：
// 调用方传 fontSize 时全部按 fontSize / BODY_BASE_PT 缩放，四号（14pt）正文
// 不会大于自己的 Heading2。
const BODY_BASE_PT = 11
const CODE_HALF_BASE = 18 // code block + degradation note at the base body
// 行距：正文 1.5 倍，代码/表格 1.15 倍（markdowner 的 1.8 在打印件里太飘）。
// 正文行距/段距显式写在每个段落上（docx-preview 对 docDefaults 的段落部分
// 支持不完整），字号/颜色走 styles——两条渲染路径都确定。
const LINE_BODY = { line: 360, lineRule: LineRuleType.AUTO }
const LINE_TIGHT = { line: 276, lineRule: LineRuleType.AUTO }
// 列表阶梯：左缩进 480/960/1440、悬挂 240。替换掉两个出厂默认——有序编号
// 原本没有任何缩进定义（编号顶格、无悬挂），无序子弹是库默认 720/1440/2160
// 阶梯（嵌套子弹跳到一英寸外，视觉孤儿）。
const LIST_INDENTS = [480, 960, 1440]
const LIST_HANGING = 240
const BULLET_GLYPHS = ['•', '◦', '▪']
// 引用块：应用链接蓝（palette.ts LINK #1677ff）+ --pm-link-bg（8% 蓝）落白底的实色。
const BLOCKQUOTE_BORDER = { left: { style: BorderStyle.SINGLE, size: 24, color: '1677FF', space: 4 } }
const BLOCKQUOTE_FILL = 'ECF4FF'
const CODE_FILL = 'F5F5F5'
// 表格：0.5pt 浅灰细线（docx 库默认是 color=auto 的黑框）。
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'C9CBD1' } as const
const CELL_MARGIN = { top: 80, bottom: 80, left: 120, right: 120 }
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
type InlineChild = TextRun | ImageRun | ExternalHyperlink

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

/** decodeURI that keeps the raw href when it is not valid percent-encoding —
 *  a bare "%" ("img/50%.png") throws URIError, which must degrade the image
 *  to its placeholder, never crash the whole export. */
function decodeHref(href: string): string {
  try { return decodeURI(href) } catch { return href }
}

function inlineRuns(tokens: MarkedToken[] | undefined, degrade: Degradations, images: Map<string, Buffer> | undefined = undefined, bold = false): InlineChild[] {
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
        const href = decodeHref(String(token.raw ?? '').match(/\]\(\s*([^)\s]+)/)?.[1] ?? '')
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
        const href = decodeHref(String(token.raw ?? '').match(/!\[.*?\]\(\s*([^)\s]+)/)?.[1] ?? '').replace(/^['"]|['"]$/g, '')
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
        out.push(new Paragraph({ spacing: { after: 120, ...LINE_BODY }, children: inlineRuns(token.tokens, degrade, images) }))
        break
      case 'blockquote': {
        const quoted = token.tokens ?? []
        for (const [i, child] of quoted.entries()) {
          // The quote's own shape (缩进 + 左边框 + 浅蓝底) wraps each quoted
          // paragraph; a quoted table renders as itself — quoting a grid is
          // not a Word concept. 连续引用段之间零间距，底色才是一整块。
          if (child.type === 'table') {
            out.push(tableChild(child, degrade, images))
            continue
          }
          out.push(new Paragraph({
            indent: { left: 240 },
            border: BLOCKQUOTE_BORDER,
            shading: { type: ShadingType.CLEAR, fill: BLOCKQUOTE_FILL },
            spacing: { before: i === 0 ? 160 : 0, after: i === quoted.length - 1 ? 160 : 0, ...LINE_BODY },
            children: inlineRuns(child.tokens ?? [child], degrade, images),
          }))
        }
        break
      }
      case 'code': {
        const lines = String(token.text ?? '').split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        for (const [i, line] of lines.entries()) {
          // 灰底色块没有内边距概念——文字会贴着底色边缘。经典 OOXML 手法：
          // 每行画与底色同色的边框，w:space 撑出 padding（Word 会把底色填到
          // 边框为止，docx-preview 把 space 映射为 padding），行间边框同色
          // 相接不可见。首行补 top、末行补 bottom，四边 padding 就齐了。
          const pad = (space: number) => ({ style: BorderStyle.SINGLE, size: 8, color: CODE_FILL, space })
          out.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
            border: {
              left: pad(8),
              right: pad(8),
              ...(i === 0 ? { top: pad(4) } : {}),
              ...(i === lines.length - 1 ? { bottom: pad(4) } : {}),
            },
            spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0, ...LINE_TIGHT },
            children: [new TextRun({ text: line === '' ? ' ' : line, font: CODE_FONT, size: codeSize })],
          }))
        }
        break
      }
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CBD1', space: 1 } }, spacing: { before: 200, after: 200 } }))
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
    // 嵌套子表缓存在自己的缓冲里：父项自己的段落必须先于它落地，否则
    // 子项全部渲染到父项之前（文档顺序倒置）。
    const nested: Paragraph[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        nested.push(...listChildren(child, level + 1, degrade, images))
        continue
      }
      runs.push(...inlineRuns([child], degrade, images))
    }
    out.push(new Paragraph({
      // 缩进直接挂在段落上（Word 与 docx-preview 都以段落级 ind 为准），
      // 编号/子弹落在 left - hanging 处，正文对齐 left。
      indent: { left: LIST_INDENTS[capped], hanging: LIST_HANGING },
      spacing: { after: 80, ...LINE_BODY },
      ...(token.ordered
        ? { numbering: { reference: NUMBERING_REFERENCE, level: capped } }
        : { numbering: { reference: BULLET_REFERENCE, level: capped } }),
      children: runs,
    }))
    out.push(...nested)
  }
  return out
}

function tableChild(token: MarkedToken, degrade: Degradations, images: Map<string, Buffer> | undefined): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: (token.header ?? []).map((cell) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: 'F2F3F5' },
      margins: CELL_MARGIN,
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, ...LINE_TIGHT },
        children: inlineRuns(cell.tokens, degrade, images, true),
      })],
    })),
  })
  const bodyRows = (token.rows ?? []).map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      margins: CELL_MARGIN,
      children: [new Paragraph({
        spacing: { before: 0, after: 0, ...LINE_TIGHT },
        children: inlineRuns(cell.tokens, degrade, images),
      })],
    })),
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: TABLE_BORDER, bottom: TABLE_BORDER, left: TABLE_BORDER, right: TABLE_BORDER,
      insideHorizontal: TABLE_BORDER, insideVertical: TABLE_BORDER,
    },
    rows: [headerRow, ...bodyRows],
  })
}

/** href paths referenced by ![...](href) — workspace-relative or absolute,
 *  in document order (the service resolves + reads them, same discipline as the pptx generators). */
export function mdImagePaths(md: string): Array<{ href: string }> {
  const out: Array<{ href: string }> = []
  const seen = new Set<string>()
  const tokens = marked.lexer(md) as unknown as MarkedToken[]
  const visit = (list: MarkedToken[]): void => {
    for (const t of list) {
      if (t.type === 'image') {
        const href = decodeHref(String(t.raw ?? '').match(/!\[.*?\]\(\s*([^)\s]+)/)?.[1] ?? '').replace(/^['"]|['"]$/g, '')
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
 *  code block scale with it (BODY_BASE_PT). 样式部分无条件生成（字体栈/标题
 *  体系/编号定义就是文档设计的一部分），fontSize 只改尺寸——缩放因子 1 时
 *  输出即基准设计。 */
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
  const headingRun = (halfBase: number) => ({ bold: true, color: HEADING_INK, size: Math.round(halfBase * scale) })
  // H1/H2 带浅灰底线（markdowner 的 h1,h2 border-bottom）；keepNext 让标题
  // 不会孤悬在页底。样式对象是整体替换语义——run 必须把 bold/color/size 写全。
  const headingPara = (before: number, after: number, rule: boolean) => ({
    keepNext: true,
    keepLines: true,
    spacing: { before, after, ...LINE_BODY },
    ...(rule ? { border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E1E4E8', space: 4 } } } : {}),
  })
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: Math.round((fontSize ?? BODY_BASE_PT) * 2) } },
        heading1: { run: headingRun(HEADING_HALF_BASE[0]), paragraph: headingPara(400, 160, true) },
        heading2: { run: headingRun(HEADING_HALF_BASE[1]), paragraph: headingPara(360, 120, true) },
        heading3: { run: headingRun(HEADING_HALF_BASE[2]), paragraph: headingPara(280, 100, false) },
        heading4: { run: headingRun(HEADING_HALF_BASE[3]), paragraph: headingPara(240, 80, false) },
        heading5: { run: headingRun(HEADING_HALF_BASE[4]), paragraph: headingPara(240, 80, false) },
        heading6: { run: headingRun(HEADING_HALF_BASE[5]), paragraph: headingPara(240, 80, false) },
      },
    },
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
          })),
        },
        {
          reference: BULLET_REFERENCE,
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: BULLET_GLYPHS[level],
            alignment: AlignmentType.START,
          })),
        },
      ],
    },
    sections: [{ children }],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}
