// ── Synthetic .docx corpus (PLAN-office-editing L14, T1) ──
// The repo has no binary-fixture precedent and none is wanted in git: every
// corpus file is DETERMINISTICALLY GENERATED from string templates with
// adm-zip. The shapes are Word-shaped (real rsid attributes, run splits,
// AlternateContent, revisions) — the exact shapes the span engine must
// survive. WPS-specific shapes stay behind the probe's --corpus hook.

import AdmZip from 'adm-zip'

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const RELS_WITH_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const W_OPEN = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">'
const W_CLOSE = '</w:document>'

export function pXml(inner: string, opts: { rsid?: string; pPr?: string } = {}): string {
  const rsid = opts.rsid ? ` w:rsidR="${opts.rsid}" w:rsidRDefault="${opts.rsid}"` : ''
  const pPr = opts.pPr ? `<w:pPr>${opts.pPr}</w:pPr>` : ''
  return `<w:p${rsid}>${pPr}${inner}</w:p>`
}

export function rXml(text: string, rPr?: string): string {
  const p = rPr ? `<w:rPr>${rPr}</w:rPr>` : ''
  return `<w:r>${p}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function doc(body: string): string {
  return `${DECL}${W_OPEN}<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>${W_CLOSE}`
}

type Part = string | Buffer
function zip(parts: Record<string, Part>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(parts)) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }
  return zip.toBuffer()
}

export const CORPUS: Record<string, () => Buffer> = {
  /** ① single run, single paragraph — the trivial case. */
  'simple.docx': () => zip({
    '[Content_Types].xml': CT,
    '_rels/.rels': RELS,
    'word/document.xml': doc(pXml(rXml('Hello world'))),
  }),

  /** ② one sentence split across THREE runs (Word does this at every spell/
   *  rsid boundary) — cross-run replacement is the whole game. */
  'split-runs.docx': () => zip({
    '[Content_Types].xml': CT,
    '_rels/.rels': RELS,
    'word/document.xml': doc(
      pXml('<w:r><w:t xml:space="preserve">Hello wor</w:t></w:r>' +
           '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">ld of </w:t></w:r>' +
           `<w:r w:rsidR="00A1B2C3"><w:t xml:space="preserve">tomorrow</w:t></w:r>`, { rsid: '00998877' })),
  }),

  /** ③ XML comment + PI + standalone decl + BOM + CRLF — byte fidelity beyond
   *  the element tree. */
  'comments-bom.docx': () => {
    const body = `${DECL}<!-- edited by hand, keep me --><?word style="legacy"?>${W_OPEN}<w:body>${pXml(rXml('Keep the comment'))}</w:body>${W_CLOSE}`
    return zip({
      '[Content_Types].xml': CT,
      '_rels/.rels': RELS,
      'word/document.xml': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    })
  },

  /** ④ mc:AlternateContent with the SAME text in Choice and Fallback — the
   *  entity must be replaced ONCE, not twice. */
  'alternate-content.docx': () => {
    const text = '<w:r><w:t xml:space="preserve">Replace once only</w:t></w:r>'
    const body = `${W_OPEN.slice(0, -1)} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
      `<w:body>${pXml(`<mc:AlternateContent><mc:Choice Requires="w14">${text}</mc:Choice><mc:Fallback>${text}</mc:Fallback></mc:AlternateContent>`)}</w:body></w:document>`
    return zip({
      '[Content_Types].xml': CT,
      '_rels/.rels': RELS,
      'word/document.xml': `${DECL}${body}`,
    })
  },

  /** ⑤ revisions: w:ins carries a normal w:t (matchable), w:del carries
   *  w:delText (NEVER matchable — invisible content must not be edited). */
  'revisions.docx': () => zip({
    '[Content_Types].xml': CT,
    '_rels/.rels': RELS,
    'word/document.xml': doc(
      pXml(`<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">${rXml('inserted words')}</w:ins>` +
           `<w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>deleted words</w:delText></w:r></w:del>`),
    ),
  }),

  /** ⑥ styles + numbering + a table with cell text (replace/format must work
   *  inside table paragraphs for free). */
  'styles-table.docx': () => zip({
    '[Content_Types].xml': CT.replace('/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'),
    '_rels/.rels': RELS_WITH_STYLES,
    'word/document.xml': doc(
      pXml(rXml('Styled heading'), { pPr: '<w:pStyle w:val="Heading1"/>' }) +
      `<w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">cell one</w:t></w:r></w:p></w:tc>` +
      `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    ),
    'word/styles.xml': `${DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  }),

  /** ⑦ rels + a media placeholder — untouched parts must come through
   *  byte-identical even when a sibling part is edited. */
  'with-media.docx': () => zip({
    '[Content_Types].xml': CT,
    '_rels/.rels': RELS,
    'word/document.xml': doc(pXml(rXml('Document with media'))),
    'word/media/image1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  }),
}

/** ⑧ a UTF-16-encoded part — the engine must REFUSE it (fail-closed), not
 *  half-read it. Generated on demand. */
export function utf16Docx(): Buffer {
  const zipFile = new AdmZip()
  zipFile.addFile('[Content_Types].xml', Buffer.from(CT, 'utf8'))
  zipFile.addFile('_rels/.rels', Buffer.from(RELS, 'utf8'))
  zipFile.addFile('word/document.xml', Buffer.from(`${DECL}${W_OPEN}<w:body>${pXml(rXml('Utf16 part'))}</w:body>${W_CLOSE}`, 'utf16le'))
  return zipFile.toBuffer()
}

/** A non-zip blob with the OLE magic — the "encrypted/legacy .doc" refusal case. */
export function oleBlob(): Buffer {
  return Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)])
}
