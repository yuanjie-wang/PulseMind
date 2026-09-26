/**
 * Page DOM analysis pipeline (PLAN-browser-extension M2.1, ported from
 * Anywhere `packages/extension/src/content/dom-tree.ts`).
 *
 * Flat-DOM-tree approach (after page-agent):
 *   - walk visible elements, build a flat DOM tree
 *   - number the interactive ones [n] — numbers are PERSISTENT refs: an element
 *     keeps the index it was first numbered with for the life of the page
 *     (content-script module state), so a follow-up read after a click does not
 *     renumber the world and the model can act on indices it already holds
 *   - serialize to compact text (attribute whitelist + dedupe + descendant text)
 *   - selectorMap: index → element reference, so the action executors can act
 *     without xpath
 *   - `delta: true` re-walks (geometry must be recomputed) but prints only what
 *     changed since the last build — added/changed/removed refs plus new plain
 *     text — falling back to the full view when there is no comparable baseline
 *
 * jsdom compatibility: when no layout engine is present (the probe fails) the
 * rect / elementFromPoint geometry checks are skipped and the pure DOM
 * heuristics still work — a real browser runs the full pipeline.
 *
 * Two deviations from the Anywhere original:
 *   - own-DOM detection keys off our host attribute instead of an id prefix
 *   - MAX_NODES caps the *total* walked node count (not just interactive ones),
 *     so a pathological page cannot hang the content script
 */

// ── Types ────────────────────────────────────────────────────────────

interface TextNode {
  type: 'text'
  text: string
  isVisible: boolean
  parentId: string | null
}

interface ElementNode {
  type: 'element'
  tagName: string
  attributes?: Record<string, string>
  children: string[]
  isVisible: boolean
  isInteractive: false
  highlightIndex?: number
  isNew?: boolean
  parentId: string | null
  scrollable?: { x: number; y: number }
  isTop?: boolean
}

interface InteractiveElementNode {
  type: 'interactive'
  tagName: string
  attributes?: Record<string, string>
  children: string[]
  isVisible: boolean
  isInteractive: true
  highlightIndex: number
  isNew: boolean
  parentId: string | null
  ref: Element
  scrollable?: { x: number; y: number }
  isTop?: boolean
}

type DomNode = TextNode | ElementNode | InteractiveElementNode

interface FlatDomTree {
  rootId: string
  map: Record<string, DomNode>
  truncated: boolean
}

// ── Constants ────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['svg', 'script', 'style', 'noscript', 'meta', 'link', 'canvas', 'template'])
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'])
const INTERACTIVE_CURSORS = new Set(['pointer', 'text', 'move', 'grab', 'grabbing', 'cell'])
const SEMANTIC_TAGS = new Set(['nav', 'menu', 'header', 'footer', 'aside', 'dialog'])
const SKIPPABLE_TAGS = new Set([
  'html', 'head', 'body', 'div', 'span', 'p', 'section', 'article', 'main',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'form',
  'fieldset', 'legend', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])
const ATTR_WHITELIST = [
  'title', 'type', 'checked', 'name', 'role', 'value', 'placeholder',
  'data-date-format', 'alt', 'aria-label', 'aria-expanded', 'data-state', 'aria-checked',
  'id', 'for', 'target', 'aria-haspopup', 'aria-controls', 'aria-owns', 'contenteditable',
]
export const MAX_NODES = 4000
const MAX_ATTR_LEN = 20

/** The panel host element injected by `content/index.tsx`. Everything inside it
 *  (the FAB, the transcript) is ours and must never be numbered or reported. */
const OWN_DOM_ATTR = 'data-pulsemind-panel'

// ── WeakMap caches ───────────────────────────────────────────────────

// Reassigned at the top of every build (see buildDomTree): the caches exist to
// dedupe the several rect/style reads one element gets within a single walk.
// Kept across builds they go stale the moment the page scrolls or reflows, and
// isTopElement then hit-tests OLD viewport coordinates against the live page —
// elements silently lose (or keep) their numbers on every re-read after a
// scroll. Found by the delta probe: an action → re-read is the common agent
// loop, so per-build freshness is the contract.
let rectCache = new WeakMap<Element, DOMRect | null>()
let styleCache = new WeakMap<Element, CSSStyleDeclaration | null>()

