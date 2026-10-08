// PLAN-pptx-html-route — the design route's test face. Two halves per the
// repo's split: this file (node env) covers the PURE emitter (facts → pptx,
// asserted through the real zip), the profile/token validators, the service
// contract (mutex, scans, pipe — Chromium mocked at the measureLayout seam,
// the real browser is the probe's job) and the wiring scans. The in-page
// collector is tests/office-html-collector.test.ts (jsdom).

import { describe, expect, it, vi } from 'vitest'

// ── guard mocked exactly like office-export-service.test.ts (it drags the DB in) ──
vi.mock('../src/main/sandbox/guard', () => ({
  expandTilde: (t: string) => (t.startsWith('~') ? t : t),
  guardFsTarget: async (target: string, mode: string) =>
    target.includes('deny') ? { ok: false, reason: `deny-listed (${mode})` } : { ok: true },
}))

// Chromium never launches in vitest: the service pipe is pinned with fixed
// minimal facts at the measureLayout seam (decoupled from EMIT_FACTS on
// purpose — the service e2e html has no images); the real measurement is the
// probe's job (scripts/probe-pptx-html-route.mjs). Validators stay real.
vi.mock('../src/main/office-export/html-measure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/office-export/html-measure')>()
  return {
    ...actual,
    measureLayout: vi.fn(async () => ({
      slides: [
        {
          blocks: [
            {
              kind: 'text', x: 64, y: 64, w: 400, h: 40, align: 'left' as const,
              runs: [{ text: '你好', fontSizePx: 18, bold: false, italic: false, underline: false, strike: false, color: '262626' }],
            },
          ],
        },
      ],
      degradations: ['第 1 页：1 处 box-shadow 未映射'],
    })),
  }
})

import AdmZip from 'adm-zip'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { htmlDeckToPptxBuffer } from '../src/main/office-export/html-to-pptx'
import {
  collectImageSrcs, collectLinkedCss, extractHtmlTitle, parseTokensCss,
  resolveTokenTheme, scanHtmlProfile,
} from '../src/main/office-export/html-measure'
import { defaultTokensStyle } from '../src/main/office-export/html-measure'
import { svcExportDocument } from '../src/main/services/office-export'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pm-html-route-'))
}

/** A real 1×1 PNG (same fixture office-export-service.test.ts uses). */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const run = (t: { text: string; fontSizePx: number; bold?: boolean; color: string }) => ({
  text: t.text, fontSizePx: t.fontSizePx, bold: !!t.bold, italic: false, underline: false, strike: false, color: t.color,
})

const EMIT_FACTS = {
  slides: [
    {
      background: 'FFF7E6',
      blocks: [
        { kind: 'box', x: 0, y: 0, w: 960, h: 40, fill: 'C2483B', radiusPx: 12 },
        { kind: 'text', x: 64, y: 80, w: 600, h: 60, align: 'left', runs: [run({ text: '季度回顾', fontSizePx: 44, bold: true, color: '1F1F1F' })] },
        { kind: 'text', x: 64, y: 400, w: 200, h: 40, align: 'left', bullet: { level: 1, ordered: false }, runs: [run({ text: '要点甲', fontSizePx: 18, color: '595959' })] },
        { kind: 'text', x: 64, y: 440, w: 200, h: 40, align: 'left', positioned: true, runs: [run({ text: '定位文本', fontSizePx: 18, color: '595959' })] },
      ],
    },
    {
      blocks: [
        { kind: 'chart', x: 64, y: 120, w: 600, h: 360, raw: JSON.stringify({ type: 'pie', categories: ['甲', '乙'], series: [{ name: '构成', values: [60, 40] }] }) },
      ],
    },
    {
      blocks: [
        {
          kind: 'table', x: 64, y: 120, w: 600, h: 120, colWidthsPx: [300, 300], rowHeightsPx: [40, 40, 40],
          cells: [
            [
              { text: '名称', header: true, bold: true, color: 'FFFFFF', fontSizePx: 16, align: 'left' as const, fill: 'C2483B' },
              { text: '数量', header: true, bold: true, color: 'FFFFFF', fontSizePx: 16, align: 'left' as const, fill: 'C2483B' },
            ],
            [
              { text: '甲', header: false, bold: false, color: '262626', fontSizePx: 14, align: 'left' as const },
              { text: '12', header: false, bold: false, color: '262626', fontSizePx: 14, align: 'left' as const },
            ],
          ],
        },
      ],
    },
    {
      blocks: [{ kind: 'image', x: 64, y: 64, w: 300, h: 200, src: 'assets/logo.png' }],
    },
  ],
}

