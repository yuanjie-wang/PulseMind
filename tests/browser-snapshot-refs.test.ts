// @vitest-environment jsdom
/** Snapshot ref addressing (page_* 哲学 on the browser tool).
 *
 *  domSnapshot() now numbers the page's interactive elements and tags each
 *  with data-pm-ref; the model addresses them as bare numbers through
 *  tab.playwright(N, op). jsdom covers the walk's heuristics (it has a DOM but
 *  no layout engine — checkVisibility is missing, so the hidden-element filter
 *  degrades to pass-through here and is pinned against a real engine in the
 *  live section at the bottom). The stale fast-fail and the recovery-hint
 *  decoration are pinned against a fake locator, which is exactly honest: both
 *  behaviors are about which error TEXT reaches the model, not about geometry.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import { refPassSource, MAX_REF_ELEMENTS, combineDomSnapshot, takeDomSnapshot, nextSnapshotGeneration } from '../src/main/browser/snapshot-refs'
import { serializeResult } from '../src/shared/browser-client/serialize'
import { runPlaywrightOp } from '../src/main/browser/PlaywrightCommands'
import { createBrowserFacade } from '../src/shared/browser-client/facade'
import { playwrightSugar } from '../src/shared/browser-client/playwright-sugar'
import { PM_REF_ATTR, PM_REF_RECOVERY_HINT, isPmRefSelector, pmRefNumberOf, pmRefSelector } from '../src/shared/browser-client/pm-refs'

function mount(html: string): void {
  document.body.innerHTML = html
}

/** The pass ships as serialized source and runs in the page realm against
 *  globalThis.document — run it exactly that way (refPassSource builds the
 *  self-invoking expression; the Function constructor needs the explicit
 *  `return`, or the IIFE's value is discarded like any statement). */
function runPass(input: { mode: 'collect' | 'verify'; gen: number; n?: string }): unknown {
  return new Function(`return ${refPassSource(input)}`)() as unknown
}
function collectRefs(gen = 1): string[] {
  return runPass({ mode: 'collect', gen }) as string[]
}
/** The stamped value shape: s<gen>:<sig>:<n>. */
function expectCarries(el: Element | null, gen: number, n: number): void {
  const value = el?.getAttribute(PM_REF_ATTR) ?? ''
  expect(new RegExp(`^s${gen}:[0-9a-z]{7}:${n}$`).test(value), `got "${value}"`).toBe(true)
}

