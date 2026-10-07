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
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TableOfContents,
  TextRun,
  WidthType,
} from 'docx'
import { highlightToLines } from './docx-highlight'

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
// accent 主题（PLAN-docx-native-styles M1）只重着四处：引用块边框/底色、表头
// 底纹、H1/H2 底线——墨色标题与灰阶代码底是排版正确性，不属于主题。
interface DocxTheme {
  quoteBorder: string
  quoteFill: string
  headerFill: string
  ruleColor: string
}
const DEFAULT_THEME: DocxTheme = { quoteBorder: '1677FF', quoteFill: 'ECF4FF', headerFill: 'F2F3F5', ruleColor: 'E1E4E8' }
/** 色值按 alpha 叠白底：mixOverWhite('1677FF', 0.08) === 'ECF4FF'（--pm-link-bg 的合成式）。 */
function mixOverWhite(hex: string, alpha: number): string {
  const n = parseInt(hex, 16)
  const channel = (v: number): string =>
    Math.round(255 - (255 - v) * alpha)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return channel((n >> 16) & 0xff) + channel((n >> 8) & 0xff) + channel(n & 0xff)
}
function accentTheme(accent: string): DocxTheme {
  return {
    quoteBorder: accent,
    quoteFill: mixOverWhite(accent, 0.08),
    headerFill: mixOverWhite(accent, 0.06),
    ruleColor: mixOverWhite(accent, 0.25),
  }
}
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
  return tokens.map((t) => (t.tokens && t.tokens.length > 0 ? plainText(t.tokens) : (t.text ?? ''))).join('')
}

// ── frontmatter 文档级设计（PLAN-docx-native-styles M1）── markdown 头部的
// `---` 块承载封面/页眉页脚/目录/缩进/主题，键位表是 references/docx.md §一
// 的唯一权威。未知键与解析不了的值不静默忽略——进 issues，文末注点名（typo
// 静默失效比拒绝更糟，与降级注同一 honesty 纪律）。
export interface DocxFrontmatter {
  title?: string
  subtitle?: string
  author?: string
  date?: string
  toc?: boolean
  /** 1–3，默认 3（headingStyleRange 的深度）。 */
  tocDepth?: number
  header?: string
  footer?: 'page' | 'total' | 'off'
  indent?: boolean
  /** 6 位 RRGGBB 不带 #。 */
  accent?: string
}

export interface ParsedDocxFrontmatter {
  design: DocxFrontmatter
  /** 剥掉 frontmatter 与脚注定义行后的正文——lexer 只看它。 */
  body: string
  issues: string[]
}

const FOOTER_LEVELS = ['page', 'total', 'off'] as const

/** 解析 markdown 头部的 frontmatter 块。开闭栏都是行首 `---`，闭栏取**第一
 *  个**后续 `---` 行（lazy 匹配）——正文里更晚的分隔线不会被吞。 */
