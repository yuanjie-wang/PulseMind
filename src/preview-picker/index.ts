// ── In-frame element picker (PLAN-html-element-edit §3) ──
// This module is bundled to an IIFE by scripts/build-preview-picker.mjs and
// injected verbatim into every `local-file://…?pmPreview=1` HTML preview
// (see src/main/preview/serve-preview.ts). It never ships in the renderer
// bundle and must not import anything DOM-free modules rely on beyond
// src/shared — everything here runs inside the PAGE's frame.
//
// The frame is sandboxed (opaque origin): the only channel to the parent is
// window.parent.postMessage. The overlay lives in a shadow root the page's
// CSS cannot reach; every overlay surface is pointer-events:none so hover
// and click fall through to the page, and the picker's own nodes (the
// injected <script> and the overlay host) are excluded from pmPath indices
// so paths built here match the untouched disk source (D4).

import {
  formatPmPath,
  parsePmPath,
  PM_PICKER_SCRIPT_ID,
  PM_PICKER_HOST_ID,
  type PmPathSegment,
} from '../shared/html-edit/pm-path'
import { isInPlaceEditableCategory } from '../shared/html-edit/categories'
import type { ComputedSnapshot, ElementAncestor, ElementRect, FrameToParentPayload, ParentToFrameMessage } from '../shared/html-edit/messages'

// The computed-style properties reported with a selection; the typed controls
// in ElementEditPanel initialize their inputs from these.
const COMPUTED_KEYS = [
  'font-size', 'font-weight', 'color', 'background-color', 'text-align', 'line-height',
  'border-radius', 'padding', 'margin', 'width', 'height', 'border-width', 'border-color',
  'border-style', 'list-style-type',
] as const

const MAX_TEXT_LEN = 400

// The parent's per-mount nonce (review 2026-09-18 M9): buildPreviewCopy
// replaces the token with the real value before serving, and the parent
// drops every pm:* message whose nonce differs. The page's own scripts share
// this realm — which is exactly why the script element carrying the value is
// scrubbed below, synchronously, before any page observer can run: mutation
// observers are delivered at the next microtask checkpoint, after this IIFE
// has already finished.
const PM_NONCE = '__PM_NONCE__'

// Scrub FIRST — nothing else in this file may run before the nonce's carrier
// is out of the DOM.
try {
  const self = document.currentScript
  if (self) {
    self.textContent = ''
    self.remove()
  }
} catch {
  /* nothing to scrub (already removed / detached execution) */
}

function isPickerNode(el: Element): boolean {
  return el.id === PM_PICKER_SCRIPT_ID || el.id === PM_PICKER_HOST_ID
}

function elementIndexAmongSiblings(el: Element): number {
  const parent = el.parentElement
  if (!parent) return 1
  let index = 0
  for (const child of Array.from(parent.children)) {
    if (isPickerNode(child)) continue
    index += 1
    if (child === el) return index
  }
  return index
}

/** The pmPath of `el`, walking up to <html>. Picker nodes are skipped in
 *  every sibling count. */
function buildPmPath(el: Element): string {
  const chain: Element[] = []
  let cur: Element | null = el
  while (cur) {
    chain.unshift(cur)
    cur = cur.parentElement
  }
  const segments: PmPathSegment[] = chain.map((node, i) => ({
    tag: node.tagName.toLowerCase(),
    index: i === 0 ? 1 : elementIndexAmongSiblings(node),
  }))
  return formatPmPath(segments)
}

/** Inverse of buildPmPath: find the live element a pmPath names. Returned
 *  as HTMLElement — every style/text edit below needs the inline-style and
 *  innerHTML surface, which only HTML elements carry. */
function findByPmPath(path: string): HTMLElement | null {
  const segments = parsePmPath(path)
  if (!segments || segments.length === 0) return null
  let node: Element = document.documentElement
  if (!node || node.tagName.toLowerCase() !== segments[0].tag) return null
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]
    const children = Array.from(node.children).filter((c) => !isPickerNode(c))
    const next = children[seg.index - 1]
    if (!next || next.tagName.toLowerCase() !== seg.tag) return null
    node = next
  }
  return node as HTMLElement
}

function ancestorChain(el: Element): ElementAncestor[] {
  const chain: ElementAncestor[] = []
  let cur: Element | null = el
  while (cur) {
    chain.unshift({
      tag: cur.tagName.toLowerCase(),
      id: cur.id || null,
      classes: Array.from(cur.classList),
      pmPath: buildPmPath(cur),
    })
    cur = cur.parentElement
  }
  return chain
}

function rectOf(el: Element): ElementRect {
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    w: rect.width,
    h: rect.height,
  }
}

function computedSnapshot(el: Element): ComputedSnapshot {
  const style = window.getComputedStyle(el)
  const snapshot: ComputedSnapshot = {}
  for (const key of COMPUTED_KEYS) snapshot[key] = style.getPropertyValue(key)
  return snapshot
}

