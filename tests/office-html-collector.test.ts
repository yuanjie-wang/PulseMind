// @vitest-environment jsdom
// PLAN-pptx-html-route — the in-page collector under jsdom. jsdom has NO
// layout engine: every getBoundingClientRect returns zeros, so fixtures stub
// rects per element (the extension-page-tree precedent) and inline-group Range
// rects degrade to "none" (the collector's own guard) — text hidden inside
// mixed-content containers is therefore NOT testable here; leaf blocks are.
// What this pins: the walk (tags, blocks, runs, bullets, decoration,
// refusals). The real measurement lives in the probe.

import { describe, expect, it } from 'vitest'
import { collectDeckLayout } from '../src/main/office-export/html-measure-script'

type Rect = { x: number; y: number; w: number; h: number }

/** Mount html into body, then stub getBoundingClientRect from the prepared
 *  map (elements are looked up AFTER mounting, so selectors stay simple). */
function mount(html: string, prepare?: (doc: Document) => Map<Element, Rect>): Document {
  document.body.innerHTML = html
  const doc = document
  const rects = prepare ? prepare(doc) : new Map<Element, Rect>()
  for (const [el, r] of rects) {
    ;(el as HTMLElement).getBoundingClientRect = () =>
      ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y, toJSON: () => ({}) }) as DOMRect
  }
  return doc
}

const at = (doc: Document, selector: string, index = 0): Element => {
  const el = doc.querySelectorAll(selector)[index]
  if (!el) throw new Error(`fixture missing element: ${selector}[${index}]`)
  return el
}

