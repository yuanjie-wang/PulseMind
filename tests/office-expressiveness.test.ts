import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { imageDims, displaySize, EMU_PER_PX } from '../src/shared/office/image-dims'
import { markdownToDocxBuffer, mdImagePaths } from '../src/main/office-export/md-to-docx'
import { editDocx } from '../src/main/docx/package'
import { editXlsx } from '../src/main/xlsx/engine'
import { editXlsxOOXML } from '../src/main/xlsx/ooxml-edit'

// ── Minimal hand-built header corpora (no image library) ──
function png(w: number, h: number): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89; buf.write('PNG', 1, 'ascii'); buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20)
  return buf
}
function gif(w: number, h: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.write('GIF', 0, 'ascii')
  buf.writeUInt16LE(w, 6); buf.writeUInt8(h & 0xff, 8); buf.writeUInt8((h >> 8) & 0xff, 9)
  return buf
}
function jpeg(w: number, h: number): Buffer {
  const buf = Buffer.alloc(14)
  buf[0] = 0xff; buf[1] = 0xd8
  buf.writeUInt16BE(0xffc0, 2)
  buf.writeUInt16BE(11, 4) // segment length
  buf[6] = 8 // precision
  buf.writeUInt16BE(h, 7)
  buf.writeUInt16BE(w, 9)
  return buf
}

describe('imageDims (M1) — hand-built header corpora', () => {
  it('PNG IHDR at bytes 16–24 big-endian', () => {
    expect(imageDims(png(640, 480))).toEqual({ width: 640, height: 480 })
  })
  it('GIF little-endian at bytes 6–10', () => {
    expect(imageDims(gif(320, 200))).toEqual({ width: 320, height: 200 })
  })
  it('JPEG SOF0 scan', () => {
    expect(imageDims(jpeg(800, 600))).toEqual({ width: 800, height: 600 })
  })
  it('garbage/empty → null (never guesses)', () => {
    expect(imageDims(Buffer.from('not an image'))).toBeNull()
    expect(imageDims(Buffer.alloc(0))).toBeNull()
  })
  it('displaySize caps at 600 and honors an explicit side', () => {
    expect(displaySize({ width: 1200, height: 600 })).toEqual({ width: 600, height: 300 })
    expect(displaySize({ width: 300, height: 150 })).toEqual({ width: 300, height: 150 })
    expect(displaySize({ width: 300, height: 150 }, { widthPx: 150 })).toEqual({ width: 150, height: 75 })
    expect(displaySize({ width: 300, height: 150 }, { heightPx: 300 })).toEqual({ width: 600, height: 300 })
  })
  it('EMU conversion constant', () => {
    expect(EMU_PER_PX).toBe(9525)
  })
})

describe('mdImagePaths (M2)', () => {
  it('collects image hrefs in order, deduped', () => {
    const paths = mdImagePaths('![a](shot.png)\n\n![b](shot.png)\n\n![c](./diagrams/arch.png)')
    expect(paths).toEqual([{ href: 'shot.png' }, { href: './diagrams/arch.png' }])
  })
})

describe('docx generation embeds images (M2)', () => {
  it('a resolvable href embeds the real image into word/media', async () => {
    const md = '# 报告\n\n![现场](shot.png)\n\n正文。'
    const buf = await markdownToDocxBuffer(md, new Map([['shot.png', png(400, 300)]]))
    const zip = new AdmZip(buf)
    const media = zip.getEntries().filter((e) => e.entryName.startsWith('word/media/') && !e.isDirectory)
    expect(media.length).toBe(1)
    expect(zip.getEntry('word/_rels/document.xml.rels')!.getData().toString('utf8')).toContain('relationships/image')
    expect(zip.getEntry('[Content_Types].xml')!.getData().toString('utf8')).toContain('Extension="png"')
    expect(zip.getEntry('word/document.xml')!.getData().toString('utf8')).toContain('<wp:inline')
  })

  it('an unresolvable href keeps the degradation note (不静默变好也不静默变坏)', async () => {
    const md = '![现场](missing.png)'
    const buf = await markdownToDocxBuffer(md) // no images map
    const zip = new AdmZip(buf)
    expect(zip.getEntries().some((e) => e.entryName.startsWith('word/media/'))).toBe(false)
    expect(zip.getEntry('word/document.xml')!.getData().toString('utf8')).toContain('正文不支持')
  })
})

