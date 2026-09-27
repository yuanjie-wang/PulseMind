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
