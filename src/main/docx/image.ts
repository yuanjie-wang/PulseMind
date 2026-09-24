// ── insert_image surgery (PLAN-office-expressiveness M3) ──
// One inline image touches FOUR package parts; every edit is a
// locate-and-replace that keeps "only edited parts re-encoded":
//   1. word/media/pmimg-<N>.<ext>            — the bytes (new part)
//   2. word/_rels/document.xml.rels          — the relationship
//   3. [Content_Types].xml                   — a Default for the extension
//   4. word/document.xml                     — the anchored <w:p> + wp:inline
// The drawing declares its namespaces INLINE (xmlns:wp/a/pic/r on the element)
// — the root's declarations are never trusted. docPr @id scans past the
// existing maximum so two images never collide (WPS is picky).
//
// Pure helpers only: the package layer (package.ts) owns the working copies of
// rels/content-types across a multi-image batch and the media write.

import { escapeXmlText } from './xml-splice'
import { imageDims, displaySize, EMU_PER_PX } from '../../shared/office/image-dims'

/** Scan the maximum N in `pmimg-<N>` across existing media names (0 when the
 *  package has none). */
export function nextMediaNumber(entryNames: string[]): number {
  let max = 0
  for (const name of entryNames) {
    const m = /media\/pmimg-(\d+)\./.exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** The maximum numeric rId in a rels part (relationships start at rId1). */
export function nextRelId(relsXml: string): number {
  let max = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]))
  return max + 1
}

/** The maximum numeric wp:docPr/@id in the document (0 when none). */
export function nextDocPrId(documentXml: string): number {
  let max = 0
  for (const m of documentXml.matchAll(/wp:docPr id="(\d+)"/g)) max = Math.max(max, Number(m[1]))
  return max + 1
}

/** Build the anchored drawing paragraph. Namespaces INLINE. */
export function drawingParagraph(opts: { docPrId: number; relId: string; widthPx: number; heightPx: number; alt: string }): string {
  const cx = Math.round(opts.widthPx * EMU_PER_PX)
  const cy = Math.round(opts.heightPx * EMU_PER_PX)
  const alt = escapeXmlText(opts.alt || '图片')
  return (
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${opts.docPrId}" name="图片 ${opts.docPrId}" descr="${alt}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${opts.docPrId}" name="图片 ${opts.docPrId}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${opts.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  )
}

export interface ImageBatchState {
  /** Working copies, updated per insert (initialized from the package). */
  relsXml: string
  contentTypesXml: string
  mediaEntries: Array<{ name: string; bytes: Buffer }>
  existingEntryNames: string[]
  altText: string
}

export interface PreparedImage {
  ext: string
  bytes: Buffer
  paragraphXml: string
  mediaName: string
  widthPx: number
  heightPx: number
}

/** Prepare ONE image against the batch state: allocate media number + rId +
 *  docPr id, update the working rels/CT copies, build the drawing paragraph.
 *  Throws loudly on unreadable images (the batch refuses with it). */
export function prepareImage(state: ImageBatchState, documentXml: string, image: { ext: string; bytes: Buffer; widthPx?: number; heightPx?: number }): PreparedImage {
  const dims = imageDims(image.bytes)
  if (!dims) throw new Error('insert_image: 无法解析图片尺寸（支持 png/jpg/jpeg/gif）')
  const size = displaySize(dims, { widthPx: image.widthPx, heightPx: image.heightPx })

  const mediaNum = nextMediaNumber([...state.existingEntryNames, ...state.mediaEntries.map((m) => m.name)])
  const mediaName = `word/media/pmimg-${mediaNum}.${image.ext}`
  const relNum = nextRelId(state.relsXml)
  const relId = `rId${relNum}`
  state.relsXml = state.relsXml.replace(
    '</Relationships>',
    `  <Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pmimg-${mediaNum}.${image.ext}"/>\n</Relationships>`,
  )
  const contentType = image.ext === 'jpg' || image.ext === 'jpeg' ? 'image/jpeg' : `image/${image.ext}`
  if (!state.contentTypesXml.includes(`Extension="${image.ext}"`)) {
    state.contentTypesXml = state.contentTypesXml.replace('</Types>', `  <Default Extension="${image.ext}" ContentType="${contentType}"/>\n</Types>`)
  }
  const docPrId = nextDocPrId(documentXml)
  const paragraphXml = drawingParagraph({ docPrId, relId, widthPx: size.width, heightPx: size.height, alt: state.altText })

  state.mediaEntries.push({ name: mediaName, bytes: image.bytes })
  return { ext: image.ext, bytes: image.bytes, paragraphXml, mediaName, widthPx: size.width, heightPx: size.height }
}
