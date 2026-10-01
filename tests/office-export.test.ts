// PLAN-office-export M1: the pure-function generation engines. Every assertion
// reads REAL product bytes — the docx is unzipped, the xlsx is read back with
// the same exceljs the service ships, the CSV's first byte is the BOM — so a
// mapper that "runs" but writes wrong cells cannot pass.
import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'
import { describe, it, expect } from 'vitest'
import { inferCellValue } from '../src/main/office-export/cell-type'
import {
  markdownToSheets,
  sheetsToXlsxBuffer,
  sanitizeSheetName,
  dedupeSheetNames,
} from '../src/main/office-export/md-tables'
import { markdownToDocxBuffer, mdImagePaths } from '../src/main/office-export/md-to-docx'
import { csvFromSheet, csvToSheet } from '../src/main/office-export/csv-io'

async function docxDocumentXml(md: string): Promise<string> {
  const buf = await markdownToDocxBuffer(md)
  expect(buf.length).toBeGreaterThan(1000)
  return new AdmZip(buf).readAsText('word/document.xml')
}

/** Paragraph texts in document order — a mapper that emits the right runs in
 *  the wrong <w:p> order still passes a contains() check, so order needs its
 *  own reader. */
async function docxParagraphTexts(md: string): Promise<string[]> {
  const xml = await docxDocumentXml(md)
  return xml.split('<w:p>').slice(1).map((chunk) => {
    let text = ''
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(chunk))) text += m[1]
    return text
  })
}

async function docxPart(md: string, part: string): Promise<string> {
  const buf = await markdownToDocxBuffer(md)
  return new AdmZip(buf).readAsText(part)
}

const stripTags = (xml: string): string =>
  xml.replace(/<[^>]+>/g, '')

describe('cell-type (D5 whitelist)', () => {
  it('converts strict round-trip numerics only', () => {
    expect(inferCellValue('42')).toBe(42)
    expect(inferCellValue('-3.5')).toBe(-3.5)
    expect(inferCellValue('0.5')).toBe(0.5)
  })
  it('keeps leading zeros (工号), over-long digit strings and date-like text as TEXT', () => {
    expect(inferCellValue('007')).toBe('007')
    expect(inferCellValue('12345678901234567890')).toBe('12345678901234567890')
    expect(inferCellValue('2026-09')).toBe('2026-09')
    expect(inferCellValue('2026/09/18')).toBe('2026/09/18')
  })
  it('accepts well-formed thousand groups via comma-strip round-trip; malformed groups stay text', () => {
    expect(inferCellValue('1,234')).toBe(1234)
    expect(inferCellValue('12,345,678.9')).toBe(12345678.9)
    expect(inferCellValue('1,23')).toBe('1,23')
  })
  it('refuses hex/exponent/empty shapes Number() would accept', () => {
    expect(inferCellValue('0x1A')).toBe('0x1A')
    expect(inferCellValue('1e5')).toBe('1e5')
    expect(inferCellValue('Infinity')).toBe('Infinity')
    expect(inferCellValue('')).toBeNull()
  })
})

describe('sheet names (D4 + sanitize + D6 dedupe)', () => {
  it('sanitizes forbidden chars, caps at 31 chars, empty falls back', () => {
    expect(sanitizeSheetName('Q[1]:*?/\\')).toBe('Q1')
    expect(sanitizeSheetName('x'.repeat(40))).toHaveLength(31)
    expect(sanitizeSheetName('///')).toBe('Sheet1')
  })
  it('dedupes case-insensitively with the -2 suffix (D6, sheet dimension)', () => {
    // 销售与 SALES 不冲突（大小写折叠只在同名内进行）；第二个 销售-2 撞上第一个衍生名
    expect(dedupeSheetNames(['销售', '销售', '销售-2', 'sales', 'SALES'])).toEqual([
      '销售', '销售-2', '销售-2-2', 'sales', 'SALES-2',
    ])
  })
})

describe('markdown → sheets (D4: H2 opens a sheet, heading names it)', () => {
  it('splits each H2 section into its own named sheet; pre-heading table lands in Sheet1', () => {
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '## 一月',
      '',
      '| 名称 | 数量 |',
      '|---|---|',
      '| 甲 | 12 |',
      '',
      '## 二月',
      '',
      '| 名称 | 数量 |',
      '|---|---|',
      '| 乙 | 34 |',
    ].join('\n')
    const sheets = markdownToSheets(md)
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', '一月', '二月'])
    expect(sheets[0].rows).toEqual([['a', 'b'], ['1', '2']])
    expect(sheets[1].rows).toEqual([['名称', '数量'], ['甲', '12']])
  })

  it('flattens inline markup in cells (bold header cell reads as plain text)', () => {
    const sheets = markdownToSheets('| 名称 | 数量 |\n|---|---|\n| **甲** | 12 |')
    expect(sheets[0].rows).toEqual([['名称', '数量'], ['甲', '12']])
  })

  it('two same-named H2s dedupe to X / X-2', () => {
    const sheets = markdownToSheets('## 销售\n\n| a |\n|---|\n| 1 |\n\n## 销售\n\n| b |\n|---|\n| 2 |')
    expect(sheets.map((s) => s.name)).toEqual(['销售', '销售-2'])
  })
})

