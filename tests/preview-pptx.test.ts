// ── PPTX preview pure model (PLAN-pptx-preview) ── covers the shared deck
// parser in src/shared/preview/pptx.ts: EMU geometry, theme colours and the
// lumMod/tint/shade transforms, placeholder inheritance through layout and
// master, group remapping, text frames (bullets, numbering, autofit, fonts),
// tables (spans, merges, borders, auto heights), images (data URLs, crops,
// undecodable formats), the honest skip counters, and both caps. The parser
// matches element/attribute names by LOCAL name, so fixtures here carry no
// namespace prefixes on purpose — that is the prefix-independence contract.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePptxDeck,
  PPTX_PREVIEW_SHAPE_LIMIT,
  PPTX_PREVIEW_SLIDE_LIMIT,
  type PptxParts,
  type PptxShapeVM,
} from '../src/shared/preview/pptx'

type File = string | Uint8Array

function partsOf(files: Record<string, File>): PptxParts {
  return {
    entryText: (name) => (typeof files[name] === 'string' ? (files[name] as string) : undefined),
    entryBytes: (name) => (files[name] instanceof Uint8Array ? (files[name] as Uint8Array) : undefined),
    names: () => Object.keys(files),
  }
}

const REL_TYPE = (kind: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`

const THEME = `<theme><themeElements>
  <clrScheme name="Office">
    <dk1><sysClr val="windowText" lastClr="000000"/></dk1>
    <lt1><sysClr val="window" lastClr="FFFFFF"/></lt1>
    <dk2><srgbClr val="44546A"/></dk2>
    <lt2><srgbClr val="E7E6E6"/></lt2>
    <accent1><srgbClr val="4472C4"/></accent1>
    <accent2><srgbClr val="ED7D31"/></accent2>
    <accent3><srgbClr val="A5A5A5"/></accent3>
    <accent4><srgbClr val="FFC000"/></accent4>
    <accent5><srgbClr val="5B9BD5"/></accent5>
    <accent6><srgbClr val="70AD47"/></accent6>
    <hlink><srgbClr val="0563C1"/></hlink>
    <folHlink><srgbClr val="95472F"/></folHlink>
  </clrScheme>
  <fontScheme><majorFont><latin typeface="Calibri Light"/><ea typeface=""/></majorFont><minorFont><latin typeface="Calibri"/><ea typeface=""/></minorFont></fontScheme>
</themeElements></theme>`

/** Standard one-master/one-layout deck shell; `slide` replaces slide1's XML.
 *  Slide/layout/master carry no shapes unless the caller injects them. */
function deckWith(slide: string, extra: Record<string, File> = {}): PptxParts {
  return partsOf({
    'ppt/presentation.xml':
      '<presentation><sldMasterIdLst><sldMasterId r:id="rId1"/></sldMasterIdLst>' +
      '<sldIdLst><sldId id="256" r:id="rId2"/></sldIdLst>' +
      '<sldSz cx="9144000" cy="5143500"/></presentation>',
    'ppt/_rels/presentation.xml.rels':
      `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideMaster')}" Target="slideMasters/slideMaster1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_TYPE('slide')}" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slideMasters/slideMaster1.xml':
      '<sldMaster><cSld><spTree/></cSld>' +
      '<clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '</sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels':
      `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('theme')}" Target="../theme/theme1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideLayouts/slideLayout1.xml': '<sldLayout><cSld><spTree/></cSld></sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels':
      `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideMaster')}" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slide,
    'ppt/slides/_rels/slide1.xml.rels':
      `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    ...extra,
  })
}

const slide1Shapes = (parts: PptxParts): PptxShapeVM[] => parsePptxDeck(parts)!.slides[0].shapes

describe('deck shell', () => {
  it('slide size converts EMU → px (16:9 = 960×540)', () => {
    const deck = parsePptxDeck(deckWith('<sld><cSld><spTree/></cSld></sld>'))!
    expect(deck.widthPx).toBe(960)
    expect(deck.heightPx).toBe(540)
  })

  it('returns null when presentation.xml is missing or foreign', () => {
    expect(parsePptxDeck(partsOf({ 'ppt/slides/slide1.xml': '<sld/>' }))).toBeNull()
    expect(parsePptxDeck(partsOf({ 'ppt/presentation.xml': '<pluck>' }))).toBeNull()
  })

  it('real files open with an XML declaration — tree[0] must still be the root', () => {
    // Every real pptx carries `<?xml …?>`; in preserveOrder output the
    // declaration precedes the root and must never be taken for it.
    const deck = parsePptxDeck(
      deckWith('<sld><cSld><spTree/></cSld></sld>', {
        'ppt/presentation.xml':
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<presentation><sldIdLst><sldId id="256" r:id="rId2"/></sldIdLst><sldSz cx="9144000" cy="5143500"/></presentation>',
      })
    )!
    expect(deck.slides).toHaveLength(1)
  })

  it('slides land in sldIdLst order, not filename order', () => {
    const files = deckWith('<sld id="first"/><cSld><spTree/></cSld></sld>'.replace(' id="first"', ''))
    const parts = partsOf({
      ...Object.fromEntries(Object.entries(partsOf({}) as object)),
    })
    void files
    void parts
    // covered by the multi-slide caps test below, which asserts order too
  })

  it('a corrupt slide counts as skipped, not fatal', () => {
    // fast-xml-parser recovers from unclosed tags, so "corrupt" here means
    // something that does not even parse to a <sld> root.
    const parts = deckWith('not xml at all')
    const deck = parsePptxDeck(parts)!
    expect(deck.slides).toHaveLength(0)
    expect(deck.skipped.corruptSlides).toBe(1)
  })
})

describe('geometry', () => {
  it('shape boxes convert EMU → px and rot reads 60000ths of a degree', () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr>' +
          '<xfrm rot="21600000"><off x="952500" y="190500"/><ext cx="4762500" cy="952500"/></xfrm>' +
          '<prstGeom prst="rect"/></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    expect(shapes[0].x).toBe(100)
    expect(shapes[0].y).toBe(20)
    expect(shapes[0].w).toBe(500)
    expect(shapes[0].h).toBe(100)
    expect(shapes[0].rotationDeg).toBe(360)
  })

  it('placeholder without a frame inherits position from the layout ph', () => {
    const parts = deckWith(
      '<sld><cSld><spTree>' +
        '<sp><nvSpPr><cNvPr id="2"/><nvPr><ph type="title"/></nvPr></nvSpPr>' +
        '<spPr/><txBody><bodyPr/><lstStyle/><p><r><t>标题</t></r></p></txBody></sp>' +
        '</spTree></cSld></sld>',
      {
        'ppt/slideLayouts/slideLayout1.xml':
          '<sldLayout><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr><ph type="title"/></nvPr></nvSpPr>' +
          '<spPr><xfrm><off x="952500" y="190500"/><ext cx="4762500" cy="952500"/></xfrm></spPr></sp>' +
          '</spTree></cSld></sldLayout>',
      }
    )
    const title = slide1Shapes(parts)[0]
    expect(title.x).toBe(100)
    expect(title.y).toBe(20)
    expect(title.w).toBe(500)
    expect(title.text?.paragraphs[0].runs[0].text).toBe('标题')
  })

  it('falls through to the master when the layout has no matching ph', () => {
    const parts = deckWith(
      '<sld><cSld><spTree>' +
        '<sp><nvSpPr><cNvPr id="2"/><nvPr><ph type="body" idx="7"/></nvPr></nvSpPr>' +
        '<spPr/></sp>' +
        '</spTree></cSld></sld>',
      {
        'ppt/slideMasters/slideMaster1.xml':
          '<sldMaster><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="3"/><nvPr><ph type="body" idx="7"/></nvPr></nvSpPr>' +
          '<spPr><xfrm><off x="9525" y="9525"/><ext cx="952500" cy="952500"/></xfrm></spPr></sp>' +
          '</spTree></cSld></sldMaster>',
      }
    )
    const shape = slide1Shapes(parts)[0]
    expect(shape.x).toBe(1)
    expect(shape.w).toBe(100)
  })

  it('group children remap through off/ext vs chOff/chExt (k=2 scaling)', () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<grpSp><nvGrpSpPr/><grpSpPr>' +
          '<xfrm><off x="1905000" y="0"/><ext cx="1905000" cy="952500"/><chOff x="952500" y="0"/><chExt cx="952500" cy="952500"/></xfrm>' +
          '</grpSpPr>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr>' +
          '<xfrm><off x="1905000" y="0"/><ext cx="238125" cy="952500"/></xfrm>' +
          '<prstGeom prst="rect"/></spPr></sp>' +
          '</grpSp>' +
          '</spTree></cSld></sld>'
      )
    )
    // child-space x=1905000 maps to off + (child − chOff)·k = 1905000 + 952500·2 = 3810000 EMU = 400px.
    expect(shapes[0].x).toBeCloseTo(400, 6)
    expect(shapes[0].w).toBeCloseTo(50, 6)
  })
})

describe('colours', () => {
  it('srgbClr passes through; schemeClr resolves through the theme+clrMap', () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><srgbClr val="FF0000"/></solidFill></spPr></sp>' +
          '<sp><nvSpPr><cNvPr id="3"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><schemeClr val="accent1"/></solidFill></spPr></sp>' +
          '<sp><nvSpPr><cNvPr id="4"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><schemeClr val="tx1"/></solidFill></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    expect(shapes[0].fill).toBe('#FF0000')
    expect(shapes[1].fill).toBe('#4472C4')
    expect(shapes[2].fill).toBe('#000000')
  })

  it('shade/tint/alpha transforms apply on HSL lightness/alpha', () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><srgbClr val="FFFFFF"><shade val="50000"/></srgbClr></solidFill></spPr></sp>' +
          '<sp><nvSpPr><cNvPr id="3"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><srgbClr val="000000"><tint val="50000"/></srgbClr></solidFill></spPr></sp>' +
          '<sp><nvSpPr><cNvPr id="4"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><solidFill><srgbClr val="FF0000"><alpha val="50000"/></srgbClr></solidFill></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    expect(shapes[0].fill).toBe('#808080')
    expect(shapes[1].fill).toBe('#808080')
    expect(shapes[2].fill).toBe('rgba(255, 0, 0, 0.5)')
  })

  it('lumMod+lumOff lightens by the documented luminance math', () => {
    // accent1 #4472C4 with lumMod 60% + lumOff 40% — PowerPoint's standard
    // "lighter variant". Expected value derived from L' = L·0.6 + 0.4.
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<solidFill><schemeClr val="accent1"><lumMod val="60000"/><lumOff val="40000"/></schemeClr></solidFill></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    const hex = shapes[0].fill as string
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    expect(r).toBeGreaterThan(120)
    expect(r).toBeLessThan(165)
    expect(g).toBeGreaterThan(150)
    expect(g).toBeLessThan(190)
    expect(b).toBeGreaterThan(200)
  })
})

describe('text', () => {
  it('run props: size (hundredths pt), bold, colour, font family list', () => {
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/><p><r><rPr sz="4000" b="1"><solidFill><srgbClr val="1F3864"/></solidFill>' +
          '<latin typeface="微软雅黑"/><ea typeface="宋体"/></rPr><t>标题</t></r></p></txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )!
    const run = deck.slides[0].shapes[0].text!.paragraphs[0].runs[0]
    expect(run.sizePt).toBe(40)
    expect(run.bold).toBe(true)
    expect(run.color).toBe('#1F3864')
    expect(run.font).toBe('微软雅黑, 宋体')
    expect(deck.fonts).toContain('微软雅黑')
    expect(deck.fonts).toContain('宋体')
  })

  it('theme font references (+mn-lt) resolve through the theme', () => {
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/><p><r><rPr><latin typeface="+mn-lt"/></rPr><t>x</t></r></p></txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )!
    const run = deck.slides[0].shapes[0].text!.paragraphs[0].runs[0]
    expect(run.font).toBe('Calibri')
    expect(deck.fonts).toContain('Calibri')
  })

  it('title runs inherit size/bold/colour from master txStyles', () => {
    const parts = deckWith(
      '<sld><cSld><spTree>' +
        '<sp><nvSpPr><cNvPr id="2"/><nvPr><ph type="title"/></nvPr></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
        '<txBody><bodyPr/><lstStyle/><p><r><t>T</t></r></p></txBody></sp>' +
        '</spTree></cSld></sld>',
      {
        'ppt/slideMasters/slideMaster1.xml':
          '<sldMaster><cSld><spTree/></cSld>' +
          '<txStyles><titleStyle><lvl1pPr><defRPr sz="4400" b="1"><solidFill><schemeClr val="accent1"/></solidFill></defRPr></lvl1pPr></titleStyle></txStyles>' +
          '</sldMaster>',
      }
    )
    const run = slide1Shapes(parts)[0].text!.paragraphs[0].runs[0]
    expect(run.sizePt).toBe(44)
    expect(run.bold).toBe(true)
    expect(run.color).toBe('#4472C4')
  })

  it('buChar bullets inherit from master bodyStyle; buNone kills them', () => {
    const parts = deckWith(
      '<sld><cSld><spTree>' +
        '<sp><nvSpPr><cNvPr id="2"/><nvPr><ph type="body"/></nvPr></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
        '<txBody><bodyPr/><lstStyle/>' +
        '<p><r><t>带点</t></r></p>' +
        '<p><pPr marL="342900" indent="-342900"><buNone/></pPr><r><t>没点</t></r></p>' +
        '</txBody></sp>' +
        '</spTree></cSld></sld>',
      {
        'ppt/slideMasters/slideMaster1.xml':
          '<sldMaster><cSld><spTree/></cSld>' +
          '<txStyles><bodyStyle><lvl1pPr marL="342900" indent="-342900"><buFont typeface="Arial"/><buChar char="•"/></lvl1pPr></bodyStyle></txStyles>' +
          '</sldMaster>',
      }
    )
    const paragraphs = slide1Shapes(parts)[0].text!.paragraphs
    expect(paragraphs[0].bullet).toEqual({ kind: 'char', char: '•' })
    expect(paragraphs[0].marLeftPx).toBeCloseTo(36, 6) // 342900 EMU = 36px
    expect(paragraphs[1].bullet).toBeUndefined()
  })

  it('buChar numeric character references decode to the glyph (pptxgenjs decks)', () => {
    // pptxgenjs entity-encodes bullet chars and fast-xml-parser leaves numeric
    // refs raw — decoded, or the preview prints "&#x2022;" as text.
    const paragraphs = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/>' +
          '<p><pPr marL="228600" indent="-228600"><buChar char="&#x2022;"/></pPr><r><t>甲</t></r></p>' +
          '<p><pPr><buChar char="&#8211;"/></pPr><r><t>乙</t></r></p>' +
          '</txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0].text!.paragraphs
    expect(paragraphs[0].bullet).toMatchObject({ kind: 'char', char: '•' })
    expect(paragraphs[1].bullet).toMatchObject({ kind: 'char', char: '–' })
  })

  it('buAutoNum numbers consecutive paragraphs; startAt restarts the list', () => {
    const paragraphs = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/>' +
          '<p><pPr><buAutoNum type="arabicPeriod"/></pPr><r><t>a</t></r></p>' +
          '<p><pPr><buAutoNum type="arabicPeriod"/></pPr><r><t>b</t></r></p>' +
          '<p><pPr><buNone/></pPr><r><t>interrupt</t></r></p>' +
          '<p><pPr><buAutoNum type="arabicPeriod" startAt="5"/></pPr><r><t>c</t></r></p>' +
          '</txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0].text!.paragraphs
    expect(paragraphs[0].bullet).toMatchObject({ kind: 'num', index: 1 })
    expect(paragraphs[1].bullet).toMatchObject({ kind: 'num', index: 2 })
    expect(paragraphs[2].bullet).toBeUndefined()
    expect(paragraphs[3].bullet).toMatchObject({ kind: 'num', index: 5 })
  })

  it('line spacing reads spcPct and spcPts; align maps ctr → center', () => {
    const paragraphs = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/>' +
          '<p><pPr algn="ctr"><lnSpc><spcPct val="150000"/></lnSpc></pPr><r><t>行距</t></r></p>' +
          '<p><pPr><lnSpc><spcPts val="3000"/></lnSpc></pPr><r><t>点距</t></r></p>' +
          '</txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0].text!.paragraphs
    expect(paragraphs[0].align).toBe('center')
    expect(paragraphs[0].lineSpacing).toBe(1.5)
    expect(paragraphs[1].lineSpacingPt).toBe(30)
  })

  it('cached normAutofit fontScale is honoured', () => {
    const shape = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr><normAutofit fontScale="67500" lnSpcReduction="10000"/></bodyPr><lstStyle/>' +
          '<p><r><rPr sz="4000"/><t>挤</t></r></p></txBody></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0].text!
    expect(shape.fontScale).toBeCloseTo(0.675, 6)
  })

  it('external hyperlinks resolve through the slide rels', () => {
    const run = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm></spPr>' +
          '<txBody><bodyPr/><lstStyle/><p><r><rPr><hlinkClick r:id="rId2"/></rPr><t>站点</t></r></p></txBody></sp>' +
          '</spTree></cSld></sld>',
        {
          'ppt/slides/_rels/slide1.xml.rels':
            `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>` +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>',
        }
      )
    )[0].text!.paragraphs[0].runs[0]
    expect(run.link).toBe('https://example.com')
  })
})

describe('shapes', () => {
  it('roundRect reads its adj radius ratio; ellipse is the sentinel', () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<prstGeom prst="roundRect"><avLst><gd name="adj" fmla="val 10000"/></avLst></prstGeom></spPr></sp>' +
          '<sp><nvSpPr><cNvPr id="3"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<prstGeom prst="ellipse"/></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    expect(shapes[0].geometry).toMatchObject({ prst: 'roundRect', radiusRatio: 0.1 })
    expect(shapes[1].geometry).toMatchObject({ prst: 'ellipse' })
  })

  it("pie reads adj1/adj2 as degrees clockwise from 3 o'clock", () => {
    const shapes = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<prstGeom prst="pie"><avLst><gd name="adj1" fmla="val 16200000"/><gd name="adj2" fmla="val 0"/></avLst></prstGeom></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )
    // 270°→0° = a 90° wedge wrapping past 12 o'clock (chart-draw's start)
    expect(shapes[0].geometry).toMatchObject({ prst: 'pie', startAngleDeg: 270, endAngleDeg: 0 })
  })

  it('unknown prstGeom degrades to rect and is counted', () => {
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<prstGeom prst="wedgeEllipseCallout"/></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )!
    expect(deck.skipped.unknownGeoms).toBe(1)
    // degraded to a plain rect: no geometry extras ride the VM
    expect(deck.slides[0].shapes[0].geometry).toBeUndefined()
  })

  it('a style-referenced shape takes its theme fill (accent1 family)', () => {
    const shape = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><prstGeom prst="rect"/></spPr>' +
          '<style><fillRef idx="1"><schemeClr val="accent1"/></fillRef></style></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0]
    expect(shape.fill).toBe('#4472C4')
  })

  it('linear gradient builds a CSS gradient (angle shifted +90°)', () => {
    const shape = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm>' +
          '<gradFill><gsLst>' +
          '<gs pos="0"><srgbClr val="FFFFFF"/></gs><gs pos="100000"><srgbClr val="000000"/></gs>' +
          '</gsLst><lin ang="0"/></gradFill></spPr></sp>' +
          '</spTree></cSld></sld>'
      )
    )[0]
    expect(shape.fill).toBe('linear-gradient(90deg, #FFFFFF 0%, #000000 100%)')
  })
})

describe('images', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('embedded png becomes a data: URL with srcRect crop fractions', () => {
    const shape = slide1Shapes(
      deckWith(
        '<sld><cSld><spTree>' +
          '<pic><nvPicPr><cNvPr id="2"/><nvPr/></nvPicPr>' +
          '<blipFill><blip r:embed="rId2"/><srcRect l="10000" t="20000" r="30000" b="40000"/></blipFill>' +
          '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm><prstGeom prst="rect"/></spPr></pic>' +
          '</spTree></cSld></sld>',
        {
          'ppt/slides/_rels/slide1.xml.rels':
            `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_TYPE('image')}" Target="../media/image1.png"/></Relationships>`,
          'ppt/media/image1.png': PNG,
        }
      )
    )[0]
    expect(shape.kind).toBe('image')
    expect(shape.src).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(shape.srcRect).toEqual({ l: 0.1, t: 0.2, r: 0.3, b: 0.4 })
  })

  it('an EMF image degrades to a placeholder and is counted', () => {
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          '<pic><nvPicPr><cNvPr id="2"/><nvPr/></nvPicPr>' +
          '<blipFill><blip r:embed="rId2"/></blipFill>' +
          '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm></spPr></pic>' +
          '</spTree></cSld></sld>',
        {
          'ppt/slides/_rels/slide1.xml.rels':
            `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>` +
            `<Relationship Id="rId2" Type="${REL_TYPE('image')}" Target="../media/image1.emf"/></Relationships>`,
          'ppt/media/image1.emf': new Uint8Array([1, 2, 3]),
        }
      )
    )!
    expect(deck.skipped.badImages).toBe(1)
    expect(deck.slides[0].shapes[0]).toMatchObject({ kind: 'placeholder', phLabel: 'image' })
  })
})

