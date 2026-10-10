/** Panel markdown renderer (PLAN-browser-extension M1.1).
 *
 * The transcript renders assistant output (and later page content) into the
 * page, so escaping is a security boundary, not a formatting detail: nothing the
 * model or the page produces may become live script, a `javascript:` href, or
 * an event handler. Raw HTML therefore renders only through the sanitizer
 * (DOMPurify, explicit allowlist) — same as the desktop's XMarkdown, which
 * feeds raw HTML through htmlparser2. DOMPurify needs a DOM: the suite runs in
 * node, so a jsdom window is installed before any render call. */

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { escapeHtml, renderMarkdown, splitHtmlFences } from '../src/extension/ui/markdown'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as unknown as { window: Window }).window = dom.window as unknown as Window
;(globalThis as unknown as { document: Document }).document = dom.window.document

describe('panel markdown', () => {
  it('strips live HTML but keeps its text', () => {
    // `<script>` is not an allowed tag: the tags vanish, the payload stays as
    // inert text — it must not disappear silently (lost content reads as a
    // renderer bug) and must not survive as markup.
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>alert(1)</p>')
    const img = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(img).not.toContain('onerror')
    expect(img).toContain('<img')
    expect(escapeHtml('a & b "c" \'d\' <e>')).toBe('a &amp; b &quot;c&quot; &#39;d&#39; &lt;e&gt;')
  })

  it('renders html blocks the desktop renders, sanitized', () => {
    // The styled-card shape models actually emit, as a block and self-closed.
    const card = renderMarkdown('<div style="color:red">卡片</div>')
    expect(card).toContain('<div style="color:red">卡片</div>')
    const multi = renderMarkdown('<div style="background:#f5f5f5">\n第一行\n第二行\n</div>')
    expect(multi).toContain('<div style="background:#f5f5f5">')
    expect(multi).toContain('第一行')
    expect(multi).toContain('</div>')
    // Markdown is not parsed inside a raw html block (desktop parity).
    expect(renderMarkdown('<div>**not bold**</div>')).toContain('<div>**not bold**</div>')
  })

  it('renders a NESTED same-tag card as one block — no line dropped, no split (review 2026-10-10 高1)', () => {
    // Every inner line ends in its own </div>: the flagship shape for styled
    // cards. The old first-close-line rule tested the closing line BEFORE
    // pushing it — the title row vanished, the outer card became an empty
    // shell and the body escaped as a sibling root.
    const src = '<div class="card">\n  <div class="title">标题</div>\n  <div class="body">内容正文</div>\n</div>'
    expect(renderMarkdown(src)).toBe('<div class="card">\n  <div class="title">标题</div>\n  <div class="body">内容正文</div>\n</div>')
    // The single-line balanced shape stays intact too.
    expect(renderMarkdown('<div class="card"><div class="title">t</div><div class="body">b</div></div>')).toBe(
      '<div class="card"><div class="title">t</div><div class="body">b</div></div>',
    )
  })

  it('keeps a still-open card across blank lines, but an unclosed fragment falls back to the blank line', () => {
    // The desktop's parser keeps the element open across blank lines; so does
    // the block collection while the tag is unclosed.
    const blanked = renderMarkdown('<div class="card">\n  <div class="title">标题</div>\n\n  <div class="body">内容</div>\n</div>')
    expect(blanked).toContain('<div class="title">标题</div>')
    expect(blanked).toContain('<div class="body">内容</div>')
    expect(blanked).not.toContain('<p>') // nothing leaked into markdown parsing
    // An unbalanced fragment must not swallow the rest of the document: the
    // block ends at its first blank line and markdown parsing resumes.
    const unclosed = renderMarkdown('<div class="card">\nfragment\n\nmore **text**')
    expect(unclosed).toContain('fragment</div>')
    expect(unclosed).toContain('<p>more <strong>text</strong></p>')
  })

  it('an <hr> html block is complete on its own line (void tags never close)', () => {
    // Depth-counting hr would wait forever for </hr> and swallow the rest.
    expect(renderMarkdown('<hr>\n## Heading')).toBe('<hr>\n<h2>Heading</h2>')
  })

  it('keeps code spans inside paired inline html spans (review 2026-10-10 中1)', () => {
    // The code span is stashed first, so the paired-span sanitization used to
    // receive NUL sentinels — which the HTML parser drops — corrupting them
    // into a bare digit + \u0001 and losing the code content.
    expect(renderMarkdown('<b>a `x` b</b>')).toBe('<p><b>a <code>x</code> b</b></p>')
    expect(renderMarkdown('<span>用 `npm i` 安装</span>')).toBe('<p><span>用 <code>npm i</code> 安装</span></p>')
    const out = renderMarkdown('<code>`deep`</code> and <b>`x`</b>')
    expect(out).toContain('<code>deep</code>')
    expect(out).toContain('<code>x</code>')
    // No sentinel residue of any generation (control chars or PUA).
    for (const ch of ['\u0000', '\u0001', '\uE000', '\uE001']) {
      expect(out.includes(ch)).toBe(false)
    }
  })

  it('strips position:fixed/sticky from style — model HTML must not overlay the viewport (review 2026-10-10 中2)', () => {
    // The panel host is position:fixed at the top of the z-order; a fixed
    // descendant's containing block is the viewport, which no overflow clip
    // can cut — so surviving fixed would paint an interactive full-page mask.
    const overlay = renderMarkdown('<div style="position:fixed;inset:0;z-index:99999;background:#fff">overlay</div>')
    expect(overlay).not.toContain('fixed')
    expect(overlay).toContain('background:#fff') // the styled-card feature survives
    const onlyFixed = renderMarkdown('<div style="position:fixed">x</div>')
    expect(onlyFixed).not.toContain('style=')
    expect(renderMarkdown('<div style="Position: Sticky;top:0">x</div>')).not.toMatch(/sticky/i)
    // Contained positioning stays — it cannot escape the panel.
    expect(renderMarkdown('<div style="position:absolute;left:0">x</div>')).toContain('position:absolute')
  })

  it('sanitizes html blocks: no handlers, no script/style/frame, no javascript: hrefs', () => {
    expect(renderMarkdown('<div onclick="alert(1)">x</div>')).not.toContain('onclick')
    expect(renderMarkdown('<div onclick="alert(1)">x</div>')).toContain('>x<')
    const style = renderMarkdown('<style>body { visibility: hidden }</style>')
    expect(style).not.toContain('<style')
    expect(renderMarkdown('<iframe src="https://evil.example"></iframe>')).not.toContain('<iframe')
    expect(renderMarkdown('<form action="https://evil.example"><input name="pw"></form>')).not.toContain('<form')
    const js = renderMarkdown('<a href="javascript:alert(1)">点我</a>')
    expect(js).not.toContain('javascript:')
    expect(js).toContain('点我')
  })

  it('forces sanitized links to open outside the page', () => {
    const out = renderMarkdown('<a href="https://example.com/a">docs</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noreferrer noopener"')
  })

  it('renders inline html inside paragraphs, sanitized', () => {
    expect(renderMarkdown('这是 <b>重点</b> 和 <span style="color:red">红色</span>')).toBe(
      '<p>这是 <b>重点</b> 和 <span style="color:red">红色</span></p>',
    )
    // Code spans stay literal: the inline-html rule runs after them and must
    // never see their content.
    expect(renderMarkdown('`<b>x</b>`')).toBe('<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>')
  })

  it('escapes code spans and fences', () => {
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

  it('splits ```html artifact fences out of the markdown runs', () => {
    // The exact shape the system prompt teaches: prose, then a ```html card,
    // then more prose. The fence body rides verbatim; the md runs re-join.
    const segs = splitHtmlFences('前言\n\n```html\n<div style="color:red">卡片</div>\n```\n\n后记')
    expect(segs).toEqual([
      { kind: 'md', text: '前言\n\n' },
      { kind: 'html', text: '<div style="color:red">卡片</div>', partial: false },
      { kind: 'md', text: '\n后记' },
    ])
    // Non-html fences stay markdown (they render as code blocks).
    expect(splitHtmlFences('```js\nconst a = 1\n```')).toEqual([{ kind: 'md', text: '```js\nconst a = 1\n```' }])
    // Case-insensitive first info word, like the desktop's isHtmlFenceLang.
    expect(splitHtmlFences('```HTML hl_lines\n<b>x</b>\n```')[0].kind).toBe('html')
    // An unterminated html fence is the live stream's tail.
    const tail = splitHtmlFences('前\n```html\n<div>')
    expect(tail[1]).toEqual({ kind: 'html', text: '<div>', partial: true })
    // An empty html fence is not a card — back to markdown (renders as code).
    expect(splitHtmlFences('```html\n```')).toEqual([{ kind: 'md', text: '```html\n```' }])
    // No fences: a single md segment carrying the source untouched.
    expect(splitHtmlFences('plain **text**')).toEqual([{ kind: 'md', text: 'plain **text**' }])
  })
})