export function parseDocxFrontmatter(md: string): ParsedDocxFrontmatter {
  const open = /^\uFEFF?[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*---[ \t]*(?:\r?\n|$)/.exec(md)
  if (!open) return { design: {}, body: md, issues: [] }
  const design: DocxFrontmatter = {}
  const issues: string[] = []
  const unknown = new Set<string>()
  const parseBool = (raw: string): boolean | undefined => (raw === 'true' ? true : raw === 'false' ? false : undefined)
  for (const rawLine of open[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) {
      issues.push(`无法解析的行「${line}」`)
      continue
    }
    const key = kv[1].toLowerCase()
    const value = kv[2].trim().replace(/^["'](.*)["']$/, '$1')
    switch (key) {
      case 'title':
      case 'subtitle':
      case 'author':
      case 'date':
      case 'header':
        if (value) (design as Record<string, unknown>)[key] = value
        break
      case 'toc':
      case 'indent': {
        const b = parseBool(value)
        if (b === undefined) issues.push(`${key} 的值需是 true/false，收到「${value}」`)
        else design[key] = b
        break
      }
      case 'toc-depth': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 3) issues.push(`toc-depth 需是 1–3 的整数，收到「${value}」`)
        else design.tocDepth = n
        break
      }
      case 'footer':
        if ((FOOTER_LEVELS as readonly string[]).includes(value)) design.footer = value as DocxFrontmatter['footer']
        else issues.push(`footer 需是 ${FOOTER_LEVELS.join(' / ')} 之一，收到「${value}」`)
        break
      case 'accent':
        if (/^#?[0-9a-fA-F]{6}$/.test(value)) design.accent = value.replace('#', '').toUpperCase()
        else issues.push(`accent 需是 #RRGGBB，收到「${value}」`)
        break
      default:
        unknown.add(kv[1])
    }
  }
  if (unknown.size > 0) issues.push(`未识别的键 ${[...unknown].join('、')}`)
  return { design, body: md.slice(open[0].length), issues }
}

// ── 脚注（M8）── marked 没有脚注扩展：定义行（行首 `[^id]: 文字`）在 lexer
// 之前剥掉，行内引用 `[^id]` 留在 text token 里原样到达 inlineRuns，在那里
// 按这张表切分成 FootnoteReferenceRun。数字 id 按定义顺序分配——Word 的脚注
// 编号按引用在文中的位置自动排序，与 id 数值无关。
function scanFootnotes(body: string): { body: string; footnotes: Map<string, number>; texts: Map<string, string> } {
  const footnotes = new Map<string, number>()
  const texts = new Map<string, string>()
  if (!body.includes('[^')) return { body, footnotes, texts }
  const defRe = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/
  const kept: string[] = []
  for (const line of body.split('\n')) {
    const m = defRe.exec(line)
    if (m) {
      if (!texts.has(m[1])) texts.set(m[1], m[2])
      continue
    }
    kept.push(line)
  }
  let n = 1
  for (const [id] of texts) {
    footnotes.set(id, n)
    n++
  }
  return { body: kept.join('\n'), footnotes, texts }
}

/** decodeURI that keeps the raw href when it is not valid percent-encoding —
 *  a bare "%" ("img/50%.png") throws URIError, which must degrade the image
 *  to its placeholder, never crash the whole export. */
function decodeHref(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}

// ── 生成上下文：一次导出的全部环境，替代逐参数穿透 ──
interface GenCtx {
  degrade: Degradations
  images?: Map<string, Buffer>
  codeSize: number
  theme: DocxTheme
  /** 已定义脚注 id → 数字 id（M8）；缺省 = 全文无脚注。 */
  footnotes?: Map<string, number>
  /** 正文首行缩进（M6）：firstLineChars 固定 200 字符，firstLine 是字号回退 twips。 */
  indent?: { firstLineTwips: number }
  /** M9：```chart 围栏（文档序 index）→ 栅格化 PNG。缺项 = 服务层降级（无
   *  Chromium），围栏回落普通代码块 + 降级注。 */
  charts?: Map<number, Buffer>
}

/** 行内样式累积（M2 粗斜体组合）：strong/em/del 递归携带，叶子 run 落全部
 *  标志——取代旧的「只取最外层」拍平口径。仅在 true 时写键，无组合时序列化
 *  字节与旧实现一致。 */
interface InlineStyle {
  bold?: boolean
  italics?: boolean
  strike?: boolean
}

const styledRun = (text: string, style: InlineStyle): TextRun =>
  new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
  })

/** 行内文本按脚注引用切分（M8）：`[^id]` 命中已定义脚注 → 引用 run；未定义 →
 *  原文照旧 + 降级注（与图片占位同款 honesty）。无脚注文档零正则命中，序列化
 *  字节与旧实现一致。 */
