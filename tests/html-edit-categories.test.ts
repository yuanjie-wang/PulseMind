// The element-category gates (PLAN-html-element-edit §设计4) — one function
// shared by the panel (which controls to render) and the frame (which
// elements a double-click may edit in place). Pure logic, node-env.

import { describe, expect, it } from 'vitest'
import { isInPlaceEditableCategory } from '../src/shared/html-edit/categories'

describe('isInPlaceEditableCategory (D7 gates)', () => {
  it('the text family edits in place regardless of inline children', () => {
    for (const tag of ['h1', 'p', 'span', 'strong', 'a', 'button', 'li']) {
      expect(isInPlaceEditableCategory(tag, 0)).toBe(true)
      expect(isInPlaceEditableCategory(tag, 2)).toBe(true)
    }
  })

  it('a list edits in place only when it has no element children', () => {
    expect(isInPlaceEditableCategory('ul', 0)).toBe(true)
    expect(isInPlaceEditableCategory('ol', 1)).toBe(false)
  })

  it('a container edits in place only when its content is pure text (2026-09-18 「无法直接编辑文字」)', () => {
    // A div-wrapped text line used to be unreachable: the old gate returned
    // false for every container, so neither double-click nor the panel could
    // edit it. Element children still stay out (the commit re-serializes the
    // whole subtree — too blunt for a layout wrapper).
    expect(isInPlaceEditableCategory('div', 0)).toBe(true)
    expect(isInPlaceEditableCategory('section', 0)).toBe(true)
    expect(isInPlaceEditableCategory('div', 1)).toBe(false)
    expect(isInPlaceEditableCategory('body', 1)).toBe(false)
  })

  it('form controls and images never edit in place', () => {
    expect(isInPlaceEditableCategory('input', 0)).toBe(false)
    expect(isInPlaceEditableCategory('textarea', 0)).toBe(false)
    expect(isInPlaceEditableCategory('select', 0)).toBe(false)
    expect(isInPlaceEditableCategory('img', 0)).toBe(false)
  })
})