const EMIT_IMAGES = new Map([['assets/logo.png', PNG_1PX]])

describe('htmlDeckToPptxBuffer (facts → pptx)', () => {
  it('emits a 4-slide deck the read-back gate would accept', async () => {
    const { buffer, report } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: '测试 Deck',
      degradations: ['第 1 页：1 处 box-shadow 未映射'],
    })
    const zip = new AdmZip(buffer)
    for (let i = 1; i <= 4; i++) expect(zip.readFile(`ppt/slides/slide${i}.xml`)).toBeTruthy()
    expect(report).toContain('4 页')
    expect(report).toContain('图表 1')
    expect(report).toContain('表格 1')
    expect(report).toContain('box-shadow')
    expect(report).toContain('office_edit')
  })

  it('maps px → EMU/pt at 96dpi (64px = 0.667in = 609600 EMU; 44px = 33pt)', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const slide1 = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(slide1).toContain('x="609600"') // 64px
    expect(slide1).toContain('y="762000"') // 80px
    expect(slide1).toContain('sz="3300"') // 44px × 0.75
    expect(slide1).toContain('季度回顾')
  })

  it('slide background, box fill/radius, and bullets land as real pptx primitives', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const slide1 = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(slide1).toContain('val="FFF7E6"') // slide background
    expect(slide1).toContain('val="C2483B"') // band fill
    expect(slide1).toContain('prst="roundRect"') // radiusPx 12
    expect(slide1).toContain('buChar') // ul bullet
    // positioned paints above in-flow: 定位文本 is the LAST text emitted
    expect(slide1.indexOf('要点甲')).toBeLessThan(slide1.indexOf('定位文本'))
  })

  it('fill/line/border alpha maps to pptx transparency, slide background included', async () => {
    const facts = {
      slides: [
        {
          background: '0B1F3A',
          backgroundTransparency: 25,
          blocks: [
            // mask over a photo: 65% alpha → pptx transparency 35
            { kind: 'box', x: 0, y: 0, w: 960, h: 540, fill: '000000', fillTransparency: 65 },
            { kind: 'box', x: 64, y: 64, w: 200, h: 60, fill: 'C2483B', border: { color: '7A241C', widthPx: 2, transparency: 40 } },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:alpha val="75000"/>') // bg alpha 0.25 → 75% (transparency 25)
    expect(xml).toContain('<a:alpha val="35000"/>') // mask fill alpha 0.65 → 35%
    expect(xml).toContain('<a:alpha val="60000"/>') // border alpha 0.6 → 60%
    // opaque fills stay alpha-free
    expect(xml).not.toContain('<a:alpha val="100000"/>')
  })

  it('a single outer box-shadow lands as <a:outerShdw> (polar dist/dir from dx/dy)', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            // `0 2px 8px rgba(0,0,0,0.1)`: dist=1.5pt→19050 EMU, dir=90°→5400000, alpha 0.1
            { kind: 'box', x: 64, y: 64, w: 300, h: 120, fill: 'FFFFFF', shadow: { offsetX: 0, offsetY: 2, blur: 8, color: '000000', alpha: 0.1 } },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:outerShdw')
    expect(xml).toContain('blurRad="76200"') // 8px × 0.75 = 6pt
    expect(xml).toContain('dist="19050"') // |offset| = 2px × 0.75 = 1.5pt
    expect(xml).toContain('dir="5400000"') // atan2(2, 0) = 90°
    expect(xml).toContain('<a:alpha val="10000"/>') // opacity 0.1
  })

  it('shadow zeros survive pptxgenjs falsy-defaults (glow keeps no offset, 0° stays 0°)', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            // `0 0 12px …`: a glow — offset must stay ~0, not pptxgenjs's default 4pt
            { kind: 'box', x: 64, y: 64, w: 300, h: 120, fill: 'FFFFFF', shadow: { offsetX: 0, offsetY: 0, blur: 12, color: '000000', alpha: 0.2 } },
            // `4px 0 8px …`: dir=0° must not become pptxgenjs's default 270°
            { kind: 'box', x: 400, y: 64, w: 300, h: 120, fill: 'FFFFFF', shadow: { offsetX: 4, offsetY: 0, blur: 8, color: '000000', alpha: 0.2 } },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('dist="127"') // 0.01pt epsilon — NOT the 4pt (50800) default
    expect(xml).not.toContain('dist="50800"')
    expect(xml).toContain('dir="21600000"') // 360° ≡ 0° — NOT the 270° default
    expect(xml).not.toContain('dir="16200000"') // 270°
  })

  it('object-fit:cover rewrites the pic srcRect from the measured crop (post-pass)', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            // 2000×1500 (4:3) natural in a 960×540 (16:9) window: taller than
            // the box → top/bottom crop (renderedH = 960/(4/3) = 720;
            // (720−540)/(2·720) = 0.125). The collector computes this; the
            // facts carry it verbatim.
            { kind: 'image', x: 0, y: 0, w: 960, h: 540, src: 'assets/logo.png', objectFit: 'cover' as const, naturalW: 2000, naturalH: 1500, coverCrop: { l: 0, r: 0, t: 0.125, b: 0.125 } },
            { kind: 'image', x: 640, y: 64, w: 256, h: 192, src: 'assets/logo.png' },
          ],
        },
      ],
    }
    const { buffer, report } = await htmlDeckToPptxBuffer({
      facts, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    // the cover pic carries the REAL crop; the plain image keeps the legacy
    // stretch with no srcRect at all
    expect(xml).toContain('<a:srcRect l="0" r="0" t="12500" b="12500"/>')
    expect(xml.match(/<a:srcRect/g)).toHaveLength(1)
    expect(xml).toContain('<a:stretch><a:fillRect/></a:stretch>')
    expect(report).not.toContain('object-fit')
  })

  // review_20261008 高1: the post-pass used string-mode replace — only the
  // FIRST marker per slide was swapped, so the 2nd+ cover image on one slide
  // kept its zero srcRect (stretch, not crop) with no degradation line. The
  // contract is k-th marker → k-th crop in emission order, ALL of them.
  it('two cover images on one slide both get their crops (k-th marker → k-th crop)', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            { kind: 'image', x: 0, y: 0, w: 480, h: 540, src: 'assets/logo.png', objectFit: 'cover' as const, naturalW: 2000, naturalH: 1500, coverCrop: { l: 0.1, r: 0.1, t: 0.125, b: 0.125 } },
            { kind: 'image', x: 480, y: 0, w: 480, h: 540, src: 'assets/logo.png', objectFit: 'cover' as const, naturalW: 1500, naturalH: 2000, coverCrop: { l: 0.2, r: 0.2, t: 0, b: 0 } },
          ],
        },
      ],
    }
    const { buffer, report } = await htmlDeckToPptxBuffer({
      facts, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    // BOTH real crops landed, in emission order — no zero marker survives
    expect(xml).toContain('<a:srcRect l="10000" r="10000" t="12500" b="12500"/>')
    expect(xml).toContain('<a:srcRect l="20000" r="20000" t="0" b="0"/>')
    expect(xml).not.toContain('<a:srcRect l="0" r="0" t="0" b="0"/>')
    expect(report).not.toContain('object-fit')
  })

  it('a cover image without a computable crop degrades to stretch, by name', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            { kind: 'image', x: 0, y: 0, w: 960, h: 540, src: 'assets/logo.png', objectFit: 'cover' as const },
          ],
        },
      ],
    }
    const { buffer, report } = await htmlDeckToPptxBuffer({
      facts, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).not.toContain('<a:srcRect')
    expect(report).toContain('object-fit:cover')
    expect(report).toContain('按拉伸处理')
  })

  it('letter-spacing px → charSpacing pt (spc = 1/100pt, 4px → 300)', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            {
              kind: 'text', x: 64, y: 64, w: 400, h: 30, align: 'left' as const,
              runs: [
                run({ text: '眉 题', fontSizePx: 13, color: '8C8C8C' }),
                { ...run({ text: '未加字距', fontSizePx: 13, color: '8C8C8C' }), charSpacingPx: 4 },
              ],
            },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('spc="300"') // 4px × 0.75 = 3pt → spc 300
    expect(xml.match(/spc="/g)).toHaveLength(1) // only the tracked run carries it
  })

  it('dashed/dotted borders land as prstDash; solid stays silent', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            { kind: 'box', x: 40, y: 40, w: 200, h: 60, border: { color: '7A241C', widthPx: 2, dash: 'dash' } },
            { kind: 'box', x: 300, y: 40, w: 200, h: 60, border: { color: '333333', widthPx: 1, dash: 'dot' } },
            { kind: 'box', x: 40, y: 140, w: 200, h: 60, border: { color: '666666', widthPx: 1 } },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:prstDash val="dash"/>')
    expect(xml).toContain('<a:prstDash val="dot"/>')
    expect(xml.match(/<a:prstDash val="dash"/g)).toHaveLength(1)
    expect(xml.match(/<a:prstDash val="dot"/g)).toHaveLength(1)
    // pptxgenjs writes prstDash val="solid" for plain lines — that is its
    // own default shape, not something the profile asked for
    expect(xml).toContain('<a:prstDash val="solid"/>')
  })

  it('splits a:latin/a:ea — latin rides --pm-font-latin, CJK keeps --pm-font-zh', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const slide1 = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(slide1).toContain('<a:latin typeface="Arial"')
    expect(slide1).toContain('<a:ea typeface="微软雅黑"')
  })

  it('a mono run carries the mono latin face while CJK stays on the sans face', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            {
              kind: 'text', x: 64, y: 500, w: 200, h: 24, align: 'left' as const,
              runs: [
                { text: 'P03', fontSizePx: 13, bold: false, italic: false, underline: false, strike: false, color: '8C8C8C', mono: true },
                { text: ' / 14', fontSizePx: 13, bold: false, italic: false, underline: false, strike: false, color: '8C8C8C' },
              ],
            },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', fontMono: 'Menlo', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:latin typeface="Menlo"') // the mono run's latin
    expect(xml).not.toContain('<a:ea typeface="Menlo"') // post-pass: CJK reads on the sans face
  })

  it('same font both sides skips the latin/ea rewrite', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: 'Arial', fontLatin: 'Arial', title: 't',
    })
    const slide1 = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(slide1).toContain('<a:latin typeface="Arial"')
    expect(slide1).toContain('<a:ea typeface="Arial"')
  })

  it('charts draw as native pie shapes with the accent riding the first slice', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const slide2 = new AdmZip(buffer).readAsText('ppt/slides/slide2.xml')
    expect(slide2).toContain('prst="pie"')
    expect(slide2).toContain('val="C2483B"')
    expect(slide2).toContain('甲 · 60')
  })

  // review_20261006 中7: the box-parameterization refactor (fixed coordinates →
  // ChartBox) rewrote the column/bar/line geometry and retired the deck route's
  // five chart tests with it — the new route only tested pie. These three pin
  // each branch's shape vocabulary through the real zip, at a NON-default box.
  const chartFacts = (raw: unknown) => ({
    slides: [{ blocks: [{ kind: 'chart', x: 120, y: 80, w: 520, h: 300, raw: JSON.stringify(raw) }] }],
  })
  const emitChart = async (raw: unknown) => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: chartFacts(raw), images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    return new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
  }

  it('column: grouped bars per series, legend, value + category labels (arbitrary box)', async () => {
    const xml = await emitChart({ type: 'column', categories: ['Q1', 'Q2'], series: [{ name: '营收', values: [120, 80] }, { name: '成本', values: [60, 90] }] })
    // 每系列色出现 3 次 = 2 根柱 + 1 个图例色块（文本框也带 rect 几何，
    // 数 prst 区分不出柱子，数系列填充色才行）。伴生色是 accent 派生的
    // （seriesPalette 金黄角轮转）：红 accent 的第二系列是 3BC26F，不再是
    // 固定 antd 青。
    expect(xml.match(/val="C2483B"/g)).toHaveLength(3)
    expect(xml.match(/val="3BC26F"/g)).toHaveLength(3)
    expect(xml).toContain('<a:t>营收</a:t>') // legend entry
    expect(xml).toContain('<a:t>成本</a:t>')
    for (const v of ['120', '80', '60', '90']) expect(xml).toContain(`<a:t>${v}</a:t>`) // value labels (≤24 cells)
    expect(xml).toContain('<a:t>Q1</a:t>') // category labels
  })

  it('bar: horizontal bars with a class-label column and a darker zero line for negatives', async () => {
    const xml = await emitChart({ type: 'bar', categories: ['一月', '二月', '三月'], series: [{ name: '净额', values: [120, -30, 80] }] })
    // 1 series → no legend；系列色恰好 3 次 = 3 根横条
    expect(xml.match(/val="C2483B"/g)).toHaveLength(3)
    expect(xml).toContain('<a:t>三月</a:t>') // the class-label column
    expect(xml).toContain('val="BFBFBF"') // the vertical zero line (minV < 0)
    for (const v of ['120', '-30', '80']) expect(xml).toContain(`<a:t>${v}</a:t>`)
  })

  it('line: polyline segments + point dots, flipV on the rising leg, value labels', async () => {
    const xml = await emitChart({ type: 'line', categories: ['甲', '乙', '丙'], series: [{ name: '走势', values: [1, 3, 2] }] })
    // 3 points → 2 segments; the chart's own bottom axis adds 1 more line
    expect(xml.match(/prst="line"/g)).toHaveLength(3)
    expect(xml.match(/prst="ellipse"/g)).toHaveLength(3) // one dot per point
    expect(xml.match(/val="C2483B"/g)).toHaveLength(5) // 3 dot fills + 2 segment strokes ride the accent
    expect(xml.match(/flipV="1"/g)).toHaveLength(1) // 甲→乙 rises, 乙→丙 falls
    for (const c of ['甲', '乙', '丙']) expect(xml).toContain(`<a:t>${c}</a:t>`)
  })

  it('tables map to native <a:tbl> with per-cell styles', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const slide3 = new AdmZip(buffer).readAsText('ppt/slides/slide3.xml')
    expect(slide3).toContain('<a:tbl>')
    expect(slide3).toContain('val="C2483B"')
    expect(slide3).toContain('sz="1200"') // 16px header
  })

  it('embeds referenced workspace images', async () => {
    const { buffer } = await htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: EMIT_IMAGES, accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const zip = new AdmZip(buffer)
    // pptxgenjs writes a bare `ppt/media/` directory entry alongside the file
    const media = zip.getEntries().filter((e) => e.entryName.startsWith('ppt/media/') && !e.entryName.endsWith('/'))
    expect(media).toHaveLength(1)
    expect(media[0].getData()).toEqual(PNG_1PX)
  })

  it('refuses an invalid data-chart with a page-named, readable reason', async () => {
    await expect(htmlDeckToPptxBuffer({
      facts: { slides: [{ blocks: [{ kind: 'chart', x: 0, y: 0, w: 100, h: 100, raw: '{not json' }] }] },
      images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })).rejects.toThrow('不是合法 JSON')
    await expect(htmlDeckToPptxBuffer({
      facts: { slides: [{ blocks: [{ kind: 'chart', x: 0, y: 0, w: 100, h: 100, raw: JSON.stringify({ type: 'pie', categories: ['a', 'b'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [2, 3] }] }) }] }] },
      images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })).rejects.toThrow('pie 只吃一组 series')
  })

  it('zeroes text-box insets and pads per alignment without moving the anchor', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            { kind: 'text', x: 880, y: 500, w: 40, h: 20, align: 'right' as const, positioned: true, runs: [run({ text: '3 / 12', fontSizePx: 12, color: '8C8C8C' })] },
            { kind: 'text', x: 64, y: 80, w: 200, h: 30, align: 'left' as const, runs: [run({ text: '标题', fontSizePx: 24, color: '262626' })] },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    expect(xml).toContain('lIns="0"')
    // right-aligned page number: box grew LEFT (880-8=872px → off 8,305,800), width grew (+8px → 48px → 457,200)
    expect(xml).toContain('x="8305800"')
    expect(xml).toContain('cx="457200"')
    // left-aligned: anchor unchanged (64px → 609600), width extended (208px → 1,981,200)
    expect(xml).toContain('x="609600"')
    expect(xml).toContain('cx="1981200"')
  })

  it('clamps padded text boxes to the canvas', async () => {
    const facts = {
      slides: [
        {
          blocks: [
            { kind: 'text', x: 900, y: 520, w: 100, h: 18, align: 'left' as const, runs: [run({ text: '尾行', fontSizePx: 12, color: '262626' })] },
          ],
        },
      ],
    }
    const { buffer } = await htmlDeckToPptxBuffer({
      facts, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    // x+w would be 900+108+4=1012px > 960 — width clamps to 60px (571500 EMU)
    expect(xml).toContain('cx="571500"')
  })

  it('refuses an image the service never resolved (internal-inconsistency guard)', async () => {
    await expect(htmlDeckToPptxBuffer({
      facts: EMIT_FACTS, images: new Map(), accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', title: 't',
    })).rejects.toThrow('没有解析到字节')
  })
})