describe('snapshot refs walk', () => {
  beforeEach(() => mount(''))
  afterEach(() => {
    // tags leak across mounts via head leftovers; jsdom document is per-file anyway
    mount('')
  })

  it('numbers interactive elements in document order, with role/name/tag facts', () => {
    mount(`
      <input id="kw" placeholder="百度一下,你就知道">
      <input id="su" type="submit" value="百度一下">
      <button id="login">登 录</button>
      <a href="/more">更多</a>
      <select id="cat"><option value="1">新闻</option></select>
      <div id="plain">不是可交互元素</div>
    `)
    const lines = collectRefs()

    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('[1] textbox "百度一下,你就知道" (input#kw, placeholder=百度一下,你就知道)')
    // a submit input reads as a button, not a textbox — its YAML role is button too
    expect(lines[1]).toBe('[2] button "百度一下" (input#su, type=submit)')
    expect(lines[2]).toBe('[3] button "登 录" (button#login)')
    expect(lines[3]).toBe('[4] link "更多" (a)')
    expect(lines[4]).toContain('[5] combobox')
    // every listed element carries its tag for resolution
    expectCarries(document.querySelector('#kw'), 1, 1)
    expectCarries(document.querySelector('#login'), 1, 3)
    // the plain div is neither numbered nor tagged
    expect(document.querySelector('#plain')!.getAttribute(PM_REF_ATTR)).toBeNull()
  })

  it('skips input[type=hidden] and numbers label[for] + inline-click divs', () => {
    mount(`
      <input type="hidden" id="csrf" value="x">
      <label for="u">用户名</label><input id="u">
      <div onclick="void 0" id="clicky">点我</div>
    `)
    const lines = collectRefs()
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('label')
    expect(lines[0]).toContain('用户名')
    expect(document.querySelector('#csrf')!.getAttribute(PM_REF_ATTR)).toBeNull()
    expectCarries(document.querySelector('#clicky'), 1, 3)
  })

  it('strips page-forged data-pm-ref attributes before numbering (untrusted page)', () => {
    mount('<div data-pm-ref="999" id="forged">伪造引用</div><button id="real">真按钮</button>')
    const lines = collectRefs()
    // the forged tag is gone, the forged element is not in the list, and the
    // real button owns [1] — a page cannot pre-seed addressing
    expect(document.querySelector('#forged')!.getAttribute(PM_REF_ATTR)).toBeNull()
    expect(lines.join('\n')).not.toContain('999')
    expect(lines[0]).toContain('[1] button "真按钮"')
  })

  it('descends into open shadow roots (Playwright CSS pierces them, so refs resolve)', () => {
    mount('<my-widget></my-widget>')
    const host = document.querySelector('my-widget')!
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>影子按钮</button>'
    const lines = collectRefs()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('影子按钮')
    expectCarries(host.shadowRoot!.querySelector('button'), 1, 1)
  })

  // M11 (review 2026-09-18): the fast-fail used to be `count() === 0` only —
  // a framework that REUSES the DOM node keeps the attribute, so the next
  // action landed on whatever content now occupies the ref, silently. The
  // content signature inside the value is what turns that into a hard fail.
  it('verify flags a REUSED node: attribute intact, content swapped', () => {
    mount('<div><button id="a">加入购物车 (2)</button><button id="b">结算</button></div>')
    collectRefs(1)
    // React key reuse: the SAME node now shows different content.
    const a = document.querySelector('#a')!
    a.textContent = '加入购物车 (3)'
    const verdict = runPass({ mode: 'verify', gen: 1, n: '1' }) as { status: string; detail: string }
    expect(verdict.status).toBe('changed')
    // ...while the untouched second ref still verifies
    expect((runPass({ mode: 'verify', gen: 1, n: '2' }) as { status: string }).status).toBe('ok')
  })

  it('verify flags a ref whose value is from an older generation (strip-miss survivor)', () => {
    mount('<button id="a">按钮</button>')
    collectRefs(1)
    // A tag the strip pass could not reach (here: simulated by hand-writing
    // an old-generation value, e.g. a node that moved behind a closed shadow root).
    document.querySelector('#a')!.setAttribute(PM_REF_ATTR, 's1:abc0000:1')
    collectRefs(2) // re-stamps to gen 2; hand-write the survivor back
    document.querySelector('#a')!.setAttribute(PM_REF_ATTR, 's1:abc0000:1')
    const verdict = runPass({ mode: 'verify', gen: 2, n: '1' }) as { status: string; detail: string }
    expect(verdict.status).toBe('stale')
  })

  it('verify: missing for a number nothing carries; ok needs the current generation', () => {
    mount('<button id="a">按钮</button>')
    collectRefs(3)
    expect(((runPass({ mode: 'verify', gen: 3, n: '9' })) as { status: string }).status).toBe('missing')
    // gen 0 (never snapshotted) can never verify — the error path says re-snapshot
    expect(((runPass({ mode: 'verify', gen: 0, n: '1' })) as { status: string }).status).toBe('stale')
    expectCarries(document.querySelector('#a'), 3, 1)
    expect(((runPass({ mode: 'verify', gen: 3, n: '1' })) as { status: string }).status).toBe('ok')
  })

  it('refPassSource refuses a non-digit n (the source embeds its input)', () => {
    expect(() => refPassSource({ mode: 'verify', gen: 1, n: '1); alert(1' })).toThrow(/digits/)
  })

  it(`caps numbering at ${MAX_REF_ELEMENTS} and says so instead of silently truncating`, () => {
    mount(Array.from({ length: MAX_REF_ELEMENTS + 5 }, (_, i) => `<button data-i="${i}">b${i}</button>`).join(''))
    const lines = collectRefs()
    expect(lines).toHaveLength(MAX_REF_ELEMENTS + 1)
    expect(lines[MAX_REF_ELEMENTS]).toContain('仅编号前')
    expect(document.querySelector(`[${PM_REF_ATTR}$=" :201"],[${PM_REF_ATTR}$=":201"]`)).toBeNull()
  })
})

describe('combineDomSnapshot', () => {
  it('leads with the numbered section and its addressing instructions, YAML after', () => {
    const out = combineDomSnapshot('- button "登录"', ['[1] button "登录" (button#l)'])
    expect(out.startsWith('── 交互元素编号 [N] ──')).toBe(true)
    expect(out).toContain('tab.playwright(N, op, arg)')
    expect(out).toContain('重新 domSnapshot()')
    expect(out).toContain('[1] button "登录" (button#l)')
    // The order is the contract, not a detail: refs must come BEFORE the tree.
    expect(out.indexOf('[1] button "登录"')).toBeLessThan(out.indexOf('- button "登录"'))
    expect(out).toContain('── 页面结构（ARIA）──')
  })

  it('keeps the index inside the head that every cap on this path preserves', () => {
    // The report this pins (2026-09-17): every byte was there, but the list rode a
    // 5.6KB YAML's tail — past the chat card's 300px window, and past the head every
    // truncation keeps. A snapshot's numbered index has to survive both.
    const yaml = Array.from({ length: 400 }, (_, i) => `  - paragraph: 段落 ${i}`).join('\n')
    const out = combineDomSnapshot(yaml, ['[1] link "新闻" (a)', '[2] textbox "搜索" (input#kw)'])
    expect(out.indexOf('[1] link')).toBeLessThan(200) // i.e. within the first visible lines
    expect(out.slice(0, 200)).toContain('[2] textbox')
    const capped = serializeResult(out, 1024)
    expect(capped.truncated).toBe(true)
    expect(capped.text).toContain('[1] link "新闻" (a)')
    expect(capped.text).not.toContain('段落 399') // the tail is what got cut
  })

  it('returns the YAML untouched when nothing is interactive', () => {
    expect(combineDomSnapshot('- text: hello', [])).toBe('- text: hello')
  })
})

