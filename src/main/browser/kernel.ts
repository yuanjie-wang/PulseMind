// ── Browser vm kernel (L1, A-M1) ──
// Every browser:runCode call gets a BRAND-NEW node:vm context — no variables
// survive across calls, and continuity lives on the host's tabs, not in JS
// state (无状态内核 §2.2). The sandbox exposes exactly three things: the
// facade (agent), emitImage, and a console. No require/process/fs/net.

import vm from 'node:vm'
import { createBrowserFacade, type FacadeImage } from '../../shared/browser-client/facade'
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

export async function runBrowserCode(input: BrowserRunInput, execute: (cmd: BrowserCommand) => Promise<BrowserCommandResult>): Promise<BrowserRunOutput> {
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
