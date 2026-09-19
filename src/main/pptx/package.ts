// ── pptx package layer + gates (PLAN-pptx-editing, L3's slide twin) ── The
//  package keeps every untouched part's bytes VERBATIM and re-encodes only
//  the edited slide parts. All-or-nothing: gates run on in-memory buffers and
//  a failure means nothing is ever written.

import AdmZip from 'adm-zip'
import { structuralCheck } from '../docx/xml-splice'
import { validateOpsPayload, applySlideOps, type PptxOp, type OpResult, type PptxSlideOp } from './ops'
import { buildSlideModel, slidePartNames, outlineOf, GAP_CHAR, type SlideOutline } from './model'

export type { PptxOp }

export interface EditPptxResult {
  buffer: Buffer
  results: OpResult[]
  outline: SlideOutline[]
  editedParts: string[]
  warnings: string[]
}

const PRESENTATION_PART = 'ppt/presentation.xml'
const PRESENTATION_RELS = 'ppt/_rels/presentation.xml.rels'

/** Read a .pptx package and refuse anything that is not an editable OOXML
 *  presentation: OLE blobs (.ppt / encrypted), missing presentation.xml,
 *  non-UTF-8 parts. Fail-closed — a half-understood file is never edited. */
export function openPptxPackage(buffer: Buffer): AdmZip {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('这不是 .pptx（OOXML）文件——可能是 .ppt 旧格式或已加密文档，请先在 PowerPoint/WPS 中另存为 .pptx')
  }
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry(PRESENTATION_PART)
  if (!entry) throw new Error('包内缺少 ppt/presentation.xml — 不是有效的 PowerPoint 文档')
  const text = (zip.readFile(PRESENTATION_PART) as Buffer).toString('utf8')
  const decl = /\bencoding="([^"]+)"/.exec(text.slice(0, 200))
  if (decl && !/^(UTF-8|ASCII|US-ASCII)$/i.test(decl[1])) {
    throw new Error(`presentation.xml 使用了不支持的编码（${decl[1]}），拒绝编辑`)
  }
  return zip
}

/** Slide part names in presentation order; missing rels → error naming the
 *  file (D3 refuses to guess slide identity from filenames). */
function orderedSlideParts(zip: AdmZip): string[] {
  const presXml = (zip.readFile(PRESENTATION_PART) as Buffer).toString('utf8')
  const relsEntry = zip.getEntry(PRESENTATION_RELS)
  const relsXml = relsEntry ? (zip.readFile(PRESENTATION_RELS) as Buffer).toString('utf8') : ''
  const names = slidePartNames(presXml, relsXml)
  if (names.length === 0) {
    throw new Error('无法从 presentation.xml 的 sldIdLst 解析出任何幻灯片（rels 缺失或损坏）——拒绝编辑半理解的文件')
  }
  for (const name of names) {
    if (!zip.getEntry(name)) throw new Error(`sldIdLst 指向的 ${name} 不在包内——文件损坏，拒绝编辑`)
  }
  return names
}