function post(message: FrameToParentPayload): void {
  try {
    window.parent.postMessage({ ...message, nonce: PM_NONCE }, '*')
  } catch {
    /* the parent may be gone (navigation) — nothing to do */
  }
}

// ── Overlay (shadow root the page CSS cannot touch) ──

const host = document.createElement('div')
host.id = PM_PICKER_HOST_ID
host.style.all = 'initial'
const shadow = host.attachShadow({ mode: 'closed' })
const style = document.createElement('style')
style.textContent = `
  :host { all: initial; }
  .pm-overlay {
    position: absolute; top: 0; left: 0; z-index: 2147483647;
    pointer-events: none;
    font: 11px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .pm-box { position: absolute; display: none; box-sizing: border-box; }
  .pm-box.hover { outline: 1.5px solid rgba(22, 119, 255, 0.85); background: rgba(22, 119, 255, 0.08); }
  .pm-box.selected { outline: 2px solid #fa8c16; background: rgba(250, 140, 22, 0.06); }
  .pm-label {
    position: absolute; display: none; padding: 1px 6px; border-radius: 4px;
    background: #fa8c16; color: #fff; white-space: nowrap; transform: translateY(-100%);
  }
  .pm-toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    display: none; padding: 5px 12px; border-radius: 6px; max-width: 80%;
    background: rgba(0, 0, 0, 0.75); color: #fff; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
`
const overlay = document.createElement('div')
overlay.className = 'pm-overlay'
const hoverBox = document.createElement('div')
hoverBox.className = 'pm-box hover'
const selectedBox = document.createElement('div')
selectedBox.className = 'pm-box selected'
const label = document.createElement('div')
label.className = 'pm-label'
const toast = document.createElement('div')
toast.className = 'pm-toast'
overlay.append(hoverBox, selectedBox, label)
shadow.append(style, overlay, toast)

function sizeOverlay(): void {
  overlay.style.width = `${document.documentElement.scrollWidth}px`
  overlay.style.height = `${document.documentElement.scrollHeight}px`
}

function placeBox(box: HTMLElement, rect: ElementRect): void {
  box.style.display = 'block'
  box.style.left = `${rect.x}px`
  box.style.top = `${rect.y}px`
  box.style.width = `${rect.w}px`
  box.style.height = `${rect.h}px`
}

function placeLabel(rect: ElementRect, text: string): void {
  label.style.display = 'block'
  label.style.left = `${rect.x}px`
  label.style.top = `${Math.max(rect.y, 14)}px`
  label.textContent = text
}

let toastTimer: number | undefined
function showToast(text: string): void {
  toast.textContent = text
  toast.style.display = 'block'
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.style.display = 'none'
  }, 2000)
}

// ── State ──

let modeOn = true
let hovered: Element | null = null
let selected: Element | null = null
let editing = false
let editingOriginalHtml = ''

function hideHover(): void {
  hovered = null
  hoverBox.style.display = 'none'
}

function redrawSelection(): void {
  if (!selected) return
  const rect = rectOf(selected)
  placeBox(selectedBox, rect)
  const tag = selected.tagName.toLowerCase()
  placeLabel(rect, `${tag} · ${Math.round(rect.w)}×${Math.round(rect.h)}`)
}

function reportSelection(el: Element): void {
  post({
    type: 'pm:select',
    pmPath: buildPmPath(el),
    tag: el.tagName.toLowerCase(),
    rect: rectOf(el),
    text: (el.textContent ?? '').trim().slice(0, MAX_TEXT_LEN),
    ancestors: ancestorChain(el),
    computed: computedSnapshot(el),
  })
}

function select(el: Element): void {
  selected = el
  editing = false
  redrawSelection()
  reportSelection(el)
}

function deselect(silent = false): void {
  selected = null
  selectedBox.style.display = 'none'
  label.style.display = 'none'
  if (!silent) post({ type: 'pm:deselect' })
}

// ── In-place text editing (D7) ──

function exitEditing(commit: boolean): void {
  if (!editing || !selected) return
  editing = false
  const el = selected as HTMLElement
  el.removeEventListener('blur', onBlur)
  el.removeEventListener('keydown', onEditKeydown)
  el.contentEditable = 'false'
  if (commit) {
    post({ type: 'pm:commit-text', pmPath: buildPmPath(el), html: el.innerHTML })
  } else {
    el.innerHTML = editingOriginalHtml
    redrawSelection()
  }
}

function onBlur(): void {
  // A blur that is not our own commit path (Enter) is still a commit: the
  // plan's submit granularity is blur/Enter, never per keystroke (D5).
  exitEditing(true)
}

function onEditKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    exitEditing(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    exitEditing(false)
  }
}

function enableEditing(target: Element): void {
  const el = target as HTMLElement
  const forbidden = el.querySelectorAll('script, style, template')
  if (forbidden.length > 0) {
    showToast('该元素包含脚本或样式子节点，请在面板或 AI 中编辑')
    return
  }
  editingOriginalHtml = el.innerHTML
  editing = true
  el.contentEditable = 'true'
  el.addEventListener('blur', onBlur)
  el.addEventListener('keydown', onEditKeydown)
  el.focus()
}

