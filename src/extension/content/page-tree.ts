/**
 * Page DOM analysis pipeline (PLAN-browser-extension M2.1, ported from
 * Anywhere `packages/extension/src/content/dom-tree.ts`).
 *
 * Flat-DOM-tree approach (after page-agent):
 *   - walk visible elements, build a flat DOM tree
 *   - number the interactive ones [n]
 *   - serialize to compact text (attribute whitelist + dedupe + descendant text)
 *   - selectorMap: index → element reference, so the action executors can act
 *     without xpath
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

const rectCache = new WeakMap<Element, DOMRect | null>()
const styleCache = new WeakMap<Element, CSSStyleDeclaration | null>()
/** Elements already seen in a previous build of this document: anything absent
 *  from it is new. Keyed by element, so it cannot leak across page loads. */
const seenElements = new WeakMap<Element, true>()

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
  counter: number
  visitedShadow: Set<ShadowRoot>
  truncated: boolean
}

function buildFlatTree(root: ParentNode, layout: boolean, viewportExpansion: number): FlatDomTree {
  const state: BuildState = { map: {}, counter: 0, visitedShadow: new Set(), truncated: false }
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
      state.counter += 1
      const isNew = !seenElements.has(element)
      if (isNew) seenElements.set(element, true)

      state.map[id] = {
        type: 'interactive',
        tagName: tag,
        attributes: getAttributes(element),
        children: [],
        isVisible: true,
        isInteractive: true,
        highlightIndex: state.counter,
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

function flatTreeToString(tree: FlatDomTree): string {
  const result: string[] = []

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
        result.push(`${'\t'.repeat(depth)}${node.text}`)
      }
      return
    }

    if (node.type === 'interactive') {
      const attrs = formatAttrs(node.attributes)
      const scrollAttr = node.scrollable ? ` data-scrollable="x=${node.scrollable.x},y=${node.scrollable.y}"` : ''
      const prefix = node.isNew ? `*[${node.highlightIndex}]` : `[${node.highlightIndex}]`
      const text = getAllTextTillNextClickable(nodeId, tree)
      result.push(`${'\t'.repeat(depth)}${prefix}<${node.tagName}${attrs ? ' ' + attrs : ''}${scrollAttr}>${text} />`)
      for (const childId of node.children) processNode(childId, depth + 1)
      return
    }

    if (SEMANTIC_TAGS.has(node.tagName)) {
      result.push(`${'\t'.repeat(depth)}<${node.tagName}>`)
      for (const childId of node.children) processNode(childId, depth + 1)
      result.push(`${'\t'.repeat(depth)}</${node.tagName}>`)
      return
    }

    // Layout-only wrappers collapse: children keep the parent's indent level.
    if (SKIPPABLE_TAGS.has(node.tagName)) {
      for (const childId of node.children) processNode(childId, depth)
      return
    }

    const attrs = formatAttrs(node.attributes)
    const scrollAttr = node.scrollable ? ` data-scrollable="x=${node.scrollable.x},y=${node.scrollable.y}"` : ''
    result.push(`${'\t'.repeat(depth)}<${node.tagName}${attrs ? ' ' + attrs : ''}${scrollAttr}>`)
    for (const childId of node.children) processNode(childId, depth + 1)
    result.push(`${'\t'.repeat(depth)}</${node.tagName}>`)
  }

  processNode(tree.rootId, 0)
  return result.join('\n')
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

  const tree = buildFlatTree(root, layout, viewportExpansion)
  const content = flatTreeToString(tree)

  const selectorMap = new Map<number, Element>()
  for (const node of Object.values(tree.map)) {
    if (node.type === 'interactive') selectorMap.set(node.highlightIndex, node.ref)
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

  return { text: [header, content, ...footerParts].join('\n'), selectorMap, truncated: tree.truncated }
}