export function editPptx(buffer: Buffer, ops: PptxOp[]): EditPptxResult {
  const payload = validateOpsPayload(ops)
  if (!payload.ok) throw new Error(payload.reason)

  const zip = openPptxPackage(buffer)
  const slideNames = orderedSlideParts(zip)

  // outline-only calls never write.
  const mutating = payload.ops.filter((op): op is PptxSlideOp => op.op !== 'outline')
  const outlines: SlideOutline[] = []
  for (let i = 0; i < slideNames.length; i++) {
    outlines.push(outlineOf(buildSlideModel((zip.readFile(slideNames[i]) as Buffer).toString('utf8')), i + 1))
  }
  if (mutating.length === 0) {
    return { buffer, results: [{ index: 0, op: 'outline', ok: true, detail: `${slideNames.length} 页` }], outline: outlines, editedParts: [], warnings: [] }
  }

  // Group the mutating ops by slide (1-based, sldIdLst order — D3).
  const perSlide = new Map<number, PptxSlideOp[]>()
  for (const op of mutating) {
    const slide = op.slide ?? 1
    if (slide < 1 || slide > slideNames.length) {
      throw new OpBatchError([{ index: mutating.indexOf(op), op: op.op, ok: false, detail: `slide ${slide} 不存在（文档共 ${slideNames.length} 页）` }])
    }
    const list = perSlide.get(slide) ?? []
    list.push(op)
    perSlide.set(slide, list)
  }

  // Apply per slide; each op re-parses the slide's current string.
  const editedXml = new Map<string, string>()
  const results: OpResult[] = []
  const sortedSlides = [...perSlide.keys()].sort((a, b) => a - b)
  for (const slide of sortedSlides) {
    const part = slideNames[slide - 1]
    const originalXml = (zip.readFile(part) as Buffer).toString('utf8')
    const slideOps = perSlide.get(slide)!
    // op result indices are GLOBAL (the batch's numbering), so rebuild them
    // from each op's position in the original payload.
    const outcome = applySlideOps(originalXml, slideOps)
    for (let i = 0; i < outcome.results.length; i++) {
      const r = outcome.results[i]
      results.push({ ...r, index: mutating.indexOf(slideOps[i]) })
    }
    if (!outcome.results.every((r) => r.ok)) {
      const failed = outcome.results.filter((r) => !r.ok)
      throw new OpBatchError(results, `第 ${slide} 页: ${failed.map((f) => f.detail).join('；')}`)
    }
    editedXml.set(part, outcome.xml)
  }

  // Gate ② (structural): every edited slide must re-tokenize with balanced
  // tags and its declaration intact.
  for (const [part, xml] of editedXml) {
    const originalXml = (zip.readFile(part) as Buffer).toString('utf8')
    const structure = structuralCheck(originalXml, xml)
    if (!structure.ok) throw new Error(`门禁②未通过：编辑后的 ${part} 结构损坏（${structure.reason}）`)
  }

  // Gate ③ (semantic): replace ops — the find's occurrence count after the
  // edit is computable exactly (docx twin's formula); set_shape_text — the
  // target shape's text IS the new text and other shapes' paragraph counts
  // are unchanged.
  for (const [part, xml] of editedXml) {
    const slide = slideNames.indexOf(part) + 1
    const slideOps = perSlide.get(slide)!
    const after = buildSlideModel(xml)
    const before = buildSlideModel((zip.readFile(part) as Buffer).toString('utf8'))
    verifySemantic(before, after, slideOps)
  }

  // Rebuild the package: untouched entries keep their ORIGINAL bytes.
  const out = new AdmZip()
  const editedParts: string[] = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) { out.addFile(`${entry.entryName}/`, Buffer.alloc(0)); continue }
    const edited = editedXml.get(entry.entryName)
    if (edited !== undefined) {
      out.addFile(entry.entryName, Buffer.from(edited, 'utf8'))
      editedParts.push(entry.entryName)
    } else {
      out.addFile(entry.entryName, zip.readFile(entry.entryName) as Buffer)
    }
  }

  // Gate ① (content identity of untouched parts) — by construction above the
  // bytes are copied verbatim; the check makes the contract explicit.
  const checkZip = new AdmZip(out.toBuffer())
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || editedXml.has(entry.entryName)) continue
    const before = zip.readFile(entry.entryName) as Buffer
    const after = checkZip.readFile(entry.entryName) as Buffer
    if (!before.equals(after)) throw new Error(`门禁①未通过：未编辑部件 ${entry.entryName} 的内容发生了变化`)
  }

  return {
    buffer: out.toBuffer(),
    results,
    outline: outlines,
    editedParts,
    warnings: [],
  }
}

export class OpBatchError extends Error {
  readonly results: OpResult[]
  constructor(results: OpResult[], message?: string) {
    const failed = results.filter((r) => !r.ok)
    super(message ?? `第 ${failed.map((f) => f.index + 1).join('、')} 个 op 失败，整批未应用: ${failed.map((f) => f.detail).join('；')}`)
    this.results = results
  }
}

/** Gate ③ for one slide: the declared effects are exactly what happened. */
export function verifySemantic(before: ReturnType<typeof buildSlideModel>, after: ReturnType<typeof buildSlideModel>, ops: PptxSlideOp[]): void {
  const textsOf = (m: ReturnType<typeof buildSlideModel>): string[] =>
    m.shapes.flatMap((s) => s.paragraphs.map((p) => p.text))
  const beforeTexts = textsOf(before)
  const afterTexts = textsOf(after)

  for (const op of ops) {
    if (op.op === 'replace_text') {
      const beforeCount = beforeTexts.reduce((acc, t) => acc + countOf(t, op.find), 0)
      if (beforeCount !== (op.expected_count ?? 1)) {
        throw new Error('门禁③未通过：replace_text 命中数与声明不符')
      }
      const reintroduced = countOf(op.replace, op.find)
      const expectedAfter = beforeCount - (op.expected_count ?? 1) + reintroduced * (op.expected_count ?? 1)
      const actualAfter = afterTexts.reduce((acc, t) => acc + countOf(t, op.find), 0)
      if (actualAfter !== expectedAfter) {
        throw new Error(`门禁③未通过：replace_text 后「${op.find.slice(0, 30)}」出现 ${actualAfter} 次（期望 ${expectedAfter}）`)
      }
      continue
    }
    // set_shape_text: the target shape's concatenated text equals the new
    // text (with GAP normalization); every other shape's paragraph count is
    // untouched.
    const shapeAfter = after.shapes.find((s) => s.id === op.shape_id)
    if (!shapeAfter) throw new Error(`门禁③未通过：set_shape_text 后形状 ${op.shape_id} 消失了`)
    const got = shapeAfter.paragraphs.map((p) => p.text.replace(new RegExp(GAP_CHAR, 'g'), '')).join('\n')
    const want = op.text.replace(new RegExp(GAP_CHAR, 'g'), '')
    if (got !== want) {
      throw new Error(`门禁③未通过：set_shape_text 后形状 ${op.shape_id} 的文本与声明不符`)
    }
    const beforeOther = before.shapes.filter((s) => s.id !== op.shape_id).map((s) => s.paragraphs.length).join(',')
    const afterOther = after.shapes.filter((s) => s.id !== op.shape_id).map((s) => s.paragraphs.length).join(',')
    if (beforeOther !== afterOther) {
      throw new Error('门禁③未通过：set_shape_text 改变了目标形状之外的段落数')
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
