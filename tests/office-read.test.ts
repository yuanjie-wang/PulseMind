import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { formatOfficeReadResult, OFFICE_READ_CHAR_BUDGET } from '../src/renderer/src/agent/office-read-format'
import type { OfficeReadResult } from '../src/shared/office/ops'

/**
 * office_read (PLAN-office-read): the paged, structure-faithful read whose
 * coordinates are the edit tools' coordinates. Pins the service contract
 * (FULL paragraph text — not the outline's 80-char slice; sldIdLst slide
 * order — never filename order; formula cells as =expr → result) and the
 * formatter contract (absolute row numbers in the address header — a window
 * offset displayed as the row number aims set_cell at the WRONG cell;
 * envelope last, even mid-truncation).
 */

const lastLine = (text: string): string => text.split('\n').at(-1) ?? ''

describe('formatOfficeReadResult — docx', () => {
  const result: OfficeReadResult = {
    success: true,
    format: 'docx',
    summary: 'Word 文档: 第 1–2 段 / 共 5 段',
    details: {
      paragraphs: [
        { index: 0, style: 'Heading1', text: '2026 年度报告' },
        { index: 1, style: null, text: '正文'.repeat(100) },
      ],
      paragraphCount: 5,
      nextOffset: 3,
      tables: [{ index: 0, rows: 2, cols: 2, cells: [['名称', '数量'], ['甲 | 乙', '10']] }],
    },
  }

  it('renders full paragraph text, table cells, next offset and envelope', () => {
    const text = formatOfficeReadResult(result)
    expect(text.split('\n')[0]).toBe(result.summary)
    expect(text).toContain('[0] Heading1: 2026 年度报告')
    expect(text).toContain(`[1] -: ${'正文'.repeat(100)}`) // FULL text, not an 80-char slice
    expect(text).toContain('表 0：2 行 × 2 列')
    expect(text).toContain('R1: 名称 | 数量')
    expect(text).toContain('R2: 甲 \\| 乙 | 10') // pipes escaped for the row display
    expect(lastLine(text)).toBe('下一步：继续读 → offset=3；编辑 → 对照段落索引调 docx_edit（表格行用 表/行 号）。')
  })

  it('ends with the envelope even when the budget truncates mid-page', () => {
    const big: OfficeReadResult = {
      ...result,
      details: {
        ...result.details,
        paragraphs: Array.from({ length: 4000 }, (_, i) => ({ index: i, style: null, text: `段落内容${i}。`.repeat(10) })),
        tables: undefined,
      },
    }
    const text = formatOfficeReadResult(big)
    expect(text.length).toBeLessThanOrEqual(OFFICE_READ_CHAR_BUDGET + 200)
    expect(text).toContain('…（超出预算被截断')
    expect(lastLine(text)).toContain('重读 → offset=0')
  })
})

describe('formatOfficeReadResult — xlsx', () => {
  it('headers carry column letters and rows carry ABSOLUTE numbers', () => {
    const text = formatOfficeReadResult({
      success: true,
      format: 'xlsx',
      summary: '工作表「数据」: 第 11–12 行 / 共 30 行 × 3 列',
      details: {
        sheet: '数据',
        startRow: 11,
        cells: [
          ['甲', '=SUM(B2:B2) → 10', '2026-09-29'],
          ['乙', '20', ''],
        ],
        columnCount: 3,
        nextOffset: 13,
      },
    })
    expect(text).toContain('| 行 | A | B | C |')
    expect(text).toContain('| 11 | 甲 |')
    expect(text).toContain('| 12 | 乙 |')
    expect(text).not.toContain('| 1 | 甲 |') // window offset ≠ row number
    expect(lastLine(text)).toBe('下一步：继续读 → sheet="数据" offset=13；编辑 → xlsx_edit 的单元格地址 = 行号 + 列字母（公式显示为 =式 → 结果，set_cell 重写表达式）。')
  })

  it('sheet inventory ends with the sheet-then-read hint', () => {
    const text = formatOfficeReadResult({
      success: true,
      format: 'xlsx',
      summary: 'Excel 工作簿: 数据(30行×3列), 说明(1行×1列)',
      details: { sheets: [{ name: '数据', rowCount: 30, columnCount: 3 }, { name: '说明', rowCount: 1, columnCount: 1 }] },
    })
    expect(text).toContain('- 数据: 30 行 × 3 列')
    expect(lastLine(text)).toBe('下一步：读值 → sheet="<名称>"（可加 range="A1:J50" 或 offset/limit 翻行）。')
  })
})

describe('formatOfficeReadResult — pptx', () => {
  it('renders shape ids, placeholder types and wrapped paragraph text', () => {
    const text = formatOfficeReadResult({
      success: true,
      format: 'pptx',
      summary: 'PowerPoint: 第 2 页（2 形状）',
      details: {
        slides: [
          {
            index: 2,
            shapes: [
              { shapeId: '3', name: 'Title 1', phType: 'title', text: '第二页标题' },
              { shapeId: '7', name: '文本框 4', text: '第一段\n第二段' },
            ],
          },
        ],
      },
    })
    expect(text).toContain('— 第 2 页（2 形状）:')
    expect(text).toContain('[3](title) Title 1: 第二页标题')
    expect(text).toContain('[7] 文本框 4: 第一段')
    expect(text).toContain('    第二段') // continuation paragraphs indented
    expect(lastLine(text)).toBe('下一步：编辑 → 对照 shape id 调 pptx_edit（set_shape_text 整形状重写，replace_text 跨形状查替换）。')
  })
})