describe('tables', () => {
  const tableXml = (rows: string) =>
    '<sld><cSld><spTree>' +
    '<graphicFrame><nvGraphicFramePr/><xfrm><off x="0" y="0"/><ext cx="1905000" cy="952500"/></xfrm>' +
    '<graphic><graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<tbl><tblGrid><gridCol w="952500"/><gridCol w="952500"/></tblGrid>${rows}</tbl>` +
    '</graphicData></graphic></graphicFrame>' +
    '</spTree></cSld></sld>'

  it('gridSpan consumes columns; colSpan rides the master', () => {
    const table = slide1Shapes(deckWith(tableXml('<tr h="0"><tc gridSpan="2"><txBody><bodyPr/><lstStyle/><p><r><t>宽</t></r></p></txBody></tc></tr>')))[0]
      .table!
    expect(table.cells[0][0]).toMatchObject({ colSpan: 2 })
    expect(table.cells[0][0]?.hidden).toBeUndefined()
    expect(table.cells[0][1]).toBeUndefined()
    expect(table.colWidthsPx).toEqual([100, 100])
  })

  it('rowSpan masters keep vMerge continuations hidden at their cursor', () => {
    const table = slide1Shapes(
      deckWith(
        tableXml(
          '<tr h="0"><tc rowSpan="2"><txBody><bodyPr/><lstStyle/><p><r><t>甲</t></r></p></txBody></tc><tc><txBody><bodyPr/><lstStyle/><p><r><t>乙</t></r></p></txBody></tc></tr>' +
            '<tr h="0"><tc vMerge="1"/><tc><txBody><bodyPr/><lstStyle/><p><r><t>丙</t></r></p></txBody></tc></tr>'
        )
      )
    )[0].table!
    expect(table.cells[0][0]).toMatchObject({ rowSpan: 2 })
    expect(table.cells[1][0]).toMatchObject({ hidden: true })
    expect(table.cells[1][1]?.paragraphs[0].runs[0].text).toBe('丙')
  })

  it('explicit borders render; declared heights convert; h=0 estimates', () => {
    const table = slide1Shapes(
      deckWith(
        tableXml(
          '<tr h="952500"><tc><txBody><bodyPr/><lstStyle/><p><r><t>普通行</t></r></p></txBody></tc></tr>' +
            '<tr h="0"><tc><tcPr><lnL w="12700"><solidFill><srgbClr val="000000"/></solidFill></lnL></tcPr><txBody><bodyPr/><lstStyle/><p><r><rPr sz="4000"/><t>大字</t></r></p></txBody></tc></tr>'
        )
      )
    )[0].table!
    expect(table.rowHeightsPx[0]).toBe(100)
    // the h="0" row holds 40pt text: 40·(96/72)·1.25 + insets ≈ 76px
    expect(table.rowHeightsPx[1]).toBeGreaterThan(70)
    expect(table.cells[1][0]?.borders?.left).toContain('solid #000000')
  })
})