describe('pm-refs helpers', () => {
  it('builds and recognizes ref selectors, and nothing else', () => {
    expect(pmRefSelector(3)).toBe('[data-pm-ref$=":3"]')
    expect(isPmRefSelector('[data-pm-ref$=":3"]')).toBe(true)
    expect(pmRefNumberOf('[data-pm-ref$=":3"]')).toBe('3')
    expect(pmRefNumberOf('[data-pm-ref$=":13"]')).toBe('13')
    expect(isPmRefSelector('[data-pm-ref$=":3"] >> nth=0')).toBe(false)
    expect(isPmRefSelector('internal:role=button[name="x"]')).toBe(false)
    // the old exact-value form is NOT a ref selector any more (values carry
    // generation + signature now)
    expect(isPmRefSelector('[data-pm-ref="3"]')).toBe(false)
  })

  it('walk source carries the attribute literal — a rename in one place fails here', () => {
    expect(refPassSource({ mode: 'collect', gen: 1 }).includes(PM_REF_ATTR)).toBe(true)
  })
})

/** Fake page: runPlaywrightOp sees only page.locator(selector) → Locator. */
function fakePage(counts: Record<string, number>, behavior: Record<string, () => void>) {
  const calls: string[] = []
  const page = {
    locator: (selector: string) => ({
      count: async () => counts[selector] ?? 0,
      click: async () => {
        calls.push(selector)
        behavior[selector]?.()
      },
    }),
  }
  return { page: page as unknown as Page, calls }
}

