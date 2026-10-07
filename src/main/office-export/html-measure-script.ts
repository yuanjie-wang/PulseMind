// ── HTML design route: the in-page measurement collector (PLAN-pptx-html-route)
//  Runs INSIDE the Chromium page via page.evaluate — and under jsdom in the
//  tests. That double host is why this function is deliberately SELF-CONTAINED:
//  no imports, no closure over module scope (Playwright serializes the
//  function's own source, so any outer reference would be a ReferenceError in
//  the page). The canvas constants below are mirrored from html-route-types on
//  purpose — a SLIDE_W import here would silently break the serialization.
//
//  What it reports: per .slide (document order), every PAINTED thing as a
//  flat block list — text (with per-node runs), boxes (fill/border/shadow),
//  images, tables, data-chart annotations — plus refusals (profile
//  violations, out-of-bounds) and advisory degradations. Coordinates are
//  slide-relative px. Alpha color maps to pptx transparency on fills/lines
//  (pptxgenjs fill/line `transparency`); TEXT color has no alpha in OOXML
//  runs and is still refused by name. Painting order ≈ DOM order, with the
//  browser's "positioned paints above in-flow" rule approximated by tagging
//  positioned blocks; the emitter stable-partitions on that tag.

import type { CollectResult, LayoutRun, TableCellFacts } from './html-route-types'

