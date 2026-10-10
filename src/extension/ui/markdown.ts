/** Minimal Markdown → HTML for the panel transcript.
 *
 * Security model: the source is escaped FIRST, and every step after that only
 * introduces tags this module generates — with one deliberate exception, HTML
 * blocks/spans. The desktop transcript renders raw HTML (XMarkdown feeds it
 * through htmlparser2 + html-to-react), and the panel is the same UI, so model
 * HTML must render here too. But the panel lives in a Shadow Root inside an
 * arbitrary page, in the content script's isolated world where `chrome.runtime`
 * is reachable — so the HTML passes a sanitizer first (DOMPurify, explicit
 * allowlist: no script/style/iframe/form/svg, no event handlers, no data-*,
 * `javascript:` URIs dropped; links are forced to `target="_blank"`). The
 * sanitizer owns that boundary — hand-rolled allowlist filtering is how mXSS
 * bugs get written, so this is the one dependency the module takes. Link
 * targets in the module's OWN markdown syntax stay scheme-checked below.
 *
 * Scope tracks what the desktop transcript renders with `@ant-design/x-markdown`:
 * code fences, headings at their real level (the light theme's rules only
 * address `h1`–`h4`, so a clamped level would fall outside the styling), nested
 * lists, quotes, tables, rules, code spans, bold/italic, links, and raw HTML.
 * Anything richer (math, mermaid, syntax highlighting) belongs in the desktop UI. */

import DOMPurify from 'dompurify'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/** Link targets that are safe to emit as href. Everything else (javascript:,
 *  data:, vbscript:…) is rendered as plain text instead. */