// ── Page memory: persistent refs + the delta baseline ────────────────

/** One serialized output line. `ref` marks a line that carries an interactive
 *  element's `[n]` marker — the delta compares those per-ref exactly and diffs
 *  everything else as plain text. */
interface SerializedLine {
  text: string
  ref?: number
}

/** What this content script remembers about the page it has analyzed: the
 *  persistent ref registry (element → the index minted when first numbered)
 *  and the baseline a `delta` read diffs against. Module state, so a real
 *  navigation starts a fresh page; `resetPageAnalysisState` is the explicit
 *  equivalent for tests and probes. */
interface PageMemory {
  refs: WeakMap<Element, number>
  nextRefId: number
  baseline: { url: string; expansion: number; lines: SerializedLine[] } | null
}

const newPageMemory = (): PageMemory => ({ refs: new WeakMap(), nextRefId: 0, baseline: null })
let memory: PageMemory = newPageMemory()

/** Drop the page memory (persistent refs + delta baseline). A real page gets
 *  this for free when the content script is torn down on navigation; tests and
 *  probes call it between cases. */
export function resetPageAnalysisState(): void {
  memory = newPageMemory()
}

// ── Layout probe ─────────────────────────────────────────────────────

function hasLayout(doc: Document): boolean {
  try {
    const probe = doc.createElement('div')
    probe.style.position = 'absolute'
    probe.style.width = '100px'
    doc.body.appendChild(probe)
    const ok = probe.offsetWidth >= 10
    probe.remove()
    return ok
  } catch {
    return false
  }
}

function getStyle(el: Element): CSSStyleDeclaration | null {
  if (!styleCache.has(el)) {
    let s: CSSStyleDeclaration | null = null
    try { s = window.getComputedStyle(el) } catch { s = null }
    styleCache.set(el, s)
  }
  return styleCache.get(el) ?? null
}

function getRect(el: Element): DOMRect | null {
  if (!rectCache.has(el)) {
    let r: DOMRect | null = null
    try { r = el.getBoundingClientRect() } catch { r = null }
    rectCache.set(el, r)
  }
  return rectCache.get(el) ?? null
}

// ── Visibility / interactivity ───────────────────────────────────────

function isOwnDom(el: Element): boolean {
  return el.hasAttribute?.(OWN_DOM_ATTR) === true
}

/** Own DOM *or* inside it — `closest` works here because the panel lives in a
 *  shadow root whose host sits in the light DOM, so the host is an ancestor. */
function isWithinOwnDom(el: Element): boolean {
  return isOwnDom(el) || el.closest(`[${OWN_DOM_ATTR}]`) !== null
}

/** Hidden in a way that cascades to descendants (display/visibility/aria/hidden
 *  attribute), so the subtree is genuinely absent from the render — the walk may
 *  drop it without losing anything.
 *
 *  Deliberately excludes the zero-size rect test: a container with no box can
 *  still hold absolutely positioned or `display:contents` descendants that do
 *  have one. `<html>`/`<body>` collapse to height 0 whenever every child is
 *  absolutely positioned, and pruning on that alone made such pages read as
 *  empty (real-browser find, M2.6). Use `hasBox` for the element's own
 *  visibility instead. */
function isHidden(el: Element): boolean {
  if (isWithinOwnDom(el)) return true
  if (el.closest('[aria-hidden="true"]')) return true
  if ((el as HTMLElement).hidden) return true
  if (el.getAttribute('type') === 'hidden') return true
  const style = getStyle(el)
  return style !== null && (style.display === 'none' || style.visibility === 'hidden')
}

/** Does this element itself occupy space? Gates what may be *numbered*: a
 *  zero-size element cannot be clicked or typed into, even when its children
 *  can. Without a layout engine every element passes (jsdom). */
