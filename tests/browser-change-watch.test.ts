// @vitest-environment jsdom
/** Change signal for state-changing ops.
 *
 *  The bug behind this file: a `click` that did nothing returned the same
 *  'clicked' as one that navigated, so the model re-clicked, guessed APIs and
 *  wrote a memory blaming the site (conv_20260917151236 — snapshot byte-equal
 *  6604 → 6604 across the click, and a live probe on the same page proved the
 *  click worked when it did something: 6292 → 7492).
 *
 *  Coverage split: jsdom runs the two SHIPPED sources (they are serialized
 *  `Function.toString()`, so they are run exactly as the page runs them) and the
 *  pure verdict/annotation logic; the runPlaywrightOp wiring runs against a fake
 *  page, which is honest here because the contract is about which TEXT reaches
 *  the model; the live section at the bottom checks the discrimination itself
 *  (inert click vs DOM change vs class-only change vs URL change) against a real
 *  engine, which is the one thing jsdom cannot have.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright-core'
import {
  CHANGE_SETTLE_MS,
  CHANGE_TRACKED_OPS,
  CHANGE_WATCH_KEY,
  COLLECT_CHANGE_WATCH_SOURCE,
  INSTALL_CHANGE_WATCH_SOURCE,
  UNCHANGED_HINT,
  changeVerdict,
  describeOperationResult,
  type ChangeReport,
} from '../src/main/browser/change-watch'
import { runPlaywrightOp } from '../src/main/browser/PlaywrightCommands'
import { pmRefSelector } from '../src/shared/browser-client/pm-refs'

/** Both ends ship as serialized source; run them the way the page does. */
function install(): boolean {
  return new Function(`return ${INSTALL_CHANGE_WATCH_SOURCE}`)() as boolean
}
function collect() {
  return new Function(`return ${COLLECT_CHANGE_WATCH_SOURCE}`)() as {
    childList: number
    attributes: number
    characterData: number
    url: string
  } | null
}
function watchState(): unknown {
  return (globalThis as unknown as Record<string, unknown>)[CHANGE_WATCH_KEY]
}

describe('change watch sources (running in this realm, as the page runs them)', () => {
  it('install returns true, counts every mutation kind, and collect drains + cleans up', () => {
    document.body.innerHTML = '<div id="a">x</div>'
    expect(install()).toBe(true)
    expect(watchState()).toBeTruthy()

    document.getElementById('a')!.setAttribute('data-x', '1') // attributes
    document.getElementById('a')!.textContent = 'y' // childList (text node swap)
    document.body.appendChild(document.createElement('span')) // childList
    document.getElementById('a')!.firstChild!.nodeValue = 'z' // characterData

    const report = collect()!
    expect(report.childList).toBeGreaterThanOrEqual(2)
    expect(report.attributes).toBe(1)
    expect(report.characterData).toBe(1)
    expect(report.url).toBe(location.href)
    // the watch is one-shot: a second collect finds nothing parked
    expect(collect()).toBeNull()
    expect(watchState()).toBeUndefined()
  })

  it('counts mutations in the same turn as the read (takeRecords, not a callback race)', () => {
    document.body.innerHTML = '<div id="a">x</div>'
    install()
    document.getElementById('a')!.setAttribute('data-y', '1') // may not have been delivered yet
    expect(collect()!.attributes).toBe(1)
  })

  it('re-installing disconnects the previous observer instead of leaking it', () => {
    document.body.innerHTML = '<div id="a">x</div>'
    expect(install()).toBe(true)
    const first = watchState()
    expect(install()).toBe(true)
    expect(watchState()).not.toBe(first)
    document.getElementById('a')!.setAttribute('data-z', '1')
    // exactly one record: a leaked first observer would count it twice
    expect(collect()!.attributes).toBe(1)
  })

  it('ships self-contained sources: the parked key is a literal in both halves', () => {
    expect(INSTALL_CHANGE_WATCH_SOURCE).toContain(CHANGE_WATCH_KEY)
    expect(COLLECT_CHANGE_WATCH_SOURCE).toContain(CHANGE_WATCH_KEY)
    expect(INSTALL_CHANGE_WATCH_SOURCE).not.toContain('export ')
    expect(COLLECT_CHANGE_WATCH_SOURCE).not.toContain('export ')
  })
})

