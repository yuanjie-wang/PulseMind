// ── Fast code-to-HTML builder (2026-10-31 perf batch) ──
//
// react-syntax-highlighter's render pipeline (refractor → hast → per-token
// React elements → inline styles) costs ~4ms/KB of BLOCKING on every mount:
// a 280-line file measured one ~300-500ms frame per preview switch, made of
// thousands of createElement calls plus the GC churn of dropping the previous
// tree (probe-tree-click-jank.mjs; unmount itself is free). This module
// replaces that pipeline with the same refractor tokenizer feeding a plain
// HTML string: one `dangerouslySetInnerHTML` set — the browser's HTML parser
// (C++) builds the spans, React never sees a per-token element, and repeat
// mounts of a cached (code, lang, theme) are a Map hit.
//
// Visual contract (captured from the production SyntaxHighlighter DOM,
// scripts/.capture-code-ref.mjs reference): the caller renders the
// pre/code shell via `codeShellStyles`; every token span carries the merged
// inline style of its refractor class names (same `theme[className]` lookup
// the library performs); with lineNumbers each line is a block row with the
// hanging gutter (inline number span, minWidth `<digits>.25em` + 1em pad) —
// the exact geometry the wrapLongLines block-row shape produces.

import { refractor } from 'refractor/core'
import bash from 'refractor/bash'
import cLang from 'refractor/c'
import cpp from 'refractor/cpp'
import css from 'refractor/css'
import go from 'refractor/go'
import java from 'refractor/java'
import javascript from 'refractor/javascript'
import json from 'refractor/json'
import jsx from 'refractor/jsx'
import markdown from 'refractor/markdown'
import markup from 'refractor/markup'
import php from 'refractor/php'
import python from 'refractor/python'
import ruby from 'refractor/ruby'
import rust from 'refractor/rust'
import sql from 'refractor/sql'
import toml from 'refractor/toml'
import tsx from 'refractor/tsx'
import typescript from 'refractor/typescript'
import yaml from 'refractor/yaml'

type StyleObj = Record<string, string | number | undefined>
type ThemeObj = Record<string, StyleObj | undefined>
export type { StyleObj, ThemeObj }

