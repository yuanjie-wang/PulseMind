// ── Playwright command executor (A-M1) ──
// The ONLY selector-engine entry of the whole scheme: one function, one
// page.locator(selector)[op]() whitelist. The facade's playwright/cua/dom_cua
// escape hatches all land here; no CDP/DOM glue gets written anywhere else.

import type { Page } from 'playwright-core'
import { isPmRefSelector, PM_REF_RECOVERY_HINT } from '../../shared/browser-client/pm-refs'
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

/** Playwright's own timeout message is the one load-bearing string a locator
 *  failure carries — decoration keys on it (stable English in playwright-core,
 *  independent of app locale). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && /timeout \d+ms exceeded|timed out/i.test(err.message)
}

export async function runPlaywrightOp(page: Page, input: PlaywrightOpInput): Promise<unknown> {
  const { selector, op } = input
  if (!PLAYWRIGHT_OPS.has(op)) throw new Error(`不支持的操作：${op}（可用：${[...PLAYWRIGHT_OPS].join(', ')}）`)
  const timeout = Math.min(Math.max(input.timeoutMs ?? 8_000, 500), 30_000)
  const locator = page.locator(selector)

  // A snapshot ref is binary — the tag is there or the page has moved on.
  // Fast-fail stale refs instead of burning the locator timeout, and name the
  // fix (the model decides its next move off the last bytes of the error).
  if (isPmRefSelector(selector)) {
    const refId = selector.match(/="([^"]+)"/)?.[1] ?? selector
    if ((await locator.count()) === 0) {
      throw new Error(`编号 [${refId}] 不存在或已失效——页面在快照后已变化。重新 domSnapshot() 获取新编号，不要重试旧编号。`)
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
