// ── XML plumbing for the PPTX preview model (PLAN-pptx-preview) ── The only
//  file that knows fast-xml-parser. OOXML element/attribute names are matched
//  by LOCAL name (the segment after the colon) — the namespaces are fixed by
//  the spec, the prefixes are not (WPS and python-pptx pick their own), so
//  binding to `a:`/`p:` literals would break on real-world files.
//
//  fast-xml-parser's `preserveOrder` output (array of { tag: [...], ':@': attrs
//  }) is converted once, here, into the plain XNode tree below — everything
//  downstream works on that shape and stays insulated from library quirks.

import { XMLParser } from 'fast-xml-parser'

/** A minimal element node: local tag name, attribute map (local names),
 *  element children, and the node's own text (all #text/#cdata children
 *  concatenated — OOXML keeps text data in leaf nodes like a:t). */
export interface XNode {
  tag: string
  attrs: Record<string, string>
  kids: XNode[]
  text: string
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  trimValues: false,
  cdataPropName: '__cdata',
  processEntities: true,
})

type RawNode = Record<string, unknown>

const localName = (tag: string): string => {
  const i = tag.indexOf(':')
  return i === -1 ? tag : tag.slice(i + 1)
}

function convert(raw: RawNode[]): XNode[] {
  const out: XNode[] = []
  for (const entry of raw) {
    for (const key of Object.keys(entry)) {
      if (key === ':@') continue
      // `?xml` / `?doctype` directive entries: not elements, and in
      // preserveOrder output they precede the root — skipping them keeps
      // tree[0] the actual root element.
      if (key.startsWith('?')) continue
      const value = entry[key]
      const attrs = (entry[':@'] as Record<string, string> | undefined) ?? {}
      if (key === '#text' || key === '__cdata') {
        // A bare text entry becomes a synthetic node; the caller's tree
        // builder folds it into the parent's `text` below.
        out.push({ tag: '#text', attrs: {}, kids: [], text: String(value ?? '') })
        continue
      }
      const kids = Array.isArray(value) ? convert(value) : []
      // fast-xml-parser wraps text children as sibling entries; fold them in.
      const folded: XNode[] = []
      let text = ''
      for (const kid of kids) {
        if (kid.tag === '#text') text += kid.text
        else folded.push(kid)
      }
      out.push({ tag: localName(key), attrs, kids: folded, text })
    }
  }
  return out
}

/** Parse an OOXML part. Returns [] on any failure — callers treat "no tree"
 *  the same as "part missing", which is the honest outcome for a corrupt or
 *  foreign part (the deck itself fails elsewhere, at its required parts). */
export function parseXml(xml: string | undefined): XNode[] {
  if (!xml) return []
  try {
    return convert(parser.parse(xml) as RawNode[])
  } catch {
    return []
  }
}

/** First element child with the given local tag, else undefined. */
export function kid(node: XNode | undefined, tag: string): XNode | undefined {
  return node?.kids.find((k) => k.tag === tag)
}

/** All element children with the given local tag, in document order. */
export function kids(node: XNode | undefined, tag: string): XNode[] {
  return node?.kids.filter((k) => k.tag === tag) ?? []
}

/** All element children (document order) — the spTree walk needs every kind. */
export function elementsOf(node: XNode | undefined): XNode[] {
  return node?.kids ?? []
}

/** Descendant search by local tag (first hit, document order). */
export function findDescendant(node: XNode | undefined, tag: string): XNode | undefined {
  if (!node) return undefined
  for (const k of node.kids) {
    if (k.tag === tag) return k
    const hit = findDescendant(k, tag)
    if (hit) return hit
  }
  return undefined
}

/** All descendant elements with the tag, document order. */
export function findDescendants(node: XNode | undefined, tag: string, out: XNode[] = []): XNode[] {
  if (!node) return out
  for (const k of node.kids) {
    if (k.tag === tag) out.push(k)
    findDescendants(k, tag, out)
  }
  return out
}

/** Parsed attribute number ('' / absent / NaN → fallback). OOXML numeric
 *  attributes are plain integers (EMU, hundredths of a point, 60000ths of a
 *  degree, 1000ths of a percent). */
export function numAttr(node: XNode | undefined, name: string, fallback: number): number {
  const raw = node?.attrs[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Sum of an element's own text (used where a container mixes text and
 *  markup, which OOXML proper never does — kept for safety on a:t). */
export function textOf(node: XNode | undefined): string {
  return node?.text ?? ''
}