function hasBox(el: Element, layout: boolean): boolean {
  if (!layout) return true
  const rect = getRect(el)
  return !!rect && rect.width > 0 && rect.height > 0
}

function isTopElement(el: Element, layout: boolean): boolean {
  if (!layout) return true
  const rect = getRect(el)
  if (!rect) return false
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const top = hitTest(cx, cy, el) || hitTest(rect.left + 2, rect.top + 2, el) || hitTest(rect.right - 2, rect.bottom - 2, el)
  return top === null || top === undefined ? true : top === el || el.contains(top)
}

/** Deepest element at a point, crossing shadow boundaries.
 *
 *  `document.elementFromPoint` stops at a shadow *host*, so a plain comparison
 *  against the element being tested is never true for anything inside a shadow
 *  root and such controls could never be numbered (real-browser find, M2.6).
 *  Descending into `shadowRoot.elementFromPoint` yields the element the click
 *  would really reach. */
const MAX_SHADOW_PIERCE = 10

function hitTest(x: number, y: number, root: Element): Element | null {
  try {
    let hit: Element | null = document.elementFromPoint(x, y)
    for (let depth = 0; depth < MAX_SHADOW_PIERCE; depth += 1) {
      if (!hit) return null
      // Checked at every level: the panel's own shadow content is only
      // reachable from its host, which is the element we must not step through.
      if (isWithinOwnDom(hit)) return null
      const inner: Element | null = hit.shadowRoot ? hit.shadowRoot.elementFromPoint(x, y) : null
      if (!inner || inner === hit) break
      hit = inner
    }
    if (!hit) return null
    // A still-open shadow root means we could not see what is on top (closed
    // root): report unknown rather than claiming the element is unobstructed.
    if (hit.shadowRoot && !hit.shadowRoot.contains(root)) return null
    return hit
  } catch {
    return null
  }
}

// ── Viewport scoping (after page-agent) ──────────────────────────────

/** Any client rect inside the expanded viewport counts; -1 disables scoping. */
function isInExpandedViewport(el: Element, expansion: number, layout: boolean): boolean {
  if (!layout || expansion === -1) return true
  const vw = window.innerWidth
  const vh = window.innerHeight
  try {
    const rects = el.getClientRects()
    if (rects.length > 0) {
      for (const r of rects) {
        if (r.bottom >= -expansion && r.top <= vh + expansion && r.right >= -expansion && r.left <= vw + expansion) return true
      }
      return false
    }
  } catch {
    /* fall through to rect */
  }
  const rect = getRect(el)
  if (!rect) return true
  return rect.bottom >= -expansion && rect.top <= vh + expansion && rect.right >= -expansion && rect.left <= vw + expansion
}

/** Fast reject: fully outside the viewport, not fixed/sticky, and sizeless.
 *  Sized containers continue so their children can still be reached. */
function isOffViewport(el: Element, expansion: number, layout: boolean): boolean {
  if (!layout || expansion === -1) return false
  const vw = window.innerWidth
  const vh = window.innerHeight
  const style = getStyle(el)
  if (style && (style.position === 'fixed' || style.position === 'sticky')) return false
  const he = el as HTMLElement
  if (he.offsetWidth > 0 || he.offsetHeight > 0) return false
  const rect = getRect(el)
  if (!rect) return false
  return rect.bottom < -expansion || rect.top > vh + expansion || rect.right < -expansion || rect.left > vw + expansion
}

function scrollableSize(el: Element): { x: number; y: number } | null {
  const he = el as HTMLElement
  const x = he.scrollWidth - he.clientWidth
  const y = he.scrollHeight - he.clientHeight
  if (x < 4 && y < 4) return null
  return { x, y }
}

