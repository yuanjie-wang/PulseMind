// ── deck spec → pptx buffer (PLAN-deck-layouts) ── pptxgenjs output is
//  unzipped and its slide XML read back, because a spec that looks right says
//  nothing about the bytes the user takes away. Each layout is pinned by the
//  marks a reader would notice: shape geometry tags, fill colours, bullet
//  chars, chart legends — not internal pptxgenjs call shapes.

import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { deckToPptxBuffer, DEFAULT_DECK_ACCENT } from '../src/main/office-export/deck-to-pptx'
import { parseDeckSpec } from '../src/shared/deck/spec'

/** A real 1×1 PNG — the image-layout test needs real bytes to embed. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function bufferOf(spec: unknown, images: Map<string, Buffer> = new Map()): Promise<Buffer> {
  const parsed = parseDeckSpec(spec)
  if (!parsed.ok) throw new Error(parsed.error)
  return deckToPptxBuffer(parsed.spec, images)
}

type Zip = Record<string, Uint8Array>
const slideXml = (zip: Zip, n: number): string => strFromU8(zip[`ppt/slides/slide${n}.xml`])
const count = (xml: string, needle: string): number => xml.split(needle).length - 1
/** addText boxes are also prst="rect" sp's — plain shapes are the ones with
 *  no txBody (bars, chrome, axis-adjacent geometry). */
const plainShapes = (xml: string): number => count(xml, '</p:spPr></p:sp>')

describe('deck → pptx: chrome & text layouts', () => {
  it('the cover carries title, subtitle and the accent bar', async () => {
    const zip = unzipSync(await bufferOf({ title: 'T', slides: [{ layout: 'cover', title: '季度经营回顾', subtitle: '2026 Q3' }] }))
    const xml = slideXml(zip, 1)
    expect(xml).toContain('<a:t>季度经营回顾</a:t>')
    expect(xml).toContain('<a:t>2026 Q3</a:t>')
    expect(xml).toContain(`val="${DEFAULT_DECK_ACCENT}"`)
    // no page number on a cover
    expect(xml).not.toContain('<a:t>1</a:t>')
  })

  // review0924 M6: the schema lets ANY slide carry a note, so cover/section
  // must render it too — a silently dropped note is a delivered-model-believes
  // / user-sees-nothing split, the exact thing the office engine refuses.
  it('cover and section render their note (no page number) instead of dropping it', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [
        { layout: 'cover', title: '封面', note: '来源：季度报表' },
        { layout: 'section', title: '第一章', note: '数据截至 2026-09' },
        { layout: 'bullets', title: '正文', bullets: ['一'], note: '来源：正文注脚' },
      ],
    }))
    const cover = slideXml(zip, 1)
    expect(cover).toContain('<a:t>来源：季度报表</a:t>')
    expect(cover).not.toContain('<a:t>1</a:t>')
    expect(slideXml(zip, 2)).toContain('<a:t>数据截至 2026-09</a:t>')
    expect(slideXml(zip, 2)).not.toContain('<a:t>2</a:t>')
    // the content page keeps its numbered foot
    expect(slideXml(zip, 3)).toContain('<a:t>来源：正文注脚</a:t>')
    expect(slideXml(zip, 3)).toContain('<a:t>3</a:t>')
  })

  it('every layout renders its page; content pages get page numbers', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [
        { layout: 'cover', title: '封面' },
        { layout: 'section', title: '第一章' },
        { layout: 'bullets', title: '要点', bullets: ['一', { text: '二', sub: ['2.1'] }] },
        { layout: 'two-col', title: '对比', columns: [{ heading: '甲', bullets: ['甲1'] }, { heading: '乙', bullets: ['乙1'] }] },
        { layout: 'kpi', title: '指标', items: [{ value: '98.2%', label: '达成率' }, { value: '3天', label: '交付周期' }] },
        { layout: 'table', title: '明细', header: ['名', '量'], rows: [['甲', '12']] },
        { layout: 'quote', quote: '结论先行', author: '金字塔原理' },
        { layout: 'bullets', title: '尾页', bullets: ['完'], note: '来源：内部统计' },
      ],
    }))
    expect(Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(8)
    // bullets page: • for mains, – for subs, one indent level deeper
    // (pptxgenjs entity-encodes the bullet char code in buChar)
    const bullets = slideXml(zip, 3)
    expect(bullets).toContain('<a:buChar char="&#x2022;"/>')
    expect(bullets).toContain('<a:buChar char="&#x2013;"/>')
    expect(bullets).toContain('lvl="1"')
    // two-col panels are rounded rectangles
    expect(count(slideXml(zip, 4), 'prst="roundRect"')).toBe(2)
    expect(slideXml(zip, 4)).toContain('<a:t>甲</a:t>')
    // kpi: one rounded card per item, values at the headline size
    expect(count(slideXml(zip, 5), 'prst="roundRect"')).toBe(2)
    expect(slideXml(zip, 5)).toContain('sz="3300"')
    expect(slideXml(zip, 5)).toContain('<a:t>98.2%</a:t>')
    // table: real a:tbl with header + body text
    const table = slideXml(zip, 6)
    expect(table).toContain('<a:tbl>')
    expect(table).toContain('<a:t>名</a:t>')
    expect(table).toContain('<a:t>甲</a:t>')
    // quote: the big mark and the attribution
    const quote = slideXml(zip, 7)
    expect(quote).toContain('<a:t>“</a:t>')
    expect(quote).toContain('<a:t>— 金字塔原理</a:t>')
    // note lands at the page foot; page numbers count content pages
    expect(slideXml(zip, 8)).toContain('<a:t>来源：内部统计</a:t>')
    expect(slideXml(zip, 8)).toContain('<a:t>8</a:t>')
    // section page carries its tint background (0.92 white mix of the accent)
    expect(slideXml(zip, 2)).toContain('<p:bg>')
    expect(slideXml(zip, 2)).toContain('val="EEF1FD"')
  })
})

