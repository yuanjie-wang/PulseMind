import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { DATA_DIR, HOOKS_DIR, WORKSPACE_DIR, SKILLS_DIR, KNOWLEDGE_DIR } from './storage/index'
import { getUserPath, initUserPath } from './utils/user-path'
import { openBuiltInWindow } from './hook-browser'
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
    launchPromise = runLaunchHooks().catch((err) => {
      console.error('[Hooks] launch hooks crashed:', err)
    })
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

      const result: HookResult = await hookFn(context)
      if (result?.env) {
        hookEnv = { ...hookEnv, ...result.env }
        console.log(`[Hooks] ${event}.js returned ${Object.keys(result.env).length} env var(s)`)
      }
    } catch (err) {
      console.error(`[Hooks] ${event}.js failed:`, err)
    }
  }

  console.log('[Hooks] All hooks completed')

  await userPathPromise
}