// ── pure validators ──

describe('scanHtmlProfile', () => {
  const clean = `<!doctype html><html><head><style>.slide{width:960px;height:540px}</style></head>
<body><div class="slide"><p>你好</p></div></body></html>`

  it('a clean profile html passes', () => {
    expect(scanHtmlProfile(clean)).toEqual([])
  })

  it('font-family var() references to the three font tokens are legal', () => {
    expect(scanHtmlProfile(`<style>.mono{font-family:var(--pm-font-mono)}</style>${clean}`)).toEqual([])
  })

  const cases: Array<[string, RegExp, string]> = [
    ['script', /script/, `<script>alert(1)</script>${clean}`],
    ['svg', /白名单外/, `<div class="slide"><svg width="10"><rect/></svg></div>`],
    ['font-face', /@font-face/, `<style>@font-face{src:url(x.woff)}</style>${clean}`],
    ['import', /@import/, `<style>@import url(a.css)</style>${clean}`],
    ['css url', /url/, `<style>.s{background:url(a.png)}</style>${clean}`],
    ['srcset', /srcset/, `<div class="slide"><img src="a.png" srcset="a.png 2x"></div>`],
    ['font-family', /font-family/, `<div class="slide" style="font-family:Arial"><p>x</p></div>`],
    ['font-family bare list', /font-family/, `<div class="slide" style="font-family:'Menlo',monospace"><p>x</p></div>`],
    ['fixed', /fixed/, `<style>.s{position:fixed}</style>${clean}`],
    ['transform', /transform/, `<style>.s{transform:rotate(3deg)}</style>${clean}`],
    ['animation', /动画/, `<style>.s{animation:x 1s}</style>${clean}`],
    ['gradient', /渐变/, `<style>.s{background:linear-gradient(red,blue)}</style>${clean}`],
    ['colspan', /合并单元格/, `<table><tr><td colspan="2">x</td></tr></table>`],
    ['network image', /网络/, `<div class="slide"><img src="https://a.com/b.png"></div>`],
  ]
  it.each(cases)('refuses %s', (_name, pattern, html) => {
    expect(scanHtmlProfile(html).join('\n')).toMatch(pattern)
  })

  it('refusals carry the 1-based source line', () => {
    const html = `<style>.a{color:red}</style>\n<div class="slide"><script>alert(1)</script></div>`
    expect(scanHtmlProfile(html).join('\n')).toMatch(/第 2 行：<script>/)
  })

  it('self-closing variants of the enumerated refusals are caught too', () => {
    expect(scanHtmlProfile(`<head><script/></head>${clean}`).join('\n')).toMatch(/script/)
    expect(scanHtmlProfile(`<div class="slide"><svg/></div>`).join('\n')).toMatch(/白名单外/)
  })
})