describe('deck → pptx: charts are vector shapes', () => {
  it('column: one rect per data point in the accent colour, value + category labels', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [{ layout: 'chart', title: '营收', note: '来源：财务', chart: { type: 'column', categories: ['一月', '二月', '三月'], series: [{ name: '营收', values: [12, 30, 20] }] } }],
    }))
    const xml = slideXml(zip, 1)
    expect(plainShapes(xml)).toBe(5) // 3 bars + title chrome bar + bottom axis
    expect(xml).toContain('<a:t>30</a:t>')
    expect(xml).toContain('<a:t>二月</a:t>')
    expect(xml).toContain('<a:t>来源：财务</a:t>')
    expect(xml).toContain(`<a:srgbClr val="${DEFAULT_DECK_ACCENT}"/>`)
  })

  it('line: segments between points plus ellipse markers', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [{ layout: 'chart', title: '趋势', chart: { type: 'line', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: '活跃', values: [5, 9, 7] }] } }],
    }))
    const xml = slideXml(zip, 1)
    expect(count(xml, 'prst="line"')).toBe(3) // 2 segments + the bottom axis
    expect(count(xml, 'prst="ellipse"')).toBe(3)
  })

  it('bar (horizontal): category labels sit in their own column', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [{ layout: 'chart', title: '渠道', chart: { type: 'bar', categories: ['直营', '渠道'], series: [{ name: '占比', values: [65, 35] }] } }],
    }))
    const xml = slideXml(zip, 1)
    expect(plainShapes(xml)).toBe(4) // 2 bars + title chrome bar + bottom axis
    expect(xml).toContain('<a:t>直营</a:t>')
  })

  it('pie: one pie shape per slice with adjust angles, legend carries the pct', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      slides: [{ layout: 'chart', title: '构成', chart: { type: 'pie', categories: ['甲', '乙', '丙'], series: [{ name: '份额', values: [2, 1, 1] }] } }],
    }))
    const xml = slideXml(zip, 1)
    expect(count(xml, 'prst="pie"')).toBe(3)
    expect(xml).toContain('name="adj1"')
    expect(xml).toContain('name="adj2"')
    expect(xml).toContain('（50%）')
    expect(xml).toContain('<a:t>甲 · 2（50%）</a:t>')
  })

  it('negative values draw the darker zero line; a custom accent recolors the series', async () => {
    const zip = unzipSync(await bufferOf({
      title: 'T',
      theme: { accent: 'AA33CC' },
      slides: [{ layout: 'chart', title: '同比', chart: { type: 'column', categories: ['甲', '乙'], series: [{ name: '变化', values: [5, -3] }] } }],
    }))
    const xml = slideXml(zip, 1)
    expect(xml).toContain('val="BFBFBF"')
    expect(xml).toContain('val="AA33CC"')
  })
})