const wrap = (content: string) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div class="slide" style="width:960px;height:540px">${content}</div></body></html>`

/** Fake range rects for the ink extent: rectsOf() runs document.createRange()
 *  per node, so the stub wraps it and answers from a node-keyed map. */
function stubRangeRects(doc: Document, inkByNode: Map<Node, Array<Record<string, number>>>): void {
  const orig = doc.createRange.bind(doc)
  ;(doc as unknown as { createRange: () => Range }).createRange = () => {
    const r = orig()
    let current: Node | null = null
    const origSelect = r.selectNode.bind(r)
    r.selectNode = (n: Node) => { current = n; return origSelect(n) }
    ;(r as unknown as { getClientRects: () => unknown }).getClientRects = () => inkByNode.get(current!) ?? []
    return r
  }
}

describe('collectDeckLayout (jsdom, stubbed rects)', () => {
  it('collects one fact-set per .slide in document order', () => {
    mount(`<div class="slide" style="width:960px;height:540px"></div><div class="slide" style="width:960px;height:540px"></div>`, (doc) => {
      const m = new Map<Element, Rect>()
      doc.querySelectorAll('.slide').forEach((s) => m.set(s, { x: 0, y: 0, w: 960, h: 540 }))
      return m
    })
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    expect(result.slides).toHaveLength(2)
    expect(result.slides.every((s) => s.blocks.length === 0)).toBe(true)
  })

  it('refuses a slide that is not 960×540', () => {
    mount(`<div class="slide" style="width:900px;height:540px"></div>`, (doc) =>
      new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 900, h: 540 }]]))
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/960×540/)
    expect(result.slides).toHaveLength(0)
  })

  it('a leaf text block lands with runs, computed styles, and its content rect', () => {
    // <p>, not <h1>: h1 carries a UA bold the run assertion would read as vacuous
    const doc = mount(wrap(`<p style="font-size:32px;color:#1F1F1F">季度<strong>回顾</strong></p>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, 'p'), { x: 64, y: 80, w: 600, h: 44 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    expect(block.kind).toBe('text')
    if (block.kind !== 'text') return
    expect(block.x).toBe(64)
    expect(block.y).toBe(80)
    expect(block.runs.map((r) => r.text).join('')).toBe('季度回顾')
    expect(block.runs[0].bold).toBe(false)
    expect(block.runs[1].bold).toBe(true) // <strong> splits the run
    expect(block.runs[0].color).toBe('1F1F1F')
    expect(block.runs[0].fontSizePx).toBe(32)
  })

  it('a painted div becomes a box block (fill / border / radius)', () => {
    const doc = mount(wrap(`<div style="background:#C2483B;border:2px solid #7A241C;border-top-left-radius:12px;width:200px;height:100px"></div>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, '.slide > div'), { x: 40, y: 40, w: 200, h: 100 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    expect(result.slides[0].blocks).toHaveLength(1)
    const block = result.slides[0].blocks[0]
    expect(block.kind).toBe('box')
    if (block.kind !== 'box') return
    expect(block.fill).toBe('C2483B')
    expect(block.border).toEqual({ color: '7A241C', widthPx: 2 })
    expect(block.radiusPx).toBe(12)
  })

  it('letter-spacing rides the run; a tracked span splits runs, same tracking merges', () => {
    const doc = mount(wrap(`<p style="font-size:20px;color:#1F1F1F"><span style="letter-spacing:4px">眉题</span><span style="letter-spacing:0">正文</span></p>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, 'p'), { x: 64, y: 80, w: 400, h: 30 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    if (block.kind !== 'text') return
    expect(block.runs).toHaveLength(2)
    expect(block.runs[0].text).toBe('眉题')
    expect(block.runs[0].charSpacingPx).toBe(4)
    expect(block.runs[1].text).toBe('正文')
    expect(block.runs[1].charSpacingPx).toBeUndefined() // normal spacing: no fact, no spc
  })

  it('dashed/dotted borders map to dash facts; double still degrades to solid', () => {
    const doc = mount(
      wrap(
        `<div style="border:2px dashed #7A241C;width:100px;height:40px"></div>` +
          `<div style="border:1px dotted #333333;width:100px;height:40px"></div>` +
          `<div style="border:3px double #666666;width:100px;height:40px"></div>`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        doc.querySelectorAll('.slide > div').forEach((el, i) => m.set(el, { x: 40, y: 40 + i * 60, w: 100, h: 40 }))
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const boxes = result.slides[0].blocks.filter((b) => b.kind === 'box')
    expect(boxes).toHaveLength(3)
    const [dashed, dotted, doubled] = boxes
    if (dashed.kind !== 'box' || dotted.kind !== 'box' || doubled.kind !== 'box') return
    expect(dashed.border).toEqual({ color: '7A241C', widthPx: 2, dash: 'dash' })
    expect(dotted.border).toEqual({ color: '333333', widthPx: 1, dash: 'dot' })
    expect(doubled.border).toEqual({ color: '666666', widthPx: 3 }) // no dash fact
    expect(result.degradations.join('；')).toMatch(/double 边框按实线处理/)
  })

  it('rgba fills map to pptx transparency (box, table cell, slide background) instead of refusing', () => {
    document.body.innerHTML =
      `<div class="slide" style="width:960px;height:540px;background:rgba(31,31,31,0.65)">` +
      `<div style="background:rgba(200,60,50,0.4);width:200px;height:100px"></div>` +
      `<table style="border-collapse:collapse"><tr><td style="background:rgba(0,0,0,0.08);width:100px;height:40px">甲</td></tr></table></div>`
    const doc = document
    ;(doc.querySelector('.slide > div') as HTMLElement).getBoundingClientRect = () =>
      ({ left: 40, top: 40, right: 240, bottom: 140, width: 200, height: 100, x: 40, y: 40, toJSON: () => ({}) }) as DOMRect
    ;(doc.querySelector('.slide') as HTMLElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    ;(doc.querySelector('table') as HTMLElement).getBoundingClientRect = () =>
      ({ left: 64, top: 200, right: 164, bottom: 240, width: 100, height: 40, x: 64, y: 200, toJSON: () => ({}) }) as DOMRect
    ;(doc.querySelector('td') as HTMLElement).getBoundingClientRect = () =>
      ({ left: 64, top: 200, right: 164, bottom: 240, width: 100, height: 40, x: 64, y: 200, toJSON: () => ({}) }) as DOMRect
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const box = result.slides[0].blocks[0]
    if (box.kind !== 'box') return
    expect(box.fill).toBe('C83C32')
    expect(box.fillTransparency).toBe(60) // alpha 0.4 → pptx transparency 60
    const table = result.slides[0].blocks[1]
    if (table.kind !== 'table') return
    expect(table.cells[0][0].fill).toBe('000000')
    expect(table.cells[0][0].fillTransparency).toBe(92)
    // the slide fact itself: alpha 0.65 → transparency 35
    expect(result.slides[0].background).toBe('1F1F1F')
    expect(result.slides[0].backgroundTransparency).toBe(35)
  })

  it('a single outer box-shadow maps to shadow facts (px + alpha), no degradation', () => {
    const doc = mount(wrap(`<div style="background:#FFFFFF;box-shadow:0px 2px 8px rgba(0,0,0,0.1);width:200px;height:100px"></div>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, '.slide > div'), { x: 40, y: 40, w: 200, h: 100 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    expect(result.degradations).toEqual([])
    const block = result.slides[0].blocks[0]
    if (block.kind !== 'box') return
    expect(block.shadow).toEqual({ offsetX: 0, offsetY: 2, blur: 8, color: '000000', alpha: 0.1 })
  })

  it('a shadow-only div (no fill, no border) still emits its box', () => {
    const doc = mount(wrap(`<div style="box-shadow:0px 0px 12px rgba(0,0,0,0.2);width:200px;height:100px"></div>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, '.slide > div'), { x: 40, y: 40, w: 200, h: 100 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    expect(block.kind).toBe('box')
    if (block.kind !== 'box') return
    expect(block.fill).toBeUndefined()
    expect(block.shadow).toMatchObject({ blur: 12, alpha: 0.2 })
  })

  it('multi-layer / inset / spread box-shadows degrade by name, never silently', () => {
    const doc = mount(
      wrap(
        `<div style="background:#FFFFFF;box-shadow:2px 2px 4px rgba(0,0,0,0.2), 0 0 6px rgba(0,0,0,0.1);width:100px;height:40px"></div>` +
          `<div style="background:#FFFFFF;box-shadow:inset 0 0 4px rgba(0,0,0,0.3);width:100px;height:40px"></div>` +
          `<div style="background:#FFFFFF;box-shadow:2px 2px 4px 2px rgba(0,0,0,0.3);width:100px;height:40px"></div>`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        doc.querySelectorAll('.slide > div').forEach((el, i) => m.set(el, { x: 40, y: 40 + i * 60, w: 100, h: 40 }))
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    // boxes still emit (they have fills) — but every shadow is dropped
    expect(result.slides[0].blocks.filter((b) => b.kind === 'box')).toHaveLength(3)
    expect(result.slides[0].blocks.every((b) => b.kind !== 'box' || b.shadow === undefined)).toBe(true)
    const msg = result.degradations.join('；')
    expect(msg).toMatch(/2 层 box-shadow/)
    expect(msg).toMatch(/inset/)
    expect(msg).toMatch(/spread/)
  })

  it('object-fit:cover rides the image facts; off-center object-position degrades', () => {
    const doc = mount(
      wrap(
        `<img src="assets/a.png" style="object-fit:cover;width:400px;height:130px">` +
          `<img src="assets/b.png" style="object-fit:cover;object-position:left top;width:400px;height:130px">` +
          `<img src="assets/c.png" style="width:400px;height:130px">`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        doc.querySelectorAll('img').forEach((el, i) => m.set(el, { x: 40, y: 40 + i * 150, w: 400, h: 130 }))
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const images = result.slides[0].blocks.filter((b) => b.kind === 'image')
    expect(images).toHaveLength(3)
    const [covered, offCenter, plain] = images
    if (covered.kind !== 'image' || offCenter.kind !== 'image' || plain.kind !== 'image') return
    expect(covered.objectFit).toBe('cover')
    expect(offCenter.objectFit).toBe('cover')
    expect(plain.objectFit).toBeUndefined() // default stays contain (unchanged decks)
    expect(result.degradations.join('；')).toMatch(/object-position/)
  })

  it('object-fit:cover computes the centered crop from the natural aspect', () => {
    const doc = mount(wrap(`<img src="assets/a.png" style="object-fit:cover;width:960px;height:540px">`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, 'img'), { x: 0, y: 0, w: 960, h: 540 }],
      ]))
    void doc
    // jsdom decodes nothing — naturalWidth stays 0. Stub the decoded size the
    // browser would report (2000×1500 = 4:3 into a 16:9 window → crop t/b).
    const img = doc.querySelector('img') as HTMLImageElement
    Object.defineProperty(img, 'naturalWidth', { value: 2000 })
    Object.defineProperty(img, 'naturalHeight', { value: 1500 })
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    if (block.kind !== 'image') return
    expect(block.naturalW).toBe(2000)
    expect(block.naturalH).toBe(1500)
    // renderedH = 960/(4/3) = 720; (720−540)/(2·720) = 0.125 top and bottom
    expect(block.coverCrop).toEqual({ l: 0, r: 0, t: 0.125, b: 0.125 })
  })

  it('li text blocks carry bullet level and ordered kind (nesting counted)', () => {
    const doc = mount(wrap(`<ul><li>要点甲</li><ol><li>子项</li></ol></li></ul>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      doc.querySelectorAll('li').forEach((li, i) => m.set(li, { x: 64, y: 100 + i * 30, w: 300, h: 24 }))
      return m
    })
    void doc
    const result = collectDeckLayout()
    // 要点乙 mixes loose text with a block child — jsdom has no line boxes for
    // its anonymous group, so only the two LEAF li blocks are expected here
    expect(result.errors).toEqual([])
    const bullets = result.slides[0].blocks
      .filter((b) => b.kind === 'text')
      .map((b) => (b.kind === 'text' ? b.bullet : undefined))
    expect(bullets).toContainEqual({ level: 1, ordered: false })
    expect(bullets).toContainEqual({ level: 2, ordered: true })
  })

  it('data-chart annotations become chart blocks carrying the raw JSON', () => {
    const raw = JSON.stringify({ type: 'column', categories: ['Q1'], series: [{ name: 's', values: [1] }] })
    const doc = mount(wrap(`<div data-chart='${raw}' style="width:600px;height:360px"></div>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, '[data-chart]'), { x: 64, y: 120, w: 600, h: 360 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    expect(block.kind).toBe('chart')
    if (block.kind !== 'chart') return
    expect(JSON.parse(block.raw)).toEqual(JSON.parse(raw))
  })

  it('refuses out-of-bounds blocks naming the page and element', () => {
    const doc = mount(wrap(`<p style="width:500px">超界文本</p>`), (doc) =>
      new Map<Element, Rect>([
        [at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }],
        [at(doc, 'p'), { x: 700, y: 500, w: 500, h: 100 }],
      ]))
    void doc
    const result = collectDeckLayout()
    expect(result.errors[0].page).toBe(1)
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/超出页面/)
  })

  it('refuses whitelisted-out elements and nested .slide', () => {
    mount(`<div class="slide" style="width:960px;height:540px"><svg width="10"></svg><div class="slide" style="width:960px;height:540px"></div></div>`, (doc) =>
      new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]]))
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/不允许的元素/)
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/嵌套/)
  })

  it('refuses translucent text color and colspan tables', () => {
    const doc = mount(wrap(`<p style="color:rgba(0,0,0,0.5)">浅字</p><table><tr><td colspan="2">合并</td></tr></table>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p'), { x: 10, y: 10, w: 100, h: 20 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/半透明/)
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/colspan/)
  })

  it('tables report per-row heights, per-col widths, and cell styles', () => {
    const doc = mount(
      wrap(`<table style="border-collapse:collapse"><tr><th style="background:#C2483B;color:#FFFFFF;font-size:16px">名称</th><th>数量</th></tr><tr><td>甲</td><td>12</td></tr></table>`),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        m.set(at(doc, 'table'), { x: 64, y: 120, w: 600, h: 80 })
        doc.querySelectorAll('tr').forEach((tr, i) => m.set(tr, { x: 64, y: 120 + i * 40, w: 600, h: 40 }))
        doc.querySelectorAll('th').forEach((th, i) => m.set(th, { x: 64 + i * 300, y: 120, w: 300, h: 40 }))
        doc.querySelectorAll('td').forEach((td, i) => m.set(td, { x: 64 + i * 300, y: 160, w: 300, h: 40 }))
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const block = result.slides[0].blocks[0]
    expect(block.kind).toBe('table')
    if (block.kind !== 'table') return
    expect(block.colWidthsPx).toEqual([300, 300])
    expect(block.rowHeightsPx).toEqual([40, 40])
    expect(block.cells[0][0]).toMatchObject({ text: '名称', header: true, bold: true, color: 'FFFFFF', fill: 'C2483B', fontSizePx: 16 })
    expect(block.cells[1][1]).toMatchObject({ text: '12', header: false })
  })

  it('refuses ragged rows — gridCol count would fall short of a row\'s tc count (review_20261006 中8)', () => {
    // 浏览器照常渲染行间 cell 数不齐的表格；发射器按首行定列宽，参差行会
    // 产出 gridCol 数 < 行内 <a:tc> 数的非法 OOXML（PowerPoint 打开要修复）。
    const doc = mount(
      wrap(`<table style="border-collapse:collapse"><tr><td>甲</td><td>12</td></tr><tr><td>乙</td><td>13</td><td>多出的格子</td></tr></table>`),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        m.set(at(doc, 'table'), { x: 64, y: 120, w: 600, h: 80 })
        doc.querySelectorAll('tr').forEach((tr, i) => m.set(tr, { x: 64, y: 120 + i * 40, w: 600, h: 40 }))
        return m
      })
    void doc
    const result = collectDeckLayout()
    const msg = result.errors.map((e) => e.message).join(' ')
    expect(msg).toMatch(/列数必须一致/)
    expect(msg).toMatch(/第 2 行/)          // 点名行号
    expect(result.errors[0].page).toBe(1)  // 点名页码（与 colspan 拒绝同款）
    // 参差表格不发射——blocks 里没有 table
    expect(result.slides[0].blocks.filter((b) => b.kind === 'table')).toHaveLength(0)
  })

  it('refuses overlapping text blocks naming both elements', () => {
    const doc = mount(wrap(`<p style="position:absolute">上方标题标题标题</p><p style="position:absolute">下方文本文本文本</p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p', 0), { x: 100, y: 100, w: 400, h: 60 })
      m.set(at(doc, 'p', 1), { x: 100, y: 130, w: 400, h: 60 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    const msg = result.errors.map((e) => e.message).join(' ')
    expect(msg).toMatch(/文字区域重叠/)
    expect(msg).toMatch(/下方文本文本文本/)
    expect(result.errors[0].page).toBe(1)
  })

  it('tolerates edge-touching text boxes (≤3px or sliver overlaps)', () => {
    const doc = mount(wrap(`<p>甲</p><p>乙</p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p', 0), { x: 100, y: 100, w: 400, h: 60 })
      m.set(at(doc, 'p', 1), { x: 100, y: 158, w: 400, h: 60 }) // 2px touch
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).not.toMatch(/重叠/)
  })

  it('refuses text crossing a table — the 20261007235037 page-12 shape (full-width line 18px into a table)', () => {
    const doc = mount(wrap(`<p style="position:absolute">安卓续航充电普遍 80–120W</p><table><tr><td>机型</td><td>电池</td></tr></table>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p'), { x: 64, y: 200, w: 832, h: 30 })
      m.set(at(doc, 'table'), { x: 64, y: 212, w: 832, h: 200 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    const msg = result.errors.map((e) => e.message).join(' ')
    expect(msg).toMatch(/表格区域重叠/)
    expect(msg).toMatch(/安卓续航充电普遍/)
    expect(result.errors[0].page).toBe(1)
  })

  it('refuses text crossing a chart box (charts draw their own labels)', () => {
    const raw = JSON.stringify({ type: 'column', categories: ['Q1'], series: [{ name: 's', values: [1] }] })
    const doc = mount(wrap(`<p style="position:absolute">上图可见</p><div data-chart='${raw}'></div>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p'), { x: 500, y: 200, w: 200, h: 30 })
      m.set(at(doc, '[data-chart]'), { x: 64, y: 120, w: 600, h: 360 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/图表区域重叠/)
  })

  it('grazing a table (2px edge touch) stays tolerance, not a defect', () => {
    const doc = mount(wrap(`<p style="position:absolute">说明行</p><table><tr><td>甲</td></tr></table>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p'), { x: 64, y: 170, w: 400, h: 30 })
      m.set(at(doc, 'table'), { x: 64, y: 198, w: 832, h: 200 }) // 2px touch
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).not.toMatch(/重叠/)
  })

  // The overlap checks probe the ink extent (range rects) with a fallback to
  // the block box. jsdom has no layout, so these two stub createRange to fake
  // the glyphs — the shapes the OLD clamped/fallback behavior got wrong.

  it('text-vs-text probes the ink: a short-glyphed wide title does not collide across its empty half', () => {
    const doc = mount(wrap(`<p style="position:absolute">短标题</p><p style="position:absolute">右侧说明文字</p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p', 0), { x: 64, y: 100, w: 832, h: 30 }) // block box reaches x:896
      m.set(at(doc, 'p', 1), { x: 600, y: 104, w: 200, h: 24 })
      return m
    })
    const inkByNode = new Map<Node, Array<Record<string, number>>>()
    doc.querySelectorAll('p').forEach((p, i) => {
      inkByNode.set(p.firstChild as Node, [i === 0
        ? { left: 64, top: 100, right: 264, bottom: 124, width: 200, height: 24 } // glyphs end at x:264
        : { left: 600, top: 104, right: 800, bottom: 128, width: 200, height: 24 }])
    })
    stubRangeRects(doc, inkByNode)
    const result = collectDeckLayout()
    // the BLOCK boxes overlap (600 < 896) — the block-rect check refused this
    expect(result.errors.map((e) => e.message).join(' ')).not.toMatch(/文字区域重叠/)
  })

  it('ink spilling past a fixed-height box is visible: the overlap is refused', () => {
    const doc = mount(wrap(`<p style="position:absolute">溢出文本</p><p style="position:absolute">紧贴盒底的文本行</p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p', 0), { x: 64, y: 100, w: 400, h: 30 }) // box ends at y:130
      m.set(at(doc, 'p', 1), { x: 64, y: 140, w: 400, h: 24 })
      return m
    })
    const inkByNode = new Map<Node, Array<Record<string, number>>>()
    doc.querySelectorAll('p').forEach((p, i) => {
      inkByNode.set(p.firstChild as Node, [i === 0
        ? { left: 64, top: 100, right: 464, bottom: 190, width: 400, height: 90 } // glyphs reach y:190
        : { left: 64, top: 140, right: 464, bottom: 164, width: 400, height: 24 }])
    })
    stubRangeRects(doc, inkByNode)
    const result = collectDeckLayout()
    // glyphs 100–190 vs 140–164: a real 24px collision the clamped ink (100–130) missed
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/文字区域重叠/)
  })

  it('a box painted AFTER text that crosses it refuses — the glyphs would be buried', () => {
    // the wild page-10/15 shape: an absolute lead whose bottom slips under a
    // card row that follows it in the DOM
    const doc = mount(
      wrap(
        `<p style="position:absolute; font-size:18px">把模型选择权还给用户的说明行</p>` +
          `<div style="position:absolute; background:#F2ECE1"></div>`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        m.set(at(doc, 'p'), { x: 64, y: 162, w: 832, h: 32 })
        m.set(at(doc, '.slide > div'), { x: 64, y: 170, w: 832, h: 300 })
        return m
      })
    void doc
    const result = collectDeckLayout()
    const msg = result.errors.map((e) => e.message).join(' ')
    expect(msg).toMatch(/盖掉/)
    expect(msg).toMatch(/把模型选择权还给用户的说明行/)
    expect(result.errors[0].page).toBe(1)
  })

  it('the mask/card device stays legal: text over an EARLIER surface, and text inside its card', () => {
    const doc = mount(
      wrap(
        `<div style="position:absolute; background:rgba(0,0,0,0.45)"></div>` +
          `<h1 style="position:absolute; width:300px; font-size:44px">反白巨标</h1>` +
          `<div style="position:absolute; background:#F2ECE1; width:300px; height:200px"><p style="font-size:15px">卡内文字</p></div>`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        m.set(at(doc, '.slide > div', 0), { x: 0, y: 0, w: 960, h: 540 })
        m.set(at(doc, 'h1'), { x: 64, y: 200, w: 300, h: 52 }) // glyphs end at x:364, clear of the card
        m.set(at(doc, '.slide > div', 1), { x: 400, y: 120, w: 300, h: 200 })
        m.set(at(doc, 'p'), { x: 420, y: 140, w: 260, h: 24 })
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
  })

  it('reports zero slides with the .slide hint when none exist', () => {
    mount('<div class="not-slide"></div>')
    const result = collectDeckLayout()
    expect(result.errors.map((e) => e.message).join(' ')).toMatch(/没有找到任何 \.slide/)
  })

  it('visibility:hidden content is skipped — leaf blocks, inline spans, counted once', () => {
    const doc = mount(
      wrap(
        `<p style="visibility:hidden">隐身标题</p>` +
          `<p style="font-size:20px">可见<span style="visibility:hidden">占位</span>文本</p>`,
      ),
      (doc) => {
        const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
        m.set(at(doc, 'p', 0), { x: 10, y: 10, w: 200, h: 24 })
        m.set(at(doc, 'p', 1), { x: 10, y: 44, w: 200, h: 24 })
        return m
      })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const texts = result.slides[0].blocks.filter((b) => b.kind === 'text')
    expect(texts).toHaveLength(1)
    if (texts[0].kind !== 'text') return
    expect(texts[0].runs.map((r) => r.text).join('')).toBe('可见文本')
    // 隐身的 p（容器层拦下）+ 隐身的 span（leaf 文本走 buildRuns 拦下）各计一次
    expect(result.degradations.join('；')).toMatch(/2 处 visibility:hidden/)
  })

  it('refuses overflow-clipped text naming the clipping box, once per clipper', () => {
    const doc = mount(wrap(`<div style="overflow:hidden;height:100px"><p>第一段</p><p>第二段</p></div>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, '.slide > div'), { x: 64, y: 80, w: 400, h: 100 })
      m.set(at(doc, 'p', 0), { x: 64, y: 80, w: 400, h: 24 })
      m.set(at(doc, 'p', 1), { x: 64, y: 104, w: 400, h: 24 })
      return m
    })
    void doc
    // jsdom has no layout: the overflow itself is a stubbed scroll metric
    const box = at(doc, '.slide > div') as HTMLElement
    Object.defineProperty(box, 'scrollHeight', { value: 300 })
    Object.defineProperty(box, 'clientHeight', { value: 100 })
    Object.defineProperty(box, 'scrollWidth', { value: 400 })
    Object.defineProperty(box, 'clientWidth', { value: 400 })
    const result = collectDeckLayout()
    expect(result.errors.filter((e) => /overflow 裁剪/.test(e.message))).toHaveLength(1)
    const msg = result.errors.map((e) => e.message).join(' ')
    expect(msg).toMatch(/装不下/)
    expect(msg).toMatch(/内容 400×300px，盒子 400×100px/)
    expect(result.errors[0].page).toBe(1)
  })

  it('pre runs carry mono even though the UA monospace stack misses the token face', () => {
    const doc = mount(wrap(`<pre>const pulse = 1</pre><p style="font-size:18px">正文</p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'pre'), { x: 64, y: 80, w: 400, h: 60 })
      m.set(at(doc, 'p'), { x: 64, y: 150, w: 400, h: 24 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.errors).toEqual([])
    const [pre, p] = result.slides[0].blocks
    if (pre.kind !== 'text' || p.kind !== 'text') return
    expect(pre.runs[0].mono).toBe(true)
    expect(p.runs[0].mono).toBeUndefined()
  })

  it('links degrade with a per-slide note — text stays, href cannot enter pptx', () => {
    const doc = mount(wrap(`<p><a href="a.md">附录甲</a>与<a href="b.md">附录乙</a></p>`), (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, 'p'), { x: 64, y: 80, w: 400, h: 24 })
      return m
    })
    void doc
    const result = collectDeckLayout()
    expect(result.degradations.join('；')).toMatch(/第 1 页：2 个链接仅保留文字/)
  })

  it('an empty .slide degrades by name instead of silently exporting a blank page', () => {
    mount(`<div class="slide" style="width:960px;height:540px"></div><div class="slide" style="width:960px;height:540px"><p>有内容</p></div>`, (doc) => {
      const m: Map<Element, Rect> = new Map([[at(doc, '.slide'), { x: 0, y: 0, w: 960, h: 540 }]])
      m.set(at(doc, '.slide', 1), { x: 0, y: 560, w: 960, h: 540 })
      m.set(at(doc, 'p'), { x: 10, y: 570, w: 100, h: 20 })
      return m
    })
    const result = collectDeckLayout()
    const msg = result.degradations.join('；')
    expect(msg).toMatch(/第 1 页没有任何内容块/)
    expect(msg).not.toMatch(/第 2 页没有任何内容块/)
  })
})