export function collectDeckLayout(): CollectResult {
  // every constant lives INSIDE the function: page.evaluate serializes this
  // function's own source, so module-scope references would be dead in the page
  const TOL = 0.75 // px of slack before a block counts as out of bounds
  const SIZE_TOL = 1 // px on the .slide 960×540 check
  const SLIDE_CAP = 200 // mirrored from html-route-types (HTML_SLIDE_CAP)
  const ALLOWED_TAGS = new Set([
    'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
    'IMG', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'A', 'CODE', 'PRE',
    'SMALL', 'SUP', 'SUB', 'SECTION', 'MAIN', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION',
  ])
  const slides = Array.from(document.querySelectorAll('.slide')) as HTMLElement[]
  const errors: CollectResult['errors'] = []
  const degradations: string[] = []
    const slideFacts: CollectResult['slides'] = []

  // ── color reader: rgb()/rgba() → hex + pptx transparency (fills/lines), or
  // a named refusal for the text callers ──
  // pptxgenjs carries fill/line alpha natively as `transparency` 0-100, so an
  // rgba() FILL is a mapping, not a refusal — the fidelity contract holds
  // because the pptx paints the same blend over the same backdrop. Text color
  // has no alpha in OOXML runs, so the text callers keep the refusal (they
  // check `transparency` and error out).
  const readColor = (value: string): { hex?: string; transparency?: number; transparent?: boolean } | null => {
    const v = (value || '').trim()
    if (!v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)') return { transparent: true }
    const m = v.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/)
    if (!m) return null
    const part = (s: string): number => Math.max(0, Math.min(255, Math.round(parseFloat(s))))
    const hex = [m[1], m[2], m[3]].map((c) => part(c).toString(16).padStart(2, '0')).join('').toUpperCase()
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4])
    if (alpha < 0.999) return { hex, transparency: Math.max(1, Math.round((1 - alpha) * 100)) }
    return { hex }
  }

  const desc = (el: Element): string => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''
    const tag = el.tagName.toLowerCase() + cls
    const own = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18)
    return own ? `<${tag}>「${own}」` : `<${tag}>`
  }

  const px = (v: string | null | undefined): number => (v ? parseFloat(v) || 0 : 0)

  const unionRect = (rects: DOMRect[]): { x: number; y: number; w: number; h: number } => {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity
    for (const r of rects) {
      if (r.width === 0 && r.height === 0) continue
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top)
      x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom)
    }
    if (x1 === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }

  const blockish = (el: Element): boolean => {
    const d = window.getComputedStyle(el).display
    if (d) return !(d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'inline-table')
    // jsdom gap: computed display can come back empty for elements its minimal
    // UA sheet doesn't cover — fall back to the tag's HTML default (real
    // browsers always resolve display, so this never fires in the page)
    const INLINE_BY_DEFAULT = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'A', 'CODE', 'SMALL', 'SUP', 'SUB', 'BR', 'IMG', 'LABEL'])
    return !INLINE_BY_DEFAULT.has(el.tagName)
  }

  // content-box rect: text starts inside padding+border, and the pptx text box
  // must land on the text, not on the element's border box
  const contentRect = (el: HTMLElement): { x: number; y: number; w: number; h: number } => {
    const r = el.getBoundingClientRect()
    const c = window.getComputedStyle(el)
    const bl = px(c.borderLeftWidth); const bt = px(c.borderTopWidth)
    const pl = px(c.paddingLeft); const pt = px(c.paddingTop)
    return {
      x: r.left + bl + pl,
      y: r.top + bt + pt,
      w: Math.max(0, r.width - bl - px(c.borderRightWidth) - pl - px(c.paddingRight)),
      h: Math.max(0, r.height - bt - px(c.borderBottomWidth) - pt - px(c.paddingBottom)),
    }
  }

  // the mono face from the resolved cascade (tokens.css or the injected
  // defaults); jsdom doesn't resolve var(), so runs styled with
  // `font-family: var(--pm-font-mono)` keep the literal var — match both
  const monoFace = (window.getComputedStyle(document.documentElement).getPropertyValue('--pm-font-mono') || '')
    .trim()
    .replace(/^["']|["']$/g, '')

  slides.forEach((slideEl, idx) => {
    const page = idx + 1
    if ((slideEl.parentElement as Element | null)?.closest?.('.slide')) {
      errors.push({ page, message: '.slide 不允许嵌套——一页一个平级的 .slide 节点。' })
      return
    }
    const sr = slideEl.getBoundingClientRect()
    if (Math.abs(sr.width - 960) > SIZE_TOL || Math.abs(sr.height - 540) > SIZE_TOL) {
      errors.push({ page, message: `.slide 尺寸必须是 960×540px（16:9，96dpi ≡ 10×5.625 英寸），实测 ${Math.round(sr.width)}×${Math.round(sr.height)}——给 .slide 设 width:960px; height:540px。` })
      return
    }
    const ox = sr.left
    const oy = sr.top
    const blocks: CollectResult['slides'][number]['blocks'] = []
    let inlineGroup: Node[] = []

    const bounds = (b: { x: number; y: number; w: number; h: number }, what: string) => {
      if (b.x < -TOL || b.y < -TOL || b.x + b.w > 960 + TOL || b.y + b.h > 540 + TOL) {
        errors.push({
          page,
          message: `${what} 超出页面（x:${Math.round(b.x)} y:${Math.round(b.y)} 宽:${Math.round(b.w)} 高:${Math.round(b.h)}）——960×540 的画布装不下就是装不下，缩小或拆页。`,
        })
      }
    }

    // ── color/decoration readers for containers ──
    const decoration = (el: HTMLElement): {
      fill?: string
      fillTransparency?: number
      border?: { color: string; widthPx: number; transparency?: number; dash?: 'dash' | 'dot' }
      radiusPx?: number
      shadow?: { offsetX: number; offsetY: number; blur: number; color: string; alpha: number }
    } => {
      const c = window.getComputedStyle(el)
      const out: {
        fill?: string
        fillTransparency?: number
        border?: { color: string; widthPx: number; transparency?: number; dash?: 'dash' | 'dot' }
        radiusPx?: number
        shadow?: { offsetX: number; offsetY: number; blur: number; color: string; alpha: number }
      } = {}
      const bg = readColor(c.backgroundColor)
      if (bg && bg.hex) {
        out.fill = bg.hex
        if (bg.transparency !== undefined) out.fillTransparency = bg.transparency
      }
      const bw = px(c.borderTopWidth)
      if (bw > 0) {
        // dashed/dotted map to pptx dashType; the exotic styles (double,
        // groove, ridge…) still degrade to solid by name
        const style = c.borderTopStyle
        const dash = style === 'dashed' ? ('dash' as const) : style === 'dotted' ? ('dot' as const) : undefined
        if (style && style !== 'solid' && style !== 'none' && !dash) degradations.push(`第 ${page} 页：${desc(el)} 的 ${style} 边框按实线处理`)
        const bc = readColor(c.borderTopColor)
        if (bc && bc.hex) {
          out.border = { color: bc.hex, widthPx: bw, ...(dash ? { dash } : {}) }
          if (bc.transparency !== undefined) out.border.transparency = bc.transparency
        }
      }
      const radius = px(c.borderTopLeftRadius)
      if (radius > 0.5) out.radiusPx = radius
      if (c.boxShadow && c.boxShadow !== 'none') {
        const shadow = parseBoxShadow(c.boxShadow, el)
        if (shadow) out.shadow = shadow
      }
      const op = parseFloat(c.opacity || '1')
      if (op < 0.999) degradations.push(`第 ${page} 页：${desc(el)} 的 opacity:${op} 未映射（按不透明渲染）`)
      return out
    }

    /** box-shadow → one outer shadow (px + alpha). Chromium computes color
     *  FIRST (`rgba(...) 0px 2px 8px`), jsdom/author order keeps it last —
     *  the parser takes the color from either end. Multiple layers, inset
     *  and spread have no pptx primitive: named degradation, never silent. */
    const parseBoxShadow = (css: string, el: HTMLElement): { offsetX: number; offsetY: number; blur: number; color: string; alpha: number } | null => {
      const label = desc(el)
      const layers = css.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)
      if (layers.length > 1) {
        degradations.push(`第 ${page} 页：${label} 的 ${layers.length} 层 box-shadow 未映射（只支持单层外阴影）`)
        return null
      }
      let seg = layers[0]
      if (/\binset\b/.test(seg)) {
        degradations.push(`第 ${page} 页：${label} 的 inset box-shadow 未映射`)
        return null
      }
      let color = '000000'
      let alpha = 1
      const cm = seg.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/)
      if (cm) {
        const parsed = readColor(cm[0])
        if (parsed && parsed.hex) {
          color = parsed.hex
          if (parsed.transparency !== undefined) alpha = Math.round(Math.max(0, Math.min(1, 1 - parsed.transparency / 100)) * 100) / 100
        }
        seg = seg.replace(cm[0], ' ')
      }
      const lengths = seg.trim().split(/\s+/).map(px)
      if (lengths.length < 2) {
        degradations.push(`第 ${page} 页：${label} 的 box-shadow 未映射（读不出偏移）`)
        return null
      }
      const [offsetX, offsetY] = lengths
      const blur = lengths.length > 2 ? lengths[2] : 0
      const spread = lengths.length > 3 ? lengths[3] : 0
      if (spread !== 0) {
        degradations.push(`第 ${page} 页：${label} 的 box-shadow spread 未映射`)
        return null
      }
      if (alpha === 0 || (offsetX === 0 && offsetY === 0 && blur === 0)) return null
      return { offsetX, offsetY, blur, color, alpha }
    }

    // ── text runs: per-node styles, BR → '\n', whitespace collapsed like the
    // browser does, adjacent same-style runs merged ──
    const buildRuns = (nodes: Node[], fallback: HTMLElement): LayoutRun[] => {
      const runs: LayoutRun[] = []
      let pendingNewlines = 0
      const pushText = (text: string, styleOwner: Element | null) => {
        const c = window.getComputedStyle(styleOwner || fallback)
        const col = readColor(c.color)
        // OOXML runs carry no alpha on color — text keeps the named refusal
        // (fills map it; this is the one place translucency still refuses).
        if (col && col.transparency !== undefined) {
          errors.push({
            page,
            message: `${desc(styleOwner || fallback)} 的文字色用了半透明——文字没有透明度可映射，改用调淡后的 hex（浅色强调用 --pm-accent-soft 或 --pm-muted）。`,
          })
        }
        const family = c.fontFamily || ''
        const isMono = !!monoFace && (family.indexOf(monoFace) >= 0 || /--pm-font-mono/.test(family))
        // letter-spacing: computed px ('normal' parses to 0) — one of the
        // strongest typographic signals (kickers, tracked numerals)
        const ls = px(c.letterSpacing)
        const run: LayoutRun = {
          text: (pendingNewlines > 0 ? '\n'.repeat(pendingNewlines) : '') + text,
          fontSizePx: px(c.fontSize) || 16,
          bold: c.fontWeight === 'bold' || c.fontWeight === 'bolder' || parseInt(c.fontWeight || '400', 10) >= 600,
          italic: c.fontStyle === 'italic' || c.fontStyle === 'oblique',
          underline: (c.textDecorationLine || c.textDecoration || '').indexOf('underline') >= 0,
          strike: (c.textDecorationLine || c.textDecoration || '').indexOf('line-through') >= 0,
          color: col && col.hex ? col.hex : '262626',
          ...(isMono ? { mono: true } : {}),
          ...(ls > 0.05 ? { charSpacingPx: ls } : {}),
        }
        pendingNewlines = 0
        const last = runs[runs.length - 1]
        if (last && last.fontSizePx === run.fontSizePx && last.bold === run.bold && last.italic === run.italic
          && last.underline === run.underline && last.strike === run.strike && last.color === run.color
          && !!last.mono === !!run.mono && (last.charSpacingPx ?? 0) === (run.charSpacingPx ?? 0)) last.text += run.text
        else runs.push(run)
      }
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.nodeValue || '').replace(/[\t\n\r\f ]+/g, ' ')
          if (t) pushText(t, node.parentElement)
          return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const el = node as HTMLElement
        if (el.tagName === 'BR') { pendingNewlines++; return }
        for (const child of Array.from(el.childNodes)) walk(child)
      }
      for (const n of nodes) walk(n)
      // trim the block's leading/trailing whitespace and stray edge newlines
      const firstRun = runs[0]
      if (firstRun) firstRun.text = firstRun.text.replace(/^[\n ]+/, '')
      if (firstRun && firstRun.text.length === 0) runs.shift()
      const lastRun = runs[runs.length - 1]
      if (lastRun) lastRun.text = lastRun.text.replace(/[\n ]+$/, '')
      if (lastRun && lastRun.text.length === 0 && runs.length > 0) runs.pop()
      return runs.filter((r) => r.text.length > 0)
    }

    /** Text rects on this slide, for the pairwise overlap check at the end
     *  of the walk (text-over-text is a layout bug; text over a box/image is
     *  legitimate and unchecked). */
    const textRects: Array<{ x: number; y: number; w: number; h: number; label: string }> = []
    const emitText = (owner: HTMLElement, rect: { x: number; y: number; w: number; h: number }, nodes: Node[], positioned: boolean, bullet?: { level: number; ordered: boolean }) => {
      const runs = buildRuns(nodes, owner)
      if (runs.length === 0) return
      const c = window.getComputedStyle(owner)
      const align = c.textAlign === 'center' || c.textAlign === 'right' || c.textAlign === 'justify' ? c.textAlign : 'left'
      const block: CollectResult['slides'][number]['blocks'][number] = {
        kind: 'text', x: rect.x - ox, y: rect.y - oy, w: rect.w, h: rect.h, runs, align, positioned,
      }
      if (c.lineHeight && c.lineHeight !== 'normal') {
        const lh = px(c.lineHeight)
        const fs = px(c.fontSize)
        if (lh > 0 && fs > 0) block.lineHeightMultiple = Math.round((lh / fs) * 100) / 100
      }
      if (bullet) block.bullet = bullet
      blocks.push(block)
      bounds(block, desc(owner))
      if (rect.w > 1 && rect.h > 1) textRects.push({ x: block.x, y: block.y, w: rect.w, h: rect.h, label: desc(owner) })
    }

    const emitImage = (el: HTMLElement, positioned: boolean) => {
      const r = el.getBoundingClientRect()
      const src = el.getAttribute('src') || ''
      if (!src) {
        errors.push({ page, message: `${desc(el)} 缺少 src——图片必须是工作区里的文件（png/jpg/jpeg/gif）。` })
        return
      }
      const c = window.getComputedStyle(el)
      const block: CollectResult['slides'][number]['blocks'][number] = {
        kind: 'image', x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, src, positioned,
        ...(c.objectFit === 'cover' ? { objectFit: 'cover' as const } : {}),
      }
      if (c.objectFit === 'cover') {
        // pptxgenjs sizes images against the element frame (it never decodes
        // the natural size), so ITS cover is a no-op — the crop must be
        // computed here where the browser knows both aspects, and injected
        // into the pic's srcRect by the emitter's post-pass.
        const img = el as HTMLImageElement
        const nw = img.naturalWidth || 0
        const nh = img.naturalHeight || 0
        if (nw > 0 && nh > 0 && r.width > 0 && r.height > 0) {
          block.naturalW = nw
          block.naturalH = nh
          const boxAspect = r.width / r.height
          const natAspect = nw / nh
          if (natAspect > boxAspect * 1.001) {
            // image wider than the window: crop left/right
            const renderedW = r.height * natAspect
            const crop = (renderedW - r.width) / (2 * renderedW)
            block.coverCrop = { l: crop, r: crop, t: 0, b: 0 }
          } else if (natAspect < boxAspect * 0.999) {
            // taller: crop top/bottom
            const renderedH = r.width / natAspect
            const crop = (renderedH - r.height) / (2 * renderedH)
            block.coverCrop = { l: 0, r: 0, t: crop, b: crop }
          }
        }
        // pptx cover crops centered — an off-center object-position would be
        // a silent reframe, so it degrades by name instead.
        const pos = (c.objectPosition || '').replace(/\s+/g, ' ').trim()
        if (pos && pos !== '50% 50%' && pos !== 'center' && pos !== 'center center') {
          degradations.push(`第 ${page} 页：${desc(el)} 的 object-position:${pos} 未映射——cover 按居中裁切`)
        }
      }
      blocks.push(block)
      bounds(block, desc(el))
    }

    const emitTable = (el: HTMLTableElement, positioned: boolean) => {
      const r = el.getBoundingClientRect()
      const rows = Array.from(el.rows)
      if (rows.length === 0) { errors.push({ page, message: `${desc(el)} 是空表格——至少要有一行。` }); return }
      const cells: TableCellFacts[][] = []
      const rowHeightsPx: number[] = []
      let colWidthsPx: number[] = []
      for (const tr of rows) {
        rowHeightsPx.push(tr.getBoundingClientRect().height)
        const rowCells: TableCellFacts[] = []
        const widths: number[] = []
        for (const cell of Array.from(tr.cells)) {
          if (cell.colSpan > 1 || cell.rowSpan > 1) {
            errors.push({ page, message: `${desc(cell)} 用了 colspan/rowspan——设计路线的表格不支持合并单元格，拆成普通格子或改用色块拼。` })
            return
          }
          const cc = window.getComputedStyle(cell)
          const fill = readColor(cc.backgroundColor)
          const col = readColor(cc.color)
          if (col && col.transparency !== undefined) {
            errors.push({ page, message: `${desc(cell)} 的文字色用了半透明——文字没有透明度可映射，改用调淡后的 hex。` })
          }
          const text = (cell.innerText !== undefined ? cell.innerText : cell.textContent || '')
            .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
          rowCells.push({
            text,
            header: cell.tagName === 'TH',
            bold: cc.fontWeight === 'bold' || cc.fontWeight === 'bolder' || parseInt(cc.fontWeight || '400', 10) >= 600 || cell.tagName === 'TH',
            color: col && col.hex ? col.hex : '262626',
            fontSizePx: px(cc.fontSize) || 14,
            align: cc.textAlign === 'center' || cc.textAlign === 'right' ? cc.textAlign : 'left',
            fill: fill && fill.hex ? fill.hex : undefined,
            ...(fill && fill.transparency !== undefined ? { fillTransparency: fill.transparency } : {}),
          })
          widths.push(cell.getBoundingClientRect().width)
        }
        if (cells.length === 0) colWidthsPx = widths
        // Ragged rows: the browser renders them fine, but the emitter sizes
        // columns from row 1 (`colWidthsPx`) and hands pptxgenjs one colW per
        // FIRST-ROW cell — a row with more cells than that produced
        // gridCol-count < tc-count, an OOXML shape PowerPoint offers to
        // "repair" (review_20261006 中8; the old deck route's rows≈header
        // check shrank away with spec.ts). Refuse at the collector, named by
        // row, same as the colspan refusal above.
        if (cells.length > 0 && rowCells.length !== cells[0].length) {
          errors.push({ page, message: `${desc(el)} 第 ${cells.length + 1} 行是 ${rowCells.length} 个单元格，与第 1 行的 ${cells[0].length} 个不一致——行间列数必须一致（列宽按首行取），补齐或删掉多余格子。` })
          return
        }
        cells.push(rowCells)
      }
      const block = { kind: 'table' as const, x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, colWidthsPx, rowHeightsPx, cells, positioned }
      blocks.push(block)
      bounds(block, desc(el))
    }

    // inline groups between block children: text-ish nodes accumulate into one
    // anonymous text block (rect = union of the nodes' own line boxes); an
    // <img> splits the group. Range rects are layout facts — jsdom has none,
    // so a range failure degrades to "no rects" and the batch is skipped
    // (in-page this never throws).
    const rectsOf = (node: Node): DOMRect[] => {
      try {
        const rg = document.createRange()
        rg.selectNode(node)
        return Array.from(rg.getClientRects())
      } catch {
        return []
      }
    }
    const flushInline = (owner: HTMLElement, positioned: boolean) => {
      if (inlineGroup.length === 0) { inlineGroup = []; return }
      const nodes = inlineGroup
      inlineGroup = []
      const emitBatch = (batch: Node[], rects: DOMRect[]) => {
        const rect = unionRect(rects)
        if (rect.w <= 0.5 || rect.h <= 0.5) return
        emitText(owner, rect, batch, positioned)
      }
      let batch: Node[] = []
      let rects: DOMRect[] = []
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          batch.push(node); rects.push(...rectsOf(node))
          return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const el = node as HTMLElement
        if (el.tagName === 'IMG') { emitBatch(batch, rects); batch = []; rects = []; emitImage(el, positioned); return }
        if (el.tagName === 'BR') { batch.push(el); rects.push(...rectsOf(el)); return }
        for (const child of Array.from(el.childNodes)) walk(child)
      }
      for (const n of nodes) walk(n)
      emitBatch(batch, rects)
    }

    const visit = (el: HTMLElement, listDepth: number, listOrdered: boolean, positioned: boolean) => {
      const c = window.getComputedStyle(el)
      if (c.display === 'none') return
      if (!ALLOWED_TAGS.has(el.tagName)) {
        errors.push({ page, message: `不允许的元素 <${el.tagName.toLowerCase()}>——设计路线的白名单见 references/pptx.md（图表用 data-chart 标注，装饰用色块与图片）。` })
        return
      }
      if (c.transform && c.transform !== 'none') {
        errors.push({ page, message: `${desc(el)} 用了 transform——设计路线拒绝 CSS 变换，把位置和尺寸直接写进布局。` })
        return
      }
      if (c.position === 'fixed') {
        errors.push({ page, message: `${desc(el)} 用了 position:fixed——画布上没有视口概念，用 absolute。` })
        return
      }
      if (c.backgroundImage && c.backgroundImage !== 'none') {
        errors.push({ page, message: `${desc(el)} 用了 background-image/渐变——背景只收纯色；渐变可以拆成几个纯色块近似。` })
        return
      }
      if (el.hasAttribute('data-chart')) {
        const r = el.getBoundingClientRect()
        const raw = el.getAttribute('data-chart') || ''
        if (!raw.trim()) {
          errors.push({ page, message: `${desc(el)} 的 data-chart 是空的——属性值是图表 JSON（形如 {"type":"column",...}）。` })
          return
        }
        const block = { kind: 'chart' as const, x: r.left - ox, y: r.top - oy, w: r.width, h: r.height, raw, positioned }
        blocks.push(block)
        bounds(block, desc(el))
        return
      }
      if (el.tagName === 'TABLE') { emitTable(el as HTMLTableElement, positioned); return }
      if (el.tagName === 'IMG') { emitImage(el, positioned); return }

      const selfPositioned = positioned || c.position === 'absolute' || c.position === 'relative' || c.position === 'sticky'
      const kids = Array.from(el.childNodes)
      const elementKids = kids.filter((n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE)
      const hasBlockChild = elementKids.some((k) => blockish(k))
      const hasImg = elementKids.some((k) => k.tagName === 'IMG' || (k.querySelector && k.querySelector('img')))
      const hasText = (el.textContent || '').trim().length > 0

      if (!hasBlockChild && !hasImg) {
        // a styled leaf paints its own box first, text lands on the content
        // box — two shapes, paint order keeps them stacked. An EMPTY styled
        // leaf (a pure color box / banner / shadow-only glow) still emits its
        // box: decoration fires whether or not there is text.
        const deco = el !== slideEl ? decoration(el) : {}
        if (deco.fill || deco.border || deco.shadow) {
          const r = el.getBoundingClientRect()
          const box = {
            kind: 'box' as const, x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
            fill: deco.fill, fillTransparency: deco.fillTransparency, border: deco.border, radiusPx: deco.radiusPx, shadow: deco.shadow, positioned: selfPositioned,
          }
          blocks.push(box)
          bounds(box, desc(el))
        }
        if (hasText) emitText(el, contentRect(el), kids, selfPositioned, el.tagName === 'LI' ? { level: listDepth, ordered: listOrdered } : undefined)
        return
      }

      // container: paint its own decoration first, then recurse
      if (el !== slideEl) {
        const deco = decoration(el)
        if (deco.fill || deco.border || deco.shadow) {
          const r = el.getBoundingClientRect()
          const box = {
            kind: 'box' as const, x: r.left - ox, y: r.top - oy, w: r.width, h: r.height,
            fill: deco.fill, fillTransparency: deco.fillTransparency, border: deco.border, radiusPx: deco.radiusPx, shadow: deco.shadow, positioned: selfPositioned,
          }
          blocks.push(box)
          bounds(box, desc(el))
        }
      }

      for (const node of kids) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const k = node as HTMLElement
          if (window.getComputedStyle(k).display === 'none') continue
          if (blockish(k)) {
            flushInline(el, selfPositioned)
            const childList = k.tagName === 'UL' || k.tagName === 'OL'
            visit(k, childList ? listDepth + 1 : listDepth, k.tagName === 'OL' ? true : listOrdered, selfPositioned)
            continue
          }
        }
        inlineGroup.push(node)
      }
      flushInline(el, selfPositioned)
    }

    const slideCs = window.getComputedStyle(slideEl)
    const sbg = readColor(slideCs.backgroundColor)
    visit(slideEl, 0, false, false)

    // text-vs-text overlap: absolute layouts guessed from font sizes are this
    // route's failure mode — refuse with both element names so the model fixes
    // the html instead of shipping glyphs on glyphs (the deck route's "a weak
    // model cannot produce an overlapping page" guarantee, restored). Small
    // edge touches (≤3px) and slivers under 10% of the smaller box are
    // tolerance, not defects.
    for (let i = 0; i < textRects.length; i++) {
      for (let j = i + 1; j < textRects.length; j++) {
        const a = textRects[i]
        const b = textRects[j]
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ix <= 3 || iy <= 3) continue
        const minArea = Math.min(a.w * a.h, b.w * b.h)
        if (ix * iy < minArea * 0.1) continue
        errors.push({
          page,
          message: `${a.label} 与 ${b.label} 文字区域重叠（相交 ${Math.round(ix)}×${Math.round(iy)}px）——绝对定位要按实际渲染高度排：缩短上方文本、下移下方元素，或拉开间距。`,
        })
      }
    }
    slideFacts.push({
      background: sbg && sbg.hex ? sbg.hex : undefined,
      backgroundTransparency: sbg && sbg.transparency !== undefined ? sbg.transparency : undefined,
      blocks,
    })
  })

  if (slides.length === 0) {
    errors.push({ page: 0, message: '没有找到任何 .slide 页——每页一个 <div class="slide">（960×540px），按文档顺序成为第 1、2、… 页。' })
  } else if (slides.length > SLIDE_CAP) {
    errors.push({ page: 0, message: `${slides.length} 页超过上限 ${SLIDE_CAP}——拆成多份导出。` })
  }
  return { slides: slideFacts, errors, degradations }
}
