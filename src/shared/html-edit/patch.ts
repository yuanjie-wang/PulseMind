// ── Patch operations (PLAN-html-element-edit D3/D5/D6, §2.2) ──
// All writes are "disk original text + a local span patch" (D3): the iframe's
// serialization is NEVER written back — it loses comments/indentation and
// would freeze JS-generated DOM into the file. These functions take the
// original text plus a resolved ElementLocation and return patched text;
// every patch must then pass verifyPatch (D6: re-parse and confirm — a patch
// that cannot be proven lands nowhere).

import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import type { ElementLocation, Span } from './resolve'
import { resolveElement } from './resolve'
import { parsePmPath } from './pm-path'

// ── Serialization helpers ──

/** Escape text going into an element's inner span (panel text edits). */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value going into a double-quoted attribute. */
function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

// ── Style merging ──

/** Parse a style attribute body into ordered [prop, value] pairs. Splits on
 *  `;` outside quotes/parens (url(...) and quoted strings may contain both). */
export function parseStyleDecls(style: string): [string, string][] {
  const decls: [string, string][] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      pushDecl(decls, style.slice(start, i))
      start = i + 1
    }
  }
  pushDecl(decls, style.slice(start))
  return decls
}

function pushDecl(decls: [string, string][], raw: string): void {
  const idx = raw.indexOf(':')
  if (idx <= 0) return
  const prop = raw.slice(0, idx).trim().toLowerCase()
  const value = raw.slice(idx + 1).trim()
  if (prop && value) decls.push([prop, value])
}

/** Apply decl updates to an existing style body. `null` removes the
 *  property; existing order is preserved, new properties append. */
export function mergeStyleDecls(existing: string | null, decls: Record<string, string | null>): string {
  const pairs = parseStyleDecls(existing ?? '')
  for (const [prop, value] of Object.entries(decls)) {
    const key = prop.trim().toLowerCase()
    const idx = pairs.findIndex(([p]) => p === key)
    if (value === null) {
      if (idx >= 0) pairs.splice(idx, 1)
    } else if (idx >= 0) pairs[idx] = [key, value.trim()]
    else pairs.push([key, value.trim()])
  }
  return pairs.map(([p, v]) => `${p}: ${v}`).join('; ')
}

// ── Start-tag rebuilding ──

/** Rewrite the start tag with attribute mutations applied. Existing attrs
 *  are replaced/removed in place (offsets stay valid because edits apply
 *  bottom-up); new attrs append before the closing bracket. */
function rebuildStartTag(html: string, location: ElementLocation, set: Record<string, string | null>): string {
  const base = location.startTag.start
  let tag = html.slice(location.startTag.start, location.startTag.end)
  const closing = /\/?>$/.exec(tag)
  const bracket = closing ? closing[0] : '>'
  let body = tag.slice(0, tag.length - bracket.length)

  // Replace/remove existing attrs, bottom-up so earlier offsets stay valid.
  const replacements: { start: number; end: number; text: string }[] = []
  for (const [name, value] of Object.entries(set)) {
    const key = name.toLowerCase()
    const attr = location.attrs[key]
    if (attr) {
      const start = attr.span.start - base
      const end = attr.span.end - base
      if (value === null) {
        // Removing an attribute must also consume the ONE separator space
        // before it, or the start tag keeps a double space behind.
        const widened = body[start - 1] === ' ' ? start - 1 : start
        replacements.push({ start: widened, end, text: '' })
      } else {
        replacements.push({ start, end, text: `${name}="${escapeAttrValue(value)}"` })
      }
    }
  }
  replacements.sort((a, b) => b.start - a.start)
  for (const rep of replacements) {
    body = body.slice(0, rep.start) + rep.text + body.slice(rep.end)
  }

  // Append brand-new attrs.
  const known = new Set(Object.keys(location.attrs))
  for (const [name, value] of Object.entries(set)) {
    if (value !== null && !known.has(name.toLowerCase())) {
      body = `${body} ${name}="${escapeAttrValue(value)}"`
    }
  }
  return `${body}${bracket}`
}

/** Set inline-style declarations on the element (style attr rewritten or
 *  created). Returns the patched whole-document text. */
export function setInlineStyle(html: string, location: ElementLocation, decls: Record<string, string | null>): string {
  const existing = location.attributes['style'] ?? null
  const merged = mergeStyleDecls(existing, decls)
  const set = merged ? { style: merged } : { style: null }
  const newTag = rebuildStartTag(html, location, set)
  return html.slice(0, location.startTag.start) + newTag + html.slice(location.startTag.end)
}

/** Set (or remove) attributes other than style. */
export function setAttributes(html: string, location: ElementLocation, attrs: Record<string, string | null>): string {
  const newTag = rebuildStartTag(html, location, attrs)
  return html.slice(0, location.startTag.start) + newTag + html.slice(location.startTag.end)
}

// ── Span replacements ──

/** Replace the element's inner span (panel text commit, in-place editable
 *  commit — D7: the frame's innerHTML for THIS element only). */
