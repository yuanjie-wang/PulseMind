// ── deck spec validator (PLAN-deck-layouts) ── the gate the model's deck
//  JSON passes through twice (renderer for the fast readable refusal, main at
//  the trust boundary). Every refusal here must name the slide and the field,
//  because the model is expected to fix and retry off this message alone.

import { describe, expect, it } from 'vitest'
import { parseDeckSpec, deckImagePaths, DECK_MAX_SLIDES, type DeckSpec } from '../src/shared/deck/spec'

const okSpec = (slides: object[], theme?: object): unknown => ({ title: '测试 Deck', ...(theme ? { theme } : {}), slides })

function errsOf(slides: object[]): string {
  const r = parseDeckSpec(okSpec(slides))
  expect(r.ok).toBe(false)
  return (r as { ok: false; error: string }).error
}

describe('parseDeckSpec — shape of the deck itself', () => {
  it('a valid deck parses; the accent normalizes to uppercase RRGGBB', () => {
    const r = parseDeckSpec(okSpec([{ layout: 'cover', title: '封面' }], { accent: 'aa33cc' }))
    expect(r.ok).toBe(true)
    expect((r as { ok: true; spec: DeckSpec }).spec.theme?.accent).toBe('AA33CC')
    expect((r as { ok: true; spec: DeckSpec }).spec.slides).toHaveLength(1)
  })

  it('non-object / missing title / empty slides refuse', () => {
    expect(parseDeckSpec('不是对象').ok).toBe(false)
    expect(parseDeckSpec({ slides: [{ layout: 'cover', title: 't' }] }).ok).toBe(false)
    expect(parseDeckSpec({ title: 't', slides: [] }).ok).toBe(false)
    expect(parseDeckSpec({ title: '   ', slides: [{ layout: 'cover', title: 't' }] }).ok).toBe(false)
  })

  it('an unknown layout refuses with the full layout list', () => {
    expect(errsOf([{ layout: 'slide', title: 'x' }])).toContain('cover / section / bullets / two-col / kpi / chart / table / quote / image')
  })

  it(`the deck cap is ${DECK_MAX_SLIDES} slides`, () => {
    const r = parseDeckSpec(okSpec(Array.from({ length: DECK_MAX_SLIDES + 1 }, () => ({ layout: 'quote', quote: 'x' }))))
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('上限')
  })

  it('a bad accent refuses with the received value', () => {
    const r = parseDeckSpec(okSpec([{ layout: 'cover', title: 'x' }], { accent: '#2F54EB' }))
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('#2F54EB')
  })
})