describe('parseTokensCss', () => {
  it('parses the 7-key schema, normalizing 3-digit hex and quotes', () => {
    const { values, errors } = parseTokensCss(`/* theme */
:root {
  --pm-accent: #c24; /* 3-digit */
  --pm-ink: #1F1F1F;
  --pm-font-zh: "微软雅黑";
}`)
    expect(errors).toEqual([])
    expect(values['--pm-accent']).toBe('CC2244')
    expect(values['--pm-ink']).toBe('1F1F1F')
    expect(values['--pm-font-zh']).toBe('微软雅黑')
  })

  it('accepts the type-scale keys as bounded px integers', () => {
    const { values, errors } = parseTokensCss(':root { --pm-fs-cover: 48px; --pm-fs-title: 30px; }')
    expect(errors).toEqual([])
    expect(values['--pm-fs-cover']).toBe('48px')
    expect(parseTokensCss(':root { --pm-fs-body: 18; }').errors.join()).toMatch(/整像素/)
    expect(parseTokensCss(':root { --pm-fs-note: 300px; }').errors.join()).toMatch(/整像素/)
    expect(parseTokensCss(':root { --pm-fs-body: 1.5rem; }').errors.join()).toMatch(/整像素/)
  })

  it('accepts mono faces from the whitelist', () => {
    const { values, errors } = parseTokensCss(":root { --pm-font-mono: 'JetBrains Mono'; }")
    expect(errors).toEqual([])
    expect(values['--pm-font-mono']).toBe('JetBrains Mono')
    expect(parseTokensCss(":root { --pm-font-mono: 'Comic Sans MS'; }").errors.join()).toMatch(/白名单/)
  })

  it('refuses unknown variables, non-hex colors, non-whitelisted fonts, and non-:root content', () => {
    expect(parseTokensCss(':root { --pm-brand: #123456; }').errors.join()).toMatch(/未知变量/)
    expect(parseTokensCss(':root { --pm-accent: rgb(1,2,3); }').errors.join()).toMatch(/hex/)
    expect(parseTokensCss(":root { --pm-font-zh: 'Comic Sans'; }").errors.join()).toMatch(/白名单/)
    expect(parseTokensCss(':root { --pm-font-zh: A, B; }').errors.join()).toMatch(/一个字体名/)
    expect(parseTokensCss('body { margin: 0 } :root { --pm-ink: #111111; }').errors.join()).toMatch(/:root/)
  })
})