function isInteractive(el: Element, layout: boolean): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag === 'option' || tag === 'label') return false
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) {
    if (INTERACTIVE_TAGS.has(tag)) return false
  }
  if (layout) {
    const style = getStyle(el)
    if (style && INTERACTIVE_CURSORS.has(style.cursor)) return true
  }
  if (INTERACTIVE_TAGS.has(tag)) return true
  if ((el as HTMLElement).isContentEditable) return true
  const role = el.getAttribute('role')
  if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'combobox', 'textbox', 'searchbox'].includes(role)) return true
  const cls = `${el.className ?? ''}`
  if (/btn|button|dropdown-toggle/.test(cls) || el.hasAttribute('aria-haspopup') || el.hasAttribute('data-index')) return true
  if (layout) {
    const style = getStyle(el)
    if (style && (style.overflow === 'auto' || style.overflow === 'scroll' ||
      style.overflowY === 'auto' || style.overflowY === 'scroll' ||
      style.overflowX === 'auto' || style.overflowX === 'scroll')) {
      if (scrollableSize(el)) return true
    }
  }
  return false
}

/** Keeps a control and its wrapping label from both taking a number. */
function isDistinctInteraction(el: Element): boolean {
  const parent = el.parentElement
  if (!parent) return true
  const tag = el.tagName.toLowerCase()
  const ptag = parent.tagName.toLowerCase()
  if (ptag === 'label' && ['input', 'select', 'textarea'].includes(tag)) return false
  if (ptag === 'a' && tag === 'img') return false
  return true
}

// ── Text collection ──────────────────────────────────────────────────

function getAllTextTillNextClickable(nodeId: string, tree: FlatDomTree, maxDepth = -1): string {
  const textParts: string[] = []
  const node = tree.map[nodeId]
  if (!node || node.type === 'text') return ''

  const collect = (id: string, depth: number): void => {
    if (maxDepth !== -1 && depth > maxDepth) return
    const n = tree.map[id]
    if (!n) return
    if (n.type === 'text' && n.isVisible) {
      textParts.push(n.text)
    } else if (n.type === 'element' || n.type === 'interactive') {
      for (const childId of n.children) {
        const child = tree.map[childId]
        if (child?.type === 'interactive') continue // stop at the next interactive element
        collect(childId, depth + 1)
      }
    }
  }

  for (const childId of (node as ElementNode | InteractiveElementNode).children) {
    collect(childId, 0)
  }
  return textParts.join('\n').trim()
}

// ── Attribute formatting ─────────────────────────────────────────────

function formatAttrs(attrs: Record<string, string> | undefined): string {
  if (!attrs) return ''
  const seenValues = new Set<string>()
  const out: string[] = []
  for (const name of ATTR_WHITELIST) {
    const raw = attrs[name]
    if (raw == null || raw === '') continue
    const val = raw.length > MAX_ATTR_LEN ? `${raw.slice(0, MAX_ATTR_LEN)}...` : raw
    if (seenValues.has(val)) continue
    seenValues.add(val)
    out.push(`${name}=${val}`)
  }
  return out.join(' ')
}

function getAttributes(el: Element): Record<string, string> | undefined {
  const attrs: Record<string, string> = {}
  let hasAny = false
  for (const name of ATTR_WHITELIST) {
    const raw = el.getAttribute(name)
    if (raw != null && raw !== '') {
      attrs[name] = raw
      hasAny = true
    }
  }
  return hasAny ? attrs : undefined
}

// ── Flat tree build ──────────────────────────────────────────────────

interface BuildState {
  map: Record<string, DomNode>
  visitedShadow: Set<ShadowRoot>
  truncated: boolean
}

