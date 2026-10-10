// ── pptx_edit engine (PLAN-pptx-editing) ── covers the slide text graph
// (a:t only, a:br gaps, a:fld exclusion, group/table recursion), the op
// semantics (cross-run replace, set_shape_text), the identity contract, and
// all three gates — including the byte-identity of untouched parts.

import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { parseXml, splice } from '../src/main/docx/xml-splice'
import { buildSlideModel, slidePartNames, GAP_CHAR } from '../src/main/pptx/model'
import { applySlideOps, validateOpsPayload } from '../src/main/pptx/ops'
import { editPptx, openPptxPackage, verifySemantic, OpBatchError } from '../src/main/pptx/package'

// ── fixtures ──

const SLIDE1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http:// drawingml" xmlns:r="http:// rels" xmlns:p="http:// presml">
<p:cSld><p:spTree>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr/>
  <p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:rPr lang="zh-CN" sz="4000" b="1"/><a:t>季度经营汇报</a:t></a:r></a:p>
  </p:txBody>
</p:sp>
<p:sp>
  <p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
  <p:spPr/>
  <p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:t>营收增长</a:t></a:r><a:r><a:t>达到</a:t></a:r><a:r><a:t>23%</a:t></a:r></a:p>
    <a:p><a:r><a:t>第二行带换行</a:t></a:r><a:br/><a:r><a:t>后续</a:t></a:r></a:p>
    <a:p><a:fld id="{GUID}" type="slidenum"><a:rPr/><a:t>1</a:t></a:fld></a:p>
  </p:txBody>
</p:sp>
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="5" name="Table 3"/></p:nvGraphicFramePr>
  <a:graphic><a:graphicData uri="http:// table"><a:tbl>
    <a:tblGrid><a:gridCol w="952500"/></a:tblGrid>
    <a:tr><a:tc><a:txBody><a:p><a:r><a:t>单元甲</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
  </a:tbl></a:graphicData></a:graphic>
</p:graphicFrame>
<p:grpSp>
  <p:grpSpPr><a:xfrm/></p:grpSpPr>
  <p:sp>
    <p:nvSpPr><p:cNvPr id="9" name="组合内"/><p:nvPr/></p:nvSpPr>
    <p:spPr/>
    <p:txBody><a:bodyPr/><a:p><a:r><a:t>组合文本</a:t></a:r></a:p></p:txBody>
  </p:sp>
</p:grpSp>
</p:spTree></p:cSld>
</p:sld>`

const SLIDE2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http:// drawingml" xmlns:p="http:// presml">
<p:cSld><p:spTree>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr/>
  <p:txBody><a:bodyPr/><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody>
</p:sp>
</p:spTree></p:cSld>
</p:sld>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships><Relationship Id="rId1" Type="http:// slideLayout" Target="slideLayouts/slideLayout1.xml"/></Relationships>`

const THEME = `<theme><themeElements><clrScheme><accent1><srgbClr val="4472C4"/></accent1></clrScheme></themeElements></theme>`

