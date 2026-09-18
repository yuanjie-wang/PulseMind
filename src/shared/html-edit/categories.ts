// ── Element categories (PLAN-html-element-edit §设计4) ──
// One definition shared by the panel (which controls to render) and the
// picker (which elements a double-click may edit in place) — two copies
// drifting apart is what would make the picker offer editing the panel
// refuses to commit.

export const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'li', 'td', 'th', 'button', 'label',
  'blockquote', 'strong', 'em', 'b', 'i', 'u', 'small', 'code', 'figcaption', 'dt', 'dd',
  'summary', 'cite', 'q', 'time', 'pre', 'a',
])
export const CONTAINER_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'main', 'nav', 'article', 'aside', 'form',
  'figure', 'table', 'tr', 'body',
])
export const LIST_TAGS = new Set(['ul', 'ol'])
export const FORM_TAGS = new Set(['input', 'textarea', 'select'])

export type ElementCategory = 'text' | 'image' | 'list' | 'form' | 'container'

export function categoryOf(tag: string): ElementCategory {
  if (tag === 'img') return 'image'
  if (LIST_TAGS.has(tag)) return 'list'
  if (FORM_TAGS.has(tag)) return 'form'
  if (TEXT_TAGS.has(tag)) return 'text'
  return 'container'
}

/** D7: which categories may enter in-place contenteditable editing — the
 *  text family (even with inline children: the live-DOM commit preserves
 *  them), plus a list or container whose content is pure text (no element
 *  children — a list item IS text, and a div-wrapped text line was the
 *  2026-09-18 「无法直接编辑文字」 report's unreachable case). A container
 *  with element children stays out: its commit re-serializes the whole
 *  subtree's innerHTML, too blunt for a layout wrapper. */
export function isInPlaceEditableCategory(tag: string, elementChildCount: number): boolean {
  const category = categoryOf(tag)
  if (category === 'text') return true
  return (category === 'list' || category === 'container') && elementChildCount === 0
}
