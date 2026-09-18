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

const REPEATED_PAGE_SHELL_TAGS = new Set(['HEADER', 'FOOTER'])

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

  const groups = groupByHeight(Array.from(article.children) as HTMLElement[], limit)
  if (groups.length < 2) return

  let anchor = section
  for (let i = 1; i < groups.length; i++) {
    const page = clonePageShell(section, className)
    const body = article.cloneNode(false) as HTMLElement
    for (const child of groups[i]) body.appendChild(child)
    page.appendChild(body)
    anchor.insertAdjacentElement('afterend', page)
    anchor = page
  }
}

/** Greedy fill: a child starts a new page when its bottom would pass the
 *  page's content box. Reading each child's own layout offsets makes the
 *  accumulated paragraph margins count exactly as the browser laid them out
 *  (offsets already bake in margin collapsing; summing heights would not). A
 *  single child taller than a page is placed alone and overflows it. */
function groupByHeight(children: HTMLElement[], limit: number): HTMLElement[][] {
  const first = children[0]
  if (!first) return []
  const groups: HTMLElement[][] = []
  let current: HTMLElement[] = []
  let pageTop = first.offsetTop
  for (const child of children) {
    const bottom = child.offsetTop + child.offsetHeight
    if (current.length > 0 && bottom - pageTop > limit) {
      groups.push(current)
      current = []
      pageTop = child.offsetTop
    }
    current.push(child)
  }
  if (current.length > 0) groups.push(current)
  return groups
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
