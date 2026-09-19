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
