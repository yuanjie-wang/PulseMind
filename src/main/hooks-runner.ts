import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { DATA_DIR, HOOKS_DIR, WORKSPACE_DIR, SKILLS_DIR, KNOWLEDGE_DIR } from './storage/index'
import { getUserPath, initUserPath } from './utils/user-path'
import { closeAllHookWindows, openBuiltInWindow } from './hook-browser'
import type { HookContext, HookResult } from '../shared/types/hooks'

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

/** Env vars collected from hook scripts, consumed by terminal and MCP subprocesses. */
let hookEnv: Record<string, string> = {}

export function getHookEnv(): Record<string, string> {
  const env = { ...hookEnv }
  // Subprocesses (MCP servers, terminal) may need commands that live only in
  // the user's login-shell PATH (e.g. bunx, codegraph). Packaged apps launched
  // from Finder get a minimal PATH, so inject the resolved one unless a hook
  // explicitly set it.
  const userPath = getUserPath()
  if (userPath && !env.PATH) env.PATH = userPath
  return env
}

const HOOK_EVENTS = ['app-start']

let launchPromise: Promise<void> | null = null

// ── Watchdog + gate skip (review 2026-09-26 中4) ──────────────────────────
// 「hook 延迟 = 启动延迟」是记录在案的裁定，等合法登录多久都没问题；但链条
// 上曾没有任何上限或逃生面：模板示例的裸 fetch 对网络黑洞永不超时，启用即
// 挂死启动；此时 splash 已销毁、用户关掉登录窗后 window-all-closed 因
// startupComplete=false 直接 return——Windows 上留下无窗口、无托盘、任务栏
// 不可见的常驻进程。看门狗 + skipLaunchHooks()（门期对话框的「跳过」按钮）
// 是那两个逃生面；二者都不打断 hook 本身——被放弃的 promise 继续跑，只是
// 没有人再等它。
const DEFAULT_HOOK_TIMEOUT_MS = 10 * 60_000

/** Per-hook watchdog: the exported function may carry `timeout` (ms) to
 *  override the generous default (`module.exports.timeout = 300_000`). */
function hookTimeoutMs(hookFn: (...args: unknown[]) => unknown): number {
  const t = (hookFn as { timeout?: unknown }).timeout
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULT_HOOK_TIMEOUT_MS
}

// Resolved by skipLaunchHooks(); ensureLaunchHooks races it against the hooks.
let gateSkip: (() => void) | null = null

/** Release the launch gate WITHOUT waiting for the hooks. The hooks keep
 *  running in the background — a late env var still lands in hookEnv for the
 *  consumers that read later — but nothing waits for them any more. */
export function skipLaunchHooks(): void {
  gateSkip?.()
}

/**
 * Start the launch hooks exactly once and return their completion.
 *
 * app-start GATES the main window (user decision 2026-09-25, reversing the
 * earlier concurrency fix): the hook may run a login flow — open the built-in
 * browser via ctx.browser.open, poll its server-side session endpoint, close
 * — and the app must not start until that resolves. index.ts awaits this
 * BEFORE createWindow; the splash holds the screen meanwhile, so a valid
 * session (fast local check) is near-instant and a login costs exactly the
 * time the user takes. The cost accepted with the decision: any hook latency
 * is startup latency (a hook that sleeps seconds delays first paint by them).
 *
 * Consumers that read what hooks produce still await this first:
 * getHookEnv() (terminal exec, MCP stdio spawn) and the ${ENV} placeholder
 * resolution in applyProfileHeaders. Never rejects: runLaunchHooks logs hook
 * failures, so a broken hook degrades to default env instead of blocking
 * whatever awaited — the gate moves on either way.
 */
export function ensureLaunchHooks(): Promise<void> {
  if (!launchPromise) {
    const skip = new Promise<void>((resolve) => { gateSkip = resolve })
    launchPromise = Promise.race([
      runLaunchHooks().catch((err) => {
        console.error('[Hooks] launch hooks crashed:', err)
      }),
      skip,
    ])
  }
  return launchPromise
}

export async function runLaunchHooks(): Promise<void> {
  // Resolve the login-shell PATH in parallel with hook execution so subprocess
  // env is ready before the first gated consumer (terminal/MCP spawn) proceeds.
  const userPathPromise = initUserPath()

  if (!existsSync(HOOKS_DIR)) {
    await userPathPromise
    return
  }

  for (const event of HOOK_EVENTS) {
    const filePath = join(HOOKS_DIR, `${event}.js`)
    if (!existsSync(filePath)) continue

    try {
      const hookFn = require(filePath)
      if (typeof hookFn !== 'function') {
        console.warn(`[Hooks] ${event}.js does not export a function, skipping`)
        continue
      }

      const context: HookContext = {
        event,
        dataDir: DATA_DIR,
        workspaceDir: WORKSPACE_DIR,
        skillsDir: SKILLS_DIR,
        knowledgeDir: KNOWLEDGE_DIR,
        platform: {
          name: PLATFORM_NAMES[process.platform] || process.platform,
          release: os.release(),
          arch: os.arch(),
        },
        env: { ...process.env as Record<string, string> },
        browser: { open: openBuiltInWindow },
      }

      // Watchdog race: a hook stuck on a network黑洞 fetch must not hold the
      // startup gate forever. On timeout the flow is ABANDONED, not killed —
      // the orphaned promise keeps running (its rejections are pre-caught so
      // they never surface as unhandledRejection), any login window the hook
      // opened is closed, and the gate moves on.
      const timeoutMs = hookTimeoutMs(hookFn)
      let watchdogTimer: ReturnType<typeof setTimeout> | null = null
      const watchdog = new Promise<'timeout'>((resolve) => {
        watchdogTimer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      try {
        const hookPromise = Promise.resolve(hookFn(context))
        hookPromise.catch(() => { /* the race's own catch logs the live case */ })
        const outcome = await Promise.race([hookPromise, watchdog])
        if (outcome === 'timeout') {
          closeAllHookWindows()
          console.warn(`[Hooks] ${event}.js exceeded its ${timeoutMs}ms watchdog — abandoned; startup continues`)
          continue
        }
        const result: HookResult = outcome as HookResult
        if (result?.env) {
          hookEnv = { ...hookEnv, ...result.env }
          console.log(`[Hooks] ${event}.js returned ${Object.keys(result.env).length} env var(s)`)
        }
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer)
      }
    } catch (err) {
      console.error(`[Hooks] ${event}.js failed:`, err)
    }
  }

  console.log('[Hooks] All hooks completed')

  await userPathPromise
}
