import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { formatOfficeSearchResult, OFFICE_SEARCH_CHAR_BUDGET } from '../src/renderer/src/agent/office-search-format'

/**
 * office_search (2026-10-12): coordinate-anchored content search — find
 * WHERE content lives (paragraph index / cell address / shape id) without
 * reading the file. Pins the service contract (docx hits in the flat index
 * space office_read pages and office_edit edits; xlsx cell addresses with
 * row context; pptx in sldIdLst order; formula cells matched in their
 * rendered "=expr → result" form) and the formatter contract (the follow-up
 * office_read envelope is the true last bytes).
 */

const lastLine = (text: string): string => text.split('\n').at(-1) ?? ''

describe('formatOfficeSearchResult', () => {
  it('docx hits render with index + style and the envelope teaches offset=[段落号]+1', () => {
    const text = formatOfficeSearchResult({
      success: true,
      format: 'docx',
      summary: 'Word 检索「年度」: 2 处命中',
      details: {
        hits: [
          { index: 0, style: 'Heading1', snippet: '2026 年度报告' },
          { index: 12, style: null, snippet: '…本 年度 合计…' },
        ],
        totalMatches: 2,
      },
    })
    expect(text).toContain('[0] Heading1: 2026 年度报告')
    expect(text).toContain('[12] -: …本 年度 合计…')
    expect(lastLine(text)).toBe('下一步：精读 → office_read offset=[段落号]+1 limit=40；编辑 → 对照段落索引调 office_edit。')
  })

  it('xlsx hits render sheet!address with the row preview, collapsed to one line', () => {
    const text = formatOfficeSearchResult({
      success: true,
      format: 'xlsx',
      summary: 'Excel 检索「甲」: 1 处命中',
      details: {
        hits: [{ sheet: '数据', address: 'A2', rowPreview: ['名称', '甲', '10'], snippet: '甲' }],
        totalMatches: 1,
      },
    })
    expect(text).toContain('- 数据!A2: 甲 ｜ 行: 名称 | 甲 | 10')
    expect(lastLine(text)).toBe(
      '下一步：精读首条命中 数据!A2 → office_read sheet="数据" offset=2 limit=5；跨工作表命中按各行地址取行号；编辑 → office_edit 的 xlsx 算子（单元格地址 = 行号 + 列字母）。',
    )
  })

  it('xlsx envelope splices the first hit’s real row from a multi-letter address (review_20261013 低4)', () => {
    // The envelope used to say `offset=<行号>` and made the model convert
    // `C12` → 12 itself; the row number lives in the address, so it is
    // spliced in. Non-vacuous: a two-letter column changes the extracted row.
    const text = formatOfficeSearchResult({
      success: true,
      format: 'xlsx',
      summary: 'Excel 检索「考核」: 1 处命中',
      details: {
        hits: [{ sheet: 'Q4', address: 'C12', snippet: '考核得分' }],
        totalMatches: 1,
      },
    })
    expect(lastLine(text)).toContain('offset=12')
    expect(lastLine(text)).toContain('精读首条命中 Q4!C12')
  })

  it('xlsx envelope falls back to the <行号> placeholder when the address carries no row digits', () => {
    // Zero hits never reaches the teaching line (the 无命中 early return owns
    // that path); the placeholder arm is for a malformed digit-less address —
    // fail-closed honesty instead of `offset=NaN`.
    const text = formatOfficeSearchResult({
      success: true,
      format: 'xlsx',
      summary: 'Excel 检索「甲」: 1 处命中',
      details: { hits: [{ sheet: '数据', address: 'C', snippet: '甲' }], totalMatches: 1 },
    })
    expect(lastLine(text)).toContain('sheet="数据" offset=<行号>')
  })

  it('pptx snippets collapse paragraph line breaks into one display line', () => {
    const text = formatOfficeSearchResult({
      success: true,
      format: 'pptx',
      summary: 'PowerPoint 检索「续约」: 1 处命中',
      details: {
        hits: [{ slide: 2, shapeId: '7', name: '文本框 4', snippet: '大客户 续约率 92%\n创三年新高' }],
        totalMatches: 1,
      },
    })
    expect(text).toContain('- 第 2 页 [7] 文本框 4: 大客户 续约率 92% 创三年新高')
    expect(lastLine(text)).toBe('下一步：读整页 → office_read slide=N；编辑 → 对照 shape id 调 office_edit。')
  })

  it('zero hits coach instead of showing an empty list', () => {
    const text = formatOfficeSearchResult({
      success: true,
      format: 'docx',
      summary: 'Word 检索「不存在」: 无命中',
      details: { hits: [], totalMatches: 0 },
    })
    expect(text).toContain('无命中——换更短的关键词、开 regex')
  })

  it('budget truncation keeps the envelope last', () => {
    const hits = Array.from({ length: 4000 }, (_, i) => ({
      index: i,
      style: null as string | null,
      snippet: `命中内容${i}。`.repeat(10),
    }))
    const text = formatOfficeSearchResult({
      success: true,
      format: 'docx',
      summary: 'Word 检索「内容」: 4000 处命中（显示前 50）',
      details: { hits, totalMatches: 4000 },
    })
    expect(text.length).toBeLessThanOrEqual(OFFICE_SEARCH_CHAR_BUDGET + 200)
    expect(lastLine(text)).toContain('office_read offset=[段落号]+1')
  })
})

