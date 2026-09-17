// ── domSnapshot with numbered refs (page_* 哲学, host-side) ──
// The browser tool's answer to the extension's indexed DOM walk: the ARIA YAML
// stays (semantic understanding), and a second pass numbers the interactive
// elements and tags each with `data-pm-ref`, so what the model just saw is
// addressable as `[N]` through the host's one selector engine — no name
// transcription between observation and action. The walk ships as serialized
// source (`Function.toString()`) and runs in the page realm, so the collect
// function below is deliberately SELF-CONTAINED: it may reference nothing from
// this module (the attribute name appears as a literal inside it, pinned by
// test to PM_REF_ATTR).

import type { Page } from 'playwright-core'

/** Interactive elements get numbered up to here; the walk says so in its
 *  output rather than silently truncating (same contract as page-tree). */
export const MAX_REF_ELEMENTS = 200

function pulsemindCollectRefs(): string[] {
  const ATTR = 'data-pm-ref'
  const MAX = 200
  const g = globalThis as unknown as { document: any }
  const doc: any = g.document
  // 1) The page is untrusted: strip any refs it forged before we started, so
  //    addressing can only ever hit tags this pass set itself.
  for (const el of doc.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR)

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

  // 3) Name resolution: cheap probes in confidence order — the line's label is
  //    for correlation with the YAML; addressing itself never needs it.
  const nameOf = (el: any): string => {
    const al = el.getAttribute('aria-label')
    if (al && al.trim()) return al.trim()
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input' && (type === 'submit' || type === 'button')) {
      const v = (el.value || '').trim()
      if (v) return v
    }
    if (tag === 'input' || tag === 'textarea') {
      const ph = el.getAttribute('placeholder')
      if (ph && ph.trim()) return ph.trim()
    }
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (txt) return txt.slice(0, 60)
    if (tag === 'input') {
      const v = (el.value || '').trim()
      if (v) return v
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

  // 4) Tag + line. Elements that aren't rendered are skipped (checkVisibility
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
    el.setAttribute(ATTR, String(n))
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

/** The exact bytes shipped into the page. */
export const SNAPSHOT_REFS_SOURCE = `(${pulsemindCollectRefs.toString()})()`

/** One observation: the ARIA YAML for understanding, the numbered refs for
 *  addressing. Numbered list after the YAML, so the YAML prefix stays stable
 *  for whatever the model anchors on first. */
export function combineDomSnapshot(yaml: string, refLines: string[]): string {
  const refs =
    refLines.length > 0
      ? `\n\n── 交互元素编号 [N] ──\n寻址：tab.playwright(N, op, arg) 或 agent.playwright.ref(N)。页面变化后编号失效：重新 domSnapshot()，不要重试旧编号。\n${refLines.join('\n')}`
      : ''
  return `${yaml}${refs}`
}

/** The service-side snapshot: both passes over one page, joined. */
export async function takeDomSnapshot(page: Page): Promise<string> {
  const [yaml, refLines] = await Promise.all([
    page.locator('html').ariaSnapshot(),
    page.evaluate<string[]>(SNAPSHOT_REFS_SOURCE),
  ])
  return combineDomSnapshot(yaml, refLines ?? [])
}
