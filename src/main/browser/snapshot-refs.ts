// ── domSnapshot with numbered refs (page_* 哲学, host-side) ──
// The browser tool's answer to the extension's indexed DOM walk: the ARIA YAML
// stays (semantic understanding), and a second pass numbers the interactive
// elements and tags each with `data-pm-ref`, so what the model just saw is
// addressable as `[N]` through the host's one selector engine — no name
// transcription between observation and action. The walk ships as serialized
// source (`Function.toString()`) and runs in the page realm, so the pass below
// is deliberately SELF-CONTAINED: it may reference nothing from this module
// (the attribute name appears as a literal inside it, pinned by test to
// PM_REF_ATTR).
//
// Ref values carry three facts, `s<gen>:<sig>:<n>` (review 2026-09-18 M11):
//   gen — the per-page snapshot generation (bumped on every domSnapshot), so
//         a tag left over from an earlier pass is recognizable as stale;
//   sig — a tiny content hash (tag|role|name|text head) captured at stamp
//         time, so a page whose framework REUSED the DOM node (kept the
//         attribute, swapped the content) fails verification at action time
//         instead of silently clicking the element that now occupies the ref;
//   n   — the number the model addresses.
// The action-time fast-fail (PlaywrightCommands) runs this same source in
// verify mode: one round trip proves the ref is present, current, and still
// naming the content the snapshot showed. Without that proof the error says
// re-snapshot — a wasted domSnapshot costs one call, a wrong-element click
// costs wrong actions.

import type { Page } from 'playwright-core'

/** Interactive elements get numbered up to here; the walk says so in its
 *  output rather than silently truncating (same contract as page-tree). */
export const MAX_REF_ELEMENTS = 200

