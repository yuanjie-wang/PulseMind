// ── pptx_edit service (PLAN-pptx-editing) ── exercises svcEditPptx over real
// files: the guard chain, the backup, the atomic replace, the outline-only
// no-write path, and the closed loop — an edited deck parses back through the
// PREVIEW model with the new text visible and zero skips.

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { svcEditPptx } from '../src/main/services/pptx-ops'
import { parsePptxDeck, type PptxParts } from '../src/shared/preview/pptx'
import pptxgen from 'pptxgenjs'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pm-pptx-service-'))
}

/** A real deck, generated the way the export tool does (same library). */
async function makeDeck(dir: string, name = '模板.pptx'): Promise<string> {
  const pptx = new pptxgen()
  const s1 = pptx.addSlide()
  s1.addText('季度经营汇报', { x: 1, y: 0.5, w: 8, h: 1, fontSize: 32, bold: true })
  s1.addText('营收增长 23%，成本下降 5%', { x: 1, y: 2, w: 8, h: 0.8, fontSize: 18 })
  const s2 = pptx.addSlide()
  s2.addText('要点', { x: 1, y: 0.5, w: 8, h: 1, fontSize: 24, bold: true })
  s2.addTable([[{ text: '指标' }, { text: '数值' }], [{ text: '营收' }, { text: '1200' }]], { x: 1, y: 2, w: 6 })
  const path = join(dir, name)
  const { writeFile } = await import('node:fs')
  const { promisify } = await import('node:util')
  await promisify(writeFile)(path, Buffer.from(await pptx.write({ outputType: 'nodebuffer' })))
  return path
}

function previewParse(path: string): ReturnType<typeof parsePptxDeck> {
  const files = new AdmZip(readFileSync(path)).getEntries().reduce<Record<string, Uint8Array>>((acc, e) => {
    if (!e.isDirectory) acc[e.entryName] = e.getData()
    return acc
  }, {})
  const parts: PptxParts = {
    entryText: (n) => (files[n] ? new TextDecoder().decode(files[n]) : undefined),
    entryBytes: (n) => files[n],
    names: () => Object.keys(files),
  }
  return parsePptxDeck(parts)
}

describe('svcEditPptx', () => {
  it('outline-only: reports slides and shape ids, writes nothing, no backup', async () => {
    const dir = tempDir()
    const path = await makeDeck(dir)
    const before = readFileSync(path)
    const result = await svcEditPptx({ filePath: path, ops: [{ op: 'outline' }] })
    expect(result.success).toBe(true)
    expect(result.outline).toHaveLength(2)
    expect(result.outline![0].shapes.some((s) => s.text.includes('季度经营汇报'))).toBe(true)
    expect(result.backup).toBeUndefined()
    expect(readFileSync(path)).toEqual(before)
  })

  it('replace_text: cross-run replace lands, backup created, file still parses', async () => {
    const dir = tempDir()
    const path = await makeDeck(dir)
    const result = await svcEditPptx({
      filePath: path,
      ops: [{ op: 'replace_text', slide: 1, find: '23%', replace: '31%' }],
    })
    expect(result.success).toBe(true)
    expect(result.backup).toBeDefined()
    expect(existsSync(result.backup!)).toBe(true)
    // closed loop through the preview model
    const deck = previewParse(path)!
    const texts = deck.slides[0].shapes.flatMap((s) => s.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')) ?? [])
    expect(texts.some((t) => t.includes('31%'))).toBe(true)
    expect(deck.skipped.corruptSlides).toBe(0)
  })

  it('set_shape_text by shape id from the outline; a second edit gets a -2 backup', async () => {
    const dir = tempDir()
    const path = await makeDeck(dir)
    const outline = await svcEditPptx({ filePath: path, ops: [{ op: 'outline' }] })
    const titleShape = outline.outline![0].shapes.find((s) => s.text.includes('季度经营汇报'))!
    const result = await svcEditPptx({
      filePath: path,
      ops: [{ op: 'set_shape_text', slide: 1, shape_id: titleShape.shapeId, text: '年度经营总结' }],
    })
    expect(result.success).toBe(true)
    const deck = previewParse(path)!
    const texts = deck.slides[0].shapes.flatMap((s) => s.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')) ?? [])
    expect(texts.some((t) => t.includes('年度经营总结'))).toBe(true)
    // second edit prunes/keeps backups per policy but never overwrites the target
    const second = await svcEditPptx({
      filePath: path,
      ops: [{ op: 'set_shape_text', slide: 1, shape_id: titleShape.shapeId, text: '第三版' }],
    })
    expect(second.success).toBe(true)
    expect(second.backup).not.toBe(result.backup)
  })

  it('a failed batch writes nothing (file byte-identical) and returns per-op results', async () => {
    const dir = tempDir()
    const path = await makeDeck(dir)
    const before = readFileSync(path)
    const result = await svcEditPptx({
      filePath: path,
      ops: [
        { op: 'replace_text', slide: 1, find: '23%', replace: '31%' },
        { op: 'replace_text', slide: 1, find: '不存在的文字', replace: 'x' },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.results?.some((r) => !r.ok)).toBe(true)
    expect(readFileSync(path)).toEqual(before)
  })

  it('legacy .ppt refuses with the save-as pointer', async () => {
    const dir = tempDir()
    const path = join(dir, '旧.ppt')
    const { writeFile: wf } = await import('node:fs')
    const { promisify } = await import('node:util')
    await promisify(wf)(path, Buffer.from('D0CF11E0A1B11AE1', 'hex'))
    const result = await svcEditPptx({ filePath: path, ops: [{ op: 'outline' }] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('另存为')
  })
})