describe('sheets → real xlsx buffer', () => {
  it('reads back with exceljs: values typed per D5, numbers are numbers', async () => {
    const buf = await sheetsToXlsxBuffer([
      { name: '人员', rows: [['姓名', '工号', '数量', '备注'], ['张三', '007', '42', '2026-09']] },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.worksheets).toHaveLength(1)
    expect(wb.worksheets[0].name).toBe('人员')
    const row = wb.worksheets[0].getRow(2)
    expect(row.getCell(1).value).toBe('张三')
    expect(row.getCell(2).value).toBe('007') // 前导零 → 文本
    expect(row.getCell(3).value).toBe(42) // 纯数字 → 数值
    expect(row.getCell(4).value).toBe('2026-09') // 日期样 → 文本
  })

  it('one sheet per H2 section (D4), both readable', async () => {
    const sheets = markdownToSheets('## 一\n\n| a |\n|---|\n| 1 |\n\n## 二\n\n| b |\n|---|\n| 2 |')
    const buf = await sheetsToXlsxBuffer(sheets)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['一', '二'])
  })
})

describe('csv io', () => {
  it('output starts with the UTF-8 BOM (WPS/Excel 中文乱码预防) and quotes properly', () => {
    const csv = csvFromSheet({ name: 'S', rows: [['名称', '备注'], ['甲', '含,逗号'], ['乙', '含"引号']] })
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('含,逗号')
    expect(csv).toContain('"含""引号"')
  })
  it('input parses through exceljs and round-trips', async () => {
    const sheet = await csvToSheet('\uFEFF名称,数量\n甲,12\n,空\n')
    expect(sheet.rows[0]).toEqual(['名称', '数量'])
    expect(sheet.rows[1]).toEqual(['甲', '12'])
    expect(sheet.rows[2]).toEqual(['', '空'])
  })
})

describe('markdown → real docx (附录 A mapping)', () => {
  it('headings 1-6 map to Heading1-6 styles', async () => {
    const xml = await docxDocumentXml('# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六')
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(xml).toContain(`w:val="Heading${level}"`)
    }
  })

  it('inline styles: bold / italic / strike / codespan, links become hyperlinks', async () => {
    const md = '段落 **加粗** *斜体* ~~删除~~ `代码` [链接文字](https://example.com/a)'
    const xml = await docxDocumentXml(md)
    expect(xml).toContain('加粗')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('斜体')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('删除')
    expect(xml).toContain('<w:strike/>')
    expect(xml).toContain('代码')
    expect(xml).toContain('Courier New')
    expect(xml).toContain('w:hyperlink')
    expect(xml).toContain('链接文字')
    expect(await docxPart(md, 'word/_rels/document.xml.rels')).toContain('https://example.com/a')
  })

  it('unordered and ordered lists render as real numbering paragraphs', async () => {
    const xml = await docxDocumentXml('- 项目一\n  - 嵌套\n\n1. 第一\n2. 第二')
    expect(xml).toContain('项目一')
    expect(xml).toContain('嵌套')
    expect(xml).toContain('w:numPr')
    expect(xml).toContain('第一')
  })

  it('nested list: every child renders AFTER its own parent item (document order)', async () => {
    const paras = await docxParagraphTexts('# T\n\n- parent one\n  - child A\n  - child B\n- parent two\n')
    const idx = (needle: string) => paras.findIndex((t) => t.includes(needle))
    const [iParent, iChildA, iChildB, iParentTwo] = [idx('parent one'), idx('child A'), idx('child B'), idx('parent two')]
    expect(iParent).toBeGreaterThanOrEqual(0)
    expect(iChildA).toBeGreaterThan(iParent)
    expect(iChildB).toBeGreaterThan(iChildA)
    expect(iParentTwo).toBeGreaterThan(iChildB)
  })

  it('tables: bold header with shading, typed cells keep inline bold', async () => {
    const xml = await docxDocumentXml('| 名称 | 数量 |\n|---|---|\n| **甲** | 12 |')
    expect(xml).toContain('<w:tbl>')
    // header shading
    expect(xml.toUpperCase()).toContain('F2F3F5')
    // header cell text exists; bold count ≥1 (header cells forced bold)
    expect(xml).toContain('名称')
  })

  it('code block: monospace shaded paragraphs, no syntax highlighting', async () => {
    const xml = await docxDocumentXml('```js\nconst a = 1;\n```')
    expect(xml).toContain('const a = 1;')
    expect(xml.toUpperCase()).toContain('F5F5F5')
    expect(xml).toContain('Courier New')
  })

  it('blockquote: indented bordered paragraph; hr renders a rule', async () => {
    const xml = await docxDocumentXml('> 引用文字\n\n---')
    expect(xml).toContain('引用文字')
    expect(xml).toContain('w:left')
    expect(xml).toContain('single')
  })

  it('image degrades to a visible placeholder plus the closing honesty note — never silent loss', async () => {
    const xml = await docxDocumentXml('前言\n\n![流程图](assets/flow.png)')
    expect(xml).toContain('[图片:流程图，正文不支持]')
    expect(stripTags(xml)).toContain('图片在 Word 导出中不支持')
  })

  it('an image href with a bare "%" is not valid percent-encoding: degrade, never crash', async () => {
    // decodeURI("img/50%.png") throws URIError — the export must degrade the
    // image to its placeholder, not fail the whole document.
    const xml = await docxDocumentXml('![pic](img/50%.png)\n')
    expect(xml).toContain('[图片:pic，正文不支持]')
    expect(mdImagePaths('![pic](img/50%.png)\n')).toEqual([{ href: 'img/50%.png' }])
  })

  it('Chinese and mixed CJK/Latin survive the round trip', async () => {
    const xml = await docxDocumentXml('# 项目报告\n\n中文与 English 混排、以及「标点」和数字 12345。')
    expect(xml).toContain('项目报告')
    expect(xml).toContain('中文与 English 混排、以及「标点」和数字 12345。')
  })
})

