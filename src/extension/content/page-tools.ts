/**
 * `page_*` action executors, content-script side (PLAN-browser-extension M2.3).
 *
 * Locates elements through the `selectorMap` that the last `page_get_content`
 * produced, then clicks / types / selects / scrolls them. Indices are
 * PERSISTENT refs (page-tree.ts page memory): an element keeps its number for
 * the life of the page, so the model can chain actions across reads without
 * re-reading, and a removed element fails loudly through the `isConnected`
 * guard instead of silently doing nothing. `page_get_content` takes
 * `delta: true` to print only what changed since the previous read.
 *
 * Ported from Anywhere `content/dom-tools.ts` with three additions: a real
 * pointer/mouse event sequence for clicks, `page_select` option matching by
 * value/text/label, and the truncation flag from the DOM pipeline.
 */
import { buildDomTree, resetPageAnalysisState } from './page-tree'
import { isCspEvalError, runInPage, serializeResult } from './page-js'
import type { PageToolOutcome } from '../bridge'

/** Elements of the most recent `page_get_content`, keyed by the page URL they
 *  were built for — an SPA URL change invalidates them wholesale; a real
 *  navigation tears the content script (and the page memory) down with it. */
let cached: { map: Map<number, Element>; url: string } | null = null

const STALE_HINT = '（索引在页面存续期间保持稳定；如报错失效或想查看页面变化，请重新调用 page_get_content，传 delta:true 只返回增量）'

function elementAt(index: unknown): HTMLElement {
  const i = Number(index)
  if (!Number.isInteger(i) || i < 1) throw new Error(`无效的元素索引: ${index}`)
  const el = getSelectorMap().get(i)
  if (!el) {
    throw new Error(
      `索引 ${i} 不存在或已失效——请先调用 page_get_content 获取当前页面状态（索引在页面存续期间稳定，跳转后从新页面重新编号）`,
    )
  }
  // The map holds strong references, so a removed element would otherwise stay
  // actionable: clicking a detached node is a silent no-op, which is exactly
  // the "clicked and nothing happened" failure this guard turns loud.
  if (!el.isConnected) {
    throw new Error(`索引 ${i} 指向的元素已从页面移除——请重新调用 page_get_content 获取当前页面状态`)
  }
  return el as HTMLElement
}

function getSelectorMap(): Map<number, Element> {
  const url = location.href
  if (!cached || cached.url !== url) cached = null
  return cached?.map ?? new Map()
}

/** React 兼容输入：原生 setter 绕过受控组件的 value 拦截，再派发 input/change。 */
/** Push a value through the element's OWN realm prototype (full_20261011
 *  M13-P1-1): a same-origin iframe's wrappers answer to the frame's
 *  constructors, so the top-realm `instanceof` used to miss and the native
 *  value setter must come from the frame's prototype. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const win = (el.ownerDocument?.defaultView ?? window) as typeof window
  const isTextarea = el instanceof (win.HTMLTextAreaElement ?? HTMLTextAreaElement)
  const proto = isTextarea
    ? (win.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype
    : (win.HTMLInputElement ?? HTMLInputElement).prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// ── Read tools ───────────────────────────────────────────────────────

export function pageGetContent(args: Record<string, unknown>): string {
  const raw = args?.viewportExpansion
  const expansion = raw === undefined || raw === null ? 0 : Number(raw)
  const { text, selectorMap } = buildDomTree(document, {
    viewportExpansion: Number.isFinite(expansion) ? expansion : 0,
    delta: args?.delta === true,
  })
  cached = { map: selectorMap, url: location.href }
  return text
}

export function pageScroll(args: Record<string, unknown>): string {
  const down = args?.down !== false
  const sign = down ? 1 : -1
  const pixels = Number(args?.pixels)
  const pages = Number(args?.pages)
  const delta =
    Number.isFinite(pixels) && pixels > 0
      ? sign * pixels
      : sign * Math.round(window.innerHeight * (Number.isFinite(pages) && pages > 0 ? pages : 1))

  let target = '窗口'
  if (args?.index !== undefined) {
    const el = elementAt(args.index)
    el.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior })
    target = `[${args.index}] <${el.tagName.toLowerCase()}>`
  } else {
    window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior })
  }
  return `已滚动 ${target} ${delta > 0 ? '向下' : '向上'} ${Math.abs(delta)}px。位置变化后请再次调用 page_get_content 查看新露出的元素（可传 delta:true 只取增量）。`
}

export function pageWait(args: Record<string, unknown>): Promise<string> {
  const seconds = Math.min(10, Math.max(1, Number(args?.seconds) || 2))
  const selector = typeof args?.selector === 'string' ? args.selector.trim() : ''
  if (selector) {
    // 选法错误是调用方输入错误，必须在同步路径上响亮失败（runPageTool 转
    // ok:false），而不是吃掉整个预算后报「未出现」。
    try {
      document.querySelector(selector)
    } catch (err) {
      throw new Error(`无效的选择器 "${selector}"：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return new Promise<string>((resolve) => {
    if (!selector) {
      setTimeout(() => resolve(`已等待 ${seconds}s。请调用 page_get_content 查看是否已渲染完成。`), seconds * 1000)
      return
    }
    // 条件等待（2026-11-12）：轮询 querySelector，元素出现即刻返回——比死等
    // 省时间；到点未现是「观察结果」不是工具失败，模型据此决定重读、换选择
    // 器还是放弃。
    const started = Date.now()
    const budgetMs = seconds * 1000
    const poll = (): void => {
      if (document.querySelector(selector)) {
        resolve(`元素 "${selector}" 已出现（等待了 ${((Date.now() - started) / 1000).toFixed(1)}s）。请调用 page_get_content 查看页面。`)
        return
      }
      if (Date.now() - started >= budgetMs) {
        resolve(`已等待 ${seconds}s，"${selector}" 仍未出现。请调用 page_get_content 查看当前页面状态。`)
        return
      }
      setTimeout(poll, 200)
    }
    poll()
  })
}

// ── Write tools ──────────────────────────────────────────────────────

/** A full pointer/mouse down+up sequence, then a real `click()` so the
 *  browser's default action (navigate / submit / toggle) still happens.
 *  Component libraries that only listen to mousedown or pointerdown need the
 *  synthetic part; `<a href>` and form submits need the real one.
 *
 *  Each event is dispatched through `fire`, which lets one unsupported
 *  constructor (older engines, test DOMs) fail without aborting the rest of the
 *  sequence — the real click at the end is the load-bearing one. */
