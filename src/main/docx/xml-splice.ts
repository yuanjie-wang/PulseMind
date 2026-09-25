// ── L0 span-splice XML codec (PLAN-office-editing §3.1, T2) ──
// The foundation of byte-faithful docx editing: a single-pass tokenizer that
// LOCATES markup without REWRITING it. Editing is always "replace this exact
// range of the original string with that exact text", so an untouched part
// survives verbatim and a parsed-then-spliced document is byte-identical to
// its input:
//
//     splice(parse(xml), []) === xml        // the identity contract (L3)
//
// This is the direct counter to the rejected external design, whose full
// ET.tostring re-serialization renamed namespace prefixes and left
// mc:Ignorable pointing at a prefix that no longer existed — corrupting the
// file while its own quality gates reported healthy. Offsets here are UTF-16
// code-unit indices of the decoded string; all surgery happens on the string,
// and only edited parts are ever re-encoded to bytes.

export interface XmlAttribute {
  name: string
  /** Raw value between the quotes (entities intact). */
  rawValue: string
  valueStart: number
  valueEnd: number
  quote: string
}

export interface XmlTextNode {
  kind: 'text'
  start: number
  end: number
  raw: string
  /** Decoded text, one entry per character, mapping to its raw index within
   *  [start, end). Entities decode to one entry covering their full span. */
  charMap: number[]
  decoded: string
}

export interface XmlElementNode {
  kind: 'element'
  name: string
  start: number
  end: number
  /** `<w:p …>` span */
  startTagStart: number
  startTagEnd: number
  /** `</w:p>` span — null for self-closing elements. */
  endTag: { start: number; end: number } | null
  attrs: Map<string, XmlAttribute>
  children: XmlNode[]
  parent: XmlElementNode | null
}

export type XmlNode = XmlElementNode | XmlTextNode

const SELF_CLOSING = new Set(['w:br', 'w:tab'])

export interface ParsedXml {
  root: XmlElementNode
  /** Every element in document order. */
  allElements: XmlElementNode[]
}

/** Is this the XML declaration or something with an encoding we cannot edit
 *  byte-faithfully as a JS string? UTF-16 parts fail here (fail-closed). */
export function looksLikeSupportedXml(text: string): boolean {
  if (text.charCodeAt(0) === 0xfffe || text.charCodeAt(0) === 0xfffe) return false
  const decl = /^<\?xml\s+[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(text)
  if (decl) {
    const enc = decl[1].toUpperCase()
    return enc === 'UTF-8' || enc === 'ASCII'
  }
  return true
}

/** Single-pass parse. Throws (fail-closed) on structurally impossible input —
 *  a half-understood document is never edited. */
export function parseXml(xml: string): ParsedXml {
  const allElements: XmlElementNode[] = []
  const root: XmlElementNode = { kind: 'element', name: '#document', start: 0, end: xml.length, startTagStart: 0, startTagEnd: 0, endTag: null, attrs: new Map(), children: [], parent: null }
  const stack: XmlElementNode[] = [root]
  let i = 0
  const n = xml.length

  const appendChild = (node: XmlNode): void => {
    const top = stack[stack.length - 1]
    top.children.push(node)
  }

  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      appendChild(makeText(xml, i, n))
      break
    }
    if (lt > i) appendChild(makeText(xml, i, lt))
    i = lt
    if (xml.startsWith('<!--', i)) {
      const close = xml.indexOf('-->', i + 4)
      if (close < 0) throw new Error('unterminated comment')
      i = close + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const close = xml.indexOf(']]>', i + 9)
      if (close < 0) throw new Error('unterminated CDATA')
      appendChild({ kind: 'text', start: i, end: close + 3, raw: xml.slice(i, close + 3), charMap: [], decoded: xml.slice(i + 9, close) })
      i = close + 3
      continue
    }
    if (xml.startsWith('<?', i)) {
      const close = xml.indexOf('?>', i + 2)
      if (close < 0) throw new Error('unterminated processing instruction')
      i = close + 2
      continue
    }
    if (xml.startsWith('<!', i)) {
      const close = xml.indexOf('>', i + 2)
      if (close < 0) throw new Error('unterminated declaration')
      i = close + 1
      continue
    }
    // ── a close tag: pop the stack ──
    if (xml.startsWith('</', i)) {
      const closeMatch = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(xml.slice(i))
      if (!closeMatch) throw new Error(`unparsable close tag at ${i}`)
      const open = stack.pop()
      if (!open || open === root || open.name !== closeMatch[1]) {
        throw new Error(`mismatched close tag </${closeMatch[1]}> at ${i}`)
      }
      open.endTag = { start: i, end: i + closeMatch[0].length }
      open.end = i + closeMatch[0].length
      i += closeMatch[0].length
      continue
    }
    // ── an element tag ──
    const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i))
    if (!nameMatch) throw new Error(`unparsable markup at ${i}`)
    const name = nameMatch[1]
    let j = i + nameMatch[0].length
    const attrs = new Map<string, XmlAttribute>()
    let selfClosing = false
    for (;;) {
      while (j < n && /\s/.test(xml[j])) j++
      if (j >= n) throw new Error('unterminated tag')
      if (xml[j] === '/') { selfClosing = true; j++; continue }
      if (xml[j] === '>') { j++; break }
      const attrMatch = /^([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(xml.slice(j))
      if (!attrMatch) throw new Error(`unparsable attribute at ${j}`)
      attrs.set(attrMatch[1], {
        name: attrMatch[1],
        rawValue: attrMatch[3],
        valueStart: j + attrMatch[0].length - attrMatch[3].length - 1,
        valueEnd: j + attrMatch[0].length - 1,
        quote: attrMatch[2],
      })
      j += attrMatch[0].length
    }
    const element: XmlElementNode = {
      kind: 'element', name, start: i, end: j,
      startTagStart: i, startTagEnd: j, endTag: null,
      attrs, children: [], parent: stack[stack.length - 1] === root ? null : stack[stack.length - 1],
    }
    appendChild(element)
    allElements.push(element)
    if (selfClosing) {
      element.end = j
    } else {
      stack.push(element)
    }
    i = j
    void SELF_CLOSING
  }
  if (stack.length !== 1) throw new Error('unclosed element(s) at end of input')
  return { root, allElements }
}

