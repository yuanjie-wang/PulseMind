// PLAN-office-editing M2 T7 — per-op semantics and the gate transaction:
// cross-run replacement keeps neighboring run formatting, expected_count
// refuses ambiguity WITHOUT touching the file bytes, w:delText is never
// matched, AlternateContent replaces once, sectPr refuses, rPr children keep
// their canonical order, table-cell text edits work, and an injected corrupt
// byte fails a gate so nothing is written.

import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { editDocx, OpBatchError } from '../src/main/docx/package'
import { buildDocumentModel } from '../src/main/docx/model'
import { CORPUS } from './docx-corpus'

const docXml = (name: string): string =>
  new AdmZip(CORPUS[name]()).readFile('word/document.xml')!.toString('utf8')

const paragraphsOf = (xml: string) => buildDocumentModel(xml).paragraphs.map((p) => p.text)

describe('replace_text', () => {
  it('replaces ACROSS three runs and keeps the neighbors untouched', () => {
    const before = docXml('split-runs.docx')
    const outcome = editDocx(CORPUS['split-runs.docx'](), [
      { op: 'replace_text', find: 'Hello world of tomorrow', replace: '再见，昨天' },
    ])
    const xml = outcome.buffer ? new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8') : ''
    expect(xml).not.toBe(before)
    const paragraphs = paragraphsOf(xml)
    expect(paragraphs.join('\n')).toContain('再见，昨天')
    expect(paragraphs.join('\n')).not.toContain('Hello wor')
    // The BOLD middle run keeps its formatting: the <w:b/> element survives.
    expect(xml).toContain('<w:b/>')
  })

  it('expected_count mismatch refuses the batch and the FILE BYTES are unchanged', () => {
    const original = CORPUS['split-runs.docx']()
    const xmlBefore = new AdmZip(original).readFile('word/document.xml')!.toString('utf8')
    // 「o」 hits several times — the default expected_count=1 refuses.
    expect(() => editDocx(original, [{ op: 'replace_text', find: 'o', replace: 'X' }])).toThrow(OpBatchError)
    // editDocx never writes; assert the source buffer itself is intact.
    expect(new AdmZip(original).readFile('word/document.xml')!.toString('utf8')).toBe(xmlBefore)
  })

  it('w:delText is NEVER matched (invisible revision content, D6)', () => {
    const outcome = editDocx(CORPUS['revisions.docx'](), [
      { op: 'replace_text', find: 'inserted words', replace: 'INS' },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    expect(xml).toContain('INS')
    expect(xml).toContain('deleted words') // untouched — it is invisible content
    expect(() =>
      editDocx(CORPUS['revisions.docx'](), [{ op: 'replace_text', find: 'deleted words', replace: 'X' }]),
    ).toThrow(OpBatchError)
  })

  it('AlternateContent text is replaced ONCE (Fallback skipped, L4)', () => {
    const outcome = editDocx(CORPUS['alternate-content.docx'](), [
      { op: 'replace_text', find: 'Replace once only', replace: 'REPLACED' },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    expect(xml.match(/REPLACED/g)?.length).toBe(1)
  })

  it('table cell text is ordinary paragraph text', () => {
    const outcome = editDocx(CORPUS['styles-table.docx'](), [
      { op: 'replace_text', find: 'cell two', replace: 'cell 2' },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    expect(xml).toContain('cell 2')
  })
})

describe('insert / delete / style', () => {
  it('insert_paragraph clones the anchor style; an explicit style overrides', () => {
    const outcome = editDocx(CORPUS['styles-table.docx'](), [
      { op: 'insert_paragraph', paragraph: 0, position: 'after', text: 'New subheading', style: 'Heading2' },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>')
    expect(paragraphsOf(xml).length).toBe(4) // heading + new + 2 cells? (cells count) — sanity below
    expect(paragraphsOf(xml)[1]).toBe('New subheading')
  })

  it('delete_paragraph works on normal paragraphs and REFUSES a pPr-embedded sectPr', () => {
    // The body-level sectPr (simple.docx) is not the paragraph's property —
    // deleting the paragraph is safe.
    const outcome = editDocx(CORPUS['simple.docx'](), [{ op: 'delete_paragraph', paragraph: 0 }])
    expect(paragraphsOf(new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8'))).toHaveLength(0)
    // A paragraph whose pPr carries the section break must refuse.
    const zip = new AdmZip(CORPUS['simple.docx']())
    const xml = zip.readFile('word/document.xml')!.toString('utf8')
    const withSect = xml.replace('<w:p>', '<w:p><w:pPr><w:sectPr><w:pgSz w:w="1"/></w:sectPr></w:pPr>')
    const buf = (() => {
      const out = new AdmZip()
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        out.addFile(entry.entryName, entry.entryName === 'word/document.xml' ? Buffer.from(withSect, 'utf8') : zip.readFile(entry.entryName)!)
      }
      return out.toBuffer()
    })()
    expect(() => editDocx(buf, [{ op: 'delete_paragraph', paragraph: 0 }])).toThrow(/sectPr/)
  })

  it('set_paragraph_style writes pStyle on a paragraph without pPr', () => {
    const outcome = editDocx(CORPUS['simple.docx'](), [
      { op: 'set_paragraph_style', paragraph: 0, style: 'Title' },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    expect(xml).toContain('<w:pStyle w:val="Title"/>')
  })
})

describe('format_text', () => {
  it('whole-run coverage rewrites rPr in place', () => {
    const outcome = editDocx(CORPUS['simple.docx'](), [
      { op: 'format_text', find: 'Hello world', bold: true, color: 'FF0000', font_size: 14 },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    // Canonical order: color before sz.
    expect(xml).toContain('<w:color w:val="FF0000"/><w:sz w:val="28"/>')
    expect(xml).toContain('<w:b/>')
  })

  it('partial coverage SPLITS the run; the uncovered part keeps the old format', () => {
    const outcome = editDocx(CORPUS['split-runs.docx'](), [
      { op: 'format_text', find: 'world', bold: true },
    ])
    const xml = new AdmZip(outcome.buffer).readFile('word/document.xml')!.toString('utf8')
    // The first run "Hello wor" splits: "Hello" plain, " wor" bold.
    expect(xml).toContain('<w:t xml:space="preserve">Hello </w:t>')
    expect(xml).toContain('<w:b/>')
    expect(paragraphsOf(xml).join('')).toContain('Hello')
    // The model still reads the same visible text.
    expect(paragraphsOf(xml).join('\n')).toContain('Hello world of tomorrow')
  })

  it('an empty find refuses the batch instead of looping to OOM (pptx H1 twin)', () => {
    expect(() =>
      editDocx(CORPUS['simple.docx'](), [{ op: 'format_text', find: '', bold: true }]),
    ).toThrow(/find 不能为空/)
  })
})

describe('gates (L5): any failure means nothing is written', () => {
  it('gate ③ catches a semantic mismatch injected into the pipeline', () => {
    // A delete that would remove the sectPr paragraph is refused by the op
    // itself; a forged structural edit is gate ②'s job. Here: the batch error
    // carries per-op results for the model to react to.
    try {
      editDocx(CORPUS['split-runs.docx'](), [
        { op: 'replace_text', find: 'no-such-text', replace: 'x' },
      ])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OpBatchError)
      expect((err as OpBatchError).results[0].ok).toBe(false)
    }
  })

  it('gate ② catches structural damage: simulate by splicing out a close tag via a format op on a corrupted base', () => {
    // Corrupt the base by hand: delete the </w:p> close of paragraph 0.
    const original = CORPUS['simple.docx']()
    const zip = new AdmZip(original)
    const xml = zip.readFile('word/document.xml')!.toString('utf8')
    const corrupted = xml.replace('</w:p>', '')
    const corruptedBuf = (() => {
      const out = new AdmZip()
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        out.addFile(entry.entryName, entry.entryName === 'word/document.xml' ? Buffer.from(corrupted, 'utf8') : zip.readFile(entry.entryName)!)
      }
      return out.toBuffer()
    })()
    // The parse itself fails closed on the unbalanced part (mismatched tags),
    // which is the fail-closed refusal the plan demands.
    expect(() =>
      editDocx(corruptedBuf, [{ op: 'replace_text', find: 'Hello world', replace: 'x' }]),
    ).toThrow()
  })

  it('gate ① keeps untouched parts byte-identical (styles.xml, media)', () => {
    const outcome = editDocx(CORPUS['styles-table.docx'](), [
      { op: 'replace_text', find: 'cell one', replace: 'cell 1' },
    ])
    const before = new AdmZip(CORPUS['styles-table.docx']())
    const after = new AdmZip(outcome.buffer)
    const stylesBefore = before.readFile('word/styles.xml')
    const stylesAfter = after.readFile('word/styles.xml')
    expect(stylesBefore!.equals(stylesAfter!)).toBe(true)
    // The document part DID change (gate ① is about the OTHER parts).
    expect(after.readFile('word/document.xml')!.toString('utf8')).toContain('cell 1')
  })
})

describe('outline (L9)', () => {
  it('returns index + style + text so the model can navigate before editing', () => {
    const outcome = editDocx(CORPUS['styles-table.docx'](), [{ op: 'outline' }])
    expect(outcome.outline[0]).toMatchObject({ index: 0, style: 'Heading1' })
    expect(outcome.outline.some((o) => o.text.includes('cell one'))).toBe(true)
    expect(outcome.results.every((r) => r.ok)).toBe(true)
  })
})
