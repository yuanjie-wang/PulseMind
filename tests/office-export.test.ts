// PLAN-office-export M1: the pure-function generation engines. Every assertion
// reads REAL product bytes — the docx is unzipped, the xlsx is read back with
// the same exceljs the service ships, the CSV's first byte is the BOM — so a
// mapper that "runs" but writes wrong cells cannot pass.
import AdmZip from 'adm-zip'
import ExcelJS from 'exceljs'
import { describe, it, expect } from 'vitest'
import { inferCellValue } from '../src/main/office-export/cell-type'
import { markdownToSheets, sheetsToXlsxBuffer, sanitizeSheetName, dedupeSheetNames } from '../src/main/office-export/md-tables'
import { markdownToDocxBuffer, mdImagePaths, parseDocxFrontmatter } from '../src/main/office-export/md-to-docx'
import { chartToSvg, mdChartSpecs } from '../src/main/office-export/docx-charts'
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
  return xml
    .split('<w:p>')
    .slice(1)
    .map((chunk) => {
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

const stripTags = (xml: string): string => xml.replace(/<[^>]+>/g, '')

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
    expect(dedupeSheetNames(['销售', '销售', '销售-2', 'sales', 'SALES'])).toEqual(['销售', '销售-2', '销售-2-2', 'sales', 'SALES-2'])
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
    expect(sheets[0].rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(sheets[1].rows).toEqual([
      ['名称', '数量'],
      ['甲', '12'],
    ])
  })

  it('flattens inline markup in cells (bold header cell reads as plain text)', () => {
    const sheets = markdownToSheets('| 名称 | 数量 |\n|---|---|\n| **甲** | 12 |')
    expect(sheets[0].rows).toEqual([
      ['名称', '数量'],
      ['甲', '12'],
    ])
  })

  it('two same-named H2s dedupe to X / X-2', () => {
    const sheets = markdownToSheets('## 销售\n\n| a |\n|---|\n| 1 |\n\n## 销售\n\n| b |\n|---|\n| 2 |')
    expect(sheets.map((s) => s.name)).toEqual(['销售', '销售-2'])
  })
})

