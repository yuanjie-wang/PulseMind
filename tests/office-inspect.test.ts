import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { formatInspectResult, INSPECT_RESULT_CHAR_BUDGET } from '../src/renderer/src/agent/office-inspect-format'
import type { OfficeInspectResult } from '../src/shared/office/ops'

/**
 * office_inspect used to ship ONLY the one-line summary — the service computed
 * the full details and the executor dropped them, so the model learned nothing
 * and fell back to read/python every time (user report 2026-09-28). Pins the
 * whole contract now: the service carries content previews, the renderer
 * formats them under one char budget, and the next-step envelope is always
 * the last bytes.
 */

const NEXT_STEP_PREFIX = '下一步：'
const lastLine = (text: string): string => text.split('\n').at(-1) ?? ''

describe('formatInspectResult — docx', () => {
  const result: OfficeInspectResult = {
    success: true,
    format: 'docx',
    summary: 'Word 文档: 3 段落, 约 220 字符（预算 242）',
    details: {
      paragraphs: [
        { index: 0, style: 'Heading1', textLength: 12, text: '2026 年度报告' },
        { index: 1, style: null, textLength: 200, text: '本报告总结了公司本年度经营情况' },
        { index: 2, style: null, textLength: 8, text: '' },
      ],
      textBudget: 242,
      images: 2,
    },
  }

  it('renders the summary first, every paragraph with preview, budget and envelope', () => {
    const text = formatInspectResult(result)
    expect(text.split('\n')[0]).toBe(result.summary)
    expect(text).toContain('[0] Heading1: 12字 — 2026 年度报告')
    expect(text).toContain('[1] -: 200字 — 本报告总结了公司本年度经营情况')
    expect(text).toContain('[2] -: 8字 — (空段落)')
    expect(text).toContain('文本预算: 242 字符')
    expect(text).toContain('图片: 2 张')
    expect(lastLine(text)).toMatch(new RegExp(`^${NEXT_STEP_PREFIX}`))
  })

  it('caps the outline at 120 lines with a count note', () => {
    const big: OfficeInspectResult = {
      ...result,
      details: {
        ...result.details,
        paragraphs: Array.from({ length: 150 }, (_, i) => ({ index: i, style: null, textLength: 10, text: `段${i}` })),
      },
    }
    const text = formatInspectResult(big)
    expect(text).toContain('[119] -: 10字')
    expect(text).not.toContain('[120]')
    expect(text).toContain('…（共 150 段，已列前 120 段）')
  })
})

describe('formatInspectResult — xlsx', () => {
  const result: OfficeInspectResult = {
    success: true,
    format: 'xlsx',
    summary: 'Excel 工作簿: 2 个工作表, 42 个单元格, 1 个公式, 1 个图表',
    details: {
      sheets: [
        {
          name: '数据',
          usedRange: 'C3',
          rowCount: 3,
          columnCount: 3,
          head: [
            ['名称', '数量', '合计'],
            ['甲', '10', '55'],
            ['乙', '20', ''],
          ],
        },
        { name: '图表页', usedRange: 'A1', rowCount: 0, columnCount: 0 },
      ],
      formulas: ['C2: SUM(B2:B2)'],
      charts: 1,
    },
  }

  it('renders sheets, the head markdown table, formulas, charts and the envelope', () => {
    const text = formatInspectResult(result)
    expect(text).toContain('- 数据: C3（3 行 × 3 列）')
    expect(text).toContain('| 名称 | 数量 | 合计 |')
    expect(text).toContain('| 甲 | 10 | 55 |')
    expect(text).toContain('- C2: SUM(B2:B2)')
    expect(text).toContain('图表: 1 个')
    expect(text.match(/预览前/g)).toHaveLength(1) // only the sheet with rows gets a table
    expect(lastLine(text)).toMatch(new RegExp(`^${NEXT_STEP_PREFIX}`))
  })

  it('escapes pipes and line breaks inside cells', () => {
    const nasty: OfficeInspectResult = {
      ...result,
      details: {
        ...result.details,
        sheets: [{ ...result.details.sheets![0], head: [['a|b', 'c\nd', 'e']] }],
      },
    }
    const text = formatInspectResult(nasty)
    expect(text).toContain('a\\|b')
    expect(text).toContain('c d')
  })

  it('caps the formula list with a remainder note', () => {
    const many: OfficeInspectResult = {
      ...result,
      details: { ...result.details, formulas: Array.from({ length: 40 }, (_, i) => `A${i}: SUM(B1:B2)`) },
    }
    const text = formatInspectResult(many)
    expect(text).toContain('- A14: SUM(B1:B2)')
    expect(text).not.toContain('- A15:')
    expect(text).toContain('…（其余 25 条公式略）')
  })
})

