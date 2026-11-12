/** tab.readText — the plain-text READING channel (2026-11-12).
 *
 *  domSnapshot is the ACTION-ADDRESSING channel: ARIA nodes with refs and
 *  state brackets, cost scales with the whole tree. For READING (a long
 *  article, a big result list) that is waste — a 24K-char page spends
 *  context on scaffolding the model needed once. This is the cheap inverse:
 *  one evaluate, no refs, a char budget, paging.
 *
 *  `pulsemindReadText` runs INSIDE the page via page.evaluate. Playwright
 *  serializes ONLY the function's own source (fn.toString(), minified by the
 *  main bundle's esbuild pass) — the first cut referenced module-level
 *  helpers and died in the page with `ReferenceError: wA is not defined`
 *  (their minified names exist nowhere in the page realm; jsdom tests called
 *  the function in-module and could not see the break). So EVERYTHING it
 *  needs lives in its own body: constants, helpers, all of it. The
 *  serialization nail in browser-read-text.test.ts indirect-evals the
 *  function's source with the module scope gone — that is what keeps this
 *  contract honest.
 */

export interface ReadTextOptions {
  /** Read ONE container's text instead of the auto-detected main content —
   *  the "只要这几条结果" form: `{ selector: '.b_results' }`. */
  selector?: string
  /** Max characters returned (default 12000, hard cap 60000). */
  budget?: number
  /** Character offset to continue a truncated read (readText returns
   *  totalChars/truncated — the next call is `{ offset: prev budget }`). */
  offset?: number
}

export interface ReadTextResult {
  text: string
  totalChars: number
  truncated: boolean
  /** How the container was chosen: 'selector' | 'semantic' (article /
   *  [role=main] / main) | 'density' (largest own-text block) | 'body'. Says
   *  how much to trust the scope of what came back. */
  strategy: string
}

/** Runs inside the page — see the module doc. Self-contained by construction. */
export function pulsemindReadText(options: ReadTextOptions): ReadTextResult {
  const DEFAULT_BUDGET = 12_000
  const MAX_BUDGET = 60_000
  /** The substantial-text bar for the semantic/density candidates: anything
   *  smaller falls through to the next strategy instead of returning a stub. */
  const MAIN_TEXT_MIN_CHARS = 120
  const BOILERPLATE_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG'])
  const LINKISH_TAGS = new Set(['A', 'NAV', 'BUTTON'])

  /** innerText when the realm provides it (real pages: layout-aware, hides
   *  display:none); textContent as the jsdom fallback. A whitespace-only
   *  innerText (hidden container) falls back too. */
  const visibleTextOf = (el: Element): string => {
    const inner = (el as HTMLElement).innerText
    if (typeof inner === 'string' && inner.trim()) return inner
    return (el.textContent ?? '').replace(/[ \t]+/g, ' ')
  }

  /** One walk, two numbers: `total` = own text mass (textContent of TEXT
   *  nodes, boilerplate subtrees excluded — they register in textContent but
   *  are not content), `linkish` = the part inside a/nav/button. No layout is
   *  forced, unlike innerText — scoring an 800-candidate scan stays cheap. */
  const ownTextOf = (el: Element): { total: number; linkish: number } => {
    let total = 0
    let linkish = 0
    const walk = (node: Node, inLink: boolean): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const len = (child.textContent ?? '').trim().length
          total += len
          if (inLink) linkish += len
        } else if (child.nodeType === 1) {
          const tag = (child as Element).tagName?.toUpperCase()
          if (BOILERPLATE_TAGS.has(tag)) continue
          walk(child, inLink || LINKISH_TAGS.has(tag))
        }
      }
    }
    walk(el, LINKISH_TAGS.has(el.tagName?.toUpperCase() ?? ''))
    return { total, linkish }
  }

  const budget = Math.min(Math.max(Math.floor(Number(options?.budget) || DEFAULT_BUDGET), 200), MAX_BUDGET)
  const offset = Math.max(0, Math.floor(Number(options?.offset) || 0))

  const selector = typeof options?.selector === 'string' ? options.selector.trim() : ''
  let text = ''
  let strategy = ''

  if (selector) {
    const el = document.querySelector(selector)
    if (!el) throw new Error(`readText: 没有元素匹配 "${selector}"——先用 domSnapshot() 或 evaluate() 核对选择器`)
    text = visibleTextOf(el)
    strategy = 'selector'
  } else {
    // 语义候选优先：article / [role=main] / main 有足量文本就不再猜。
    const semantic = document.querySelector('article, [role="main"], main')
    if (semantic && ownTextOf(semantic).total >= MAIN_TEXT_MIN_CHARS) {
      text = visibleTextOf(semantic)
      strategy = 'semantic'
    }
    if (!text) {
      // 文本密度最大的块：own-text（去 script/style 等锅炉、按链接占比轻罚）
      // 最多的容器赢。子元素不可能胜过父元素（文本是子集），所以拿到的是
      // 包住正文的最外层块——对阅读场景刚好。
      let best: Element | null = null
      let bestScore = 0
      const candidates = document.querySelectorAll('article, main, section, div, td, [role="main"]')
      const scan = Math.min(candidates.length, 800)
      for (let i = 0; i < scan; i++) {
        const el = candidates[i]
        if (el === document.body) continue
        const { total, linkish } = ownTextOf(el)
        if (total < MAIN_TEXT_MIN_CHARS) continue
        const score = total * (1 - linkish / total) * (1 - linkish / total)
        if (score > bestScore) {
          bestScore = score
          best = el
        }
      }
      if (best) {
        text = visibleTextOf(best)
        strategy = 'density'
      }
    }
    if (!text) {
      text = visibleTextOf(document.body ?? document.documentElement)
      strategy = 'body'
    }
  }

  // Collapse the blank-line runs innerText tends to produce between blocks.
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  const totalChars = text.length
  return {
    text: text.slice(offset, offset + budget),
    totalChars,
    truncated: offset + budget < totalChars,
    strategy,
  }
}