function clickSequence(el: HTMLElement): void {
  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* detached ancestor */ }
  try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }

  const rect = el.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
  // `view` may only be a real Window — the constructor brand-checks it, and a
  // test DOM's global is a plain object, so omit it rather than fail the
  // dispatch. Nothing in this sequence depends on `view` being set.
  const view = el.ownerDocument?.defaultView
  if (typeof Window !== 'undefined' && view instanceof Window) base.view = view
  const pointerInit = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }

  fire(el, () => new PointerEvent('pointerover', { ...pointerInit, buttons: 0 }))
  fire(el, () => new MouseEvent('mouseover', { ...base, button: 0, buttons: 0 }))
  fire(el, () => new PointerEvent('pointerdown', { ...pointerInit, buttons: 1 }))
  fire(el, () => new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }))
  fire(el, () => new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }))
  fire(el, () => new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }))
  el.click()
}

function fire(el: HTMLElement, make: () => Event): void {
  try {
    el.dispatchEvent(make())
  } catch {
    /* the constructor or the listener threw — keep going */
  }
}

export function pageClick(args: Record<string, unknown>): string {
  const el = elementAt(args.index)
  clickSequence(el)
  const tag = el.tagName.toLowerCase()
  const label = (el.textContent ?? '').trim().slice(0, 40)
  return `已点击 [${args.index}] <${tag}>${label ? ` "${label}"` : ''}。${STALE_HINT}`
}