describe('deck → pptx: images and honesty', () => {
  it('image layout embeds the real bytes and the caption', async () => {
    const images = new Map([['assets/screenshot.png', PNG_1PX]])
    const zip = unzipSync(await bufferOf({ title: 'T', slides: [{ layout: 'image', image: 'assets/screenshot.png', caption: '图一：后台' }] }, images))
    // pptxgenjs v4 names media parts per slide-image: image-<slide>-<n>.png
    expect(Object.keys(zip).filter((k) => /^ppt\/media\/.+\.png$/.test(k))).toHaveLength(1)
    expect(slideXml(zip, 1)).toContain('<p:pic>')
    expect(slideXml(zip, 1)).toContain('<a:t>图一：后台</a:t>')
  })

  it('image + bullets goes image left, text right', async () => {
    const zip = unzipSync(await bufferOf({ title: 'T', slides: [{ layout: 'image', image: 'a.png', bullets: ['要点甲', '要点乙'] }] }, new Map([['a.png', PNG_1PX]])))
    const xml = slideXml(zip, 1)
    expect(xml).toContain('<p:pic>')
    expect(xml).toContain('<a:t>要点甲</a:t>')
  })

  it('an unresolved image is a programming error, not a silent hole', async () => {
    const parsed = parseDeckSpec({ title: 'T', slides: [{ layout: 'image', image: 'missing.png' }] })
    if (!parsed.ok) throw new Error(parsed.error)
    await expect(deckToPptxBuffer(parsed.spec, new Map())).rejects.toThrow('missing.png')
  })

  it('closes the loop: a full-layout deck parses through the PREVIEW model with zero skips', async () => {
    // The reason vector shapes (and the preview's pie conic branch) exist:
    // native chart parts / unrecognized geometry land in the preview's
    // placeholder-and-skipped buckets. Every layout must survive
    // export → preview-parse with nothing skipped and titles intact.
    const { parsePptxDeck } = await import('../src/shared/preview/pptx')
    const spec = {
      title: 'T',
      theme: { accent: 'AA33CC' },
      slides: [
        { layout: 'cover', title: '封面', subtitle: '副题' },
        { layout: 'section', title: '章节' },
        { layout: 'bullets', title: '要点', bullets: ['一', { text: '二', sub: ['2.1'] }] },
        { layout: 'two-col', title: '对比', columns: [{ heading: '甲', bullets: ['甲1'] }, { heading: '乙', bullets: ['乙1'] }] },
        { layout: 'kpi', title: '指标', items: [{ value: '98.2%', label: '达成率' }, { value: '3天', label: '交付' }] },
        { layout: 'chart', title: '柱状', chart: { type: 'column', categories: ['一', '二'], series: [{ name: '营收', values: [12, 30] }] } },
        { layout: 'chart', title: '折线', chart: { type: 'line', categories: ['一', '二', '三'], series: [{ name: '活跃', values: [5, 9, 7] }] } },
        { layout: 'chart', title: '饼图', chart: { type: 'pie', categories: ['甲', '乙'], series: [{ name: '份额', values: [3, 1] }] } },
        { layout: 'table', title: '明细', header: ['名', '量'], rows: [['甲', '12']] },
        { layout: 'quote', quote: '结论先行', author: '某人' },
        { layout: 'image', image: 'a.png', caption: '图注' },
      ],
    }
    const parsed = parseDeckSpec(spec)
    if (!parsed.ok) throw new Error(parsed.error)
    const zip = unzipSync(await deckToPptxBuffer(parsed.spec, new Map([['a.png', PNG_1PX]])))
    const deck = parsePptxDeck({
      entryText: (n) => (zip[n] ? strFromU8(zip[n]) : undefined),
      entryBytes: (n) => zip[n],
      names: () => Object.keys(zip),
    })
    expect(deck).not.toBeNull()
    expect(deck!.slides).toHaveLength(11)
    expect(deck!.skipped.charts).toBe(0)
    expect(deck!.skipped.unknownGeoms).toBe(0)
    expect(deck!.skipped.badImages).toBe(0)
    // every slide carries visible text (the title or the layout's payload)
    deck!.slides.forEach((s, i) => expect(s.shapes.length, `slide ${i}`).toBeGreaterThan(0))
    // the pie slices come back with their wedge angles (preview conic branch)
    const pie = deck!.slides[7].shapes.filter((s) => s.geometry?.prst === 'pie')
    expect(pie.length).toBe(2)
    expect(pie[0].geometry!.startAngleDeg).toBe(270)
  })
})