// ── Event wiring ──

document.addEventListener('mousemove', (e) => {
  if (!modeOn || editing) return
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (!target || isPickerNode(target) || target === hovered) return
  hovered = target
  if (selected && target === selected) {
    hoverBox.style.display = 'none'
    return
  }
  placeBox(hoverBox, rectOf(target))
}, { capture: true })

document.addEventListener(
  'click',
  (e) => {
    if (!modeOn) return
    const anchor = (e.target as Element | null)?.closest?.('a')
    if (anchor) {
      // D10: the picker must not survive a navigation it cannot follow —
      // block in-frame link jumps while editing.
      e.preventDefault()
      e.stopPropagation()
      showToast('已阻止链接跳转（元素编辑模式中）')
    }
    // A click while in-place editing is the user repositioning the caret,
    // never a reselect: select() would flip `editing` back to false and the
    // pending blur/Enter commit would die in exitEditing's early-return —
    // everything typed stays in the live DOM only and a reload discards it
    // (measured 2026-09-18: type → click mid-text → Enter writes nothing).
    // A click OUTSIDE has already committed through its mousedown blur by
    // the time this event runs, so selecting the new target still works.
    if (editing) return
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (!target || isPickerNode(target)) return
    select(target)
  },
  { capture: true },
)

document.addEventListener(
  'submit',
  (e) => {
    if (!modeOn) return
    e.preventDefault()
    e.stopPropagation()
    showToast('已阻止表单提交（元素编辑模式中）')
  },
  { capture: true },
)

// Double-click = direct text editing (D7, user ask 2026-09-18: 文字类元素能
// 直接编辑文字). The picker does NOT flip contenteditable itself: whether the
// element exists in the DISK source is parent-side knowledge, and an
// unresolvable element would only take the user's typed text into a commit
// that refuses and reloads it away. So: ask the parent (pm:request-edit);
// it enables editing back (pm:enable-edit) or explains the refusal.
document.addEventListener(
  'dblclick',
  (e) => {
    if (!modeOn || editing) return
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (!target || isPickerNode(target)) return
    if (!isInPlaceEditableCategory(target.tagName.toLowerCase(), target.children.length)) return
    select(target)
    post({ type: 'pm:request-edit', pmPath: buildPmPath(target) })
  },
  { capture: true },
)

document.addEventListener(
  'keydown',
  (e) => {
    if (!modeOn || editing) return
    if (e.key === 'Escape' && selected) {
      deselect()
      e.stopPropagation()
    }
  },
  { capture: true },
)

let scrollTimer: number | undefined
window.addEventListener('scroll', () => {
  sizeOverlay()
  redrawSelection()
  if (scrollTimer !== undefined) return
  scrollTimer = window.setTimeout(() => {
    scrollTimer = undefined
    post({ type: 'pm:scroll', y: window.scrollY })
  }, 150)
}, { capture: true, passive: true })

window.addEventListener('resize', () => {
  sizeOverlay()
  redrawSelection()
})

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as ParentToFrameMessage | null
  if (!data || typeof data.type !== 'string' || !data.type.startsWith('pm:')) return
  switch (data.type) {
    case 'pm:mode':
      modeOn = data.on
      if (!modeOn) {
        hideHover()
        deselect(true)
      }
      break
    case 'pm:apply-style': {
      const el = findByPmPath(data.pmPath)
      if (!el) break
      for (const [prop, value] of Object.entries(data.decls)) {
        if (value === null) el.style.removeProperty(prop)
        else el.style.setProperty(prop, value)
      }
      redrawSelection()
      if (selected === el) reportSelection(el)
      break
    }

    case 'pm:apply-attrs': {
      const el = findByPmPath(data.pmPath)
      if (!el) break
      for (const [name, value] of Object.entries(data.attrs)) {
        if (value === null) el.removeAttribute(name)
        else el.setAttribute(name, value)
      }
      if (selected === el) reportSelection(el)
      break
    }
    case 'pm:apply-text': {
      const el = findByPmPath(data.pmPath)
      if (!el) break
      el.innerHTML = data.html
      redrawSelection()
      if (selected === el) reportSelection(el)
      break
    }
    case 'pm:enable-edit': {
      const el = findByPmPath(data.pmPath)
      if (el) enableEditing(el)
      break
    }
    case 'pm:reselect': {
      const el = findByPmPath(data.pmPath)
      if (el) select(el)
      else {
        deselect(true)
        post({ type: 'pm:deselect' })
      }
      break
    }
    case 'pm:scroll-to':
      window.scrollTo(0, data.y)
      break
  }
})

// ── Boot ──

function boot(): void {
  document.body?.appendChild(host)
  sizeOverlay()
  post({ type: 'pm:ready' })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}
