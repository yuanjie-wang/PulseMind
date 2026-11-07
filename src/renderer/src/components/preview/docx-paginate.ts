// ── Measurement-based pagination for docx-preview ──
// docx-preview has no layout engine: it breaks pages only where the document
// says to (`w:br type="page"`, `pageBreakBefore`, section changes, and — with
// `ignoreLastRenderedPageBreak: false` — Word's own `w:lastRenderedPageBreak`
// hints). A document written by a generator that records none of those renders
// as one continuous sheet even though Word would break it across pages.
//
// This pass supplies the missing breaks the only way a browser can: it measures
// the rendered content against the page's own content box (page height minus
// the section's top/bottom margins, every one of which docx-preview writes
// inline from `w:pgSz` / `w:pgMar`) and moves the overflow into additional
// `<section>` pages cloned from the first — page geometry is per section, so a
// new page reuses it verbatim.
//
// It is a no-op for a document that already fits one page or already paginated
// from explicit hints, so it can run unconditionally after every render.
//
// Consumers: the in-app DocxPreview and the docx→PDF conversion page
// (src/renderer/docx2pdf/index.ts). The PDF path depends on the fit test being
// EXACT: a page that overflows its box is fragmented by Chromium's own
// print paginator, which ignores the docx margins and slices mid-paragraph at
// whatever y it likes (that is how exported PDFs ended up with text 13pt from
// the paper edge and a second page starting 1.3pt from the top).

const REPEATED_PAGE_SHELL_TAGS = new Set(['HEADER', 'FOOTER'])

/** One laid-out block (a paragraph, table, list item…) as the splitter sees it.
 *  `top`/`bottom` are viewport-independent offsets in the same laid-out pixel
 *  space (offsetTop/offsetHeight); the margins are the computed ones, which
 *  offsets do NOT include — a block's own margin is outside its box. */
export interface DocxPageBlock {
  top: number
  bottom: number
  marginTop: number
  marginBottom: number
  /** Block must stay with the block after it (headings). */
  keepWithNext: boolean
}

/** Height a group of blocks occupies when it STARTS a page.
 *
 *  This is the whole point of the pass, and it is not `last.bottom -
 *  first.top`: on a fresh page the first block's top margin no longer collapses
 *  with a previous sibling (it is contained by the page's padding), and the
 *  last block's bottom margin still takes up room below it. Ignoring either
 *  lets a group measure as "fits" and then overflow the page box by exactly
 *  those margins — measured at 21.5px on a page that looked fine in the old
 *  fit test. */
function groupHeight(group: DocxPageBlock[]): number {
  const first = group[0]
  const last = group[group.length - 1]
  return first.marginTop + (last.bottom - first.top) + last.marginBottom
}

/** Greedy fill returning the block INDICES of each page. A block starts a new
 *  page when the page would overflow with it added. When the break lands after
 *  a keep-with-next block (a heading), the heading is carried to the next page
 *  instead of being stranded at the bottom of this one — but never at the cost
 *  of emptying the page (a heading that is the page's first block stays, or two
 *  consecutive headings would push each other forever). A single block taller
 *  than a page is placed alone and overflows it; nothing can split a paragraph.
 */
export function planDocxPages(blocks: DocxPageBlock[], limit: number): number[][] {
  if (blocks.length === 0 || limit <= 0) return []
  const pages: number[][] = []
  let current: number[] = []
  const wouldOverflow = (next: number): boolean =>
    current.length > 0 && groupHeight([...current, next].map((i) => blocks[i])) > limit
  for (let i = 0; i < blocks.length; i++) {
    if (wouldOverflow(i)) {
      const carry: number[] = []
      while (current.length > 1 && blocks[current[current.length - 1]].keepWithNext) {
        carry.unshift(current.pop() as number)
      }
      pages.push(current)
      current = carry
    }
    current.push(i)
  }
  if (current.length > 0) pages.push(current)
  return pages
}

export function paginateDocxPages(container: HTMLElement, className: string): void {
  container
    .querySelectorAll<HTMLElement>(`section.${className}`)
    .forEach((section) => splitSection(section, className))
}

function splitSection(section: HTMLElement, className: string): void {
  const articles = Array.from(section.children).filter(
    (node): node is HTMLElement => node.tagName === 'ARTICLE'
  )
  // A page group with several <article> elements is a continuous-section
  // document (columns changing without a page break). Splitting the first
  // article alone would interleave content, so leave the group as laid out.
  if (articles.length !== 1) return
  const article = articles[0]

  const limit = contentBoxHeight(section)
  if (limit <= 0) return

  const children = Array.from(article.children).filter(
    (node): node is HTMLElement => node.nodeType === Node.ELEMENT_NODE
  )
  const pages = planDocxPages(measureBlocks(children), limit)
  if (pages.length < 2) return

  let anchor = section
  for (let i = 1; i < pages.length; i++) {
    const page = clonePageShell(section, className)
    const body = article.cloneNode(false) as HTMLElement
    for (const index of pages[i]) body.appendChild(children[index])
    page.appendChild(body)
    anchor.insertAdjacentElement('afterend', page)
    anchor = page
  }
}

/** Offsets already bake in margin collapsing between siblings (`offsetTop` is
 *  where the box actually landed), so the splitter only needs each block's own
 *  margins for the two edges a page break un-collapses. Heading detection is
 *  deliberately tag-agnostic: docx-preview writes `p.docx_headingN` and the PDF
 *  page promotes those to `<hN>` before paginating. */
function measureBlocks(children: HTMLElement[]): DocxPageBlock[] {
  return children.map((child) => {
    const style = getComputedStyle(child)
    return {
      top: child.offsetTop,
      bottom: child.offsetTop + child.offsetHeight,
      marginTop: px(style.marginTop),
      marginBottom: px(style.marginBottom),
      keepWithNext: isHeadingBlock(child),
    }
  })
}

function px(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

function isHeadingBlock(el: HTMLElement): boolean {
  return /^H[1-6]$/.test(el.tagName) || /heading/i.test(el.className)
}

/** The height a page has for its body, in the same (unzoomed) layout pixels
 *  the offsets are measured in. Both numbers must come from the COMPUTED
 *  style: docx-preview writes the page height as `min-height: 841.90pt` (its
 *  length unit is points, not pixels) while the browser resolves padding to
 *  px, so reading `section.style.minHeight` would subtract 96px from 841.9pt.
 *  When no page height is set (`ignoreHeight`), fall back to the laid-out
 *  box — such a page has no fixed page size to split against anyway. */
function contentBoxHeight(section: HTMLElement): number {
  const style = getComputedStyle(section)
  const pageHeight = parseFloat(style.minHeight) || section.clientHeight
  return pageHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0')
}

/** A fresh page carrying `section`'s geometry (class + inline geometry attrs)
 *  and its repeating header/footer. Footnotes/endnotes are deliberately left
 *  on the page that had them — they are content, not chrome. */
function clonePageShell(section: HTMLElement, className: string): HTMLElement {
  const page = document.createElement('section')
  page.className = className
  for (const attr of Array.from(section.attributes)) {
    if (attr.name !== 'class') page.setAttribute(attr.name, attr.value)
  }
  for (const node of Array.from(section.children)) {
    if (REPEATED_PAGE_SHELL_TAGS.has(node.tagName)) page.appendChild(node.cloneNode(true))
  }
  return page
}
