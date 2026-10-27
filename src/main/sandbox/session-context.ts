// ── Session sandbox context (PLAN-0.4.0 M3.5) ──
// The engine runs in the main process against a SINGLETON host (mainHost), so
// host calls carry no session identity. The session manager wraps every engine
// entry point that can execute tools (ask, engineCall) in this AsyncLocalStorage
// context; the file-ops and terminal services read it to adjudicate (write
// jail + cwd confinement against the session's workspace).

import { AsyncLocalStorage } from 'node:async_hooks'

export interface SessionSandboxContext {
  sessionId: string
  workspaceDir: string
  /** Exec prefixes the user approved with 「本会话总是允许」 (PLAN-coding-contract
   *  #5/#6). Deliberately not in the DB: the exception is a promise about THIS
   *  conversation, and a new session starting clean IS the feature. Keys are
   *  produced/matched by shared/sandbox/command-allowlist.ts. */
  execAllowlist: Set<string>
  /** OS pids this session spawned with `background: true` (P0-3 #14/#15):
   *  exec_logs / exec_kill answer ONLY for these, and session teardown reaps
   *  the live ones (terminal.svcReapBackgroundPids). A pid stays here after the
   *  process exits on its own — exec_logs must still read its log tail to
   *  discover the `[exited code=N]` line. */
  backgroundPids: Set<number>
}

export const sessionSandbox = new AsyncLocalStorage<SessionSandboxContext>()

/** Current session context, or null outside any session (renderer-initiated
 *  utilities — knowledge import, attachments). */
export function currentSessionSandbox(): SessionSandboxContext | null {
  return sessionSandbox.getStore() ?? null
}

// ── Background-exit push (2026-10-28 后台任务唤醒) ──
// terminal.ts discovers a background process's death inside its child 'exit'
// handler — the one moment main knows (pid, code) and can name the owning
// session (the spawn-time sandbox context). Session-manager registers a
// listener here to enqueue a wake-up notice on the owning engine; terminal
// fires it. A listener REGISTRY rather than a direct import: session-manager
// already sits above the services layer, and a service → manager import would
// invert the dependency arrow for one call (setHookWindowOpenListener /
// gate-escape are the same shape). The exit path must never break, so the
// notify swallows everything.
type BackgroundExitListener = (sessionId: string, pid: number, code: number | null) => void

let backgroundExitListener: BackgroundExitListener | null = null

export function setSessionBackgroundExitListener(fn: BackgroundExitListener | null): void {
  backgroundExitListener = fn
}

export function notifySessionBackgroundExit(sessionId: string, pid: number, code: number | null): void {
  try {
    backgroundExitListener?.(sessionId, pid, code)
  } catch { /* the process is dead either way; the log tail still reports it */ }
}