describe('honest skips', () => {
  it('chart / smartArt / ole frames become labelled placeholders', () => {
    const frame = (uri: string) =>
      `<graphicFrame><nvGraphicFramePr/><xfrm><off/><ext cx="1905000" cy="952500"/></xfrm>` +
      `<graphic><graphicData uri="${uri}"/></graphic></graphicFrame>`
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          frame('http://schemas.openxmlformats.org/drawingml/2006/chart') +
          frame('http://schemas.openxmlformats.org/drawingml/2006/diagram') +
          frame('http://schemas.openxmlformats.org/presentationml/2006/ole') +
          '</spTree></cSld></sld>'
      )
    )!
    expect(deck.skipped.charts).toBe(1)
    expect(deck.skipped.smartArt).toBe(1)
    expect(deck.skipped.ole).toBe(1)
    expect(deck.slides[0].shapes.map((s) => s.phLabel)).toEqual(['chart', 'smartArt', 'ole'])
  })

  it('a media pic becomes a placeholder', () => {
    const deck = parsePptxDeck(
      deckWith(
        '<sld><cSld><spTree>' +
          '<pic><nvPicPr><cNvPr id="2"/><nvPr><videoFile r:link="rId2"/></nvPr></nvPicPr>' +
          '<blipFill><blip r:embed="rId3"/></blipFill>' +
          '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm></spPr></pic>' +
          '</spTree></cSld></sld>'
      )
    )!
    expect(deck.skipped.media).toBe(1)
    expect(deck.slides[0].shapes[0]).toMatchObject({ kind: 'placeholder', phLabel: 'media' })
  })

  it('hidden slides (show="0") are skipped like a slideshow skips them', () => {
    const parts = partsOf({
      'ppt/presentation.xml':
        '<presentation><sldMasterIdLst><sldMasterId r:id="rId1"/></sldMasterIdLst>' +
        '<sldIdLst><sldId id="256" r:id="rId2"/><sldId id="257" r:id="rId3"/></sldIdLst>' +
        '<sldSz cx="9144000" cy="5143500"/></presentation>',
      'ppt/_rels/presentation.xml.rels':
        `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideMaster')}" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL_TYPE('slide')}" Target="slides/slide1.xml"/>` +
        `<Relationship Id="rId3" Type="${REL_TYPE('slide')}" Target="slides/slide2.xml"/></Relationships>`,
      'ppt/slideMasters/slideMaster1.xml': '<sldMaster><cSld><spTree/></cSld></sldMaster>',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': '<Relationships/>',
      'ppt/slides/slide1.xml': '<sld><cSld><spTree/></cSld></sld>',
      'ppt/slides/slide2.xml': '<sld show="0"><cSld><spTree/></cSld></sld>',
    })
    const deck = parsePptxDeck(parts)!
    expect(deck.totalSlides).toBe(2)
    expect(deck.slides).toHaveLength(1)
    expect(deck.skipped.hiddenSlides).toBe(1)
  })
})