function safeUrl(raw: string): string | null {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url
  if (/^[#/]/.test(url)) return url
  return null
}

// ── raw HTML pass-through (sanitized) ─────────────────────────────────

/** Text/structure/formatting only — the tags a model answer legitimately uses
 *  for styled cards and emphasis. Deliberately absent: script/style/link/meta
 *  (a `<style>` block would restyle the whole shadow tree), iframe/object/
 *  embed/portal, svg/math (mXSS surface, no use here), and every form element
 *  (a model-authored form is a phishing surface inside the panel). */
const HTML_ALLOWED_TAGS = [
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption',
  'center', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl',
  'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]

/** Presentation and table geometry; `style` is the feature (styled cards).
 *  Anything event-ish or behavior-ish (onclick, srcset, formaction…) simply has
 *  no entry here. target/rel are added by the hook below, not this list. */
const HTML_ALLOWED_ATTR = [
  'style', 'class', 'id', 'href', 'src', 'alt', 'title', 'width', 'height',
  'align', 'colspan', 'rowspan', 'start', 'dir', 'lang', 'span',
]

type Purifier = ReturnType<typeof DOMPurify>
let purifier: Purifier | null = null

function sanitizeHtml(dirty: string): string {
  // Fail closed: no DOM → nothing renders. Every real runtime (content script,
  // options page, probe harness, jsdom-backed tests) has one; node alone does not.
  const w = typeof window === 'undefined' ? null : window
  if (!w) return ''
  if (!purifier) {
    purifier = DOMPurify(w)
    purifier.addHook('afterSanitizeAttributes', (node) => {
      // A model-authored link must never navigate the host page in place.
      if (node.nodeName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noreferrer noopener')
      }
      // A sanitized element must not escape the panel's layout: the host is
      // position:fixed at the top of the z-order, and a fixed descendant's
      // containing block is the VIEWPORT — no overflow clip in between can cut
      // it, so surviving `position:fixed` would let model HTML paint an
      // interactive full-viewport overlay (fake login box, fake system dialog)
      // above the page. Sticky rides along for the same escape potential.
      // Neither renders as intended inside a 380px column anyway; every other
      // declaration (the styled-card feature) passes untouched.
      const style = node.getAttribute?.('style')
      if (style && /position\s*:\s*(fixed|sticky)/i.test(style)) {
        const stripped = style.replace(/position\s*:\s*(fixed|sticky)\s*;?/gi, '').trim()
        if (stripped) node.setAttribute('style', stripped)
        else node.removeAttribute('style')
      }
    })
  }
  return purifier.sanitize(dirty, {
    ALLOWED_TAGS: HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: HTML_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  })
}

/** An inline HTML fragment: a tag, a closing tag, or a comment. Attribute
 *  values containing `>` simply fail to match and stay escaped — the failure
 *  direction is "shows literal text", never "executes". */
const INLINE_HTML = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g

/** A PAIRED inline span (`<b>重点</b>`): sanitized as one fragment so the text
 *  between the tags stays inside them — tag-by-tag sanitization would emit
 *  `<b></b>重点` and break the emphasis. Same `[^<>]` attribute rule applies.
 *  Nesting rides along: the outermost pair captures inner tags raw, and the
 *  sanitizer processes the whole fragment. */
const INLINE_HTML_SPAN = /<(b|strong|i|em|u|s|del|strike|mark|sub|sup|span|a|abbr|kbd|q|dfn|small|bdi|bdo|code)(\s[^<>]*)?>([\s\S]*?)<\/\1>/gi

/** Void/self-contained inline tags — no closing tag to pair with. */
const INLINE_HTML_VOID = /<(br|img|hr|wbr)(\s[^<>]*)?\/?>/gi

/** Block-level HTML: a line that opens with one of these starts a raw block
 *  (CommonMark type 6). Inline-only tags (`<b>…` at line start) stay in the
 *  paragraph path, where the inline rule below sanitizes them. */
const HTML_BLOCK_TAGS = new Set([
  'article', 'aside', 'blockquote', 'center', 'details', 'div', 'dl', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'main', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul',
])

/** Void block tags: they never carry a closing tag, so their block is the
 *  opening line alone. Depth-counting them would swallow the rest of the
 *  document — no `</hr>` ever comes. */
const HTML_VOID_BLOCK_TAGS = new Set(['hr'])

const htmlBlockOpen = (line: string): string | null => {
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9-]*)[\s>]/.exec(line)
  if (!m) return null
  const name = m[1].toLowerCase()
  return HTML_BLOCK_TAGS.has(name) ? name : null
}

// ── ```html artifact fences (the desktop's HtmlArtifactCard dispatch) ──

export interface MarkdownSegment {
  kind: 'md' | 'html'
  text: string
  /** html only: the fence never closed — a live stream's tail. */
  partial?: boolean
}

/** Split a message's source into markdown runs and ```html artifact fences.
 *  A ```html fence is a deliverable to preview, not code to read — the system
 *  prompt teaches the model exactly that, and the desktop's CodeBlock routes
 *  the fence to its artifact card — so the panel's MarkdownBlock renders html
 *  segments through its own card and everything else through renderMarkdown.
 *  Line-anchored like renderMarkdown's fence rule; the language is the info
 *  string's first word, case-insensitive (the desktop's isHtmlFenceLang rule).
 *  The segments are SLICES of the original (newline-normalized) source, so the
 *  markdown runs re-render byte-identical; non-html fences are skipped whole —
 *  a ```html sample inside a ```js fence is that fence's content, not a card.
 *  An html fence with an empty body is not a card — back to markdown, where it
 *  renders as the plain code block it visually is. */
export function splitHtmlFences(source: string): MarkdownSegment[] {
  const src = source.replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const starts: number[] = []
  let pos = 0
  for (const l of lines) {
    starts.push(pos)
    pos += l.length + 1
  }
  const segments: MarkdownSegment[] = []
  let mdStart = 0
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```(\w*)(.*)$/.exec(lines[i])
    if (!fence) continue
    const body: string[] = []
    let closed = false
    let j = i + 1
    while (j < lines.length) {
      if (/^\s*```\s*$/.test(lines[j])) {
        closed = true
        break
      }
      body.push(lines[j])
      j++
    }
    const code = body.join('\n')
    if (fence[1].toLowerCase() === 'html' && code.trim() !== '') {
      const fenceStart = starts[i]
      if (fenceStart > mdStart) segments.push({ kind: 'md', text: src.slice(mdStart, fenceStart) })
      const bodyStart = starts[i + 1] ?? pos
      // The body ends at the newline before the closing fence line; an
      // unclosed fence runs to EOF and is the live stream's tail.
      const bodyEnd = closed ? starts[j] - 1 : pos
      segments.push({ kind: 'html', text: src.slice(bodyStart, bodyEnd), partial: !closed })
      mdStart = closed ? starts[j] + lines[j].length + 1 : pos
      i = j
    } else if (closed) {
      // A non-html fence stays markdown — skip past it so its body is never
      // mistaken for a fence of its own.
      i = j
    }
  }
  if (mdStart < src.length) segments.push({ kind: 'md', text: src.slice(mdStart) })
  return segments.length > 0 ? segments : [{ kind: 'md', text: '' }]
}