describe('docx_edit insert_image (M3)', () => {
  async function baseDoc(): Promise<Buffer> {
    return markdownToDocxBuffer('# 标题\n\n第一段。\n\n第二段。\n')
  }
  it('insert_image writes media/rels/CT and the anchored drawing paragraph', async () => {
    const doc = await baseDoc()
    const result = editDocx(doc, [{ op: 'insert_image', paragraph: 1, position: 'after', image: 'shot.png' }], {
      resolveImageBytes: (p) => (p === 'shot.png' ? { ext: 'png', bytes: png(320, 240) } : null),
    })
    const zip = new AdmZip(result.buffer)
    expect(zip.getEntries().some((e) => e.entryName === 'word/media/pmimg-1.png')).toBe(true)
    const rels = zip.getEntry('word/_rels/document.xml.rels')!.getData().toString('utf8')
    expect(rels).toContain('pmimg-1.png')
    const docXml = zip.getEntry('word/document.xml')!.getData().toString('utf8')
    expect(docXml).toContain('<wp:inline')
    // Every prefix the fragment uses must be declared INLINE — a minimal root
    // without xmlns:r would make the drawing ill-formed (Word: 内容有问题).
    expect(docXml).toMatch(/<wp:inline[^>]*xmlns:wp=/)
    expect(docXml).toMatch(/<wp:inline[^>]*xmlns:r=/)
    expect(result.editedParts).toContain('word/media/pmimg-1.png')
    expect(result.editedParts).toContain('word/_rels/document.xml.rels')
  })

  it('two images get unique media numbers AND unique docPr ids', async () => {
    const doc = await baseDoc()
    const result = editDocx(doc, [
      { op: 'insert_image', paragraph: 1, position: 'after', image: 'a.png' },
      { op: 'insert_image', paragraph: 3, position: 'before', image: 'b.png' },
    ], {
      resolveImageBytes: (p) => ({ ext: 'png', bytes: png(100, 100 + (p === 'b.png' ? 1 : 0)) }),
    })
    const zip = new AdmZip(result.buffer)
    expect(zip.getEntry('word/media/pmimg-1.png')).toBeTruthy()
    expect(zip.getEntry('word/media/pmimg-2.png')).toBeTruthy()
    const docXml = zip.getEntry('word/document.xml')!.getData().toString('utf8')
    const ids = [...docXml.matchAll(/wp:docPr id="(\d+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a missing image refuses the batch with no write', async () => {
    const doc = await baseDoc()
    expect(() => editDocx(doc, [{ op: 'insert_image', paragraph: 1, position: 'after', image: 'nope.png' }], {
      resolveImageBytes: () => null,
    })).toThrow(/读取失败/)
  })
})

describe('docx_edit table rows (M4)', () => {
  async function tableDoc(): Promise<Buffer> {
    return markdownToDocxBuffer('| 名次 | 姓名 | 得分 |\n|---|---|---|\n| 1 | 张三 | 95 |\n| 2 | 李四 | 88 |\n')
  }
  it('insert_table_row clones the anchor row formatting and sets cell texts', async () => {
    const doc = await tableDoc()
    const result = editDocx(doc, [{ op: 'insert_table_row', table: 0, after_row: 2, cells: ['3', '王五', '76'] }])
    expect(result.tables?.[0]).toEqual({ index: 0, rows: 4, cols: 3 }) // 3 + the inserted row
    const xml = new AdmZip(result.buffer).getEntry('word/document.xml')!.getData().toString('utf8')
    expect(xml).toContain('王五')
  })

  it('delete_table_row removes the row; the last remaining row is refused', async () => {
    const doc = await tableDoc()
    const result = editDocx(doc, [
      { op: 'delete_table_row', table: 0, row: 2 },
      { op: 'delete_table_row', table: 0, row: 1 },
    ])
    expect(result.tables?.[0].rows).toBe(1)
    expect(() => editDocx(result.buffer, [{ op: 'delete_table_row', table: 0, row: 0 }])).toThrow(/只剩一行/)
  })

  it('insert_table_row refuses a row carrying vertical merges (vMerge)', async () => {
    const doc = await tableDoc()
    // Hand-plant a vMerge into the LAST row (2) as Word writes it: a tcPr child.
    const zip = new AdmZip(doc)
    let xml = zip.getEntry('word/document.xml')!.getData().toString('utf8')
    const idx = xml.lastIndexOf('<w:tcPr>')
    xml = xml.slice(0, idx) + '<w:tcPr><w:vMerge w:val="restart"/>' + xml.slice(idx + '<w:tcPr>'.length)
    const merged = new AdmZip()
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue
      merged.addFile(e.entryName, e.entryName === 'word/document.xml' ? Buffer.from(xml) : e.getData())
    }
    const mergedBuf = merged.toBuffer()
    // The planted row now contains vMerge — the clone must refuse.
    expect(() => editDocx(mergedBuf, [{ op: 'insert_table_row', table: 0, after_row: 2, cells: ['x'] }])).toThrow(/vMerge/)
    expect(() => editDocx(mergedBuf, [{ op: 'delete_table_row', table: 0, row: 2 }])).toThrow(/vMerge/)
  })

  it('a bad table index refuses', () => {
    return markdownToDocxBuffer('无表格。').then(async (doc) => {
      expect(() => editDocx(doc, [{ op: 'insert_table_row', table: 0, after_row: 0 }])).toThrow(/不存在/)
    })
  })
})

describe('xlsx style ops (M5)', () => {
  async function sheetBuf(): Promise<Buffer> {
    const { sheetsToXlsxBuffer } = await import('../src/main/office-export/md-tables')
    return sheetsToXlsxBuffer([{ name: '数据', rows: [['项目', '数量'], ['苹果', 3], ['香蕉', 5]] }])
  }

  it('set_style / set_column_width / freeze_panes pass their read-backs', async () => {
    const buf = await sheetBuf()
    const out = await editXlsx(buf, [
      { op: 'set_style', cells: 'A1:B1', bold: true, fill: 'F0F0F0', align: 'center' },
      { op: 'set_column_width', columns: 'A:C', width: 18 },
      { op: 'freeze_panes', cell: 'A2' },
    ] as never)
    expect(out.results.every((r) => r.ok)).toBe(true)
    expect(out.warnings).toEqual([])
    // The splits ARE the freeze: a pane without xSplit/ySplit freezes nothing
    // in Excel/WPS, and the exceljs round-trip cannot see the gap. Assert the
    // pane XML the client will actually open ('A2' ⇒ ySplit=1, xSplit absent=0).
    const sheetXml = new AdmZip(out.buffer).getEntry('xl/worksheets/sheet1.xml')!.getData().toString('utf8')
    const pane = /<pane[^>]*\/?>/.exec(sheetXml)?.[0] ?? ''
    expect(pane).toContain('state="frozen"')
    expect(pane).toContain('ySplit="1"')
    expect(pane).not.toContain('xSplit="0"')
  })

  it('freeze_panes B2 writes BOTH splits (the bug the round-trip gate missed)', async () => {
    const buf = await sheetBuf()
    const out = await editXlsx(buf, [{ op: 'freeze_panes', cell: 'B2' }] as never)
    const sheetXml = new AdmZip(out.buffer).getEntry('xl/worksheets/sheet1.xml')!.getData().toString('utf8')
    const pane = /<pane[^>]*\/?>/.exec(sheetXml)?.[0] ?? ''
    expect(pane).toContain('xSplit="1"')
    expect(pane).toContain('ySplit="1"')
    expect(pane).toContain('topLeftCell="B2"')
  })

  it('an illegal color refuses loudly', async () => {
    const buf = await sheetBuf()
    await expect(editXlsx(buf, [{ op: 'set_style', cells: 'A1', color: 'zzz' }] as never)).rejects.toThrow(/RRGGBB/)
  })

  it('a runaway range (>50k cells) refuses', async () => {
    const buf = await sheetBuf()
    await expect(editXlsx(buf, [{ op: 'set_style', cells: 'A1:XFD1048576' }] as never)).rejects.toThrow(/50,000/)
  })

  it('the generation rider bolds the header and sizes columns', async () => {
    const buf = await sheetBuf()
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('数据')!
    expect(ws.getRow(1).font?.bold).toBe(true)
    expect((ws.getColumn(1).width ?? 0)).toBeGreaterThan(2)
  })

  it('the OOXML path refuses the style ops', async () => {
    // Build a workbook that carries a chart part → needsOOXMLPath hits.
    const buf = await sheetBuf()
    const zip = new AdmZip(buf)
    zip.addFile('xl/charts/chart1.xml', Buffer.from('<chart/>'))
    const withChart = zip.toBuffer()
    await expect(editXlsxOOXML(withChart, [{ op: 'set_style', cells: 'A1:B1', bold: true }])).rejects.toThrow(/暂不支持/)
  })
})
