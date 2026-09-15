// @vitest-environment jsdom
/** Page DOM pipeline + `page_*` executors (PLAN-browser-extension M2.1/M2.3).
 *
 * Ported from Anywhere's `test/dom-tree.test.ts` and extended to cover what the
 * port changed: our own panel host is excluded (via attribute, not id prefix),
 * the node cap is reported, and clicks dispatch a real pointer/mouse sequence.
 *
 * jsdom has no layout engine, so `hasLayout` fails and every geometry check is
 * skipped — the heuristics are exercised, the geometry is not. That gap is
 * exactly why the manual acceptance run against a real Chrome stays in the
 * milestone's checklist. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_NODES, buildDomTree } from '../src/extension/content/page-tree'
import {
  invalidateSelectorMap,
  pageBack,
  pageClick,
  pageGetContent,
  pageInput,
  pageSelect,
  pageWait,
  runPageTool,
} from '../src/extension/content/page-tools'
import { isCspEvalError, normalizeFunctionBody, serializeResult } from '../src/extension/content/page-js'

function mount(html: string): void {
  document.body.innerHTML = html
}

/** `page_get_content` caches the index map for the *current* URL; tests that
 *  act on indices must refresh it after touching the DOM. */
function look(): string {
  return pageGetContent({})
}

describe('page-tree', () => {
  beforeEach(() => {
    mount('')
    invalidateSelectorMap()
  })

  it('numbers interactive elements and exposes the selectorMap', () => {
    mount('<div><button id="b1">保存</button><input id="i1" type="text" placeholder="搜索"/><span>静态文本</span></div>')
    const { text, selectorMap } = buildDomTree(document)

    expect(text).toContain('[1]<button')
    expect(text).toContain('保存')
    expect(text).toContain('placeholder=搜索')
    expect(selectorMap.get(1)?.id).toBe('b1')
    expect(selectorMap.size).toBeGreaterThanOrEqual(2) // the input counts too
  })

  it('skips script/svg and aria-hidden subtrees', () => {
    mount('<svg><circle/></svg><script>alert(1)</script><div aria-hidden="true"><button>x</button></div><button id="ok">go</button>')
    const { text, selectorMap } = buildDomTree(document)

    expect(text).not.toContain('<script')
    expect(text).not.toContain('<svg')
    expect(text).not.toContain('aria-hidden')
    for (const el of selectorMap.values()) expect(el.id).toBe('ok')
  })

  it('excludes the panel host itself and everything inside its shadow root', () => {
    mount('<button id="real">真按钮</button>')
    const host = document.createElement('div')
    host.setAttribute('data-pulsemind-panel', '')
    const shadow = host.attachShadow({ mode: 'open' })
    const fab = document.createElement('button')
    fab.textContent = '面板按钮'
    shadow.appendChild(fab)
    document.body.appendChild(host)

    const { text, selectorMap } = buildDomTree(document)
    expect(text).not.toContain('面板按钮')
    for (const el of selectorMap.values()) expect(el.id).toBe('real')
  })

  it('marks elements that were not on the page during the previous look', () => {
    mount('<button id="a">A</button>')
    const first = buildDomTree(document)
    expect(first.text).toContain('[1]<button')
    expect(first.text).toContain('*[1]') // nothing was known before this build

    // A second look with an unchanged page shows no asterisks.
    const second = buildDomTree(document)
    expect(second.text).not.toContain('*[')

    document.body.insertAdjacentHTML('beforeend', '<button id="b">B</button>')
    const third = buildDomTree(document)
    expect(third.text).toContain('*[2]')
    expect(third.text).toContain('[1]<button')
  })

  it('caps the walked node count and says so instead of silently truncating', () => {
    const chunks: string[] = []
    for (let i = 0; i < MAX_NODES + 200; i++) chunks.push(`<span>n${i}</span>`)
    mount(chunks.join(''))

    const { truncated, text } = buildDomTree(document)
    expect(truncated).toBe(true)
    expect(text).toContain(`节点数超过 ${MAX_NODES}`)
    expect(text).toContain('page_scroll')
  })

  it('reports scroll position, page size and a fallback hint when nothing is numbered', () => {
    mount('<div>只有一个元素</div>')
    const { text } = buildDomTree(document)
    expect(text).toContain('Current Page:')
    expect(text).toContain('Page info:')
    expect(text).toContain('[Start of page]')
    expect(text).toContain('[End of page]')
  })
})

/** The rest of the jsdom suite runs with `hasLayout()` failing, i.e. every
 *  geometry check short-circuits. Stubbing just the probe (`offsetWidth`) and
 *  client rects turns the geometry path back on, which pins the two defects the
 *  real-browser probe found (M2.6) as fast unit tests. */