describe('svcSearchOffice — real fixtures', () => {
  it('searches docx paragraphs, xlsx cells (rendered formulas included), pptx shapes', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-office-search-'))
    process.env.HOME = fixture // the guard's deny roots derive from homedir()
    const dir = path.join(fixture, 'docs')
    fs.mkdirSync(dir)

    // docx: same shape as office-read's fixture — Heading1 + body + a table
    // whose cell paragraphs join the flat index space
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>2026 年度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>正文提到供应商考核。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>考核</w:t></w:r></w:p></w:tc><w:tc><w:p><w:del><w:r><w:delText>旧考核</w:delText></w:r></w:del><w:ins><w:r><w:t>新考核</w:t></w:r></w:ins></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`
    const docxZip = new AdmZip()
    docxZip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'))
    const docxPath = path.join(dir, '报告.docx')
    fs.writeFileSync(docxPath, docxZip.toBuffer())

    // xlsx: two sheets; one formula with cached result — the SEARCH space is
    // the same rendering the reader sees ("=expr → result")
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('数据')
    ws.addRow(['名称', '数量', '合计'])
    ws.addRow(['甲', 10, null])
    ws.getCell('C2').value = { formula: 'SUM(B2:B2)', result: 10 }
    for (let i = 3; i <= 60; i++) ws.addRow(['填', i, null])
    const ws2 = wb.addWorksheet('说明')
    ws2.addRow(['备注'])
    const xlsxPath = path.join(dir, '台账.xlsx')
    fs.writeFileSync(xlsxPath, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer))

    // pptx: sldIdLst order — slide2 is presentation page 1
    const slideXml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="5" name="文本框 1"/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const pptxZip = new AdmZip()
    pptxZip.addFile(
      'ppt/presentation.xml',
      Buffer.from(
        `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
        'utf8',
      ),
    )
    pptxZip.addFile(
      'ppt/_rels/presentation.xml.rels',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/><Relationship Id="rId2" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>`,
        'utf8',
      ),
    )
    pptxZip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml('第二页内容'), 'utf8'))
    pptxZip.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml('续约率创新高'), 'utf8'))
    const pptxPath = path.join(dir, '汇报.pptx')
    fs.writeFileSync(pptxPath, pptxZip.toBuffer())

    try {
      const { svcSearchOffice } = await import('../src/main/services/office-search')

      // docx: hits carry the flat paragraph index (table cell paragraphs are
      // ordinary members of that space); deleted-revision text never matches
      const docHits = await svcSearchOffice({ filePath: docxPath, query: '考核' })
      expect(docHits.success).toBe(true)
      expect(docHits.summary).toContain('3 处命中')
      expect(docHits.details.hits).toEqual([
        { index: 1, style: null, snippet: '正文提到供应商考核。' },
        { index: 4, style: null, snippet: '考核' },
        { index: 5, style: null, snippet: '新考核' },
      ])
      expect(JSON.stringify(docHits.details.hits)).not.toContain('旧考核')

      // xlsx: rendered cell text — the formula cell matches BOTH halves; the
      // hit row carries its leading cells as column context
      const xlsxHits = await svcSearchOffice({ filePath: xlsxPath, query: 'sum' })
      expect(xlsxHits.summary).toContain('1 处命中')
      expect(xlsxHits.details.hits![0]).toMatchObject({ sheet: '数据', address: 'C2' })
      expect(xlsxHits.details.hits![0].snippet).toBe('=SUM(B2:B2) → 10')
      expect(xlsxHits.details.hits![0].rowPreview).toEqual(['甲', '10', '=SUM(B2:B2) → 10'])

      // xlsx: sheet filter + case-insensitive default; a missing sheet errors
      // with the available names
      const sheetScoped = await svcSearchOffice({ filePath: xlsxPath, query: '备注', sheet: '说明' })
      expect(sheetScoped.summary).toContain('1 处命中')
      expect(sheetScoped.details.hits![0].address).toBe('A1')
      const wrongSheet = await svcSearchOffice({ filePath: xlsxPath, query: '备注', sheet: '不存在' })
      expect(wrongSheet.success).toBe(false)
      expect(wrongSheet.error).toContain('可用: 数据, 说明')

      // xlsx: regex mode — B holds 3..60; the two-digit values are B2 and
      // B10..B60 = 52 cells ('填' never concatenates with the number: addRow
      // puts them in separate cells)
      const regexHits = await svcSearchOffice({ filePath: xlsxPath, query: '^\\d{2}$', regex: true })
      expect(regexHits.details.totalMatches).toBe(52)
      expect(regexHits.details.hits).toHaveLength(50) // MAX_HITS cap

      // pptx: presentation order — page 1 is the slide sldIdLst names first
      const pptxHits = await svcSearchOffice({ filePath: pptxPath, query: '续约' })
      expect(pptxHits.summary).toContain('1 处命中')
      expect(pptxHits.details.hits![0]).toMatchObject({ slide: 1, shapeId: '5' })
      const scoped = await svcSearchOffice({ filePath: pptxPath, query: '续约', slide: 2 })
      expect(scoped.summary).toContain('无命中')

      // a miss is a SUCCESSFUL search with zero hits (the model may retry)
      const miss = await svcSearchOffice({ filePath: docxPath, query: '不存在的内容' })
      expect(miss.success).toBe(true)
      expect(miss.details.totalMatches).toBe(0)

      // an invalid regex is a REFUSAL, not a crash
      const badRegex = await svcSearchOffice({ filePath: docxPath, query: '(', regex: true })
      expect(badRegex.success).toBe(false)
      expect(badRegex.error).toContain('不是合法正则')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('a long regex match re-windows its snippet on the match midpoint (review_20261013 低1)', async () => {
    // MAX_SNIPPET_CHARS only bounded the no-match fallback before — a regex
    // like 长.*尾 over a 2,000-char paragraph produced a ~2,080-char snippet
    // that ate the hit list (usable-only degradation: the formatter's char
    // budget then dropped the hits AFTER it). The body now re-windows on the
    // match's own midpoint: bounded, hit-centered. Non-vacuous: reverting the
    // re-window fails the length bound; the all-mid-match ink and the
    // ellipses prove the window moved to the middle, not just clipped.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-office-snippet-'))
    process.env.HOME = fixture
    try {
      const dir = path.join(fixture, 'docs')
      fs.mkdirSync(dir)
      const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>长${'x'.repeat(2000)}尾</w:t></w:r></w:p>
</w:body></w:document>`
      const docxZip = new AdmZip()
      docxZip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'))
      const docxPath = path.join(dir, '长文.docx')
      fs.writeFileSync(docxPath, docxZip.toBuffer())

      const { svcSearchOffice } = await import('../src/main/services/office-search')
      const hits = await svcSearchOffice({ filePath: docxPath, query: '长.*尾', regex: true })
      expect(hits.success).toBe(true)
      const snippet = hits.details.hits![0].snippet
      expect(snippet.length).toBeLessThanOrEqual(122) // 120 cap + two ellipses
      expect(snippet.startsWith('…')).toBe(true)
      expect(snippet.endsWith('…')).toBe(true)
      expect(snippet).toContain('xxxxxx')
      expect(snippet).not.toContain('长')
      expect(snippet).not.toContain('尾')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})

