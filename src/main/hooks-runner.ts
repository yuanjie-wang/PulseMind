import { existsSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import os from 'node:os'
import { DATA_DIR, HOOKS_DIR, WORKSPACE_DIR, SKILLS_DIR, KNOWLEDGE_DIR } from './storage/index'
import { getUserPath, initUserPath } from './utils/user-path'
import { closeAllHookWindows, openBuiltInWindow } from './hook-browser'
import { logMain, describeError } from './main-log'
import type { HookContext, HookResult } from '../shared/types/hooks'

const PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

/** Env vars collected from hook scripts, consumed by terminal and MCP subprocesses. */
let hookEnv: Record<string, string> = {}

// ── Hook env → process.env (2026-11-11) ──────────────────────────────────
// `${ENV}` placeholders in settings.json are resolved from process.env only
// (shared/env.ts), so a hook that RETURNS { env } would otherwise never supply
// an API key — only a direct `process.env.X = …` inside the hook worked. Mirror
// every returned var into process.env and remember the value it had before the
// hook first touched it: a re-run then starts from the pre-hook baseline
// instead of inheriting the old script's exports (a template that drops
// `${API_KEY}` must not keep getting the previous key).
//
// Only RETURNED env is tracked. Direct `process.env` writes by the hook stay
// untracked and are not rolled back — a documented limitation of the in-place
// re-run (a hook should set what it needs on every run).
const hookEnvOriginals = new Map<string, string | undefined>()
let appliedHookEnv: Record<string, string> = {}

function applyHookReturnedEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!hookEnvOriginals.has(key)) hookEnvOriginals.set(key, process.env[key])
    process.env[key] = value
    appliedHookEnv[key] = value
  }
}

