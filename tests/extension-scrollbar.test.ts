// 扩展面板的滚动条契约（2026-11-23 跟进主应用同日裁定）。
//
// 面板挂在 closed shadow root（content/index.tsx 的 attachShadow），读不到应用
// index.html 的全局 `*` 规则，所以 styles.css 自己写了一份 6px 的
// ::-webkit-scrollbar —— 而自定义条由主线程绘制，Chromium 的线程化滚动（面板
// 跑在 Chrome 里，触控板同样走这条路）在合成器线程推进偏移、手势期间不重绘该
// 层，拇指会冻结到松手才一跳归位。实测与完整结论见 src/renderer/index.html 的
// 滚动条注释与 tests/routine-prompt-sizing.test.ts 的滚动条组。
//
// 现行契约同主应用：只用标准属性（合成器绘制），不得再出现自定义条
// （唯一例外 = display:none 的无条容器，那里没有拇指可跟）。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const css = readFileSync(join(ROOT, 'src/extension/ui/styles.css'), 'utf-8')

describe('扩展面板滚动条：原生绘制', () => {
  it('* 上声明标准属性（scrollbar-width 不继承，必须落在 *）', () => {
    expect(css).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/)
    expect(css).toMatch(/\*\s*\{[^}]*scrollbar-color:\s*rgba\(128,\s*128,\s*128,[^)]*\)\s*transparent/)
  })

  it('不再有任何自定义滚动条（display:none 的隐藏条除外）', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const offenders: string[] = []
    for (const m of code.matchAll(/::-webkit-scrollbar(?![-\w])[^{]*\{([^}]*)\}/g)) {
      if (!/display:\s*none/.test(m[1])) offenders.push(m[0].slice(0, 60))
    }
    // 只写 ::-webkit-scrollbar-thumb 之类而不写基类同样进自定义模式。
    if (/::-webkit-scrollbar-(thumb|track|button|corner)/.test(code)) {
      offenders.push('::-webkit-scrollbar-* 子伪元素')
    }
    expect(offenders).toEqual([])
  })
})
