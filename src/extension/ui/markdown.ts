/** Minimal dependency-free Markdown → HTML for the panel transcript.
 *
 * Security model: the source is escaped FIRST, and every step after that only
 * introduces tags this module generates. Assistant output and (later) page
 * content are untrusted, so raw HTML must never pass through; link targets are
 * scheme-checked so `javascript:` cannot be smuggled in through a link.
 *
 * Scope tracks what the desktop transcript renders with `@ant-design/x-markdown`:
 * code fences, headings at their real level (the light theme's rules only
 * address `h1`–`h4`, so a clamped level would fall outside the styling), nested
 * lists, quotes, tables, rules, code spans, bold/italic, links. Anything richer
 * (math, mermaid, syntax highlighting) belongs in the desktop UI. */

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

/** Sentinel-delimited stash for inline code, so later inline rules can't touch it. */
const STASH_OPEN = '\u0000'
const STASH_CLOSE = '\u0001'

function renderInline(text: string): string {
  // Escaping happens first; everything below wraps already-escaped text.
  let out = escapeHtml(text)
  const stash: string[] = []
  const keep = (html: string): string => `${STASH_OPEN}${stash.push(html) - 1}${STASH_CLOSE}`

  // Code spans first: their content is literal.
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${code}</code>`))
  // Links — only when the target passes the scheme check.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    const url = safeUrl(href)
    if (!url) return match
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`
  })
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // Restore stashed spans last.
  out = out.replace(new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, 'g'), (_m, i: string) => stash[Number(i)] ?? '')
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