describe('runPlaywrightOp ref fast-fail + timeout decoration', () => {
  it('fails a dead ref immediately with the re-snapshot instruction, never reaching the op', async () => {
    const { page, calls } = fakePage({}, {})
    await expect(runPlaywrightOp(page, { selector: pmRefSelector(3), op: 'click' })).rejects.toThrow(
      /编号 \[3\] 不存在或已失效.*重新 domSnapshot/,
    )
    expect(calls).toHaveLength(0)
  })

  it('runs a live ref through the normal op path', async () => {
    const { page, calls } = fakePage({ [pmRefSelector(1)]: 1 }, {})
    expect(await runPlaywrightOp(page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')
    expect(calls).toEqual([pmRefSelector(1)])
  })

  it('fails a ref the page verify marks as reused/stale, with the re-snapshot instruction', async () => {
    // The fake's evaluate IS the verify: report a reused node.
    const reused = fakePage({ [pmRefSelector(1)]: 1 }, {})
    reused.page.evaluate = async () => ({ status: 'changed', detail: '该编号现指向内容不同的元素' })
    await expect(runPlaywrightOp(reused.page, { selector: pmRefSelector(1), op: 'click' })).rejects.toThrow(
      /编号 \[1\] 已失效.*重新 domSnapshot/,
    )
    expect(reused.calls).toHaveLength(0)

    const stale = fakePage({ [pmRefSelector(2)]: 1 }, {})
    stale.page.evaluate = async () => ({ status: 'stale', detail: '来自第 1 代快照，当前第 2 代' })
    await expect(runPlaywrightOp(stale.page, { selector: pmRefSelector(2), op: 'click' })).rejects.toThrow(
      /编号 \[2\] 来自旧的快照.*重新 domSnapshot/,
    )
  })

  it('appends the recovery hint to locator timeouts', async () => {
    const { page } = fakePage({ css: 1 }, { css: () => { throw new Error('locator.click: Timeout 8000ms exceeded.') } })
    await expect(runPlaywrightOp(page, { selector: 'css', op: 'click' })).rejects.toThrow(PM_REF_RECOVERY_HINT)
  })

  it('passes non-timeout errors through undecorated', async () => {
    const { page } = fakePage({ css: 1 }, { css: () => { throw new Error('不是可输入元素') } })
    await expect(runPlaywrightOp(page, { selector: 'css', op: 'click' })).rejects.toThrow(/^不是可输入元素$/)
  })
})

describe('facade ref addressing', () => {
  function facadeCapturing() {
    const captured: Array<{ selector?: string; op?: string; tabId?: string }> = []
    const facade = createBrowserFacade({
      execute: async (cmd) => {
        captured.push(cmd as { selector?: string; op?: string; tabId?: string })
        return { ok: true, value: cmd.method === 'newTab' ? { id: 't1', url: 'about:blank' } : null }
      },
      emitImage: () => {},
    })
    return { facade, captured }
  }

  it('normalizes a bare number, a ref sugar locator and a plain string to the wire selector', async () => {
    const { facade, captured } = facadeCapturing()
    const tab = await facade.agent.browsers.tabs.new()
    await tab.playwright(3, 'click')
    await tab.playwright(facade.agent.playwright.ref(4), 'click')
    await tab.playwright('input#kw', 'fill', 'x')
    const selectors = captured.filter((c) => c.selector !== undefined).map((c) => c.selector)
    expect(selectors).toEqual([pmRefSelector(3), pmRefSelector(4), 'input#kw'])
  })

  it('exposes ref() in the sugar as a composable locator', () => {
    expect(playwrightSugar.ref(5).selector).toBe('[data-pm-ref$=":5"]')
    expect(playwrightSugar.ref(5).first().selector).toBe('[data-pm-ref$=":5"] >> nth=0')
  })
})

// ── Live engine: layout facts jsdom cannot have (skip by repo convention
// when no browser binary — same gate as browser-selector-smoke.test.ts). ──
const BROWSER_BINARIES = [
  process.env.PULSEMIND_CHROMIUM_PATH,
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform === 'darwin' && '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/microsoft-edge',
].filter((p): p is string => !!p && existsSync(p))

describe.skipIf(BROWSER_BINARIES.length === 0)('snapshot refs vs a real engine', () => {
  let browser: Browser | null = null
  let page: Page

  beforeAll(async () => {
    for (const channel of ['chrome', 'msedge'] as const) {
      try {
        browser = await chromium.launch({ channel, headless: true })
        break
      } catch {
        /* try the next channel */
      }
    }
    if (!browser) throw new Error('检测到浏览器二进制但启动失败')
    page = await browser.newPage()
  }, 30_000)
  afterAll(async () => { await browser?.close() })

  it('filters hidden elements, tags the rest, and the full snapshot carries both halves', async () => {
    await page.setContent(`
      <input id="kw" placeholder="百度一下,你就知道">
      <button id="hidden" style="display:none">隐藏按钮</button>
      <button id="shown">可见按钮</button>
    `)
    const snap = await takeDomSnapshot(page)
    expect(snap).toContain('- textbox')
    expect(snap).toContain('[1] textbox "百度一下,你就知道" (input#kw, placeholder=百度一下,你就知道)')
    expect(snap).toContain('[2] button "可见按钮" (button#shown)')
    expect(snap).not.toContain('隐藏按钮')
    expect(snap).toContain('tab.playwright(N, op, arg)')
    // Real-engine order check: the index the model addresses from is the FIRST
    // thing in the string, ahead of the ARIA tree it explains.
    expect(snap.indexOf('[1] textbox')).toBeLessThan(snap.indexOf('- textbox'))
    // …and it survives the kernel's own serialization, unescaped: this is the
    // exact text the user's tool card and the model both receive.
    const wire = serializeResult(snap).text
    expect(wire.split('\n')[0]).toBe('── 交互元素编号 [N] ──')
    expect(wire).not.toContain('\\n')
  }, 30_000)

  it('addresses a ref through the real selector engine and verifies the effect', async () => {
    await page.setContent(`
      <button id="go" onclick="document.getElementById('out').textContent = 'clicked'">执行</button>
      <div id="out"></div>
    `)
    const lines = (await page.evaluate(refPassSource({ mode: 'collect', gen: nextSnapshotGeneration(page) }))) as string[]
    const goRef = lines.find((l) => l.includes('button#go'))!.match(/\[(\d+)\]/)![1]
    await page.click(pmRefSelector(goRef))
    expect(await page.textContent('#out')).toBe('clicked')
  }, 30_000)

  it('fast-fails a dead ref (no locator timeout) and decorates a real timeout with the hint', async () => {
    await page.setContent('<button>存在</button>')
    const staleStart = Date.now()
    await expect(runPlaywrightOp(page, { selector: pmRefSelector(99), op: 'click' })).rejects.toThrow(/编号 \[99\] 不存在或已失效/)
    expect(Date.now() - staleStart).toBeLessThan(3_000)
    await expect(
      runPlaywrightOp(page, { selector: "internal:role=button[name=\"no-such-button-xyz\"]", op: 'click', timeoutMs: 500 }),
    ).rejects.toThrow(PM_REF_RECOVERY_HINT)
  }, 30_000)
})
