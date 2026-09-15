// ── Sandbox guard glue (PLAN-0.4.0 M3.5) ──
// Bridges the pure path-jail decision to the main-process services: resolves
// the current session context (AsyncLocalStorage), picks the right deny-root
// list, realpath-resolves the target and audits the outcome.

import { realpath } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { guardPath, buildDenyRoots, buildBaselineDenyRoots, resolveTarget } from '../../shared/sandbox/path-jail'
import { currentSessionSandbox } from './session-context'
import { auditStore } from '../storage/audit-store'

export type GuardOperation = 'read' | 'write'

export interface GuardResult {
  ok: boolean
  /** English reason when blocked — lands in a tool result verbatim. */
  reason?: string
  resolved: string
}

/**
 * Adjudicate one file path for the caller's context.
 * - Inside an agent session: deny roots + workspace write jail.
 * - Outside (renderer utilities): baseline deny roots only.
 * Throws when blocked — write services catch and surface the reason as the
 * tool error; callers that must not throw should use `checkFsTarget`.
 */
export async function guardFsTarget(target: string, operation: GuardOperation): Promise<GuardResult> {
  const ctx = currentSessionSandbox()
  const denyRoots = ctx ? buildDenyRoots(homedir(), platform()) : buildBaselineDenyRoots(homedir(), platform())
  const resolved = resolveTarget(ctx?.workspaceDir, target)

  let realTarget: string | null = null
  try { realTarget = await realpath(resolved) } catch { /* nonexistent — lexical check stands */ }

  const decision = guardPath({
    target,
    operation,
    denyRoots,
    workspaceDir: ctx?.workspaceDir,
    realTarget,
  })

  // Audit denials always; writes always (allowed writes are the interesting
  // history). Reads that pass stay silent — they would flood the log.
  if (!decision.ok || operation === 'write') {
    auditStore.record({
      scope: 'project',
      actor: ctx?.sessionId,
      action: `fs.${operation}`,
      target: decision.resolved,
      decision: decision.ok ? 'allowed' : 'denied',
    })
  }

  return decision.ok ? { ok: true, resolved: decision.resolved } : { ok: false, reason: decision.reason, resolved: decision.resolved }
}

/** Non-throwing variant for read paths where a rejection degrades to "null". */
export async function checkFsTarget(target: string, operation: GuardOperation): Promise<GuardResult> {
  return guardFsTarget(target, operation)
}