/* One self-contained page-realm pass. Serialized with Function.toString()
 * and shipped into the page realm, so it must be SELF-CONTAINED: no imports,
 * no module references — which is why it types DOM as `any` throughout and
 * carries the blanket disable below (the review's exemptible form: the code
 * runs in the PAGE, not in this module's type world). `mode` picks collect
 * (strip + stamp + number) or verify (read-only staleness proof at action
 * time). The name is part of the shipped source — keep it descriptive. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function pulsemindRefPass(input: { mode: 'collect' | 'verify'; gen: number; n?: string }): string[] | { status: string; detail: string } {
  const ATTR = 'data-pm-ref'
  const MAX = 200
  const g = globalThis as unknown as { document: any }
  const doc: any = g.document

  // Shared name resolution: cheap probes in confidence order — the line's
  // label is for correlation with the YAML; the signature below folds it so
  // a reused node whose content changed no longer verifies.
  const normalizedTextOf = (el: any): string => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const nameOf = (el: any): string => {
    const al = el.getAttribute('aria-label')
    if (al && al.trim()) return al.trim()
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input' && (type === 'submit' || type === 'button')) {
      const v = el.value || ''
      if (v.trim()) return v.trim()
    }
    if (tag === 'input' || tag === 'textarea') {
      const ph = el.getAttribute('placeholder')
      if (ph && ph.trim()) return ph.trim()
    }
    const txt = normalizedTextOf(el)
    if (txt) return txt.slice(0, 60)
    if (tag === 'input') {
      const v = el.value || ''
      if (v.trim()) return v.trim()
    }
    const img = el.querySelector('img[alt]')
    if (img) {
      const alt = (img.getAttribute('alt') || '').trim()
      if (alt) return alt
    }
    const ti = el.getAttribute('title')
    if (ti && ti.trim()) return ti.trim()
    return ''
  }
  const roleOf = (el: any): string => {
    const role = el.getAttribute('role')
    if (role) return role
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input') {
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'submit' || type === 'button' || type === 'file') return 'button'
      return 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'a') return 'link'
    if (tag === 'select') return 'combobox'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'label') return 'label'
    if (tag === 'audio' || tag === 'video') return tag
    return tag
  }
  // djb2 → base36, fixed width. Deterministic across realms: collect stamps
  // it and verify recomputes it from the SAME code, byte for byte.
  const sigOf = (el: any): string => {
    const material = `${el.tagName.toLowerCase()}|${roleOf(el)}|${nameOf(el)}|${normalizedTextOf(el).slice(0, 80)}`
    let h = 5381
    for (let i = 0; i < material.length; i++) h = ((h << 5) + h + material.charCodeAt(i)) | 0
    return (h >>> 0).toString(36).padStart(7, '0')
  }
  const valuePattern = /^s(\d+):([0-9a-z]+):(\d+)$/
  const refBearers = (): any[] => {
    const out: any[] = []
    const seen = new Set<any>()
    const visit = (root: any): void => {
      for (const el of root.querySelectorAll(`[${ATTR}]`)) {
        if (!seen.has(el)) {
          seen.add(el)
          out.push(el)
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot)
      }
    }
    visit(doc)
    return out
  }

  if (input.mode === 'verify') {
    const want = String(input.n ?? '')
    const expectedGen = Number(input.gen) || 0
    const bearers: Array<{ gen: number; sig: string; el: any }> = []
    for (const el of refBearers()) {
      const m = valuePattern.exec(el.getAttribute(ATTR) || '')
      if (m && m[3] === want) bearers.push({ gen: Number(m[1]), sig: m[2], el })
    }
    if (bearers.length === 0) return { status: 'missing', detail: '' }
    const current = bearers.filter((b) => b.gen === expectedGen)
    if (current.length === 0) {
      return { status: 'stale', detail: `来自第 ${bearers.map((b) => b.gen).join('、')} 代快照，当前第 ${expectedGen} 代` }
    }
    for (const b of current) {
      if (sigOf(b.el) === b.sig) return { status: 'ok', detail: '' }
    }
    return { status: 'changed', detail: '该编号现指向内容不同的元素（页面复用了节点）' }
  }

  // ── collect ──
  const gen = Number(input.gen) || 0
  // 1) The page is untrusted: strip any refs it forged before we started, so
  //    addressing can only ever hit tags this pass set itself.
  for (const el of refBearers()) el.removeAttribute(ATTR)

  // 2) Interactive candidates — same heuristic family as the extension's
  //    page-tree: interactive tags, focusable containers, ARIA roles, inline
  //    click handlers. Collected in document order, open shadow roots included.
  const SEL =
    'a[href],button,input,select,textarea,summary,label[for],audio[controls],video[controls],' +
    '[onclick],[contenteditable="true"],[contenteditable=""],[tabindex="0"],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
    '[role="menuitem"],[role="option"],[role="switch"],[role="combobox"],[role="searchbox"],' +
    '[role="textbox"],[role="slider"],[role="spinbutton"],[role="menuitemcheckbox"],[role="menuitemradio"]'
  const seen = new Set<any>()
  const order: any[] = []
  const visit = (root: any): void => {
    for (const el of root.querySelectorAll(SEL)) {
      if (!seen.has(el)) {
        seen.add(el)
        order.push(el)
      }
    }
    // Shadow hosts: every element is a potential host; open roots recurse.
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot)
    }
  }
  visit(doc)

  // 3) Tag + line. Elements that aren't rendered are skipped (checkVisibility
  //    when present), and numbering stops at MAX with an explicit marker.
  const lines: string[] = []
  let n = 0
  for (const el of order) {
    if (n >= MAX) {
      lines.push(`（交互元素超过 ${MAX} 个，仅编号前 ${MAX} 个——缩小范围或在页内检索后再 domSnapshot）`)
      break
    }
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (el.tagName.toLowerCase() === 'input' && type === 'hidden') continue
    n += 1
    el.setAttribute(ATTR, `s${gen}:${sigOf(el)}:${n}`)
    const tag = el.tagName.toLowerCase()
    const id = el.id ? `#${el.id}` : ''
    const name = nameOf(el)
    const role = roleOf(el)
    const extra: string[] = []
    if (tag === 'input' && type && role !== type) extra.push(`type=${type}`)
    const ph = el.getAttribute('placeholder')
    if (ph) extra.push(`placeholder=${ph}`)
    lines.push(`[${n}] ${role}${name ? ` "${name}"` : ''} (${tag}${id}${extra.length ? ', ' + extra.join(', ') : ''})`)
  }
  return lines
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** The exact bytes shipped into the page: the pass source wrapped into an
 *  IIFE over its JSON input. Playwright evaluates a STRING source as an
 *  expression (this build does not auto-invoke `function …` sources — they
 *  evaluate to an unserializable function value, i.e. undefined), so the call
 *  is built into the source. `n` rides JSON: pmRefNumberOf has already
 *  validated it down to bare digits, and the re-check here keeps the source
 *  injection-proof even against a future caller that forgot. */
