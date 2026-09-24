// ── Playwright command executor (A-M1) ──
// The ONLY selector-engine entry of the whole scheme: one function, one
// page.locator(selector)[op]() whitelist. The facade's playwright/cua/dom_cua
// escape hatches all land here; no CDP/DOM glue gets written anywhere else.

import type { Page } from 'playwright-core'
import { isPmRefSelector, pmRefNumberOf, PM_REF_RECOVERY_HINT } from '../../shared/browser-client/pm-refs'
import type { AriaNode } from './snapshot-refs'
import { CHANGE_TRACKED_OPS, describeOperationResult, withChangeWatch } from './change-watch'

/** Ops a model may invoke. Anything not listed is rejected — the whitelist is
 *  also what the audit log summarizes. */
const READ_OPS = new Set([
  'count',
  'textContent',
  'innerText',
  'allTextContents',
  'getAttribute',
  'inputValue',
  'isVisible',
  'isHidden',
  'isEnabled',
  'isDisabled',
  'ariaSnapshot',
])
const MUTATING_OPS = new Set([
  'click',
  'dblclick',
  'fill',
  'pressSequentially',
  'press',
  'hover',
  'check',
  'uncheck',
  'selectOption',
  'focus',
  'waitFor',
  'screenshot',
  'dragTo',
  'setInputFiles',
])
export const PLAYWRIGHT_OPS = new Set([...READ_OPS, ...MUTATING_OPS])

export interface PlaywrightOpInput {
  selector: string
  op: string
  arg?: string
  timeoutMs?: number
}

/** Find a node's entry in the service-side tree by its eN number. */
function treeEntryOf(tree: AriaNode[] | null | undefined, ref: string): { role: string; name: string } | null {
  let found: { role: string; name: string } | null = null
  const walk = (nodes: AriaNode[]): void => {
    for (const n of nodes) {
      if (found) return
      if (n.ref === ref) {
        found = { role: n.role, name: typeof n.name === 'string' ? n.name.replace(/\s+/g, ' ').trim() : '' }
        return
      }
      walk(n.children ?? [])
    }
  }
  for (const root of tree ?? []) walk([root])
  return found
}