/** The same registration set CodeHighlight's LANG_LOOKUP resolves into. */
const LANGUAGES: Record<string, unknown> = {
  bash, c: cLang, cpp, css, go, java, javascript, json, jsx, markdown,
  markup, php, python, ruby, rust, sql, toml, tsx, typescript, yaml
}
for (const [_name, lang] of Object.entries(LANGUAGES)) {
  try {
    ;(refractor as unknown as { register: (l: unknown) => void }).register(lang)
  } catch {
    // A duplicate registration (module double-load) must not take the
    // highlighter down — the language is already there.
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** camelCase CSS property → kebab, vendor-prefixed forms included
 *  (MozTabSize → -moz-tab-size, msHyphens → -ms-hyphens). */
function kebabProp(prop: string): string {
  const dashed = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
  return dashed.startsWith('ms-') ? `-${dashed}` : dashed
}

function styleToString(style: StyleObj): string {
  let out = ''
  for (const [prop, value] of Object.entries(style)) {
    if (value === undefined || value === null || value === '') continue
    out += `${kebabProp(prop)}:${String(value)};`
  }
  return out
}

/** A theme prepared for lookup: base styles for the pre shell and a class →
 *  inline-style-string map for tokens (compound selectors like
 *  `attr-value > .token.punctuation` never match a class list, skip them). */
interface PreparedTheme {
  preBase: StyleObj
  /** className → css text, merged across a token's class list at build time. */
  classStyle: Map<string, string>
}

const preparedThemes = new WeakMap<ThemeObj, PreparedTheme>()

function prepareTheme(theme: ThemeObj): PreparedTheme {
  const hit = preparedThemes.get(theme)
  if (hit) return hit
  const prepared: PreparedTheme = {
    preBase: theme['pre[class*="language-"]'] ?? {},
    classStyle: new Map(),
  }
  for (const [key, style] of Object.entries(theme)) {
    if (key.includes(' ') || key.includes('>') || key.includes('[')) continue
    if (style) prepared.classStyle.set(key, styleToString(style))
  }
  preparedThemes.set(theme, prepared)
  return prepared
}

interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

export interface HighlightOptions {
  lineNumbers?: boolean
  revealLine?: number | null
}

/** Build the highlighted HTML for `code`. Throws nothing: an unregistered
 *  language or a grammar crash falls back to escaped plain text with the same
 *  line-row structure. */
export function highlightToHtml(code: string, lang: string | null, theme: ThemeObj, opts: HighlightOptions = {}): string {
  return cached(code, lang, theme, opts, () => buildHtml(code, lang, theme, opts))
}

function buildHtml(code: string, lang: string | null, theme: ThemeObj, opts: HighlightOptions): string {
  const prepared = prepareTheme(theme)
  const lineNumbers = opts.lineNumbers ?? false
  const revealLine = opts.revealLine ?? null

  // The line rows exist when the preview numbers them (its block rows are the
  // reveal coordinate system). Numberless chat code stays a token flow — the
  // pre-wrap code shell breaks the lines, no per-line spans needed.
  const rows: boolean = lineNumbers || revealLine != null

  // Tokenize once; a refractor failure degrades to plain text, never a throw.
  let tree: HastNode | null = null
  if (lang) {
    try {
      tree = (refractor as unknown as { highlight: (c: string, l: string) => HastNode }).highlight(code, lang) as HastNode
    } catch {
      tree = null
    }
  }

  // Per-line token HTML. The open-tag stack re-opens every span a token had
  // open across the newline (block comments, template strings) — visually
  // identical to the library's row-split tree.
  const lines: string[] = []
  let cur: string[] = []
  const openTags: string[] = []

  const breakLine = (): void => {
    for (let i = 0; i < openTags.length; i++) cur.push('</span>')
    lines.push(cur.join(''))
    cur = openTags.slice()
  }

  const walk = (node: HastNode): void => {
    if (node.type === 'text') {
      const segments = (node.value ?? '').split('\n')
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) breakLine()
        if (segments[i]) cur.push(escapeHtml(segments[i]))
      }
      return
    }
    const classes = node.properties?.className ?? []
    let style = ''
    for (const cls of classes) {
      const s = prepared.classStyle.get(cls)
      if (s) style += s
    }
    const tag = style ? `<span style="${style}">` : '<span>'
    if (style) {
      openTags.push(tag)
      cur.push(tag)
    }
    for (const child of node.children ?? []) walk(child)
    if (style) {
      cur.push('</span>')
      openTags.pop()
    }
  }

  if (tree) {
    for (const child of tree.children ?? []) walk(child)
  } else {
    // Plain-text fallback (unregistered language or grammar crash).
    const segments = code.split('\n')
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) breakLine()
      if (segments[i]) cur.push(escapeHtml(segments[i]))
    }
  }
  breakLine()

  // A trailing newline's empty last row is not a row: the library numbers
  // `code.replace(/\n$/, '')` and neither should we render one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const largest = lines.length
  const gutter = lineNumbers ? `${String(largest).length + 1.25}em` : null

  const parts: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1
    const revealed = n === revealLine
    if (!rows) {
      parts.push(lines[i])
      continue
    }
    // The reveal flash rides the row's own style (the React path merged it
    // through lineProps); `String(n)` because hast-style attribute writers
    // and querySelector both key on the string form.
    const revealStyle = revealed ? 'background:var(--pm-warn-bg);border-radius:4px;transition:background 0.4s;' : ''
    const rowStyle = lineNumbers
      ? `display:block;padding-left:${gutter};text-indent:-${gutter};${revealStyle}`
      : revealStyle
      ? `display:block;${revealStyle}`
      : ''
    const numberSpan = lineNumbers
      ? `<span class="pm-code-linenumber" style="display:inline-block;min-width:${String(largest).length + 1.25}em;padding-right:1em;text-align:right;user-select:none;${prepared.classStyle.get('comment') ?? ''}">${n}</span>`
      : ''
    const dataAttr = revealLine != null ? ` data-reveal-line="${String(n)}"` : ''
    parts.push(`<span${dataAttr} style="${rowStyle}">${numberSpan}${lines[i]}</span>`)
  }
  // No separator between rows: the code shell is pre-wrap, so a newline text
  // node between two block rows renders its own line box — one blank line
  // between every pair of lines (2026-10-31 user: 两行之间的间距很大). The
  // block spans break the lines already.
  return parts.join('')
}

// ── Cache ──
// Repeat mounts of the same (code, lang, theme, reveal) — flipping between
// open tabs — must be a Map hit, not a rebuild. Bounded: 12 entries of up to
// the highlight cap (200K chars) ≈ 5MB worst case; the working set it exists
// for (the open tabs the user flips between) is a handful.
const CACHE_LIMIT = 12
const cache = new Map<string, string>()
let themeIdCounter = 0
const themeIds = new WeakMap<ThemeObj, number>()

function themeId(theme: ThemeObj): number {
  let id = themeIds.get(theme)
  if (id === undefined) {
    id = ++themeIdCounter
    themeIds.set(theme, id)
  }
  return id
}

function cached(code: string, lang: string | null, theme: ThemeObj, opts: HighlightOptions, build: () => string): string {
  const key = `${themeId(theme)}\u0000${lang ?? ''}\u0000${opts.lineNumbers ? 1 : 0}\u0000${opts.revealLine ?? ''}\u0000${code}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit) // re-insert as most-recently-used
    return hit
  }
  const html = build()
  cache.set(key, html)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return html
}

/** Test hook: drop every cached render (vitest reset, same shape as the
 *  verify-loop's resetVerifyCommandsCache). */
export function resetFastCodeCache(): void {
  cache.clear()
}

/** The pre/code shell inline styles — the captured production shape: the pre
 *  carries the theme's base (its ink and metrics) with the app's card look on
 *  top; the code carries only the caller's font contract plus pre-wrap (the
 *  wrapLongLines shape). */
export function codeShellStyles(
  theme: ThemeObj,
  fontSize: number,
  fontStack: string,
): { pre: StyleObj; code: StyleObj } {
  const prepared = prepareTheme(theme)
  return {
    pre: { ...prepared.preBase, margin: 0, padding: 12, background: 'var(--pm-code-bg)', fontSize },
    code: { whiteSpace: 'pre-wrap', fontFamily: fontStack, fontSize, lineHeight: 1.6 },
  }
}
