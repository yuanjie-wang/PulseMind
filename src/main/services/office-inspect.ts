/**
 * office_inspect — structured inventory for docx/xlsx/pptx files.
 * Read-only: no backup, no write. Pure analysis.
 */
import AdmZip from 'adm-zip'
import { parseXml } from '../docx/xml-splice'
import { buildDocumentModel, outlineOf } from '../docx/model'
import { scanXlsx } from '../xlsx/engine'
import type { OfficeInspectResult } from '../../shared/office/ops'

export async function svcInspectOffice(input: { filePath: string }): Promise<OfficeInspectResult> {
  const { filePath } = input
  if (!filePath) return { success: false, format: 'unknown', summary: 'file_path is required', details: {}, error: 'file_path is required' }

  const { readFile } = await import('fs/promises')
  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (err: any) {
    return { success: false, format: 'unknown', summary: `无法读取文件: ${err.message}`, details: {}, error: err.message }
  }

  if (buffer.length < 4) {
    return { success: false, format: 'unknown', summary: '文件太小', details: {}, error: '文件太小，无法识别格式' }
  }

  // Detect format by magic bytes + required entries
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b
  if (!isZip) {
    return { success: false, format: 'unknown', summary: '不是 OOXML 文件', details: {}, error: '该文件不是 OOXML 格式（.docx/.xlsx/.pptx）' }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return { success: false, format: 'unknown', summary: '无法解析 ZIP 包', details: {}, error: '无法读取文件包结构' }
  }

  const names = zip.getEntries().map(e => e.entryName)

  // ── docx ──
  if (names.includes('word/document.xml')) {
    try {
      const xml = (zip.readFile('word/document.xml') as Buffer).toString('utf8')
      const model = buildDocumentModel(xml)
      const outline = outlineOf(model)
      const totalTextLen = model.paragraphs.reduce((n, p) => n + p.text.length, 0)
      const textBudget = Math.ceil(totalTextLen * 1.1)

      // Detect images
      const imageEntries = names.filter(n => /^word\/media\//.test(n))

      const summary = `Word 文档: ${model.paragraphs.length} 段落, 约 ${totalTextLen} 字符（预算 ${textBudget}）`
      return {
        success: true,
        format: 'docx',
        summary,
        details: {
          paragraphs: outline,
          textBudget,
          images: imageEntries.length,
        },
      }
    } catch (err: any) {
      return { success: false, format: 'docx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  // ── xlsx ──
  if (names.includes('xl/workbook.xml')) {
    try {
      const scan = scanXlsx(buffer)
      if (!scan.ok) {
        return { success: false, format: 'xlsx', summary: scan.reason!, details: {}, error: scan.reason }
      }

      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

      const sheets = workbook.worksheets.map(ws => ({
        name: ws.name,
        usedRange: ws.getCell(ws.rowCount, ws.columnCount).address || 'A1',
        rowCount: ws.rowCount,
        columnCount: ws.columnCount,
      }))

      // Collect formulas
      const formulas: string[] = []
      for (const ws of workbook.worksheets) {
        ws.eachRow({ includeEmpty: false }, row => {
          row.eachCell({ includeEmpty: false }, cell => {
            if (cell.formula) formulas.push(`${cell.address}: ${cell.formula}`)
          })
        })
      }

      // Detect charts
      const chartEntries = names.filter(n => /^xl\/charts\//.test(n))

      const totalCells = sheets.reduce((n, s) => n + s.rowCount * s.columnCount, 0)
      const summary = `Excel 工作簿: ${sheets.length} 个工作表, ${totalCells} 个单元格, ${formulas.length} 个公式, ${chartEntries.length} 个图表`
      return {
        success: true,
        format: 'xlsx',
        summary,
        details: { sheets, formulas, charts: chartEntries.length },
      }
    } catch (err: any) {
      return { success: false, format: 'xlsx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  // ── pptx ──
  if (names.includes('ppt/presentation.xml')) {
    try {
      const slideNames = names
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort()

      const slides: Array<{ index: number; text: string; shapeCount: number }> = []

      for (const slideName of slideNames) {
        const xml = (zip.readFile(slideName) as Buffer).toString('utf8')
        const { root } = parseXml(xml)
        const index = parseInt(slideName.match(/slide(\d+)\.xml/)![1], 10)

        const texts: string[] = []
        let shapeCount = 0
        const collectText = (node: any): void => {
          for (const child of node.children ?? []) {
            if (child.kind !== 'element') continue
            if (child.name === 'p:sp') shapeCount++
            if (child.name === 'a:t') {
              for (const t of child.children ?? []) {
                if (t.kind === 'text') texts.push(t.decoded)
              }
            }
            if (child.children?.length > 0) collectText(child)
          }
        }
        collectText(root)
        slides.push({ index, text: texts.join(''), shapeCount })
      }

      // Detect embedded media
      const mediaEntries = names.filter(n => /^ppt\/media\//.test(n))

      const totalTextLen = slides.reduce((n, s) => n + s.text.length, 0)
      const summary = `PowerPoint 演示文稿: ${slides.length} 张幻灯片, ${slides.reduce((n, s) => n + s.shapeCount, 0)} 个形状, 约 ${totalTextLen} 字符`
      return {
        success: true,
        format: 'pptx',
        summary,
        details: { slides, images: mediaEntries.length },
      }
    } catch (err: any) {
      return { success: false, format: 'pptx', summary: `解析失败: ${err.message}`, details: {}, error: err.message }
    }
  }

  return { success: false, format: 'unknown', summary: '无法识别的 Office 格式', details: {}, error: 'ZIP 包内未找到 word/document.xml、xl/workbook.xml 或 ppt/presentation.xml' }
}
