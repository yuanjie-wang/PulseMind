// ── Change signal for state-changing ops (browser tool) ──
// A mutating op can resolve and still have done nothing. Playwright's action
// contract only guarantees the gesture landed on an actionable element — not
// that the page reacted — so a click on a link whose handler never fires
// returns the same 'clicked' a successful one does. The model then repeats it,
// because "成功" and "无效果" are the same bytes (measured: a real click on
// 百度登录 in conversation conv_20260917151236 returned 'clicked' and left the
// snapshot byte-identical 6604 → 6604, and the model clicked it twice, then
// wrote a memory blaming the site).
// So the host says whether the page moved: a MutationObserver is installed
// before the op and read after it, and the result carries a hint when nothing
// at all happened (URL unchanged, zero DOM mutations).
//
// Three deliberate shapes:
// (1) The signal is NEGATIVE-ONLY — it annotates the "nothing happened" case
//     and says nothing when the page did move. A change report is cheap but a
//     false "有变化" is noise on every successful click, while the absence of a
//     change is the surprising fact the model needs.
// (2) It is a DOM-level diff, not an element count: `fill`-style ops write the
//     element's own *property* and a count would call them no-ops, and a
//     class-only toggle (an antd dropdown opening) leaves the count identical.
//     That is also why VALUE_WRITING_OPS are excluded from the watch: for them
//     "no DOM mutation" is the normal case, so a hint would be a lie.
// (3) It never guesses: install failure, a torn-down context (navigation) or a
//     page that churns on its own all read as "unknown"/"changed" — quieter,
//     never wrong. Ambient mutation is a false-negative source and is accepted
//     as such.
// The watch ships as serialized source (`Function.toString()`), like the
// snapshot walk, so both functions below are deliberately SELF-CONTAINED: they
// may reference nothing from this module (the global key appears as a literal
// inside them, pinned by test).

import type { Page } from 'playwright-core'

/** Where the watch parks itself in the page. Namespaced so a page's own
 *  globals can't collide, and cleaned up on collect. */
export const CHANGE_WATCH_KEY = '__pulsemindChangeWatch'

/** Ops whose effect lands OUTSIDE the target element, so "the page did not
 *  move" is a meaningful verdict: the click/drag/hover/press either triggered
 *  the page or it didn't. Value-writing ops (fill / pressSequentially / check /
 *  uncheck / selectOption / focus / setInputFiles) are excluded — they change
 *  the element's own value property, which no DOM diff can see, so their
 *  silence would be the normal case rather than news. */
export const CHANGE_TRACKED_OPS = new Set(['click', 'dblclick', 'dragTo', 'hover', 'press'])

/** How long the watch keeps counting after the op resolves, before it is read.
 *  Covers the gesture's own macrotask hops (a click handler that awaits a
 *  microtask, a rAF-deferred render) without becoming a wait for the network:
 *  effects landing later only make the verdict 'unchanged' where it would have
 *  been 'changed' — i.e. they cost one re-snapshot the protocol already asks
 *  for, never a wrong recommendation. */
export const CHANGE_SETTLE_MS = 120

