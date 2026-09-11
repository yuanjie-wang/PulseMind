// ── Session sandbox context (PLAN-0.4.0 M3.5) ──
// The engine runs in the main process against a SINGLETON host (mainHost), so
// host calls carry no session identity. The session manager wraps every engine
// entry point that can execute tools (ask, engineCall) in this AsyncLocalStorage
// context; the file-ops and terminal services read it to adjudicate.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProjectSandboxPolicy } from '../../shared/sandbox/policy'

export interface SessionSandboxContext {
  sessionId: string
  workspaceDir: string
  policy: ProjectSandboxPolicy
}

export const sessionSandbox = new AsyncLocalStorage<SessionSandboxContext>()

/** Current session context, or null outside any session (renderer-initiated
 *  utilities — knowledge import, canvas, attachments). */
export function currentSessionSandbox(): SessionSandboxContext | null {
  return sessionSandbox.getStore() ?? null
}