function footnoteAwareRuns(text: string, ctx: GenCtx, style: InlineStyle): InlineChild[] {
  const out: InlineChild[] = []
  if (!ctx.footnotes) return [styledRun(text, style)]
  const re = /\[\^([^\]\s]+)\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const id = ctx.footnotes.get(m[1])
    if (m.index > last) out.push(styledRun(text.slice(last, m.index), style))
    if (id !== undefined) out.push(new FootnoteReferenceRun(id))
    else {
      ctx.degrade.add('未定义的脚注引用')
      out.push(styledRun(m[0], style))
    }
    last = m.index + m[0].length
  }
  if (last < text.length || out.length === 0) out.push(styledRun(text.slice(last), style))
  return out
}

function inlineRuns(tokens: MarkedToken[] | undefined, ctx: GenCtx, style: InlineStyle = {}): InlineChild[] {
  if (!tokens) return []
  const out: InlineChild[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.tokens && token.tokens.length > 0) out.push(...inlineRuns(token.tokens, ctx, style))
        else out.push(...footnoteAwareRuns(token.text ?? '', ctx, style))
        break
      case 'escape':
        out.push(...footnoteAwareRuns(token.text ?? '', ctx, style))
        break
      case 'br':
        out.push(new TextRun({ text: '', break: 1 }))
        break
      case 'strong':
        out.push(...inlineRuns(token.tokens, ctx, { ...style, bold: true }))
        break
      case 'em':
        out.push(...inlineRuns(token.tokens, ctx, { ...style, italics: true }))
        break
      case 'del':
        out.push(...inlineRuns(token.tokens, ctx, { ...style, strike: true }))
        break
      case 'codespan':
        out.push(
          new TextRun({
            text: token.text ?? '',
            font: CODE_FONT,
            shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' },
            ...(style.bold ? { bold: true } : {}),
            ...(style.italics ? { italics: true } : {}),
            ...(style.strike ? { strike: true } : {}),
          }),
        )
        break
      case 'link': {
        const href = decodeHref(String(token.raw ?? '').match(/\]\(\s*([^)\s]+)/)?.[1] ?? '')
        out.push(
          new ExternalHyperlink({
            link: href,
            children: [
              new TextRun({
                text: plainText(token.tokens),
                style: 'Hyperlink',
                ...(style.bold ? { bold: true } : {}),
                ...(style.italics ? { italics: true } : {}),
                ...(style.strike ? { strike: true } : {}),
              }),
            ],
          }),
        )
        break
      }
      case 'image': {
        // M2 (PLAN-office-expressiveness): a resolvable WORKSPACE href embeds
        // the real image; http(s)/data:/unreadable keeps today's degradation —
        // never silent, never fetched over the network.
        const href = decodeHref(String(token.raw ?? '').match(/!\[.*?\]\(\s*([^)\s]+)/)?.[1] ?? '').replace(/^['"]|['"]$/g, '')
        const buf = ctx.images?.get(href)
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
        ctx.degrade.add('图片')
        const alt = token.text || plainText(token.tokens) || '图片'
        out.push(new TextRun({ text: `[图片:${alt}，正文不支持]`, color: '808080' }))
        break
      }
      case 'html':
        ctx.degrade.add('HTML 片段')
        out.push(new TextRun({ text: token.raw ?? token.text ?? '' }))
        break
      default:
        out.push(new TextRun({ text: token.text ?? token.raw ?? '' }))
    }
  }
  return out
}

