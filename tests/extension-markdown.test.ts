/** Panel markdown renderer (PLAN-browser-extension M1.1).
 *
 * The transcript renders assistant output (and later page content) into the
 * page, so escaping is a security boundary, not a formatting detail: nothing the
 * model or the page produces may become live HTML or a `javascript:` href. */

import { describe, expect, it } from 'vitest'
import { escapeHtml, renderMarkdown } from '../src/extension/ui/markdown'

describe('panel markdown', () => {
  it('escapes raw HTML instead of emitting it', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toContain('&lt;img')
    expect(escapeHtml('a & b "c" \'d\' <e>')).toBe('a &amp; b &quot;c&quot; &#39;d&#39; &lt;e&gt;')
  })

  it('escapes code spans and fences', () => {
    expect(renderMarkdown('`<b>x</b>`')).toBe('<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>')
    const fenced = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    expect(fenced).toContain('<pre><code class="pm-lang-html">&lt;script&gt;')
    expect(fenced).not.toContain('<script>')
  })

  it('refuses unsafe link targets but keeps safe ones', () => {
    const js = renderMarkdown('[click](javascript:alert(1))')
    expect(js).not.toContain('<a')
    expect(js).toContain('[click]')

    const data = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(data).not.toContain('href')

    const ok = renderMarkdown('[docs](https://example.com/a?b=1)')
    expect(ok).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noreferrer noopener">docs</a>')

    expect(renderMarkdown('[me](mailto:a@b.c)')).toContain('href="mailto:a@b.c"')
    expect(renderMarkdown('[top](#anchor)')).toContain('href="#anchor"')
  })

  it('renders the block constructs the transcript uses', () => {
    // Headings keep their real level: the light theme styles h1–h4, so a clamped
    // level would fall outside it (the desktop renders real levels too).
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>')
    expect(renderMarkdown('#### four')).toBe('<h4>four</h4>')
    expect(renderMarkdown('###### deep')).toBe('<h6>deep</h6>')
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>')
    expect(renderMarkdown('para one\n\npara two')).toBe('<p>para one</p>\n<p>para two</p>')
    expect(renderMarkdown('line one\nline two')).toBe('<p>line one<br>line two</p>')
    expect(renderMarkdown('---')).toBe('<hr>')
  })

  it('nests lists by indent and keeps an ordered list start', () => {
    expect(renderMarkdown('- a\n  - a1\n  - a2\n- b')).toBe(
      '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>',
    )
    expect(renderMarkdown('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>')
    // A marker change at the same depth starts a second list rather than
    // merging two kinds into one.
    expect(renderMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul>\n<ol><li>b</li></ol>')
  })

  it('renders a GFM table with per-column alignment', () => {
    const out = renderMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(out).toBe(
      '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th>' +
        '<th style="text-align:right">c</th></tr></thead><tbody>' +
        '<tr><td style="text-align:left">1</td><td style="text-align:center">2</td>' +
        '<td style="text-align:right">3</td></tr></tbody></table>',
    )
    // A pipe in a paragraph is not a table until a divider row follows it.
    expect(renderMarkdown('a | b')).toBe('<p>a | b</p>')
    // Cell content is still escaped and inline-rendered.
    expect(renderMarkdown('| x |\n|---|\n| **b** |')).toContain('<td><strong>b</strong></td>')
  })

  it('keeps inline emphasis inside a paragraph and off code spans', () => {
    expect(renderMarkdown('**bold** and *italic* and ~~gone~~')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <del>gone</del></p>',
    )
    // A `*` inside a code span must not be treated as emphasis.
    expect(renderMarkdown('`a * b * c`')).toBe('<p><code>a * b * c</code></p>')
  })

  it('separates blocks that would otherwise merge into one paragraph', () => {
    const out = renderMarkdown('text\n- item\n> quote\n```\ncode\n```\n# h\nend')
    expect(out).toContain('<p>text</p>')
    expect(out).toContain('<ul><li>item</li></ul>')
    expect(out).toContain('<blockquote>quote</blockquote>')
    expect(out).toContain('<pre><code>code</code></pre>')
    expect(out).toContain('<h1>h</h1>')
    expect(out).toContain('<p>end</p>')
  })

  it('handles an unterminated fence without losing the rest', () => {
    const out = renderMarkdown('```\nstill code')
    expect(out).toBe('<pre><code>still code</code></pre>')
  })
})
