// ── md-to-pptx mapper (PLAN-pptx-export) ── covers the pure slide-spec half
// (heading pagination D2, block/inline mapping D3/D4, honest degradation D5,
// the 200-slide cap D6) and the real buffer: pptxgenjs output is unzipped and
// its slide XML read back, because a spec that looks right says nothing about
// the bytes the user takes away.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { markdownToSlideSpecs, markdownToPptxBuffer, PPTX_EXPORT_SLIDE_LIMIT } from '../src/main/office-export/md-to-pptx'

describe('slide specs (D2 pagination)', () => {
  it('the first h1 is the cover; its first paragraph is the subtitle', () => {
    const { slides } = markdownToSlideSpecs('# 季度汇报\n\n2026 Q3 经营回顾\n\n正文段落')
    expect(slides).toHaveLength(1)
    expect(slides[0].kind).toBe('cover')
    expect(slides[0].title).toBe('季度汇报')
    expect(slides[0].subtitle).toBe('2026 Q3 经营回顾')
    expect(slides[0].blocks).toEqual([expect.objectContaining({ kind: 'para' })])
  })

  it('every h1/h2 starts a new page; ### stays a bold body line', () => {
    const { slides } = markdownToSlideSpecs('# 封面\n\n## 甲\n\n甲内容\n\n### 小节\n\n深内容\n\n## 乙\n\n乙内容')
    expect(slides.map((s) => s.title)).toEqual(['封面', '甲', '乙'])
    expect(slides[0].kind).toBe('cover')
    expect(slides[1].kind).toBe('content')
    const kinds = slides[1].blocks.map((b) => b.kind)
    expect(kinds).toEqual(['para', 'heading', 'para'])
  })

  it('a document with no headings rides one page', () => {
    const { slides } = markdownToSlideSpecs('只有段落。\n\n- 甲\n- 乙')
    expect(slides).toHaveLength(1)
    expect(slides[0].title).toBe('')
    expect(slides[0].blocks.map((b) => b.kind)).toEqual(['para', 'bullet', 'bullet'])
  })

  it('an empty document exports nothing (the service refuses it)', () => {
    expect(markdownToSlideSpecs('\n\n   \n').slides).toHaveLength(0)
  })
})

describe('block + inline mapping (D3/D4)', () => {
  it('bullets nest to level 2; deeper flattens onto level 2', () => {
    const { slides } = markdownToSlideSpecs('# T\n\n- 一\n  - 1.1\n    - 过深\n- 二')
    const bullets = slides[0].blocks.filter((b) => b.kind === 'bullet')
    expect(bullets.map((b) => (b as { level?: number }).level)).toEqual([0, 1, 2, 0])
  })

  it('ordered lists carry the flag', () => {
    const { slides } = markdownToSlideSpecs('# T\n\n1. 甲\n2. 乙')
    const bullets = slides[0].blocks.filter((b) => b.kind === 'bullet')
    expect(bullets.every((b) => (b as { ordered?: boolean }).ordered)).toBe(true)
  })

  it('tables map header + rows as plain text', () => {
    const { slides } = markdownToSlideSpecs('# T\n\n| 名称 | 数量 |\n|---|---|\n| 甲 | 3 |')
    expect(slides[0].blocks[0]).toEqual({ kind: 'table', header: ['名称', '数量'], rows: [['甲', '3']] })
  })

  it('code blocks stay verbatim; blockquote goes italic spec', () => {
    const { slides } = markdownToSlideSpecs('# T\n\n```js\nconst a = 1\n```\n\n> 引用一句')
    expect(slides[0].blocks[0]).toEqual({ kind: 'code', text: 'const a = 1' })
    expect(slides[0].blocks[1]).toMatchObject({ kind: 'quote' })
  })

  it('inline: outermost style wins; links carry href; hr is ignored', () => {
    const { slides } = markdownToSlideSpecs('## T\n\n**粗体和*嵌套斜体*** 与[站点](https://example.com)和`code`\n\n---')
    const para = slides[0].blocks[0]
    if (para.kind !== 'para') throw new Error('expected para')
    expect(para.runs[0]).toEqual({ text: '粗体和嵌套斜体', bold: true })
    expect(para.runs[1]).toEqual({ text: ' 与' })
    expect(para.runs[2]).toMatchObject({ text: '站点', link: 'https://example.com' })
    expect(para.runs[3]).toEqual({ text: '和' })
    expect(para.runs[4]).toEqual({ text: 'code', code: true })
  })
})

