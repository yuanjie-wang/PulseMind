// ── wire 上的 max_tokens 钳制（2026-11-22）──
// 病：`effectiveInputWindow` 按 `opts.maxTokens`（×1）留 reserve，而
// `buildRequest` 发的是 `×1.5`。provider 校验 `input + max_tokens ≤ 窗口` 用的是
// **请求里写的**那个数，与实际输出多长无关 —— 所以 0.5× 的缺口在小窗口下会把每
// 条请求都打成 400（实测：50K 窗口 + 32K 上限，切到 17500 的请求仍要 49152 输出）。
//
// 这里钉三件事：宽窗口行为逐字节不变、小窗口钳到刚好装下、以及一条扫描式不变量
// （任何 ctx/price 组合，钳完必须装得下）。最后一条同时钉住「不钳会怎样」——
// 老公式在同一批组合上的违规数是它存在的理由。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_OUTPUT_RESERVE, OUTPUT_HEADROOM, effectiveInputWindow, wireMaxTokens } from '../src/renderer/src/agent/engine/window-budget'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

/** 改动前 wire 上那个数：不加钳的配置值 × 1.5。 */
const naive = (maxTokens: number): number => Math.floor(maxTokens * OUTPUT_HEADROOM)

describe('宽窗口：行为与改动前完全一致', () => {
  it('150K / 32K、冷启动切深价 → 仍是 49152', () => {
    // b = 150000 − 32768 = 117232，target = 0.70b = 82062
    expect(wireMaxTokens(32768, 150000, 82062)).toBe(49152)
    expect(wireMaxTokens(32768, 150000, 82062)).toBe(naive(32768))
  })

  it('200K / 32K 同理', () => {
    expect(wireMaxTokens(32768, 200000, 118000)).toBe(49152)
  })
})

describe('小窗口：钳到刚好装下', () => {
  it('50K / 32K，切到 target 的请求：49152 → 32500，加起来正好一窗', () => {
    const price = 17500
    const wire = wireMaxTokens(32768, 50000, price)
    expect(wire).toBe(32500)
    expect(price + wire).toBe(50000)
    // 老公式在这一版请求上超窗 16652。
    expect(price + naive(32768)).toBeGreaterThan(50000)
  })

  it('50K / 32K，还没切的臃肿请求也钳（恢复前的那一版）', () => {
    expect(wireMaxTokens(32768, 50000, 39900)).toBe(10100)
  })

  it('64K / 32K：49152 → 32000', () => {
    expect(wireMaxTokens(32768, 64000, 32000)).toBe(32000)
  })
})

describe('不变量：钳完一定装得下（扫一遍组合）', () => {
  it('ctx 40K–200K × price 30%–95% → price + wire ≤ ctx', () => {
    const violations: string[] = []
    for (let ctx = 40_000; ctx <= 200_000; ctx += 5_000) {
      for (const share of [0.3, 0.5, 0.7, 0.85, 0.95]) {
        for (const maxTokens of [4096, 8192, 32768, 65536]) {
          const price = Math.round(ctx * share)
          const wire = wireMaxTokens(maxTokens, ctx, price)
          const room = ctx - price
          // 房间小到只够吐几个字时不钳（交 overflow 救援），这条不在断言范围。
          if (room < 1024) continue
          if (price + wire > ctx) violations.push(`ctx=${ctx} price=${price} maxTokens=${maxTokens} → ${wire}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('同一个扫描下，老公式（不钳）会违规 —— 这是钳制存在的理由', () => {
    let oldViolations = 0
    for (let ctx = 40_000; ctx <= 200_000; ctx += 5_000) {
      for (const share of [0.3, 0.5, 0.7, 0.85, 0.95]) {
        const price = Math.round(ctx * share)
        if (price + naive(32768) > ctx) oldViolations++
      }
    }
    // 40K–100K 段几乎全违规；宽窗口段不违规 —— 与「宽窗口无害、小窗口致命」一致。
    expect(oldViolations).toBeGreaterThan(30)
  })
})

describe('兜底路径', () => {
  it('房间不足 1024：不钳，交给 overflow 救援（它会真的截短输入）', () => {
    expect(wireMaxTokens(32768, 50000, 49500)).toBe(49152)
  })

  it('不知道请求多大（缺省/非法）→ 退回不钳的旧行为', () => {
    expect(wireMaxTokens(32768, 50000)).toBe(49152)
    expect(wireMaxTokens(32768, 50000, 0)).toBe(49152)
    expect(wireMaxTokens(32768, 50000, Number.NaN)).toBe(49152)
  })

  it('窗口缺省/非法 → 不钳', () => {
    expect(wireMaxTokens(32768, 0, 40000)).toBe(49152)
    expect(wireMaxTokens(32768, Number.NaN, 40000)).toBe(49152)
  })

  it('输出上限缺省/非法 → 用 DEFAULT_OUTPUT_RESERVE 那个数', () => {
    expect(wireMaxTokens(undefined, 50000, 17500)).toBe(32500)
    expect(wireMaxTokens(0, 50000, 17500)).toBe(32500)
    expect(naive(DEFAULT_OUTPUT_RESERVE)).toBe(49152)
  })
})

describe('输入预算本身没被改小（不为钳制牺牲容量）', () => {
  it('150K / 32K 的 reserve 仍是 ×1', () => {
    expect(effectiveInputWindow(150000, 32768)).toBe(117232)
    expect(effectiveInputWindow(50000, 32768)).toBe(25000)
    // 比例守卫还在：预留不超过半窗。
    expect(effectiveInputWindow(20000, 32768)).toBe(10000)
  })
})

describe('接线：请求构建点用的是钳制后的值', () => {
  const src = read('src/renderer/src/agent/AgentEngine.ts')

  it('buildRequest 走 wireMaxTokens，而不是自己写 1.5', () => {
    expect(src).toContain('wireMaxTokens(opts.maxTokens')
    expect(src).not.toMatch(/maxTokens:\s*Math\.floor\(opts\.maxTokens \* 1\.5\)/)
    expect(src).not.toContain('opts.maxTokens * 1.5')
  })

  it('钳制读的是本版请求已经算好的输入价', () => {
    expect(src).toContain('const requestPrice = this.compactor.copyTokens(finalMessages, fixedOverhead)')
    // 同一份价格还要喂表盘，别算第二遍（两处口径必须同一时刻同一份 copy）。
    expect(src).toMatch(/buildContextWindowSection\(\{ tokens: requestPrice,/)
  })

  it('×1.5 只活在一个地方（window-budget），引擎里不再有第二份', () => {
    const budget = read('src/renderer/src/agent/engine/window-budget.ts')
    expect(budget).toContain('export const OUTPUT_HEADROOM = 1.5')
    expect(budget).not.toContain('writes no `max_tokens` at all')
  })
})