describe('sheets → real xlsx buffer', () => {
  it('reads back with exceljs: values typed per D5, numbers are numbers', async () => {
    const buf = await sheetsToXlsxBuffer([
      {
        name: '人员',
        rows: [
          ['姓名', '工号', '数量', '备注'],
          ['张三', '007', '42', '2026-09'],
        ],
      },
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
    const csv = csvFromSheet({
      name: 'S',
      rows: [
        ['名称', '备注'],
        ['甲', '含,逗号'],
        ['乙', '含"引号'],
      ],
    })
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

  it('code block: monospace shaded paragraphs; registered languages get oneLight syntax runs', async () => {
    const xml = await docxDocumentXml('```js\nconst a = 1;\n```')
    expect(stripTags(xml)).toContain('const a = 1;')
    expect(xml.toUpperCase()).toContain('F5F5F5')
    expect(xml).toContain('Courier New')
    expect(xml).toContain('A626A4') // keyword 紫色（oneLight，与聊天侧 Prism 同源）
    expect(xml).toContain('986801') // number 橙色
  })

  it('unregistered language falls back to plain monospace (no run colors)', async () => {
    const xml = await docxDocumentXml('```octave\nA = 1\n```')
    expect(stripTags(xml)).toContain('A = 1')
    expect(xml).not.toContain('<w:color') // run 级零着色（边框的 w:color 属性不算）
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
  const headingBlock = (styles: string, id: string): string => styles.match(new RegExp(`w:styleId="${id}"[\\s\\S]*?</w:style>`))?.[0] ?? ''

  it('the document defaults always carry the design: font stack + 11pt base body', async () => {
    const { docDefaults } = await stylesFor()
    expect(docDefaults).toContain('Calibri')
    expect(docDefaults).toContain('微软雅黑')
    expect(docDefaults).toContain('<w:sz w:val="22"/>') // BODY_BASE_PT pinned explicitly, not Word's ambient default
  })

  it('fontSize lands as the body default in half-points (10.5pt → 21)', async () => {
    const { docDefaults } = await stylesFor(10.5)
    expect(docDefaults).toContain('<w:sz w:val="21"/>')
    expect(docDefaults).toContain('<w:szCs w:val="21"/>')
  })

  it('Heading1–6 scale off the 11pt baseline in the near-black ink (the lib replaces the whole run)', async () => {
    const { styles } = await stylesFor(14)
    expect(headingBlock(styles, 'Heading1')).toContain('<w:sz w:val="56"/>') // 22pt × 14/11
    expect(headingBlock(styles, 'Heading1')).toContain('w:val="1F2329"')
    expect(headingBlock(styles, 'Heading1')).toContain('<w:b/>')
    expect(headingBlock(styles, 'Heading2')).toContain('<w:sz w:val="41"/>') // 16pt × 14/11
    expect(headingBlock(styles, 'Heading3')).toContain('<w:sz w:val="36"/>') // 14pt × 14/11
    expect(headingBlock(styles, 'Heading4')).toContain('<w:sz w:val="31"/>') // 12pt × 14/11
    // H1/H2 carry the light bottom rule; H3+ do not
    expect(headingBlock(styles, 'Heading1')).toContain('w:pBdr')
    expect(headingBlock(styles, 'Heading2')).toContain('w:pBdr')
    expect(headingBlock(styles, 'Heading3')).not.toContain('w:pBdr')
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

describe('docx style system (2026-10-01: markdowner export-CSS ported into OOXML)', () => {
  it('lists ride the custom ladder — paragraph indents replace the lib defaults (orphan nested bullets)', async () => {
    const md = '- 项目一\n  - 嵌套\n\n1. 第一\n2. 第二'
    const xml = await docxDocumentXml(md)
    // bullet at 240→text 480; the nested level at 720→960 (the old lib default
    // jumped nested bullets to 1440+ with the ordered parent at 0)
    expect(xml).toContain('<w:ind w:left="480" w:hanging="240"/>')
    expect(xml).toContain('<w:ind w:left="960" w:hanging="240"/>')
    const numbering = await docxPart(md, 'word/numbering.xml')
    expect(numbering).toContain('w:val="bullet"')
    expect(numbering).toContain('w:val="•"')
    expect(numbering).toContain('w:val="◦"')
    expect(numbering).toContain('w:val="▪"')
    expect(numbering).toContain('w:val="decimal"')
    expect(numbering).toContain('w:val="%1."')
  })

  it('tables: light-grey hairline grid (no black auto borders), roomier padding, centered header', async () => {
    const xml = await docxDocumentXml('| 名称 | 数量 |\n|---|---|\n| **甲** | 12 |')
    expect(xml.toUpperCase()).toContain('C9CBD1')
    expect(xml).not.toContain('w:color="auto"')
    // cell margins land per-cell (w:tcMar 80/120), not as a table-level default
    expect(xml).toContain('<w:tcMar>')
    expect(xml).toContain('<w:jc w:val="center"/>')
  })

  it('blockquote: app-link-blue left bar over the link-bg wash', async () => {
    const xml = await docxDocumentXml('> 引用文字')
    expect(xml).toContain('w:color="1677FF"')
    expect(xml.toUpperCase()).toContain('ECF4FF')
  })

  it('code block: fill-coloured border box supplies the padding the shading lacks', async () => {
    const xml = await docxDocumentXml('```js\nconst a = 1;\n```')
    expect(xml.toUpperCase()).toContain('F5F5F5')
    // the padding hack: paragraph borders painted in the fill colour
    expect(xml).toContain('w:pBdr')
    expect(xml.toUpperCase()).toContain('W:COLOR="F5F5F5"')
  })

  it('body paragraphs carry the 1.5× line rhythm and a 6pt after-gap', async () => {
    const xml = await docxDocumentXml('正文内容。')
    expect(xml).toContain('w:line="360"')
    expect(xml).toContain('w:after="120"')
  })
})

describe('docx frontmatter design (PLAN-docx-native-styles)', () => {
  const countOf = (needle: string, hay: string): number => hay.split(needle).length - 1

  it('plain md passes through parseDocxFrontmatter untouched (byte-identity substrate)', () => {
    const md = '# 标题\n\n正文。内容里有 --- 分隔线。\n'
    expect(parseDocxFrontmatter(md)).toEqual({ design: {}, body: md, issues: [] })
  })

  it('frontmatter is parsed and stripped; values keep quotes off and keys are case-stable', () => {
    const parsed = parseDocxFrontmatter('---\ntitle: 年度报告\nindent: true\naccent: "#0F766E"\n---\n\n# 正文')
    expect(parsed.design).toEqual({ title: '年度报告', indent: true, accent: '0F766E' })
    expect(parsed.body).not.toContain('title:')
    expect(parsed.body).toContain('# 正文')
  })

  it('unknown keys and unparsable values are NAMED, never silent', async () => {
    const parsed = parseDocxFrontmatter('---\ntocs: true\ntoc: yes\n---\n正文')
    expect(parsed.issues.join('；')).toContain('未识别的键 tocs')
    expect(parsed.issues.join('；')).toContain('toc 的值需是 true/false')
    const xml = await docxDocumentXml('---\ntocs: true\n---\n\n正文内容')
    expect(stripTags(xml)).toContain('frontmatter 未识别的键 tocs')
  })

  it("no frontmatter → today's shape: single sectPr, no header/footer parts, no updateFields", async () => {
    const md = '# 标题\n\n正文。'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    expect(countOf('<w:sectPr', zip.readAsText('word/document.xml'))).toBe(1)
    expect(zip.readAsText('word/document.xml')).not.toContain('headerReference')
    expect(zip.readAsText('word/document.xml')).not.toContain('footerReference')
    expect(zip.readAsText('word/settings.xml')).not.toContain('updateFields')
    expect(zip.getEntry('word/header1.xml')).toBeNull()
    expect(zip.getEntry('word/footer1.xml')).toBeNull()
  })

  it('title generates a cover (single section + titlePg + trailing page break); a same-text leading H1 is deduped', async () => {
    const md = '---\ntitle: 年度报告\nauthor: 王元杰\ndate: 2026-10-07\n---\n\n# 年度报告\n\n正文开始。'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    const xml = zip.readAsText('word/document.xml')
    // 单 section：docx-preview 不在同尺寸 section 边界翻页（probe 实测封面与
    // 目录同页流），封面靠 titlePg + 显式分页符在两条渲染引擎里都独占一页。
    expect(countOf('<w:sectPr', xml)).toBe(1)
    expect(xml).toContain('<w:titlePg/>')
    expect(xml).toContain('年度报告')
    expect(xml).toContain('王元杰')
    expect(xml).toContain('2026-10-07')
    // 正文 H1 已被封面吸收：document.xml 里不再有 Heading1 引用
    expect(xml).not.toContain('w:val="Heading1"')
  })

  it('header/footer generate real parts with PAGE/SECTIONPAGES fields; the cover page is titlePg-exempt', async () => {
    const md = '---\ntitle: T\nheader: 机密文件\nfooter: total\n---\n\n# 一\n\n正文'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    const xml = zip.readAsText('word/document.xml')
    expect(zip.readAsText('word/header1.xml')).toContain('机密文件')
    const footer = zip.readAsText('word/footer1.xml')
    expect(footer).toContain('PAGE')
    expect(footer).toContain('SECTIONPAGES')
    expect(xml).toContain('headerReference')
    expect(xml).toContain('footerReference')
    expect(xml).toContain('<w:titlePg/>')
    // 空的 first 部件：真 Word 让首页空白，docx-preview 却会回落 default——
    // 显式 first 引用让两侧一致（docx-preview 命中 first 不回落）。
    expect(xml).toContain('w:type="first"')
  })

  it('footer: off and header-only shapes stay legal; footer off emits no footer part', async () => {
    const md = '---\nheader: 只有页眉\nfooter: off\n---\n\n# 一\n\n正文'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    expect(zip.getEntry('word/header1.xml')).not.toBeNull()
    expect(zip.getEntry('word/footer1.xml')).toBeNull()
  })

  it('toc generates the field with cached entries and updateFields; depth caps the cache', async () => {
    const md = '---\ntoc: true\ntoc-depth: 2\n---\n\n# 一\n\n## 1.1 小节\n\n### 1.1.1 三级\n\n正文'
    const xml = await docxDocumentXml(md)
    expect(xml).toContain('TOC')
    expect(xml).toContain('1-2') // headingStyleRange
    // 缓存条目 = 正文标题投影：1.1 出现两次（正文 + 缓存），三级只出现一次（正文）
    expect(countOf('1.1 小节', xml)).toBe(2)
    expect(countOf('1.1.1 三级', xml)).toBe(1)
    const settings = await docxPart(md, 'word/settings.xml')
    expect(settings).toContain('updateFields')
    expect(xml).toContain('w:type="page"') // 目录后分页
  })

  it('indent: true puts firstLineChars=200 on body paragraphs only (lists/headings untouched)', async () => {
    const md = '---\nindent: true\n---\n\n正文段落甲。\n\n- 列表项\n\n# 标题\n\n正文段落乙。'
    const xml = await docxDocumentXml(md)
    expect(xml).toContain('w:firstLineChars="200"')
    expect(countOf('w:firstLineChars', xml)).toBe(2) // 两个正文段落，仅此而已
  })

  it('accent re-tints quote bar/wash and table header; default accent = byte-stable constants', async () => {
    // mixOverWhite('0F766E'): quote fill 8% → ECF4F3, header fill 6% → F1F7F6, rule 25% → C3DDDB
    const xml = await docxDocumentXml('---\naccent: "#0F766E"\n---\n\n> 引用\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |')
    expect(xml).toContain('w:color="0F766E"')
    expect(xml).toContain('ECF4F3')
    expect(xml).toContain('F1F7F6')
    const styles = await docxPart('---\naccent: "#0F766E"\n---\n\n# 标题\n\n正文', 'word/styles.xml')
    expect(styles).toContain('C3DDDB')
    const def = await docxDocumentXml('> 引用\n\n| 甲 |\n|---|\n| 1 |')
    expect(def).toContain('w:color="1677FF"')
    expect(def.toUpperCase()).toContain('ECF4FF')
    expect(def.toUpperCase()).toContain('F2F3F5')
  })

  it('bold+italic compose on the same run (M2 口径变更：***粗斜*** 兼有两标志)', async () => {
    const xml = await docxDocumentXml('段落 ***重点***')
    const runChunk = xml.slice(xml.lastIndexOf('<w:r>', xml.indexOf('重点')), xml.indexOf('重点'))
    expect(runChunk).toContain('<w:b/>')
    expect(runChunk).toContain('<w:i/>')
  })

  it('footnotes: definitions leave the body, references become footnoteReference runs', async () => {
    const md = '正文有引用[^1]，以及第二个[^note]。\n\n[^1]: 第一条脚注内容\n[^note]: 命名脚注内容\n\n更多正文。'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    const xml = zip.readAsText('word/document.xml')
    expect(countOf('footnoteReference', xml)).toBe(2)
    expect(xml).not.toContain('[^1]')
    expect(xml).not.toContain('[^note]')
    expect(xml).not.toContain('第一条脚注内容') // 定义行离开正文
    const footnotesXml = zip.readAsText('word/footnotes.xml')
    expect(footnotesXml).toContain('第一条脚注内容')
    expect(footnotesXml).toContain('命名脚注内容')
  })

  it('undefined footnote refs stay literal text and are named in the honesty note (only when the doc HAS footnotes)', async () => {
    // 有定义：真引用落 footnoteReference，未定义引用原文照旧 + 降级注点名
    const md = '已有脚注[^1]，还有一个不存在的[^404]。\n\n[^1]: 真脚注内容'
    const buf = await markdownToDocxBuffer(md)
    const zip = new AdmZip(buf)
    const xml = zip.readAsText('word/document.xml')
    expect(countOf('footnoteReference', xml)).toBe(1)
    expect(xml).toContain('[^404]')
    expect(stripTags(xml)).toContain('未定义的脚注引用')
    // 无定义：[^404] 只是普通文本（可能是集合记号），不吓唬人
    const plain = await docxDocumentXml('引用了一个不存在的[^404]脚注。')
    expect(plain).toContain('[^404]')
    expect(plain).not.toContain('footnoteReference')
    expect(stripTags(plain)).not.toContain('未定义的脚注引用')
  })
})

describe('docx chart fences (PLAN-docx-native-styles M9)', () => {
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const FENCE = "```chart\n{\"type\": \"column\", \"categories\": [\"一月\", \"二月\"], \"series\": [{\"name\": \"营收\", \"values\": [12, 30]}]}\n```"

  it('mdChartSpecs scans top-level chart fences in document order', () => {
    const md = FENCE + '\n\n正文\n\n' + FENCE.replace('营收', '成本')
    expect(mdChartSpecs(md)).toHaveLength(2)
    expect(mdChartSpecs('```js\nconst a = 1\n```')).toEqual([])
    // 列表里的围栏不是文档化能力，两边都不认（对齐生成器的顶层计数）
    expect(mdChartSpecs('- 项\n  ```chart\n  {}\n  ```')).toEqual([])
  })

  it('chartToSvg: accent rides series 0 verbatim; pie slices get their own palette', () => {
    const column = chartToSvg({ type: 'column', categories: ['一', '二'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [2, 1] }] }, '0F766E')
    expect(column).toContain('#0F766E') // 主色原样骑系列 0
    expect(column).toContain('<rect') // 柱
    expect(column).not.toContain('undefined')
    const pie = chartToSvg({ type: 'pie', categories: ['甲', '乙', '丙', '丁'], series: [{ name: 's', values: [4, 3, 2, 1] }] }, '0F766E')
    expect(pie).toContain('<path') // 扇形
    const fills = new Set([...pie.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]))
    expect(fills.size).toBeGreaterThanOrEqual(5) // 白底 + 4 切片各自有色
    expect([...fills].some((f) => f === 'undefined')).toBe(false)
  })

  it('chart fence + charts map → embedded image; missing map → code block + named note', async () => {
    const withChart = await markdownToDocxBuffer('图表如下：\n\n' + FENCE, undefined, { charts: new Map([[0, PNG_1PX]]) })
    const xml = new AdmZip(withChart).readAsText('word/document.xml')
    expect(xml).toContain('<w:drawing>')
    expect(xml).not.toContain('营收') // JSON 不再以代码出现
    const without = await markdownToDocxBuffer('图表如下：\n\n' + FENCE)
    const xml2 = new AdmZip(without).readAsText('word/document.xml')
    expect(xml2).not.toContain('<w:drawing>')
    expect(xml2).toContain('营收')
    expect(stripTags(xml2)).toContain('图表（浏览器内核缺席，已按原数据呈现）')
  })
})
