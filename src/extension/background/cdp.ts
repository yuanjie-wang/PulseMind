/**
 * `page_execute_js` CDP fallback (PLAN-browser-extension §6, ported from
 * Anywhere `background/cdp.ts`).
 *
 * A page whose CSP forbids `unsafe-eval` makes the content script's
 * `new AsyncFunction(...)` throw, so the script never runs there. Evaluating
 * through `chrome.debugger` → `Runtime.evaluate` happens in the page's main
 * world and is not subject to that CSP — the same mechanism Playwright uses.
 *
 * Attaching happens per call and is detached in `finally`: the extension holds
 * no persistent debugger session, so Chrome's "being debugged" banner only
 * appears for the duration of one call. `userGesture: true` keeps the
 * evaluation on the same footing as a real user action (autoplay, popups).
 */
import { buildCdpExpression, serializeResult } from '../content/page-js'
import type { ToolCallParams } from '../../shared/agent-protocol'

/** Wall-clock budget for one CDP evaluation. */
export const CDP_EVAL_TIMEOUT_MS = 30_000

interface CdpEvalResponse {
  result?: { value?: unknown }
  exceptionDetails?: { exception?: { description?: string; value?: string } }
}

/** Tabs that already proved to be CSP-strict: the next `page_execute_js` goes
 *  straight to CDP instead of paying a failed round-trip first. Reset on
 *  navigation, because the new document's CSP may be laxer (Anywhere §cdp). */
const cspStrictTabs = new Set<number>()

export function markCspStrict(tabId: number): void {
  cspStrictTabs.add(tabId)
}

export function shouldUseDebugger(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.debugger
}

export async function runViaDebugger(
  tabId: number,
  params: ToolCallParams,
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
  const args = { ...((params.args ?? {}) as Record<string, unknown>) }
  const script = String(args.script ?? '')
  const fnArgs = (args.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>

  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (err) {
    return { ok: false, error: `无法附加调试器：${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const cmd = chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: buildCdpExpression(script, fnArgs),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }) as Promise<CdpEvalResponse | undefined>
    const res = await Promise.race([
      cmd,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`页面脚本执行超时（${CDP_EVAL_TIMEOUT_MS / 1000}s）`)), CDP_EVAL_TIMEOUT_MS),
      ),
    ])
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails.exception
      return { ok: false, error: detail?.description ?? detail?.value ?? '页面脚本抛出异常' }
    }
    markCspStrict(tabId)
    return { ok: true, result: serializeResult(res?.result?.value) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    void chrome.debugger.detach(target).catch(() => {})
  }
}

/** A navigation replaces the document, so the recorded CSP verdict is stale. */
export function resetCspVerdict(tabId: number): void {
  cspStrictTabs.delete(tabId)
}

export function isCspStrict(tabId: number): boolean {
  return cspStrictTabs.has(tabId)
}