function blockChildren(tokens: MarkedToken[], ctx: GenCtx): DocxChild[] {
  const out: DocxChild[] = []
  let chartFenceIndex = 0
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const level = Math.min(Math.max(token.depth ?? 1, 1), 6)
        out.push(
          new Paragraph({
            heading: HEADING_LEVELS[level - 1],
            children: inlineRuns(token.tokens, ctx),
          }),
        )
        break
      }
      case 'paragraph':
        out.push(
          new Paragraph({
            spacing: { after: 120, ...LINE_BODY },
            ...(ctx.indent ? { indent: { firstLine: ctx.indent.firstLineTwips, firstLineChars: 200 } } : {}),
            children: inlineRuns(token.tokens, ctx),
          }),
        )
        break
      case 'blockquote': {
        const quoted = token.tokens ?? []
        for (const [i, child] of quoted.entries()) {
          // The quote's own shape (缩进 + 左边框 + 浅色底) wraps each quoted
          // paragraph; a quoted table renders as itself — quoting a grid is
          // not a Word concept. 连续引用段之间零间距，底色才是一整块。
          if (child.type === 'table') {
            out.push(tableChild(child, ctx))
            continue
          }
          out.push(
            new Paragraph({
              indent: { left: 240 },
              border: { left: { style: BorderStyle.SINGLE, size: 24, color: ctx.theme.quoteBorder, space: 4 } },
              shading: { type: ShadingType.CLEAR, fill: ctx.theme.quoteFill },
              spacing: { before: i === 0 ? 160 : 0, after: i === quoted.length - 1 ? 160 : 0, ...LINE_BODY },
              children: inlineRuns(child.tokens ?? [child], ctx),
            }),
          )
        }
        break
      }
      case 'code': {
        const text = String(token.text ?? '')
        const lines = text.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        const lang = (token.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        // M9：chart 围栏 → 服务层栅格化的 PNG（按文档序 index 对齐）。命中落
        // 居中图片；缺项（无 Chromium 降级）回落普通代码块 + 降级注——图表是
        // 增强，不是承重墙。
        if (lang === 'chart') {
          const png = ctx.charts?.get(chartFenceIndex++)
          if (png) {
            const dims = imageDims(png)
            const size = dims ? displaySize(dims) : { width: 600, height: 360 }
            out.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 120, after: 120, ...LINE_BODY },
                children: [new ImageRun({ type: 'png', data: png, transformation: { width: size.width, height: size.height } })],
              }),
            )
            break
          }
          ctx.degrade.add('图表（浏览器内核缺席，已按原数据呈现）')
        }
        // M7：声明了已注册语言 → 逐行着色段；行数与源行严格对齐才可用（高亮
        // 管线任何意外宁回纯文本，不出错版），未注册语言回落纯文本（与旧一致）。
        const highlighted = lang && lang !== 'chart' ? highlightToLines(text, lang) : null
        const colored = highlighted !== null && highlighted.length === lines.length ? highlighted : null
        for (const [i, line] of lines.entries()) {
          // 灰底色块没有内边距概念——文字会贴着底色边缘。经典 OOXML 手法：
          // 每行画与底色同色的边框，w:space 撑出 padding（Word 会把底色填到
          // 边框为止，docx-preview 把 space 映射为 padding），行间边框同色
          // 相接不可见。首行补 top、末行补 bottom，四边 padding 就齐了。
          const pad = (space: number) => ({ style: BorderStyle.SINGLE, size: 8, color: CODE_FILL, space })
          const runs: InlineChild[] = colored
            ? (colored[i].length > 0 ? colored[i] : [{ text: ' ' }]).map(
                (seg) =>
                  new TextRun({
                    text: seg.text === '' ? ' ' : seg.text,
                    font: CODE_FONT,
                    size: ctx.codeSize,
                    ...(seg.color ? { color: seg.color } : {}),
                  }),
              )
            : [new TextRun({ text: line === '' ? ' ' : line, font: CODE_FONT, size: ctx.codeSize })]
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
              border: {
                left: pad(8),
                right: pad(8),
                ...(i === 0 ? { top: pad(4) } : {}),
                ...(i === lines.length - 1 ? { bottom: pad(4) } : {}),
              },
              spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0, ...LINE_TIGHT },
              children: runs,
            }),
          )
        }
        break
      }
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CBD1', space: 1 } }, spacing: { before: 200, after: 200 } }))
        break
      case 'list':
        out.push(...listChildren(token, 0, ctx))
        break
      case 'table':
        out.push(tableChild(token, ctx))
        break
      case 'space':
        break
      default:
        ctx.degrade.add('数学公式等元素')
        out.push(new Paragraph({ children: [new TextRun({ text: token.raw ?? token.text ?? '' })] }))
    }
  }
  return out
}