describe('token helpers', () => {
  it('resolveTokenTheme applies defaults and strips #', () => {
    const t = resolveTokenTheme({ '--pm-accent': '#C2483B' })
    expect(t).toEqual({ accent: 'C2483B', fontZh: '微软雅黑', fontLatin: 'Arial', fontMono: 'Courier New' })
  })

  it('defaultTokensStyle is a :root style block with every token', () => {
    const s = defaultTokensStyle()
    expect(s).toMatch(/^<style>:root \{ .+ \}<\/style>$/)
    expect(s).toContain('--pm-accent: #2F54EB')
    expect(s).toContain('--pm-accent-soft: #EAEFFB')
    expect(s).toContain('--pm-line: #D9D9D9')
    expect(s).toContain('--pm-font-zh: 微软雅黑')
    expect(s).toContain('--pm-font-mono: Courier New')
    expect(s).toContain('--pm-fs-title: 26px')
    expect(s).toContain('--pm-fs-note: 12px')
  })

  it('collectLinkedCss / collectImageSrcs / extractHtmlTitle read the html', () => {
    const html = `<head><link rel="stylesheet" href="./tokens.css"><link rel="stylesheet" href="tokens.css"><title>季度 Deck</title></head>
<body><img src="assets/a.png"><img src='./b.png'><img src=noc.png></body>`
    expect(collectLinkedCss(html)).toEqual(['./tokens.css', 'tokens.css'])
    expect(collectImageSrcs(html)).toEqual(['assets/a.png', './b.png', 'noc.png'])
    expect(extractHtmlTitle(html)).toBe('季度 Deck')
  })
})

