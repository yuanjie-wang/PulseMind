// Element span resolution + span patching + verifyPatch
// (PLAN-html-element-edit M2 — the highest-risk module, so the tests are the
// heaviest: byte-exact outputs, fostering, script content, CRLF, and refusals
// for everything without a source representation. A deliberately corrupted
// span offset is asserted to produce DIFFERENT bytes, which is what keeps
// these assertions non-vacuous: any resolve-offset regression goes red here.)

import { describe, expect, it } from 'vitest'
import {
  resolveElement,
  elementOuterHtml,
  type ElementLocation,
} from '../src/shared/html-edit/resolve'
import {
  applyInnerHtml,
  decodedInnerText,
  escapeHtmlText,
  mergeStyleDecls,
  parseStyleDecls,
  removeElement,
  replaceElement,
  setAttributes,
  setInlineStyle,
  spanIsValid,
  verifyPatch,
} from '../src/shared/html-edit/patch'

const SRC =
  '<!DOCTYPE html><html><head><title>T</title></head><body><div class="hero" data-x="a>b"><h1 style="color: red; font-size: 12px" id="t">Hello</h1><img src="a.png"><br><!-- c --><p>para <b>bold</b> tail</p></div></body></html>'

const H1_PATH = 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)'
const DIV_PATH = 'html>body:nth-child(2)>div:nth-child(1)'
const IMG_PATH = 'html>body:nth-child(2)>div:nth-child(1)>img:nth-child(2)'
const P_PATH = 'html>body:nth-child(2)>div:nth-child(1)>p:nth-child(4)'

function expectResolved(path: string, source = SRC): ElementLocation {
  const result = resolveElement(source, path)
  if (!result.ok) throw new Error(`resolve failed for ${path}: ${result.reason}`)
  return result.location
}