describe('changeVerdict / describeOperationResult', () => {
  const report = (over: Partial<ChangeReport> = {}): ChangeReport => ({
    installed: true,
    collected: true,
    urlBefore: 'https://a.com/',
    urlAfter: 'https://a.com/',
    mutations: { childList: 0, attributes: 0, characterData: 0 },
    ...over,
  })

  it('is three-valued, and only claims "unchanged" for a fully observed quiet op', () => {
    expect(changeVerdict(null)).toBe('unknown')
    expect(changeVerdict(report({ installed: false }))).toBe('unknown')
    expect(changeVerdict(report({ collected: false }))).toBe('unknown')
    expect(changeVerdict(report())).toBe('unchanged')
    expect(changeVerdict(report({ mutations: { childList: 1, attributes: 0, characterData: 0 } }))).toBe('changed')
    expect(changeVerdict(report({ mutations: { childList: 0, attributes: 0, characterData: 2 } }))).toBe('changed')
    expect(changeVerdict(report({ urlAfter: 'https://a.com/other' }))).toBe('changed')
  })

  it('speaks only when nothing happened, and names both real explanations', () => {
    expect(describeOperationResult('clicked', report())).toBe(`clicked（${UNCHANGED_HINT}）`)
    expect(describeOperationResult('clicked', report({ mutations: { childList: 3, attributes: 0, characterData: 0 } }))).toBe('clicked')
    expect(describeOperationResult('clicked', null)).toBe('clicked')
    // a popup tab looks exactly like a dead click from inside this tab
    expect(UNCHANGED_HINT).toContain('tabs.list()')
    expect(UNCHANGED_HINT).toContain('domSnapshot()')
  })

  it('tracks the gesture ops whose effect lands outside the element, not value-writers', () => {
    expect([...CHANGE_TRACKED_OPS].sort()).toEqual(['click', 'dblclick', 'dragTo', 'hover', 'press'])
    // fill/check/selectOption write the element's own value property — no DOM
    // diff can see that, so "no change" would be the normal case, not news
    for (const op of ['fill', 'pressSequentially', 'check', 'uncheck', 'selectOption', 'focus', 'setInputFiles']) {
      expect(CHANGE_TRACKED_OPS.has(op)).toBe(false)
    }
  })
})

/** A page that plays the watch protocol back. `withWatch: false` models a page
 *  whose evaluate is unusable (context not ready) — the quiet degradation. */
function watchablePage(over: {
  mutations?: { childList: number; attributes: number; characterData: number }
  urlBefore?: string
  urlAfter?: string
  installs?: boolean
  collects?: boolean
  withWatch?: boolean
  opThrows?: Error
} = {}) {
  const state = { installs: 0, collects: 0, waits: 0, ops: 0 }
  // url() is read twice (before the op, after it) — the install call flips it,
  // exactly as a navigation during the op would.
  let navigated = false
  const page = {
    locator: () => ({
      count: async () => 1,
      click: async () => {
        state.ops += 1
        if (over.opThrows) throw over.opThrows
      },
    }),
    url: () => (navigated ? (over.urlAfter ?? over.urlBefore ?? 'https://a.com/') : (over.urlBefore ?? 'https://a.com/')),
    waitForTimeout: async () => {
      state.waits += 1
    },
    evaluate: async (src: string) => {
      if (src === INSTALL_CHANGE_WATCH_SOURCE) {
        state.installs += 1
        navigated = true
        return over.installs ?? true
      }
      if (src === COLLECT_CHANGE_WATCH_SOURCE) {
        state.collects += 1
        if (over.collects === false) throw new Error('execution context was destroyed')
        return { childList: 0, attributes: 0, characterData: 0, url: 'https://a.com/', ...(over.mutations ?? {}) }
      }
      throw new Error(`unexpected evaluate: ${String(src).slice(0, 40)}`)
    },
  }
  if (over.withWatch === false) delete (page as Record<string, unknown>)['evaluate']
  return { page: page as unknown as Page, state }
}