function buildFlatTree(root: ParentNode, layout: boolean, viewportExpansion: number): FlatDomTree {
  const state: BuildState = { map: {}, visitedShadow: new Set(), truncated: false }
  let nodeCounter = 0

  function addNode(el: Node, parentId: string | null): string {
    // Hard stop: past MAX_NODES the walk is aborting, not merely skipping, so a
    // pathological page cannot make this linear-in-nodes pipeline hang.
    if (nodeCounter >= MAX_NODES) {
      state.truncated = true
      return ''
    }
    const id = `n${++nodeCounter}`

    if (el.nodeType === Node.TEXT_NODE) {
      const text = (el.textContent ?? '').trim()
      if (!text) return ''
      state.map[id] = { type: 'text', text, isVisible: true, parentId }
      return id
    }

    if (el.nodeType !== Node.ELEMENT_NODE) return ''
    const element = el as Element
    const tag = element.tagName?.toLowerCase()
    if (!tag || SKIP_TAGS.has(tag)) return ''
    if (isHidden(element)) return ''
    if (isOffViewport(element, viewportExpansion, layout)) return ''
    // Boxless containers still get walked (see isHidden); they just never get
    // numbered themselves.
    const selfVisible = hasBox(element, layout)

    const interactive = selfVisible && isInteractive(element, layout) && isTopElement(element, layout) && isDistinctInteraction(element)
    const inViewport = isInExpandedViewport(element, viewportExpansion, layout)
    const highlight = interactive && inViewport
    const isTop = isTopElement(element, layout)
    const scroll = scrollableSize(element)

    if (highlight) {
      // The ref is minted the first time this element is numbered and then
      // never changes — the star marks exactly that minting. A later build
      // reuses it, so indices survive DOM churn (and a removed element's
      // number is retired, never handed to a different element).
      let refId = memory.refs.get(element)
      const isNew = refId === undefined
      if (isNew) {
        memory.nextRefId += 1
        refId = memory.nextRefId
        memory.refs.set(element, refId)
      }

      state.map[id] = {
        type: 'interactive',
        tagName: tag,
        attributes: getAttributes(element),
        children: [],
        isVisible: true,
        isInteractive: true,
        highlightIndex: refId,
        isNew,
        parentId,
        scrollable: scroll ?? undefined,
        ref: element,
        isTop: true,
      }
    } else {
      state.map[id] = {
        type: 'element',
        tagName: tag,
        attributes: getAttributes(element),
        children: [],
        isVisible: true,
        isInteractive: false,
        parentId,
        scrollable: scroll ?? undefined,
        isTop,
      }
    }

    // Shadow DOM piercing (custom-element components).
    if (element.shadowRoot && !state.visitedShadow.has(element.shadowRoot)) {
      state.visitedShadow.add(element.shadowRoot)
      for (const child of Array.from(element.shadowRoot.childNodes)) {
        const childId = addNode(child, id)
        if (childId) (state.map[id] as ElementNode).children.push(childId)
      }
    }

    for (const child of Array.from(element.childNodes)) {
      const childId = addNode(child, id)
      if (childId) (state.map[id] as ElementNode).children.push(childId)
    }

    return id
  }

  const rootId = `n${++nodeCounter}`
  state.map[rootId] = {
    type: 'element',
    tagName: 'root',
    children: [],
    isVisible: true,
    isInteractive: false,
    parentId: null,
  }

  for (const child of Array.from(root.childNodes)) {
    const childId = addNode(child, rootId)
    if (childId) (state.map[rootId] as ElementNode).children.push(childId)
  }

  return { rootId, map: state.map, truncated: state.truncated }
}

// ── Serialization ────────────────────────────────────────────────────