describe('parseDeckSpec — per-layout slots', () => {
  it('cover/section need a title', () => {
    expect(errsOf([{ layout: 'cover' }])).toContain('slides[0]（cover）：title 必填')
    expect(errsOf([{ layout: 'section' }])).toContain('slides[0]（section）：title 必填')
  })

  it('bullets: 1–10 items; strings or {text, sub}; empties refuse', () => {
    expect(errsOf([{ layout: 'bullets', title: 't' }])).toContain('bullets 必填')
    expect(errsOf([{ layout: 'bullets', title: 't', bullets: Array.from({ length: 11 }, (_, i) => `条${i}`) }])).toContain('最多 10 条')
    expect(errsOf([{ layout: 'bullets', title: 't', bullets: ['好', ''] }])).toContain('第 2 条是空字符串')
    expect(errsOf([{ layout: 'bullets', title: 't', bullets: [{ text: '好', sub: Array.from({ length: 7 }, () => '深') }] }])).toContain('最多 6 项')
    const r = parseDeckSpec(okSpec([{ layout: 'bullets', title: 't', bullets: [{ text: '好', sub: ['一'] }] }]))
    expect(r.ok).toBe(true)
  })

  it('two-col demands exactly two columns', () => {
    expect(errsOf([{ layout: 'two-col', title: 't', columns: [{ heading: '甲' }] }])).toContain('恰好两栏')
    const r = parseDeckSpec(okSpec([{ layout: 'two-col', title: 't', columns: [{ heading: '甲', bullets: ['1'] }, { bullets: ['2'] }] }]))
    expect(r.ok).toBe(true)
  })

  it('kpi takes 2–4 items shaped {value, label}', () => {
    expect(errsOf([{ layout: 'kpi', title: 't', items: [{ value: '1', label: '一' }] }])).toContain('2–4 个')
    expect(errsOf([{ layout: 'kpi', title: 't', items: [{ value: '1' }, { value: '2', label: '二' }] }])).toContain('items[0]')
    expect(parseDeckSpec(okSpec([{ layout: 'kpi', title: 't', items: [{ value: '98.2%', label: '环比' }, { value: '3天', label: '交付' }] }])).ok).toBe(true)
  })

  it('chart: categories/series must line up; pie is single-series and non-negative', () => {
    const col = { type: 'column', categories: ['一', '二', '三'], series: [{ name: '营收', values: [1, 2, 3] }] }
    expect(parseDeckSpec(okSpec([{ layout: 'chart', title: 't', chart: col }])).ok).toBe(true)
    expect(errsOf([{ layout: 'chart', title: 't', chart: { ...col, type: 'scatter' } }])).toContain('column / bar / line / pie')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { ...col, series: [{ name: '营收', values: [1, 2] }] } }])).toContain('长度（2）必须等于 categories 长度（3）')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { ...col, series: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })) } }])).toContain('series 需要 1–4 组')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { ...col, series: [{ name: 'a', values: [1, 'x', 3] }] } }])).toContain('混进了非数字')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { type: 'pie', categories: ['一', '二'], series: [{ name: 'a', values: [1, 2] }, { name: 'b', values: [1, 2] }] } }])).toContain('pie 只吃一组 series')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { type: 'pie', categories: ['一', '二'], series: [{ name: 'a', values: [1, -2] }] } }])).toContain('pie 的 values 不能有负数')
    expect(errsOf([{ layout: 'chart', title: 't', chart: { ...col, categories: Array.from({ length: 13 }, (_, i) => String(i)) } }])).toContain('最多 12')
  })

  it('table rows must match the header shape; 12 rows is the floor plan', () => {
    const t = { layout: 'table', title: 't', header: ['名', '量'], rows: [['甲', '1']] }
    expect(parseDeckSpec(okSpec([t])).ok).toBe(true)
    expect(errsOf([{ ...t, rows: [['甲']] }])).toContain('rows[0] 列数（1）与 header（2）不一致')
    expect(errsOf([{ ...t, rows: [['甲', 12]] }])).toContain('非字符串单元格')
    expect(errsOf([{ ...t, rows: Array.from({ length: 13 }, () => ['甲', '1']) }])).toContain('最多 12 行')
  })

  it('quote needs the quote; image needs a workspace path', () => {
    expect(errsOf([{ layout: 'quote' }])).toContain('（quote）：quote 必填')
    expect(errsOf([{ layout: 'image', title: 't' }])).toContain('（image）：image 必填')
    expect(parseDeckSpec(okSpec([{ layout: 'quote', quote: '结论先行', author: '某人' }])).ok).toBe(true)
    expect(parseDeckSpec(okSpec([{ layout: 'image', image: 'assets/a.png', caption: '图一' }])).ok).toBe(true)
  })

  it('refusals name the slide index so the model can find the page', () => {
    expect(errsOf([{ layout: 'cover', title: 'x' }, { layout: 'bullets', title: 't' }, { layout: 'kpi', title: 't', items: [] }])).toContain('slides[2]')
  })
})

describe('deckImagePaths', () => {
  it('collects image slides with their indexes, skipping other layouts', () => {
    const r = parseDeckSpec(okSpec([
      { layout: 'image', image: 'a.png' },
      { layout: 'bullets', title: 't', bullets: ['x'] },
      { layout: 'image', image: 'b.png', bullets: ['注'] },
    ]))
    expect(r.ok).toBe(true)
    expect(deckImagePaths((r as { ok: true; spec: DeckSpec }).spec)).toEqual([
      { slide: 0, path: 'a.png' },
      { slide: 2, path: 'b.png' },
    ])
  })
})