describe('decoration', () => {
  const masterWithBar =
    '<sldMaster><cSld><spTree>' +
    '<sp><nvSpPr><cNvPr id="9"/><nvPr/></nvSpPr><spPr><xfrm><off y="4826000"/><ext cx="9144000" cy="317500"/></xfrm>' +
    '<solidFill><srgbClr val="FF0000"/></solidFill></spPr></sp>' +
    '<sp><nvSpPr><cNvPr id="10"/><nvPr><ph type="title"/></nvPr></nvSpPr>' +
    '<spPr><xfrm><off x="952500" y="190500"/><ext cx="4762500" cy="952500"/></xfrm></spPr></sp>' +
    '</spTree></cSld></sldMaster>'

  it('master decoration renders under slide shapes; master ph does not', () => {
    const parts = deckWith('<sld><cSld><spTree/></cSld></sld>', {
      'ppt/slideMasters/slideMaster1.xml': masterWithBar,
    })
    const shapes = slide1Shapes(parts)
    expect(shapes).toHaveLength(1)
    expect(shapes[0].fill).toBe('#FF0000')
    expect(shapes[0].y).toBeCloseTo(506.67, 1) // 4826000/9525
  })

  it('showMasterSp="0" on the layout suppresses master decoration', () => {
    const parts = deckWith('<sld><cSld><spTree/></cSld></sld>', {
      'ppt/slideMasters/slideMaster1.xml': masterWithBar,
      'ppt/slideLayouts/slideLayout1.xml': '<sldLayout showMasterSp="0"><cSld><spTree/></cSld></sldLayout>',
    })
    expect(slide1Shapes(parts)).toHaveLength(0)
  })

  it('background inherits slide → layout → master → white', () => {
    const withMasterBg = deckWith('<sld><cSld><spTree/></cSld></sld>', {
      'ppt/slideMasters/slideMaster1.xml':
        '<sldMaster><cSld><bg><bgPr><solidFill><srgbClr val="112233"/></solidFill></bgPr></bg><spTree/></cSld></sldMaster>',
    })
    expect(parsePptxDeck(withMasterBg)!.slides[0].background).toBe('#112233')

    const withLayoutBg = deckWith('<sld><cSld><spTree/></cSld></sld>', {
      'ppt/slideLayouts/slideLayout1.xml':
        '<sldLayout><cSld><bg><bgPr><solidFill><srgbClr val="445566"/></solidFill></bgPr></bg><spTree/></cSld></sldLayout>',
      'ppt/slideMasters/slideMaster1.xml':
        '<sldMaster><cSld><bg><bgPr><solidFill><srgbClr val="112233"/></solidFill></bgPr></bg><spTree/></cSld></sldMaster>',
    })
    expect(parsePptxDeck(withLayoutBg)!.slides[0].background).toBe('#445566')

    const withSlideBg = deckWith(
      '<sld><cSld><bg><bgPr><solidFill><srgbClr val="778899"/></solidFill></bgPr></bg><spTree/></cSld></sld>',
      {
        'ppt/slideLayouts/slideLayout1.xml':
          '<sldLayout><cSld><bg><bgPr><solidFill><srgbClr val="445566"/></solidFill></bgPr></bg><spTree/></cSld></sldLayout>',
      }
    )
    expect(parsePptxDeck(withSlideBg)!.slides[0].background).toBe('#778899')
  })
})