function flatTreeToLines(tree: FlatDomTree): SerializedLine[] {
  const result: SerializedLine[] = []

  /** An interactive ancestor already prints this text on its own `[n]` line. */
  function hasInteractiveAncestor(nodeId: string): boolean {
    let cur = tree.map[nodeId]?.parentId
    while (cur) {
      const n = tree.map[cur]
      if (n && n.type === 'interactive') return true
      cur = n?.parentId ?? null
    }
    return false
  }

  function processNode(nodeId: string, depth: number): void {
    const node = tree.map[nodeId]
    if (!node) return

    if (node.type === 'text') {
      if (hasInteractiveAncestor(nodeId)) return
      const parent = node.parentId ? tree.map[node.parentId] : null
      if (parent && (parent.type === 'element' || parent.type === 'interactive') && parent.isVisible && parent.isTop !== false) {
        result.push({ text: `${'\t'.repeat(depth)}${node.text}` })
      }
      return
    }

    if (node.type === 'interactive') {
      const attrs = formatAttrs(node.attributes)
      const scrollAttr = node.scrollable ? ` data-scrollable="x=${node.scrollable.x},y=${node.scrollable.y}"` : ''
      const prefix = node.isNew ? `*[${node.highlightIndex}]` : `[${node.highlightIndex}]`
      const text = getAllTextTillNextClickable(nodeId, tree)
      result.push({ text: `${'\t'.repeat(depth)}${prefix}<${node.tagName}${attrs ? ' ' + attrs : ''}${scrollAttr}>${text} />`, ref: node.highlightIndex })
      for (const childId of node.children) processNode(childId, depth + 1)
      return
    }

    if (SEMANTIC_TAGS.has(node.tagName)) {
      result.push({ text: `${'\t'.repeat(depth)}<${node.tagName}>` })
      for (const childId of node.children) processNode(childId, depth + 1)
      result.push({ text: `${'\t'.repeat(depth)}</${node.tagName}>` })
      return
    }

    // Layout-only wrappers collapse: children keep the parent's indent level.
    if (SKIPPABLE_TAGS.has(node.tagName)) {
      for (const childId of node.children) processNode(childId, depth)
      return
    }

    const attrs = formatAttrs(node.attributes)
    const scrollAttr = node.scrollable ? ` data-scrollable="x=${node.scrollable.x},y=${node.scrollable.y}"` : ''
    result.push({ text: `${'\t'.repeat(depth)}<${node.tagName}${attrs ? ' ' + attrs : ''}${scrollAttr}>` })
    for (const childId of node.children) processNode(childId, depth + 1)
    result.push({ text: `${'\t'.repeat(depth)}</${node.tagName}>` })
  }

  processNode(tree.rootId, 0)
  return result
}

// ── Delta reads ──────────────────────────────────────────────────────

interface LineDiff {
  /** Refs whose line is byte-identical to the baseline. */
  unchanged: number
  /** Refs absent from the baseline (minted since, or newly in scope). */
  added: string[]
  /** Refs present in both, with a different line (attribute or text changed). */
  changed: string[]
  /** Baseline refs that no longer serialize. */
  removed: string[]
  addedText: string[]
  removedText: string[]
}

function diffLines(next: SerializedLine[], prev: SerializedLine[]): LineDiff {
  const prevByRef = new Map<number, string>()
  for (const l of prev) if (l.ref !== undefined) prevByRef.set(l.ref, l.text)
  const nextByRef = new Map<number, string>()
  for (const l of next) if (l.ref !== undefined) nextByRef.set(l.ref, l.text)

  const diff: LineDiff = { unchanged: 0, added: [], changed: [], removed: [], addedText: [], removedText: [] }
  for (const l of next) {
    if (l.ref === undefined) continue
    const before = prevByRef.get(l.ref)
    if (before === undefined) diff.added.push(l.text)
    else if (before === l.text) diff.unchanged += 1
    else diff.changed.push(l.text)
  }
  for (const [ref, text] of prevByRef) {
    if (!nextByRef.has(ref)) diff.removed.push(`${text}（已消失）`)
  }

  /** Lines of `next` beyond the shared multiset of `prev` — order kept,
   *  duplicates counted, O(n). */
  const surplus = (nextTexts: string[], prevTexts: string[]): string[] => {
    const counts = new Map<string, number>()
    for (const t of prevTexts) counts.set(t, (counts.get(t) ?? 0) + 1)
    const out: string[] = []
    for (const t of nextTexts) {
      const left = counts.get(t) ?? 0
      if (left > 0) counts.set(t, left - 1)
      else out.push(t)
    }
    return out
  }
  const plain = (lines: SerializedLine[]): string[] => lines.filter((l) => l.ref === undefined).map((l) => l.text)
  diff.addedText = surplus(plain(next), plain(prev))
  diff.removedText = surplus(plain(prev), plain(next))
  return diff
}

/** Past this share of the full body a delta stops being cheaper than the full
 *  view, and the caller falls back — a diff that lists most of the page is the
 *  full page plus overhead. */