export function applyInnerHtml(html: string, location: ElementLocation, newInner: string): string {
  if (!location.inner) return html
  return html.slice(0, location.inner.start) + newInner + html.slice(location.inner.end)
}

/** Replace the whole element (AI edit). Void elements have no end tag —
 *  the span is start tag only. */
export function replaceElement(html: string, location: ElementLocation, newOuter: string): string {
  const end = location.endTag ? location.endTag.end : location.startTag.end
  return html.slice(0, location.startTag.start) + newOuter + html.slice(end)
}

/** Remove the whole element (D-删除: with confirm, undoable — the undo is
 *  the caller's, this is just the span cut). */
export function removeElement(html: string, location: ElementLocation): string {
  return replaceElement(html, location, '')
}

// ── Verification (D6) ──

export interface PatchExpectation {
  /** The pmPath that must still resolve in the patched text. */
  pmPath: string
  /** The tag must be unchanged. */
  tag?: string
  /** The element's text (whitespace-normalized) must contain this. */
  textContains?: string
  /** Style properties that must be present after a style patch. */
  styleProps?: string[]
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Re-parse the patched text and prove the patch landed: the path still
 *  resolves, the tag is unchanged, expected text/style present. Any doubt
 *  refuses the write (D6: 写错字节远重于不写). */
export function verifyPatch(patchedHtml: string, expectation: PatchExpectation): VerifyResult {
  const segments = parsePmPath(expectation.pmPath)
  if (!segments) return { ok: false, reason: 'pmPath 无法解析' }
  const resolved = resolveElement(patchedHtml, expectation.pmPath)
  if (!resolved.ok) return { ok: false, reason: `补丁校验失败：${resolved.reason}` }
  const loc = resolved.location
  if (expectation.tag && loc.tagName !== expectation.tag.toLowerCase()) {
    return { ok: false, reason: `补丁校验失败：标签已变为 ${loc.tagName}（期望 ${expectation.tag}）` }
  }
  if (expectation.textContains !== undefined) {
    const raw = patchedHtml.slice(
      loc.startTag.end,
      loc.endTag ? loc.endTag.start : loc.startTag.end,
    )
    const textOnly = normalize(decodeEntities(stripTags(raw)))
    if (!textOnly.includes(normalize(expectation.textContains))) {
      return { ok: false, reason: '补丁校验失败：文本内容与预期不符' }
    }
  }
  if (expectation.styleProps && expectation.styleProps.length > 0) {
    const style = loc.attributes['style'] ?? ''
    for (const prop of expectation.styleProps) {
      if (!parseStyleDecls(style).some(([p]) => p === prop.toLowerCase())) {
        return { ok: false, reason: `补丁校验失败：style 缺少 ${prop}` }
      }
    }
  }
  return { ok: true }
}

/** Entity decode for the text-contains check — verification only; it never
 *  produces output that gets written. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Crude tag stripper for the text-contains check — verification only; it
 *  never produces output that gets written. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/** Byte-span sanity: a Span must lie inside `html` and be well-ordered. */
export function spanIsValid(html: string, span: Span): boolean {
  return span.start >= 0 && span.end <= html.length && span.start <= span.end
}

// ── AI output validation (D9, §5) ──

/** A replacement element above this size is refused — an "AI edit" that
 *  returns tens of kilobytes is a document rewrite wearing an element's
 *  clothes. */
export const MAX_AI_ELEMENT_BYTES = 32 * 1024

export type AiValidateResult =
  | { ok: true; html: string }
  | { ok: false; reason: string }

/** Prove the model returned exactly one element of the expected tag — not a
 *  fenced document, not two elements, not text. Returns the EXACT markup
 *  bytes to splice (sliced from the model output, never re-serialized). */
export function validateAiElementMarkup(raw: string, expectedTag: string): AiValidateResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'AI 返回了空内容' }
  if (trimmed.length > MAX_AI_ELEMENT_BYTES) {
    return { ok: false, reason: `AI 返回的内容过大（${trimmed.length} 字节，上限 ${MAX_AI_ELEMENT_BYTES}）` }
  }
  if (/<!doctype/i.test(trimmed) || /<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed) || /<\/body/i.test(trimmed)) {
    return { ok: false, reason: 'AI 返回了整篇文档，而这里只接受单个元素' }
  }
  const frag = parseFragment(trimmed)
  const children = (frag.childNodes ?? []).filter(
    (node): node is DefaultTreeAdapterTypes.Element => typeof (node as { tagName?: unknown }).tagName === 'string',
  )
  if (children.length === 0) {
    return { ok: false, reason: 'AI 返回的不是元素标记' }
  }
  if (children.length > 1) {
    return { ok: false, reason: `AI 返回了 ${children.length} 个元素，这里只接受一个` }
  }
  const el = children[0]
  if (el.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
    return { ok: false, reason: `AI 把标签改成了 ${el.tagName}（选中元素是 ${expectedTag}）` }
  }
  const start = el.sourceCodeLocation?.startOffset ?? 0
  const end = el.sourceCodeLocation?.endOffset ?? trimmed.length
  return { ok: true, html: trimmed.slice(start, end) }
}