describe('page-tree geometry', () => {
  /** Rects are declared per id (or tag for html/body); anything else gets a
   *  plain in-viewport box. jsdom implements neither `elementFromPoint` nor
   *  layout, so both have to be supplied. */
  function stubLayout(rects: Record<string, [number, number, number, number]>): void {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const key = this.id || this.tagName.toLowerCase()
      const [x, y, width, height] = rects[key] ?? [0, 0, 100, 20]
      return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
    })
  }

  function stubHitTest(fn: (x: number, y: number) => Element | null): void {
    Object.defineProperty(document, 'elementFromPoint', { value: fn, configurable: true, writable: true })
  }

  beforeEach(() => {
    mount('')
    invalidateSelectorMap()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (document as unknown as Record<string, unknown>).elementFromPoint
  })

  it('walks past a zero-height container whose children are absolutely positioned', () => {
    // Every child of <html> absolute → <html>/<body> collapse to height 0.
    // Pruning the walk on that alone once made such pages read as empty.
    mount('<button id="btn">可见按钮</button>')
    stubLayout({ html: [0, 0, 900, 0], body: [0, 0, 900, 0], btn: [30, 260, 69, 25] })

    const { text, selectorMap } = buildDomTree(document)

    expect(text).toContain('[1]<button id=btn')
    expect(text).toContain('可见按钮')
    expect(selectorMap.get(1)?.id).toBe('btn')
  })

  it('numbers a control inside a shadow root whose host is what gets hit-tested', () => {
    mount('<my-widget id="widget"></my-widget>')
    const widget = document.getElementById('widget') as HTMLElement
    const shadow = widget.attachShadow({ mode: 'open' })
    const btn = document.createElement('button')
    btn.id = 'shadow-btn'
    btn.textContent = '影子按钮'
    shadow.appendChild(btn)
    stubLayout({ widget: [30, 520, 69, 25], 'shadow-btn': [30, 520, 69, 25] })

    // `elementFromPoint` never reports shadow content: it returns the host, and
    // the host is the *ancestor* of the button, so a containment test alone can
    // never accept it.
    stubHitTest(() => widget)
    Object.defineProperty(shadow, 'elementFromPoint', { value: () => btn, configurable: true })

    const { text, selectorMap } = buildDomTree(document)

    expect(text).toContain('[1]<button id=shadow-btn')
    expect(selectorMap.get(1)).toBe(btn)
  })

  it('still withholds a number from a control under a covering overlay', () => {
    mount('<div id="overlay"></div><button id="covered">被遮挡按钮</button>')
    stubLayout({ overlay: [0, 0, 900, 120], covered: [30, 60, 69, 25] })
    stubHitTest(() => document.getElementById('overlay'))

    const { text } = buildDomTree(document)

    expect(text).not.toMatch(/\[\d+\]<button[^>]*id=covered/)
  })

  it('numbers only the in-viewport controls but returns the whole page text', () => {
    mount('<button id="top">顶部按钮</button><button id="below">折叠下方按钮</button>')
    stubLayout({ top: [0, 100, 69, 25], below: [0, 2400, 69, 25] })
    // Outside the viewport nothing is hit-testable; inside, the element itself.
    stubHitTest((_x, y) => (y > 700 ? null : document.getElementById('top')))
    // jsdom reports a zero-height document, which would otherwise suppress the
    // scroll-for-an-index hint the last assertion is about.
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3000, configurable: true })

    const { text } = buildDomTree(document)

    expect(text).toMatch(/\[\d+\]<button[^>]*id=top/)
    expect(text).not.toMatch(/\[\d+\]<button[^>]*id=below/)
    // The prose still arrives, so "总结这个页面" needs one read, not one per screen.
    expect(text).toContain('折叠下方按钮')
    expect(text).toContain('page_scroll')
  })
})

