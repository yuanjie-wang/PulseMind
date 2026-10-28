// ── Browser vm kernel (L1, A-M1) ──
// Every browser:runCode call gets a BRAND-NEW node:vm context — no variables
// survive across calls, and continuity lives on the host's tabs, not in JS
// state (无状态内核 §2.2). The sandbox exposes exactly three things: the
// facade (agent), emitImage, and a console. No require/process/fs/net.

import vm from 'node:vm'
import { createBrowserFacade, type BrowserFacade, type FacadeImage } from '../../shared/browser-client/facade'
import { serializeResult } from '../../shared/browser-client/serialize'
import { BROWSER_DEFAULT_TIMEOUT_MS, type BrowserCommand, type BrowserCommandResult } from '../../shared/browser-client/protocol'

export interface BrowserRunInput {
  code: string
  timeoutMs?: number
}

export interface BrowserRunOutput {
  /** Serialized return value of the code (JSON text). */
  result: string
  truncated: boolean
  images: FacadeImage[]
  console: string[]
  error?: string
}

/** The live capability manifest (PLAN-tool-issues A4-r, 2026-10-28): derived by
 *  walking an ACTUAL facade instance — the same rule the member guard's menu
 *  already follows (member-guard.ts: read off the object, never hand-written),
 *  so a new facade member shows up here automatically and the manifest cannot
 *  drift the way a hand-kept doc did (the webfetch lesson). Three levels under
 *  `agent` reach `browsers.tabs.list`; per-method signatures and per-backend
 *  differences stay in `agent.documentation()`, which the tail points at.
 *  `Object.entries` reads through the guard's Proxy to the target's own keys —
 *  the get trap only fires on unknown members. */
export function describeBrowserCapabilities(facade: BrowserFacade): string {
  const walk = (target: object, prefix: string, depth: number): string[] => {
    const lines: string[] = []
    for (const [name, value] of Object.entries(target)) {
      const label = `${prefix}${name}`
      if (typeof value === 'function') lines.push(`- ${label}()`)
      else if (value !== null && typeof value === 'object' && depth > 0) {
        lines.push(`- ${label}（子对象）`)
        lines.push(...walk(value, `${label}.`, depth - 1))
      } else lines.push(`- ${label}（字段）`)
    }
    return lines
  }
  return [
    '## Browser sandbox — live capability manifest',
    '',
    '沙盒全局只有三个：`agent`（门面，成员如下）、`emitImage(base64, mime?)`（截图出图）、`console`。没有 require/process/fs/net，也没有定时器——等待用 `await tab.waitForTimeout(ms)`。',
    '',
    ...walk(facade.agent, 'agent.', 3),
    '',
    '各方法签名与后端差异：`await agent.documentation()`（或 `agent.documentation.list()` / `.get(name)`）。',
  ].join('\n')
}

export async function runBrowserCode(input: BrowserRunInput, execute: (cmd: BrowserCommand) => Promise<BrowserCommandResult>): Promise<BrowserRunOutput> {
  // Empty code is the self-check (A4-r): dump the manifest instead of erroring —
  // proactive discovery, not guess-then-read-the-error. The probe facade is
  // never invoked (the walk only reads the object graph).
  if (!input.code.trim()) {
    const probe = createBrowserFacade({
      execute: async () => { throw new Error('manifest probe never executes commands') },
      emitImage: () => {},
    })
    return { result: describeBrowserCapabilities(probe), truncated: false, images: [], console: [] }
  }

  const images: FacadeImage[] = []
  const consoleLines: string[] = []

  const facade = createBrowserFacade({
    execute,
    emitImage: (image) => images.push(image),
  })
  const line = (...args: unknown[]) => consoleLines.push(args.map(fmt).join(' '))
  const sandbox = {
    agent: facade.agent,
    emitImage: facade.emitImage,
    console: { log: line, info: line, warn: line, error: line },
  }

  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  // Sync portion (tight loops) is bounded by the vm timeout; the awaited rest
  // by the wall-clock race below — together they make up the per-call budget.
  const script = new vm.Script(`(async () => {\n${input.code}\n})()`)
  const execution = script.runInContext(context, { timeout: 10_000 })
  const budgetMs = Math.min(Math.max(input.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS, 1_000), 300_000)

  let value: unknown
  try {
    value = await Promise.race([
      Promise.resolve(execution),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`执行超时（${Math.round(budgetMs / 1000)}s）——把工作拆成多次调用，或用更短的等待`)),
          budgetMs,
        ),
      ),
    ])
  } catch (err) {
    return {
      result: 'null',
      truncated: false,
      images,
      console: consoleLines,
      error: withTimerHint(err instanceof Error ? err.message : String(err)),
    }
  }

  const { text, truncated } = serializeResult(value)
  return { result: text, truncated, images, console: consoleLines }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** 沙盒刻意不注入定时器（kernel 只暴露 agent/emitImage/console）；模型按
 *  惯用写法摸 setTimeout 时，报错直接指到唯一合法的等待原语，免得再去猜
 *  browsers.waitForTimeout 这类不存在的岔路。 */
const TIMER_GLOBALS = new Set([
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask',
])

function withTimerHint(message: string): string {
  // vm 跨 realm 传回的 ReferenceError 自带 "ReferenceError: " 前缀，两态都接。
  const missing = /^(?:[A-Za-z]+Error: )?(\w+) is not defined$/.exec(message)?.[1]
  return missing && TIMER_GLOBALS.has(missing)
    ? `${message} —— 沙盒没有定时器，需要等待就用 await tab.waitForTimeout(ms)`
    : message
}