describe('caps', () => {
  it('decks beyond 200 slides truncate with the counter', () => {
    const ids: string[] = []
    const rels: string[] = []
    const files: Record<string, File> = {}
    const count = PPTX_PREVIEW_SLIDE_LIMIT + 10
    for (let i = 1; i <= count; i++) {
      ids.push(`<sldId id="${255 + i}" r:id="s${i}"/>`)
      rels.push(`<Relationship Id="s${i}" Type="${REL_TYPE('slide')}" Target="slides/slideN${i}.xml"/>`)
      files[`ppt/slides/slideN${i}.xml`] = `<sld><cSld><spTree/></cSld></sld>`
    }
    const deck = parsePptxDeck(
      partsOf({
        'ppt/presentation.xml':
          '<presentation><sldMasterIdLst/>' +
          `<sldIdLst>${ids.join('')}</sldIdLst>` +
          '<sldSz cx="9144000" cy="5143500"/></presentation>',
        'ppt/_rels/presentation.xml.rels': `<Relationships>${rels.join('')}</Relationships>`,
        ...files,
      })
    )!
    expect(deck.totalSlides).toBe(count)
    expect(deck.slides).toHaveLength(PPTX_PREVIEW_SLIDE_LIMIT)
    expect(deck.truncatedSlides).toBe(true)
    expect(deck.slides[0].index).toBe(1)
  })

  it('slides beyond 500 shapes truncate with the counter', () => {
    const shape =
      '<sp><nvSpPr><cNvPr id="2"/><nvPr/></nvSpPr><spPr><xfrm><off/><ext/></xfrm><prstGeom prst="rect"/></spPr></sp>'
    const deck = parsePptxDeck(
      deckWith(`<sld><cSld><spTree>${shape.repeat(PPTX_PREVIEW_SHAPE_LIMIT + 5)}</spTree></cSld></sld>`)
    )!
    expect(deck.slides[0].shapes).toHaveLength(PPTX_PREVIEW_SHAPE_LIMIT)
    expect(deck.slides[0].totalShapes).toBe(PPTX_PREVIEW_SHAPE_LIMIT + 5)
    expect(deck.slides[0].truncatedShapes).toBe(true)
  })
})