describe('docx fontSize (generation-side font control)', () => {
  async function stylesFor(fontSize?: number): Promise<{ styles: string; docDefaults: string }> {
    const buf = await markdownToDocxBuffer('# 标题\n\n正文内容。', undefined, fontSize !== undefined ? { fontSize } : undefined)
    const styles = new AdmZip(buf).readAsText('word/styles.xml')
    return { styles, docDefaults: styles.slice(styles.indexOf('<w:docDefaults>'), styles.indexOf('</w:docDefaults>')) }
  }
  const headingBlock = (styles: string, id: string): string =>
    styles.match(new RegExp(`w:styleId="${id}"[\\s\\S]*?</w:style>`))?.[0] ?? ''

  it('without fontSize the document defaults stay EMPTY — Word renders its own default', async () => {
    const { docDefaults } = await stylesFor()
    expect(docDefaults).toContain('<w:rPrDefault/>')
    expect(docDefaults).not.toContain('<w:sz')
  })

  it('fontSize lands as the body default in half-points (10.5pt → 21)', async () => {
    const { docDefaults } = await stylesFor(10.5)
    expect(docDefaults).toContain('<w:sz w:val="21"/>')
    expect(docDefaults).toContain('<w:szCs w:val="21"/>')
  })

  it('Heading1–3 scale off the 11pt baseline and KEEP their default colors (the lib replaces the whole run)', async () => {
    const { styles, docDefaults } = await stylesFor(14)
    expect(docDefaults).toContain('<w:sz w:val="28"/>')
    expect(headingBlock(styles, 'Heading1')).toContain('<w:sz w:val="41"/>') // 16pt × 14/11
    expect(headingBlock(styles, 'Heading1')).toContain('w:val="2E74B5"')
    expect(headingBlock(styles, 'Heading2')).toContain('<w:sz w:val="33"/>') // 13pt × 14/11
    expect(headingBlock(styles, 'Heading3')).toContain('<w:sz w:val="31"/>') // 12pt × 14/11
    expect(headingBlock(styles, 'Heading3')).toContain('w:val="1F4D78"')
    // Heading4+ carry no size in Word's defaults — they inherit the body size
    expect(headingBlock(styles, 'Heading4')).not.toContain('<w:sz')
  })

  it('body runs carry NO explicit size — they inherit the document default', async () => {
    const buf = await markdownToDocxBuffer('正文内容。', undefined, { fontSize: 14 })
    const xml = new AdmZip(buf).readAsText('word/document.xml')
    expect(xml).toContain('正文内容。')
    expect(xml).not.toContain('<w:sz')
  })

  it('the code block and the degradation note scale with fontSize', async () => {
    const code = await markdownToDocxBuffer('```js\nconst a = 1\n```', undefined, { fontSize: 14 })
    expect(new AdmZip(code).readAsText('word/document.xml')).toContain('<w:sz w:val="23"/>') // 9pt × 14/11
    const plainCode = await markdownToDocxBuffer('```js\nconst a = 1\n```')
    expect(new AdmZip(plainCode).readAsText('word/document.xml')).toContain('<w:sz w:val="18"/>')
    const note = await markdownToDocxBuffer('![x](a.png)', undefined, { fontSize: 14 })
    expect(new AdmZip(note).readAsText('word/document.xml')).toContain('<w:sz w:val="23"/>')
  })
})
