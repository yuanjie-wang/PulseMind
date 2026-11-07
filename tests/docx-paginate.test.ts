/**
 * docx-preview 分页的拟合数学（2026-11-04，用户报「md 导出的 pdf 还是比较丑」）。
 *
 * 根因不在样式而在分页：docx-preview 没有排版引擎，docx 自带的断页提示
 * （w:br type=page / pageBreakBefore / w:lastRenderedPageBreak）之外一律不换页，
 * 我们生成的 docx 一个提示都没有 → 一页连续长纸，printToPDF 自己的分页器按
 * 任意 y 切片、完全无视 docx 页边距（实测首页文字距纸边 13pt、第二页顶端只留
 * 1.3pt）。
 *
 * 页内拟合也不能用 `last.bottom - first.top`：换页会让**首块的上外边距**不再与
 * 上一兄弟塌陷（被页 padding 容纳），而**末块的下外边距**依旧占位——漏掉任一条，
 * 一组块会量成「装得下」却溢出页盒恰好这么多（实测 21.5px）。纯函数在这里，
 * 断言才不依赖 jsdom（无布局引擎，几何检查全部短路）。
 */
import { describe, expect, it } from 'vitest'
import { planDocxPages, type DocxPageBlock } from '../src/renderer/src/components/preview/docx-paginate'

const block = (top: number, bottom: number, extra: Partial<DocxPageBlock> = {}): DocxPageBlock => ({
  top,
  bottom,
  marginTop: 0,
  marginBottom: 0,
  keepWithNext: false,
  ...extra,
})

/** Every block must land on exactly one page, in document order. */
const flat = (pages: number[][]): number[] => pages.flat()
const contiguous = (pages: number[][]): boolean => {
  const all = flat(pages)
  return all.length === 0 || all.every((v, i) => v === i)
}

describe('planDocxPages — 页盒拟合', () => {
  it('恰好填满的一页不拆（等号不算溢出）', () => {
    const pages = planDocxPages([block(0, 40), block(40, 100)], 100)
    expect(pages).toEqual([[0, 1]])
  })

  it('首块的上外边距计入组高（旧拟合在这里少算，页盒溢出）', () => {
    // 旧算法 last.bottom - first.top = 95 ≤ 100 判「装得下」；真实占位
    // = 0（首块无上边距）+ 95 + 10（末块下边距）= 105。
    const a = block(0, 70)
    const b = block(80, 95, { marginTop: 10, marginBottom: 10 })
    expect(planDocxPages([a, b], 100)).toEqual([[0], [1]])
    // 同一组块若 b 起新页，它自己的上边距 + 高度 = 10 + 15 + 10 = 35 ≤ 100
    expect(planDocxPages([a, b], 106)).toEqual([[0, 1]])
  })

  it('末块的下外边距计入组高', () => {
    const a = block(0, 60)
    const b = block(60, 95, { marginBottom: 20 })
    // 0 + 95 + 20 = 115 > 100；没有下边距时 95 装得下。
    expect(planDocxPages([a, b], 100)).toEqual([[0], [1]])
    expect(planDocxPages([a, block(60, 95)], 100)).toEqual([[0, 1]])
  })

  it('溢出点落在标题后时，标题被带到下一页而不是孤悬页尾', () => {
    const a = block(0, 60)
    const heading = block(60, 80, { keepWithNext: true })
    const b = block(80, 130)
    expect(planDocxPages([a, heading, b], 100)).toEqual([[0], [1, 2]])
  })

  it('连续标题整串被带走', () => {
    const a = block(0, 40)
    const h1 = block(40, 60, { keepWithNext: true })
    const h2 = block(60, 80, { keepWithNext: true })
    const b = block(80, 120)
    expect(planDocxPages([a, h1, h2, b], 100)).toEqual([[0], [1, 2, 3]])
  })

  it('标题是本页首块时不带走（否则两个连续标题会互相推挤到无穷）', () => {
    const heading = block(0, 80, { keepWithNext: true })
    const b = block(80, 130)
    expect(planDocxPages([heading, b], 100)).toEqual([[0], [1]])
  })

  it('单块高于一页时独占一页溢出，不进一步切分（段落不可切）', () => {
    expect(planDocxPages([block(0, 300)], 100)).toEqual([[0]])
    expect(planDocxPages([block(0, 300), block(300, 320)], 100)).toEqual([[0], [1]])
  })

  it('空输入与非法页高返回空计划', () => {
    expect(planDocxPages([], 100)).toEqual([])
    expect(planDocxPages([block(0, 10)], 0)).toEqual([])
    expect(planDocxPages([block(0, 10)], -5)).toEqual([])
  })

  it('页计划覆盖全部块且保序', () => {
    const blocks = Array.from({ length: 25 }, (_, i) => block(i * 30, i * 30 + 28, { marginBottom: 2 }))
    const pages = planDocxPages(blocks, 200)
    expect(pages.length).toBeGreaterThan(1)
    expect(flat(pages).length).toBe(blocks.length)
    expect(contiguous(pages)).toBe(true)
  })
})
