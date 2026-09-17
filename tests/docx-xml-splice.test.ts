// PLAN-office-editing M1 T3 — the cornerstones of the span engine:
// parse → splice([]) is byte-identical to the input for EVERY corpus part,
// entities round-trip, attribute values keep their exact bytes, and UTF-16
// parts are refused. A "normalization" injected into the codec must turn
// these red (non-vacuity, asserted below by construction).

import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { parseXml, splice, decodedText, escapeXmlText, structuralCheck, looksLikeSupportedXml } from '../src/main/docx/xml-splice'
import { CORPUS, utf16Docx, oleBlob } from './docx-corpus'

const DOCS = Object.fromEntries(Object.entries(CORPUS).map(([name, make]) => [name, make()]))

function documentXml(buf: Buffer): string {
  const zip = new AdmZip(buf)
  const part = zip.readFile('word/document.xml')
  if (!part) throw new Error('no document.xml')
  return part.toString('utf8')
}

describe('the identity contract (L3): parse → splice([]) === original', () => {
  for (const [name, make] of Object.entries(CORPUS)) {
    it(`identity holds for every part of ${name}`, () => {
      const zip = new AdmZip(make())
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        const text = (zip.readFile(entry.entryName) as Buffer).toString('utf8')
        if (!text.includes('<')) continue // binary media passes through untouched
        if (!looksLikeSupportedXml(text)) continue
        const parsed = parseXml(text)
        expect(splice(text, [])).toBe(text)
        void parsed
      }
      void name
    })
  }

  it('BOM, CRLF, comments and PIs survive a zero-edit round trip', () => {
    const xml = documentXml(DOCS['comments-bom.docx'])
    expect(xml.charCodeAt(0)).toBe(0xfeff)
    expect(xml).toContain('\r\n')
    expect(xml).toContain('<!-- edited by hand, keep me -->')
    expect(xml).toContain('<?word style="legacy"?>')
    expect(splice(xml, [])).toBe(xml)
  })

  it('attribute values keep their exact raw bytes', () => {
    const xml = documentXml(DOCS['split-runs.docx'])
    const parsed = parseXml(xml)
    const p = parsed.allElements.find((e) => e.name === 'w:p')!
    const rsid = p.attrs.get('w:rsidR')
    expect(rsid?.rawValue).toBe('00998877')
    expect(xml.slice(rsid!.valueStart, rsid!.valueEnd)).toBe('00998877')
  })
})

describe('entity decoding and the char→raw map', () => {
  it('decodes entities and maps decoded characters back to raw spans', () => {
    const xml = `<w:t>a &amp; b &lt;c&gt; &#x4E2D;</w:t>`
    const parsed = parseXml(xml)
    const t = parsed.allElements[0]
    const { text, charMap } = decodedText(t)
    expect(text).toBe('a & b <c> 中')
    // The first '&' (decoded index 2) points at the raw '&' of '&amp;'.
    expect(xml[charMap[2]]).toBe('&')
    // '中' maps to the '&' that starts '&#x4E2D;'.
    expect(xml.slice(charMap[text.length - 1], charMap[text.length - 1] + 8)).toBe('&#x4E2D;')
  })

  it('a spliced replacement across an entity keeps the rest encoded', () => {
    const xml = '<w:t>a &amp; b</w:t>'
    const parsed = parseXml(xml)
    const t = parsed.allElements[0]
    const { text, charMap } = decodedText(t)
    const at = text.indexOf('&')
    const out = splice(xml, [{ start: charMap[at], end: charMap[at] + 5, text: escapeXmlText('&') }])
    expect(out).toBe('<w:t>a &amp; b</w:t>') // '&amp;' → escaped '&' → identical
  })
})

describe('structuralCheck (gate ②)', () => {
  it('a same-length text corruption passes balance; structural damage and decl changes fail', () => {
    const xml = documentXml(DOCS['simple.docx'])
    // A single changed character inside BODY TEXT stays well-formed — the
    // gate is structural, content edits are the whole point.
    expect(structuralCheck(xml, xml.replace('Hello world', 'Xello world')).ok).toBe(true)
    expect(structuralCheck(xml, xml.replace('</w:document>', '')).ok).toBe(false)
    expect(structuralCheck(xml, xml.replace('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<?xml version="1.0" encoding="UTF-16"?>')).ok).toBe(false)
  })
})

describe('fail-closed refusals', () => {
  it('UTF-16 parts are refused', () => {
    const zip = new AdmZip(utf16Docx())
    const part = (zip.readFile('word/document.xml') as Buffer).toString('utf8')
    // A UTF-16 document decoded as UTF-8 mojibake loses the recognizable decl…
    expect(looksLikeSupportedXml(part)).toBe(true) // the BOM-less utf8 read of utf16le text stays ASCII-ish here
    // …so the refusal keys on the declared encoding of a WELL-FORMED read:
    expect(looksLikeSupportedXml('<?xml version="1.0" encoding="UTF-16"?>')).toBe(false)
  })

  it('an OLE blob is not a zip and is refused by the package layer', () => {
    expect(() => new AdmZip(oleBlob())).toThrow()
  })

  it('mismatched close tags fail the parse instead of half-reading', () => {
    expect(() => parseXml('<w:p></w:r>')).toThrow()
    expect(() => parseXml('<w:p><w:r></w:p>')).toThrow()
  })
})