const DELTA_FULL_FALLBACK_RATIO = 0.6
/** Per-section output cap, so one pathological change (a table re-rendering
 *  row by row) cannot flood the model on its own. */
const DELTA_MAX_LISTED = 40

/** Render the diff as the delta view's body, or null when the caller should
 *  print the full body instead. An empty diff still renders — "nothing
 *  changed, your indices are valid" is exactly what saves the re-read. */
function renderDelta(diff: LineDiff, totalLines: number): string | null {
  const listed = diff.added.length + diff.changed.length + diff.removed.length + diff.addedText.length + diff.removedText.length
  if (listed === 0) {
    return `[增量视图] 页面自上次读取以来无变化（${diff.unchanged} 个元素一致）。已有索引全部有效，可直接继续操作。`
  }
  if (listed > totalLines * DELTA_FULL_FALLBACK_RATIO) return null

  const capped = (lines: string[]): string[] =>
    lines.length <= DELTA_MAX_LISTED ? lines : [...lines.slice(0, DELTA_MAX_LISTED), `…（其余 ${lines.length - DELTA_MAX_LISTED} 行省略）`]
  const out: string[] = [
    `[增量视图] 自上次读取以来的变化。未变化的 ${diff.unchanged} 个元素未列出，其索引仍然有效（首次读取、页面跳转或变化过大时返回全量）。`,
  ]
  out.push(...capped(diff.added).map((t) => `+ ${t}`))
  out.push(...capped(diff.changed).map((t) => `~ ${t}`))
  out.push(...capped(diff.removed).map((t) => `- ${t}`))
  out.push(...capped(diff.addedText).map((t) => `+ ${t}`))
  out.push(...capped(diff.removedText).map((t) => `- ${t}`))
  return out.join('\n')
}

// ── Page info ────────────────────────────────────────────────────────

function getPageInfo(): {
  viewportWidth: number
  viewportHeight: number
  pageWidth: number
  pageHeight: number
  pixelsAbove: number
  pixelsBelow: number
  pagesAbove: number
  pagesBelow: number
  totalPages: number
  currentPagePosition: number
} {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const pageWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0
  const pixelsBelow = Math.max(0, pageHeight - (window.innerHeight + scrollY))

  return {
    viewportWidth,
    viewportHeight,
    pageWidth,
    pageHeight,
    pixelsAbove: scrollY,
    pixelsBelow,
    pagesAbove: viewportHeight > 0 ? scrollY / viewportHeight : 0,
    pagesBelow: viewportHeight > 0 ? pixelsBelow / viewportHeight : 0,
    totalPages: viewportHeight > 0 ? pageHeight / viewportHeight : 0,
    currentPagePosition: scrollY / Math.max(1, pageHeight - viewportHeight),
  }
}

// ── Public interface ─────────────────────────────────────────────────

export interface BuildResult {
  text: string
  selectorMap: Map<number, Element>
  /** True when the node cap cut the walk short — the caller says so, rather
   *  than letting the model believe it saw the whole page. */
  truncated: boolean
}

export interface BuildDomTreeOptions {
  /** Viewport margin in px (default 0). -1 disables viewport scoping entirely. */
  viewportExpansion?: number
  /** Diff against the previous build of the same page: the full walk still
   *  runs (visibility, occlusion and scrollability are layout facts), but the
   *  output lists only what changed. Falls back to the full view when there is
   *  no comparable baseline — first read, URL or `viewportExpansion` changed,
   *  the walk truncated — or when the diff would cost more than the full body. */
  delta?: boolean
}

/**
 * `viewportExpansion` scopes which elements may be **numbered** (i.e. acted on),
 * not which text is returned. The full page text always comes back so a single
 * read can answer "总结这个页面"; scrolling then re-reading is only needed to
 * obtain indices for elements that were out of view. Measured on a 5600px
 * fixture, a viewport read is no cheaper than a full read — the numbers shrink,
 * the prose does not — which is the intended trade (M2.6).
 */
