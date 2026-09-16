// ── 启动球的拖动几何 ─────────────────────────────────────────────────────────
// 用户裁定 2026-09-16：「悬浮球可上下拖动」。拖动本身（指针捕获、松手吞掉那次
// click、存回 storage 再挂载恢复）是时序问题，只在真浏览器里成立，由
// scripts/probe-panel-render.mjs 用真鼠标断言。这里守的是另一半 —— 夹紧区间：
// 区间是按 `.pm-fab` 的尺寸与边距算的，而那两个值同时写在 TS 常量与 CSS 自定义
// 属性里（CSS 要真去画球，TS 要算数学），两处一漂就会变成"球跑出视口"或者"停得
// 离边还有十几像素"——两者都不会报错，只是看着不对。所以这个测试把两者钉在一起。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAB_MARGIN, FAB_SIZE, clampFabTop } from '../src/extension/ui/useFabDrag'

const CSS = readFileSync(join(process.cwd(), 'src/extension/ui/styles.css'), 'utf8')

/** One rule body from the stylesheet, or null when the selector is gone. */
function ruleBody(selector: string): string | null {
  const at = CSS.indexOf(`${selector} {`)
  if (at < 0) return null
  return CSS.slice(at, CSS.indexOf('}', at))
}

/** A custom property's px value from `:host`, as a number. */
function hostLength(name: string): number | null {
  const match = CSS.match(new RegExp(`${name}:\\s*(-?[\\d.]+)px\\s*;`))
  return match ? Number(match[1]) : null
}

describe('clampFabTop', () => {
  it('keeps a value that is already in range', () => {
    expect(clampFabTop(300, 980)).toBe(300)
  })

  it('clamps to the top and bottom margins', () => {
    expect(clampFabTop(-100, 980)).toBe(FAB_MARGIN)
    expect(clampFabTop(5000, 980)).toBe(980 - FAB_SIZE - FAB_MARGIN)
  })

  it('returns whole pixels, so the rendered `top` matches what is persisted', () => {
    expect(clampFabTop(300.4, 980)).toBe(300)
    expect(clampFabTop(300.6, 980)).toBe(301)
  })

  it('keeps a non-empty range in a viewport too short to hold the ball', () => {
    // 50px tall: 50 - 44 - 20 is negative, so the upper bound would sit above the
    // lower one and the ball would be pushed off-screen entirely.
    expect(clampFabTop(999, 50)).toBe(FAB_MARGIN)
    expect(clampFabTop(-999, 50)).toBe(FAB_MARGIN)
    // 100px tall: 36 is still reachable, and is *not* clamped up to the margin.
    expect(clampFabTop(999, 100)).toBe(36)
  })

  it('takes the ball size from the caller when one is given', () => {
    expect(clampFabTop(999, 400, 60)).toBe(400 - 60 - FAB_MARGIN)
  })
})

describe('the ball’s box is written down once', () => {
  // Non-vacuity: these selectors/properties must exist, or every assertion below
  // is a comparison of two nulls.
  it('finds the geometric facts it is about', () => {
    expect(ruleBody('.pm-fab'), 'no .pm-fab rule in styles.css').not.toBeNull()
    expect(hostLength('--pm-fab-size')).not.toBeNull()
    expect(hostLength('--pm-fab-margin')).not.toBeNull()
  })

  it('mirrors the TS constants in :host', () => {
    // These are the two numbers clampFabTop does arithmetic on.
    expect(hostLength('--pm-fab-size')).toBe(FAB_SIZE)
    expect(hostLength('--pm-fab-margin')).toBe(FAB_MARGIN)
  })

  it('draws the ball from those variables and leaves the position to the drag', () => {
    const fab = ruleBody('.pm-fab') ?? ''
    expect(fab).toMatch(/width:\s*var\(--pm-fab-size\)/)
    expect(fab).toMatch(/height:\s*var\(--pm-fab-size\)/)
    expect(fab).toMatch(/right:\s*var\(--pm-fab-margin\)/)
    // The drag writes these two; the stylesheet only supplies the resting state.
    expect(fab).toMatch(/top:\s*var\(--pm-fab-top\)/)
    expect(fab).toMatch(/bottom:\s*var\(--pm-fab-bottom\)/)
    expect(fab).toMatch(/cursor:\s*grab/)
    // A touch drag must not scroll the page under it.
    expect(fab).toMatch(/touch-action:\s*none/)
  })

  it('never animates the position — the ball has to track the pointer', () => {
    // The transition list is transform/background only. Adding `top` here would
    // turn the drag into a lagging tween, which reads as "the ball is stuck to a
    // spring" and is invisible in the source until you try it.
    const fab = ruleBody('.pm-fab') ?? ''
    const transition = fab.slice(fab.indexOf('transition:'))
    expect(transition).not.toMatch(/\btop\b/)
    expect(transition).not.toMatch(/\bbottom\b/)
    expect(transition).toMatch(/transform/)
  })
})