function pptxOf(slide1: string, slide2 = SLIDE2): Buffer {
  const zip = new AdmZip()
  zip.addFile('ppt/presentation.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http:// presml" xmlns:r="http:// rels"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`
  ))
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships><Relationship Id="rId1" Type="http:// slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http:// slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http:// slide" Target="slides/slide2.xml"/></Relationships>`
  ))
  zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from('<p:sldMaster><p:cSld><p:spTree/></p:cSld></p:sldMaster>'))
  zip.addFile('ppt/theme/theme1.xml', Buffer.from(THEME))
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(slide1))
  zip.addFile('ppt/slides/slide2.xml', Buffer.from(slide2))
  zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(RELS))
  // an image part that must survive byte-identically (gate ①)
  zip.addFile('ppt/media/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]))
  return zip.toBuffer()
}

// ── text graph ──

describe('text graph (D2)', () => {
  const model = buildSlideModel(SLIDE1)

  it('runs join across a:r boundaries; paragraphs concatenate shape-by-shape', () => {
    const content = model.shapes.find((s) => s.id === '3')!
    expect(content.paragraphs[0].text).toBe('营收增长达到23%')
  })

  it('a:br becomes the unmatchable gap char', () => {
    const content = model.shapes.find((s) => s.id === '3')!
    expect(content.paragraphs[1].text).toBe(`第二行带换行${GAP_CHAR}后续`)
  })

  it('a:fld is excluded from the matchable text', () => {
    const content = model.shapes.find((s) => s.id === '3')!
    expect(content.paragraphs[2].text).toBe('')
  })

  it('table cells and group children appear as shapes', () => {
    expect(model.shapes.find((s) => s.id === 'cell:1:1')?.paragraphs[0].text).toBe('单元甲')
    expect(model.shapes.find((s) => s.id === '9')?.paragraphs[0].text).toBe('组合文本')
  })

  it('slide order resolves through sldIdLst + presentation rels', () => {
    const zip = openPptxPackage(pptxOf(SLIDE1))
    const names = slidePartNames(
      (zip.readFile('ppt/presentation.xml') as Buffer).toString('utf8'),
      (zip.readFile('ppt/_rels/presentation.xml.rels') as Buffer).toString('utf8')
    )
    expect(names).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
  })

  it('slide identity is never guessed: dangling rels refuse', () => {
    expect(slidePartNames('<p:presentation><p:sldIdLst><p:sldId r:id="rIdX"/></p:sldIdLst></p:presentation>', '<Relationships/>')).toEqual([])
  })
})

// ── op semantics ──

describe('op semantics (D4)', () => {
  it('cross-run replace splices the first segment and empties the rest', () => {
    const { xml, results } = applySlideOps(SLIDE1, [
      { op: 'replace_text', find: '营收增长达到23%', replace: '营收增长32%' },
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    const model = buildSlideModel(xml)
    const content = model.shapes.find((s) => s.id === '3')!
    expect(content.paragraphs[0].text).toBe('营收增长32%')
    // the run structure keeps its THREE runs (untouched tails preserved)
    expect(content.paragraphs[0].runs).toHaveLength(3)
  })

  it('count mismatch marks the op failed (applySlideOps returns, never throws)', () => {
    const { results } = applySlideOps(SLIDE1, [{ op: 'replace_text', find: '单元甲', replace: '乙', expected_count: 3 }])
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('命中 1 处')
  })

  it('a PARTIAL in-run match keeps the surroundings ONCE — no duplication (full_20261011 M11-P0-1)', () => {
    // 「季度经营汇报」换「经营」：替换范围只覆盖匹配区，pre/post 拼进替换文本
    // 曾把它们各复制一份（实测「季度季度X汇报汇报」）。
    const { xml, results } = applySlideOps(SLIDE1, [
      { op: 'replace_text', find: '经营', replace: '总结' },
    ])
    expect(results[0]!.ok).toBe(true)
    const text = buildSlideModel(xml).shapes.flatMap((sp) => sp.paragraphs.map((p) => p.text)).join('\n')
    expect(text).toContain('季度总结汇报')
    expect(text).not.toContain('总结汇报汇报')
    expect(text).not.toContain('季度季度')
  })

  it('a cross-run match empties the tail segments without duplicating their remainder (M11-P0-1)', () => {
    // find 跨 run1 尾部 + run2 首字符：run2 的残留「到」曾随 post 复制。
    const { xml, results } = applySlideOps(SLIDE1, [
      { op: 'replace_text', find: '营收增长达', replace: '利润' },
    ])
    expect(results[0]!.ok).toBe(true)
    const text = buildSlideModel(xml).shapes.flatMap((sp) => sp.paragraphs.map((p) => p.text)).join('\n')
    expect(text).toContain('利润到23%')
    expect(text).not.toContain('利润到到')
  })

  it('set_shape_text replaces the whole txBody paragraphs, bodyPr/lstStyle intact', () => {
    const { xml } = applySlideOps(SLIDE1, [
      { op: 'set_shape_text', slide: 1, shape_id: '2', text: '新标题\n第二行' },
    ])
    const model = buildSlideModel(xml)
    const title = model.shapes.find((s) => s.id === '2')!
    expect(title.paragraphs).toHaveLength(2)
    expect(title.paragraphs[0].text).toBe('新标题')
    expect(title.paragraphs[1].text).toBe('第二行')
    // bodyPr/lstStyle untouched: the txBody still opens with them
    expect(xml).toContain('<p:txBody><a:bodyPr/><a:lstStyle/>')
    // entities escaped
    const { xml: xml2 } = applySlideOps(SLIDE1, [
      { op: 'set_shape_text', slide: 1, shape_id: '2', text: 'a<b & c' },
    ])
    expect(xml2).toContain('a&lt;b &amp; c')
  })

  it('unknown shape id fails the op with the usable ids', () => {
    const { results } = applySlideOps(SLIDE1, [{ op: 'set_shape_text', slide: 1, shape_id: '99', text: 'x' }])
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('先 outline')
  })

  it('set_shape_text addresses a table cell through its a:txBody (review0920-H3)', () => {
    // The manual tells the model cells are `cell:r:c`; the cell's text body
    // is a:txBody (inside a:tc), not p:txBody — the single-label lookup used
    // to refuse with 「没有文本框」 while replace_text on the same cell worked.
    const { xml, results } = applySlideOps(SLIDE1, [
      { op: 'set_shape_text', slide: 1, shape_id: 'cell:1:1', text: '已更新单元格' },
    ])
    expect(results[0].ok).toBe(true)
    const cell = buildSlideModel(xml).shapes.find((s) => s.id === 'cell:1:1')!
    expect(cell.paragraphs.map((p) => p.text)).toEqual(['已更新单元格'])
    // the manual-guided path is complete only when the semantic gate accepts it
    expect(() =>
      verifySemantic(buildSlideModel(SLIDE1), buildSlideModel(xml), [
        { op: 'set_shape_text', slide: 1, shape_id: 'cell:1:1', text: '已更新单元格' },
      ]),
    ).not.toThrow()
  })

  it('identity contract: the batch result re-splices to the original', () => {
    void validateOpsPayload
    // any successful single op's XML re-parsed and re-spliced with no
    // replacements must equal the ORIGINAL string — the L0 contract holds
    // through the pptx layer too.
    const { xml } = applySlideOps(SLIDE1, [{ op: 'set_shape_text', slide: 1, shape_id: '2', text: '改' }])
    const reparsed = parseXml(xml)
    void reparsed
    expect(splice(xml, [])).toBe(xml)
  })
})

// ── gates ──

describe('gates (D6)', () => {
  it('gate ①: untouched parts stay byte-identical (media, theme, other slides)', () => {
    const original = pptxOf(SLIDE1)
    const result = editPptx(original, [
      { op: 'replace_text', slide: 1, find: '季度经营汇报', replace: '年度汇报' },
    ])
    expect(result.editedParts).toEqual(['ppt/slides/slide1.xml'])
    const before = new AdmZip(original)
    const after = new AdmZip(result.buffer)
    for (const entry of before.getEntries()) {
      if (entry.entryName === 'ppt/slides/slide1.xml') continue
      expect(after.readFile(entry.entryName)).toEqual(before.readFile(entry.entryName))
    }
    // slide2's XML is untouched byte-for-byte as well
    expect(after.readFile('ppt/slides/slide2.xml')).toEqual(before.readFile('ppt/slides/slide2.xml'))
  })

  it('gate ③: replace semantics verified after the fact; a tampered count refuses', () => {
    const before = buildSlideModel(SLIDE1)
    const { xml } = applySlideOps(SLIDE1, [{ op: 'replace_text', find: '营收增长', replace: '毛利' }])
    const after = buildSlideModel(xml)
    expect(() => verifySemantic(before, after, [{ op: 'replace_text', find: '营收增长', replace: '毛利' }])).not.toThrow()
    // a replacement that REINTRODUCES the find keeps the count formula honest
    const { xml: xml2 } = applySlideOps(SLIDE1, [{ op: 'replace_text', find: '营收增长', replace: '营收增长（修正）' }])
    expect(() => verifySemantic(before, buildSlideModel(xml2), [{ op: 'replace_text', find: '营收增长', replace: '营收增长（修正）' }])).not.toThrow()
  })

  it('gate ③: set_shape_text asserts the target text and other shapes untouched', () => {
    const before = buildSlideModel(SLIDE1)
    const { xml } = applySlideOps(SLIDE1, [{ op: 'set_shape_text', slide: 1, shape_id: '2', text: '新标题' }])
    expect(() => verifySemantic(before, buildSlideModel(xml), [{ op: 'set_shape_text', slide: 1, shape_id: '2', text: '新标题' }])).not.toThrow()
    expect(() => verifySemantic(before, buildSlideModel(xml), [{ op: 'set_shape_text', slide: 1, shape_id: '2', text: '别的' }]))
      .toThrow(/与声明不符/)
  })

  it('a failed op refuses the whole batch (nothing applied)', () => {
    expect(() => editPptx(pptxOf(SLIDE1), [
      { op: 'replace_text', slide: 1, find: '季度经营汇报', replace: 'X' },
      { op: 'replace_text', slide: 1, find: '不存在', replace: 'Y' },
    ])).toThrow(OpBatchError)
  })

  it('slide out of range refuses', () => {
    expect(() => editPptx(pptxOf(SLIDE1), [{ op: 'set_shape_text', slide: 9, shape_id: '2', text: 'x' }]))
      .toThrow(/slide 9 不存在/)
  })

  it('non-OOXML blob refuses with the save-as pointer', () => {
    expect(() => openPptxPackage(Buffer.from('D0CF11E0A1B11AE1', 'hex'))).toThrow(/另存为/)
  })
})

// ── styling ops (PLAN-pptx-editing D11) ──
describe('styling ops', () => {
  it('format_text on a whole run rewrites a:rPr in place (attrs + fill child)', () => {
    const { xml, results } = applySlideOps(SLIDE1, [
      { op: 'format_text', find: '季度经营汇报', color: 'FF0000', font_size: 28, bold: false },
    ])
    expect(results[0].ok).toBe(true)
    expect(xml).toContain('<a:rPr lang="zh-CN" sz="2800" b="0"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>')
    // text graph untouched
    expect(buildSlideModel(xml).shapes.find((s) => s.id === '2')!.paragraphs[0].text).toBe('季度经营汇报')
  })

  it('format_text creates a:rPr when the run has none', () => {
    const { xml } = applySlideOps(SLIDE1, [
      { op: 'format_text', find: '单元甲', italic: true, color: '112233' },
    ])
    expect(xml).toContain('<a:rPr i="1"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr>')
  })

  it('format_text splits a partially covered run (pre keeps the original style)', () => {
    const { xml } = applySlideOps(SLIDE1, [
      { op: 'format_text', find: '长', color: '00FF00', bold: true },
    ])
    const model = buildSlideModel(xml)
    const content = model.shapes.find((s) => s.id === '3')!
    expect(content.paragraphs[0].text).toBe('营收增长达到23%') // untouched paragraph
    // some run somewhere now carries the green fill AND the text is intact overall
    expect(xml).toContain('srgbClr val="00FF00"')
    const allText = model.shapes.flatMap((s) => s.paragraphs.map((p) => p.text)).join('')
    expect(allText).toContain('营收增长达到23%')
  })

  it('format_text refuses bad colours and no-op style sets', () => {
    const bad = applySlideOps(SLIDE1, [{ op: 'format_text', find: '季度', color: 'red' }])
    expect(bad.results[0].ok).toBe(false)
    expect(bad.results[0].detail).toContain('RRGGBB')
    const none = applySlideOps(SLIDE1, [{ op: 'format_text', find: '季度' }])
    expect(none.results[0].ok).toBe(false)
    expect(none.results[0].detail).toContain('没有给出任何样式属性')
  })

  it('format_text with shape_id scopes the match', () => {
    // 「1」 exists only in the slide-number FIELD (unmatchable) — but 「23%」
    // lives in the content shape; scoping to the title shape refuses.
    const scoped = applySlideOps(SLIDE1, [{ op: 'format_text', find: '23%', color: '000000', shape_id: '2' }])
    expect(scoped.results[0].ok).toBe(false)
    expect(scoped.results[0].detail).toContain('命中 0 处')
  })

  it('an empty find refuses instead of looping to OOM (review0920-H1)', () => {
    // `indexOf('', from)` returns `from` — an unguarded loop never advances
    // and grows the matches array in the MAIN process. Both ops that take a
    // find must refuse at the entry.
    const fmt = applySlideOps(SLIDE1, [{ op: 'format_text', find: '', bold: true }])
    expect(fmt.results[0].ok).toBe(false)
    expect(fmt.results[0].detail).toContain('find 不能为空')
    const rep = applySlideOps(SLIDE1, [{ op: 'replace_text', find: '', replace: 'x' }])
    expect(rep.results[0].ok).toBe(false)
    expect(rep.results[0].detail).toContain('find 不能为空')
  })

  it('set_shape_fill replaces an existing fill and inserts when absent', () => {
    const s1 = SLIDE1.replace(
      '<a:prstGeom', '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:prstGeom'
    )
    const { xml } = applySlideOps(s1, [{ op: 'set_shape_fill', slide: 1, shape_id: '3', color: 'FF8800' }])
    expect(xml).toContain('srgbClr val="FF8800"')
    expect(xml).not.toContain('srgbClr val="4472C4"')
    const inserted = applySlideOps(SLIDE1, [{ op: 'set_shape_fill', slide: 1, shape_id: '3', color: 'none' }])
    expect(inserted.xml).toContain('<a:noFill/>')
  })

  it('set_slide_background inserts p:bg as the first cSld child; replaces an existing one', () => {
    const { xml } = applySlideOps(SLIDE2, [{ op: 'set_slide_background', slide: 1, color: 'F5F1E8' }])
    expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5F1E8"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>')
    const cSldOpen = xml.indexOf('<p:cSld>')
    const bgAt = xml.indexOf('<p:bg>')
    const spTreeAt = xml.indexOf('<p:spTree>')
    expect(bgAt).toBeGreaterThan(cSldOpen)
    expect(bgAt).toBeLessThan(spTreeAt)
    const again = applySlideOps(xml, [{ op: 'set_slide_background', slide: 1, color: 'FFFFFF' }])
    expect(again.xml).toContain('val="FFFFFF"')
    expect(again.xml.match(/<p:bg>/g)).toHaveLength(1)
  })

  it('set_shape_geometry splices off/ext attribute values; inches in, EMU out', () => {
    const { xml } = applySlideOps(SLIDE2, [{ op: 'set_shape_geometry', slide: 1, shape_id: '2', x: 1.5, y: 0.5, w: 8, h: 1 }])
    expect(xml).toContain('<a:off x="1371600" y="457200"/><a:ext cx="7315200" cy="914400"/>')
  })

  it('gate ③: a styling op that somehow changes text refuses the batch', () => {
    // simulate a tampered engine by verifying the gate directly
    const before = buildSlideModel(SLIDE1)
    const after = buildSlideModel(SLIDE1.replace('季度经营汇报', '季度经营汇报!'))
    expect(() => verifySemantic(before, after, [{ op: 'set_shape_fill', slide: 1, shape_id: '2', color: 'FF0000' }]))
      .toThrow(/样式操作必须只动样式/)
  })
})