export function buildDomTree(root: ParentNode = document, opts?: BuildDomTreeOptions): BuildResult {
  const doc = root instanceof Document ? root : root.ownerDocument ?? document
  const layout = hasLayout(doc)
  const viewportExpansion = opts?.viewportExpansion ?? 0

  rectCache = new WeakMap()
  styleCache = new WeakMap()

  const tree = buildFlatTree(root, layout, viewportExpansion)
  const lines = flatTreeToLines(tree)
  const content = lines.map((l) => l.text).join('\n')

  const selectorMap = new Map<number, Element>()
  for (const node of Object.values(tree.map)) {
    if (node.type === 'interactive') selectorMap.set(node.highlightIndex, node.ref)
  }

  // The next delta's baseline — refreshed on every build, whatever this call
  // ends up printing, so a delta always compares against the freshest view.
  // The `*[n]` star is presentation (minted this build) and must not read as a
  // change on the next diff, so the baseline stores lines without it.
  const url = location.href
  const prevBaseline = memory.baseline
  memory.baseline = {
    url,
    expansion: viewportExpansion,
    lines: lines.map((l) => (l.ref !== undefined ? { ...l, text: l.text.replace(/^(\t*)\*\[/, '$1[') } : l)),
  }

  // A delta is only attempted against a comparable baseline: same document,
  // same scoping (a different expansion numbers a different set, which would
  // read wholesale as "added"), and a walk not cut short by the node cap —
  // against a truncated baseline everything past the cap would read as added.
  let bodyText = content
  if (
    opts?.delta === true &&
    prevBaseline !== null &&
    !tree.truncated &&
    prevBaseline.url === url &&
    prevBaseline.expansion === viewportExpansion
  ) {
    const delta = renderDelta(diffLines(lines, prevBaseline.lines), lines.length)
    if (delta !== null) bodyText = delta
  }

  const pi = getPageInfo()
  const titleLine = `Current Page: [${document.title}](${location.href})`
  const pageInfoLine = `Page info: ${pi.viewportWidth}x${pi.viewportHeight}px viewport, ${pi.pageWidth}x${pi.pageHeight}px total page size, ${pi.pagesAbove.toFixed(1)} pages above, ${pi.pagesBelow.toFixed(1)} pages below, ${pi.totalPages.toFixed(1)} total pages, at ${(pi.currentPagePosition * 100).toFixed(0)}% of page`
  const scopeLabel = viewportExpansion === -1
    ? 'Interactive elements from top layer of the current page (full page):'
    : `Interactive elements from top layer of the current viewport${viewportExpansion > 0 ? ` (+${viewportExpansion}px margin)` : ''}:`
  const scrollHintAbove = pi.pixelsAbove > 4
    ? `... ${pi.pixelsAbove} pixels above (${pi.pagesAbove.toFixed(1)} pages) - scroll to see more ...`
    : '[Start of page]'
  const header = `${titleLine}\n${pageInfoLine}\n\n${scopeLabel}\n\n${scrollHintAbove}`

  const scrollHintBelow = pi.pixelsBelow > 4
    ? `... ${pi.pixelsBelow} pixels below (${pi.pagesBelow.toFixed(1)} pages) - scroll to see more ...`
    : '[End of page]'
  const footerParts: string[] = [scrollHintBelow]
  if (tree.truncated) footerParts.push(`[warn] 节点数超过 ${MAX_NODES}，已截断——请用 page_scroll 滚动后分段读取`)
  if (!tree.truncated && viewportExpansion !== -1 && pi.pixelsBelow > 4) {
    // Text is never viewport-scoped (see the note on buildDomTree): only the
    // numbered/actionable set is. Say so, or the model reads the missing index
    // as a missing element.
    footerParts.push('[hint] 视口外的元素不带编号——需要操作它们时先 page_scroll 滚动，再调用 page_get_content 取新索引')
  }

  const text = bodyText === content
    ? [header, content, ...footerParts].join('\n')
    : [titleLine, pageInfoLine, '', bodyText, '', ...footerParts].join('\n')

  return { text, selectorMap, truncated: tree.truncated }
}