/** Sentinel-delimited stash for inline code, so later inline rules can't touch
 *  it. Private-use characters, not control chars: the HTML parser drops NUL
 *  from text content per spec, so the old `\u0000`/`\u0001` sentinels were
 *  eaten whenever a paired inline span's whole content went through the
 *  sanitizer — any code span inside `<b>`/`<span>`/`<code>` came back as a
 *  bare digit + a stray `\u0001`. PUA characters pass through sanitization
 *  (and escapeHtml) untouched. */
const STASH_OPEN = '\uE000'
const STASH_CLOSE = '\uE001'

function renderInline(text: string): string {
  const stash: string[] = []
  const keep = (html: string): string => `${STASH_OPEN}${stash.push(html) - 1}${STASH_CLOSE}`

  // Code spans first — they run on the RAW text (each line is raw here; the
  // escaping below only touches what stays outside the stash), so their
  // content stays literal no matter what the later rules see.
  let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`))
  // Inline HTML fragments next: paired spans first (content stays inside the
  // tags), then void tags, then any leftover stray tag/comment — each whole
  // fragment sanitized, then stashed like code spans so the markdown rules
  // below can't reach into them.
  out = out.replace(INLINE_HTML_SPAN, (m) => keep(sanitizeHtml(m)))
  out = out.replace(INLINE_HTML_VOID, (m) => keep(sanitizeHtml(m)))
  out = out.replace(INLINE_HTML, (m) => keep(sanitizeHtml(m)))
  // Escaping happens for everything that remains; the sentinels survive it.
  out = escapeHtml(out)
  // Links — only when the target passes the scheme check.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const url = safeUrl(href)
    if (!url) return match
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // Restore stashed spans — repeatedly, because a restored fragment can carry
  // sentinels of its own: a code span inside a sanitized paired span rides
  // along inside that fragment, so one pass would stop with inner sentinels
  // still in place. Identical-output passes mean the stash is exhausted.
  const stashRe = new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, 'g')
  for (let pass = 0; pass < 10; pass++) {
    const next = out.replace(stashRe, (_m, i: string) => stash[Number(i)] ?? '')
    if (next === out) break
    out = next
  }
  return out
}

// ── lists ────────────────────────────────────────────────────────────

/** A list being built. Nesting is a stack of these: a deeper-indented bullet
 *  becomes a child list of the parent's last item, which is why items hang off
 *  the node instead of being appended to a flat string. */
interface ListNode {
  ordered: boolean
  start: number
  items: ListItem[]
}

interface ListItem {
  text: string
  children: ListNode[]
}

/** One open list level: the node, and the item it nests inside (null at the top
 *  level, where the rendered list goes straight into the document). */
interface ListFrame {
  indent: number
  node: ListNode
  parentItem: ListItem | null
}

function renderList(node: ListNode): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : ''
  const items = node.items
    .map((item) => `<li>${renderInline(item.text)}${item.children.map(renderList).join('')}</li>`)
    .join('')
  return `<${tag}${start}>${items}</${tag}>`
}

// ── tables ───────────────────────────────────────────────────────────

/** `|---|:--:|` — the row that turns the line above into a table. The grammar
 *  is GFM's: at least one `-`, cells separated by `|`, outer pipes optional. */
function isTableDivider(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+[\s:|-]*$/.test(line)
}

/** `| a | b |` → ['a', 'b']; the outer pipes are optional. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function cellAlign(cell: string): string {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return ''
}

/** Renders one markdown document to HTML (safe to assign via innerHTML). */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let quote: string[] = []
  const stack: ListFrame[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`)
    paragraph = []
  }
  /** Pop the innermost level: it belongs to its parent's last item, or to the
   *  document when it has no parent. */
  const closeListLevel = (): void => {
    const frame = stack.pop()!
    if (frame.parentItem) frame.parentItem.children.push(frame.node)
    else html.push(renderList(frame.node))
  }
  const flushList = (): void => {
    while (stack.length > 0) closeListLevel()
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    html.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`)
    quote = []
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  /** Add one bullet at [indent]; opens/closes list levels as the indent moves. */
  const pushItem = (indent: number, ordered: boolean, text: string, start: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) closeListLevel()
    const top = stack[stack.length - 1]
    if (top && top.indent === indent && top.node.ordered !== ordered) {
      // Same depth, different marker (`- a` then `1. b`): a second list.
      const parentItem = top.parentItem
      closeListLevel()
      stack.push({ indent, node: { ordered, start, items: [{ text, children: [] }] }, parentItem })
      return
    }
    if (top && top.indent === indent) {
      top.node.items.push({ text, children: [] })
      return
    }
    const node: ListNode = { ordered, start, items: [{ text, children: [] }] }
    if (top) {
      // Deeper than the open level → a child list of its last item.
      stack.push({ indent, node, parentItem: top.node.items[top.node.items.length - 1] })
    } else {
      stack.push({ indent, node, parentItem: null })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code block: consume until the closing fence (or EOF).
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      flushAll()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      const lang = fence[1] ? ` class="pm-lang-${escapeHtml(fence[1])}"` : ''
      html.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Raw HTML block (CommonMark type 6): from the opening line to a blank line
    // or the closing tag. Sanitized as a whole; markdown is NOT parsed inside,
    // matching the desktop's HTML-block behaviour.
    const blockTag = htmlBlockOpen(line)
    if (blockTag) {
      flushAll()
      const buf: string[] = [line]
      let j = i + 1
      if (!HTML_VOID_BLOCK_TAGS.has(blockTag)) {
        // Count same-name opens/closes PER LINE so a nested card — every inner
        // line ending in its own `</div>` — stays ONE block until the
        // OUTERMOST close. The old first-close-line rule tested the closing
        // line BEFORE pushing it, so that line was silently dropped (the
        // flagship nested-card shape lost its title row and the outer card
        // became an empty shell) and the card would have split at the inner
        // close anyway. While the tag is still open, blank lines are consumed
        // too — the desktop's parser keeps the element open across them; a
        // balanced opening line (`<div>x</div>`) closes the block on itself.
        const openRe = new RegExp(`<${blockTag}(?=[\\s>/])`, 'gi')
        const closeRe = new RegExp(`</${blockTag}\\s*>`, 'gi')
        const delta = (l: string): number => (l.match(openRe)?.length ?? 0) - (l.match(closeRe)?.length ?? 0)
        let depth = delta(line)
        if (depth > 0) {
          let blankAt = -1
          while (j < lines.length) {
            const l = lines[j]
            if (/^\s*$/.test(l)) {
              if (blankAt < 0) blankAt = j
              buf.push(l)
              j++
              continue
            }
            buf.push(l)
            depth += delta(l)
            j++
            if (depth <= 0) break
          }
          if (depth > 0 && blankAt >= 0) {
            // Unclosed at EOF (a fragment the model never closed): fall back
            // to the CommonMark boundary — the block ends at its first blank
            // line, the speculative tail returns to markdown parsing, and the
            // sanitizer auto-closes what is kept.
            buf.length = blankAt - i
            j = blankAt
          }
        }
      }
      // i lands on the LAST consumed line, so the outer loop's i++ steps onto
      // the first unconsumed one (the closing tag line, the first blank of a
      // truncated fragment, or the line after a self-contained block). The
      // old `i = j` dropped the line AFTER a self-contained block entirely.
      i = j - 1
      html.push(sanitizeHtml(buf.join('\n')))
      continue
    }

    if (/^\s*$/.test(line)) {
      flushAll()
      continue
    }

    // Rule — checked before the list rules, since `---` is not a bullet.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll()
      html.push('<hr>')
      continue
    }

    // Table: header row, divider row, then body rows until a non-row line.
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushAll()
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map(cellAlign)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      i-- // the loop's own i++ steps past the last consumed row
      const align = (n: number): string => (aligns[n] ? ` style="text-align:${aligns[n]}"` : '')
      const head = header.map((c, n) => `<th${align(n)}>${renderInline(c)}</th>`).join('')
      const body = rows
        .map((row) => `<tr>${row.map((c, n) => `<td${align(n)}>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')
      html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      flushQuote()
      if (bullet) pushItem(bullet[1].length, false, bullet[2], 1)
      else pushItem(numbered![1].length, true, numbered![3], Number(numbered![2]))
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line)
  }

  flushAll()
  return html.join('\n')
}
