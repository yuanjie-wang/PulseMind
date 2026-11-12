// @vitest-environment jsdom
/** tab.readText 的正文检测与预算切页（2026-11-12）。
 *
 *  pulsemindReadText 是自包含的页面端函数（无 import/闭包，page.evaluate
 *  序列化进页面跑），所以 jsdom 里直接调用就是真实路径——同一份代码既进
 *  页面也进测试。四层策略（selector / semantic / density / body）与预算
 *  切页逐一钉死；jsdom 的 innerText 缺失/退化路径也顺带被 visibleTextOf
 *  的 textContent 回落覆盖。 */

import { describe, expect, it } from 'vitest'
import { pulsemindReadText } from '../src/shared/browser-client/read-text'

function mount(html: string): void {
  document.body.innerHTML = html
}

const ARTICLE_HTML = (body: string): string =>
  `<nav><a href="#1">导航一</a><a href="#2">导航二</a><a href="#3">导航三</a></nav>
   <article>${body}</article>
   <footer>页脚信息</footer>`

describe('serialization self-containment (the page.evaluate contract)', () => {
  it('the function source runs standalone — module helpers are invisible on the page', () => {
    // page.evaluate(fn) ships ONLY fn.toString() to the page (minified by the
    // main bundle's esbuild pass). The first cut referenced module-scope
    // helpers and died there with `ReferenceError: wA is not defined`; the
    // in-module jsdom calls above could never see that break. Indirect eval
    // reproduces the page realm exactly: global scope only, no module imports.
    const revived = (0, eval)(`(${pulsemindReadText.toString()})`) as typeof pulsemindReadText
    mount(ARTICLE_HTML(`<p>${'序列化正文检测，这段要足够长以跨过语义门槛。'.repeat(10)}</p>`))

    const r = revived({})
    expect(r.strategy).toBe('semantic')
    expect(r.text).toContain('序列化正文检测')

    const picked = revived({ selector: 'article' })
    expect(picked.strategy).toBe('selector')
    expect(picked.text).not.toContain('页脚信息')
  })
})

describe('pulsemindReadText strategy ladder', () => {
  it('selector mode reads exactly that container and fails loudly on a miss', () => {
    mount('<ul class="results"><li>结果一</li><li>结果二</li></ul><p>页外的散文</p>')

    const r = pulsemindReadText({ selector: 'ul.results' })
    expect(r.strategy).toBe('selector')
    expect(r.text).toContain('结果一')
    expect(r.text).not.toContain('页外的散文')

    expect(() => pulsemindReadText({ selector: '.nope' })).toThrow(/没有元素匹配/)
  })

  it('semantic candidates win: article/[role=main]/main with substantial text', () => {
    // Enough text to clear the 120-char substantial bar — a real article body.
    const body = `<p>${'这是一段足够长的正文，用来跨过最小文本门槛，密度策略不应该被触发。'.repeat(6)}</p>`
    mount(ARTICLE_HTML(body))

    const r = pulsemindReadText({})
    expect(r.strategy).toBe('semantic')
    expect(r.text).toContain('足够长的正文')
    // The page chrome (nav/footer) is OUTSIDE the chosen container.
    expect(r.text).not.toContain('页脚信息')
  })

  it('density fallback picks the largest own-text block; boilerplate and link-heavy wrappers lose', () => {
    // No article/main: a content block plus a link-heavy nav wrapper whose raw
    // text is long. The link-density penalty must keep the wrapper from winning.
    mount(
      `<nav>${Array.from({ length: 30 }, (_, i) => `<a href="#${i}">菜单项${i}</a>`).join('')}</nav>
       <div id="content"><p>${'正文句子。'.repeat(40)}</p></div>`,
    )

    const r = pulsemindReadText({})
    expect(r.strategy).toBe('density')
    expect(r.text).toContain('正文句子')
    expect(r.text).not.toContain('菜单项')
  })

  it('script/style text never counts toward density scoring', () => {
    mount(`<style>${'.x'.repeat(200)}{color:red}</style><div id="content"><p>${'真正的正文。'.repeat(30)}</p></div>`)

    const r = pulsemindReadText({})
    expect(r.text).toContain('真正的正文')
    expect(r.text).not.toContain('color:red')
  })

  it('a stub page falls through to body', () => {
    mount('<p>短页</p>')
    const r = pulsemindReadText({})
    expect(r.strategy).toBe('body')
    expect(r.text).toContain('短页')
  })
})

describe('pulsemindReadText budget paging', () => {
  it('budget slices and reports totalChars/truncated; offset continues where it stopped', () => {
    const long = '字'.repeat(500)
    mount(`<article>${long}</article>`)

    // The clamp floors budget at 200, so page with 300-char steps.
    const first = pulsemindReadText({ budget: 300 })
    expect(first.text.length).toBe(300)
    expect(first.totalChars).toBe(500)
    expect(first.truncated).toBe(true)

    const second = pulsemindReadText({ budget: 300, offset: 300 })
    expect(second.text).toBe('字'.repeat(200))
    expect(second.truncated).toBe(false)
    expect(first.text + second.text).toBe(long)
  })

  it('budget is clamped off the floor: a 1-char ask still reads a usable window (≥200)', () => {
    mount(`<article>${'字'.repeat(500)}</article>`)
    // The clamp lifts budget 1 to the 200-char floor — a 1-char slice would be
    // an unusable page-per-call.
    const r = pulsemindReadText({ budget: 1 })
    expect(r.text.length).toBe(200)
    expect(r.truncated).toBe(true)
  })
})