describe('svcReadOffice — real fixtures', () => {
  it('serves docx full text + table cells, xlsx inventory/window/formulas, pptx sldIdLst order', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-office-read-'))
    process.env.HOME = fixture // the guard's deny roots derive from homedir()
    const dir = path.join(fixture, 'docs')
    fs.mkdirSync(dir)

    // docx: a 200-char paragraph (the slice that forced models into *_edit) +
    // a table whose second cell carries deleted-revision text (never visible)
    const longText = '正文'.repeat(100)
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>2026 年度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>${longText}</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:del><w:r><w:delText>旧</w:delText></w:r></w:del><w:ins><w:r><w:t>乙</w:t></w:r></w:ins></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`
    const docxZip = new AdmZip()
    docxZip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'))
    const docxPath = path.join(dir, '报告.docx')
    fs.writeFileSync(docxPath, docxZip.toBuffer())

    // xlsx: two sheets, one formula with cached result — read window must
    // show BOTH the expression and the result
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('数据')
    ws.addRow(['名称', '数量', '合计'])
    ws.addRow(['甲', 10, null])
    ws.getCell('C2').value = { formula: 'SUM(B2:B2)', result: 10 }
    for (let i = 3; i <= 60; i++) ws.addRow(['填', i, null]) // 60 rows total
    const ws2 = wb.addWorksheet('说明')
    ws2.addRow(['备注'])
    const xlsxPath = path.join(dir, '台账.xlsx')
    fs.writeFileSync(xlsxPath, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer))

    // pptx: sldIdLst deliberately references slide2 FIRST — presentation
    // order (what pptx_edit's slide counts), not filename order
    const slideXml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="5" name="文本框 1"/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const pptxZip = new AdmZip()
    pptxZip.addFile('ppt/presentation.xml', Buffer.from(
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      'utf8'))
    pptxZip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/><Relationship Id="rId2" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>`,
      'utf8'))
    pptxZip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml('文件名在前的页'), 'utf8'))
    pptxZip.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml('演示顺序第一页'), 'utf8'))
    const pptxPath = path.join(dir, '汇报.pptx')
    fs.writeFileSync(pptxPath, pptxZip.toBuffer())

    try {
      const { svcReadOffice } = await import('../src/main/services/office-read')

      // docx: full text, window paging, table cells with del-text excluded.
      // Cell paragraphs join the flat list (buildDocumentModel recurses into
      // w:tbl): 2 body paragraphs + 4 cell paragraphs = 共 6 段.
      const page1 = await svcReadOffice({ filePath: docxPath, limit: 1 })
      expect(page1.success).toBe(true)
      expect(page1.summary).toContain('第 1–1 段 / 共 6 段')
      expect(page1.details.paragraphs![0].text).toBe('2026 年度报告')
      expect(page1.details.nextOffset).toBe(2)

      const page2 = await svcReadOffice({ filePath: docxPath, offset: 2 })
      expect(page2.details.paragraphs![0].text).toHaveLength(200) // FULL, not 80
      expect(page2.details.nextOffset).toBeUndefined() // last page: no next

      const withTables = await svcReadOffice({ filePath: docxPath, offset: 3, limit: 4, tables: true })
      expect(withTables.summary).toContain('第 3–6 段 / 共 6 段')
      expect(withTables.summary).toContain(', 1 个表格')
      const tbl = withTables.details.tables![0]
      expect(tbl).toMatchObject({ index: 0, rows: 2, cols: 2 })
      expect(tbl.cells![0]).toEqual(['名称', '数量'])
      expect(tbl.cells![1]).toEqual(['甲', '乙']) // w:del 旧 excluded, ins visible

      // xlsx: no sheet → inventory; sheet → window with formula both-halves
      const inventory = await svcReadOffice({ filePath: xlsxPath })
      expect(inventory.details.sheets).toEqual([
        { name: '数据', rowCount: 60, columnCount: 3 },
        { name: '说明', rowCount: 1, columnCount: 1 },
      ])

      const win = await svcReadOffice({ filePath: xlsxPath, sheet: '数据', offset: 1, limit: 2 })
      expect(win.summary).toContain('第 1–2 行 / 共 60 行 × 3 列')
      expect(win.details.cells![0]).toEqual(['名称', '数量', '合计'])
      expect(win.details.cells![1][2]).toBe('=SUM(B2:B2) → 10') // expression AND result
      expect(win.details.nextOffset).toBe(3)

      const ranged = await svcReadOffice({ filePath: xlsxPath, sheet: '数据', range: 'B2:C2' })
      expect(ranged.details.startRow).toBe(2)
      expect(ranged.details.cells![0]).toEqual(['10', '=SUM(B2:B2) → 10'])

      const noSheet = await svcReadOffice({ filePath: xlsxPath, sheet: '不存在' })
      expect(noSheet.success).toBe(false)
      expect(noSheet.error).toContain('可用: 数据, 说明')

      // pptx: slide 1 is the one sldIdLst names first (slide2.xml)
      const deck = await svcReadOffice({ filePath: pptxPath })
      expect(deck.details.slides![0].index).toBe(1)
      expect(deck.details.slides![0].shapes[0].text).toBe('演示顺序第一页')
      expect(deck.details.slides![1].shapes[0].text).toBe('文件名在前的页')

      const one = await svcReadOffice({ filePath: pptxPath, slide: 1 })
      expect(one.details.slides).toHaveLength(1)
      expect(one.details.slides![0].shapes[0].shapeId).toBe('5')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