function pulsemindInstallChangeWatch(): boolean {
  const KEY = '__pulsemindChangeWatch'
  const g = globalThis as unknown as { document?: unknown; MutationObserver?: unknown } & Record<string, unknown>
  const doc = g.document as { documentElement?: unknown } | undefined
  const root = doc ? doc.documentElement : null
  if (!root || typeof g.MutationObserver !== 'function') return false
  const prev = g[KEY] as { observer?: { disconnect: () => void } } | undefined
  if (prev && prev.observer) {
    try {
      prev.observer.disconnect()
    } catch {
      /* the old watch's document is gone */
    }
  }
  const counts = { childList: 0, attributes: 0, characterData: 0 }
  const Observer = g.MutationObserver as new (cb: (records: Array<{ type: string }>) => void) => {
    observe: (target: unknown, options: object) => void
  }
  const observer = new Observer((records) => {
    for (const r of records) {
      if (r.type === 'childList') counts.childList += 1
      else if (r.type === 'attributes') counts.attributes += 1
      else counts.characterData += 1
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
  g[KEY] = { observer, counts }
  return true
}

function pulsemindCollectChangeWatch(): {
  childList: number
  attributes: number
  characterData: number
  url: string
} | null {
  const KEY = '__pulsemindChangeWatch'
  const g = globalThis as unknown as Record<string, unknown>
  const watch = g[KEY] as
    | {
        observer: { takeRecords: () => Array<{ type: string }>; disconnect: () => void }
        counts: { childList: number; attributes: number; characterData: number }
      }
    | undefined
  if (!watch) return null
  try {
    // Records delivered to the callback are already counted; the ones still
    // queued (a mutation in the same microtask turn) are drained here, so the
    // count never depends on when the observer's callback happened to run.
    for (const r of watch.observer.takeRecords()) {
      if (r.type === 'childList') watch.counts.childList += 1
      else if (r.type === 'attributes') watch.counts.attributes += 1
      else watch.counts.characterData += 1
    }
    watch.observer.disconnect()
  } catch {
    /* torn down mid-flight */
  }
  try {
    delete g[KEY]
  } catch {
    g[KEY] = null
  }
  const loc = g.location as { href?: string } | undefined
  const c = watch.counts
  return { childList: c.childList, attributes: c.attributes, characterData: c.characterData, url: loc && loc.href ? loc.href : '' }
}

/** The exact bytes shipped into the page. */
export const INSTALL_CHANGE_WATCH_SOURCE = `(${pulsemindInstallChangeWatch.toString()})()`
export const COLLECT_CHANGE_WATCH_SOURCE = `(${pulsemindCollectChangeWatch.toString()})()`

export interface ChangeCounts {
  childList: number
  attributes: number
  characterData: number
}

export interface ChangeReport {
  /** The watch was installed before the op (false = nothing was observed). */
  installed: boolean
  /** The watch was read back (false = the page navigated / the tab is gone). */
  collected: boolean
  urlBefore: string
  urlAfter: string
  mutations: ChangeCounts
}

export type ChangeVerdict = 'changed' | 'unchanged' | 'unknown'

const NO_MUTATIONS: ChangeCounts = { childList: 0, attributes: 0, characterData: 0 }

/** Three-valued on purpose: 'unchanged' is a claim (the page demonstrably did
 *  not move) and only that value drives the hint; everything unobservable is
 *  'unknown' rather than a guess. */
export function changeVerdict(report: ChangeReport | null): ChangeVerdict {
  if (!report || !report.installed || !report.collected) return 'unknown'
  if (report.urlBefore !== report.urlAfter) return 'changed'
  const m = report.mutations
  return m.childList + m.attributes + m.characterData > 0 ? 'changed' : 'unchanged'
}

/** What the model reads when a state-changing op left no trace. Both real
 *  explanations are named — a popup in another tab looks exactly like a dead
 *  click from inside this one — and the fix is the protocol's own re-observe
 *  step, never a retry of the same address. */
export const UNCHANGED_HINT =
  '未检测到本页变化（URL 与 DOM 都没动）：若你预期这次操作有反应——先 tabs.list() 看是否新开了标签页，再重新 domSnapshot() 按新编号核对；不要重试旧编号或旧定位器。'

/** Annotate an op's result string. Only 'unchanged' speaks. */
export function describeOperationResult(base: string, report: ChangeReport | null): string {
  return changeVerdict(report) === 'unchanged' ? `${base}（${UNCHANGED_HINT}）` : base
}

/** Install → run → settle → collect. The action's own error path still
 *  disconnects the watch: a leaked observer would keep counting into the next
 *  op's window and quietly turn every later verdict into 'changed'. */
export async function withChangeWatch<T>(page: Page, action: () => Promise<T>): Promise<{ value: T; report: ChangeReport }> {
  const urlBefore = safeUrl(page)
  let installed = false
  try {
    installed = Boolean(await page.evaluate(INSTALL_CHANGE_WATCH_SOURCE))
  } catch {
    installed = false
  }
  let value: T
  try {
    value = await action()
  } catch (err) {
    await collect(page)
    throw err
  }
  if (installed && CHANGE_SETTLE_MS > 0) {
    try {
      await page.waitForTimeout(CHANGE_SETTLE_MS)
    } catch {
      /* the tab went away mid-op; the collect below is the verdict */
    }
  }
  const raw = await collect(page)
  return {
    value,
    report: {
      installed,
      collected: raw !== null,
      urlBefore,
      urlAfter: safeUrl(page),
      mutations: raw ? { childList: raw.childList, attributes: raw.attributes, characterData: raw.characterData } : NO_MUTATIONS,
    },
  }
}

async function collect(page: Page): Promise<{ childList: number; attributes: number; characterData: number; url: string } | null> {
  try {
    return await page.evaluate(COLLECT_CHANGE_WATCH_SOURCE)
  } catch {
    return null
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}