function listChildren(token: MarkedToken, level: number, ctx: GenCtx): Paragraph[] {
  const capped = Math.min(level, 2) // 嵌套 ≤3 层（0..2），更深拍平到第三层
  const out: Paragraph[] = []
  for (const item of token.items ?? []) {
    const runs: InlineChild[] = []
    // 嵌套子表缓存在自己的缓冲里：父项自己的段落必须先于它落地，否则
    // 子项全部渲染到父项之前（文档顺序倒置）。
    const nested: Paragraph[] = []
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        nested.push(...listChildren(child, level + 1, ctx))
        continue
      }
      runs.push(...inlineRuns([child], ctx))
    }
    out.push(
      new Paragraph({
        // 缩进直接挂在段落上（Word 与 docx-preview 都以段落级 ind 为准），
        // 编号/子弹落在 left - hanging 处，正文对齐 left。
        indent: { left: LIST_INDENTS[capped], hanging: LIST_HANGING },
        spacing: { after: 80, ...LINE_BODY },
        ...(token.ordered ? { numbering: { reference: NUMBERING_REFERENCE, level: capped } } : { numbering: { reference: BULLET_REFERENCE, level: capped } }),
        children: runs,
      }),
    )
    out.push(...nested)
  }
  return out
}

function tableChild(token: MarkedToken, ctx: GenCtx): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: (token.header ?? []).map(
      (cell) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: ctx.theme.headerFill },
          margins: CELL_MARGIN,
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 0, after: 0, ...LINE_TIGHT },
              children: inlineRuns(cell.tokens, ctx, { bold: true }),
            }),
          ],
        }),
    ),
  })
  const bodyRows = (token.rows ?? []).map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              margins: CELL_MARGIN,
              children: [
                new Paragraph({
                  spacing: { before: 0, after: 0, ...LINE_TIGHT },
                  children: inlineRuns(cell.tokens, ctx),
                }),
              ],
            }),
        ),
      }),
  )
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: TABLE_BORDER,
      bottom: TABLE_BORDER,
      left: TABLE_BORDER,
      right: TABLE_BORDER,
      insideHorizontal: TABLE_BORDER,
      insideVertical: TABLE_BORDER,
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
        if (href && !seen.has(href)) {
          seen.add(href)
          out.push({ href })
        }
      }
      if (t.tokens) visit(t.tokens as unknown as MarkedToken[])
    }
  }
  visit(tokens)
  return out
}

/** 封面页（M3）：固定高度空段做顶部留白（EXACT 行高在 Word 与 docx-preview
 *  都是确定值；Word 对页首段落的 space-before 会吞掉，不能靠 spacing.before），
 *  标题居中 + 副标题 + 作者/日期。物料缺哪个就少哪段。 */
function coverParagraphs(design: DocxFrontmatter, scale: number): Paragraph[] {
  const out: Paragraph[] = []
  out.push(new Paragraph({ spacing: { before: 0, after: 0, line: 3200, lineRule: LineRuleType.EXACT }, children: [] }))
  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: design.subtitle ? 240 : 160, ...LINE_TIGHT },
      children: [new TextRun({ text: design.title ?? '', bold: true, color: HEADING_INK, size: Math.round(72 * scale) })],
    }),
  )
  if (design.subtitle) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 0, ...LINE_TIGHT },
        children: [new TextRun({ text: design.subtitle, color: '595959', size: Math.round(28 * scale) })],
      }),
    )
  }
  if (design.author) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 2000, after: design.date ? 80 : 0, ...LINE_BODY },
        children: [new TextRun({ text: design.author, color: '595959', size: Math.round(24 * scale) })],
      }),
    )
  }
  if (design.date) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: design.author ? 0 : 2000, after: 0, ...LINE_BODY },
        children: [new TextRun({ text: design.date, color: '595959', size: Math.round(24 * scale) })],
      }),
    )
  }
  return out
}