export function pageInput(args: Record<string, unknown>): string {
  const el = elementAt(args.index)
  const text = String(args.text ?? '')
  // contentEditable surfaces (rich-text editors) are numbered by page-tree's
  // isInteractive but are not input/textarea — they used to fail here with
  // 「不是可输入元素」 and the model's only workaround was page_execute_js.
  // The attribute check mirrors page-tree's (jsdom leaves isContentEditable
  // undefined; inherited editability stays a real-browser behavior).
  // Realm-aware editability: a frame element's `isContentEditable` answers to
  // the frame realm; duck-type instead of a top-realm instanceof (the
  // attribute check mirrors page-tree's, as before).
  if ((el as HTMLElement).isContentEditable === true || el.hasAttribute('contenteditable')) {
    try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
    // Replace the field's content, mirroring the input/textarea semantics:
    // select everything, then insert over the selection. execCommand is the
    // one API that both mutates a contentEditable AND fires the input events
    // editors listen for; the manual fallback covers engines without it
    // (jsdom), where a plain text swap plus a dispatched input event is the
    // best available approximation.
    const doc = el.ownerDocument
    const selection = doc.getSelection()
    let usedExecCommand = false
    try {
      if (selection) {
        selection.selectAllChildren(el)
        usedExecCommand = doc.execCommand('insertText', false, text)
      }
    } catch { usedExecCommand = false }
    if (!usedExecCommand) {
      el.textContent = text
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return `已向 [${args.index}] 输入 ${text.length} 个字符（contentEditable）。${STALE_HINT}`
  }
  // 帧内元素用元素自身 realm 的构造器判型（full_20261011 M13-P1-1）：DOM
  // 包装对象按 realm 缓存，顶层 realm 的 instanceof 对同源 iframe 里的
  // <input> 恒为 false —— 索引给得出编号、调用必报「不是可输入元素
  // （<input>）」的自相矛盾错误。`?? window.X` 兜 ownerDocument 缺省视图。
  const win = (el.ownerDocument?.defaultView ?? window) as typeof window
  if (!(el instanceof (win.HTMLInputElement ?? HTMLInputElement)) && !(el instanceof (win.HTMLTextAreaElement ?? HTMLTextAreaElement))) {
    throw new Error(`[${args.index}] 不是可输入元素（<${el.tagName.toLowerCase()}>）`)
  }
  try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
  setNativeValue(el, text)
  return `已向 [${args.index}] 输入 ${text.length} 个字符。${STALE_HINT}`
}

export function pageSelect(args: Record<string, unknown>): string {
  const el = elementAt(args.index)
  const selWin = (el.ownerDocument?.defaultView ?? window) as typeof window
  if (!(el instanceof (selWin.HTMLSelectElement ?? HTMLSelectElement))) {
    throw new Error(`[${args.index}] 不是下拉框（<${el.tagName.toLowerCase()}>）`)
  }
  const want = String(args.option ?? '')
  let matched: HTMLOptionElement | undefined
  for (const opt of Array.from(el.options)) {
    if (opt.value === want || opt.text.trim() === want || opt.label === want) {
      matched = opt
      break
    }
  }
  if (!matched) {
    const available = Array.from(el.options).map((o) => o.text.trim()).slice(0, 20).join(' | ')
    throw new Error(`未找到匹配 "${want}" 的选项。可选值：${available}`)
  }
  el.value = matched.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return `已在 [${args.index}] 选择 "${matched.text.trim()}"。${STALE_HINT}`
}

export function pageBack(): string {
  history.back()
  return '已执行 history.back()。请调用 page_get_content 查看新页面。'
}

/** page_navigate（2026-11-12）：此前家族不能换页——导航只能靠点击或走
 *  page_execute_js 改 location（后者还落在 exec 审批档）。只收绝对
 *  http/https（`new URL` 无隐式 base，相对路径直接无效），其余 scheme
 *  （javascript:/data:/file:）要么是注入向量要么回不来。赋值 location.href
 *  后跨文档导航会拆掉内容脚本，这里回执的是「正在离开」确认；连它都丢了
 *  就由 service worker 的「导航中」结算兜住。新页首读总是全量，旧索引不延续。 */
export function pageNavigate(args: Record<string, unknown>): string {
  const raw = String(args?.url ?? '').trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`无效的 URL: ${raw || '（空）'}——page_navigate 需要完整的 http/https 地址`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不允许的协议 "${url.protocol}"——page_navigate 只接受 http/https 地址`)
  }
  location.href = url.href
  return `正在导航到 ${url.href}。加载完成后先 page_wait（可传 selector 等新页关键元素出现），再 page_get_content 查看新页面（新页首次读取总是全量）。`
}

/** In-page evaluation. Throws an `EvalError` under a CSP that forbids eval —
 *  the service worker catches the shape and retries over CDP. */
export function pageExecuteJs(args: Record<string, unknown>): Promise<string> {
  const script = String(args?.script ?? '')
  const fnArgs = (args?.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>
  return runInPage(script, fnArgs)
}

// ── Dispatch ─────────────────────────────────────────────────────────

/** Run one `page_*` call. Never throws: failures come back as `ok: false`, the
 *  shape `ToolCallResultParams` wants. */
export async function runPageTool(tool: string, args: Record<string, unknown>): Promise<PageToolOutcome> {
  try {
    const result = await dispatchPageTool(tool, args ?? {})
    return { ok: true, result: typeof result === 'string' ? result : serializeResult(result) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, cspEvalBlocked: isCspEvalError(message) }
  }
}

async function dispatchPageTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'page_get_content':
      return pageGetContent(args)
    case 'page_scroll':
      return pageScroll(args)
    case 'page_wait':
      return pageWait(args)
    case 'page_click':
      return pageClick(args)
    case 'page_input':
      return pageInput(args)
    case 'page_select':
      return pageSelect(args)
    case 'page_navigate':
      return pageNavigate(args)
    case 'page_back':
      return pageBack()
    case 'page_execute_js':
      return pageExecuteJs(args)
    default:
      throw new Error(`未知页面工具: ${tool}`)
  }
}

/** Forget everything known about the current page: the cached index map and
 *  the persistent ref / delta baseline in page-tree. A real navigation gives
 *  the content script fresh module state; this is the explicit equivalent for
 *  tests and probes. (The service worker needs no invalidate-after-write call:
 *  stable indices across writes are the point, and a removed element fails
 *  loudly through `elementAt`'s `isConnected` guard.) */
export function resetPageToolState(): void {
  cached = null
  resetPageAnalysisState()
}
