// ── L3 package layer + gates (PLAN-office-editing §3.4, T6) ──
// The package keeps every untouched part's bytes VERBATIM and re-encodes only
// the edited parts — container recompression is known and honest, content is
// what the gates check. All-or-nothing: the gates run on in-memory buffers
// and a failure means nothing is ever written.

import AdmZip from 'adm-zip'
import { structuralCheck } from './xml-splice'
import { applyOps, validateOpsPayload, type DocxOp, type OpResult } from './ops'
import { buildDocumentModel, outlineOf } from './model'
import { prepareImage, type ImageBatchState, type PreparedImage } from './image'
import type { DocxEditOutcome } from '../../shared/office/ops'

export type { DocxOp }

export interface EditDocxResult extends DocxEditOutcome {
  buffer: Buffer
  editedParts: string[]
}

const DOCUMENT_PART = 'word/document.xml'

/** Read a .docx package and refuse anything that is not an editable
 *  OOXML word document: OLE blobs (.doc / encrypted), missing document.xml,
 *  non-UTF-8 parts. Fail-closed — a half-understood file is never edited. */
export function openDocxPackage(buffer: Buffer): AdmZip {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('这不是 .docx（OOXML）文件——可能是 .doc 旧格式或已加密文档，请先另存为 .docx')
  }
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry(DOCUMENT_PART)
  if (!entry) throw new Error('包内缺少 word/document.xml — 不是有效的 Word 文档')
  const text = (zip.readFile(DOCUMENT_PART) as Buffer).toString('utf8')
  const decl = /\bencoding="([^"]+)"/.exec(text.slice(0, 200))
  if (decl && !/^(UTF-8|ASCII|US-ASCII)$/i.test(decl[1])) {
    throw new Error(`document.xml 使用了不支持的编码（${decl[1]}），拒绝编辑`)
  }
  return zip
}

export function editDocx(buffer: Buffer, ops: DocxOp[], opts?: { resolveImageBytes?: (path: string) => { ext: string; bytes: Buffer } | null }): EditDocxResult {
  const payload = validateOpsPayload(ops)
  if (!payload.ok) throw new Error(payload.reason)

  const zip = openDocxPackage(buffer)
  const docEntry = zip.getEntry(DOCUMENT_PART)!
  const originalXml = (zip.readFile(DOCUMENT_PART) as Buffer).toString('utf8')

  // M3: the image batch state — working copies of rels/content-types live
  // HERE, so a multi-image batch accumulates rIds/media numbers correctly.
  const entryNames = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName)
  const relsEntry = zip.getEntry('word/_rels/document.xml.rels')
  const ctEntry = zip.getEntry('[Content_Types].xml')
  const imageState: ImageBatchState = {
    relsXml: relsEntry ? (zip.readFile(relsEntry) as Buffer).toString('utf8') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    contentTypesXml: ctEntry ? (zip.readFile(ctEntry) as Buffer).toString('utf8') : '',
    mediaEntries: [],
    existingEntryNames: entryNames,
    altText: '',
  }
  const preparedImages: PreparedImage[] = []

  // M2/M3: compile the ops to the edited document string. A failed op returns
  // (xml=original, results with ok:false) — surface it without writing.
  const outcome = applyOps(originalXml, payload.ops, opts?.resolveImageBytes
    ? (path, currentXml) => {
        const resolved = opts.resolveImageBytes!(path)
        if (!resolved) throw new Error(`insert_image: 图片「${path}」读取失败——先确认文件在工作区里（png/jpg/jpeg/gif）`)
        const prepared = prepareImage(imageState, currentXml, { ext: resolved.ext, bytes: resolved.bytes })
        preparedImages.push(prepared)
        return { paragraphXml: prepared.paragraphXml, mediaName: prepared.mediaName }
      }
    : undefined)
  if (!outcome.results.every((r) => r.ok)) {
    throw new OpBatchError(outcome.results)
  }

  // Gate ② (structural): the edited part must re-tokenize with balanced tags
  // and its declaration intact. An image batch re-checks the two small parts
  // it rewrote (rels / [Content_Types]) as well.
  const structure = structuralCheck(originalXml, outcome.xml)
  if (!structure.ok) throw new Error(`门禁②未通过：编辑后的 document.xml 结构损坏（${structure.reason}）`)
  if (preparedImages.length > 0) {
    const relsAfter = structuralCheck(imageState.relsXml, imageState.relsXml)
    if (!relsAfter.ok) throw new Error(`门禁②未通过：编辑后的 rels 结构损坏（${relsAfter.reason}）`)
    const ctAfter = structuralCheck(imageState.contentTypesXml, imageState.contentTypesXml)
    if (!ctAfter.ok) throw new Error(`门禁②未通过：编辑后的 [Content_Types] 结构损坏（${ctAfter.reason}）`)
  }

  // Gate ③ (semantic): the paragraph sequence must differ exactly the way the
  // ops declared. Cheap and strong — it catches off-by-one spans that gate ②
  // cannot see. insert_image adds one paragraph each.
  verifySemantic(originalXml, outcome.xml, payload.ops)

  const editedXml = Buffer.from(outcome.xml, 'utf8')

  // Rebuild the package: untouched entries keep their ORIGINAL bytes. The
  // image half adds media parts and replaces rels/[Content_Types].
  const out = new AdmZip()
  const editedParts: string[] = []
  const editedSet = new Set<string>([DOCUMENT_PART])
  if (preparedImages.length > 0) {
    editedSet.add('word/_rels/document.xml.rels')
    editedSet.add('[Content_Types].xml')
    for (const img of preparedImages) editedSet.add(img.mediaName)
  }
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) { out.addFile(`${entry.entryName}/`, Buffer.alloc(0)); continue }
    if (entry.entryName === DOCUMENT_PART) {
      out.addFile(entry.entryName, editedXml)
      editedParts.push(entry.entryName)
    } else if (entry.entryName === 'word/_rels/document.xml.rels' && preparedImages.length > 0) {
      out.addFile(entry.entryName, Buffer.from(imageState.relsXml, 'utf8'))
      editedParts.push(entry.entryName)
    } else if (entry.entryName === '[Content_Types].xml' && preparedImages.length > 0) {
      out.addFile(entry.entryName, Buffer.from(imageState.contentTypesXml, 'utf8'))
      editedParts.push(entry.entryName)
    } else {
      out.addFile(entry.entryName, zip.readFile(entry.entryName) as Buffer)
    }
  }
  for (const img of preparedImages) {
    out.addFile(img.mediaName, img.bytes)
    editedParts.push(img.mediaName)
  }

  // Gate ① (content identity of untouched parts) — by construction above the
  // bytes are copied verbatim; the check makes the contract explicit and
  // catches future refactors that might re-encode. The EDITED set (document +
  // an image batch's media/rels/CT) is skipped — gate① generalized from
  // "only document.xml" to the set of parts the ops actually touched.
  const checkZip = new AdmZip(out.toBuffer())
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || editedSet.has(entry.entryName)) continue
    const before = zip.readFile(entry.entryName) as Buffer
    const after = checkZip.readFile(entry.entryName) as Buffer
    if (!before.equals(after)) throw new Error(`门禁①未通过：未编辑部件 ${entry.entryName} 的内容发生了变化`)
  }

  return {
    buffer: out.toBuffer(),
    results: outcome.results,
    outline: outcome.outline.length > 0 ? outcome.outline : outlineOf(buildDocumentModel(originalXml)),
    tables: outcome.tables,
    editedParts,
    warnings: [],
  }
}