export function refPassSource(input: { mode: 'collect' | 'verify'; gen: number; n?: string }): string {
  if (input.n !== undefined && !/^\d+$/.test(input.n)) throw new Error(`ref n must be digits: ${input.n}`)
  return `(${pulsemindRefPass.toString()})(${JSON.stringify(input)})`
}

// ── Per-page snapshot generations ──
// The generation a ref carries is the pass that stamped it; the action-time
// verify compares it against the page's CURRENT generation, so anything that
// stamped an earlier pass (or any tag the strip pass could not reach — a node
// that moved into a closed shadow root, say) is provably stale.
const snapshotGenerations = new WeakMap<Page, number>()

export function nextSnapshotGeneration(page: Page): number {
  const gen = (snapshotGenerations.get(page) ?? 0) + 1
  snapshotGenerations.set(page, gen)
  return gen
}

/** The generation the page's live refs carry (0 = never snapshotted — nothing
 *  can verify against it, which is exactly the "re-snapshot first" state). */
export function currentSnapshotGeneration(page: Page): number {
  return snapshotGenerations.get(page) ?? 0
}

/** One observation: the numbered refs for addressing, then the ARIA YAML for
 *  understanding — the index FIRST, and both halves of that order are load-bearing.
 *
 *  (1) Every cap on this path keeps the HEAD: `serializeResult` slices
 *      `text.slice(0, maxBytes)` and the engine's tool-result guardrail is
 *      head+tail, so a numbered list riding the tail is one the model may never
 *      receive on a big page. (2) The chat's output box is a 300px scroller that
 *      opens at the top (its auto-scroll effect rides `block.output`, which does
 *      not change when a collapsed card expands), so the same list is one the
 *      *user* never reads either: measured 2026-09-17, the report was
 *      「返回的snapshot还是没有标序号」 while the bytes were in the result all
 *      along — read off the user's own `tool_results` rows, where every recent
 *      snapshot carried them 4600 characters in. (3) It is also the actionable
 *      half: what the model does next is address an element, not read prose. */
export function combineDomSnapshot(yaml: string, refLines: string[]): string {
  if (refLines.length === 0) return yaml
  const refs = `── 交互元素编号 [N] ──\n寻址：tab.playwright(N, op, arg) 或 agent.playwright.ref(N)。页面变化后编号失效：重新 domSnapshot()，不要重试旧编号。\n${refLines.join('\n')}`
  return `${refs}\n\n── 页面结构（ARIA）──\n${yaml}`
}

/** The service-side snapshot: both passes over one page, joined. */
export async function takeDomSnapshot(page: Page): Promise<string> {
  const gen = nextSnapshotGeneration(page)
  const [yaml, refLines] = await Promise.all([
    page.locator('html').ariaSnapshot(),
    page.evaluate(refPassSource({ mode: 'collect', gen })) as Promise<string[]>,
  ])
  return combineDomSnapshot(yaml, refLines ?? [])
}