/** Undo every returned var this process applied, back to its pre-hook value. */
function restoreHookReturnedEnv(): void {
  for (const key of Object.keys(appliedHookEnv)) {
    const original = hookEnvOriginals.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  appliedHookEnv = {}
}

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

// ── Serialized hook runs (2026-11-11) ─────────────────────────────────────
// A template-pack import can ask for app-start to run again in the CURRENT
// process instead of restarting the app (user 2026-11-11: 「我其实是想能够
// 触发app-start脚本」). app-start may drive a login flow in its own window, so
// two instances must never overlap. Every run — the launch run and any re-run
// — goes through this one queue: a re-run queued while the launch hook is
// still alive (its gate may have been skipped) starts only after it settles.
let hookQueue: Promise<unknown> = Promise.resolve()

function serializeHookRun<T>(run: () => Promise<T>): Promise<T> {
  const next = hookQueue.then(run, run)
  // The queue must survive a rejected run; callers still see the rejection.
  hookQueue = next.catch(() => undefined)
  return next
}

// ── Watchdog + gate skip (review 2026-09-26 中4) ──────────────────────────
// 「hook 延迟 = 启动延迟」是记录在案的裁定，等合法登录多久都没问题；但链条
// 上曾没有任何上限或逃生面：模板示例的裸 fetch 对网络黑洞永不超时，启用即
// 挂死启动；此时 splash 已销毁、用户关掉登录窗后 window-all-closed 因
// startupComplete=false 直接 return——Windows 上留下无窗口、无托盘、任务栏
// 不可见的常驻进程。看门狗 + skipLaunchHooks()（gate-escape.ts 的两个跳过
// 入口：用户关掉登录窗后的静默跳过、兜底对话框的「跳过」按钮）
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

/** Options for one hook execution. Production passes none; tests inject the
 *  loader/cache because vitest runs ESM, where the global `require` does not
 *  exist. */
export interface HookRunOptions {
  /** Overrides the data-dir hooks root (tests). */
  hooksDir?: string
  /** Purge the hook dir from the CJS module cache before loading, so a file
   *  replaced on disk (template import) is really the one that runs. */
  fresh?: boolean
  /** Test seam; production uses Node's `require`. */
  loader?: (filePath: string) => unknown
  /** Test seam; production uses `require.cache`. */
  cache?: Record<string, unknown>
}

export interface HookRunOutcome {
  /** The hook function was actually invoked (missing file / non-function
   *  export → false). */
  ran: boolean
  env?: Record<string, string>
  timedOut: boolean
  error?: string
}

export interface AppStartRerunResult {
  ran: boolean
  envKeys: number
  timedOut: boolean
  error?: string
}

function defaultLoader(filePath: string): unknown {
  return require(filePath)
}

/**
 * Delete every CJS cache entry under `dir` — the hook file itself plus the
 * helper modules it `require()`s. Rewriting a cached module's file changes
 * nothing on its own: `require()` would keep serving the old exports.
 *
 * `cache` is injectable for tests; production passes Node's real
 * `require.cache`. Returns the removed module keys (diagnostics).
 *
 * Cache keys are REAL paths (`require` resolves symlinks), while the directory
 * we are handed may still be the symlinked spelling — macOS `/var` →
 * `/private/var`, a symlinked home directory. Compare both spellings or the
 * purge silently matches nothing and the stale module keeps winning.
 */
export function purgeHookModuleCache(
  dir: string,
  cache: Record<string, unknown> | undefined = typeof require === 'undefined' ? undefined : require.cache,
): string[] {
  if (!cache) return []
  const roots = new Set<string>([dir])
  try {
    roots.add(realpathSync(dir))
  } catch {
    /* dir may not exist yet — the literal spelling still counts */
  }
  const prefixes = [...roots].map((root) => (root.endsWith(sep) ? root : root + sep))
  const removed: string[] = []
  for (const key of Object.keys(cache)) {
    if (roots.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      delete cache[key]
      removed.push(key)
    }
  }
  return removed
}

/**
 * Execute one hook file. Never throws: failures are returned as `error` so the
 * launch path can degrade to default env and the import path can log a truth-
 * ful outcome. The watchdog ABANDONS the flow on timeout (it does not kill
 * it): the orphaned promise keeps running with its rejections pre-caught, any
 * login window it opened is closed, and the caller moves on.
 */
async function runHook(event: string, options: HookRunOptions = {}): Promise<HookRunOutcome> {
  const hooksDir = options.hooksDir ?? HOOKS_DIR
  const filePath = join(hooksDir, `${event}.js`)
  if (!existsSync(filePath)) return { ran: false, timedOut: false }

  try {
    if (options.fresh) {
      const cache = options.cache ?? (typeof require === 'undefined' ? undefined : require.cache)
      const removed = purgeHookModuleCache(hooksDir, cache)
      if (removed.length > 0) {
        logMain('INFO', 'hooks', `${event}: cleared ${removed.length} cached module(s) for a fresh run`)
      }
    }

    const loaded = (options.loader ?? defaultLoader)(filePath)
    if (typeof loaded !== 'function') {
      console.warn(`[Hooks] ${event}.js does not export a function, skipping`)
      logMain('WARN', 'hooks', `${event}.js does not export a function, skipping`)
      return { ran: false, timedOut: false }
    }
    const hookFn = loaded as (...args: unknown[]) => unknown

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
        logMain('WARN', 'hooks', `${event}.js exceeded its ${timeoutMs}ms watchdog — abandoned; startup continues`)
        return { ran: true, timedOut: true }
      }
      const result = outcome as HookResult
      return { ran: true, timedOut: false, env: result?.env }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  } catch (err) {
    console.error(`[Hooks] ${event}.js failed:`, err)
    logMain('ERROR', 'hooks', `${event}.js failed: ${describeError(err)}`)
    return { ran: true, timedOut: false, error: describeError(err) }
  }
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
 *
 * A template import can trigger a mid-session re-run. Once one is running,
 * this returns THAT promise instead of the original launch promise: waiting
 * for the re-run is the whole point (a request must not resolve ${ENV}
 * against the old hook's values while the imported hook is about to replace
 * them), and the launch run has either finished or been skipped by then.
 */
export function ensureLaunchHooks(): Promise<void> {
  if (!launchPromise) {
    const skip = new Promise<void>((resolve) => { gateSkip = resolve })
    launchPromise = Promise.race([
      runLaunchHooks().catch((err) => {
        console.error('[Hooks] launch hooks crashed:', err)
        logMain('ERROR', 'hooks', `launch hooks crashed: ${describeError(err)}`)
      }),
      skip,
    ])
  }
  if (rerunPromise) return rerunPromise.then(() => undefined)
  return launchPromise
}

export function runLaunchHooks(): Promise<void> {
  return serializeHookRun(runLaunchHooksOnce)
}

async function runLaunchHooksOnce(): Promise<void> {
  // Resolve the login-shell PATH in parallel with hook execution so subprocess
  // env is ready before the first gated consumer (terminal/MCP spawn) proceeds.
  const userPathPromise = initUserPath()

  if (!existsSync(HOOKS_DIR)) {
    logMain('INFO', 'hooks', 'no hooks dir — nothing to run')
    await userPathPromise
    return
  }

  for (const event of HOOK_EVENTS) {
    const outcome = await runHook(event)
    // A successful run's env merges on top of what earlier hooks produced, as
    // it always has, and is mirrored into process.env so `${ENV}` placeholders
    // in settings resolve against it. A failed/timed-out run contributes nothing.
    if (outcome.ran && !outcome.timedOut && !outcome.error && outcome.env) {
      hookEnv = { ...hookEnv, ...outcome.env }
      applyHookReturnedEnv(outcome.env)
      console.log(`[Hooks] ${event}.js returned ${Object.keys(outcome.env).length} env var(s)`)
      logMain('INFO', 'hooks', `${event}.js returned ${Object.keys(outcome.env).length} env var(s)`)
    }
  }

  console.log('[Hooks] All hooks completed')
  logMain('INFO', 'hooks', 'all launch hooks completed')

  await userPathPromise
}

// In-flight mid-session re-run. Coalesces concurrent triggers (a double click
// on import, or both the import arm and a future caller) and makes
// ensureLaunchHooks() gate on the NEW hook's completion.
let rerunPromise: Promise<AppStartRerunResult> | null = null

/**
 * Re-run hooks/app-start.js in the CURRENT process (template import, user
 * 2026-11-11). A full restart is the alternative and it kills in-flight
 * sessions/routines for the sake of one startup-only script; this performs
 * exactly the missing side effect.
 *
 * Semantics deliberately differ from the launch run:
 *  - the module cache under the hooks dir is purged first, so imported or
 *    replaced files (and their helpers) are the ones that execute;
 *  - `hookEnv` is REPLACED on success — a fresh process starts with only what
 *    the new script returns, so vars the old script exported must not survive.
 *    A failed/timed-out/missing run keeps the previous env (degrade, never lose
 *    working config);
 *  - returned env is mirrored into `process.env` too — that is the only place
 *    `${ENV}` placeholders in settings.json resolve from, so an app-start that
 *    fetches an API key works exactly like one that sets process.env directly.
 *    Before the run, keys a previous hook applied are restored to their
 *    pre-hook values (fresh-process baseline); on failure the previous set is
 *    put back;
 *  - `process.env` mutations made directly by the hook are NOT rolled back —
 *    that is a documented limitation of an in-place re-run (hooks that need
 *    placeholder values should set them on every run).
 *
 * Never rejects. Resolves when the run settles or is coalesced into another.
 */
export function rerunAppStartHook(options: HookRunOptions = {}): Promise<AppStartRerunResult> {
  if (rerunPromise) return rerunPromise
  rerunPromise = serializeHookRun(async (): Promise<AppStartRerunResult> => {
    // Captured after the queue releases us (the launch hook may have finished
    // in the meantime and produced env worth preserving on failure).
    const previousEnv = hookEnv
    const previousReturned = { ...appliedHookEnv }
    // Fresh-process baseline: the new script must not see (or fail to override)
    // what the old one exported. Restored below if this run does not succeed.
    restoreHookReturnedEnv()
    const outcome = await runHook('app-start', { ...options, fresh: true })
    if (outcome.ran && !outcome.timedOut && !outcome.error) {
      hookEnv = outcome.env ? { ...outcome.env } : {}
      applyHookReturnedEnv(outcome.env ?? {})
      logMain('INFO', 'hooks', `app-start re-run applied ${Object.keys(hookEnv).length} env var(s) in place`)
    } else {
      hookEnv = previousEnv
      applyHookReturnedEnv(previousReturned)
      if (outcome.ran) {
        logMain('WARN', 'hooks', `app-start re-run did not apply (${outcome.error ?? 'timeout'}); previous env kept`)
      }
    }
    return {
      ran: outcome.ran,
      envKeys: outcome.env ? Object.keys(outcome.env).length : 0,
      timedOut: outcome.timedOut,
      error: outcome.error,
    }
  }).finally(() => {
    rerunPromise = null
  })
  return rerunPromise
}