describe('runPlaywrightOp carries the change signal', () => {
  it('annotates a click that left the page untouched', async () => {
    const { page, state } = watchablePage()
    expect(await runPlaywrightOp(page, { selector: pmRefSelector(1), op: 'click' })).toBe(`clicked（${UNCHANGED_HINT}）`)
    expect(state.installs).toBe(1)
    expect(state.collects).toBe(1)
    expect(state.waits).toBe(1)
  })

  it('stays silent when the page moved — DOM change or URL change alike', async () => {
    const dom = watchablePage({ mutations: { childList: 4, attributes: 0, characterData: 1 } })
    expect(await runPlaywrightOp(dom.page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')

    const nav = watchablePage({ urlAfter: 'https://a.com/next' })
    expect(await runPlaywrightOp(nav.page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')
  })

  it('degrades quietly when the watch is unusable (no evaluate, install failed, torn-down context)', async () => {
    const none = watchablePage({ withWatch: false })
    expect(await runPlaywrightOp(none.page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')
    expect(none.state.waits).toBe(0) // nothing installed ⇒ no settle wait either

    const refused = watchablePage({ installs: false })
    expect(await runPlaywrightOp(refused.page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')

    const torn = watchablePage({ collects: false })
    expect(await runPlaywrightOp(torn.page, { selector: pmRefSelector(1), op: 'click' })).toBe('clicked')
  })

  it('never watches value-writing or reading ops', async () => {
    const read = watchablePage()
    expect(await runPlaywrightOp(read.page, { selector: 'css', op: 'count' })).toBe(1)
    expect(read.state.installs).toBe(0)
    expect(read.state.waits).toBe(0)

    const write = watchablePage()
    const fill = {
      ...write.page,
      locator: () => ({ count: async () => 1, fill: async () => {} }),
    } as unknown as Page
    expect(await runPlaywrightOp(fill, { selector: 'input#kw', op: 'fill', arg: 'x' })).toBe('filled')
    expect(write.state.installs).toBe(0)
  })

  it('collects the watch even when the op errors, so the next op is not counting ghosts', async () => {
    const { page, state } = watchablePage({ opThrows: new Error('不是可输入元素') })
    await expect(runPlaywrightOp(page, { selector: 'css', op: 'click' })).rejects.toThrow('不是可输入元素')
    expect(state.collects).toBe(1)
  })
})

// ── Live engine: the discrimination itself (skip by repo convention when no
// browser binary). ──
const BROWSER_BINARIES = [
  process.env.PULSEMIND_CHROMIUM_PATH,
  process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.platform === 'darwin' && '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.platform === 'linux' && '/usr/bin/google-chrome',
  process.platform === 'linux' && '/usr/bin/microsoft-edge',
].filter((p): p is string => !!p && existsSync(p))

describe.skipIf(BROWSER_BINARIES.length === 0)('change signal vs a real engine', () => {
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

  it('calls an inert click inert (the conv_20260917151236 shape)', async () => {
    await page.setContent('<button id="dead">登录</button><div id="out"></div>')
    const result = await runPlaywrightOp(page, { selector: 'button#dead', op: 'click' })
    expect(result).toBe(`clicked（${UNCHANGED_HINT}）`)
    // and the page really is untouched — the hint is not a false positive
    expect(await page.textContent('#out')).toBe('')
  }, 30_000)

  it('stays silent for a click the page reacted to', async () => {
    await page.setContent(`<button id="go" onclick="document.getElementById('out').textContent='done'">开始</button><div id="out"></div>`)
    expect(await runPlaywrightOp(page, { selector: 'button#go', op: 'click' })).toBe('clicked')
    expect(await page.textContent('#out')).toBe('done')
  }, 30_000)

  it('stays silent for a class-only change (a dropdown opening is not a count change)', async () => {
    await page.setContent(`<button id="t" onclick="document.getElementById('m').classList.toggle('open')">菜单</button><div id="m" class="menu">项</div>`)
    expect(await runPlaywrightOp(page, { selector: 'button#t', op: 'click' })).toBe('clicked')
    expect(await page.getAttribute('#m', 'class')).toBe('menu open')
  }, 30_000)

  it('stays silent when the URL moved (hash navigation included)', async () => {
    await page.setContent('<a id="l" href="#section">跳转</a>')
    expect(await runPlaywrightOp(page, { selector: 'a#l', op: 'click' })).toBe('clicked')
    expect(page.url()).toContain('#section')
  }, 30_000)

  it('settles before reading, so a handler that renders on the next task still counts', async () => {
    await page.setContent(
      `<button id="later" onclick="setTimeout(() => { document.body.appendChild(document.createElement('p')) }, 40)">稍后</button>`,
    )
    expect(await runPlaywrightOp(page, { selector: 'button#later', op: 'click' })).toBe('clicked')
    expect(await page.locator('p').count()).toBe(1)
  }, 30_000)

  it('is not fooled by an ambient page that churns on its own', async () => {
    // a ticking page reads as 'changed' — a false negative, i.e. one wasted
    // domSnapshot, never a wrong instruction
    await page.setContent('<div id="tick">0</div><script>setInterval(() => { document.getElementById("tick").textContent = String(Date.now()) }, 10)</script>')
    await page.waitForTimeout(CHANGE_SETTLE_MS)
    expect(await runPlaywrightOp(page, { selector: '#tick', op: 'click' })).toBe('clicked')
  }, 30_000)
})
