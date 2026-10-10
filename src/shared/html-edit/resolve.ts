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

import { formatPmPath, parsePmPath, type PmPathSegment } from './pm-path'

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

// ── Smart resolution (live DOM path ≠ disk source) ──
// The picker builds pmPath in the SERVED page's live DOM; the resolver walks
// the DISK text. They agree only while the page's scripts have not touched
// the tree: content a script created (or a sibling it inserted) shifts every
// later index, and the walk then fails for elements that ARE in the source.
// resolveElementSmart falls back to locating the element by tag + inner text
// (unique match required — patching the wrong twin is data corruption), and
// reports the element's TRUE source path so verifyPatch / undo-reselect aim
// at the disk, not at the runtime tree.

export type SmartResolveResult =
  | { ok: true; location: ElementLocation; matchedBy: 'path' | 'content'; sourcePmPath: string }
  | { ok: false; reason: string }

export const GENERATED_ELEMENT_REASON =
  '该元素不在文件源码中——它可能由页面脚本在运行时生成，脚本生成的内容无法安全写盘。请编辑源码中的静态元素，或让 AI 修改生成它的脚本'

function ambiguousReason(count: number): string {
  return `选中内容在源码中匹配到 ${count} 处相同元素，无法确定要修改哪一处——请让 AI 按你的描述修改，或先让元素文本彼此不同`
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Quote-aware tag stripper (full_20261011 M12-P1-1): `/<[^>]*>/` closed at
 *  the FIRST `>`, so an attribute value containing one (`onclick="a>b"`,
 *  `style="content:'>'"`) left tag fragments inside the "text" — static
 *  elements then failed the text comparison and were reported as
 *  「由页面脚本运行时生成」. Inside "…"/'…' a `>` is an ordinary character. */
function stripTagsLoose(html: string): string {
  return html.replace(/<(?:"[^"]*"|'[^']*'|[^>"'])*>/g, '')
}

/** Comparison-only decode (mirror of patch.ts's verification decoder — kept
 *  local because patch.ts imports this module). */
function comparisonText(html: string): string {
  return normalizeText(
    stripTagsLoose(html)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&'),
  )
}

/** The pmPath of `chain` (root first) as the DISK lays the elements out —
 *  same counting rule as the picker's buildPmPath (element siblings, 1-based). */
function pmPathOfChain(chain: P5Element[]): string {
  return formatPmPath(
    chain.map((node, i) => ({
      tag: node.tagName,
      index: i === 0 ? 1 : elementChildren(chain[i - 1]).indexOf(node) + 1,
    })),
  )
}

export interface SmartSelection {
  pmPath: string
  tag: string
  /** The LIVE textContent the picker reported (trimmed, ≤400 chars). */
  text: string
}

/** HTML void elements (no end tag, no inner text — the content match can never
 *  see them). */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** Void-element structural resolver (2026-10-10; direct-hit gate since
 *  full_20261011 M12-P0-4): <img>/<br>/<hr>/<input> & co. have no endTag and
 *  no inner text, so the text-anchored match can never see them. Match by
 *  tag instead, disambiguated by the pmPath's ancestor TAG chain: a script
 *  inserting siblings shifts every INDEX but no tag name, so ancestor-tag
 *  agreement survives exactly the drift that breaks the direct path. Unique
 *  agreement only — patching the wrong twin is data corruption, same
 *  discipline as the text match. Returns null when not applicable (hint
 *  present, or the tag is not void); an ambiguity is an honest ok:false, not
 *  a guess. */
function resolveVoidBySkeleton(html: string, selection: SmartSelection): SmartResolveResult | null {
  if (selection.text.trim() || !VOID_TAGS.has(selection.tag)) return null
  let tree
  try {
    tree = parse(html, { sourceCodeLocationInfo: true })
  } catch (err) {
    return { ok: false, reason: `HTML 解析失败: ${err instanceof Error ? err.message : String(err)}` }
  }
  const segments = parsePmPath(selection.pmPath)
  const ancestorTags = segments && segments.length > 1 ? segments.slice(0, -1).map((s) => s.tag) : null
  const candidates: P5Element[][] = []
  const walk = (node: P5ParentNode, chain: P5Element[]): void => {
    for (const child of elementChildren(node)) {
      const nextChain = [...chain, child]
      if (child.tagName === selection.tag && child.sourceCodeLocation?.startTag) {
        if (!ancestorTags || nextChain.slice(0, -1).map((n) => n.tagName).join('>') === ancestorTags.join('>')) {
          candidates.push(nextChain)
        }
      }
      walk(child, nextChain)
    }
  }
  walk(tree as unknown as P5ParentNode, [])
  if (candidates.length === 1) {
    const chain = candidates[0]
    const el = chain[chain.length - 1]
    return { ok: true, location: buildLocation(el, chain), matchedBy: 'content', sourcePmPath: pmPathOfChain(chain) }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: `源码中有 ${candidates.length} 个 <${selection.tag}> 元素与所选元素的路径骨架一致，无法唯一定位（元素没有可匹配的文本）。请改用 AI 修改或编辑源码中的其他静态元素` }
  }
  return { ok: false, reason: GENERATED_ELEMENT_REASON }
}

/** Resolve the selected element against the disk text: exact pmPath first
 *  (verified against the picker's text hint — H9), then a unique tag+text
 *  match. Never guesses between duplicates. */
export function resolveElementSmart(html: string, selection: SmartSelection): SmartResolveResult {
  const hint = normalizeText(selection.text)
  // The picker caps textContent at 400 chars — a capped hint matches by prefix.
  const capped = selection.text.trim().length >= 400
  const direct = resolveElement(html, selection.pmPath)
  if (direct.ok) {
    if (!hint) {
      // A void element has NO comparable text, so a direct hit cannot be
      // verified against anything — and a script-inserted sibling shifts
      // every pmPath index onto a same-tag twin. The skeleton check (ancestor
      // tag chain, UNIQUE agreement) is therefore not just the fallback for a
      // FAILED direct resolve: it is the only verification a void element can
      // have, so it gates the direct hit too (full_20261011 M12-P0-4 —
      // patching the wrong twin is data corruption, same discipline as the
      // text match). Non-void no-hint elements keep the plain path blessing.
      const bySkeleton = resolveVoidBySkeleton(html, selection)
      if (bySkeleton) return bySkeleton
      return { ok: true, location: direct.location, matchedBy: 'path', sourcePmPath: selection.pmPath }
    }
    // The pmPath indexes were built in the LIVE served DOM; a page script that
    // inserted or removed a sibling shifts every later index, and the walk can
    // land on a same-tag sibling of a template card list — patching the wrong
    // twin. The picker's text hint is the guard: a resolved path whose source
    // text disagrees with what the user actually selected falls through to the
    // content match below instead of being blessed by verifyPatch (which only
    // re-checks the same wrong path).
    const inner = direct.location.inner
    const sourceText = inner ? comparisonText(html.slice(inner.start, inner.end)) : ''
    if (sourceText === hint || (capped && sourceText.startsWith(hint))) {
      return { ok: true, location: direct.location, matchedBy: 'path', sourcePmPath: selection.pmPath }
    }
  } else {
    // A parse failure is hopeless; everything else may still be findable.
    if (direct.reason.startsWith('HTML 解析失败')) return { ok: false, reason: direct.reason }
  }

  if (!hint) {
    // Void-element structural fallback (2026-10-10) — see resolveVoidBySkeleton:
    // without a hint the content match below can never fire for a void tag.
    const bySkeleton = resolveVoidBySkeleton(html, selection)
    if (bySkeleton) return bySkeleton
    return { ok: false, reason: GENERATED_ELEMENT_REASON }
  }
  let tree
  try {
    tree = parse(html, { sourceCodeLocationInfo: true })
  } catch (err) {
    return { ok: false, reason: `HTML 解析失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  const matches: P5Element[][] = []
  const walk = (node: P5ParentNode, chain: P5Element[]): void => {
    for (const child of elementChildren(node)) {
      const nextChain = [...chain, child]
      const sl = child.sourceCodeLocation
      if (child.tagName === selection.tag && sl?.startTag && sl.endTag) {
        const inner = html.slice(sl.startTag.endOffset, sl.endTag.startOffset)
        const sourceText = comparisonText(inner)
        if (sourceText === hint || (capped && sourceText.startsWith(hint))) matches.push(nextChain)
      }
      walk(child, nextChain)
    }
  }
  walk(tree as unknown as P5ParentNode, [])

  if (matches.length === 1) {
    const chain = matches[0]
    const el = chain[chain.length - 1]
    if (!el.sourceCodeLocation?.startTag) return { ok: false, reason: NO_SOURCE_REASON }
    return { ok: true, location: buildLocation(el, chain), matchedBy: 'content', sourcePmPath: pmPathOfChain(chain) }
  }
  if (matches.length > 1) return { ok: false, reason: ambiguousReason(matches.length) }
  return { ok: false, reason: GENERATED_ELEMENT_REASON }
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