/** Playwright's own timeout message is the one load-bearing string a locator
 *  failure carries — decoration keys on it (stable English in playwright-core,
 *  independent of app locale). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && /timeout \d+ms exceeded|timed out/i.test(err.message)
}

export async function runPlaywrightOp(page: Page, input: PlaywrightOpInput, lastTree?: AriaNode[] | null): Promise<unknown> {
  const { selector, op } = input
  if (!PLAYWRIGHT_OPS.has(op)) throw new Error(`不支持的操作：${op}（可用：${[...PLAYWRIGHT_OPS].join(', ')}）`)
  const timeout = Math.min(Math.max(input.timeoutMs ?? 8_000, 500), 30_000)
  const locator = page.locator(selector)

  // A snapshot ref must prove itself before the gesture fires
  // (PLAN-browser-snapshot-ai §1.2 — the gen/sig stamping is gone; the sig
  // lives in the SERVICE-side tree now):
  //   1. count 0 → the node is gone (or the number comes from a pre-upgrade
  //      session) — fail FAST, no locator timeout, name the fix;
  //   2. one round trip reads what the element is NOW and compares against the
  //      server-side tree's eN entry — a framework that REUSED the node
  //      (kept the position, swapped the content) is caught here instead of
  //      clicking whatever occupies the ref. The name comparison only fires
  //      when the DOM heuristic could actually read one, so label-supplied
  //      names never false-reject. Gen-staleness is gone by design: refs are
  //      persistent, and step 2 covers a swapped target. State decorations
  //      ([checked]/[disabled]) are deliberately NOT verified — changing them
  //      is what the actions are FOR, so a state verdict here would reject
  //      every legitimate toggle (they ride the diff channel instead).
  if (isPmRefSelector(selector)) {
    const refId = pmRefNumberOf(selector) ?? selector
    const count = await locator.count()
    if (count === 0) {
      throw new Error(`编号 [${refId}] 不存在或已失效——页面在快照后已变化，或该编号来自旧版快照（编号体系已升级，请重新 domSnapshot()）。不要重试旧编号。`)
    }
    const entry = treeEntryOf(lastTree, `e${refId}`)
    if (entry) {
      try {
        const now = (await page.locator(selector).evaluate((el) => {
          const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim()
          const tag = el.tagName.toLowerCase()
          const type = (el.getAttribute('type') || '').toLowerCase()
          let role = el.getAttribute('role') || ''
          if (!role) {
            if (tag === 'input') role = (type === 'checkbox' || type === 'radio') ? type : (type === 'submit' || type === 'button' || type === 'file') ? 'button' : 'textbox'
            else if (tag === 'textarea') role = 'textbox'
            else if (tag === 'a') role = 'link'
            else if (tag === 'select') role = 'combobox'
            else if (tag === 'button' || tag === 'summary') role = 'button'
            else role = tag
          }
          let name = ''
          const al = el.getAttribute('aria-label')
          if (al && al.trim()) name = norm(al)
          else {
            const txt = norm(el.textContent)
            if (txt) name = txt.slice(0, 60)
            else if (tag === 'input') { const v = (el as HTMLInputElement).value || ''; if (v.trim()) name = norm(v) }
          }
          return { role: String(role).toLowerCase(), name, textHead: norm(el.textContent).slice(0, 60), tag }
        })) as { role: string; name: string; textHead: string; tag: string }
        const roleNow = String(now.role || '').toLowerCase()
        if (roleNow && entry.role && roleNow !== String(entry.role).toLowerCase()) {
          throw new Error(`编号 [${refId}] 已失效：现指向 ${roleNow} 元素（快照时是 ${entry.role}）——页面复用了节点。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
        }
        const head = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 40)
        if (now.name && entry.name) {
          const a = head(now.name)
          const b = head(entry.name)
          if (a && b && !b.includes(a) && !a.includes(b)) {
            throw new Error(`编号 [${refId}] 已失效：现指向 "${now.name.slice(0, 30)}"（快照时是 "${entry.name.slice(0, 30)}"）——页面复用了节点。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
          }
        }
      } catch (err) {
        // Our own rejection rethrows; an environment that cannot run the probe
        // (torn-down context) degrades to the count check above — the op never
        // skips verification entirely.
        if (err instanceof Error && err.message.includes('编号 [')) throw err
      }
    }
  }

  // State-changing ops answer with what the page did, not only that the
  // gesture landed: 'clicked' from a click on a dead link and from a click that
  // opened a page are the same bytes, and the model repeats the first one
  // forever. See change-watch.ts — the annotation is negative-only.
  try {
    if (CHANGE_TRACKED_OPS.has(op)) {
      const { value, report } = await withChangeWatch(page, () => runOp(locator, page, input, timeout))
      return typeof value === 'string' ? describeOperationResult(value, report) : value
    }
    return await runOp(locator, page, input, timeout)
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\n${PM_REF_RECOVERY_HINT}`)
    }
    throw err
  }
}

async function runOp(locator: ReturnType<Page['locator']>, page: Page, input: PlaywrightOpInput, timeout: number): Promise<unknown> {
  const { op } = input
  switch (op) {
    // ── read ──
    case 'count':
      return await locator.count()
    case 'textContent':
      return await locator.textContent({ timeout })
    case 'innerText':
      return await locator.innerText({ timeout })
    case 'allTextContents':
      return await locator.allTextContents()
    case 'getAttribute':
      return await locator.getAttribute(input.arg ?? '', { timeout })
    case 'inputValue':
      return await locator.inputValue({ timeout })
    case 'isVisible':
      return await locator.isVisible()
    case 'isHidden':
      return await locator.isHidden()
    case 'isEnabled':
      return await locator.isEnabled()
    case 'isDisabled':
      return await locator.isDisabled()
    case 'ariaSnapshot':
      return await locator.ariaSnapshot({ timeout })
    // ── mutating ──
    case 'click':
      await locator.click({ timeout })
      return 'clicked'
    case 'dblclick':
      await locator.dblclick({ timeout })
      return 'double-clicked'
    case 'fill':
      await locator.fill(input.arg ?? '', { timeout })
      return 'filled'
    case 'pressSequentially':
      await locator.pressSequentially(input.arg ?? '', { timeout })
      return 'typed'
    case 'press':
      await locator.press(input.arg ?? '', { timeout })
      return 'pressed'
    case 'hover':
      await locator.hover({ timeout })
      return 'hovered'
    case 'check':
      await locator.check({ timeout })
      return 'checked'
    case 'uncheck':
      await locator.uncheck({ timeout })
      return 'unchecked'
    case 'selectOption':
      await locator.selectOption(input.arg ?? '', { timeout })
      return 'selected'
    case 'setInputFiles':
      await locator.setInputFiles(input.arg ?? '', { timeout })
      return 'files set'
    case 'focus':
      await locator.focus()
      return 'focused'
    case 'waitFor':
      await locator.waitFor({ state: (input.arg as 'visible' | 'hidden' | 'attached' | 'detached') ?? 'visible', timeout })
      return 'waited'
    case 'screenshot': {
      const buffer = await locator.screenshot({ timeout })
      return { mime: 'image/png', base64: buffer.toString('base64') }
    }
    case 'dragTo':
      await locator.dragTo(page.locator(input.arg ?? ''))
      return 'dragged'
    default:
      throw new Error(`不支持的操作：${op}`)
  }
}