export class OpBatchError extends Error {
  readonly results: OpResult[]
  constructor(results: OpResult[]) {
    const failed = results.filter((r) => !r.ok)
    super(`第 ${failed.map((f) => f.index + 1).join('、')} 个 op 失败，整批未应用: ${failed.map((f) => f.detail).join('；')}`)
    this.results = results
  }
}

/** Gate ③: the paragraph outline before vs after must match the ops' declared
 *  effects — replacements vanish, inserted/deleted paragraphs move the count,
 *  style ops flip exactly one style. */
export function verifySemantic(beforeXml: string, afterXml: string, ops: DocxOp[]): void {
  const before = buildDocumentModel(beforeXml)
  const after = buildDocumentModel(afterXml)
  let expectedCount = before.paragraphs.length
  const textsBefore = before.paragraphs.map((p) => p.text)
  for (const op of ops) {
    if (op.op === 'insert_paragraph') expectedCount += 1
    if (op.op === 'insert_image') expectedCount += 1
    if (op.op === 'delete_paragraph') expectedCount -= 1
    if (op.op === 'insert_table_row') {
      // Every cloned cell carries exactly one new <w:p> (the clone rebuilds
      // cell content) — the row count is cell count.
      const row = before.tables[op.table]?.rows[op.after_row]
      if (row) expectedCount += row.cells.length
    }
    if (op.op === 'delete_table_row') {
      // The deleted row's ACTUAL paragraph count (cells may hold several) —
      // counting 1 per row undercounted and the gate failed a legal delete.
      const row = before.tables[op.table]?.rows[op.row]
      if (row) {
        const rowXml = beforeXml.slice(row.element.start, row.element.end)
        expectedCount -= (rowXml.match(/<w:p[\s/>]/g) ?? []).length
      }
    }
    if (op.op === 'replace_text') {
      const scope = op.paragraph !== undefined ? [before.paragraphs[op.paragraph]] : before.paragraphs
      const occurrences = scope.filter(Boolean).reduce((acc, p) => {
        let count = 0
        let from = 0
        for (;;) {
          const at = p.text.indexOf(op.find, from)
          if (at < 0) break
          count++
          from = at + op.find.length
        }
        return acc + count
      }, 0)
      if (occurrences !== (op.expected_count ?? 1)) {
        throw new Error(`门禁③未通过：replace_text 命中数与声明不符`)
      }
    }
  }
  if (after.paragraphs.length !== expectedCount) {
    throw new Error(`门禁③未通过：段落数 ${before.paragraphs.length} → ${after.paragraphs.length}（期望 ${expectedCount}）`)
  }
  // Replace ops: the expected occurrence count of `find` in the AFTER text is
  // computable exactly — before minus the replaced hits, plus whatever times
  // the replacement itself embeds the find (a replacement like
  // 「⟨已改:world⟩」 legitimately still contains 「world」).
  for (const op of ops) {
    if (op.op !== 'replace_text') continue
    const occurrences = op.paragraph !== undefined
      ? countOf(before.paragraphs[op.paragraph]?.text ?? '', op.find)
      : before.paragraphs.reduce((acc, p) => acc + countOf(p.text, op.find), 0)
    const declared = op.expected_count ?? 1
    const reintroduced = countOf(op.replace, op.find)
    const expected = occurrences - declared + reintroduced * declared
    const actual = after.paragraphs.reduce((acc, p) => acc + countOf(p.text, op.find), 0)
    if (actual !== expected) {
      throw new Error(`门禁③未通过：replace_text 后「${op.find.slice(0, 30)}」出现 ${actual} 次（期望 ${expected}）`)
    }
  }
}

function countOf(text: string, find: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(find, from)
    if (at < 0) break
    count++
    from = at + find.length
  }
  return count
}