describe('honest degradation (D5) + cap (D6)', () => {
  it('images degrade to a labelled text run and a note', () => {
    const { slides, degradations } = markdownToSlideSpecs('## T\n\n![架构图](./a.png)')
    const para = slides[0].blocks[0]
    if (para.kind !== 'para') throw new Error('expected para')
    expect(para.runs[0].text).toContain('[图片:架构图]')
    expect(degradations.join('、')).toContain('图片')
  })

  it('a deck beyond 200 slides truncates with the count in the note', () => {
    const md = Array.from({ length: PPTX_EXPORT_SLIDE_LIMIT + 5 }, (_, i) => `## 页${i + 1}`).join('\n\n')
    const { slides, degradations } = markdownToSlideSpecs(md)
    expect(slides).toHaveLength(PPTX_EXPORT_SLIDE_LIMIT)
    expect(degradations.join('、')).toContain(`共 ${PPTX_EXPORT_SLIDE_LIMIT + 5} 页`)
  })

  it('the cap is the preview model’s cap — a drifted pair must fail loudly', async () => {
    // The exporter keeps its own copy on purpose (importing the preview module
    // would bundle its XML parser into the main process for one number), so the
    // equality is pinned here instead. Widening one without the other means an
    // exported deck the pane silently refuses to render.
    const { PPTX_PREVIEW_SLIDE_LIMIT } = await import('../src/shared/preview/pptx')
    expect(PPTX_EXPORT_SLIDE_LIMIT).toBe(PPTX_PREVIEW_SLIDE_LIMIT)
  })
})

// ── Real buffer: the bytes must parse back as the deck they claim. ──

function unzip(buffer: Buffer): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(buffer))
}

describe('pptx buffer', () => {
  it('generates a zip whose slide parts carry the mapped text', async () => {
    const files = unzip(await markdownToPptxBuffer('# 季度汇报\n\n2026 Q3\n\n## 甲\n\n- 要点一\n- 要点二'))
    const slideNames = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
    expect(slideNames).toHaveLength(2) // cover + 甲
    const presXml = strFromU8(files['ppt/presentation.xml'])
    expect(presXml).toContain('sldSz')
    const slide1 = strFromU8(files['ppt/slides/slide1.xml'])
    expect(slide1).toContain('季度汇报')
    expect(slide1).toContain('2026 Q3')
    const slide2 = strFromU8(files['ppt/slides/slide2.xml'])
    expect(slide2).toContain('甲')
    expect(slide2).toContain('要点一')
  })

  it('degradations produce a closing 备注 page', async () => {
    const files = unzip(await markdownToPptxBuffer('# T\n\n![图](./a.png)'))
    const slideNames = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slideNames).toHaveLength(2) // content + notes
    const notes = strFromU8(files['ppt/slides/slide2.xml'])
    expect(notes).toContain('导出说明')
    expect(notes).toContain('图片')
  })

  it('throws on an empty document (the service refuses before writing)', async () => {
    await expect(markdownToPptxBuffer('   \n\n')).rejects.toThrow('没有可导出的内容')
  })

  it('closes the loop: the exported deck parses through the PREVIEW model', async () => {
    const { parsePptxDeck } = await import('../src/shared/preview/pptx')
    const buffer = await markdownToPptxBuffer('# 季度汇报\n\n2026 Q3\n\n## 要点\n\n- 甲\n- 乙')
    const files = unzipSync(new Uint8Array(buffer))
    const deck = parsePptxDeck({
      entryText: (n) => (files[n] ? strFromU8(files[n]) : undefined),
      entryBytes: (n) => files[n],
      names: () => Object.keys(files),
    })
    expect(deck).not.toBeNull()
    const titleText = (i: number): string =>
        deck!.slides[i].shapes[0].text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('') ?? ''
    expect(titleText(0)).toBe('季度汇报')
    expect(titleText(1)).toBe('要点')
    expect(deck!.skipped.badImages).toBe(0)
  })

  it('readme path check: mapper lives next to its md-to-docx sibling', () => {
    const src = readFileSync(join(__dirname, '../src/main/office-export/md-to-pptx.ts'), 'utf8')
    expect(src).toContain("import { marked } from 'marked'")
    expect(src).toContain("import PptxGenJS from 'pptxgenjs'")
  })
})