// ── service contract (Chromium mocked at the seam) ──

describe('svcExportDocument · htmlPath', () => {
  it('enforces the four-way mutex with paired messages', async () => {
    const dir = tempDir()
    const html = join(dir, 'deck.html')
    writeFileSync(html, '<div class="slide"></div>')
    expect((await svcExportDocument({ format: 'pptx', deck: {}, filePath: join(dir, 'o.pptx') })).error).toMatch(/deck 参数已退役/)
    expect((await svcExportDocument({ format: 'pptx', htmlPath: html, content: '# x', filePath: join(dir, 'o.pptx') })).error).toMatch(/htmlPath 与 content/)
    expect((await svcExportDocument({ format: 'pptx', htmlPath: html, sourcePath: html, filePath: join(dir, 'o.pptx') })).error).toMatch(/htmlPath 与 sourcePath/)
    expect((await svcExportDocument({ format: 'docx', htmlPath: html, filePath: join(dir, 'o.docx') })).error).toMatch(/htmlPath 仅支持 format pptx/)
    expect((await svcExportDocument({ format: 'docx', filePath: join(dir, 'o.docx') })).error).toMatch(/content 与 sourcePath/)
  })

  it('surfaces profile refusals raw (no 构建失败 prefix), naming nothing written', async () => {
    const dir = tempDir()
    const html = join(dir, 'deck.html')
    writeFileSync(html, '<div class="slide"><script>alert(1)</script></div>')
    const result = await svcExportDocument({ format: 'pptx', htmlPath: html, filePath: join(dir, 'o.pptx') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('profile 校验未通过')
    expect(result.error).toContain('<script>')
    expect(existsNo(join(dir, 'o.pptx'))).toBe(false)
  })

  it('refuses a second stylesheet link and unknown tokens', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'deck.html'), '<head><link rel="stylesheet" href="./theme.css"></head><div class="slide"></div>')
    expect((await svcExportDocument({ format: 'pptx', htmlPath: join(dir, 'deck.html'), filePath: join(dir, 'o.pptx') })).error).toMatch(/tokens\.css/)
    writeFileSync(join(dir, 'deck.html'), '<head><link rel="stylesheet" href="./tokens.css"></head><div class="slide"></div>')
    writeFileSync(join(dir, 'tokens.css'), ':root { --pm-brand: #123456; }')
    expect((await svcExportDocument({ format: 'pptx', htmlPath: join(dir, 'deck.html'), filePath: join(dir, 'o.pptx') })).error).toMatch(/tokens\.css 校验未通过/)
  })

  it('refuses an unresolvable image before Chromium runs', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'deck.html'), '<div class="slide"><img src="assets/gone.png"></div>')
    const result = await svcExportDocument({ format: 'pptx', htmlPath: join(dir, 'deck.html'), filePath: join(dir, 'o.pptx') })
    expect(result.error).toMatch(/<img src="assets\/gone\.png">/)
  })

  it('end-to-end with measured facts mocked: real pptx lands, report rides, gate applies', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'deck.html'), `<head><title>季度经营</title></head><div class="slide"><p>你好</p></div>`)
    const result = await svcExportDocument({ format: 'pptx', htmlPath: join(dir, 'deck.html'), filePath: join(dir, 'out.pptx') })
    expect(result.success).toBe(true)
    expect(result.report).toContain('保真报告')
    expect(result.report).toContain('box-shadow') // measure degradations pass through
    const zip = new AdmZip(readFileSync(result.path!))
    expect(zip.readFile('ppt/slides/slide1.xml')).toBeTruthy()
    // the pptx title metadata carries the html <title>
    const core = zip.readFile('docProps/core.xml')?.toString('utf8') ?? ''
    expect(core).toContain('季度经营')
  })

  function existsNo(p: string): boolean {
    try { readFileSync(p); return true } catch { return false }
  }
})

