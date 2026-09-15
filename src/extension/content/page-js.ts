/**
 * `page_execute_js` shared helpers (PLAN-browser-extension M2.1, ported from
 * Anywhere `common/js-exec.ts`).
 *
 * Used by both execution paths: the direct one in the content script and the
 * `chrome.debugger` (CDP) fallback in the service worker, which exists because
 * a page CSP that forbids `unsafe-eval` makes `new AsyncFunction` throw.
 */

/** Normalize the three accepted input shapes down to a bare function body:
 *    "return x"          → as-is
 *    "() => { ... }"     → the braces' contents
 *    "() => expression"  → return (expression)
 */
export function normalizeFunctionBody(code: string): string {
  const body = code.trim()
  const wrapped = body.match(/^(?:async\s*)?\(\s*\)\s*=>\s*\{([\s\S]*)\}$/)
  if (wrapped) return wrapped[1]!
  const expr = body.match(/^(?:async\s*)?\(\s*\)\s*=>\s*([\s\S]+)$/)
  if (expr) return `return (${expr[1]})`
  return body
}

/** undefined → "undefined", strings verbatim, everything else pretty JSON. */
export function serializeResult(result: unknown): string {
  if (result === undefined) return 'undefined'
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/** The CDP Runtime.evaluate expression: an async IIFE that keeps `args` bound
 *  the same way the direct path does. */
export function buildCdpExpression(code: string, args: Record<string, unknown>): string {
  const body = normalizeFunctionBody(code)
  let jsonArgs: string
  try {
    jsonArgs = JSON.stringify(args ?? {})
  } catch {
    jsonArgs = '{}'
  }
  return `(async function (args) {\n${body}\n}).call(null, ${jsonArgs})`
}

/** Recognizes a "page CSP refused eval" failure — Chrome and Edge word it
 *  differently, so match by feature rather than by exact string. */
export function isCspEvalError(message: string): boolean {
  return /unsafe-eval|(refused|violates).*evaluat\w+ a string.*javascript|content security policy/i.test(
    message,
  )
}

/** Run a function body in the current (content-script) world. Throws an
 *  `EvalError` under a CSP that forbids eval — the caller falls back to CDP.
 *  `args` is a real parameter so a script can read `args.foo` on both paths
 *  (the Anywhere original only exposed it positionally as `arguments[0]`). */
export async function runInPage(code: string, args: Record<string, unknown>): Promise<string> {
  const trimmed = code.trim()
  if (!trimmed) throw new Error('script 参数不能为空')
  // AsyncFunction allows await; require/import are not in scope.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (argName: string, body: string) => (args: Record<string, unknown>) => Promise<unknown>
  const fn = new AsyncFunction('args', normalizeFunctionBody(trimmed))
  return serializeResult(await fn(args))
}