describe('resolveElement', () => {
  it('resolves exact spans through nesting', () => {
    const loc = expectResolved(H1_PATH)
    expect(loc.tagName).toBe('h1')
    expect(SRC.slice(loc.startTag.start, loc.startTag.end)).toBe('<h1 style="color: red; font-size: 12px" id="t">')
    expect(SRC.slice(loc.inner!.start, loc.inner!.end)).toBe('Hello')
    expect(SRC.slice(loc.endTag!.start, loc.endTag!.end)).toBe('</h1>')
    expect(elementOuterHtml(SRC, loc)).toBe('<h1 style="color: red; font-size: 12px" id="t">Hello</h1>')
  })

  it('collects attribute spans and values (including > inside a value)', () => {
    const loc = expectResolved(DIV_PATH)
    expect(loc.attributes['data-x']).toBe('a>b')
    expect(SRC.slice(loc.attrs['data-x']!.span.start, loc.attrs['data-x']!.span.end)).toBe('data-x="a>b"')
    expect(loc.attrs['style']).toBeUndefined()
    expect(loc.attributes['class']).toBe('hero')
  })

  it('treats void elements as start-tag-only', () => {
    const loc = expectResolved(IMG_PATH)
    expect(loc.endTag).toBeNull()
    expect(loc.inner).toBeNull()
    expect(elementOuterHtml(SRC, loc)).toBe('<img src="a.png">')
    const br = expectResolved('html>body:nth-child(2)>div:nth-child(1)>br:nth-child(3)')
    expect(br.endTag).toBeNull()
  })

  it('ignores comments when indexing element children', () => {
    // The comment sits between <br> and <p>; p is still the 4th element child.
    const loc = expectResolved(P_PATH)
    expect(loc.tagName).toBe('p')
    expect(SRC.slice(loc.inner!.start, loc.inner!.end)).toBe('para <b>bold</b> tail')
    expect(loc.hasScriptLikeChildren).toBe(false)
  })

  it('flags script-like children for the in-place edit gate (D7)', () => {
    const src = '<html><body><div>ok<script>var a = 1;</script></div></body></html>'
    const loc = expectResolved('html>body:nth-child(2)>div:nth-child(1)', src)
    expect(loc.hasScriptLikeChildren).toBe(true)
  })

  it('resolves fostered elements at their original source bytes', () => {
    // "stray" text and the <h1> are fostered out of the table by the HTML
    // parsing algorithm — identically in the live DOM and in parse5, so the
    // picker's path resolves and the span still points INSIDE the table.
    const src = '<html><body><table>stray<h1 id="x">cell</h1></table></body></html>'
    const loc = expectResolved('html>body:nth-child(2)>h1:nth-child(1)', src)
    expect(loc.tagName).toBe('h1')
    expect(src.slice(loc.startTag.start, loc.endTag!.end)).toBe('<h1 id="x">cell</h1>')
  })

  it('refuses elements without a source location (D6)', () => {
    // '<p>hi</p>' parses with an IMPLICIT html/body — no source bytes exist
    // for them, exactly like script-created elements in a live DOM.
    const result = resolveElement('<p>hi</p>', 'html')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('没有对应的源码位置')
  })

  it('refuses unresolvable and malformed paths', () => {
    expect(resolveElement(SRC, 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(2)').ok).toBe(false)
    expect(resolveElement(SRC, 'html>body:nth-child(2)>section:nth-child(9)').ok).toBe(false)
    expect(resolveElement(SRC, 'garbage>').ok).toBe(false)
  })

  it('refuses a tag mismatch on the walked path', () => {
    expect(resolveElement(SRC, 'html>body:nth-child(2)>div:nth-child(1)>h2:nth-child(1)').ok).toBe(false)
  })
})

describe('setInlineStyle', () => {
  it('rewrites one declaration and keeps the others, byte-exact', () => {
    const loc = expectResolved(H1_PATH)
    const patched = setInlineStyle(SRC, loc, { 'font-size': '20px' })
    expect(patched).toBe(
      '<!DOCTYPE html><html><head><title>T</title></head><body><div class="hero" data-x="a>b"><h1 style="color: red; font-size: 20px" id="t">Hello</h1><img src="a.png"><br><!-- c --><p>para <b>bold</b> tail</p></div></body></html>',
    )
    expect(verifyPatch(patched, { pmPath: H1_PATH, tag: 'h1', styleProps: ['font-size'] }).ok).toBe(true)
  })

  it('creates the style attribute on an element without one', () => {
    const loc = expectResolved(DIV_PATH)
    const patched = setInlineStyle(SRC, loc, { 'background-color': '#f0f0f0' })
    expect(patched).toContain('<div class="hero" data-x="a>b" style="background-color: #f0f0f0">')
    expect(verifyPatch(patched, { pmPath: DIV_PATH, styleProps: ['background-color'] }).ok).toBe(true)
  })

  it('removes a declaration with null and drops the whole attr when empty', () => {
    const loc = expectResolved(H1_PATH)
    const removed = setInlineStyle(SRC, loc, { color: null })
    expect(removed).toContain('<h1 style="font-size: 12px" id="t">')
    const all = setInlineStyle(SRC, loc, { color: null, 'font-size': null })
    expect(all).toContain('<h1 id="t">')
    expect(verifyPatch(all, { pmPath: H1_PATH, styleProps: ['color'] }).ok).toBe(false)
  })

  it('appends style before a self-closing bracket', () => {
    const src = '<html><body><img src="a.png"/></body></html>'
    const loc = expectResolved('html>body:nth-child(2)>img:nth-child(1)', src)
    const patched = setInlineStyle(src, loc, { width: '100px' })
    expect(patched).toBe('<html><body><img src="a.png" style="width: 100px"/></body></html>')
  })

  it('preserves CRLF line endings outside the patched span', () => {
    const crlf = '<html>\r\n<body>\r\n<div class="hero">\r\n<h1 style="color: red" id="t">Hello</h1>\r\n</div>\r\n</body>\r\n</html>'
    const loc = expectResolved('html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)', crlf)
    const patched = setInlineStyle(crlf, loc, { color: 'blue' })
    expect(patched).toBe(
      '<html>\r\n<body>\r\n<div class="hero">\r\n<h1 style="color: blue" id="t">Hello</h1>\r\n</div>\r\n</body>\r\n</html>',
    )
  })

  it('keeps attr values with > intact while restyling', () => {
    const loc = expectResolved(DIV_PATH)
    const patched = setInlineStyle(SRC, loc, { padding: '8px' })
    expect(patched).toContain('data-x="a>b"')
    expect(patched).toContain('style="padding: 8px"')
  })
})

describe('mergeStyleDecls / parseStyleDecls', () => {
  it('parses around quotes and parens', () => {
    const decls = parseStyleDecls(`background: url("a;b.png"); color: red; font-family: 'x;y'`)
    expect(decls).toEqual([
      ['background', 'url("a;b.png")'],
      ['color', 'red'],
      ['font-family', "'x;y'"],
    ])
  })

  it('merges preserving order and removing nulls', () => {
    expect(mergeStyleDecls('color: red; font-size: 12px', { 'font-size': '20px', padding: '4px' })).toBe(
      'color: red; font-size: 20px; padding: 4px',
    )
    expect(mergeStyleDecls('color: red; font-size: 12px', { color: null })).toBe('font-size: 12px')
    expect(mergeStyleDecls(null, { color: 'red' })).toBe('color: red')
  })
})

describe('applyInnerHtml / replaceElement / removeElement', () => {
  it('replaces the inner span with escaping done by the caller', () => {
    const loc = expectResolved(P_PATH)
    const patched = applyInnerHtml(SRC, loc, escapeHtmlText('a < b & c'))
    expect(patched).toContain('<p>a &lt; b &amp; c</p>')
    expect(verifyPatch(patched, { pmPath: P_PATH, tag: 'p', textContains: 'a < b & c' }).ok).toBe(true)
  })

  it('replaces the whole element and keeps siblings byte-identical', () => {
    const loc = expectResolved(H1_PATH)
    const patched = replaceElement(SRC, loc, '<h1 class="new">Replaced</h1>')
    expect(patched).toBe(
      '<!DOCTYPE html><html><head><title>T</title></head><body><div class="hero" data-x="a>b"><h1 class="new">Replaced</h1><img src="a.png"><br><!-- c --><p>para <b>bold</b> tail</p></div></body></html>',
    )
    expect(verifyPatch(patched, { pmPath: H1_PATH, tag: 'h1', textContains: 'Replaced' }).ok).toBe(true)
  })

  it('replaces a void element (start-tag-only span)', () => {
    const loc = expectResolved(IMG_PATH)
    const patched = replaceElement(SRC, loc, '<img src="b.png" alt="x">')
    expect(patched).toContain('<img src="b.png" alt="x"><br>')
    expect(patched).not.toContain('a.png')
  })

  it('removes the element cleanly', () => {
    const loc = expectResolved(H1_PATH)
    const patched = removeElement(SRC, loc)
    expect(patched).toContain('<div class="hero" data-x="a>b"><img src="a.png">')
    // The removal re-indexes the following siblings — verifyPatch correctly
    // refuses the OLD path (h1 is gone)…
    expect(verifyPatch(patched, { pmPath: H1_PATH, tag: 'h1' }).ok).toBe(false)
    // …while the document still parses and p, now the 3rd element child,
    // resolves at its path.
    const p = resolveElement(patched, 'html>body:nth-child(2)>div:nth-child(1)>p:nth-child(3)')
    expect(p.ok).toBe(true)
  })

  it('edits script content without touching its markup-lookalike bytes', () => {
    const src = '<html><body><script>if (a<b) { el.innerHTML = "</div>"; }</script><p id="after">x</p></body></html>'
    const loc = expectResolved('html>body:nth-child(2)>script:nth-child(1)', src)
    expect(src.slice(loc.inner!.start, loc.inner!.end)).toBe('if (a<b) { el.innerHTML = "</div>"; }')
    const patched = applyInnerHtml(src, loc, 'console.log(1)')
    expect(patched).toBe('<html><body><script>console.log(1)</script><p id="after">x</p></body></html>')
    // A patch on the SIBLING must not have shifted: the p path re-resolves.
    expect(resolveElement(patched, 'html>body:nth-child(2)>p:nth-child(2)').ok).toBe(true)
  })
})

describe('setAttributes', () => {
  it('replaces existing attrs in place and appends new ones', () => {
    const img = expectResolved(IMG_PATH)
    const patched = setAttributes(SRC, img, { src: 'c.png', alt: 'An image' })
    expect(patched).toContain('<img src="c.png" alt="An image">')
    expect(verifyPatch(patched, { pmPath: IMG_PATH, tag: 'img' }).ok).toBe(true)

    const h1 = expectResolved(H1_PATH)
    const linked = setAttributes(SRC, h1, { href: 'https://example.com', target: '_blank' })
    expect(linked).toContain('<h1 style="color: red; font-size: 12px" id="t" href="https://example.com" target="_blank">')
  })

  it('removes an attribute with null', () => {
    const div = expectResolved(DIV_PATH)
    const patched = setAttributes(SRC, div, { 'data-x': null })
    expect(patched).toContain('<div class="hero">')
    expect(patched).not.toContain('data-x')
  })

  it('escapes double quotes in values', () => {
    const img = expectResolved(IMG_PATH)
    const patched = setAttributes(SRC, img, { alt: 'He said "hi"' })
    expect(patched).toContain('alt="He said &quot;hi&quot;"')
  })
})

describe('verifyPatch refusals (D6)', () => {
  it('refuses when the path no longer resolves', () => {
    expect(verifyPatch(SRC, { pmPath: 'html>body:nth-child(2)>div:nth-child(1)>span:nth-child(9)' }).ok).toBe(false)
  })

  it('refuses a changed tag', () => {
    expect(verifyPatch(SRC, { pmPath: H1_PATH, tag: 'h2' }).ok).toBe(false)
  })

  it('refuses a text mismatch', () => {
    expect(verifyPatch(SRC, { pmPath: H1_PATH, textContains: 'goodbye' }).ok).toBe(false)
    expect(verifyPatch(SRC, { pmPath: H1_PATH, textContains: 'Hello' }).ok).toBe(true)
  })

  it('refuses a missing style prop', () => {
    expect(verifyPatch(SRC, { pmPath: H1_PATH, styleProps: ['padding'] }).ok).toBe(false)
    expect(verifyPatch(SRC, { pmPath: H1_PATH, styleProps: ['color'] }).ok).toBe(true)
  })
})

describe('non-vacuity: corrupted offsets cannot pass', () => {
  it('a shifted start tag offset produces different (wrong) bytes', () => {
    const loc = expectResolved(H1_PATH)
    const correct = setInlineStyle(SRC, loc, { color: 'blue' })
    // Simulate an off-by-one in span resolution: the patch lands one byte
    // late — the original '<' stays as a stray text node and the patch eats
    // the 'H' of "Hello". The byte-exact assertions above are the primary
    // guard against resolve regressions; this one proves a corrupted offset
    // is at least DETECTABLE after the fact (the text check trips).
    const corrupted: ElementLocation = {
      ...loc,
      startTag: { start: loc.startTag.start + 1, end: loc.startTag.end + 1 },
    }
    const wrong = setInlineStyle(SRC, corrupted, { color: 'blue' })
    expect(wrong).not.toBe(correct)
    expect(wrong).not.toContain('Hello')
    expect(verifyPatch(wrong, { pmPath: H1_PATH, textContains: 'Hello' }).ok).toBe(false)
  })
})

describe('spanIsValid', () => {
  it('rejects out-of-range and inverted spans', () => {
    expect(spanIsValid(SRC, { start: 0, end: SRC.length })).toBe(true)
    expect(spanIsValid(SRC, { start: -1, end: 2 })).toBe(false)
    expect(spanIsValid(SRC, { start: 0, end: SRC.length + 1 })).toBe(false)
    expect(spanIsValid(SRC, { start: 5, end: 2 })).toBe(false)
  })
})

// H3 (review 2026-09-18): the panel text input's initial value is the FULL
// decoded inner text — committing it re-escapes through escapeHtmlText, so
// the round trip must be lossless.
describe('decodedInnerText', () => {
  it('decodes entities and keeps the whole text (no truncation)', () => {
    expect(decodedInnerText('a &amp; b &lt;tag&gt;')).toBe('a & b <tag>')
    expect(decodedInnerText('x'.repeat(500))).toHaveLength(500)
    expect(decodedInnerText('plain')).toBe('plain')
  })
})