describe('formatInspectResult — pptx + budget', () => {
  it('renders slide lines and envelope', () => {
    const result: OfficeInspectResult = {
      success: true,
      format: 'pptx',
      summary: 'PowerPoint 演示文稿: 2 张幻灯片, 3 个形状, 约 30 字符',
      details: {
        slides: [
          { index: 1, text: '2026 年度报告 副标题', shapeCount: 2 },
          { index: 2, text: '', shapeCount: 1 },
        ],
        images: 3,
      },
    }
    const text = formatInspectResult(result)
    expect(text).toContain('— 第 1 页（2 形状）: 2026 年度报告 副标题')
    expect(text).toContain('— 第 2 页（1 形状）: (无文本)')
    expect(text).toContain('图片: 3 张')
    expect(lastLine(text)).toMatch(new RegExp(`^${NEXT_STEP_PREFIX}`))
  })

  it('truncates at the char budget and still ends with the envelope', () => {
    const filler = '内容'.repeat(150) // 300 CJK chars per slide
    const huge: OfficeInspectResult = {
      success: true,
      format: 'pptx',
      summary: 'PowerPoint 演示文稿: 100 张幻灯片',
      details: { slides: Array.from({ length: 100 }, (_, i) => ({ index: i + 1, text: `${filler}${i}`, shapeCount: 1 })) },
    }
    const text = formatInspectResult(huge)
    expect(text).toContain('…（清单超长被截断——完整内容用 read 读取）')
    // summary + envelope + truncation notice fit; the body is capped
    expect(text.length).toBeLessThan(INSPECT_RESULT_CHAR_BUDGET + 300)
    expect(lastLine(text)).toMatch(new RegExp(`^${NEXT_STEP_PREFIX}`))
    expect(text.indexOf('…（清单超长被截断')).toBeGreaterThan(text.lastIndexOf('— 第'))
  })
})

// ── the service side: real fixtures through the real guard ──

describe('svcInspectOffice — real fixtures', () => {
  it('carries docx paragraph previews with real lengths, xlsx head rows and formulas, pptx slide text', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-inspect-'))
    process.env.HOME = fixture // the guard's deny roots derive from homedir()
    const dir = path.join(fixture, 'docs')
    fs.mkdirSync(dir)

    // docx: three paragraphs, one long — textLength must report the REAL length
    const longText = '正文'.repeat(100) // 200 chars, preview slices at 80
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>2026 年度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>${longText}</w:t></w:r></w:p>
</w:body></w:document>`
    const docxZip = new AdmZip()
    docxZip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'))
    const docxPath = path.join(dir, '报告.docx')
    fs.writeFileSync(docxPath, docxZip.toBuffer())

    // xlsx: two sheets, values + one formula with a cached result
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('数据')
    ws.addRow(['名称', '数量', '合计'])
    ws.addRow(['甲', 10, null])
    ws.getCell('C2').value = { formula: 'SUM(B2:B2)', result: 10 }
    ws.addRow(['乙', 20, 30])
    const ws2 = wb.addWorksheet('说明')
    ws2.addRow(['备注'])
    const xlsxPath = path.join(dir, '台账.xlsx')
    fs.writeFileSync(xlsxPath, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer))

    // pptx: two slides with a:t runs
    const slideXml = (texts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody><a:p>${texts.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('')}</a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`
    const pptxZip = new AdmZip()
    pptxZip.addFile('ppt/presentation.xml', Buffer.from('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>', 'utf8'))
    pptxZip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml(['2026 年度报告', '副标题']), 'utf8'))
    pptxZip.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml(['议程']), 'utf8'))
    const pptxPath = path.join(dir, '汇报.pptx')
    fs.writeFileSync(pptxPath, pptxZip.toBuffer())

    try {
      const { svcInspectOffice } = await import('../src/main/services/office-inspect')

      const docx = await svcInspectOffice({ filePath: docxPath })
      expect(docx.success).toBe(true)
      expect(docx.format).toBe('docx')
      const paras = docx.details.paragraphs!
      expect(paras).toHaveLength(2)
      expect(paras[0]).toMatchObject({ index: 0, style: 'Heading1', textLength: 9, text: '2026 年度报告' })
      expect(paras[1].textLength).toBe(200) // real length, not the 80-char preview
      expect(paras[1].text).toHaveLength(80) // preview is outlineOf's plain slice — no ellipsis marker
      expect(docx.details.textBudget).toBe(Math.ceil((9 + 200) * 1.1))

      const xlsx = await svcInspectOffice({ filePath: xlsxPath })
      expect(xlsx.success).toBe(true)
      expect(xlsx.format).toBe('xlsx')
      const sheets = xlsx.details.sheets!
      expect(sheets).toHaveLength(2)
      expect(sheets[0].head).toEqual([
        ['名称', '数量', '合计'],
        ['甲', '10', '10'],
        ['乙', '20', '30'],
      ])
      expect(xlsx.details.formulas).toEqual(['C2: SUM(B2:B2)'])
      expect(sheets[1].head).toEqual([['备注']])

      const pptx = await svcInspectOffice({ filePath: pptxPath })
      expect(pptx.success).toBe(true)
      expect(pptx.format).toBe('pptx')
      expect(pptx.details.slides![0].text).toBe('2026 年度报告 副标题')
      expect(pptx.details.slides![1].text).toBe('议程')
      expect(pptx.details.slides![0].shapeCount).toBe(1)
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
