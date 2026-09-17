// ── Element span resolution (PLAN-html-element-edit D4/D6, §2.2) ──
// Given the ORIGINAL file text and a pmPath, resolve where that element lives
// in the source: its start-tag span, end-tag span, inner span and per-attribute
// spans, via parse5's sourceCodeLocationInfo. Every patch is string surgery on
// these spans against the disk text (D3: never the iframe's serialization), so
// this module is where correctness lives — the picker's live DOM and parse5
// follow the same HTML parsing algorithm (fostering included), and anything
// that has no source representation (script-created elements, parser-forged
// wrappers) carries no location and is refused downstream (D6).

import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

type P5Element = DefaultTreeAdapterTypes.Element
type P5Node = DefaultTreeAdapterTypes.ChildNode
interface P5ParentNode {
  childNodes?: P5Node[]
}

import { parsePmPath, type PmPathSegment } from './pm-path'

export interface Span {
  start: number
  end: number
}

export interface AttributeSpan {
  /** Full `name="value"` span inside the start tag. */
  span: Span
  value: string
}

export interface ElementLocation {
  tagName: string
  /** `<tag …>` including the angle brackets. */
  startTag: Span
  /** `</tag>` — null for void elements (img, br, input…) and self-closing
   *  foreign elements. */
  endTag: Span | null
  /** Between the tags; null when there is no end tag. */
  inner: Span | null
  /** Attribute spans keyed by lowercased attribute name. */
  attrs: Record<string, AttributeSpan>
  /** Current attribute values keyed by lowercased name. */
  attributes: Record<string, string>
  /** True when the element carries script/style/template children — in-place
   *  editing must refuse those (D7). */
  hasScriptLikeChildren: boolean
  /** tag + id/class chain from <html> down to and including this element. */
  ancestors: { tag: string; id: string | null; classes: string[] }[]
}

export type ResolveResult =
  | { ok: true; location: ElementLocation }
  | { ok: false; reason: string }

const SCRIPT_LIKE = ['script', 'style', 'template']

function isElementNode(node: P5Node): node is P5Element {
  return typeof (node as { tagName?: unknown }).tagName === 'string'
}

function elementChildren(node: P5ParentNode): P5Element[] {
  return (node.childNodes ?? []).filter(isElementNode)
}

function attrsOf(el: P5Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const attr of el.attrs) attrs[attr.name.toLowerCase()] = attr.value
  return attrs
}

/** parse5 puts attribute spans at the element level AND on the start tag at
 *  runtime; its types only name the element level. Read both. */
function attrSpansOf(sl: NonNullable<P5Element['sourceCodeLocation']>): Record<string, { startOffset: number; endOffset: number }> {
  const elementLevel = (sl as { attrs?: Record<string, { startOffset: number; endOffset: number }> }).attrs
  const startTagLevel = (sl.startTag as { attrs?: Record<string, { startOffset: number; endOffset: number }> } | undefined)?.attrs
  return elementLevel ?? startTagLevel ?? {}
}

function buildLocation(el: P5Element, chain: P5Element[]): ElementLocation {
  const sl = el.sourceCodeLocation!
  const startTagLocation = sl.startTag!
  const startTag: Span = { start: startTagLocation.startOffset, end: startTagLocation.endOffset }
  const endTag: Span | null = sl.endTag ? { start: sl.endTag.startOffset, end: sl.endTag.endOffset } : null
  const attrs: Record<string, AttributeSpan> = {}
  for (const [name, loc] of Object.entries(attrSpansOf(sl))) {
    attrs[name.toLowerCase()] = {
      span: { start: loc.startOffset, end: loc.endOffset },
      value: el.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value ?? '',
    }
  }
  return {
    tagName: el.tagName,
    startTag,
    endTag,
    inner: endTag ? { start: startTag.end, end: endTag.start } : null,
    attrs,
    attributes: attrsOf(el),
    hasScriptLikeChildren: elementChildren(el).some((child) => SCRIPT_LIKE.includes(child.tagName)),
    ancestors: chain.map((node) => ({
      tag: node.tagName,
      id: node.attrs.find((a) => a.name === 'id')?.value ?? null,
      classes: (node.attrs.find((a) => a.name === 'class')?.value ?? '').split(/\s+/).filter(Boolean),
    })),
  }
}

/** Walk the parse5 tree by pmPath segments; returns the element chain (root
 *  first, target last) or null when the path does not resolve (D6). */
function walkByPath(root: P5ParentNode, segments: PmPathSegment[]): P5Element[] | null {
  const [first, ...rest] = segments
  const html = elementChildren(root).find((el) => el.tagName === first.tag)
  if (!html) return null
  const chain: P5Element[] = [html]
  let node: P5Element = html
  for (const seg of rest) {
    const next = elementChildren(node)[seg.index - 1]
    if (!next || next.tagName !== seg.tag) return null
    chain.push(next)
    node = next
  }
  return chain
}

const NO_SOURCE_REASON = '该元素没有对应的源码位置（可能由页面脚本生成），无法安全写盘'

/** Parse the full document and resolve `pmPath` against it. */
export function resolveElement(html: string, pmPath: string): ResolveResult {
  const segments = parsePmPath(pmPath)
  if (!segments) return { ok: false, reason: 'pmPath 无法解析' }
  let tree
  try {
    tree = parse(html, { sourceCodeLocationInfo: true })
  } catch (err) {
    return { ok: false, reason: `HTML 解析失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  const chain = walkByPath(tree as unknown as P5ParentNode, segments)
  if (!chain) return { ok: false, reason: '源码中找不到该路径对应的元素' }
  const el = chain[chain.length - 1]
  if (!el.sourceCodeLocation?.startTag) return { ok: false, reason: NO_SOURCE_REASON }
  return { ok: true, location: buildLocation(el, chain) }
}

/** Fragment variant: resolve a pmPath inside a fragment (used by AI-output
 *  validation, where there is no full document). */
export function resolveInFragment(fragmentHtml: string, pmPath: string): ResolveResult {
  const segments = parsePmPath(pmPath)
  if (!segments) return { ok: false, reason: 'pmPath 无法解析' }
  const frag = parseFragment(fragmentHtml, { sourceCodeLocationInfo: true })
  const chain = walkByPath(frag as unknown as P5ParentNode, segments)
  if (!chain) return { ok: false, reason: '路径在片段中无法解析' }
  const el = chain[chain.length - 1]
  if (!el.sourceCodeLocation?.startTag) return { ok: false, reason: '该元素没有对应的源码位置' }
  return { ok: true, location: buildLocation(el, chain) }
}

/** The element's current outer markup as it sits in `html` (D3: read from
 *  the source spans, never re-serialized). */
export function elementOuterHtml(html: string, location: ElementLocation): string {
  const end = location.endTag ? location.endTag.end : location.startTag.end
  return html.slice(location.startTag.start, end)
}

export type { PmPathSegment }