// review_20261013 中1: the matcher runs on the MAIN process — a model-generated
// catastrophic-backtracking regex pinned the event loop with no abort channel
// (window + IPC + every session frozen, no log line). The walk now carries a
// total time budget and bails into scanNote with the partial result. The clock
// is injected, so the trip is deterministic: the first call reads the base
// time, every later call is past the deadline.
describe('svcSearchOffice — match-time budget bails into scanNote (三格式同一出口)', () => {
  it('docx/xlsx/pptx stop early and report partial coverage when the budget trips', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-office-budget-'))
    process.env.HOME = fixture
    const dir = path.join(fixture, 'docs')
    fs.mkdirSync(dir)

    const paragraphs = Array.from({ length: 5 }, (_, i) => `<w:p><w:r><w:t>预算段落${i}</w:t></w:r></w:p>`).join('')
    const docxZip = new AdmZip()
    docxZip.addFile(
      'word/document.xml',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
        'utf8',
      ),
    )
    const docxPath = path.join(dir, '预算.docx')
    fs.writeFileSync(docxPath, docxZip.toBuffer())

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('数据')
    for (let r = 1; r <= 3; r++) ws.addRow(['甲', '乙', '丙'])
    const xlsxPath = path.join(dir, '预算.xlsx')
    fs.writeFileSync(xlsxPath, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer))

    const shape = (id: number) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="文本框 ${id}"/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>预算形状${id}</a:t></a:r></a:p></p:txBody></p:sp>`
    const pptxZip = new AdmZip()
    pptxZip.addFile(
      'ppt/presentation.xml',
      Buffer.from(
        `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
        'utf8',
      ),
    )
    pptxZip.addFile(
      'ppt/_rels/presentation.xml.rels',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>`,
        'utf8',
      ),
    )
    pptxZip.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shape(5)}${shape(6)}</p:spTree></p:cSld></p:sld>`,
        'utf8',
      ),
    )
    const pptxPath = path.join(dir, '预算.pptx')
    fs.writeFileSync(pptxPath, pptxZip.toBuffer())

    try {
      const { svcSearchOffice } = await import('../src/main/services/office-search')
      // First now() call mints the deadline; every later call is past it, so
      // the FIRST walked item trips the budget in each format's loop. Fresh
      // clock per call — a shared counter would shift the next call's base.
      const tripped = () => {
        let calls = 0
        return { budgetMs: 1_000, checkEvery: 1, now: () => (calls++ === 0 ? 0 : 10_000) }
      }

      const docx = await svcSearchOffice({ filePath: docxPath, query: '预算段落' }, tripped())
      expect(docx.success).toBe(true)
      expect(docx.details.totalMatches).toBe(0) // checked before the first match
      expect(docx.details.scanNote).toContain('时长预算')

      const xlsx = await svcSearchOffice({ filePath: xlsxPath, query: '甲' }, tripped())
      expect(xlsx.success).toBe(true)
      expect(xlsx.details.totalMatches).toBe(0)
      expect(xlsx.details.scanNote).toContain('时长预算')

      const pptx = await svcSearchOffice({ filePath: pptxPath, query: '预算形状' }, tripped())
      expect(pptx.success).toBe(true)
      expect(pptx.details.totalMatches).toBe(0)
      expect(pptx.details.scanNote).toContain('时长预算')

      // The formatter surfaces the note (the model's only signal it saw a part):
      const { formatOfficeSearchResult } = await import('../src/renderer/src/agent/office-search-format')
      expect(formatOfficeSearchResult(docx)).toContain('时长预算')
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('default opts (no injection) scan everything — negative control', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const prevHome = process.env.HOME
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-office-budget-'))
    process.env.HOME = fixture
    const dir = path.join(fixture, 'docs')
    fs.mkdirSync(dir)
    const docxZip = new AdmZip()
    docxZip.addFile(
      'word/document.xml',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正常段落</w:t></w:r></w:p></w:body></w:document>`,
        'utf8',
      ),
    )
    const docxPath = path.join(dir, '正常.docx')
    fs.writeFileSync(docxPath, docxZip.toBuffer())
    try {
      const { svcSearchOffice } = await import('../src/main/services/office-search')
      const r = await svcSearchOffice({ filePath: docxPath, query: '正常段落' })
      expect(r.success).toBe(true)
      expect(r.details.totalMatches).toBe(1)
      expect(r.details.scanNote).toBeUndefined()
    } finally {
      process.env.HOME = prevHome
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
})