/** Markdown string → a real .docx buffer. `images` maps workspace hrefs to
 *  resolved bytes (M2): a hit embeds the real image, a miss keeps the
 *  degradation placeholder — the resolver decides, never the network.
 *  `options.fontSize` (磅) sets the document-wide body size; headings and the
 *  code block scale with it (BODY_BASE_PT). 样式部分无条件生成（字体栈/标题
 *  体系/编号定义就是文档设计的一部分），fontSize 只改尺寸——缩放因子 1 时
 *  输出即基准设计。frontmatter（PLAN-docx-native-styles）在 lexer 之前剥出
 *  文档级设计；无 frontmatter 的输入逐字节走旧形状（单一 section、无页眉页
 *  脚部件、无 updateFields）。 */
export async function markdownToDocxBuffer(md: string, images?: Map<string, Buffer>, options?: { fontSize?: number; charts?: Map<number, Buffer> }): Promise<Buffer> {
  const fontSize = options?.fontSize
  const scale = fontSize !== undefined ? fontSize / BODY_BASE_PT : 1
  const codeSize = Math.round(CODE_HALF_BASE * scale)
  const { design, body, issues } = parseDocxFrontmatter(md)
  const scanned = scanFootnotes(body)
  const tokens = marked.lexer(scanned.body) as unknown as MarkedToken[]
  const degrade = new Degradations(codeSize)
  // 封面承载 title 后，正文第一个同文 H1 不再重复渲染（双标题去重）。正文
  // 允许以空行开头——首个非 space token 才是候选。
  let bodyTokens = tokens
  const firstContent = tokens.findIndex((t) => t.type !== 'space')
  const first = firstContent >= 0 ? tokens[firstContent] : undefined
  if (design.title && first?.type === 'heading' && (first.depth ?? 1) === 1 && plainText(first.tokens) === design.title) {
    bodyTokens = tokens.filter((_, i) => i !== firstContent)
  }
  const ctx: GenCtx = {
    degrade,
    images,
    codeSize,
    theme: design.accent ? accentTheme(design.accent) : DEFAULT_THEME,
    ...(scanned.footnotes.size > 0 ? { footnotes: scanned.footnotes } : {}),
    ...(design.indent ? { indent: { firstLineTwips: Math.round(2 * (fontSize ?? BODY_BASE_PT) * 20) } } : {}),
    ...(options?.charts && options.charts.size > 0 ? { charts: options.charts } : {}),
  }
  const children = blockChildren(bodyTokens, ctx)
  const note = degrade.note()
  if (note) children.push(note)
  if (issues.length > 0) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [new TextRun({ text: `注：frontmatter ${issues.join('；')}——已忽略对应项。`, italics: true, color: '808080', size: codeSize })],
      }),
    )
  }
  const headingRun = (halfBase: number) => ({ bold: true, color: HEADING_INK, size: Math.round(halfBase * scale) })
  // H1/H2 带浅色底线（markdowner 的 h1,h2 border-bottom）；keepNext 让标题
  // 不会孤悬在页底。样式对象是整体替换语义——run 必须把 bold/color/size 写全。
  const headingPara = (before: number, after: number, rule: boolean) => ({
    keepNext: true,
    keepLines: true,
    spacing: { before, after, ...LINE_BODY },
    ...(rule ? { border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ctx.theme.ruleColor, space: 4 } } } : {}),
  })
  // ── 目录（M5）──「目录」标签不用 Heading 样式（否则出现在自己的目录里）；
  // cachedEntries 用自产标题构建，docx-preview（预览与 PDF 同引擎）对空域不
  // 渲染内容，静态条目让预览立即可见；updateFields 让 Word/WPS 打开时刷新页
  // 码——缓存条目没有页码，页码以打开端更新域后为准（双源契约，references 有载）。
  const tocChildren: DocxChild[] = []
  if (design.toc) {
    const depth = Math.min(Math.max(design.tocDepth ?? 3, 1), 3)
    const cachedEntries = bodyTokens
      .filter((t) => t.type === 'heading' && (t.depth ?? 1) <= depth)
      .map((t) => ({ title: plainText(t.tokens), level: Math.min(Math.max(t.depth ?? 1, 1), 6) }))
    tocChildren.push(
      new Paragraph({
        spacing: { after: 240, ...LINE_BODY },
        children: [new TextRun({ text: '目录', bold: true, color: HEADING_INK, size: Math.round(32 * scale) })],
      }),
      new TableOfContents('目录', {
        hyperlink: true,
        headingStyleRange: `1-${depth}`,
        ...(cachedEntries.length > 0 ? { cachedEntries } : {}),
      }),
      new Paragraph({ children: [new PageBreak()] }),
    )
  }
  const bodyChildren: DocxChild[] = [...tocChildren, ...children]
  // ── 封面与分节（M3/M4）──单 section + titlePg（首页不同）+ 封面尾显式分页
  // 符，刻意不用双 section：docx-preview 只在页宽高/方向变化或显式分页符处翻
  // 页，同尺寸 section 边界是连续流（probe 实测封面与目录同页），而「双
  // section + 显式分页符」又会在 Word 里多出一页空白——两条渲染引擎只有这套
  // 组合都对齐。titlePg 让封面页不吃 default 页眉页脚（无 first 引用即空白），
  // 代价是页码从封面起计（正文从第 2 页起），即 Word 内置封面页的标准行为。
  const cover = design.title ? coverParagraphs(design, scale) : null
  const frontChildren: DocxChild[] = cover ? [...cover, new Paragraph({ children: [new PageBreak()] })] : []
  // ── 页眉/页脚/页码（M4）──页码域挂 default 部件，封面页由 titlePg 豁免。
  const headers = design.header
    ? {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0 },
              children: [new TextRun({ text: design.header, color: '808080', size: 18 })],
            }),
          ],
        }),
      }
    : undefined
  const footers =
    design.footer === 'page' || design.footer === 'total'
      ? {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
                children: [
                  new TextRun({ text: '第 ', color: '808080', size: 18 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: '808080', size: 18 }),
                  ...(design.footer === 'total'
                    ? [
                        new TextRun({ text: ' 页 共 ', color: '808080', size: 18 }),
                        new TextRun({ children: [PageNumber.TOTAL_PAGES_IN_SECTION], color: '808080', size: 18 }),
                        new TextRun({ text: ' 页', color: '808080', size: 18 }),
                      ]
                    : [new TextRun({ text: ' 页', color: '808080', size: 18 })]),
                ],
              }),
            ],
          }),
        }
      : undefined
  const section: {
    children: DocxChild[]
    headers?: { default: Header; first?: Header }
    footers?: { default: Footer; first?: Footer }
    properties?: { titlePage: boolean }
  } = { children: [...frontChildren, ...bodyChildren] }
  // titlePg 的双引擎对齐：真 Word 对「titlePg + 只有 default 引用」让首页空白，
  // docx-preview 却回落到 default（封面照挂页眉页脚）。显式给一个空的 first 部
  // 件后两侧一致——Word 用它（空白），docx-preview 命中 first 不再回落。
  if (headers) section.headers = cover ? { default: headers.default, first: new Header({ children: [new Paragraph({ children: [] })] }) } : headers
  if (footers) section.footers = cover ? { default: footers.default, first: new Footer({ children: [new Paragraph({ children: [] })] }) } : footers
  if (cover) section.properties = { titlePage: true }
  const doc = new Document({
    ...(design.toc ? { features: { updateFields: true } } : {}),
    ...(scanned.footnotes.size > 0
      ? {
          footnotes: Object.fromEntries(
            [...scanned.footnotes.entries()].map(([id, num]) => [
              String(num),
              {
                children: [
                  new Paragraph({
                    spacing: { after: 60, ...LINE_TIGHT },
                    children: [new TextRun({ text: scanned.texts.get(id) ?? '' })],
                  }),
                ],
              },
            ]),
          ),
        }
      : {}),
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
    sections: [section],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}