function makeText(xml: string, start: number, end: number): XmlTextNode {
  const raw = xml.slice(start, end)
  const charMap: number[] = []
  const decodedChars: string[] = []
  let k = 0
  while (k < raw.length) {
    if (raw[k] === '&') {
      const semi = raw.indexOf(';', k)
      if (semi > k && semi - k <= 10) {
        const entity = raw.slice(k + 1, semi)
        let decodedEntity: string | null = null
        if (entity === 'amp') decodedEntity = '&'
        else if (entity === 'lt') decodedEntity = '<'
        else if (entity === 'gt') decodedEntity = '>'
        else if (entity === 'quot') decodedEntity = '"'
        else if (entity === 'apos') decodedEntity = "'"
        else if (entity.startsWith('#x') || entity.startsWith('#X')) decodedEntity = String.fromCodePoint(parseInt(entity.slice(2), 16))
        else if (entity.startsWith('#')) decodedEntity = String.fromCodePoint(parseInt(entity.slice(1), 10))
        if (decodedEntity !== null) {
          for (const ch of decodedEntity) {
            decodedChars.push(ch)
            charMap.push(start + k)
          }
          k = semi + 1
          continue
        }
      }
    }
    decodedChars.push(raw[k])
    charMap.push(start + k)
    k += 1
  }
  return { kind: 'text', start, end, raw, charMap, decoded: decodedChars.join('') }
}

/** Concatenated decoded text of an element's DIRECT text children (entities
 *  decoded); char i maps to raw offset `charMap[i]` in the document. */
export function decodedText(el: XmlElementNode): { text: string; charMap: number[] } {
  const parts: string[] = []
  const charMap: number[] = []
  const walk = (node: XmlNode): void => {
    if (node.kind === 'text') {
      for (let i = 0; i < node.decoded.length; i++) {
        parts.push(node.decoded[i])
        charMap.push(node.charMap[i])
      }
      return
    }
    for (const child of node.children) walk(child)
  }
  walk(el)
  return { text: parts.join(''), charMap }
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface SpliceReplacement {
  start: number
  end: number
  text: string
}

/** Apply ordered, non-overlapping replacements to the original string.
 *  With an empty list the output IS the input — the identity contract. */
export function splice(xml: string, replacements: SpliceReplacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error('overlapping replacements')
  }
  let out = ''
  let cursor = 0
  for (const rep of sorted) {
    out += xml.slice(cursor, rep.start) + rep.text
    cursor = rep.end
  }
  out += xml.slice(cursor)
  return out
}

/** Gate ② (L5): an edited part must re-tokenize with balanced tags and its
 *  declaration intact. Not full W3C validation — the Spans philosophy is to
 *  catch structural damage, which is what splicing can actually cause. */
export function structuralCheck(original: string, edited: string): { ok: boolean; reason?: string } {
  if (looksLikeSupportedXml(original) && !looksLikeSupportedXml(edited)) {
    return { ok: false, reason: 'the XML declaration changed' }
  }
  const declOf = (t: string) => (/^\uFEFF?\s*(<\?xml[^>]*\?>)/.exec(t)?.[1] ?? '')
  if (declOf(original) !== declOf(edited)) return { ok: false, reason: 'the XML declaration changed' }
  let open = 0
  let i = 0
  while (i < edited.length) {
    if (edited.startsWith('<!--', i)) { const c = edited.indexOf('-->', i + 4); if (c < 0) return { ok: false, reason: 'unterminated comment' }; i = c + 3; continue }
    if (edited.startsWith('<![CDATA[', i)) { const c = edited.indexOf(']]>', i + 9); if (c < 0) return { ok: false, reason: 'unterminated CDATA' }; i = c + 3; continue }
    if (edited.startsWith('<?', i)) { const c = edited.indexOf('?>', i + 2); if (c < 0) return { ok: false, reason: 'unterminated PI' }; i = c + 2; continue }
    if (edited[i] === '<') {
      const close = edited.indexOf('>', i)
      if (close < 0) return { ok: false, reason: 'unterminated tag' }
      if (edited.startsWith('</', i)) {
        open -= 1
        if (open < 0) return { ok: false, reason: 'unbalanced close tag' }
      } else if (edited[close - 1] !== '/') {
        // self-closing tags (<w:pgSz …/>) never open a scope
        open += 1
      }
      i = close + 1
      continue
    }
    i++
  }
  if (open !== 0) return { ok: false, reason: `${open} unclosed tag(s)` }
  return { ok: true }
}