// ── wiring scans (the composer-cap / toolset-stability钉法) ──

describe('wiring scans', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

  it('export_document schema carries htmlPath with mutex wording', () => {
    const src = read('src/renderer/src/tools/built-in-tools.ts')
    expect(src).toMatch(/htmlPath: \{ type: 'string', description: '\(pptx only\) 设计路线/)
    expect(src).toMatch(/exactly one/)
    // deck route stays retired at the model-visible surface
    expect(src).not.toMatch(/\bdeck:\s*\{/)
    expect(src).toMatch(/ALWAYS via the HTML design route/)
  })

  it('tool manual carries the design-route recipe and dual-source contract', () => {
    const src = read('src/renderer/src/tools/tool-instructions.ts')
    expect(src).toMatch(/htmlPath: \(format pptx only\) \*\*设计路线\*\*——从零做 PPT 的唯一生成路线/)
    expect(src).toMatch(/先与用户对齐风格/)
    expect(src).toMatch(/落定即锁，改风格\/换字号阶只改它/)
    expect(src).toMatch(/双源契约/)
    expect(src).toMatch(/content \/ htmlPath \/ sourcePath/)
  })

  it('executor pre-validates the four-way mutex and surfaces the report', () => {
    const src = read('src/renderer/src/agent/tool-executors.ts')
    expect(src).toMatch(/content \/ sourcePath \/ htmlPath 三选一/)
    expect(src).toMatch(/result\.report/)
  })

  it('SKILL routes the design path; references carry the profile', () => {
    const route = read('src/renderer/src/skills/built-in/office-route.ts')
    expect(route).toMatch(/设计路线/)
    expect(route).toMatch(/references\/pptx\.md\\` 设计路线节/)
    // alignment-first: the route demands a style conversation BEFORE tokens land
    expect(route).toMatch(/先对齐风格、落定 tokens\.css，再写 HTML/)
    expect(route).toMatch(/不要跳过对齐自作主张套默认主题/)
    const refs = read('src/renderer/src/skills/built-in/office-references.ts')
    expect(refs).toMatch(/## 七、设计路线（htmlPath：HTML → pptx）/)
    expect(refs).toMatch(/### 0\. 风格对齐：先定调，再动手/)
    expect(refs).toMatch(/没有「默认主题兜底」这回事/)
    expect(refs).toMatch(/--pm-accent/)
    expect(refs).toMatch(/960×540/)
  })

  it('bridge and preload types carry htmlPath/report', () => {
    const bridge = read('src/shared/types/electron-bridge.ts')
    expect(bridge).toMatch(/htmlPath\?: string/)
    expect(bridge).toMatch(/report\?: string/)
    const preload = read('src/preload/index.ts')
    expect(preload).toMatch(/htmlPath\?: string/)
  })
})