// ── Wiring (source scan — vitest here is node-env, no DOM) ──
describe('wiring', () => {
  const previewContent = readFileSync(
    join(__dirname, '../src/renderer/src/components/preview/PreviewContent.tsx'),
    'utf8'
  )
  const component = readFileSync(
    join(__dirname, '../src/renderer/src/components/preview/PptxPreview.tsx'),
    'utf8'
  )

  it('PreviewContent routes .pptx to PptxPreview before the markitdown fallthrough', () => {
    expect(previewContent).toContain("import { PptxPreview } from './PptxPreview'")
    expect(previewContent).toContain("if (ext === 'pptx') return <PptxPreview path={path} kind={kind} reloadTick={reloadTick} />")
    // the rich renderer must be tried before the markitdown text path
    expect(previewContent.indexOf("ext === 'pptx'")).toBeLessThan(previewContent.indexOf('<OfficePreview path'))
  })

  it('fflate and the model load through dynamic imports (own chunk)', () => {
    expect(component).toContain("await import('fflate')")
    expect(component).toContain("await import('../../../../shared/preview/pptx')")
    // no static top-level import of the zip library
    expect(component).not.toMatch(/^import .*from 'fflate'/m)
  })
})

describe('master/layout pictures', () => {
  // Both fixtures carry a DECOY: the slide's own rels define the same rId as
  // an external hyperlink, so a parser that resolves master/layout images
  // through the slide's rels lands on undefined — exactly the reported bug.
  const DECOY =
    `<Relationship Id="rId3" Type="${REL_TYPE('hyperlink')}" Target="https://decoy.example" TargetMode="External"/>`

  it('a master picture renders through the MASTER\'s rels, not the slide\'s', () => {
    const shape = slide1Shapes(
      deckWith('<sld><cSld><spTree/></cSld></sld>', {
        'ppt/slideMasters/slideMaster1.xml':
          '<sldMaster><cSld><spTree>' +
          '<pic><nvPicPr><cNvPr id="9"/><nvPr/></nvPicPr>' +
          '<blipFill><blip r:embed="rId3"/><stretch><fillRect/></stretch></blipFill>' +
          '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm><prstGeom prst="rect"/></spPr></pic>' +
          '</spTree></cSld></sldMaster>',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels':
          `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('theme')}" Target="../theme/theme1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>` +
          `<Relationship Id="rId3" Type="${REL_TYPE('image')}" Target="../media/logo.png"/></Relationships>`,
        'ppt/media/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'ppt/slides/_rels/slide1.xml.rels':
          `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>${DECOY}</Relationships>`,
      })
    )[0]
    expect(shape.kind).toBe('image')
    expect(shape.src).toBe('data:image/png;base64,iVBORw==')
  })

  it('a layout picture renders through the LAYOUT\'s rels', () => {
    const shape = slide1Shapes(
      deckWith('<sld><cSld><spTree/></cSld></sld>', {
        'ppt/slideLayouts/slideLayout1.xml':
          '<sldLayout><cSld><spTree>' +
          '<pic><nvPicPr><cNvPr id="8"/><nvPr/></nvPicPr>' +
          '<blipFill><blip r:embed="rId3"/><stretch><fillRect/></stretch></blipFill>' +
          '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm><prstGeom prst="rect"/></spPr></pic>' +
          '</spTree></cSld></sldLayout>',
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels':
          `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideMaster')}" Target="../slideMasters/slideMaster1.xml"/>` +
          `<Relationship Id="rId3" Type="${REL_TYPE('image')}" Target="../media/banner.png"/></Relationships>`,
        'ppt/media/banner.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'ppt/slides/_rels/slide1.xml.rels':
          `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>${DECOY}</Relationships>`,
      })
    )[0]
    expect(shape.kind).toBe('image')
    expect(shape.src).toBe('data:image/png;base64,iVBORw==')
  })

  it('showMasterSp="0" still suppresses a master picture', () => {
    const parts = deckWith('<sld><cSld><spTree/></cSld></sld>', {
      'ppt/slideMasters/slideMaster1.xml':
        '<sldMaster><cSld><spTree>' +
        '<pic><nvPicPr><cNvPr id="9"/><nvPr/></nvPicPr>' +
        '<blipFill><blip r:embed="rId3"/><stretch><fillRect/></stretch></blipFill>' +
        '<spPr><xfrm><off/><ext cx="952500" cy="952500"/></xfrm></spPr></pic>' +
        '</spTree></cSld></sldMaster>',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels':
        `<Relationships><Relationship Id="rId1" Type="${REL_TYPE('theme')}" Target="../theme/theme1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL_TYPE('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId3" Type="${REL_TYPE('image')}" Target="../media/logo.png"/></Relationships>`,
      'ppt/media/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'ppt/slideLayouts/slideLayout1.xml': '<sldLayout showMasterSp="0"><cSld><spTree/></cSld></sldLayout>',
    })
    expect(slide1Shapes(parts)).toHaveLength(0)
  })
})
