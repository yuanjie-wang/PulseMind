// ── Playwright command executor (A-M1) ──
// The ONLY selector-engine entry of the whole scheme: one function, one
// page.locator(selector)[op]() whitelist. The facade's playwright/cua/dom_cua
// escape hatches all land here; no CDP/DOM glue gets written anywhere else.

import type { Page } from 'playwright-core'
import { isPmRefSelector, pmRefOf, PM_REF_RECOVERY_HINT } from '../../shared/browser-client/pm-refs'
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
function treeEntryOf(tree: AriaNode[] | null | undefined, ref: string): { role: string; name: string; text: string } | null {
  let found: { role: string; name: string; text: string } | null = null
  const walk = (nodes: AriaNode[]): void => {
    for (const n of nodes) {
      if (found) return
      if (n.ref === ref) {
        found = {
          role: n.role,
          name: typeof n.name === 'string' ? n.name.replace(/\s+/g, ' ').trim() : '',
          text: typeof n.text === 'string' ? n.text.replace(/\s+/g, ' ').trim() : '',
        }
        return
      }
      walk((n.children ?? []).filter((c): c is AriaNode => typeof c !== 'string'))
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
  //      clicking whatever occupies the ref. The ROLE comparison only fires
  //      when the DOM side can derive a role the snapshot could actually have
  //      printed (explicit role= attribute, or one of the implicit mappings
  //      Chromium derives context-independently) — a <div> reads `generic` in
  //      the snapshot and `div` from the tag name, so tag-as-role compared
  //      against the ARIA tree false-rejected 6 of 10 typical refs (measured,
  //      review 2026-09-26 高1); untrusted nodes skip the role check and the
  //      name/text comparison carries the swap detection alone. The NAME/TEXT
  //      comparison only fires when the DOM heuristic could actually read one,
  //      so label-supplied names never false-reject. Gen-staleness is gone by
  //      design: refs are persistent, and step 2 covers a swapped target.
  //      State decorations ([checked]/[disabled]) are deliberately NOT
  //      verified — changing them is what the actions are FOR, so a state
  //      verdict here would reject every legitimate toggle (they ride the diff
  //      channel instead).
  if (isPmRefSelector(selector)) {
    // The WHOLE ref, frame prefix included: `f7e74` and `e74` are different
    // addresses, and the tree is keyed on exactly what the snapshot printed.
    const refId = pmRefOf(selector) ?? selector
    const count = await locator.count()
    if (count === 0) {
      throw new Error(`编号 [ref=${refId}] 不存在或已失效——编号带帧前缀时（如 [ref=f7e74]）必须连前缀一起原样传入，只传数字会丢掉帧前缀而指向错误的帧；也可能是页面在快照后已变化，或该编号来自旧版快照（编号体系已升级，请重新 domSnapshot()）。不要重试旧编号。`)
    }
    const entry = treeEntryOf(lastTree, refId)
    if (entry) {
      try {
        const now = (await page.locator(selector).evaluate((el) => {
          const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim()
          const tag = el.tagName.toLowerCase()
          const type = (el.getAttribute('type') || '').toLowerCase()
          // The role the SNAPSHOT would print for this element, and whether we
          // can know it from the DOM alone. An explicit role= is authoritative;
          // the implicit set below is what Chromium (hence Playwright's ARIA
          // tree) derives context-independently. Anything else — generic
          // containers, landmarks whose role depends on ancestors (header →
          // banner vs generic), input types Chromium composes — must NOT be
          // guessed: guessing yields the tag name, and tag ≠ ARIA role is
          // exactly the false-rejection this table exists to prevent.
          const IMPLICIT: Record<string, string[]> = {
            textarea: ['textbox'],
            select: ['combobox', 'listbox'],
            button: ['button'],
            summary: ['button'],
            a: ['link', 'generic'],
            img: ['img', 'generic'],
            svg: ['img', 'generic'],
            canvas: ['img', 'generic'],
            h1: ['heading'], h2: ['heading'], h3: ['heading'], h4: ['heading'], h5: ['heading'], h6: ['heading'],
            ul: ['list'], ol: ['list'], menu: ['list', 'toolbar'], dl: ['list'],
            li: ['listitem'],
            dt: ['term', 'generic'],
            dd: ['definition', 'generic'],
            nav: ['navigation'],
            main: ['main'],
            header: ['banner', 'generic'],
            footer: ['contentinfo', 'generic'],
            section: ['region', 'generic'],
            article: ['article'],
            aside: ['complementary', 'generic'],
            form: ['form', 'generic'],
            fieldset: ['group'],
            details: ['group'],
            optgroup: ['group'],
            dialog: ['dialog'],
            p: ['paragraph'],
            blockquote: ['blockquote'],
            hr: ['separator'],
            table: ['table'],
            thead: ['rowgroup'], tbody: ['rowgroup'], tfoot: ['rowgroup'],
            tr: ['row'],
            td: ['cell'], th: ['columnheader', 'rowheader'],
            option: ['option'],
            datalist: ['listbox'],
            progress: ['progressbar'],
            meter: ['meter'],
            output: ['status'],
            figure: ['figure'],
            html: ['document'],
            iframe: ['iframe'],
          }
          let roleSet: string[] | null = null
          const explicit = (el.getAttribute('role') || '').toLowerCase()
          if (explicit) {
            roleSet = [explicit]
          } else if (tag === 'input') {
            if (type === 'checkbox' || type === 'radio') roleSet = [type]
            else if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file' || type === 'image') roleSet = ['button']
            else if (type === 'range') roleSet = ['slider']
            else if (type === 'number') roleSet = ['spinbutton']
            else if (type === 'search') roleSet = ['searchbox']
            else if (type === 'color' || type === 'date' || type === 'datetime-local' || type === 'month' || type === 'time' || type === 'week') roleSet = null
            else roleSet = ['textbox']
          } else {
            roleSet = IMPLICIT[tag] ?? null
          }
          let name = ''
          const al = el.getAttribute('aria-label')
          if (al && al.trim()) name = norm(al)
          else {
            const txt = norm(el.textContent)
            if (txt) name = txt.slice(0, 60)
            else if (tag === 'input') { const v = (el as HTMLInputElement).value || ''; if (v.trim()) name = norm(v) }
          }
          return { roleSet, name, textHead: norm(el.textContent).slice(0, 60), tag }
        })) as { roleSet: string[] | null; name: string; textHead: string; tag: string }
        if (now.roleSet && entry.role) {
          const entryRole = String(entry.role).toLowerCase()
          if (entryRole && !now.roleSet.includes(entryRole)) {
            throw new Error(`编号 [ref=${refId}] 已失效：现指向 ${now.tag} 元素（快照时是 ${entryRole}）——页面复用了节点。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
          }
        }
        const head = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 40)
        let named = false
        if (now.name && entry.name) {
          const a = head(now.name)
          const b = head(entry.name)
          if (a && b && !b.includes(a) && !a.includes(b)) {
            throw new Error(`编号 [ref=${refId}] 已失效：现指向 "${now.name.slice(0, 30)}"（快照时是 "${entry.name.slice(0, 30)}"）——页面复用了节点。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
          }
          named = Boolean(a && b)
        }
        // Nameless nodes (generic containers, paragraphs) verify by their own
        // text instead — the `text` key the snapshot carries for exactly these.
        if (!named && entry.text && now.textHead) {
          const a = head(now.textHead)
          const b = head(entry.text)
          if (a && b && !b.includes(a) && !a.includes(b)) {
            throw new Error(`编号 [ref=${refId}] 已失效：现指向 "${now.textHead.slice(0, 30)}"（快照时是 "${entry.text.slice(0, 30)}"）——页面复用了节点。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
          }
        }
      } catch (err) {
        // Our own rejection rethrows; an environment that cannot run the probe
        // (torn-down context) degrades to the count check above — the op never
        // skips verification entirely.
        if (err instanceof Error && err.message.includes('编号 [ref=')) throw err
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