describe('page-tools', () => {
  beforeEach(() => {
    mount('')
    invalidateSelectorMap()
  })

  it('renders a compact text view and then acts on the returned indices', () => {
    mount('<button id="b">点我</button>')
    const text = look()
    expect(text).toContain('点我')

    let clicked = 0
    document.getElementById('b')!.addEventListener('click', () => {
      clicked += 1
    })
    expect(pageClick({ index: 1 })).toContain('已点击')
    expect(clicked).toBe(1)
  })

  it('dispatches the full pointer/mouse sequence before the real click', () => {
    mount('<button id="d">target</button>')
    look()
    const el = document.getElementById('d')!
    const seen: string[] = []
    for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      el.addEventListener(name, () => seen.push(name))
    }
    pageClick({ index: 1 })

    // Pointer events are absent in jsdom, so only the mouse part is observable
    // here; the ordering is what matters.
    expect(seen).toEqual(['mousedown', 'mouseup', 'click'])
  })

  it('refuses an index that was never issued, with an actionable message', () => {
    mount('<button id="b">x</button>')
    look()
    expect(() => pageClick({ index: 99 })).toThrow(/page_get_content/)
    expect(() => pageClick({ index: 0 })).toThrow(/无效的元素索引/)
  })

  it('drops indices when the page navigated (selectorMap is per URL)', () => {
    mount('<button id="b">x</button>')
    look()
    // A different URL invalidates the cache the indices came from.
    vi.spyOn(window, 'location', 'get').mockReturnValue({ href: 'https://elsewhere.test/' } as Location)
    expect(() => pageClick({ index: 1 })).toThrow(/索引 1 不存在或已失效/)
    vi.restoreAllMocks()
  })

  it('types through the native setter and fires input/change (React controlled inputs)', () => {
    mount('<input id="q" type="text"/>')
    look()
    const input = document.getElementById('q') as HTMLInputElement
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))

    expect(pageInput({ index: 1, text: 'hello' })).toContain('5 个字符')
    expect(input.value).toBe('hello')
    expect(events).toEqual(['input', 'change'])
  })

  it('refuses to type into a non-editable element', () => {
    mount('<button id="b">x</button>')
    look()
    expect(() => pageInput({ index: 1, text: 'hi' })).toThrow(/不是可输入元素/)
  })

  it('selects an option by value, text or label and lists the options when it misses', () => {
    mount('<select id="s"><option value="a">苹果</option><option value="b" label="香蕉">banana</option></select>')
    look()
    const select = document.getElementById('s') as HTMLSelectElement

    expect(pageSelect({ index: 1, option: '苹果' })).toContain('苹果')
    expect(select.value).toBe('a')
    expect(pageSelect({ index: 1, option: 'b' })).toContain('banana')
    expect(select.value).toBe('b')

    expect(() => pageSelect({ index: 1, option: '不存在' })).toThrow(/苹果.*banana/s)
  })

  it('waits the requested number of seconds, clamped to 1–10', async () => {
    vi.useFakeTimers()
    const p = pageWait({ seconds: 99 })
    const assertion = expect(p).resolves.toContain('已等待 10s')
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    vi.useRealTimers()
  })

  it('goes back through history', () => {
    const back = vi.spyOn(history, 'back').mockImplementation(() => {})
    expect(pageBack()).toContain('history.back()')
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })

  it('runs page JS for all three accepted shapes and reports empty input', async () => {
    mount('<div id="d">hi</div>')
    const ok = (script: string): Promise<{ ok: boolean; result?: string; error?: string }> =>
      runPageTool('page_execute_js', { script })

    await expect(ok('() => { return 1 + 2 }')).resolves.toMatchObject({ ok: true, result: '3' })
    await expect(ok('() => document.getElementById("d").textContent')).resolves.toMatchObject({ ok: true, result: 'hi' })
    await expect(ok('() => ({ a: 1 })')).resolves.toMatchObject({ ok: true, result: '{\n  "a": 1\n}' })
    await expect(ok('return "bare"')).resolves.toMatchObject({ ok: true, result: 'bare' })
    await expect(ok('')).resolves.toMatchObject({ ok: false, error: 'script 参数不能为空' })
  })

  it('passes args through to the evaluated script', async () => {
    const res = await runPageTool('page_execute_js', { script: '() => args.n * 2', args: { n: 21 } })
    expect(res).toMatchObject({ ok: true, result: '42' })
  })

  it('flags a CSP eval refusal so the worker can retry over CDP, and fails unknown tools', async () => {
    const blocked = await runPageTool('page_execute_js', {
      script: '() => { throw new Error("Refused to evaluate a string as JavaScript because unsafe-eval") }',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.cspEvalBlocked).toBe(true)

    await expect(runPageTool('page_nope', {})).resolves.toMatchObject({ ok: false, error: '未知页面工具: page_nope' })
  })
})

describe('page-js helpers', () => {
  it('normalizes the three accepted shapes and serializes results', () => {
    expect(normalizeFunctionBody('return 1')).toBe('return 1')
    expect(normalizeFunctionBody('() => { return 1 }')).toBe(' return 1 ')
    expect(normalizeFunctionBody('() => 1 + 1')).toBe('return (1 + 1)')
    expect(normalizeFunctionBody('async () => { await x() }')).toBe(' await x() ')

    expect(serializeResult(undefined)).toBe('undefined')
    expect(serializeResult('raw')).toBe('raw')
    expect(serializeResult({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('recognizes the CSP wording Chrome and Edge both use', () => {
    expect(isCspEvalError('Refused to evaluate a string as JavaScript because unsafe-eval')).toBe(true)
    expect(isCspEvalError("EvalError: call to Function() blocked by CSP")).toBe(false)
    expect(isCspEvalError('something else entirely')).toBe(false)
  })
})
